// `run --refresh-ncbi`: searches NCBI's own BLAST, live, for the sequences
// the weekly GenBank fungal ITS database does not answer (no hit at 97% or
// better), as the record store does, so their GenBank evidence is today's.
//
// Opt-in only. Nothing here runs unless the person asks for it, with their
// email address (and their own NCBI API key, if they have one); then only those
// sequences' bases are sent, to NCBI and nowhere else.
//
// The search is the one the record store makes (CMD=Put, then CMD=Get): blastn, megablast, database "nr" (NCBI's nucleotide collection),
// 50 alignments, the results read from BLAST XML. So the hits are the ones
// mycomap.org's analysis reads.
//
// NCBI's usage guidelines for the BLAST URL API
// (https://blast.ncbi.nlm.nih.gov/doc/blast-help/developerinfo.html):
//   - no more than one request every 10 seconds;
//   - no search (RID) polled more often than once a minute;
//   - TOOL and EMAIL on each request, so NCBI can say if there is a problem;
//   - more than 50 searches: at weekends, or 9 pm to 5 am Eastern on weekdays.
import { HITS_PER_SEQUENCE, type ParsedBlastResult } from "./blast";
import type { BlastHit } from "../src/analysisRules";
import { InputError } from "./fasta";

export const NCBI_BLAST_URL = "https://blast.ncbi.nlm.nih.gov/Blast.cgi";
/**
 * Where an API key is checked before anything is sent. NCBI's BLAST takes a key it does not know
 * without a word, then never finishes the search (checked 2026-11-24: a made-up key got HTTP 200
 * and a search id, then WAITING for more than 50 minutes, while the same sequence sent without a
 * key was answered in a minute); E-utilities refuses the key with HTTP 400 and says why.
 */
export const NCBI_KEY_CHECK_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi";
/** A weekly-database hit at this identity or better answers a sequence; below it, NCBI is asked. */
export const REFRESH_BELOW = 97;
/** NCBI: no more than one request every 10 seconds. */
export const REQUEST_SPACING_MS = 10_000;
/** NCBI: a search is polled no more than once a minute. */
export const POLL_EVERY_MS = 60_000;
/** A search NCBI has not finished in this long is given up (its sequence keeps the weekly hits). */
export const GIVE_UP_AFTER_MS = 60 * 60_000;
/** After this long, the person is told NCBI is slow. */
export const SLOW_AFTER_MS = 5 * 60_000;
/** Searches waiting at NCBI at once. */
export const AT_ONCE = 5;
/** How long to wait after NCBI says it is busy, doubled each time; after the last, the refresh stops. */
export const BUSY_WAITS_MS = [2 * 60_000, 4 * 60_000, 8 * 60_000] as const;
/** NCBI asks that more searches than this go at weekends or at night (Eastern). */
export const LARGE_BATCH = 50;
export const TOOL_NAME = "mycomap-validation";

/** The search settings, as the record store sends them. */
export const NCBI_SEARCH = { program: "blastn", database: "nr", megablast: true, alignments: HITS_PER_SEQUENCE } as const;

export interface NcbiAccess {
  /** The person's NCBI API key, or null: NCBI's BLAST takes searches without one (2026-11-20: optional). */
  apiKey: string | null;
  email: string;
}

/** Test seams: where NCBI is, and the clock. */
export interface NcbiService {
  url?: string;
  /** Where the key is checked; by default E-utilities' einfo, or /entrez/eutils/einfo.fcgi beside a stand-in `url`. */
  keyCheckUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

/**
 * The email address and, if there is one, the API key: from the options, else
 * NCBI_EMAIL and NCBI_API_KEY, checked. NCBI asks every caller for an email
 * address; the key is optional (NCBI's BLAST takes searches without one, and
 * the tool already keeps to NCBI's pace for searches without a key). An
 * InputError says what is missing or wrong.
 */
export function ncbiAccess(given: { apiKey?: string | null; email?: string | null }, env: NodeJS.ProcessEnv = process.env): NcbiAccess {
  const apiKey = (given.apiKey ?? "").trim() || (env.NCBI_API_KEY ?? "").trim() || null;
  const email = (given.email ?? "").trim() || (env.NCBI_EMAIL ?? "").trim();
  if (!email) throw new InputError("Refreshing from NCBI needs your email address (--ncbi-email, or NCBI_EMAIL), which NCBI asks for so it can tell you of a problem. An NCBI API key is optional (--ncbi-key, or NCBI_API_KEY).");
  if (apiKey !== null && !/^[A-Za-z0-9]{8,64}$/.test(apiKey)) throw new InputError("That NCBI API key does not look like one: it is letters and digits only (36 of them, as NCBI shows it). Leave it out to search without one.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError(`"${email}" does not look like an email address.`);
  return { apiKey, email };
}

/** Whether the weekly database answers a sequence: a hit at 97% or better (first HSP, to two places, as the record store reads it). */
export function answeredByWeekly(result: ParsedBlastResult | null | undefined): boolean {
  return !!result?.hits.some((h) => Math.round(h.identity * 100) / 100 >= REFRESH_BELOW);
}

/** The Put request: the key, if there is one, on the address, as NCBI requires; the search in the body. */
export function putRequest(bases: string, access: NcbiAccess, base = NCBI_BLAST_URL): { url: string; body: URLSearchParams } {
  const url = new URL(base);
  if (access.apiKey) url.searchParams.set("api_key", access.apiKey);
  const body = new URLSearchParams({
    CMD: "Put",
    PROGRAM: NCBI_SEARCH.program,
    DATABASE: NCBI_SEARCH.database,
    QUERY: bases,
    MEGABLAST: "on",
    ALIGNMENTS: String(NCBI_SEARCH.alignments),
    TOOL: TOOL_NAME,
    EMAIL: access.email,
  });
  return { url: url.toString(), body };
}

/** The Get request for a search's results, as BLAST XML. */
export function getRequest(rid: string, access: NcbiAccess, base = NCBI_BLAST_URL): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries({ CMD: "Get", RID: rid, FORMAT_TYPE: "XML", TOOL: TOOL_NAME, EMAIL: access.email, ...(access.apiKey ? { api_key: access.apiKey } : {}) })) url.searchParams.set(k, v);
  return url.toString();
}

/** The key check: E-utilities' einfo, with the key, TOOL and EMAIL. */
export function keyCheckRequest(access: NcbiAccess, base = NCBI_KEY_CHECK_URL): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries({ retmode: "json", tool: TOOL_NAME, email: access.email, api_key: access.apiKey ?? "" })) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * What the key check says: "ok", NCBI's reason for refusing the key, or "unknown" when the answer
 * says neither (busy, down, something else). Only a refusal that names the key counts as one.
 */
export function readKeyCheck(status: number, text: string): "ok" | "unknown" | { refused: string } {
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  const error = typeof json?.error === "string" ? json.error.trim() : "";
  const type = typeof json?.type === "string" ? json.type : "";
  if (status > 0 && status < 500 && (/api[\s_-]*key/i.test(error) || /^api-key/i.test(type))) return { refused: error || type };
  if (status === 200 && json && !error) return "ok";
  return "unknown";
}

/** NCBI's QBlastInfo block (RID, RTOE, Status, ThereAreHits), or null. */
export function readQBlastInfo(text: string): Record<string, string> | null {
  const m = /QBlastInfoBegin([\s\S]*?)QBlastInfoEnd/i.exec(text);
  if (!m) return null;
  const info: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const [k, ...v] = line.split("=");
    if (k?.trim() && v.length) info[k.trim()] = v.join("=").trim();
  }
  return info;
}

/** NCBI's own words from an error page: its message, else the page's text. */
export function ncbiWords(text: string): string {
  const message = /Message ID#\d+ Error:\s*([^<\n]+)/i.exec(text)?.[1]
    ?? /<(?:div|p|li)[^>]*class="[^"]*error[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p|li)>/i.exec(text)?.[1]
    ?? /"error"\s*:\s*"([^"]+)"/.exec(text)?.[1]
    ?? text;
  return decodeEntities(message.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Whether an answer is NCBI being busy (try later), as the record store reads it: "code: -99", "temporarily unavailable", 429 or a server error. */
export function isBusy(status: number, text: string): boolean {
  return status === 429 || status >= 500 || /code\s*:\s*-99/i.test(text) || /temporarily\s+unavailable/i.test(text) || (status === 200 && !text.trim());
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, e: string) => {
    const lower = e.toLowerCase();
    if (lower[0] === "#") {
      const code = lower[1] === "x" ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[lower];
  });
}

function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? decodeEntities(m[1]).trim() : "";
}

function blocks(text: string, name: string): string[] {
  return [...text.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);
}

/**
 * The hits from NCBI's BLAST XML, read as mycomap.org reads them
 * (batchAnalysisService parseBlastXml): the first query's hits in NCBI's order,
 * each hit's identity and coverage from its first HSP. Null if it is not BLAST XML.
 */
export function readBlastXml(text: string): ParsedBlastResult | null {
  const output = /<BlastOutput>([\s\S]*)<\/BlastOutput>/.exec(text)?.[1];
  if (!output) return null;
  const iteration = blocks(output, "Iteration")[0];
  if (iteration === undefined) return null;
  const queryLen = parseInt(tag(iteration, "Iteration_query-len") || tag(output.replace(/<BlastOutput_iterations>[\s\S]*$/, ""), "BlastOutput_query-len") || "0", 10);
  const int = (block: string, name: string) => parseInt(tag(block, name) || "0", 10);
  const hits: BlastHit[] = blocks(iteration, "Hit").map((hit, idx) => {
    const hsps = blocks(hit, "Hsp").map((hsp) => ({
      identity: int(hsp, "Hsp_identity"),
      alignLen: int(hsp, "Hsp_align-len"),
      queryFrom: int(hsp, "Hsp_query-from"),
      queryTo: int(hsp, "Hsp_query-to"),
      hitFrom: int(hsp, "Hsp_hit-from"),
      hitTo: int(hsp, "Hsp_hit-to"),
      qseq: tag(hsp, "Hsp_qseq"),
      hseq: tag(hsp, "Hsp_hseq"),
      midline: tag(hsp, "Hsp_midline"),
    }));
    const first = hsps[0];
    return {
      num: idx + 1,
      def: tag(hit, "Hit_def"),
      accession: tag(hit, "Hit_accession"),
      id: tag(hit, "Hit_id"),
      len: int(hit, "Hit_len"),
      identity: first && first.alignLen > 0 ? (first.identity / first.alignLen) * 100 : 0,
      alignLen: first?.alignLen ?? 0,
      queryLen,
      queryCoverage: queryLen > 0 && first ? ((Math.abs(first.queryTo - first.queryFrom) + 1) / queryLen) * 100 : 0,
      hsps,
    };
  });
  return { queryLen, hits };
}

export interface LiveSearch {
  id: string;
  rid: string;
  /** When NCBI answered (ISO). */
  answeredAt: string;
  xml: string;
  result: ParsedBlastResult;
}

export interface RefreshOutcome {
  searched: LiveSearch[];
  /** Sequences sent but not answered, which keep the weekly hits, and why in words. */
  keptWeekly: Array<{ id: string; reason: string }>;
  /** Set when the refresh stopped early: why, in words. */
  stopped: string | null;
}

/** Why the whole refresh stops: NCBI refused the key, or stayed busy, or cannot be reached. */
class Stop extends Error {}

interface Pending {
  id: string;
  bases: string;
  rid: string | null;
  sentAt: number;
  nextPollAt: number;
  resubmitted: boolean;
  saidSlow: boolean;
}

/**
 * Sends each sequence to NCBI (one search each, as the record store does), waits
 * for the answers within NCBI's guidelines, and reads them. Never throws for
 * what NCBI says: a sequence it does not answer keeps the weekly hits, and the
 * outcome says why.
 */
export async function refreshFromNcbi(
  sequences: Array<{ id: string; bases: string }>,
  access: NcbiAccess,
  say: (line: string) => void,
  service: NcbiService = {},
): Promise<RefreshOutcome> {
  const base = service.url ?? NCBI_BLAST_URL;
  const doFetch = service.fetch ?? globalThis.fetch;
  const now = service.now ?? Date.now;
  const wait = service.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const outcome: RefreshOutcome = { searched: [], keptWeekly: [], stopped: null };
  if (!sequences.length) return outcome;

  let lastRequestAt = -Infinity;
  let busyInARow = 0;
  let reached = false;
  /** One request to NCBI, no sooner than 10 seconds after the last; busy answers wait and try again. */
  const request = async (what: string, url: string, init?: RequestInit): Promise<{ status: number; text: string }> => {
    for (;;) {
      const gap = lastRequestAt + REQUEST_SPACING_MS - now();
      if (gap > 0) await wait(gap);
      lastRequestAt = now();
      let status: number;
      let text: string;
      try {
        const res = await doFetch(url, { ...init, headers: { "User-Agent": `${TOOL_NAME} (${access.email})`, ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(120_000) });
        status = res.status;
        text = await res.text();
        reached = true;
      } catch (error) {
        const timedOut = (error as Error)?.name === "TimeoutError";
        const why = timedOut ? "NCBI did not answer within two minutes" : `NCBI could not be reached (${(error as Error)?.message ?? error})`;
        if (!reached && !timedOut) throw new Stop(`${why}. Are you online?`);
        status = 0;
        text = "";
        say(`${why} ${what}.`);
      }
      if (status !== 0 && !isBusy(status, text)) {
        busyInARow = 0;
        return { status, text };
      }
      if (status !== 0) say(`NCBI is busy (${status === 200 ? ncbiWords(text) || "an empty answer" : `HTTP ${status}${text.trim() ? `: ${ncbiWords(text)}` : ""}`}) ${what}.`);
      if (busyInARow >= BUSY_WAITS_MS.length) throw new Stop("NCBI stayed busy, so the refresh stopped. Try --refresh-ncbi again later; NCBI is quietest at weekends and from 9 pm to 5 am Eastern time.");
      const pause = BUSY_WAITS_MS[busyInARow++];
      say(`Waiting ${pause / 60_000} minutes before asking NCBI again.`);
      await wait(pause);
    }
  };

  const queue: Array<{ id: string; bases: string; resubmitted?: boolean }> = [...sequences];
  const pending: Pending[] = [];
  const keep = (id: string, reason: string) => {
    outcome.keptWeekly.push({ id, reason });
    say(`${id}: ${reason}; it keeps the weekly database's hits.`);
  };

  const submit = async (p: Pending): Promise<void> => {
    const put = putRequest(p.bases, access, base);
    const answer = await request(`sending ${p.id}`, put.url, { method: "POST", body: put.body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    const info = readQBlastInfo(answer.text);
    if (answer.status === 401 || answer.status === 403) throw new Stop(`NCBI refused the request (HTTP ${answer.status}${answer.text.trim() ? `: ${ncbiWords(answer.text)}` : ""})${access.apiKey ? ". Check your NCBI API key." : "."}`);
    if (answer.status !== 200 || !info?.RID) {
      const words = answer.text.trim() ? ncbiWords(answer.text) : "an empty answer";
      if (access.apiKey && /api[\s_-]*key/i.test(words)) throw new Stop(`NCBI refused your API key: ${words}`);
      keep(p.id, `NCBI refused the search (${answer.status === 200 ? "" : `HTTP ${answer.status}: `}${words})`);
      return;
    }
    p.rid = info.RID;
    p.sentAt = now();
    // NCBI says how long it expects (RTOE, seconds); never sooner than once a minute.
    const rtoe = Number(info.RTOE);
    p.nextPollAt = p.sentAt + Math.max(POLL_EVERY_MS, Number.isFinite(rtoe) ? rtoe * 1000 : 0);
    pending.push(p);
    say(`Sent ${p.id} to NCBI (search ${p.rid}${Number.isFinite(rtoe) && rtoe > 0 ? `; NCBI expects about ${Math.ceil(rtoe / 60)} minute${rtoe > 60 ? "s" : ""}` : ""}).`);
  };

  const poll = async (p: Pending): Promise<void> => {
    const answer = await request(`asking about ${p.id}`, getRequest(p.rid!, access, base));
    p.nextPollAt = now() + POLL_EVERY_MS;
    const done = () => pending.splice(pending.indexOf(p), 1);
    if (answer.status === 401 || answer.status === 403) throw new Stop(`NCBI refused the request (HTTP ${answer.status}${answer.text.trim() ? `: ${ncbiWords(answer.text)}` : ""})${access.apiKey ? ". Check your NCBI API key." : "."}`);
    const result = answer.status === 200 && /<BlastOutput[\s>]/.test(answer.text) ? readBlastXml(answer.text) : null;
    if (result) {
      done();
      outcome.searched.push({ id: p.id, rid: p.rid!, answeredAt: new Date(now()).toISOString(), xml: answer.text, result });
      const best = result.hits.length ? Math.max(...result.hits.map((h) => h.identity)) : null;
      say(`NCBI answered ${p.id}: ${result.hits.length} hit${result.hits.length === 1 ? "" : "s"}${best === null ? "" : `, the best at ${Math.round(best * 100) / 100}%`}.`);
      return;
    }
    const info = readQBlastInfo(answer.text);
    const status = info?.Status?.toUpperCase();
    if (status === "WAITING") {
      const waited = now() - p.sentAt;
      if (waited >= GIVE_UP_AFTER_MS) {
        done();
        keep(p.id, `NCBI had not finished after ${Math.round(waited / 60_000)} minutes (search ${p.rid}), so the tool stopped waiting`);
      } else if (waited >= SLOW_AFTER_MS && !p.saidSlow) {
        p.saidSlow = true;
        say(`NCBI is slow: ${p.id} has been searching for ${Math.round(waited / 60_000)} minutes. The tool waits up to ${GIVE_UP_AFTER_MS / 60_000}.`);
      }
      return;
    }
    if (status === "READY" && info?.ThereAreHits?.toLowerCase() === "no") {
      done();
      outcome.searched.push({ id: p.id, rid: p.rid!, answeredAt: new Date(now()).toISOString(), xml: answer.text, result: { queryLen: p.bases.length, hits: [] } });
      say(`NCBI answered ${p.id}: no hits.`);
      return;
    }
    done();
    if (status === "UNKNOWN" && !p.resubmitted) {
      // NCBI has lost the search (it keeps them about a day, and now and then sooner): ask once more.
      say(`NCBI no longer knows search ${p.rid} for ${p.id}; sending it again.`);
      queue.unshift({ id: p.id, bases: p.bases, resubmitted: true });
      return;
    }
    keep(p.id, status === "FAILED" ? `NCBI's search failed (search ${p.rid})` : status === "UNKNOWN" ? `NCBI lost the search twice (search ${p.rid})` : `NCBI answered with something that is not a BLAST result (${ncbiWords(answer.text) || `HTTP ${answer.status}`})`);
  };

  /** A key NCBI does not know stops the refresh before anything is sent; a check NCBI cannot answer does not. */
  const checkKey = async (): Promise<void> => {
    if (!access.apiKey) return;
    const at = service.keyCheckUrl ?? (service.url ? new URL("/entrez/eutils/einfo.fcgi", service.url).toString() : NCBI_KEY_CHECK_URL);
    let status = 0;
    let text = "";
    try {
      const res = await doFetch(keyCheckRequest(access, at), { headers: { "User-Agent": `${TOOL_NAME} (${access.email})` }, signal: AbortSignal.timeout(60_000) });
      status = res.status;
      text = await res.text();
    } catch {
      status = 0;
    }
    const verdict = readKeyCheck(status, text);
    if (verdict === "ok") return;
    if (verdict === "unknown") {
      say(`Could not check your NCBI API key with NCBI (${status ? `HTTP ${status}` : "no answer"}); going on with it.`);
      return;
    }
    throw new Stop(`NCBI says your API key is not valid ("${verdict.refused}"), so nothing was sent. Check the key under API Key Management in your NCBI account settings, or leave it out to search without one.`);
  };

  const n = sequences.length;
  say(`Sending ${n} sequence${n === 1 ? "" : "s"} the weekly GenBank database does not answer (no hit at ${REFRESH_BELOW}% or better) to NCBI${access.apiKey ? ", with your API key" : ""}. NCBI asks for no more than one request every 10 seconds and one check a minute on each search, so this takes a few minutes${n > AT_ONCE ? " or more" : ""}.`);
  if (n > LARGE_BATCH) say(`NCBI asks that more than ${LARGE_BATCH} searches go at weekends, or between 9 pm and 5 am Eastern time on weekdays.`);
  try {
    await checkKey();
    while (queue.length || pending.length) {
      const due = pending.filter((p) => p.nextPollAt <= now()).sort((a, b) => a.nextPollAt - b.nextPollAt)[0];
      if (due) { await poll(due); continue; }
      if (queue.length && pending.length < AT_ONCE) {
        // Off the queue only once sent (or refused): if the refresh stops while it is sent, it is still listed as kept.
        const next = queue[0];
        await submit({ id: next.id, bases: next.bases, rid: null, sentAt: 0, nextPollAt: 0, resubmitted: !!next.resubmitted, saidSlow: false });
        queue.splice(queue.indexOf(next), 1);
        continue;
      }
      await wait(Math.max(0, Math.min(...pending.map((p) => p.nextPollAt)) - now()));
    }
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    outcome.stopped = error.message;
    say(error.message);
    const left = [...pending.map((p) => p.id), ...queue.map((q) => q.id)];
    for (const id of left) outcome.keptWeekly.push({ id, reason: error.message });
    if (left.length) say(`${left.length} sequence${left.length === 1 ? "" : "s"} keep${left.length === 1 ? "s" : ""} the weekly database's hits: ${left.join(", ")}.`);
  }
  return outcome;
}
