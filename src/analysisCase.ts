// A CASE: everything one analysis was asked, what each outside call answered,
// and the result. Replaying a case must give the same result on any machine,
// with no network and no database: the check every change to the rules, and
// every step of moving them here, is held to.
//
// The parts of record-and-replay that need no platform live here. The server
// keeps the recording itself (mycomap.org's analysisCase.ts), and
// caseReplay.ts runs a case.

export const ANALYSIS_CASE_FORMAT = 1;

/** One door's kept answers: what it was asked (as a stable string) and what it said. */
export type AnalysisCaseCalls = Record<string, Array<{ asked: string; answer: unknown }>>;

export interface AnalysisCase<Args = unknown, Result = unknown> {
  format: typeof ANALYSIS_CASE_FORMAT;
  capturedAt: string;
  /** The rules the answer was made under, e.g. "1.4". */
  rulesVersion: string;
  /** What the analysis was called with, minus anything secret. */
  args: Args;
  calls: AnalysisCaseCalls;
  result: Result;
}

/** A replay asked a door for an answer the case does not hold. */
export class AnalysisReplayMiss extends Error {
  constructor(readonly door: string, readonly asked: string) {
    super(`Replay has no recorded answer for door "${door}" asked ${asked.length > 200 ? `${asked.slice(0, 200)}…` : asked}`);
    this.name = "AnalysisReplayMiss";
  }
}

/** JSON with object keys in a fixed order, so the same question always reads the same. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v === undefined ? null : v;
  }) ?? "null";
}

/**
 * Result fields added after cases began to be captured, with the release that
 * added each. A case recorded before then has no such field; its replay may, and
 * that alone is not a difference. Once a recording holds the field, it is
 * compared like any other.
 */
export const RESULT_FIELDS_ADDED_LATER: Readonly<Record<string, string>> = {
  genbankLikelyName: "2.0.0-beta.2",
};

/** The replayed result without the later-added fields its recording predates (RESULT_FIELDS_ADDED_LATER). */
export function withoutFieldsRecordingPredates(recorded: unknown, replayed: unknown): unknown {
  if (!recorded || typeof recorded !== "object" || !replayed || typeof replayed !== "object" || Array.isArray(replayed)) return replayed;
  const predates = Object.keys(RESULT_FIELDS_ADDED_LATER).filter((key) => !(key in (recorded as object)));
  if (!predates.length) return replayed;
  return Object.fromEntries(Object.entries(replayed as Record<string, unknown>).filter(([key]) => !predates.includes(key)));
}

/** The first place two answers differ, as a path ("steps[4].message"), or null when they are the same. */
export function firstDifference(a: unknown, b: unknown, path = ""): string | null {
  if (a === b) return null;
  if (a === undefined || a === null || b === undefined || b === null) {
    // JSON drops undefined, so a missing field and an undefined one are the same answer.
    return (a ?? null) === (b ?? null) ? null : `${path || "(root)"}: ${JSON.stringify(a ?? null)} vs ${JSON.stringify(b ?? null)}`;
  }
  if (typeof a !== "object" || typeof b !== "object") {
    return `${path || "(root)"}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path || "(root)"}: one is a list, the other is not`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path || "(root)"}: ${a.length} items vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const diff = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])].sort();
  for (const key of keys) {
    const diff = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
    if (diff) return diff;
  }
  return null;
}
