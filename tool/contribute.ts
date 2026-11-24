// `mycomap-validation contribute <run folder>`: sends a run's sequences to
// mycomap.org, with the member's own key, for MycoMap's database. Only when
// the member runs this command (or presses Contribute in the browser app) and
// agrees: nothing else in the tool sends anything to mycomap.org.
//
//   POST   /api/contributions        a contribution (section 7.1 of the design)
//   GET    /api/contributions/:id    where it stands (7.2)
//   DELETE /api/contributions/:id    withdrawn, before a decision (7.3)
//
// What goes: each record's iNaturalist or Mushroom Observer observation, its
// voucher, and each read's cleaned bases (the run's sequences.fasta), read
// count, method, primers and run, plate and well when the records sheet gives
// them. The tool's own results go as notes for the person who reviews the
// contribution: they never validate anything on MycoMap. Nothing else: no
// coordinates (a record's place is its observation's), no photos, no FASTQ.
//
// The member agrees, per contribution, that the sequences are published under
// CC BY 4.0 and credited to them. A run of more than 500 sequences goes as
// several contributions, never splitting a record. contribution.json in the run
// folder keeps each contribution's number and mycomap.org's last answer; once
// mycomap.org names a read that had a local name (localNames.ts),
// `contribute --status` renames it in results.json, records.csv and
// results.csv.
import fs from "node:fs";
import path from "node:path";
import { InputError, readFasta, splitLine } from "./fasta";
import { engineVersion, SEQUENCES_FILE } from "./run";

export const DEFAULT_MYCOMAP_URL = "https://mycomap.org";
export const CONTRIBUTION_FILE = "contribution.json";
export const LICENCE = "CC-BY-4.0";
export const LICENCE_URL = "https://creativecommons.org/licenses/by/4.0/";
/** mycomap.org's limits (7.1). */
export const MAX_SEQUENCES_PER_CONTRIBUTION = 500;
export const MIN_BASES = 50;
export const MAX_BASES = 3000;
const CALL_TIMEOUT_MS = 120_000;
/** Statuses after which a contribution can no longer be withdrawn. */
const DECIDED = new Set(["accepted", "partly_accepted", "refused", "withdrawn"]);
const OBSERVATION = /^(inat|mo):(\d{1,12})$/i;

// ── settings ──

export interface ContributeSettings {
  key: string;
  /** mycomap.org's address, without a trailing slash. */
  url: string;
}

/**
 * The member key (--key, else MYCOMAP_MEMBER_KEY) and mycomap.org's address
 * (--site, else MYCOMAP_SITE_URL, else mycomap.org). Never MYCOMAP_API_KEY:
 * that is the name mycomap.org's own server gives its key to the record store. The
 * key goes only to an https address, or to this computer.
 */
export function contributeSettings(input: { key?: string | null; url?: string | null; env?: NodeJS.ProcessEnv }): ContributeSettings {
  const env = input.env ?? process.env;
  const key = (input.key ?? env.MYCOMAP_MEMBER_KEY ?? "").trim();
  if (!key) {
    throw new InputError(
      "Give your MycoMap member key: --key <key>, or set MYCOMAP_MEMBER_KEY. A member asks for one on mycomap.org's API page " +
      `(${DEFAULT_MYCOMAP_URL}/api-docs), and a MycoMap admin gives it the "contribute" grant.` +
      (env.MYCOMAP_API_KEY ? " (MYCOMAP_API_KEY is set, but it is never read: that is the name mycomap.org uses for its own key.)" : ""),
    );
  }
  const url = (input.url ?? env.MYCOMAP_SITE_URL ?? DEFAULT_MYCOMAP_URL).trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InputError(`"${url}" is not a web address. Contributions go to ${DEFAULT_MYCOMAP_URL}.`);
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    throw new InputError(`The member key is only sent over https (or to this computer), so "${url}" cannot be used.`);
  }
  return { key, url };
}

// ── the run ──

/** What contribute reads from a run folder's results.json. */
export interface RunResults {
  engineVersion?: string;
  ranAt?: string;
  databases?: { mycomap?: { version?: string | null }; ncbi?: { version?: string | null } | null };
  sequences: Array<{
    id: string;
    readCount: number | null;
    result?: { finalSpecies?: string | null; finalConfidence?: number | null; flaggedContaminant?: boolean; flaggedNonTarget?: boolean; barcodeGapNeeded?: boolean; noBlastHits?: boolean; status?: string };
    localName?: string | null;
    mycomapName?: { kind: string; value: string; contribution: string } | null;
  }>;
  records: Array<{ record: string; sequenceIds: string[]; decision: string; species: string | null; reason: string; newName?: string | null }>;
  /** The browser app's names for the inputs; the exports' kept copies. */
  input?: { fasta?: string | null; records?: string | null };
  inputFiles?: { fasta?: string; records?: string | null };
}

export interface LoadedRun {
  folder: string;
  results: RunResults;
  /** Cleaned bases by read id. */
  bases: Map<string, string>;
  /** The records sheet the details came from, or null. */
  sheet: string | null;
  details: Map<string, SequenceDetails>;
}

/** What the records sheet adds to a read for mycomap.org (all optional). */
export interface SequenceDetails {
  voucher: string | null;
  primers: string | null;
  run: string | null;
  plate: string | null;
  well: string | null;
  method: "ont" | "sanger" | null;
}

const ID_COLUMNS = ["sequence", "sequence_id", "id", "fasta_id", "header"];
const DETAIL_COLUMNS = {
  voucher: ["voucher", "specimen_voucher", "voucher_number", "catalog_number"],
  primers: ["primers", "primer_pair"],
  forward: ["fwd_primer", "forward_primer"],
  reverse: ["rev_primer", "reverse_primer"],
  run: ["run", "sequencing_run", "run_name"],
  plate: ["plate"],
  well: ["well"],
  method: ["method", "sequencing_method", "technology"],
};
/** Columns that name the record before "voucher" does (fasta.ts): with none of them, "voucher" is the record. */
const RECORD_NAMES = ["record", "record_id", "specimen", "observation"];

/** "ont" or "sanger" from the sheet's words for a method. */
export function methodOf(text: string): "ont" | "sanger" | null {
  if (/^(ont|nanopore|oxford nanopore|minion|gridion|promethion)$/i.test(text.trim())) return "ont";
  if (/^sanger$/i.test(text.trim())) return "sanger";
  return null;
}

/** The records sheet's columns for mycomap.org, by read id. Every problem is said with its line. */
export function readContributionDetails(text: string, fileLabel = "the records sheet"): Map<string, SequenceDetails> {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  const out = new Map<string, SequenceDetails>();
  if (!lines.length) return out;
  const separator = lines[0].includes("\t") ? "\t" : ",";
  const header = splitLine(lines[0], separator).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  const at = (names: string[]) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const idAt = at(ID_COLUMNS);
  if (idAt < 0) return out;
  const voucherNames = header.some((h) => RECORD_NAMES.includes(h)) ? DETAIL_COLUMNS.voucher : DETAIL_COLUMNS.voucher.filter((n) => n !== "voucher");
  const cols = {
    voucher: at(voucherNames), primers: at(DETAIL_COLUMNS.primers), forward: at(DETAIL_COLUMNS.forward), reverse: at(DETAIL_COLUMNS.reverse),
    run: at(DETAIL_COLUMNS.run), plate: at(DETAIL_COLUMNS.plate), well: at(DETAIL_COLUMNS.well), method: at(DETAIL_COLUMNS.method),
  };
  lines.slice(1).forEach((line, i) => {
    const values = splitLine(line, separator);
    const id = values[idAt]?.trim();
    if (!id) return;
    const get = (c: number) => (c >= 0 ? values[c]?.trim() || null : null);
    const methodText = get(cols.method);
    const method = methodText ? methodOf(methodText) : null;
    if (methodText && !method) throw new InputError(`${fileLabel}, line ${i + 2}: the method "${methodText}" is not one mycomap.org takes. Write ont (nanopore) or sanger.`);
    const forward = get(cols.forward);
    const reverse = get(cols.reverse);
    out.set(id, {
      voucher: get(cols.voucher),
      primers: get(cols.primers) ?? (forward || reverse ? [forward, reverse].filter(Boolean).join("/") : null),
      run: get(cols.run), plate: get(cols.plate), well: get(cols.well), method,
    });
  });
  return out;
}

/** The run's own records sheet: the exports' kept copy, else the browser app's, else none. */
export function runSheet(folder: string, results: RunResults): string | null {
  const kept = results.inputFiles?.records;
  if (kept && fs.existsSync(path.join(folder, kept))) return path.join(folder, kept);
  const named = results.input?.records;
  if (named) {
    const file = path.join(folder, `input_${path.basename(named).replace(/[^\w.-]+/g, "_")}`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function readJson<T>(file: string, what: string): T {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new InputError(what);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new InputError(`${file} could not be read as JSON: was it edited by hand?`);
  }
}

/** A run folder, as contribute reads it: results.json, sequences.fasta (or --fasta) and the records sheet (or --records). */
export function loadRun(folder: string, opts: { fasta?: string | null; records?: string | null } = {}): LoadedRun {
  const results = readJson<RunResults>(path.join(folder, "results.json"),
    `There is no results.json in ${folder}. Name a run folder: the one "run" wrote its results to, or one of the browser app's runs.`);
  if (!Array.isArray(results.sequences) || !Array.isArray(results.records)) throw new InputError(`${path.join(folder, "results.json")} has no sequences or records: is it a MycoMap Validation run?`);
  const fastaFile = opts.fasta ?? path.join(folder, SEQUENCES_FILE);
  if (!fs.existsSync(fastaFile)) {
    throw new InputError(`This run has no ${SEQUENCES_FILE}: runs before 2.0.0-beta.13 did not keep their sequences. Name the FASTA file it was run on with --fasta <file>, or run it again.`);
  }
  const bases = new Map(readFasta(fs.readFileSync(fastaFile, "utf8"), path.basename(fastaFile)).map((s) => [s.id, s.bases]));
  const sheet = opts.records ?? runSheet(folder, results);
  if (sheet && !fs.existsSync(sheet)) throw new InputError(`There is no file ${sheet}.`);
  const details = sheet ? readContributionDetails(fs.readFileSync(sheet, "utf8"), path.basename(sheet)) : new Map<string, SequenceDetails>();
  return { folder, results, bases, sheet, details };
}

// ── the body (7.1) ──

export interface ContributionSequence {
  id: string;
  bases: string;
  readCount: number | null;
  method: "ont" | "sanger";
  primers: string | null;
  run: string | null;
  plate: string | null;
  well: string | null;
  localName: string | null;
  toolResult: { dnaName: string | null; confidence: number | null; flags: string[] };
}

export interface ContributionRecord {
  record: string;
  voucher: string | null;
  sequences: ContributionSequence[];
  toolDecision: { decision: string; species: string | null; reason: string };
}

export interface ContributionBody {
  licence: typeof LICENCE;
  tool: { engineVersion: string; mycomapDatabase: string | null; ncbiDatabase: string | null; run: string };
  records: ContributionRecord[];
}

export interface ContributionPlan {
  /** One body per contribution: 500 sequences at most each, a record never split. */
  parts: ContributionBody[];
  /** Records (or reads) not sent, and why. */
  leftOut: Array<{ record: string; sequence?: string; why: string }>;
  /** Records already in a contribution of this run that was not withdrawn. */
  alreadySent: Array<{ record: string; contribution: string }>;
}

function flagsOfResult(r: NonNullable<RunResults["sequences"][number]["result"]>): string[] {
  return [
    r.flaggedContaminant && "contaminant",
    r.flaggedNonTarget && "non-target",
    r.barcodeGapNeeded && "barcode gap check needed",
    r.noBlastHits && "no MycoMap hits",
    r.status === "error" && "error",
  ].filter((f): f is string => !!f);
}

/** What would be sent from a run: the bodies, and what is left out and why. */
export function planContribution(run: LoadedRun, sent: ContributionFile | null = null): ContributionPlan {
  const leftOut: ContributionPlan["leftOut"] = [];
  const alreadySent: ContributionPlan["alreadySent"] = [];
  const sentRecords = new Map<string, string>();
  for (const c of sent?.contributions ?? []) if (c.status !== "withdrawn") for (const r of c.records) sentRecords.set(r, c.id);
  const reads = new Map(run.results.sequences.map((s) => [s.id, s]));
  const records: ContributionRecord[] = [];
  for (const r of run.results.records) {
    const already = sentRecords.get(r.record);
    if (already) { alreadySent.push({ record: r.record, contribution: already }); continue; }
    const m = OBSERVATION.exec(r.record.trim());
    if (!m) {
      leftOut.push({ record: r.record, why: "not an iNaturalist or Mushroom Observer observation (the record column must say inat:<number> or mo:<number>); records with no observation are taken later" });
      continue;
    }
    const record = `${m[1].toLowerCase()}:${m[2]}`;
    const sequences: ContributionSequence[] = [];
    let voucher: string | null = null;
    for (const id of r.sequenceIds) {
      const bases = run.bases.get(id);
      if (!bases) { leftOut.push({ record: r.record, sequence: id, why: `not in ${SEQUENCES_FILE}` }); continue; }
      if (bases.length < MIN_BASES || bases.length > MAX_BASES) {
        leftOut.push({ record: r.record, sequence: id, why: `${bases.length} bases long; mycomap.org takes ${MIN_BASES} to ${MAX_BASES.toLocaleString("en")}` });
        continue;
      }
      const read = reads.get(id);
      const d = run.details.get(id);
      voucher ??= d?.voucher ?? null;
      const readCount = read?.readCount ?? null;
      const method = d?.method ?? (readCount === null ? "sanger" : "ont");
      sequences.push({
        id, bases,
        readCount: method === "sanger" ? null : readCount,
        method,
        primers: d?.primers ?? null, run: d?.run ?? null, plate: d?.plate ?? null, well: d?.well ?? null,
        localName: read?.mycomapName ? null : read?.localName ?? null,
        toolResult: { dnaName: read?.result?.finalSpecies ?? null, confidence: read?.result?.finalConfidence ?? null, flags: read?.result ? flagsOfResult(read.result) : [] },
      });
    }
    if (!sequences.length) {
      if (r.sequenceIds.length) leftOut.push({ record: r.record, why: "none of its reads can be sent" });
      continue;
    }
    if (sequences.length > MAX_SEQUENCES_PER_CONTRIBUTION) {
      leftOut.push({ record: r.record, why: `${sequences.length} reads; a contribution takes at most ${MAX_SEQUENCES_PER_CONTRIBUTION}` });
      continue;
    }
    records.push({ record, voucher, sequences, toolDecision: { decision: r.decision, species: r.species, reason: r.reason } });
  }
  const tool = {
    engineVersion: run.results.engineVersion ?? engineVersion(),
    mycomapDatabase: run.results.databases?.mycomap?.version ?? null,
    ncbiDatabase: run.results.databases?.ncbi?.version ?? null,
    run: path.basename(path.resolve(run.folder)),
  };
  const parts: ContributionBody[] = [];
  let current: ContributionRecord[] = [];
  let count = 0;
  for (const rec of records) {
    if (count + rec.sequences.length > MAX_SEQUENCES_PER_CONTRIBUTION && current.length) {
      parts.push({ licence: LICENCE, tool, records: current });
      current = [];
      count = 0;
    }
    current.push(rec);
    count += rec.sequences.length;
  }
  if (current.length) parts.push({ licence: LICENCE, tool, records: current });
  return { parts, leftOut, alreadySent };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sequencesIn = (parts: ContributionBody[]) => parts.reduce((n, p) => n + p.records.reduce((m, r) => m + r.sequences.length, 0), 0);
const recordsIn = (parts: ContributionBody[]) => parts.reduce((n, p) => n + p.records.length, 0);

/** The licence, said plainly: shown before every send. */
export const LICENCE_WORDS =
  `Licence: by sending, you agree that these sequences are published under CC BY 4.0 (${LICENCE_URL}): ` +
  "anyone may use them, and MycoMap credits them to you by your display name.";

/** What is sent and what is not, in words. */
export const WHAT_IS_SENT_WORDS = [
  "Each read goes with its bases, read count, method, and primers, run, plate and well when the sheet gives them; each record with its observation and voucher.",
  "The tool's results go only as notes for the person at MycoMap who reviews the contribution: they never validate anything. mycomap.org runs its own analysis.",
  "Not sent: coordinates or places (a record's place comes from its observation, with the observation's own privacy), photos, FASTQ files or traces.",
];

/** The lines shown before asking: what goes where, record by record (the first 25), and what is left out. */
export function previewLines(plan: ContributionPlan, settings: Pick<ContributeSettings, "url">): string[] {
  const lines: string[] = [];
  const seqs = sequencesIn(plan.parts);
  lines.push(`This sends ${plural(seqs, "sequence")} of ${plural(recordsIn(plan.parts), "record")} to ${settings.url}, with your member key${plan.parts.length > 1 ? `, as ${plan.parts.length} contributions (at most ${MAX_SEQUENCES_PER_CONTRIBUTION} sequences each)` : ""}:`);
  const all = plan.parts.flatMap((p) => p.records);
  for (const r of all.slice(0, 25)) {
    const reads = r.sequences.map((s) => `${s.id} (${s.method === "ont" ? `ONT, ${s.readCount ?? "?"} reads` : "Sanger"}, ${s.bases.length} bases${s.localName ? `, local name ${s.localName}` : ""})`).join(", ");
    const said = r.toolDecision.decision === "validate" ? `the tool: validated as ${r.toolDecision.species}` : r.toolDecision.decision === "reject" ? "the tool: rejected" : "the tool: held for a person";
    lines.push(`  ${r.record}${r.voucher ? ` (voucher ${r.voucher})` : ""}: ${reads}; ${said}`);
  }
  if (all.length > 25) lines.push(`  … and ${plural(all.length - 25, "more record")}`);
  if (plan.leftOut.length) {
    lines.push("Not sent:");
    for (const l of plan.leftOut.slice(0, 25)) lines.push(`  ${l.record}${l.sequence ? `, read ${l.sequence}` : ""}: ${l.why}`);
    if (plan.leftOut.length > 25) lines.push(`  … and ${plan.leftOut.length - 25} more`);
  }
  if (plan.alreadySent.length) lines.push(`Already sent, so not sent again: ${plan.alreadySent.map((a) => `${a.record} (${a.contribution})`).slice(0, 10).join(", ")}${plan.alreadySent.length > 10 ? ", …" : ""}.`);
  lines.push(...WHAT_IS_SENT_WORDS, LICENCE_WORDS);
  return lines;
}

// ── contribution.json ──

export interface ContributionEntry {
  id: string;
  page: string | null;
  site: string;
  sentAt: string;
  records: string[];
  sequences: string[];
  /** The last status mycomap.org gave. */
  status: string;
  checkedAt: string | null;
  /** mycomap.org's last answer from GET /api/contributions/:id (7.2). */
  answer: ContributionAnswer | null;
}

export interface ContributionFile {
  tool: "mycomap-validation";
  contributions: ContributionEntry[];
}

export function readContributionFile(folder: string): ContributionFile | null {
  const file = path.join(folder, CONTRIBUTION_FILE);
  if (!fs.existsSync(file)) return null;
  const read = readJson<ContributionFile>(file, `${file} could not be read.`);
  return { tool: "mycomap-validation", contributions: Array.isArray(read.contributions) ? read.contributions : [] };
}

export function writeContributionFile(folder: string, file: ContributionFile): void {
  fs.writeFileSync(path.join(folder, CONTRIBUTION_FILE), `${JSON.stringify(file, null, 2)}\n`);
}

// ── talking to mycomap.org ──

/** 7.2's answer, as far as the tool reads it. */
export interface ContributionAnswer {
  id: string;
  status: string;
  receivedAt?: string | null;
  decidedAt?: string | null;
  page?: string | null;
  records?: Array<{
    record: string;
    status: string;
    reason?: string | null;
    sequences?: Array<{
      id: string;
      status: string;
      reason?: string | null;
      check?: { dnaName?: string | null; confidence?: number | null; flags?: string[]; duplicateOf?: string | number | null } | null;
      mycomapSequenceId?: string | number | null;
      name?: { kind: "existing" | "new"; value: string | null; pending?: boolean } | null;
    }>;
  }>;
}

/** mycomap.org refused, or could not be reached: `words` says what happened and what to do. */
export class ContributeRefused extends Error {
  constructor(readonly status: number, readonly words: string) {
    super(words);
  }
}

type Call = "send" | "status" | "withdraw";

/** Each answer mycomap.org can give, in words (7.1–7.3). */
export function refusalWords(status: number, body: any, call: Call, ctx: { url: string; id?: string; where?: string } = { url: DEFAULT_MYCOMAP_URL }): string {
  const said = typeof body?.error === "string" && body.error.trim() ? body.error.trim().replace(/\.?$/, ".") : null;
  const theirs = said ? ` mycomap.org said: "${said}"` : "";
  const nothing = call === "send" ? " Nothing was taken." : "";
  switch (status) {
    case 400: return `mycomap.org could not take the contribution: ${said ?? "something in it is not as it expects."}${ctx.where ? ` (${ctx.where})` : ""} Nothing was taken; correct it and send again.`;
    case 401: return `mycomap.org does not know this key. Check that it is your MycoMap member key, as mycomap.org's API page (${DEFAULT_MYCOMAP_URL}/api-docs) gave it.${nothing}`;
    case 403: return `This key cannot ${call === "send" ? "send" : "follow"} contributions: it has no "contribute" grant, or it is pending, disabled or revoked. Ask a MycoMap admin to give your key the contribute grant.${theirs}${nothing}`;
    case 404: return `mycomap.org has no contribution ${ctx.id ?? ""} that this key can read: only the member who sent it, or an admin, can. Was it sent with another key?`.replace("  ", " ");
    case 409: return `${ctx.id ?? "The contribution"} has been decided, so it can no longer be withdrawn. Removing accepted sequences goes through a person: write to info@mycomap.org.`;
    case 413: return `mycomap.org refused it as too large: at most ${MAX_SEQUENCES_PER_CONTRIBUTION} sequences in one contribution.${theirs}${nothing}`;
    case 423: return `Only mycomap.org takes contributions: ${ctx.url} does not (the dev site and local copies refuse them).${nothing} Send to ${DEFAULT_MYCOMAP_URL} (leave out --site and MYCOMAP_SITE_URL).`;
    case 429: {
      const after = typeof body?.retryAfter === "string" && !Number.isNaN(Date.parse(body.retryAfter)) ? new Date(body.retryAfter).toISOString().slice(0, 16).replace("T", " ") + " UTC" : null;
      return `Today's contributions for this key are used up.${after ? ` Send the rest after ${after}:` : " Send the rest tomorrow:"} run contribute again, and only what was not taken goes.${nothing}`;
    }
    default:
      if (status >= 500) return `mycomap.org could not answer now (HTTP ${status}).${nothing} Try again later.`;
      return `mycomap.org refused it (HTTP ${status}).${theirs}${nothing}`;
  }
}

export interface ClientOptions extends ContributeSettings {
  /** Test seam. */
  fetch?: typeof fetch;
}

async function call(opts: ClientOptions, method: "GET" | "POST" | "DELETE", route: string, what: Call, body?: unknown, ctx: { id?: string; where?: (b: any) => string | undefined } = {}): Promise<any> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${opts.url}${route}`, {
      method,
      headers: {
        "X-API-Key": opts.key,
        Accept: "application/json",
        "User-Agent": `mycomap-validation/${engineVersion()}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (error) {
    const why = (error as Error)?.name === "TimeoutError" ? "no answer in two minutes" : (error as Error)?.message ?? String(error);
    throw new ContributeRefused(0, what === "send"
      ? `No answer came from ${opts.url} (${why}), so it is not known whether the contribution was taken. Check your contributions on mycomap.org before sending again.`
      : `${opts.url} could not be reached (${why}). Try again later.`);
  }
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (res.ok) {
    if (!parsed || typeof parsed !== "object") throw new ContributeRefused(res.status, `${opts.url} answered something that is not a contribution (is it mycomap.org?).`);
    return parsed;
  }
  throw new ContributeRefused(res.status, refusalWords(res.status, parsed, what, { url: opts.url, id: ctx.id, where: ctx.where?.(parsed) }));
}

// ── sending ──

export interface FlowOptions {
  folder: string;
  settings: ContributeSettings;
  say: (line: string) => void;
  /** Asks a yes/no question; none: the tool cannot ask (and stops unless `yes`). */
  ask?: (question: string) => Promise<boolean>;
  /** Go ahead without asking. */
  yes?: boolean;
  fasta?: string | null;
  records?: string | null;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface FlowResult {
  /** 0 done (or nothing to do), 1 refused or stopped. */
  code: 0 | 1;
  sent: ContributionEntry[];
  /** What mycomap.org refused, or why nothing could be done, in words (also said). */
  problem?: string;
}

/** The place a 400 names (7.1's item), as the member knows it: the record and the read. */
function placeOf(part: ContributionBody, body: any): string | undefined {
  const item = body?.item;
  if (!item || typeof item.record !== "number") return undefined;
  const rec = part.records[item.record];
  if (!rec) return undefined;
  const seq = typeof item.sequence === "number" ? rec.sequences[item.sequence] : undefined;
  return `record ${rec.record}${seq ? `, read ${seq.id}` : ""}`;
}

/** contribute <run folder>: shows what goes, asks, sends, and keeps contribution.json. */
export async function sendRun(opts: FlowOptions): Promise<FlowResult> {
  const run = loadRun(opts.folder, { fasta: opts.fasta, records: opts.records });
  const file = readContributionFile(opts.folder) ?? { tool: "mycomap-validation" as const, contributions: [] };
  const plan = planContribution(run, file);
  if (!plan.parts.length) {
    if (plan.alreadySent.length && !plan.leftOut.length) opts.say(`Everything in this run has been sent (${[...new Set(plan.alreadySent.map((a) => a.contribution))].join(", ")}). See where it stands: mycomap-validation contribute --status ${opts.folder}`);
    else {
      const words = ["Nothing in this run can be sent:", ...plan.leftOut.map((l) => `  ${l.record}${l.sequence ? `, read ${l.sequence}` : ""}: ${l.why}`)].join("\n");
      opts.say(words);
      return { code: 1, sent: [], problem: words };
    }
    return { code: 0, sent: [] };
  }
  if (!run.sheet) opts.say("No records sheet was found for this run, so no voucher, primers, run, plate or well go with it. Name it with --records <sheet> to add them.");
  for (const line of previewLines(plan, opts.settings)) opts.say(line);
  if (!opts.yes) {
    if (!opts.ask) {
      opts.say("Nothing was sent. To send without being asked, add --yes (which agrees to CC BY 4.0 for these sequences).");
      return { code: 1, sent: [] };
    }
    const seqs = sequencesIn(plan.parts);
    if (!(await opts.ask(`Send ${plural(seqs, "sequence")} to ${opts.settings.url}, and agree to CC BY 4.0 for them? [y/N] `))) {
      opts.say("Nothing was sent.");
      return { code: 0, sent: [] };
    }
  }
  const sent: ContributionEntry[] = [];
  for (const [i, part] of plan.parts.entries()) {
    let answer: any;
    try {
      answer = await call({ ...opts.settings, fetch: opts.fetch }, "POST", "/api/contributions", "send", part, { where: (b) => placeOf(part, b) });
    } catch (error) {
      if (!(error instanceof ContributeRefused)) throw error;
      opts.say(error.words);
      if (sent.length || i > 0) opts.say(`${plural(sent.length, "contribution")} of ${plan.parts.length} ${sent.length === 1 ? "was" : "were"} taken before this; run contribute again to send the rest.`);
      return { code: 1, sent, problem: error.words };
    }
    if (typeof answer.id !== "string" || !answer.id) {
      const words = `${opts.settings.url} answered without a contribution number, so the tool cannot follow it. Check your contributions on mycomap.org before sending again.`;
      opts.say(words);
      return { code: 1, sent, problem: words };
    }
    const entry: ContributionEntry = {
      id: answer.id,
      page: typeof answer.page === "string" ? answer.page : null,
      site: opts.settings.url,
      sentAt: (opts.now?.() ?? new Date()).toISOString(),
      records: part.records.map((r) => r.record),
      sequences: part.records.flatMap((r) => r.sequences.map((s) => s.id)),
      status: typeof answer.status === "string" ? answer.status : "received",
      checkedAt: null,
      answer: null,
    };
    // Kept as soon as it is taken, so a stop later never loses it.
    file.contributions.push(entry);
    writeContributionFile(opts.folder, file);
    sent.push(entry);
    opts.say(`Sent ${entry.id}: ${plural(entry.sequences.length, "sequence")} of ${plural(entry.records.length, "record")}, ${statusWords(entry.status)}.${entry.page ? ` Its page: ${entry.page}` : ""}`);
  }
  opts.say(`A person at MycoMap reviews it. See where it stands: mycomap-validation contribute --status ${opts.folder}`);
  return { code: 0, sent };
}

// ── following ──

const STATUS_WORDS: Record<string, string> = {
  received: "received", checking: "being checked", in_review: "in review", accepted: "accepted", partly_accepted: "partly accepted",
  refused: "refused", withdrawn: "withdrawn", waiting: "waiting", duplicate: "a duplicate",
};
export function statusWords(status: string): string {
  return STATUS_WORDS[status] ?? status;
}

/** One contribution's answer as lines: each record, and each read with mycomap.org's check and name. */
export function answerLines(answer: ContributionAnswer): string[] {
  const at = (t: string | null | undefined) => (t ? `${t.slice(0, 16).replace("T", " ")} UTC` : null);
  const lines = [`${answer.id}: ${statusWords(answer.status)}${at(answer.receivedAt) ? ` (received ${at(answer.receivedAt)}` : ""}${at(answer.decidedAt) ? `, decided ${at(answer.decidedAt)}` : ""}${at(answer.receivedAt) ? ")" : ""}`];
  // A reason is a person's sentence: its own closing stop goes, so "; " can follow it.
  const said = (reason: string | null | undefined) => (reason ?? "").trim().replace(/[\s.;:,]+$/, "");
  for (const r of answer.records ?? []) {
    lines.push(`  ${r.record}: ${statusWords(r.status)}${said(r.reason) ? ` - ${said(r.reason)}` : ""}`);
    for (const s of r.sequences ?? []) {
      // A read refused with its record's own reason does not repeat it.
      const own = said(s.reason) && said(s.reason) !== said(r.reason) ? said(s.reason) : "";
      const parts = [statusWords(s.status) + (own ? ` - ${own}` : "")];
      if (s.check) {
        const c = s.check;
        parts.push(`mycomap.org's check: ${c.dnaName ?? "no DNA name"}${typeof c.confidence === "number" ? ` (${c.confidence}%)` : ""}${c.flags?.length ? ` [${c.flags.join("; ")}]` : ""}${c.duplicateOf ? `; same bases as MycoMap sequence ${c.duplicateOf}` : ""}`);
      }
      if (s.mycomapSequenceId) parts.push(`MycoMap sequence ${s.mycomapSequenceId}`);
      if (s.name) parts.push(s.name.pending || !s.name.value ? "waiting for a MycoMap name" : `name: ${s.name.value} (${s.name.kind === "new" ? "a new MycoMap name" : "an existing MycoMap name"})`);
      lines.push(`    ${s.id}: ${parts.join("; ")}`);
    }
  }
  return lines;
}

// ── renaming ──

export interface Rename {
  sequence: string;
  from: string;
  to: string;
  kind: "existing" | "new";
  contribution: string;
}

/** Splits a CSV text into rows of fields (quotes, and newlines inside quotes, allowed). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const csvField = (text: string) => (/[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/** A CSV with each cell that is `from`, or lists it ("a; b"), given `to` instead. */
export function renameInCsv(text: string, renames: ReadonlyArray<Pick<Rename, "from" | "to">>): string {
  const map = new Map(renames.map((r) => [r.from, r.to]));
  const rows = parseCsv(text).map((row) => row.map((cell) => {
    if (map.has(cell)) return map.get(cell)!;
    if (!cell.includes("; ")) return cell;
    const parts = cell.split("; ");
    return parts.some((p) => map.has(p)) ? parts.map((p) => map.get(p) ?? p).join("; ") : cell;
  }));
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/**
 * Renames, in the run folder, each read with a local name that mycomap.org
 * has now named (7.2's name, no longer pending): results.json keeps the local
 * name and gains mycomapName; records.csv and results.csv show the new name.
 */
export function applyNames(folder: string, answers: readonly ContributionAnswer[]): Rename[] {
  const jsonFile = path.join(folder, "results.json");
  const results = readJson<RunResults>(jsonFile, `There is no results.json in ${folder}.`);
  const reads = new Map(results.sequences.map((s) => [s.id, s]));
  const renames: Rename[] = [];
  for (const answer of answers) {
    for (const r of answer.records ?? []) {
      for (const s of r.sequences ?? []) {
        const name = s.name;
        if (!name || name.pending || !name.value?.trim()) continue;
        const read = reads.get(s.id);
        if (!read?.localName) continue;
        const current = read.mycomapName?.value ?? read.localName;
        const to = name.value.trim();
        if (current === to) continue;
        read.mycomapName = { kind: name.kind === "new" ? "new" : "existing", value: to, contribution: answer.id };
        renames.push({ sequence: s.id, from: current, to, kind: read.mycomapName.kind as Rename["kind"], contribution: answer.id });
      }
    }
  }
  if (!renames.length) return [];
  const map = new Map(renames.map((r) => [r.from, r.to]));
  for (const rec of results.records) {
    if (rec.newName) rec.newName = rec.newName.split("; ").map((n) => map.get(n) ?? n).join("; ");
  }
  fs.writeFileSync(jsonFile, `${JSON.stringify(results, null, 2)}\n`);
  for (const csv of ["records.csv", "results.csv"]) {
    const file = path.join(folder, csv);
    if (fs.existsSync(file)) fs.writeFileSync(file, renameInCsv(fs.readFileSync(file, "utf8"), renames));
  }
  return renames;
}

export function renameLine(r: Rename): string {
  return `Renamed ${r.sequence}: ${r.from} -> ${r.to} (${r.kind === "new" ? "a new MycoMap name" : "an existing MycoMap name"}, from ${r.contribution}), in results.json, records.csv and results.csv.`;
}

function needContributions(folder: string): ContributionFile {
  const file = readContributionFile(folder);
  if (!file?.contributions.length) throw new InputError(`Nothing from this run has been sent to MycoMap. Send it with: mycomap-validation contribute ${folder}`);
  return file;
}

/** contribute --status <run folder>: reads each contribution again, shows it, keeps the answer, and renames what mycomap.org named. */
export async function statusOfRun(opts: Omit<FlowOptions, "ask" | "yes" | "fasta" | "records">): Promise<FlowResult & { renames: Rename[] }> {
  const file = needContributions(opts.folder);
  const problems: string[] = [];
  const answers: ContributionAnswer[] = [];
  for (const entry of file.contributions) {
    try {
      const answer = await call({ ...opts.settings, url: entry.site || opts.settings.url, fetch: opts.fetch }, "GET", `/api/contributions/${encodeURIComponent(entry.id)}`, "status", undefined, { id: entry.id });
      entry.answer = answer as ContributionAnswer;
      entry.status = typeof answer.status === "string" ? answer.status : entry.status;
      entry.checkedAt = (opts.now?.() ?? new Date()).toISOString();
      answers.push(entry.answer);
      for (const line of answerLines(entry.answer)) opts.say(line);
    } catch (error) {
      if (!(error instanceof ContributeRefused)) throw error;
      opts.say(`${entry.id}: ${error.words}`);
      problems.push(`${entry.id}: ${error.words}`);
    }
  }
  writeContributionFile(opts.folder, file);
  const renames = applyNames(opts.folder, answers);
  for (const r of renames) opts.say(renameLine(r));
  const waiting = answers.flatMap((a) => (a.records ?? []).flatMap((r) => (r.sequences ?? []).filter((s) => s.name && (s.name.pending || !s.name.value)))).length;
  if (waiting) opts.say(`${plural(waiting, "read")} still ${waiting === 1 ? "has its" : "have their"} local name: mycomap.org names them when the contribution is accepted.`);
  return { code: problems.length ? 1 : 0, sent: [], renames, ...(problems.length ? { problem: problems.join(" ") } : {}) };
}

/** contribute --withdraw <run folder>: withdraws each contribution not yet decided, after asking. */
export async function withdrawRun(opts: Omit<FlowOptions, "fasta" | "records">): Promise<FlowResult> {
  const file = needContributions(opts.folder);
  const open = file.contributions.filter((c) => !DECIDED.has(c.status));
  if (!open.length) {
    opts.say(`Nothing to withdraw: ${file.contributions.map((c) => `${c.id} is ${statusWords(c.status)}`).join(", ")}.`);
    return { code: 0, sent: [] };
  }
  opts.say(`This withdraws ${open.map((c) => `${c.id} (${plural(c.sequences.length, "sequence")}, ${statusWords(c.status)})`).join(", ")} from ${opts.settings.url}. Once withdrawn, it is not reviewed.`);
  if (!opts.yes) {
    if (!opts.ask) { opts.say("Nothing was withdrawn. To withdraw without being asked, add --yes."); return { code: 1, sent: [] }; }
    if (!(await opts.ask(`Withdraw ${open.length === 1 ? "it" : "them"}? [y/N] `))) { opts.say("Nothing was withdrawn."); return { code: 0, sent: [] }; }
  }
  const problems: string[] = [];
  for (const entry of open) {
    try {
      const answer = await call({ ...opts.settings, url: entry.site || opts.settings.url, fetch: opts.fetch }, "DELETE", `/api/contributions/${encodeURIComponent(entry.id)}`, "withdraw", undefined, { id: entry.id });
      entry.answer = answer as ContributionAnswer;
      entry.status = typeof answer.status === "string" ? answer.status : "withdrawn";
      entry.checkedAt = (opts.now?.() ?? new Date()).toISOString();
      opts.say(`${entry.id}: ${statusWords(entry.status)}. Its records can be sent again with contribute.`);
    } catch (error) {
      if (!(error instanceof ContributeRefused)) throw error;
      opts.say(`${entry.id}: ${error.words}`);
      problems.push(`${entry.id}: ${error.words}`);
    }
  }
  writeContributionFile(opts.folder, file);
  return { code: problems.length ? 1 : 0, sent: [], ...(problems.length ? { problem: problems.join(" ") } : {}) };
}
