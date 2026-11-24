// The pure rules of the deterministic analysis: names, votes, consensus tiers,
// coverage, confidence, and the shapes they work on. Moved unchanged from
// mycomap.org's batchAnalysisService.ts, which still holds the analysis itself and imports these.
// Nothing here makes an outside call.
import { isAboveGenusName } from "./aboveGenusNames";
import type { GenbankLikelyName } from "./genbankLikelyName";
import { type ContaminantLikelyName, type ContaminantListTrigger, contaminantNameStepDetail, likelyContaminantNameFromHits } from "./contaminantLikelyName";
import { INFRAGENERIC_RANKS, parseInfragenericName } from "./infragenericNames";
import { sequenceHasTrashCategory } from "./sequenceCategory";
import { isContaminantFlagName, isWrongSpecimenFlagName } from "./sequenceExclusionFlags";
import { normalizeSpeciesName, speciesNamesMatch } from "./speciesNames";
import { oneVotePerSpecimen, validatedHitPhrase } from "./specimenVotes";
import { isUsableTaxonName } from "./taxonNames";


export interface BlastHit {
  num: number;
  def: string;
  accession: string;
  id: string;
  len: number;
  identity: number;
  alignLen: number;
  queryLen: number;
  queryCoverage: number;
  hsps: Array<{
    identity: number;
    alignLen: number;
    queryFrom: number;
    queryTo: number;
    hitFrom: number;
    hitTo: number;
    qseq: string;
    hseq: string;
    midline: string;
  }>;
}

export interface ParsedBlastResult {
  queryLen: number;
  hits: BlastHit[];
}

export interface SequenceRecord {
  id: string | number;
  scientificName: string | null;
  validated: boolean | null;
  validationStatus: string | null;
  flags: string[] | null;
  species: { sequence: string | null; parent: string | null } | null;
  observationId: string | null;
  categoryName?: string | null;
  ric?: number | null;
  [key: string]: unknown;
}

export function sequenceRecordFromApi(seq: Record<string, any>): SequenceRecord {
  let derivedStatus: string | null = seq.validationStatus || null;
  let derivedValidated: boolean | null = seq.validated ?? null;
  if ((!derivedStatus || derivedStatus === "not_assessed") && !derivedValidated && Array.isArray(seq.projects)) {
    const proj712 = seq.projects.find((project: any) => Number(project.id) === 712);
    if (proj712?.status === "verified") {
      derivedStatus = "verified";
      derivedValidated = true;
    } else if (proj712?.status === "rejected") {
      derivedStatus = "rejected";
      derivedValidated = false;
    }
  }
  return {
    id: String(seq.id),
    scientificName: seq.scientificName || null,
    validated: derivedValidated,
    validationStatus: derivedStatus,
    flags: seq.flags || [],
    species: seq.species || null,
    observationId: seq.observationId || null,
    inatObservationId: seq.inatObservationId ?? null,
    moObservationId: seq.moObservationId ?? null,
    platform: seq.platform || null,
    source: seq.source || null,
    location: seq.location ?? null,
    placeGuess: seq.placeGuess ?? null,
    date: seq.date ?? null,
    observedOn: seq.observedOn ?? null,
    // List and detail endpoints do not consistently shape category metadata.
    // Preserve both forms so every downstream evidence projection can apply
    // the same recoverable-trash guard.
    categoryName: seq.categoryName ?? (typeof seq.category === "string" ? seq.category : seq.category?.name) ?? null,
    categoryId: seq.categoryId ?? seq.category_id ?? seq.category?.id ?? null,
    ric: seq.ric ?? null,
    field_sequence_flags: seq.field_sequence_flags ?? seq.fieldSequenceFlags ?? null,
  };
}

export function normalizeSequenceObservationPlatform(value: unknown): "inat" | "mo" | null {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (normalized === "inat" || normalized.includes("inaturalist")) return "inat";
  if (/(^| )mo( |$)/.test(normalized) || normalized.includes("mushroom observer")) return "mo";
  return null;
}

export interface AnalysisStepResult {
  step: string;
  status: "pass" | "fail" | "skip" | "info" | "pending" | "running";
  message: string;
  details?: string[];
}

export interface ConfidenceBreakdown {
  baseScore: number;
  baseReason: string;
  ncbiAdjustment: number;
  ncbiReason: string;
  familyMismatchPenalty: number;
  familyMismatchReason: string;
  genusMatchBonus: number;
  genusMatchReason: string;
  speciesMatchBonus: number;
  speciesMatchReason: string;
  ricPenalty: number;
  ricReason: string;
  ricPenaltyWaived: boolean;
  nameAgreementPenalty: number;
  nameAgreementReason: string;
  nameAgreementPct: number | null;
  lowIdentityPenalty: number;
  lowIdentityReason: string;
  capApplied: boolean;
  capReason: string | null;
  finalScore: number;
  validatedHitCount: number;
  ncbiMatchType: "match" | "mismatch" | "no_ncbi" | "no_consensus";
  ncbiRecordCount: number;
  lowIdentityOccurrences: number;
  deepOccurrences: number;
  envBlastReplicationBonus: number;
  envBlastReplicationReason: string;
  envBlastReplicatingSamples: number;
  envBlastReplicatingVariants: number;
  envBlastSampleRic: number;
  envBlastVariantRic: number;
  unculturedPenalty: number;
  unculturedPenaltyReason: string;
}

export interface AnalysisResult {
  status: "pending" | "running" | "complete" | "error";
  // Durable identity for this individual deterministic computation. It lets
  // downstream side effects distinguish a same-run persistence projection
  // from an older row with the same final taxon.
  analysisRunId?: string;
  steps: AnalysisStepResult[];
  finalSpecies: string | null;
  finalConfidence: number | null;
  confidenceBreakdown: ConfidenceBreakdown | null;
  flaggedContaminant: boolean;
  /**
   * What a flagged contaminant most likely is (contaminantLikelyName.ts).
   * Set only with flaggedContaminant: null when NCBI gave no name, absent on
   * results stored before 2026-11-15. Never copied into finalSpecies.
   */
  contaminantLikelyName?: ContaminantLikelyName | null;
  /**
   * What GenBank points to for a specimen MycoMap's own sequences could not
   * name (genbankLikelyName.ts): read as a contaminant's likely name is. Set
   * only then, absent otherwise and on results stored before 2.0.0-beta.2.
   * Never copied into finalSpecies.
   */
  genbankLikelyName?: GenbankLikelyName | null;
  flaggedNonTarget: boolean;
  skipped: boolean;
  barcodeGapNeeded: boolean;
  noBlastHits?: boolean;
  ncbiConsensusSpecies: string | null;
  ncbiConsensusCount: number | null;
  ncbiConsensusTotalWithSpecies: number | null;
  // The threshold used to build each provider's displayed consensus pool.
  // Preserve it with the counts so comments never describe a secondary or
  // eDNA result as a 99.5% result.
  ncbiConsensusThreshold?: number | null;
  localConsensusSpecies: string | null;
  localConsensusCount: number | null;
  localConsensusTotalWithSpecies: number | null;
  localConsensusThreshold?: number | null;
  curationCount?: number;
  curationRecommendations?: DeterministicCurationRecommendation[];
  errorMessage?: string;
  ednaGenusConsensus?: string | null;
  ednaTempCode?: string | null;
  ednaAppliedCount?: number;
  ednaSkippedExisting?: number;
  broadenedSource?: string | null;
  ednaSpeciesMapping?: { envCode: string; resolvedSpecies: string; source: string } | null;
  // eDNA binomial consensus (parallel to localConsensus*/ncbiConsensus*, but
  // computed by ignoring env-code overlays so the real underlying binomial
  // can be surfaced for env-code → binomial mapping).
  localBinomialConsensus?: string | null;
  localBinomialCount?: number | null;
  localBinomialTotal?: number | null;
  ncbiBinomialConsensus?: string | null;
  ncbiBinomialCount?: number | null;
  ncbiBinomialTotal?: number | null;
  binomialConfidence?: ConfidenceBreakdown | null;
  // Snapshot of finalSpecies/finalConfidence just before they get nulled by
  // "Manual Validation Needed" because the source record's family could not
  // be resolved. Used by the Kingdom/Phylum Override post-processing block
  // to recover the would-be determination when source is Fungi / Basidiomycota /
  // Ascomycota / Agaricomycotina / Agaricomycetes and the rest of the batch
  // agrees on a single name.
  provisionalFinalSpecies?: string | null;
  provisionalFinalConfidence?: number | null;
  passingObservationRangeContext?: Array<{
    platform: "inat" | "mo" | null;
    observationId: string;
    taxon: string | null;
    place: string;
    observedOn: string | null;
    adjustedIdentity: number;
  }>;
}

export type DeterministicCurationRecommendation = {
  recommendationId: string;
  source: "mycoblast" | "ncbi";
  recordId: string;
  recordType: "sequence" | "accession";
  action: "validate_sequence" | "reverse_complement" | "update_sequence_name" | "update_observation_name" | "update_accession_name" | "clear_low_quality_flag";
  targetValue: string | null;
  currentValue: string | null;
};

export function buildPassingObservationRangeContext(
  passingHits: Array<{ accession: string; speciesName: string | null; adjustedIdentity: number }>,
  sequenceRecords: Record<string, SequenceRecord>,
): NonNullable<AnalysisResult["passingObservationRangeContext"]> {
  const seen = new Set<string>();
  const context: NonNullable<AnalysisResult["passingObservationRangeContext"]> = [];
  for (const passing of passingHits) {
    const record = sequenceRecords[passing.accession];
    // This compact range context is provider input. Low Q rows are omitted
    // from the deterministic summary, and trash rows must never be retained
    // as context for a later model call.
    if (!record || isTrashReference(record) || isExcludedReference(record)) continue;
    const rawLocation = record.location ?? record.placeGuess;
    let normalizedLocation: unknown = rawLocation;
    if (typeof rawLocation === "string" && rawLocation.trim().startsWith("{")) {
      try {
        normalizedLocation = JSON.parse(rawLocation);
      } catch {
        normalizedLocation = rawLocation;
      }
    }
    const place = normalizedLocation && typeof normalizedLocation === "object"
      ? Array.from(new Set([
          (normalizedLocation as any).placeName,
          (normalizedLocation as any).name,
          (normalizedLocation as any).city,
          (normalizedLocation as any).county,
          (normalizedLocation as any).region,
          (normalizedLocation as any).country,
        ].filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
          .map(part => part.trim()))).join(", ")
      : typeof normalizedLocation === "string"
        ? normalizedLocation.trim()
        : "";
    if (!place) continue;
    const platform = normalizeSequenceObservationPlatform(record.source)
      ?? normalizeSequenceObservationPlatform(record.platform);
    const observationId = String(
      platform === "inat"
        ? record.inatObservationId ?? record.observationId ?? ""
        : platform === "mo"
          ? record.moObservationId ?? record.observationId ?? ""
          : record.observationId ?? "",
    ).trim();
    if (!observationId) continue;
    const key = `${platform || "unknown"}:${observationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const observedOn = record.date ?? record.observedOn ?? null;
    context.push({
      platform,
      observationId,
      taxon: passing.speciesName,
      place,
      observedOn: typeof observedOn === "string" && observedOn.trim() ? observedOn.trim() : null,
      adjustedIdentity: passing.adjustedIdentity,
    });
  }
  return context;
}
export const ADJUSTED_IDENTITY_THRESHOLD = 99.5;
export const EDNA_ADJUSTED_IDENTITY_THRESHOLD = 99.35;
export const SECONDARY_IDENTITY_THRESHOLD = 99.0;
export const EDNA_SECONDARY_IDENTITY_THRESHOLD = 98.5;
export const QUERY_COVERAGE_THRESHOLD = 70;
// Bacterial 16S amplicons are commonly 1500+ bp. Reference 16S records in NCBI
// are often partial (e.g. 600–900 bp), so the standard 70% query-coverage rule
// would reject otherwise valid hits. Use a lower threshold for bacterial 16S.
export const BACTERIAL_QUERY_COVERAGE_THRESHOLD = 30;
export const COMBINED_COVERAGE_THRESHOLD = 140;
export const QC_SC_RATIO_THRESHOLD = 0.70;
export const CHIMERA_LENGTH_THRESHOLD = 750;
export const BAD_COVERAGE_MAJORITY = 0.5;
export const MIN_VALIDATED_HITS = 2;
export const CONTAMINANT_FLAG_THRESHOLD = 0.75;
export const CONTAMINANT_SKIP_THRESHOLD = 0.15;
export const SPECIES_CONSENSUS_THRESHOLD = 0.70;
export const LOW_IDENTITY_CHECK_THRESHOLD = 98.5;
export const EDNA_LOW_IDENTITY_CHECK_THRESHOLD = 98.0;

export function extractAllSpeciesNames(def: string): string[] {
  const names: string[] = [];
  const segments = def.split(/>\s*(?:gi\|[^|]+\|)?[a-z]{2,3}\|[A-Z0-9]+\.\d+\|\s*/);

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    let match: RegExpMatchArray | null;

    match = trimmed.match(/^([A-Z][a-z]+ sp\. '[^']+')/);
    if (match) { names.push(match[1]); continue; }

    match = trimmed.match(/^([A-Z][a-z]+ "[^"]+")/);
    if (match) { names.push(match[1]); continue; }

    match = trimmed.match(/^(uncultured\s+(?:[a-z]+\s+)*[a-z]+)/i);
    if (match) {
      let unculturedName = match[1].replace(/\s+/g, ' ').trim();
      const stopWords = ['clone', 'isolate', 'voucher', 'strain', 'internal', 'small', 'partial', 'genomic', '18s', '28s', '5.8s'];
      const words = unculturedName.split(' ');
      let trimIdx = words.length;
      for (let w = 1; w < words.length; w++) {
        if (stopWords.includes(words[w].toLowerCase())) { trimIdx = w; break; }
      }
      unculturedName = words.slice(0, trimIdx).join(' ');
      const accMatch = trimmed.match(/([A-Z]{1,2}\d{5,})/);
      if (accMatch) {
        names.push(`${unculturedName} - ${accMatch[1]}`);
      } else {
        names.push(unculturedName);
      }
      continue;
    }

    match = trimmed.match(/^([A-Z][a-z]+ [a-z]+)/);
    if (match) { names.push(match[1]); continue; }

    match = trimmed.match(/^([A-Z][a-z]+)\b/);
    if (match) { names.push(match[1]); }
  }

  return names;
}

export function extractSpeciesName(hitDef: string): string | null {
  const names = extractAllSpeciesNames(hitDef);
  return names.length > 0 ? names[0] : null;
}

export function isValidTaxonomicName(name: string): boolean {
  if (!name) return false;
  const isSupportedUnculturedName = /^uncultured [A-Z][a-z]+/i.test(name);
  if (!isUsableTaxonName(name) && !isSupportedUnculturedName) return false;

  if (/^[A-Z]\d+[-]/.test(name)) return false;
  if (/iNat\d+/.test(name)) return false;
  if (/ric=/.test(name)) return false;
  if (/\d+-\d+/.test(name) && !/^uncultured/i.test(name)) return false;
  if (/\.v\d/.test(name)) return false;
  if (/^[A-Z]{2,}\d/.test(name)) return false;

  if (/^uncultured [A-Z][a-z]+/i.test(name)) return true;

  return /^[A-Z][a-z]+/.test(name);
}

/**
 * A hit name that can vote in a species consensus. A name above genus ("Fungi", a family
 * such as Cortinariaceae, an order such as Agaricales) says nothing about the species, so the
 * hit counts like one without a name (2026-11-07: 24 MycoBLAST hits named "Fungi",
 * all samples on inat:260814867, outvoted 20 Suillus luteus on seq 863238 and left it with
 * no species, although every other hit and NCBI agreed).
 */
export function isConsensusVoteName(name: string | null | undefined): name is string {
  return !!name && isValidTaxonomicName(name) && !isAboveGenusName(name);
}

/**
 * The MycoBLAST hits that vote in the tiered species consensus, with their identity: one vote
 * per specimen for each name (specimenVotes.ts), so variant reads of one well can't
 * outvote other records (seq 865264, 2026-11-10).
 */
export function localConsensusEntries(
  hits: Array<{ speciesName: string | null; adjustedIdentity: number; specimenKey?: string | null }>,
): { binomial: string; adjIdentity: number; specimenKey?: string | null }[] {
  return oneVotePerSpecimen(hits
    .filter((h) => isConsensusVoteName(h.speciesName))
    .map((h) => ({ binomial: h.speciesName as string, adjIdentity: h.adjustedIdentity, specimenKey: h.specimenKey })));
}




export function groupByNormalizedName(speciesCounts: Map<string, number>): {
  normalized: Map<string, { count: number; variants: Map<string, number>; canonical: string }>;
} {
  const normalized = new Map<string, { count: number; variants: Map<string, number>; canonical: string }>();
  for (const [name, count] of speciesCounts.entries()) {
    const key = normalizeSpeciesName(name);
    const existing = normalized.get(key);
    if (existing) {
      existing.count += count;
      existing.variants.set(name, count);
      let maxCount = 0;
      let mostFrequent = existing.canonical;
      for (const [v, c] of existing.variants.entries()) {
        if (c > maxCount) {
          maxCount = c;
          mostFrequent = v;
        }
      }
      existing.canonical = mostFrequent;
    } else {
      const variants = new Map<string, number>();
      variants.set(name, count);
      normalized.set(key, { count, variants, canonical: name });
    }
  }
  return { normalized };
}

export type IterativeConsensusTier = { tier: "A" | "B" | "C"; identity: number; agreement: number; minRecords: number };
export const ITERATIVE_CONSENSUS_TIERS: IterativeConsensusTier[] = [
  { tier: "A", identity: 100,   agreement: 1.00, minRecords: 3 },
  { tier: "B", identity: 99.5,  agreement: 0.70, minRecords: 3 },
  { tier: "C", identity: 99.35, agreement: 0.70, minRecords: 3 },
];

// Tiers for the regular (non-eDNA) primary determination. Identity and agreement
// thresholds are identical to the eDNA tiers (A: 100%/100%, B: 99.5%/70%,
// C: 99.35%/70%) so a perfect match resolves at Tier A and a looser match drops
// to Tier B/C. The per-tier record floor is MIN_VALIDATED_HITS — the regular
// path's established 2-hit minimum — instead of the eDNA minRecords=3, so a
// determination that previously resolved with 2 validated hits still resolves.
export const REGULAR_CONSENSUS_TIERS: IterativeConsensusTier[] = ITERATIVE_CONSENSUS_TIERS.map(
  (t) => ({ ...t, minRecords: MIN_VALIDATED_HITS }),
);

export type IterativeConsensusTierAttempt = {
  tier: "A" | "B" | "C";
  identityThreshold: number;
  agreementThreshold: number;
  minRecords: number;
  total: number;
  topCanonical: string | null;
  topCount: number;
  ratio: number;
  passed: boolean;
};

export type IterativeConsensusResult = {
  tier: "A" | "B" | "C" | null;
  identityThreshold: number;
  agreementThreshold: number;
  minRecords: number;
  topCanonical: string | null;
  // Normalized-group key of the winning name (stable across the tier-filtered
  // subset and the full pool); use this — not topCanonical — to re-find the
  // winner in a full-pool sorted list, since a group's canonical variant can
  // differ between subsets.
  topKey: string | null;
  topCount: number;
  total: number;
  ratio: number;
  sorted: [string, { count: number; variants: Map<string, number>; canonical: string }][];
  annotation: string;
  attempts: IterativeConsensusTierAttempt[];
};

export function iterativeBinomialConsensus(
  entries: { binomial: string; adjIdentity: number }[],
  tiers: IterativeConsensusTier[] = ITERATIVE_CONSENSUS_TIERS,
): IterativeConsensusResult {
  const attempts: IterativeConsensusTierAttempt[] = [];
  let lastSorted: [string, { count: number; variants: Map<string, number>; canonical: string }][] = [];
  let lastTotal = 0;
  for (const t of tiers) {
    const filtered = entries.filter(e => e.adjIdentity >= t.identity);
    const counts = new Map<string, number>();
    for (const e of filtered) counts.set(e.binomial, (counts.get(e.binomial) || 0) + 1);
    const { normalized } = groupByNormalizedName(counts);
    const sorted = Array.from(normalized.entries()).sort((a, b) => b[1].count - a[1].count);
    lastSorted = sorted;
    lastTotal = filtered.length;
    const top = sorted[0]?.[1];
    const ratio = top && filtered.length > 0 ? top.count / filtered.length : 0;
    const passed = !!top && top.count >= t.minRecords && ratio >= t.agreement;
    attempts.push({
      tier: t.tier,
      identityThreshold: t.identity,
      agreementThreshold: t.agreement,
      minRecords: t.minRecords,
      total: filtered.length,
      topCanonical: top?.canonical ?? null,
      topCount: top?.count ?? 0,
      ratio,
      passed,
    });
    if (passed) {
      return {
        tier: t.tier,
        identityThreshold: t.identity,
        agreementThreshold: t.agreement,
        minRecords: t.minRecords,
        topCanonical: top!.canonical,
        topKey: sorted[0]![0],
        topCount: top!.count,
        total: filtered.length,
        ratio,
        sorted,
        annotation: `Tier ${t.tier} (≥${t.identity}% identity, ≥${(t.agreement * 100).toFixed(0)}% agreement, ≥${t.minRecords} records)`,
        attempts,
      };
    }
  }
  const tC = tiers[tiers.length - 1];
  const top = lastSorted[0]?.[1];
  return {
    tier: null,
    identityThreshold: tC.identity,
    agreementThreshold: tC.agreement,
    minRecords: tC.minRecords,
    topCanonical: top?.canonical ?? null,
    topKey: lastSorted[0]?.[0] ?? null,
    topCount: top?.count ?? 0,
    total: lastTotal,
    ratio: top && lastTotal > 0 ? top.count / lastTotal : 0,
    sorted: lastSorted,
    annotation: `No tier reached consensus (tried ${tiers.map(t => `${t.tier}: ${t.identity === 100 ? "" : "≥"}${t.identity}%/${(t.agreement * 100).toFixed(0)}%/≥${t.minRecords}`).join(", ")})`,
    attempts,
  };
}

/**
 * The likely name of a flagged contaminant, from the NCBI hits alone
 * (contaminantLikelyName.ts says why never from MycoBLAST): the curated
 * GenBank name first, then the hit's title; the adjusted identity, or the raw
 * one where that is missing.
 */
export function likelyContaminantNameFromNcbi(
  ncbiHits: BlastHit[],
  genbankMap: Record<string, GenBankRecord>,
  ncbiAdjustedMap: Record<number, number>,
  listTrigger: ContaminantListTrigger | null,
): ContaminantLikelyName | null {
  return likelyContaminantNameFromHits(ncbiHits, {
    nameOf: (hit) => {
      const meta = genbankMap[hit.accession];
      return (meta?.scientificName || meta?.organism || null) ?? extractSpeciesName(hit.def);
    },
    identityOf: (hit) => {
      const adjusted = ncbiAdjustedMap[hit.num];
      if (adjusted !== undefined) return adjusted;
      const hsp = hit.hsps[0];
      return hsp && hsp.alignLen > 0 ? (hsp.identity / hsp.alignLen) * 100 : null;
    },
    isVoteName: isConsensusVoteName,
    speciesConsensus: (entries) => mostAgreeingPassingTier(entries, REGULAR_CONSENSUS_TIERS),
  }, listTrigger);
}

/**
 * Of the consensus tiers that pass, the one that counts the most agreeing
 * records (a tie goes to the stricter), for a likely name and what it rests on:
 * 8 NCBI hits that agree at 99.6 to 100% read "8 of 8 at >= 99.5%", not
 * "2 of 2 at >= 100%" (2026-11-19). Naming a specimen is unchanged: it
 * takes the strictest tier that passes (iterativeBinomialConsensus). With no
 * tier passing, the answer is iterativeBinomialConsensus's own, tier null.
 */
export function mostAgreeingPassingTier(
  entries: { binomial: string; adjIdentity: number }[],
  tiers: IterativeConsensusTier[],
): IterativeConsensusResult {
  let best: IterativeConsensusResult | null = null;
  for (const tier of tiers) {
    const one = iterativeBinomialConsensus(entries, [tier]);
    if (one.tier && (!best || one.topCount > best.topCount)) best = one;
  }
  return best ?? iterativeBinomialConsensus(entries, tiers);
}

/** Records the likely name on a result just flagged as a contaminant, and says so in its last step. */
export function noteContaminantLikelyName(result: AnalysisResult, likely: ContaminantLikelyName | null): void {
  result.contaminantLikelyName = likely;
  const step = result.steps[result.steps.length - 1];
  if (step) step.details = [...(step.details ?? []), contaminantNameStepDetail(likely)];
}

export function formatTierAttempts(attempts: IterativeConsensusTierAttempt[]): string[] {
  return attempts.map(a => {
    const top = a.topCanonical ? `top: ${a.topCanonical} ${a.topCount}/${a.total} (${(a.ratio * 100).toFixed(0)}%)` : "no qualifying hits";
    const verdict = a.passed ? "✓ PASS" : "✗";
    return `  Tier ${a.tier} (≥${a.identityThreshold}% id, ≥${(a.agreementThreshold * 100).toFixed(0)}% agree, ≥${a.minRecords} rec): ${top} ${verdict}`;
  });
}

export function parseFlags(flags: string[] | null | undefined): string[] {
  if (!flags || flags.length === 0) return [];
  const parsedFlags: string[] = [];
  for (const flag of flags) {
    if (flag.startsWith("{")) {
      try {
        const parsed = JSON.parse(flag);
        parsedFlags.push(...Object.keys(parsed));
      } catch {
        parsedFlags.push(flag);
      }
    } else {
      parsedFlags.push(flag);
    }
  }
  return parsedFlags;
}

export const LOW_QUALITY_FLAG_NAMES = new Set([
  "l",
  "low",
  "low quality",
  "low-quality",
  "low_quality",
  "low ric",
  "lowric",
  "low-ric",
  "low_ric",
]);

/**
 * MycoMap's sequence-level flags are authoritative quality state.  Do not
 * infer this state from observation quality, RiC, identity, or model output:
 * those values have separate scientific meanings and must remain separate.
 */
export function authoritativeSequenceFlags(metadata: unknown): string[] {
  const record = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  const directFlags = Array.isArray(record.flags) ? record.flags.flatMap((flag: unknown) => {
    if (typeof flag !== "string") return [];
    const trimmed = flag.trim();
    if (!trimmed.startsWith("{")) return [trimmed];
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.entries(parsed)
          .filter(([, enabled]) => enabled === true || enabled === 1 || enabled === "1" || enabled === "true")
          .map(([name]) => name)
        : [trimmed];
    } catch {
      return [trimmed];
    }
  }) : [];
  const fieldFlags = record.field_sequence_flags ?? record.fieldSequenceFlags;
  const enabledFieldFlags = fieldFlags && typeof fieldFlags === "object" && !Array.isArray(fieldFlags)
    ? Object.entries(fieldFlags as Record<string, unknown>)
      .filter(([, enabled]) => enabled === true || enabled === 1 || enabled === "1" || enabled === "true")
      .map(([name]) => name)
    : [];
  return [...new Set([...directFlags, ...enabledFieldFlags].map(flag => String(flag).trim().toLowerCase()).filter(Boolean))];
}

export function sequenceEvidenceEligibility(metadata: unknown): {
  eligible: boolean;
  disposition: "deciding" | "context_only";
  reasons: string[];
  authoritativeFlags: string[];
} {
  const authoritativeFlags = authoritativeSequenceFlags(metadata);
  const lowQualityFlags = authoritativeFlags.filter(flag => LOW_QUALITY_FLAG_NAMES.has(flag));
  // A reference on the wrong observation or specimen carries that record's
  // name, not its own: the record store's "wrong" flag keeps it out of any use
  // (2026-10-13). It is neither evidence for a name nor of contamination.
  const wrongSpecimenFlags = authoritativeFlags.filter(flag => isWrongSpecimenFlagName(flag));
  const reasons = [
    ...(lowQualityFlags.length > 0 ? [`Low Q reference excluded from deciding evidence (${lowQualityFlags.join(", ")}).`] : []),
    ...(wrongSpecimenFlags.length > 0 ? [`Wrong-specimen reference excluded from deciding evidence (${wrongSpecimenFlags.join(", ")}).`] : []),
  ];
  return reasons.length > 0
    ? { eligible: false, disposition: "context_only", reasons, authoritativeFlags }
    : { eligible: true, disposition: "deciding", reasons: [], authoritativeFlags };
}

/** A reference kept out of deciding evidence: low quality or wrong specimen (sequenceEvidenceEligibility). */
export function isExcludedReference(metadata: unknown): boolean {
  return !sequenceEvidenceEligibility(metadata).eligible;
}

export function isTrashReference(metadata: unknown): boolean {
  return sequenceHasTrashCategory(metadata);
}

export function isContaminantFlag(flags: string[] | null | undefined): boolean {
  return parseFlags(flags).some(isContaminantFlagName);
}

export function sourceNonTargetStatus(metadata: Record<string, any> | undefined): {
  flags: string[];
  categoryName: string | null;
  trashFlag: boolean;
  nonTargetFlag: boolean | null;
} {
  const flags = authoritativeSequenceFlags(metadata);
  const categoryName = String(
    metadata?.categoryName
    ?? (typeof metadata?.category === "string" ? metadata.category : metadata?.category?.name)
    ?? "",
  ).trim() || null;
  const trashFlag = isTrashReference(metadata);
  const explicitNonTargetFlag = metadata?.flaggedNonTarget ?? metadata?.nonTarget;
  const nonTargetFlag = trashFlag || flags.some(flag =>
    ["non-target", "nontarget"].includes(flag.toLowerCase()),
  )
    ? true
    : typeof explicitNonTargetFlag === "boolean" ? explicitNonTargetFlag : null;
  return { flags, categoryName, trashFlag, nonTargetFlag };
}

export function calculateQueryCover(hit: BlastHit, queryLen: number): number {
  if (hit.hsps.length === 0 || queryLen === 0) return 0;
  const hsp = hit.hsps[0];
  const cover = ((hsp.queryTo - hsp.queryFrom + 1) / queryLen) * 100;
  return Math.abs(cover);
}

export function calculateSubjectCover(hit: BlastHit): number {
  if (hit.hsps.length === 0 || hit.len === 0) return 0;
  const hsp = hit.hsps[0];
  const alignLen = hsp.hitTo - hsp.hitFrom;
  const signedLen = alignLen >= 0 ? alignLen + 1 : alignLen - 1;
  return (signedLen / hit.len) * 100;
}

export function findSequenceRecordForHit(
  hit: { accession: string; id: string },
  sequenceMap: Record<string, SequenceRecord>,
): SequenceRecord | null {
  const direct = sequenceMap[String(hit.accession)];
  if (direct) return direct;
  if (/^\d+$/.test(hit.accession)) return null;
  const embeddedInat = hit.id?.match(/INAT(\d+)/i)?.[1] || hit.accession.match(/INAT(\d+)/i)?.[1];
  if (embeddedInat) {
    const compositeKey = sequenceMap[`inat-${embeddedInat}-${hit.accession}`];
    if (compositeKey) return compositeKey;
  }
  return null;
}

export function extractGenus(speciesName: string): string | null {
  if (!speciesName) return null;
  const group = parseInfragenericName(speciesName);
  if (group) return group.genus;
  const match = speciesName.match(/^([A-Z][a-z]+)/);
  if (!match) return null;
  const candidate = match[1];
  const words = speciesName.trim().split(/\s+/);
  if (words.length === 1) {
    const lower = candidate.toLowerCase();
    if (lower.endsWith("oideae") || lower.endsWith("aceae") || lower.endsWith("ineae") ||
        lower.endsWith("ales") || lower.endsWith("mycetes") || lower.endsWith("mycota") ||
        lower.endsWith("mycotina") || lower.endsWith("mycetidae")) {
      return null;
    }
  }
  return candidate;
}

// Groups inside a genus (infragenericNames.ts), and ranks below species.
export const INFRASPECIFIC_RANKS = [...INFRAGENERIC_RANKS, "subspecies", "variety", "form"] as string[];

export function isInfraspecificRank(rank: string | null | undefined): boolean {
  if (!rank) return false;
  return INFRASPECIFIC_RANKS.includes(rank.toLowerCase());
}

export const SUPRAGENERIC_RANKS = ["order", "suborder", "infraorder", "class", "subclass", "phylum", "subphylum", "kingdom", "domain"];

export function isSupragenericRank(rank: string | null | undefined): boolean {
  if (!rank) return false;
  return SUPRAGENERIC_RANKS.includes(rank.toLowerCase());
}

export function inferRankFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.trim();
  const group = parseInfragenericName(n);
  if (group) return group.rank;
  const firstWord = n.split(/\s+/)[0];
  if (!firstWord || !/^[A-Z][a-z]+$/.test(firstWord)) return null;
  const hasEpithet = /^[A-Z][a-z]+\s+[a-z]/.test(n);
  const secondWord = n.split(/\s+/)[1]?.toLowerCase();
  const isQualifier = secondWord && ["sp.", "sp", "cf.", "cf", "aff.", "aff"].includes(secondWord);
  if (hasEpithet && !isQualifier) return null;
  const lower = firstWord.toLowerCase();
  if (lower.endsWith("mycota") || lower.endsWith("mycotina")) return "phylum";
  if (lower.endsWith("mycetes") || lower.endsWith("mycetidae")) return "class";
  if (lower.endsWith("ales")) return "order";
  if (lower.endsWith("aceae") || lower.endsWith("ineae")) return "family";
  // A subfamily (Leccinoideae, Boletoideae), not a section: its family is found from it.
  if (lower.endsWith("oideae")) return "subfamily";
  return null;
}

export function getSpeciesNameFromHit(
  hit: BlastHit,
  sequenceMap: Record<string, SequenceRecord>,
  genbankMap?: Record<string, GenBankRecord>,
  ednaSpeciesIdMap?: Record<string, string>
): string | null {
  if (ednaSpeciesIdMap && ednaSpeciesIdMap[hit.accession]) {
    return ednaSpeciesIdMap[hit.accession];
  }
  if (sequenceMap[hit.accession]) {
    const rec = sequenceMap[hit.accession];
    const name = rec.scientificName;
    if (name && isValidTaxonomicName(name)) return name;
    if (rec.species?.parent) {
      const parentName = rec.species.parent.replace(/^\d+\s*-\s*/, '').trim();
      if (parentName && isValidTaxonomicName(parentName)) return parentName;
    }
  }
  if (genbankMap && genbankMap[hit.accession]) {
    const meta = genbankMap[hit.accession];
    const name = meta.scientificName || meta.organism;
    if (name && isValidTaxonomicName(name)) return name;
  }
  return extractSpeciesName(hit.def);
}

// Returns the underlying canonical binomial for a hit, IGNORING any eDNA env-code
// overlay from ednaSpeciesIdMap. Used to compute a parallel "binomial consensus"
// for eDNA sequences where the env code masks the true binomial behind hits.
export function getBinomialSpeciesNameFromHit(
  hit: BlastHit,
  sequenceMap: Record<string, SequenceRecord>,
  genbankMap?: Record<string, GenBankRecord>
): string | null {
  return getSpeciesNameFromHit(hit, sequenceMap, genbankMap, undefined);
}




export function isHitValidated(
  hit: BlastHit,
  sequenceMap: Record<string, SequenceRecord>,
  genbankMap?: Record<string, GenBankRecord>
): boolean {
  if (sequenceMap[hit.accession]) {
    const rec = sequenceMap[hit.accession];
    if (rec.validated === false) return false;
    return rec.validationStatus === "verified";
  }
  if (genbankMap && genbankMap[hit.accession]) {
    return genbankMap[hit.accession].isVerified === true;
  }
  return false;
}

export function extractInatIdFromHit(def: string, hitId?: string | number | null): string | null {
  const matches = [...def.matchAll(/iNat(?:uralist)?\s*#?\s*(\d+)/gi)];
  if (matches.length > 0) return matches[matches.length - 1][1];
  if (hitId && typeof hitId === "string") {
    const idMatch = hitId.match(/INAT(\d+)/i);
    if (idMatch) return idMatch[1];
  }
  return null;
}

export function extractMoIdFromHit(def: string, hitId?: string | number | null): string | null {
  const matches = [...def.matchAll(/MO[-]?(\d{3,})/gi)];
  if (matches.length > 0) return matches[matches.length - 1][1];
  const moLongMatch = def.match(/Mushroom\s+Observer\s*#?\s*(\d{3,})/i);
  if (moLongMatch) return moLongMatch[1];
  if (hitId && typeof hitId === "string") {
    const idMatch = hitId.match(/[-]MO(\d{3,})[-]/i);
    if (idMatch) return idMatch[1];
  }
  return null;
}

export function getHitSourceKey(hit: BlastHit, seqRecord?: SequenceRecord | null): string | null {
  const inatId = extractInatIdFromHit(hit.def, hit.id);
  if (inatId) return `inat:${inatId}`;
  const moId = extractMoIdFromHit(hit.def, hit.id);
  if (moId) return `mo:${moId}`;
  if (seqRecord?.observationId) return `obs:${seqRecord.observationId}`;
  return null;
}

export function extractPlatformObsRef(seq: SequenceRecord): { id: string; source: string } | null {
  // Source: typed `inatObservationId` / `moObservationId` fields MM exposes
  // on every sequence response.
  // The legacy title-regex resolver was the workaround that produced the
  // spurious "Saldinia" tally for iNat 298815615 / sequence 639235.
  const inatRaw = (seq as any).inatObservationId;
  const inatId = inatRaw == null ? null : (typeof inatRaw === "number" ? inatRaw : Number(inatRaw));
  if (inatId != null && Number.isFinite(inatId) && inatId > 0) {
    return { id: String(inatId), source: "inat" };
  }
  const moRaw = (seq as any).moObservationId;
  const moId = moRaw == null ? null : (typeof moRaw === "number" ? moRaw : Number(moRaw));
  if (moId != null && Number.isFinite(moId) && moId > 0) {
    return { id: String(moId), source: "mo" };
  }
  return null;
}

export function obsSpeciesKey(ref: { id: string; source: string } | null): string {
  return ref ? `${ref.source}:${ref.id}` : "";
}

export interface GenBankRecord {
  accession: string;
  scientificName: string | null;
  organism: string | null;
  isVerified: boolean;
  isType: boolean;
}

export function computeConfidenceScore(params: {
  validatedHitCount: number;
  /** Reads behind validatedHitCount when it counts specimens; only changes the reason's wording. */
  validatedHitReads?: number;
  ncbiConsensusSpecies: string | null;
  ncbiConsensusCount: number;
  ncbiTotalWithSpecies: number;
  localSpecies: string;
  localConsensusCount: number;
  localTotalWithSpecies: number;
  lowIdentityMatches: { identity: number; source: "local" | "ncbi" }[];
  familyMismatch: boolean;
  sourceRic: number | null;
  sourceSpeciesName: string | null;
  isOnlySequenceForRecord?: boolean;
  isEdna?: boolean;
  ncbiQualifiedHitCount?: number;
  envBlastReplicationParam?: { replicatingSamples: number; replicatingVariants: number; totalSampleRic: number; totalVariantRic: number };
  isUnculturedOnly?: boolean;
}): ConfidenceBreakdown {
  const { validatedHitCount, ncbiConsensusSpecies, ncbiConsensusCount, ncbiTotalWithSpecies, localSpecies, localConsensusCount, localTotalWithSpecies, lowIdentityMatches, familyMismatch, sourceRic, sourceSpeciesName, isOnlySequenceForRecord, isEdna, ncbiQualifiedHitCount, envBlastReplicationParam, isUnculturedOnly } = params;

  const effectiveHitCount = isEdna ? validatedHitCount + (ncbiQualifiedHitCount || 0) : validatedHitCount;
  let baseScore: number;
  if (effectiveHitCount < 2) {
    baseScore = 50 + (effectiveHitCount * 10);
  } else {
    baseScore = Math.min(100, 70 + 30 * Math.min(1, Math.log10(effectiveHitCount / 2) / Math.log10(10)));
  }
  const identityThresholdLabel = isEdna ? `${EDNA_ADJUSTED_IDENTITY_THRESHOLD}%` : `${ADJUSTED_IDENTITY_THRESHOLD}%`;
  const baseReason = isEdna
    ? `${effectiveHitCount} qualifying hits (${validatedHitCount} MycoBLAST + ${ncbiQualifiedHitCount || 0} NCBI) at >= ${identityThresholdLabel} identity`
    : `${validatedHitPhrase(validatedHitCount, params.validatedHitReads ?? validatedHitCount)} at >= ${identityThresholdLabel} identity`;

  let ncbiAdjustment = 0;
  let ncbiReason = "";
  let ncbiMatchType: ConfidenceBreakdown["ncbiMatchType"] = "no_ncbi";
  const ncbiRecordCount = ncbiTotalWithSpecies;

  if (ncbiTotalWithSpecies === 0 || ncbiConsensusSpecies === null) {
    ncbiMatchType = ncbiTotalWithSpecies === 0 ? "no_ncbi" : "no_consensus";
    ncbiReason = ncbiTotalWithSpecies === 0
      ? "No NCBI records at threshold - no adjustment"
      : "NCBI had no consensus species - no adjustment";
  } else {
    const ncbiWeight = Math.min(1, Math.log10(ncbiTotalWithSpecies + 1) / Math.log10(30));
    const consensusStrength = ncbiConsensusCount / ncbiTotalWithSpecies;
    if (speciesNamesMatch(ncbiConsensusSpecies, localSpecies)) {
      ncbiMatchType = "match";
      ncbiAdjustment = Math.round(14 * ncbiWeight * consensusStrength);
      ncbiReason = `NCBI matches "${localSpecies}" (${ncbiConsensusCount}/${ncbiTotalWithSpecies} records, weight ${(ncbiWeight * 100).toFixed(0)}%) -> +${ncbiAdjustment}%`;
    } else {
      ncbiMatchType = "mismatch";
      ncbiAdjustment = -Math.round(12 * ncbiWeight * consensusStrength);
      ncbiReason = `NCBI disagrees: "${ncbiConsensusSpecies}" vs "${localSpecies}" (${ncbiConsensusCount}/${ncbiTotalWithSpecies} records) -> ${ncbiAdjustment}%`;
    }
  }

  let familyMismatchPenalty = 0;
  let familyMismatchReason = "";
  if (familyMismatch) {
    familyMismatchPenalty = 50;
    familyMismatchReason = "MycoBLAST and source record families differ -> -50%";
  } else {
    familyMismatchReason = "Families match or comparison not applicable - no penalty";
  }

  let genusMatchBonus = 0;
  let genusMatchReason = "";
  let speciesMatchBonus = 0;
  let speciesMatchReason = "";
  if (!familyMismatch && sourceSpeciesName && localSpecies) {
    const sourceGenus = extractGenus(sourceSpeciesName);
    const consensusGenus = extractGenus(localSpecies);
    if (sourceGenus && consensusGenus && sourceGenus.toLowerCase() === consensusGenus.toLowerCase()) {
      genusMatchBonus = 5;
      genusMatchReason = `Source genus "${sourceGenus}" matches consensus genus "${consensusGenus}" -> +5%`;
      if (speciesNamesMatch(sourceSpeciesName, localSpecies)) {
        speciesMatchBonus = 10;
        speciesMatchReason = `Source species "${sourceSpeciesName}" matches consensus "${localSpecies}" -> +10%`;
      } else {
        speciesMatchReason = `Source species "${sourceSpeciesName}" does not match consensus "${localSpecies}" - no species bonus`;
      }
    } else {
      genusMatchReason = sourceGenus && consensusGenus
        ? `Source genus "${sourceGenus}" does not match consensus genus "${consensusGenus}" - no genus bonus`
        : "Genus extraction failed - no genus bonus";
      speciesMatchReason = "Genus does not match - no species bonus";
    }
  } else if (familyMismatch) {
    genusMatchReason = "Family mismatch - genus/species bonuses not applicable";
    speciesMatchReason = "Family mismatch - genus/species bonuses not applicable";
  } else {
    genusMatchReason = "Source species or consensus not available - no genus bonus";
    speciesMatchReason = "Source species or consensus not available - no species bonus";
  }

  let ricPenalty = 0;
  let ricReason = "";
  if (isOnlySequenceForRecord && genusMatchBonus > 0) {
    ricReason = `RiC penalty waived - only sequence for record and genus matches`;
  } else if (sourceRic === null || sourceRic === undefined) {
    ricReason = "RiC not available - no penalty";
  } else if (sourceRic >= 20) {
    ricPenalty = 0;
    ricReason = `RiC ${sourceRic} (>= 20) -> no penalty`;
  } else if (sourceRic <= 5) {
    ricPenalty = 20;
    ricReason = `RiC ${sourceRic} (<= 5) -> -20% (low RiC penalty)`;
  } else {
    ricPenalty = Math.round(20 * (20 - sourceRic) / 15);
    ricReason = `RiC ${sourceRic} -> -${ricPenalty}% (low RiC penalty)`;
  }

  let nameAgreementPenalty = 0;
  let nameAgreementReason = "";
  let nameAgreementPct: number | null = null;
  if (isEdna) {
    nameAgreementReason = "Name agreement not applicable for eDNA analysis";
  } else if (localTotalWithSpecies > 0 && localConsensusCount > 0) {
    nameAgreementPct = Math.round((localConsensusCount / localTotalWithSpecies) * 100);
    if (nameAgreementPct >= 90) {
      nameAgreementPenalty = 0;
      nameAgreementReason = `${nameAgreementPct}% name agreement (${localConsensusCount}/${localTotalWithSpecies}) - no penalty (>= 90%)`;
    } else {
      nameAgreementPenalty = 90 - nameAgreementPct;
      nameAgreementReason = `${nameAgreementPct}% name agreement (${localConsensusCount}/${localTotalWithSpecies}) -> -${nameAgreementPenalty} points`;
    }
  } else {
    nameAgreementReason = "Name agreement not applicable (no species data)";
  }

  let lowIdentityPenalty = 0;
  let lowIdentityReason = "";
  let capApplied = false;
  let capReason: string | null = null;
  const lowIdThreshold = isEdna ? EDNA_LOW_IDENTITY_CHECK_THRESHOLD : LOW_IDENTITY_CHECK_THRESHOLD;
  const lowIdentityOccurrences = lowIdentityMatches.length;
  const localLowIdCount = lowIdentityMatches.filter(m => m.source === "local").length;
  const ncbiLowIdCount = lowIdentityMatches.filter(m => m.source === "ncbi").length;
  const DEEP_THRESHOLD = 96.5;
  const deepMatches = lowIdentityMatches.filter(m => m.identity < DEEP_THRESHOLD);
  const deepOccurrences = deepMatches.length;
  const deepLocalCount = deepMatches.filter(m => m.source === "local").length;
  const deepNcbiCount = deepMatches.filter(m => m.source === "ncbi").length;

  const formatSourceBreakdown = (total: number, local: number, ncbi: number) => {
    const parts: string[] = [];
    if (local > 0) parts.push(`${local} MycoBLAST`);
    if (ncbi > 0) parts.push(`${ncbi} NCBI`);
    return parts.length > 0 ? ` (${parts.join('; ')})` : '';
  };

  if (lowIdentityOccurrences === 0) {
    lowIdentityReason = `No same-species hits found below ${lowIdThreshold}% - no penalty`;
  } else {
    for (const match of lowIdentityMatches) {
      const gap = lowIdThreshold - match.identity;
      lowIdentityPenalty += Math.round(3 + 2 * gap);
    }
    const sourceStr = formatSourceBreakdown(lowIdentityOccurrences, localLowIdCount, ncbiLowIdCount);
    lowIdentityReason = `${lowIdentityOccurrences} same-species hit${lowIdentityOccurrences !== 1 ? 's' : ''} below ${lowIdThreshold}%${sourceStr} -> -${lowIdentityPenalty}%`;

    if (deepOccurrences >= 2) {
      capApplied = true;
      const capValue = Math.max(10, 50 - 5 * (deepOccurrences - 1));
      const scoreBeforeCap = Math.round(baseScore) + ncbiAdjustment - lowIdentityPenalty;
      const deepSourceStr = formatSourceBreakdown(deepOccurrences, deepLocalCount, deepNcbiCount);
      if (scoreBeforeCap > capValue) {
        const extraPenalty = scoreBeforeCap - capValue;
        lowIdentityPenalty += extraPenalty;
        capReason = `${deepOccurrences} occurrences below ${DEEP_THRESHOLD}%${deepSourceStr} (>2% gap) -> capped at ${capValue}%`;
        lowIdentityReason = `${lowIdentityOccurrences} same-species hit${lowIdentityOccurrences !== 1 ? 's' : ''} below ${lowIdThreshold}%${sourceStr}. ${deepOccurrences} below ${DEEP_THRESHOLD}%${deepSourceStr} -> capped at ${capValue}%`;
      } else {
        capReason = `${deepOccurrences} occurrences below ${DEEP_THRESHOLD}%${deepSourceStr} -> cap at ${capValue}% (already below cap)`;
      }
    }
  }

  let envBlastReplicationBonus = 0;
  let envBlastReplicationReason = "";
  const repl = envBlastReplicationParam ?? { replicatingSamples: 0, replicatingVariants: 0, totalSampleRic: 0, totalVariantRic: 0 };
  if (isEdna && (repl.replicatingSamples > 0 || repl.replicatingVariants > 0)) {
    let sampleBonus = 0;
    if (repl.replicatingSamples > 0) {
      const ricFactor = Math.min(2, 1 + Math.log10(Math.max(1, repl.totalSampleRic)) / 3);
      sampleBonus = Math.min(20, repl.replicatingSamples * 4 * ricFactor);
      sampleBonus = Math.round(sampleBonus * 100) / 100;
    }
    let variantBonus = 0;
    if (repl.replicatingVariants > 0) {
      const ricFactor = Math.min(2, 1 + Math.log10(Math.max(1, repl.totalVariantRic)) / 3);
      variantBonus = Math.min(10, repl.replicatingVariants * 2 * ricFactor);
      variantBonus = Math.round(variantBonus * 100) / 100;
    }
    envBlastReplicationBonus = Math.round(sampleBonus + variantBonus);
    const parts: string[] = [];
    if (repl.replicatingSamples > 0) {
      parts.push(`${repl.replicatingSamples} replicating sample${repl.replicatingSamples !== 1 ? "s" : ""} (RiC ${repl.totalSampleRic}) -> +${Math.round(sampleBonus)}%`);
    }
    if (repl.replicatingVariants > 0) {
      parts.push(`${repl.replicatingVariants} replicating variant${repl.replicatingVariants !== 1 ? "s" : ""} (RiC ${repl.totalVariantRic}) -> +${Math.round(variantBonus)}%`);
    }
    envBlastReplicationReason = parts.join("; ") + ` at ≥99% identity, ≥70% query coverage -> +${envBlastReplicationBonus}%`;
  } else if (isEdna) {
    envBlastReplicationReason = "No cross-sample replication detected - no bonus";
  } else {
    envBlastReplicationReason = "Not applicable (non-eDNA)";
  }

  const unculturedPenalty = isUnculturedOnly ? 20 : 0;
  const unculturedPenaltyReason = isUnculturedOnly
    ? "Uncultured-only penalty: -20% (identification based entirely on uncultured NCBI hits)"
    : "No uncultured penalty (identification includes cultured/named hits)";

  const finalScore = Math.max(0, Math.min(100, Math.round(baseScore) + ncbiAdjustment - familyMismatchPenalty + genusMatchBonus + speciesMatchBonus - ricPenalty - nameAgreementPenalty - lowIdentityPenalty + envBlastReplicationBonus - unculturedPenalty));

  return {
    baseScore: Math.round(baseScore),
    baseReason,
    ncbiAdjustment,
    ncbiReason,
    familyMismatchPenalty,
    familyMismatchReason,
    genusMatchBonus,
    genusMatchReason,
    speciesMatchBonus,
    speciesMatchReason,
    ricPenalty,
    ricReason,
    ricPenaltyWaived: !!(isOnlySequenceForRecord && genusMatchBonus > 0),
    nameAgreementPenalty,
    nameAgreementReason,
    nameAgreementPct,
    lowIdentityPenalty,
    lowIdentityReason,
    capApplied,
    capReason,
    finalScore,
    validatedHitCount,
    ncbiMatchType,
    ncbiRecordCount,
    lowIdentityOccurrences,
    deepOccurrences,
    envBlastReplicationBonus,
    envBlastReplicationReason,
    envBlastReplicatingSamples: repl.replicatingSamples,
    envBlastReplicatingVariants: repl.replicatingVariants,
    envBlastSampleRic: repl.totalSampleRic,
    envBlastVariantRic: repl.totalVariantRic,
    unculturedPenalty,
    unculturedPenaltyReason,
  };
}

/** What the analysis reads from a sequence's two BLAST result files, after adjusted identity. */
export type BlastEvidence =
  | { failure: "fetch"; missing: "both" | "NCBI" | "local" }
  | { failure: "parse"; localParsed: boolean; ncbiParsed: boolean }
  | {
    failure: null;
    /** The parsed hits, with the aligned sequences emptied once adjusted identity has been worked out from them. */
    localResult: ParsedBlastResult;
    ncbiResult: ParsedBlastResult;
    /** Hit number -> adjusted identity in percent. A hit with none is absent. */
    localAdjustedMap: Record<number, number>;
    ncbiAdjustedMap: Record<number, number>;
    /** How many hits had an alignment to score. */
    localIdentityAsked: number;
    ncbiIdentityAsked: number;
    xmlSources: string;
  };
