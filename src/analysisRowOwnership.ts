// Which stored analysis is whose: an eDNA variant's analysis and a sequence's can share an id.
// The part of mycomap.org's analysisRowOwnership.ts that reads a result and
// asks nothing of a database. The SQL stays on the server.

/**
 * Whose analysis a blast_analysis_results row holds.
 *
 * The table has one text key, sample_id, shared by two kinds of subject:
 *   - a record store specimen sequence record: its id, digits only ("564929");
 *   - an eDNA variant: "edna-<variantId>" (ednaAnalysisKey).
 *
 * Until 2026-10-20 an eDNA variant's analysis was also written under its record store
 * BLAST job id (edna.ts copied it there, and the BLAST results page saved under
 * the URL's job id). Job ids come from another record store table whose numbers overlap
 * sequence ids, so BLAST job 564929 (a Brassica eDNA variant) replaced the
 * analysis of sequence 564929 (a Calocera specimen). eDNA analyses now live only
 * under "edna-<variantId>", every new row records its own key
 * (ANALYSIS_SUBJECT_FIELD), and readers drop a row that is not the subject's own
 * (analysisRowBelongsTo, OWN_ANALYSIS_ROW_SQL).
 *
 * Old rows carry no key. An eDNA analysis is recognised by what only eDNA
 * analyses write: a step named "eDNA …" / "… eDNA Consensus" / "Bacterial 16S …",
 * or an ednaTempCode / ednaGenusConsensus (both analyzers set these only for an
 * eDNA variant). Older eDNA analyses (before those steps existed) cannot be told
 * apart from the row alone; scripts/ednaAnalysisKeyCleanup.ts finds those as
 * exact copies of the variant's own row.
 */

export const EDNA_ANALYSIS_KEY_PREFIX = "edna-";

/** The resultData field naming the sample_id the analysis was saved for. */
export const ANALYSIS_SUBJECT_FIELD = "analysisSubject";

/** The step names only an eDNA variant's analysis writes. */
export const EDNA_STEP_PATTERN = /^eDNA |eDNA Consensus|^Bacterial 16S/;
export function isEdnaAnalysisKey(sampleId: string): boolean {
  return typeof sampleId === "string" && sampleId.startsWith(EDNA_ANALYSIS_KEY_PREFIX);
}

function nonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v !== "";
}

/** The key an analysis says it was saved for, or null for a row from before 2026-10-20. */
export function analysisSubjectOf(resultData: unknown): string | null {
  if (!resultData || typeof resultData !== "object") return null;
  const subject = (resultData as Record<string, unknown>)[ANALYSIS_SUBJECT_FIELD];
  return typeof subject === "string" ? subject : null;
}

/** Whether an analysis is an eDNA variant's, from the analysis alone. */
export function isEdnaAnalysisResult(resultData: unknown): boolean {
  if (!resultData || typeof resultData !== "object") return false;
  const subject = analysisSubjectOf(resultData);
  if (subject !== null) return isEdnaAnalysisKey(subject);
  const rd = resultData as Record<string, unknown>;
  if (nonEmptyString(rd.ednaTempCode) || nonEmptyString(rd.ednaGenusConsensus)) return true;
  if (Array.isArray(rd.steps)) {
    for (const step of rd.steps) {
      const name = step && typeof step === "object" ? (step as Record<string, unknown>).step : null;
      if (typeof name === "string" && EDNA_STEP_PATTERN.test(name)) return true;
    }
  }
  return false;
}
