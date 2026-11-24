// MycoMap Vision, asked through its public API (v1) with the user's own key,
// for the record decisions (records.ts). Only when the user gives a key:
// without one the tool sends nothing anywhere.
//
//   POST /api/v1/identify/{inat|mo}/{id}   an iNaturalist or Mushroom Observer
//                                           observation: Vision reads its photos
//   POST /api/v1/identify                  1 to 10 photos from a folder, uploaded
//   GET  /api/v1/usage                     the key's quota this month (never counted)
//
// Each answer is read the way mycomap.org reads it
// (mycomap.org's recordVisionRuns.ts): the combined ranks,
// five names each, the not-a-fungus gate's verdict, whether the record was left
// out of its own answer, the model release and the answers version. The engine's
// visionAgreementVisionFromRun then turns it into what the rules read.
//
// Asking again: Vision busy, updating or out of reach (502, 503, 504, a
// rate limit, no connection) is asked again after 5, 10, 20, 30 and 45 s, or
// Vision's Retry-After when longer, for at most two minutes, as mycomap.org
// does. A refused key or a used-up quota stops every later ask in the run: the
// answer would be the same.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { visionAgreementVisionFromRun, type VisionAgreementVision, type VisionCandidate } from "../src/visionAgreement";

export const DEFAULT_VISION_URL = "https://vision.mycomap.org";
/** Names kept per rank, as mycomap.org keeps them (and asks for). */
export const VISION_TOP_K = 5;
export const VISION_RETRY_DELAYS_S = [5, 10, 20, 30, 45] as const;
export const VISION_RETRY_BUDGET_MS = 120_000;
const MAX_RETRY_WAIT_S = 60;
const CALL_TIMEOUT_MS = 180_000;
/** Vision's own limits for an upload (its API's upload rules). */
export const VISION_MAX_PHOTOS = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_REQUEST_BYTES = 80 * 1024 * 1024;
const PHOTO_TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

export interface VisionSettings {
  key: string;
  /** Vision's address, without a trailing slash. */
  url: string;
}

/** A setting the tool cannot use: the message says what to change. */
export class VisionSettingError extends Error {}

/**
 * The Vision settings from the options, else MYCOMAP_VISION_KEY and
 * MYCOMAP_VISION_URL; null when there is no key (Vision is not asked). The key
 * goes only to an https address, or to this computer.
 */
export function visionSettings(input: { key?: string | null; url?: string | null; env?: NodeJS.ProcessEnv }): VisionSettings | null {
  const env = input.env ?? process.env;
  const key = (input.key ?? env.MYCOMAP_VISION_KEY ?? "").trim();
  if (!key) return null;
  const url = (input.url ?? env.MYCOMAP_VISION_URL ?? DEFAULT_VISION_URL).trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new VisionSettingError(`"${url}" is not a web address for MycoMap Vision. The public one is ${DEFAULT_VISION_URL}.`);
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    throw new VisionSettingError(`The Vision key is only sent over https (or to this computer), so "${url}" cannot be used.`);
  }
  return { key, url };
}

/** What Vision is asked about one record. */
export type VisionTarget =
  | { kind: "observation"; platform: "inat" | "mo"; id: string }
  | { kind: "photos"; folder: string };

/** The observation a record names ("inat:123", "mo:456"), or null. */
export function observationTarget(record: string): Extract<VisionTarget, { kind: "observation" }> | null {
  const m = /^(inat|mo):(\d{1,12})$/i.exec(record.trim());
  return m ? { kind: "observation", platform: m[1].toLowerCase() as "inat" | "mo", id: m[2] } : null;
}

export interface VisionUsage {
  plan: string | null;
  used: number | null;
  limit: number | null;
  period: string | null;
  resetsAt: string | null;
}

export interface VisionAnswer {
  /** What the rules read. */
  vision: VisionAgreementVision;
  /** The model release that answered (model.version). */
  model: string | null;
  /** What Vision answered from: model.answers_version, else the release. */
  answersVersion: string | null;
  /** Vision gave an answer it already held for the observation. */
  kept: boolean;
  /** How it was asked. */
  by: VisionTarget["kind"];
  photos: number | null;
}

export type VisionReply = { ok: true; answer: VisionAnswer } | { ok: false; code: string; words: string };

export interface VisionClientOptions extends VisionSettings {
  /** Test seams. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysS?: readonly number[];
  retryBudgetMs?: number;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Vision's ranks, the first five named ones each, as mycomap.org keeps them. */
function ranksOf(ranks: unknown): { species: VisionCandidate[]; genus: VisionCandidate[]; family: VisionCandidate[] } {
  const take = (list: unknown): VisionCandidate[] => (Array.isArray(list) ? list : [])
    .filter((c: any) => str(c?.name))
    .slice(0, VISION_TOP_K)
    .map((c: any) => ({ name: str(c.name)!, confidence: num(c.confidence) }));
  const r = ranks && typeof ranks === "object" ? ranks as Record<string, unknown> : {};
  return { species: take(r.species), genus: take(r.genus), family: take(r.family) };
}

/** The version an answer was given under, as mycomap.org reads it (recordVisionRuns.ts visionAnswersVersion). */
export function answersVersionOf(model: any): string | null {
  const answers = str(model?.answers_version);
  if (answers) return answers;
  const release = str(model?.version);
  return release ? `release:${release}` : null;
}

/** A v1 answer from Vision's API, as the rules read it. */
export function visionAnswerFromBody(body: any, by: VisionTarget["kind"]): VisionAnswer {
  const model = str(body?.model?.version);
  const answersVersion = answersVersionOf(body?.model);
  const vision = visionAgreementVisionFromRun({
    id: 0,
    status: "done",
    modelVersion: model,
    answersVersion,
    result: { gateVerdict: str(body?.gate?.verdict), excludedReference: !!body?.excluded_reference, combined: ranksOf(body?.ranks) },
  })!;
  const photos = num(body?.observation?.photos_used) ?? num(body?.photos) ?? (Array.isArray(body?.per_photo) ? body.per_photo.length : null);
  return { vision: { ...vision, runId: null }, model, answersVersion, kept: body?.cached === true, by, photos };
}

export function usageFromBody(u: any): VisionUsage | null {
  if (!u || typeof u !== "object") return null;
  return { plan: str(u.plan), used: num(u.used), limit: num(u.limit), period: str(u.period), resetsAt: str(u.resets_at) };
}

const whenText = (iso: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC` : null);

/** The quota in words: "12 of 300 used this month (2026-11), resets 2026-12-01 00:00 UTC". */
export function usageText(u: VisionUsage | null): string | null {
  if (!u || u.used === null) return null;
  const of = u.limit === null ? `${u.used} used, no limit` : `${u.used} of ${u.limit} used, ${Math.max(0, u.limit - u.used)} left`;
  const reset = whenText(u.resetsAt);
  return `${of}${u.period ? ` this month (${u.period})` : ""}${reset ? `; resets ${reset}` : ""}`;
}

const INACTIVE: Record<string, string> = {
  pending: "it is still waiting to be approved",
  disabled: "it has been turned off",
  revoked: "it has been revoked",
  account_inactive: "its owner's account is not active",
  wrong_service: "it is not a Vision key",
};

/** A refusal in words. */
function refusalWords(status: number, body: any, target: VisionTarget | null): { code: string; words: string } {
  const code = str(body?.code) ?? (status === 0 ? "unreachable" : `http_${status}`);
  const detail = str(body?.detail) ?? str(body?.message);
  if (code === "invalid_token" || code === "token_expired" || status === 401) {
    return { code, words: "MycoMap Vision refused the key (it does not know it; check the key mycomap.org/vision-keys gave you)" };
  }
  if (code === "key_inactive" || status === 403) {
    const why = INACTIVE[str(body?.reason) ?? ""] ?? detail ?? "it is not active";
    return { code, words: `MycoMap Vision refused the key (${why})` };
  }
  if (code === "quota_exceeded") {
    const u = usageFromBody({ used: body?.used, limit: body?.limit, resets_at: body?.resets_at });
    const reset = whenText(u?.resetsAt ?? null);
    return { code, words: `MycoMap Vision's quota for this key is used up (${u?.limit != null ? `${u.used ?? u.limit} of ${u.limit}` : "this month's"}${reset ? `; it resets ${reset}` : ""})` };
  }
  if (code === "observation_not_found" || (status === 404 && target?.kind === "observation")) {
    const site = target?.kind === "observation" && target.platform === "mo" ? "Mushroom Observer" : "iNaturalist";
    return { code, words: `MycoMap Vision could not find ${site} observation ${target?.kind === "observation" ? target.id : ""}`.trim() };
  }
  // mycomap.org's own words, so the rules' reason reads as it does there.
  if (code === "no_usable_photos") return { code, words: "MycoMap Vision found no usable photos" };
  if (code === "unreachable") return { code, words: `MycoMap Vision could not be reached${detail ? ` (${detail})` : ""}` };
  return { code, words: `MycoMap Vision answered HTTP ${status}${detail ? `: ${detail}` : ""}` };
}

/** Busy, updating, out of reach or rate-limited: worth asking again (recordVisionRuns.ts isTemporaryVisionFailure). */
export function isTemporary(status: number, code: string | null): boolean {
  if (code === "quota_exceeded") return false;
  if (status === 0 || status === 429 || status === 502 || status === 503 || status === 504) return true;
  return code === "busy" || code === "updating" || code === "source_unavailable";
}

/** The photos in a folder Vision can read, in name order: at most ten, each and all within Vision's limits. */
export function photosInFolder(folder: string): { files: string[]; problem: string | null; leftOut: number } {
  let names: string[];
  try {
    names = fs.readdirSync(folder).filter((n) => PHOTO_TYPES[path.extname(n).toLowerCase()] && fs.statSync(path.join(folder, n)).isFile()).sort();
  } catch {
    return { files: [], problem: `the photos folder ${folder} could not be read`, leftOut: 0 };
  }
  if (names.length === 0) return { files: [], problem: `the photos folder ${folder} has no JPEG, PNG or WebP photos`, leftOut: 0 };
  const files = names.slice(0, VISION_MAX_PHOTOS).map((n) => path.join(folder, n));
  let total = 0;
  for (const f of files) {
    const size = fs.statSync(f).size;
    if (size > MAX_FILE_BYTES) return { files: [], problem: `${path.basename(f)} is larger than Vision takes (25 MB); a long side of 640 to 1024 pixels is plenty`, leftOut: 0 };
    total += size;
  }
  if (total > MAX_REQUEST_BYTES) return { files: [], problem: `the photos in ${folder} are larger than Vision takes together (80 MB)`, leftOut: 0 };
  return { files, problem: null, leftOut: names.length - files.length };
}

export interface VisionClient {
  readonly url: string;
  /** The key's quota, or null when Vision does not say. A refused key stops the run's asks. */
  usage(): Promise<VisionUsage | null>;
  ask(target: VisionTarget): Promise<VisionReply>;
  /** Why no more records are asked about, once the key is refused or the quota used up. */
  readonly stopped: { code: string; words: string } | null;
  /** The quota as the last answer gave it. */
  readonly lastUsage: VisionUsage | null;
  /** Calls made that Vision may count (identify calls). */
  readonly calls: number;
}

export function createVisionClient(opts: VisionClientOptions): VisionClient {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const delays = opts.retryDelaysS ?? VISION_RETRY_DELAYS_S;
  const budget = opts.retryBudgetMs ?? VISION_RETRY_BUDGET_MS;
  const auth = { Authorization: `Bearer ${opts.key}`, Accept: "application/json" };
  let stopped: { code: string; words: string } | null = null;
  let lastUsage: VisionUsage | null = null;
  let calls = 0;

  async function call(url: string, init: RequestInit): Promise<{ status: number; body: any; retryAfter: number | null; error?: string }> {
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      let body: any = null;
      try { body = await res.json(); } catch { body = null; }
      const retry = Number(res.headers.get("retry-after") ?? body?.retry_after_seconds);
      return { status: res.status, body, retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null };
    } catch (error: any) {
      return { status: 0, body: { detail: String(error?.cause?.code ?? error?.message ?? error) }, retryAfter: null };
    }
  }

  const stopFor = (code: string) => code === "invalid_token" || code === "token_expired" || code === "key_inactive" || code === "quota_exceeded" || /^http_40[13]$/.test(code);

  async function request(target: VisionTarget): Promise<RequestInit | { problem: string }> {
    if (target.kind === "observation") {
      return {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ top_k: VISION_TOP_K, use_place: true, use_date: true }),
      };
    }
    const { files, problem } = photosInFolder(target.folder);
    if (problem) return { problem };
    const form = new FormData();
    for (const f of files) form.append("photos", new Blob([fs.readFileSync(f)], { type: PHOTO_TYPES[path.extname(f).toLowerCase()] }), path.basename(f));
    form.append("top_k", String(VISION_TOP_K));
    // The same find within a day is counted once. A digest, so the folder's name is not sent.
    form.append("client_ref", `mmv-${crypto.createHash("sha256").update(path.resolve(target.folder)).digest("hex").slice(0, 32)}`);
    return { method: "POST", headers: auth, body: form };
  }

  return {
    url: opts.url,
    get stopped() { return stopped; },
    get lastUsage() { return lastUsage; },
    get calls() { return calls; },
    async usage() {
      const r = await call(`${opts.url}/api/v1/usage`, { headers: auth });
      if (r.status === 401 || r.status === 403) {
        stopped = refusalWords(r.status, r.body, null);
        return null;
      }
      if (r.status !== 200) return null;
      lastUsage = usageFromBody(r.body?.usage) ?? lastUsage;
      if (lastUsage?.limit != null && lastUsage.used != null && lastUsage.used >= lastUsage.limit) {
        stopped = refusalWords(429, { code: "quota_exceeded", used: lastUsage.used, limit: lastUsage.limit, resets_at: lastUsage.resetsAt }, null);
      }
      return lastUsage;
    },
    async ask(target) {
      if (stopped) return { ok: false, ...stopped };
      const init = await request(target);
      if ("problem" in init) return { ok: false, code: "photos", words: `MycoMap Vision was not asked: ${init.problem}` };
      const url = target.kind === "observation" ? `${opts.url}/api/v1/identify/${target.platform}/${target.id}` : `${opts.url}/api/v1/identify`;
      let tries = 0;
      let waited = 0;
      for (;;) {
        tries++;
        calls++;
        const r = await call(url, init);
        if (r.status === 200 && r.body && typeof r.body === "object") {
          lastUsage = usageFromBody(r.body.usage) ?? lastUsage;
          return { ok: true, answer: visionAnswerFromBody(r.body, target.kind) };
        }
        const refusal = refusalWords(r.status, r.body, target);
        if (isTemporary(r.status, str(r.body?.code))) {
          const scheduled = delays[Math.min(tries, delays.length) - 1] ?? 0;
          const waitS = Math.max(scheduled, Math.min(MAX_RETRY_WAIT_S, r.retryAfter ?? 0));
          if (waited + waitS * 1000 <= budget) {
            waited += waitS * 1000;
            await sleep(waitS * 1000);
            continue;
          }
          const busy = r.status === 0 ? refusal.words : `MycoMap Vision was busy (${refusal.code === `http_${r.status}` ? `HTTP ${r.status}` : refusal.code})`;
          return { ok: false, code: refusal.code, words: `${busy} and did not answer (${tries} ${tries === 1 ? "try" : "tries"} over ${Math.round(waited / 1000)} s)` };
        }
        if (stopFor(refusal.code)) stopped = refusal;
        return { ok: false, ...refusal };
      }
    },
  };
}
