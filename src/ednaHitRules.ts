// Which hits count for coverage, and which environmental hits qualify. Moved
// unchanged from mycomap.org's batchAnalysisService.ts
//. Nothing here makes an outside call.
import { BACTERIAL_QUERY_COVERAGE_THRESHOLD, type BlastHit, COMBINED_COVERAGE_THRESHOLD, type ParsedBlastResult, QC_SC_RATIO_THRESHOLD, QUERY_COVERAGE_THRESHOLD, calculateQueryCover, calculateSubjectCover } from "./analysisRules";
import { type AmpliconFamily } from "./ednaAmplicon";
import { envBlastHitVariantId } from "./envBlastHitFilter";

export function meetsEdnaCoverageThreshold(
  hit: BlastHit,
  queryLen: number,
  ampliconFamily?: AmpliconFamily | null,
): boolean {
  const qCov = calculateQueryCover(hit, queryLen);
  // For long queries (>500 bp), relax the primary query-coverage threshold to 30%
  // — long reads can be locally informative even with partial overlap.
  // Short queries (<=500 bp) keep the strict 70% threshold.
  const longQuery = queryLen > 500;
  const primaryThreshold = ampliconFamily === "bacterial_16s"
    ? BACTERIAL_QUERY_COVERAGE_THRESHOLD
    : (longQuery ? BACTERIAL_QUERY_COVERAGE_THRESHOLD : QUERY_COVERAGE_THRESHOLD);
  if (qCov >= primaryThreshold) return true;
  // For bacterial 16S we skip the subject-cover/ratio fallback entirely.
  // Reference subjects are frequently whole chloroplast/genome records (100k+ bp),
  // making subject coverage meaningless and the combined/ratio rules misleading.
  if (ampliconFamily === "bacterial_16s") return false;
  const sCov = Math.abs(calculateSubjectCover(hit));
  if ((qCov + sCov) < COMBINED_COVERAGE_THRESHOLD) return false;
  if (sCov > 0 && (qCov / sCov) < QC_SC_RATIO_THRESHOLD) return false;
  return true;
}

/**
 * envBLAST hits that count as matches for an eDNA variant: never the variant
 * itself (every query hits its own database entry at 100%), first HSP at or
 * above `identityThreshold`, and passing the eDNA coverage rule. Hits whose
 * variant id cannot be read are kept, as before, but flagged with a null id.
 */
export function qualifyingEnvBlastHits(
  envResult: ParsedBlastResult,
  selfVariantId: string,
  identityThreshold: number,
  queryLen: number,
  ampliconFamily?: AmpliconFamily | null,
): Array<{ hit: BlastHit; variantId: string | null; rawIdentity: number }> {
  const out: Array<{ hit: BlastHit; variantId: string | null; rawIdentity: number }> = [];
  for (const hit of envResult.hits) {
    const variantId = envBlastHitVariantId(hit);
    if (variantId !== null && variantId === selfVariantId) continue;
    const firstHsp = hit.hsps[0];
    if (!firstHsp) continue;
    const rawIdentity = firstHsp.alignLen > 0 ? (firstHsp.identity / firstHsp.alignLen) * 100 : 0;
    if (rawIdentity < identityThreshold) continue;
    if (!meetsEdnaCoverageThreshold(hit, queryLen, ampliconFamily)) continue;
    out.push({ hit, variantId, rawIdentity });
  }
  return out;
}
