// The curation recommendations an analysis makes: which records near the
// query should be renamed, validated, re-flagged or reverse-complemented, each
// with a stable id. Moved unchanged from
// mycomap.org's batchAnalysisService.ts. Nothing here makes an outside call.
import { ADJUSTED_IDENTITY_THRESHOLD, type AnalysisResult, type BlastHit, type DeterministicCurationRecommendation, type ParsedBlastResult, type SequenceRecord, calculateQueryCover, calculateSubjectCover, extractPlatformObsRef, extractSpeciesName, findSequenceRecordForHit, isExcludedReference, isTrashReference, obsSpeciesKey, parseFlags, sourceNonTargetStatus } from "./analysisRules";
import { utf8Base64Url } from "./encoding";
import { hasExcludedSequenceFlag } from "./sequenceExclusionFlags";
import { isSpeciesLevelCurationTarget, speciesNamesMatch } from "./speciesNames";

export function deterministicCurationRecommendationId(
  source: DeterministicCurationRecommendation["source"],
  recordId: string,
  action: DeterministicCurationRecommendation["action"],
  targetValue: string | null,
): string {
  const canonicalTuple = JSON.stringify([source, recordId, action, targetValue]);
  return `curation:${utf8Base64Url(canonicalTuple)}`;
}


export function deterministicCurationRecommendations(
  hits: BlastHit[],
  queryLen: number,
  consensusSpecies: string | null,
  sequenceMap: Record<string, SequenceRecord>,
  adjustedIdentityMap: Record<number, number>,
  obsSpeciesMap: Record<string, string>,
): DeterministicCurationRecommendation[] {
  // Strand orientation is a fact about the record, not about the consensus, so
  // it is reported even when no species-level consensus exists.
  const namingTarget = isSpeciesLevelCurationTarget(consensusSpecies) ? consensusSpecies : null;
  const recommendations = new Map<string, DeterministicCurationRecommendation>();
  const add = (
    recordId: string,
    action: DeterministicCurationRecommendation["action"],
    targetValue: string | null,
    currentValue: string | null,
  ) => {
    const recommendationId = deterministicCurationRecommendationId("mycoblast", recordId, action, targetValue);
    recommendations.set(recommendationId, {
      recommendationId,
      source: "mycoblast",
      recordId,
      recordType: "sequence",
      action,
      targetValue,
      currentValue,
    });
  };
  for (const hit of hits) {
    const seqRecord = findSequenceRecordForHit(hit, sequenceMap);
    if (isTrashReference(seqRecord) || isExcludedReference(seqRecord)) continue;
    const adjVal = adjustedIdentityMap[hit.num] ?? null;
    const meetsThreshold = adjVal !== null && adjVal >= 99.5;
    const queryCover = calculateQueryCover(hit, queryLen);
    const subjectCover = calculateSubjectCover(hit);
    const isNegCover = queryCover < 0 || subjectCover < 0;
    const displaySp = seqRecord?.scientificName || null;
    const parentSp = seqRecord?.species?.parent ? seqRecord.species.parent.replace(/^\d+\s*-\s*/, '').trim() || null : null;
    const obsSp = seqRecord ? obsSpeciesMap[obsSpeciesKey(extractPlatformObsRef(seqRecord))] || null : null;
    const obsSpeciesName = parentSp || obsSp;
    if (!seqRecord) continue;
    const recordId = String(seqRecord.id ?? hit.accession);
    if (isNegCover) add(recordId, "reverse_complement", "reverse_complement", null);
    if (!namingTarget) continue;
    if (meetsThreshold && displaySp && !speciesNamesMatch(displaySp, namingTarget)) {
      add(recordId, "update_sequence_name", namingTarget, displaySp);
    }
    // A sequence already flagged non-target, contaminant or wrong specimen
    // does not describe its specimen, so it can never rename that specimen's
    // observation.
    const describesItsSpecimen = sourceNonTargetStatus(seqRecord as Record<string, any>).nonTargetFlag !== true
      && !hasExcludedSequenceFlag(seqRecord.flags);
    if (meetsThreshold && describesItsSpecimen && obsSpeciesName && !speciesNamesMatch(obsSpeciesName, namingTarget)) {
      add(recordId, "update_observation_name", namingTarget, obsSpeciesName);
    }
    if (meetsThreshold && (seqRecord.validationStatus === "not_assessed" || !seqRecord.validationStatus)) {
      add(recordId, "validate_sequence", "verified", seqRecord.validationStatus ?? "not_assessed");
    }
    if (meetsThreshold && seqRecord.flags) {
      const flags = parseFlags(seqRecord.flags);
      const hasLow = flags.some(f => f === "low" || f === "low-ric");
      if (hasLow && displaySp && speciesNamesMatch(displaySp, namingTarget)) {
        add(recordId, "clear_low_quality_flag", "clear", "low");
      }
    }
  }
  return [...recommendations.values()];
}

/**
 * Only an accession that matches the query at the deciding identity threshold
 * belongs to the query's lineage. A differently named hit below it is a
 * different species, not a mislabelled copy of this one: recommending its
 * rename once told curators to relabel Cortinarius inops, C. helobius and
 * C. polaris as C. pacificovernus. An unknown identity is not a passing one.
 */
export function ncbiNameCurationRecommendations(
  hits: BlastHit[],
  consensusSpecies: string | null,
  genbankMap: Record<string, Record<string, any>>,
  adjustedIdentityMap: Record<number, number> = {},
  identityThreshold = ADJUSTED_IDENTITY_THRESHOLD,
): DeterministicCurationRecommendation[] {
  if (!isSpeciesLevelCurationTarget(consensusSpecies)) return [];
  const recommendations = new Map<string, DeterministicCurationRecommendation>();
  for (const hit of hits) {
    const adjustedIdentity = adjustedIdentityMap[hit.num];
    if (typeof adjustedIdentity !== "number" || !Number.isFinite(adjustedIdentity) || adjustedIdentity < identityThreshold) continue;
    const currentName = String(genbankMap[hit.accession]?.scientificName || genbankMap[hit.accession]?.organism || extractSpeciesName(hit.def) || "").trim();
    if (!currentName || speciesNamesMatch(currentName, consensusSpecies)) continue;
    const recommendationId = deterministicCurationRecommendationId("ncbi", hit.accession, "update_accession_name", consensusSpecies);
    recommendations.set(recommendationId, {
      recommendationId,
      source: "ncbi" as const,
      recordId: hit.accession,
      recordType: "accession" as const,
      action: "update_accession_name" as const,
      targetValue: consensusSpecies,
      currentValue: currentName,
    });
  }
  return [...recommendations.values()];
}

export function setDeterministicCurationRecommendations(
  result: AnalysisResult,
  localResult: ParsedBlastResult,
  ncbiResult: ParsedBlastResult,
  sequenceMap: Record<string, SequenceRecord>,
  localAdjustedMap: Record<number, number>,
  obsSpeciesMap: Record<string, string>,
  genbankMap: Record<string, Record<string, any>>,
  ncbiAdjustedMap: Record<number, number>,
): void {
  const consensus = result.localConsensusSpecies || result.finalSpecies;
  const authoritativeNamingConsensus = result.localConsensusSpecies
    || (result.finalSpecies && result.finalSpecies !== "Manual Validation Needed" ? result.finalSpecies : null)
    || result.ncbiConsensusSpecies;
  result.curationRecommendations = [...new Map([
    ...deterministicCurationRecommendations(localResult.hits, localResult.queryLen, consensus, sequenceMap, localAdjustedMap, obsSpeciesMap),
    ...ncbiNameCurationRecommendations(ncbiResult.hits, authoritativeNamingConsensus, genbankMap, ncbiAdjustedMap),
  ].map(item => [item.recommendationId, item])).values()];
  result.curationCount = new Set(result.curationRecommendations.map(item => `${item.source}:${item.recordId}`)).size;
}
