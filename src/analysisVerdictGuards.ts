// Rules that keep a missing NCBI BLAST result from turning into a verdict.
//
// While NCBI BLAST is down (10/19-20), sequences have MycoBLAST results but no
// NCBI XML. The analysis already refuses to run without NCBI; these guard the
// two places where "no NCBI yet" still leaked into a decision.

/** The analysis results runFullAnalysis gives when NCBI is missing or could not be read. */
const AWAITING_NCBI_ERRORS: ReadonlySet<string> = new Set(["NCBI BLAST results required", "Awaiting NCBI"]);

export function isAwaitingNcbiResult(result: { status?: unknown; errorMessage?: unknown } | null | undefined): boolean {
  return result?.status === "error" && typeof result.errorMessage === "string" && AWAITING_NCBI_ERRORS.has(result.errorMessage);
}

/**
 * Whether a new analysis result may replace the stored one. An "awaiting NCBI"
 * error never replaces a complete result: the stored verdict was made from
 * real NCBI hits, and the new run only says NCBI isn't readable right now
 * (NCBI down, or a rerun cleared the XML until NCBI answers).
 */
export function mayReplaceStoredAnalysis(
  stored: { status?: unknown } | null | undefined,
  next: { status?: unknown; errorMessage?: unknown },
): boolean {
  return !(isAwaitingNcbiResult(next) && stored?.status === "complete");
}

/**
 * Auto-validate's "only contaminant sequences" rejection. It may reject only
 * when every sequence has an analysis result and none of them is usable. A
 * sequence with no result at all (not analysed yet, e.g. still waiting for
 * NCBI) means wait, never reject.
 */
export function contaminantOnlyOutcome(
  seqResults: ReadonlyArray<{ result: unknown | null }>,
  usableCount: number,
): "reject" | "wait" | "continue" {
  if (usableCount > 0) return "continue";
  return seqResults.some((sr) => !sr.result) ? "wait" : "reject";
}
