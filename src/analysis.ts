// The deterministic analysis of one sequence: what species its BLAST results
// say it is, how sure that is, and whether it is a contaminant or off target.
//
// Moved from mycomap.org's batchAnalysisService.ts
// The only changes to the text are
// that every outside call, and every log line, is now made through `ports`,
// which the caller hands in. The rules are the same.
//
// This file makes no outside call itself. Whoever runs the analysis supplies
// the ports: the server gives ones that read mycomap.org's data, a replay gives
// ones that answer from a recorded case, and MycoMap Validation will give ones
// that read its local databases.
//
// The eDNA branches read and write the eDNA tables through named operations
// in `ports.edna` (EdnaDatabaseOperations), which only the server hands in;
// the analysis holds no database of its own. A specimen analysis needs nothing
// from the server at all: caseReplay.ts runs one from a recorded case alone.
import { ADJUSTED_IDENTITY_THRESHOLD, type AnalysisResult, type AnalysisStepResult, BACTERIAL_QUERY_COVERAGE_THRESHOLD, BAD_COVERAGE_MAJORITY, type BlastEvidence, type BlastHit, CHIMERA_LENGTH_THRESHOLD, COMBINED_COVERAGE_THRESHOLD, CONTAMINANT_FLAG_THRESHOLD, CONTAMINANT_SKIP_THRESHOLD, EDNA_ADJUSTED_IDENTITY_THRESHOLD, EDNA_LOW_IDENTITY_CHECK_THRESHOLD, EDNA_SECONDARY_IDENTITY_THRESHOLD, type GenBankRecord, type IterativeConsensusResult, LOW_IDENTITY_CHECK_THRESHOLD, MIN_VALIDATED_HITS, type ParsedBlastResult, QC_SC_RATIO_THRESHOLD, QUERY_COVERAGE_THRESHOLD, REGULAR_CONSENSUS_TIERS, SECONDARY_IDENTITY_THRESHOLD, SPECIES_CONSENSUS_THRESHOLD, type SequenceRecord, buildPassingObservationRangeContext, calculateQueryCover, calculateSubjectCover, computeConfidenceScore, extractGenus, extractPlatformObsRef, extractSpeciesName, findSequenceRecordForHit, formatTierAttempts, getBinomialSpeciesNameFromHit, getHitSourceKey, getSpeciesNameFromHit, groupByNormalizedName, isConsensusVoteName, isContaminantFlag, isExcludedReference, isHitValidated, isInfraspecificRank, isSupragenericRank, isTrashReference, isValidTaxonomicName, iterativeBinomialConsensus, likelyContaminantNameFromNcbi, localConsensusEntries, noteContaminantLikelyName } from "./analysisRules";
import { CONTAMINANT_GENERA } from "./contaminantGenera";
import { setDeterministicCurationRecommendations } from "./curationRules";
import { type AmpliconFamily, chimeraLengthCeilingBp } from "./ednaAmplicon";
import { meetsEdnaCoverageThreshold, qualifyingEnvBlastHits } from "./ednaHitRules";
import { type FamilyResolution, formatFamilyResolution } from "./familyTypes";
import { genbankFamilyCheck, genbankLikelyNameApplies } from "./genbankLikelyName";
import { isBetweenFamilyAndGenusRank } from "./infragenericNames";
import { isBinomialName, isEnvCodeName, isRealBinomial, isUnculturedName, speciesNamesMatch } from "./speciesNames";
import { countSpecimens, oneVotePerSpecimen, specimenVoteNote, validatedHitPhrase } from "./specimenVotes";
import { isUsableTaxonName } from "./taxonNames";

/** A record's name read whole, as the analysis takes it; `indexed` is set when the fungal-names index completed it. */
export interface RecordNameAnswer {
  name: string;
  rank: string | null;
  indexed: unknown | null;
}

/**
 * Everything a specimen analysis asks of the outside world. Each is a question
 * with a plain-data answer, so a run can be recorded and replayed. What only
 * the eDNA branches ask is in `edna`.
 */
export interface AnalysisPorts {
  /** The record's name read whole ("Verni" is Cortinarius sect. Verni). */
  recordName(name: string | null | undefined): Promise<RecordNameAnswer | null>;
  /** The sequence's MycoBLAST and NCBI hits, with each hit's adjusted identity. */
  blastEvidence(sequenceId: string, localXmlUrl: string, ncbiXmlUrl: string): Promise<BlastEvidence>;
  /** Each MycoBLAST hit's own record: name, validation, flags, specimen. */
  sequenceMetadata(accessions: string[]): Promise<Record<string, SequenceRecord>>;
  /** The species names of the observations behind the MycoBLAST hits. */
  observationSpecies(refs: Array<{ id: string; source: string }>): Promise<Record<string, string>>;
  /** Each NCBI hit's GenBank record as the caller holds it. */
  genbankMetadata(accessions: string[]): Promise<Record<string, GenBankRecord>>;
  /** The rank of the record's name. */
  sourceRank(sourceSpeciesName: string | null, providedRank: string | null | undefined): Promise<string | null>;
  /** The family a name belongs to, and where that answer came from. */
  family(name: string, expectedRank?: string): Promise<FamilyResolution>;
  /** Keeps a result part-way (the chimera exits do this themselves). */
  saveInterimResult(sequenceId: string, result: AnalysisResult): Promise<unknown>;
  /** Where the analysis reports what it is doing; the server hands in its console. */
  logger: {
    log(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  /** The server's eDNA operations; null anywhere else, where an eDNA sequence is refused. */
  edna: EdnaOperations | null;
  /**
   * The server's clock in milliseconds, only for the log line that says how
   * long a sequence's BLAST files and metadata took. Without it (a replay, or
   * anyone else) that line is left out; nothing the analysis decides reads it.
   */
  now?: () => number;
}

/** An eDNA species id as the eDNA tables keep it: an accession from a source, and the name it carries. */
export interface EdnaSpeciesIdRow {
  id: number;
  accession: string;
  source: string;
  scientificName: string;
  updatedBy: string | null;
}

/** The eDNA path's reads and writes, as the server names them (mycomap.org's ednaAnalysisOperations.ts there). */
export interface EdnaDatabaseOperations {
  /** The eDNA species ids kept for these accessions. */
  speciesIdsForAccessions(batch: string[]): Promise<EdnaSpeciesIdRow[]>;
  /** Where a variant's environmental BLAST result is kept. */
  variantEnvBlastFile(ednaVariantIdNum: number): Promise<{ envBlastFile: string | null } | undefined>;
  /** The eDNA species id a variant carries now. */
  variantSpeciesId(ednaVariantIdNum: number): Promise<{ ednaSpeciesId: string | null } | undefined>;
  /** Every eDNA species id name matching a LIKE pattern (the env codes already given out for a genus). */
  speciesIdNamesLike(pattern: string): Promise<Array<{ scientificName: string }>>;
  /** The eDNA species id kept for one accession from one source. */
  speciesIdRowsFor(acc: { accession: string; source: string }): Promise<EdnaSpeciesIdRow[]>;
  /** Gives an accession the analysis's env code, unless a person set its name (manual-edit). */
  upsertAnalyzerSpeciesId({ acc, tempCode, sequenceId, taxonomy }: { acc: { accession: string; source: string }; tempCode: string; sequenceId: string; taxonomy: any }): Promise<void>;
  /** The species an env code is mapped to now, and who mapped it. */
  mappingFor(tempCode: string): Promise<{ source: string; resolvedSpecies: string } | undefined>;
  /** Maps an env code to a species, as the analysis's own (source auto). */
  upsertAutoMapping({ tempCode, mappingSpecies, localBinomial, ncbiBinomial }: { tempCode: string; mappingSpecies: string; localBinomial: string | null; ncbiBinomial: string | null }): Promise<void>;
  /** A name's kingdom, phylum and class from the classification cache. */
  classificationCacheRanks(sp: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  /** A class for a name, from any observation of it or its genus. */
  observationClassRows(sp: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  /** Keeps a name's classification in the cache, filling only what is missing there. */
  cacheClassification({ sp, kingdom, phylum, family, cls, order }: { sp: string; kingdom: string | null; phylum: string | null; family: string | null; cls: string | null; order: string | null }): Promise<void>;
  /** A name's genus to kingdom from the classification cache, when it has a phylum or kingdom. */
  classificationCacheFull(sp: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  /** The env code a variant's placeholder accession holds now. */
  placeholderSpeciesIdName({ placeholderAccession, placeholderSource }: { placeholderAccession: string; placeholderSource: string }): Promise<{ scientificName: string } | undefined>;
  /** Reserves an env code under a variant's placeholder accession, so it is not given out again. */
  upsertPlaceholderSpeciesId({ placeholderAccession, placeholderSource, tempCode, fallbackBase, sequenceId }: { placeholderAccession: string; placeholderSource: string; tempCode: string; fallbackBase: string; sequenceId: string }): Promise<void>;
  /** Records a placeholder's old env code as a synonym of its new one. */
  recordPlaceholderSynonym({ priorName, tempCode, placeholderAccession, placeholderSource, sequenceId }: { priorName: string; tempCode: string; placeholderAccession: string; placeholderSource: string; sequenceId: string }): Promise<void>;
  /** The eDNA species id each of these variants carries. */
  variantSpeciesIds(candidateVariantIds: Set<string>): Promise<Array<{ id: number; ednaSpeciesId: string | null }>>;
}

/**
 * What the eDNA branches use of the server: their reads and writes of the
 * eDNA tables, by name (EdnaDatabaseOperations), and the server's helpers
 * around them. The analysis holds no database of its own.
 */
export interface EdnaOperations extends EdnaDatabaseOperations {
  classifyVariantById(variantId: number): Promise<AmpliconFamily>;
  countSiblingVariantsByVariantId(variantId: number): Promise<number>;
  readEdnaBlastXml(storedPath: string | null | undefined): string | null;
  /** Reads an environmental BLAST result file's text into hits. */
  parseBlastXml(xmlString: string): ParsedBlastResult | null;
  clearEdnaSpeciesMappingsCache(): void;
  resolveTaxonomy(scientificName: string): Promise<any>;
  /** The family a name belongs to, alone. */
  lookupFamily(genusOrSpecies: string): Promise<string | null>;
  /** The order a name belongs to. */
  lookupOrder(genusOrSpecies: string): Promise<string | null>;
  /** A name's full classification from NCBI. */
  lookupFullTaxonomyFromNCBI(nameOrGenus: string): Promise<{ kingdom: string | null; phylum: string | null; family: string | null; class: string | null; order: string | null }>;
  findEnvBlastSiblingEdnaId(
    ednaVariantIdNum: number,
    ednaVariantIdStr: string,
    queryLen: number,
    ampliconFamily: AmpliconFamily | null | undefined,
  ): Promise<{ siblingEdnaId: string; matchCount: number } | null>;
  ednaSynonyms(): Promise<{
    renameEdnaSpeciesId: (opts: any) => Promise<any>;
    setVariantEdnaSpeciesId: (opts: any) => Promise<any>;
  }>;
}

/** What the run had in hand, for the look-up made after it finishes (genbankLikelyName.ts). */
interface AnalysisSeen {
  ncbi?: { hits: BlastHit[]; genbankMap: Record<string, GenBankRecord>; adjusted: Record<number, number> };
  mycomapQualified?: number;
  /** The record's family, as resolved early in the run. */
  recordFamily?: string | null;
}

/**
 * Runs the analysis, then, for a specimen it could not name with only GenBank to
 * go on, notes what GenBank points to (genbankLikelyName.ts). That look-up reads
 * the hits the run already had and asks nothing more.
 */
export async function runDeterministicAnalysis(...args: Parameters<typeof runAnalysisSteps> extends [unknown, ...infer Rest] ? Rest : never): Promise<AnalysisResult> {
  const seen: AnalysisSeen = {};
  const result = await runAnalysisSteps(seen, ...args);
  const sequenceId = args[1];
  if (seen.ncbi && genbankLikelyNameApplies(result, { isEdna: sequenceId.startsWith("edna-"), mycomapQualified: seen.mycomapQualified ?? 0 })) {
    const likely = likelyContaminantNameFromNcbi(seen.ncbi.hits, seen.ncbi.genbankMap, seen.ncbi.adjusted, null);
    if (likely) {
      const ports = args[0];
      result.genbankLikelyName = { ...likely, ...(await genbankFamilyCheck(likely, seen.recordFamily, (genus) => ports.family(genus, "genus"))) };
    }
  }
  return result;
}

async function runAnalysisSteps(
  seen: AnalysisSeen,
  ports: AnalysisPorts,
  sequenceId: string,
  ncbiXmlUrl: string | undefined,
  localXmlUrl: string | undefined,
  sourceSpeciesName: string | null,
  sourceRic: number | null,
  sourceRank?: string | null,
  isOnlySequenceForRecord?: boolean,
  envBlastReplication?: { replicatingSamples: number; replicatingVariants: number; totalSampleRic: number; totalVariantRic: number },
): Promise<AnalysisResult> {
  // The eDNA branches below run on the server's own operations. Anywhere else there are none,
  // and an eDNA sequence is refused before anything is read.
  if (sequenceId.startsWith("edna-") && !ports.edna) {
    throw new Error(`An eDNA analysis (${sequenceId}) needs the server's eDNA operations`);
  }
  const edna = ports.edna as EdnaOperations;
  const ignoredSourceIdentification = sourceSpeciesName && !isUsableTaxonName(sourceSpeciesName)
    ? sourceSpeciesName
    : null;
  if (ignoredSourceIdentification) sourceSpeciesName = null;

  // iNat names a group inside a genus with one word ("Verni" is Cortinarius
  // sect. Verni): its genus goes back on from the fungal-names index, so every
  // step below reads the name whole (infragenericNames.ts).
  const sourceAsRecorded = sourceSpeciesName;
  const sourceRecordName = await ports.recordName(sourceSpeciesName);
  if (sourceRecordName?.indexed) {
    sourceSpeciesName = sourceRecordName.name;
    sourceRank = sourceRecordName.rank;
  }

  const result: AnalysisResult = {
    status: "running",
    steps: [],
    finalSpecies: null,
    finalConfidence: null,
    confidenceBreakdown: null,
    flaggedContaminant: false,
    flaggedNonTarget: false,
    skipped: false,
    barcodeGapNeeded: false,
    ncbiConsensusSpecies: null,
    ncbiConsensusCount: null,
    ncbiConsensusTotalWithSpecies: null,
    ncbiConsensusThreshold: null,
    localConsensusSpecies: null,
    localConsensusCount: null,
    localConsensusTotalWithSpecies: null,
    localConsensusThreshold: null,
    curationCount: 0,
    curationRecommendations: [],
  };

  const addStep = (step: AnalysisStepResult) => {
    result.steps.push(step);
  };

  const singletonReasons: string[] = [];

  // ===== STEP 1: PREPARATION =====
  addStep({
    step: "Preparation",
    status: "running",
    message: "Checking BLAST results availability...",
  });

  if (!ncbiXmlUrl) {
    result.steps[result.steps.length - 1] = {
      step: "Preparation",
      status: "fail",
      message: "NCBI BLAST results are not available",
      details: ["NCBI BLAST results must be loaded before running analysis."],
    };
    result.status = "error";
    result.errorMessage = "NCBI BLAST results required";
    return result;
  }

  if (!localXmlUrl) {
    result.steps[result.steps.length - 1] = {
      step: "Preparation",
      status: "fail",
      message: "MycoBLAST results are not available",
      details: ["MycoBLAST results must be loaded before running analysis."],
    };
    result.status = "error";
    result.errorMessage = "MycoBLAST results required";
    return result;
  }

  const clock = ports.now;
  const t0 = clock?.() ?? 0;
  // A sequence's own id is what identifies its BLAST files; their addresses can carry a key and are not kept.
  const blast = await ports.blastEvidence(sequenceId, localXmlUrl, ncbiXmlUrl);
  const t1 = clock?.() ?? 0;

  if (blast.failure === "fetch") {
    const missing = blast.missing;
    result.steps[result.steps.length - 1] = {
      step: "Preparation",
      status: "fail",
      message: `Failed to fetch ${missing} BLAST XML`,
      details: [`Could not retrieve ${missing} BLAST XML data`],
    };
    result.status = "error";
    result.errorMessage = missing === "NCBI" ? "Awaiting NCBI" : "Failed to fetch BLAST XML";
    return result;
  }

  if (blast.failure === "parse") {
    result.steps[result.steps.length - 1] = {
      step: "Preparation",
      status: "fail",
      message: "Failed to parse BLAST XML",
      details: [
        !blast.localParsed ? "Local BLAST XML could not be parsed" : "",
        !blast.ncbiParsed ? "NCBI BLAST XML could not be parsed" : "",
      ].filter(Boolean),
    };
    result.status = "error";
    result.errorMessage = "Failed to parse BLAST XML";
    return result;
  }

  const { localResult, ncbiResult, localAdjustedMap, ncbiAdjustedMap } = blast;
  const localAccessions = localResult.hits.map(h => h.accession);
  const ncbiAccessions = ncbiResult.hits.map(h => h.accession).filter(Boolean);

  const [sequenceMap, genbankMap] = await Promise.all([
    ports.sequenceMetadata(localAccessions),
    ports.genbankMetadata(ncbiAccessions),
  ]);
  const t3 = clock?.() ?? 0;
  if (clock) ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: Timing: xmlLoad+identity=${t1 - t0}ms (${blast.xmlSources}), metadata=${t3 - t1}ms`);
  ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: Computed adjusted identity for ${Object.keys(localAdjustedMap).length}/${blast.localIdentityAsked} local + ${Object.keys(ncbiAdjustedMap).length}/${blast.ncbiIdentityAsked} NCBI hits via Python`);
  seen.ncbi = { hits: ncbiResult.hits, genbankMap, adjusted: ncbiAdjustedMap };
  ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: Fetched metadata for ${Object.keys(sequenceMap).length}/${localAccessions.length} local + ${Object.keys(genbankMap).length}/${ncbiAccessions.length} NCBI accessions`);

  // Log any adjusted identity misses for debugging
  const localMissCount = blast.localIdentityAsked - Object.keys(localAdjustedMap).length;
  const ncbiMissCount = blast.ncbiIdentityAsked - Object.keys(ncbiAdjustedMap).length;
  if (localMissCount > 0) {
    ports.logger.warn(`[BatchAnalysis] Seq ${sequenceId}: ${localMissCount} local hits missing adjusted identity`);
  }
  if (ncbiMissCount > 0) {
    ports.logger.warn(`[BatchAnalysis] Seq ${sequenceId}: ${ncbiMissCount} NCBI hits missing adjusted identity`);
  }

  // Enrich sequenceMap with observation species names (matches client-side enrichment flow)
  // Client: fetches sequences → extracts platform-specific obs ids from title → fetches species from observations/species API
  // IMPORTANT: seq.observationId is the MycoMap-internal id and must NOT be sent to the
  // upstream species endpoint as a platform id (see extractPlatformObsRef comment).
  const obsRefs: Array<{ id: string; source: string }> = [];
  for (const [, seq] of Object.entries(sequenceMap)) {
    const ref = extractPlatformObsRef(seq);
    if (ref) obsRefs.push(ref);
  }
  let obsSpeciesMap: Record<string, string> = {};
  if (obsRefs.length > 0) {
    obsSpeciesMap = await ports.observationSpecies(obsRefs);
    ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: Enriched ${Object.keys(obsSpeciesMap).length} observation species names`);
    // Map platform observation IDs back to sequence records and enrich scientificName
    for (const [, seq] of Object.entries(sequenceMap)) {
      const ref = extractPlatformObsRef(seq);
      if (!ref) continue;
      const enrichedName = obsSpeciesMap[`${ref.source}:${ref.id}`];
      if (enrichedName && isValidTaxonomicName(enrichedName)) {
        if (!seq.scientificName || !isValidTaxonomicName(seq.scientificName)) {
          seq.scientificName = enrichedName;
        }
      }
    }
  }

  const isEdnaSequence = sequenceId.startsWith("edna-");
  const effectiveIdentityThreshold = isEdnaSequence ? EDNA_ADJUSTED_IDENTITY_THRESHOLD : ADJUSTED_IDENTITY_THRESHOLD;
  const effectiveLowIdThreshold = isEdnaSequence ? EDNA_LOW_IDENTITY_CHECK_THRESHOLD : LOW_IDENTITY_CHECK_THRESHOLD;

  // Primer-aware chimera length ceiling. Fungal ITS amplicons are ~250–500bp
  // so the default 750bp is fine, but bacterial 16S amplicons are ~1500bp
  // legitimately and would otherwise trip the chimera rule on every sequence.
  let effectiveChimeraLengthThreshold = CHIMERA_LENGTH_THRESHOLD;
  // Number of non-trash variants on the same parent sequence (for eDNA only).
  // A "Singleton Sequence" verdict only makes sense when this is 1; sequences
  // with multiple variants should never be labeled "Singleton".
  let ednaVariantSiblingCount = 1;
  let ampliconFamily: AmpliconFamily | null = null;
  if (isEdnaSequence) {
    try {
      // For eDNA, the `sequenceId` here is `edna-{variantId}`, NOT the underlying
      // ednaSequences.id. Resolve the variant → its parent sequence → its primers.
      const numericVariantId = parseInt(sequenceId.replace(/^edna-/, ""), 10);
      if (!Number.isNaN(numericVariantId)) {
        ampliconFamily = await edna.classifyVariantById(numericVariantId);
        const ceiling = chimeraLengthCeilingBp(ampliconFamily);
        if (ceiling !== null) {
          effectiveChimeraLengthThreshold = ceiling;
        }
        ednaVariantSiblingCount = await edna.countSiblingVariantsByVariantId(numericVariantId);
        ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: amplicon family=${ampliconFamily}, chimera length ceiling=${effectiveChimeraLengthThreshold}bp, variant siblings=${ednaVariantSiblingCount}`);
      }
    } catch (err: any) {
      ports.logger.error(`[BatchAnalysis] Seq ${sequenceId}: failed to resolve amplicon family for chimera threshold; using default ${CHIMERA_LENGTH_THRESHOLD}bp:`, err?.message || err);
    }
  }
  const isBacterial16s = ampliconFamily === "bacterial_16s";
  const effectiveQueryCoverageThreshold = isBacterial16s
    ? BACTERIAL_QUERY_COVERAGE_THRESHOLD
    : QUERY_COVERAGE_THRESHOLD;
  const ednaIsMultiVariant = isEdnaSequence && ednaVariantSiblingCount > 1;

  let ednaSpeciesIdMap: Record<string, string> | undefined;
  if (isEdnaSequence) {
    const allAccessions = [
      ...localResult.hits.map(h => h.accession),
      ...ncbiResult.hits.map(h => h.accession),
    ].filter(Boolean);
    if (allAccessions.length > 0) {
      const uniqueAccessions = [...new Set(allAccessions)];
      const batchSize = 500;
      const mapEntries: Record<string, string> = {};
      for (let i = 0; i < uniqueAccessions.length; i += batchSize) {
        const batch = uniqueAccessions.slice(i, i + batchSize);
        const rows = await edna.speciesIdsForAccessions(batch);
        for (const row of rows) {
          mapEntries[row.accession] = row.scientificName;
        }
      }
      if (Object.keys(mapEntries).length > 0) {
        ednaSpeciesIdMap = mapEntries;
        ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: Loaded ${Object.keys(mapEntries).length} eDNA species ID mappings for ${uniqueAccessions.length} accessions`);
      }
    }
  }

  let sourceRecordFamily: string | null = null;
  let sourceRecordFamilyResolution: FamilyResolution | null = null;
  const effectiveRank = await ports.sourceRank(sourceSpeciesName, sourceRank);
  const infraspecificSource = isInfraspecificRank(effectiveRank);
  const supragenericSource = isSupragenericRank(effectiveRank);

  const isFamilyRank = effectiveRank?.toLowerCase() === "family";

  const ORDER_TO_FAMILY_MAP: Record<string, string> = {
    "pezizales": "Pezizaceae",
    "boletales": "Boletaceae",
  };

  const GENUS_MATCH_FAMILIES: Record<string, string[][]> = {
    "agaricaceae": [
      ["Agaricus"],
      ["Bovista", "Calbovista", "Calvatia", "Handkea", "Tulostoma", "Disciseda", "Lycoperdon", "Mycenastrum", "Podaxis"],
    ],
  };

  const orderFamilyOverride = sourceSpeciesName ? ORDER_TO_FAMILY_MAP[sourceSpeciesName.toLowerCase()] : null;
  if (sourceSpeciesName) {
    if (orderFamilyOverride && supragenericSource) {
      sourceRecordFamily = orderFamilyOverride;
      ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: sourceSpeciesName="${sourceSpeciesName}" rank="${effectiveRank}" (order→family override: "${orderFamilyOverride}")`);
    } else if (supragenericSource) {
      ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: sourceSpeciesName="${sourceSpeciesName}" rank="${effectiveRank}" (suprageneric - skipping family lookup)`);
    } else if (isBetweenFamilyAndGenusRank(effectiveRank)) {
      // A subfamily or tribe ("Leccinoideae"): its family, not a genus, from the name.
      sourceRecordFamilyResolution = await ports.family(sourceSpeciesName, effectiveRank || undefined);
      sourceRecordFamily = sourceRecordFamilyResolution.family;
      ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: sourceSpeciesName="${sourceSpeciesName}" rank="${effectiveRank}" (between family and genus) => family="${sourceRecordFamily}"`);
    } else if (isFamilyRank) {
      ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: sourceSpeciesName="${sourceSpeciesName}" rank="${effectiveRank}" (family-level - using source name as family)`);
      sourceRecordFamily = sourceSpeciesName;
    } else if (infraspecificSource) {
      const sourceGenus = extractGenus(sourceSpeciesName);
      const isSingleWordInfraspecific = sourceSpeciesName.trim().split(/\s+/).length === 1;
      if (isSingleWordInfraspecific) {
        ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: sourceSpeciesName="${sourceSpeciesName}" rank="${effectiveRank}" (single-word infraspecific name — genus not in name, using iNat API for family lookup)`);
      } else {
        ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: sourceSpeciesName="${sourceSpeciesName}" rank="${effectiveRank}" (infraspecific -> using genus "${sourceGenus}" for family lookup)`);
      }
      if (sourceGenus && !isSingleWordInfraspecific) {
        sourceRecordFamilyResolution = await ports.family(sourceGenus, "genus");
        sourceRecordFamily = sourceRecordFamilyResolution.family;
        ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: Family lookup for genus "${sourceGenus}" => "${sourceRecordFamily}"`);
      } else {
        sourceRecordFamilyResolution = await ports.family(sourceSpeciesName, effectiveRank || undefined);
        if (sourceRecordFamilyResolution.family) {
          sourceRecordFamily = sourceRecordFamilyResolution.family;
          ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: Resolved infraspecific "${sourceSpeciesName}" => family="${sourceRecordFamily}" via ${sourceRecordFamilyResolution.authority}`);
        } else {
          ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: Could not resolve family for infraspecific "${sourceSpeciesName}"`);
        }
      }
    } else {
      const sourceGenus = extractGenus(sourceSpeciesName);
      ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: sourceSpeciesName="${sourceSpeciesName}" sourceGenus="${sourceGenus}"`);
      if (sourceGenus) {
        sourceRecordFamilyResolution = await ports.family(sourceGenus, "genus");
        sourceRecordFamily = sourceRecordFamilyResolution.family;
        ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: Family lookup for "${sourceGenus}" => "${sourceRecordFamily}"`);
      }
    }
  } else {
    ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: No sourceSpeciesName provided`);
  }

  seen.recordFamily = sourceRecordFamily;
  const sourceDisplayName = orderFamilyOverride && supragenericSource && sourceSpeciesName
    ? `${sourceSpeciesName} (rank: ${effectiveRank}, mapped to family: ${orderFamilyOverride})`
    : supragenericSource && sourceSpeciesName
    ? `${sourceSpeciesName} (rank: ${effectiveRank}, too high for family comparison)`
    : infraspecificSource && sourceSpeciesName
    ? (extractGenus(sourceSpeciesName)
      ? `${sourceSpeciesName} (rank: ${effectiveRank}, using genus "${extractGenus(sourceSpeciesName)}" for family lookup)`
      : `${sourceSpeciesName} (rank: ${effectiveRank}, direct family lookup)`)
    : sourceSpeciesName;

  result.steps[result.steps.length - 1] = {
    step: "Preparation",
    status: "pass",
    message: "Both NCBI and MycoBLAST results are available",
    details: [
      `NCBI: ${ncbiResult.hits.length} hits`,
      `MycoBLAST: ${localResult.hits.length} hits`,
      ...(isEdnaSequence
        ? ["eDNA variant - no source specimen species"]
        : sourceDisplayName
        ? [
            ...(sourceAsRecorded && sourceAsRecorded !== sourceSpeciesName
              ? [`Source name "${sourceAsRecorded}" read as ${sourceSpeciesName} (rank: ${sourceRecordName?.rank}, from the iNat fungal-names index)`]
              : []),
            `Source species: ${sourceDisplayName}${sourceRecordFamily ? ` (Family: ${sourceRecordFamily})` : " (family not resolved)"}`,
            ...(sourceRecordFamilyResolution ? formatFamilyResolution(sourceRecordFamilyResolution) : []),
          ]
        : [ignoredSourceIdentification
            ? `Source identification "${ignoredSourceIdentification}" is a placeholder and was treated as unidentified`
            : "No source species name available"]),
    ],
  };

  // ===== STEP 2: CONTAMINANT CHECK =====
  if (isEdnaSequence) {
    addStep({
      step: "Contaminant Check",
      status: "pass",
      message: "eDNA - contaminant check skipped (not applicable for environmental DNA)",
    });
  }

  const top10Ncbi = ncbiResult.hits.slice(0, 10);
  const contaminantHits: { hitDef: string; genus: string }[] = [];

  if (!isEdnaSequence) {
    addStep({
      step: "Contaminant Check",
      status: "running",
      message: "Checking top NCBI hits for contaminant genera...",
    });

    for (const hit of top10Ncbi) {
      const hitDef = hit.def;
      for (const contaminantGenus of CONTAMINANT_GENERA) {
        const isMatch = contaminantGenus === "Candida"
          ? hitDef.includes(contaminantGenus)
          : hitDef.toLowerCase().includes(contaminantGenus.toLowerCase());
        if (isMatch) {
          contaminantHits.push({ hitDef, genus: contaminantGenus });
          break;
        }
      }
    }
  }

  if (!isEdnaSequence && contaminantHits.length > 0) {
    const contaminantGenus = contaminantHits[0].genus;

    addStep({
      step: "Contaminant Check - Family Comparison",
      status: "running",
      message: `Contaminant genus "${contaminantGenus}" detected. Comparing family classification...`,
    });

    const sourceGenus = (sourceSpeciesName && !supragenericSource && !isFamilyRank) ? extractGenus(sourceSpeciesName) : null;
    let sourceFamily: string | null = isFamilyRank ? sourceSpeciesName : (orderFamilyOverride || null);
    let sourceFamilyResolution: FamilyResolution | null = null;
    let contaminantFamilyResolution: FamilyResolution | null = null;
    let contaminantFamily: string | null = null;

    const isSingleWordInfraForContam = infraspecificSource && sourceSpeciesName && sourceSpeciesName.trim().split(/\s+/).length === 1;
    if (!sourceFamily && sourceGenus && !isSingleWordInfraForContam) {
      sourceFamilyResolution = await ports.family(sourceGenus, "genus");
      sourceFamily = sourceFamilyResolution.family;
    } else if (!sourceFamily && sourceSpeciesName && (infraspecificSource || !sourceGenus)) {
      sourceFamilyResolution = await ports.family(sourceSpeciesName, effectiveRank || undefined);
      sourceFamily = sourceFamilyResolution.family;
    }
    contaminantFamilyResolution = await ports.family(contaminantGenus, "genus");
    contaminantFamily = contaminantFamilyResolution.family;

    let contaminantFamilyMatch = sourceFamily && contaminantFamily && sourceFamily.toLowerCase() === contaminantFamily.toLowerCase();
    let genusGroupMismatchMsg: string | null = null;
    if (contaminantFamilyMatch && sourceGenus) {
      const genusGroups = GENUS_MATCH_FAMILIES[sourceFamily!.toLowerCase()];
      if (genusGroups) {
        const srcGroup = genusGroups.find(g => g.some(gn => gn.toLowerCase() === sourceGenus.toLowerCase()));
        const contGroup = genusGroups.find(g => g.some(gn => gn.toLowerCase() === contaminantGenus.toLowerCase()));
        if (srcGroup && contGroup && srcGroup !== contGroup) {
          contaminantFamilyMatch = false;
          genusGroupMismatchMsg = `Same family (${sourceFamily}) but different genus groups: source "${sourceGenus}" vs contaminant "${contaminantGenus}"`;
        } else if (srcGroup && !contGroup) {
          contaminantFamilyMatch = false;
          genusGroupMismatchMsg = `Same family (${sourceFamily}) but contaminant genus "${contaminantGenus}" not in expected genus group for "${sourceGenus}"`;
        }
      }
    }

    if (contaminantFamilyMatch) {
      result.steps[result.steps.length - 1] = {
        step: "Contaminant Check - Family Comparison",
        status: "pass",
        message: `Family match found - contaminant flag removed`,
        details: [
          `Contaminant genus: ${contaminantGenus} (Family: ${contaminantFamily})`,
          `Source genus: ${sourceGenus} (Family: ${sourceFamily})`,
          `Same family "${sourceFamily}" - continuing analysis`,
          ...(sourceFamilyResolution ? formatFamilyResolution(sourceFamilyResolution).map(d => `Source ${d}`) : []),
          ...(contaminantFamilyResolution ? formatFamilyResolution(contaminantFamilyResolution).map(d => `Contaminant ${d}`) : []),
        ],
      };
      result.steps[result.steps.length - 2] = {
        step: "Contaminant Check",
        status: "pass",
        message: `Contaminant genera detected but family match confirmed - analysis continues`,
        details: contaminantHits.map(
          (ch) => `Found "${ch.genus}" in: ${ch.hitDef.substring(0, 80)}...`
        ),
      };
    } else {
      result.steps[result.steps.length - 1] = {
        step: "Contaminant Check - Family Comparison",
        status: "fail",
        message: `Family mismatch - sequence flagged as contaminant`,
        details: [
          `Contaminant genus: ${contaminantGenus}${contaminantFamily ? ` (Family: ${contaminantFamily})` : " (family lookup failed)"}`,
          sourceGenus
            ? `Source genus: ${sourceGenus}${sourceFamily ? ` (Family: ${sourceFamily})` : " (family lookup failed)"}`
            : "No source species available for comparison",
          "Analysis stopped - sequence is flagged as contaminant",
          ...(sourceFamilyResolution ? formatFamilyResolution(sourceFamilyResolution).map(d => `Source ${d}`) : []),
          ...(contaminantFamilyResolution ? formatFamilyResolution(contaminantFamilyResolution).map(d => `Contaminant ${d}`) : []),
        ],
      };
      result.steps[result.steps.length - 2] = {
        step: "Contaminant Check",
        status: "fail",
        message: `Contaminant genera detected in NCBI results`,
        details: contaminantHits.map(
          (ch) => `Found "${ch.genus}" in: ${ch.hitDef.substring(0, 80)}...`
        ),
      };
      result.flaggedContaminant = true;
      noteContaminantLikelyName(result, likelyContaminantNameFromNcbi(ncbiResult.hits, genbankMap, ncbiAdjustedMap, {
        name: contaminantGenus,
        hits: contaminantHits.filter((ch) => ch.genus === contaminantGenus).length,
        checked: top10Ncbi.length,
      }));
      result.status = "complete";
      return result;
    }
  } else if (!isEdnaSequence) {
    result.steps[result.steps.length - 1] = {
      step: "Contaminant Check",
      status: "pass",
      message: "No contaminant genera found in top 10 NCBI hits",
      details: [
        `Checked ${top10Ncbi.length} NCBI hits against: ${CONTAMINANT_GENERA.join(", ")}`,
        "Contaminant check passed - analysis continues",
      ],
    };
  }

  // ===== STEP 2b: MYCOBLAST CONTAMINANT FLAG CHECK =====
  const LOCAL_CONTAMINANT_IDENTITY_THRESHOLD = 98.5;
  const LOCAL_CONTAMINANT_RATIO_THRESHOLD = 0.5;

  if (!isEdnaSequence && localResult && localResult.hits.length > 0) {
    addStep({
      step: "Contaminant Check - MycoBLAST Flags",
      status: "running",
      message: "Checking MycoBLAST hits for contaminant/non-target flags...",
    });

    const hitsAtThreshold: { accession: string; adjIdentity: number; isContaminant: boolean }[] = [];
    for (const hit of localResult.hits) {
      const seqRecord = findSequenceRecordForHit(hit, sequenceMap);
       if (isTrashReference(seqRecord)) continue;
      if (isExcludedReference(seqRecord)) continue;
      const adjIdentity = localAdjustedMap[hit.num];
      if (adjIdentity === undefined || adjIdentity < LOCAL_CONTAMINANT_IDENTITY_THRESHOLD) continue;
      const flags = seqRecord?.flags || [];
      const contaminant = isContaminantFlag(flags);
      hitsAtThreshold.push({ accession: hit.accession, adjIdentity, isContaminant: contaminant });
    }

    if (hitsAtThreshold.length > 0) {
      const contaminantCount = hitsAtThreshold.filter(h => h.isContaminant).length;
      const contaminantRatio = contaminantCount / hitsAtThreshold.length;

      if (contaminantRatio >= LOCAL_CONTAMINANT_RATIO_THRESHOLD) {
        result.steps[result.steps.length - 1] = {
          step: "Contaminant Check - MycoBLAST Flags",
          status: "fail",
          message: `MycoBLAST contaminant threshold exceeded - ${contaminantCount}/${hitsAtThreshold.length} hits (${(contaminantRatio * 100).toFixed(0)}%) at >= ${LOCAL_CONTAMINANT_IDENTITY_THRESHOLD}% identity are flagged as non-target`,
          details: [
            `${contaminantCount} of ${hitsAtThreshold.length} MycoBLAST hits at >= ${LOCAL_CONTAMINANT_IDENTITY_THRESHOLD}% adjusted identity are flagged as contaminant/non-target`,
            `Threshold: >= ${(LOCAL_CONTAMINANT_RATIO_THRESHOLD * 100).toFixed(0)}% flags sequence as contaminant`,
            "Sequence flagged as contaminant",
          ],
        };
        result.flaggedContaminant = true;
        noteContaminantLikelyName(result, likelyContaminantNameFromNcbi(ncbiResult.hits, genbankMap, ncbiAdjustedMap, null));
        result.status = "complete";
        return result;
      } else {
        result.steps[result.steps.length - 1] = {
          step: "Contaminant Check - MycoBLAST Flags",
          status: "pass",
          message: contaminantCount > 0
            ? `MycoBLAST contaminant check passed - ${contaminantCount}/${hitsAtThreshold.length} hits flagged (below ${(LOCAL_CONTAMINANT_RATIO_THRESHOLD * 100).toFixed(0)}% threshold)`
            : `MycoBLAST contaminant check passed - no contaminant flags found among ${hitsAtThreshold.length} hits at >= ${LOCAL_CONTAMINANT_IDENTITY_THRESHOLD}% identity`,
          details: [
            `Checked ${hitsAtThreshold.length} MycoBLAST hits at >= ${LOCAL_CONTAMINANT_IDENTITY_THRESHOLD}% adjusted identity (any validation status)`,
            contaminantCount > 0
              ? `${contaminantCount} flagged as contaminant/non-target (${(contaminantRatio * 100).toFixed(0)}%)`
              : "No contaminant/non-target flags found",
            "Contaminant check passed - analysis continues",
          ],
        };
      }
    } else {
      result.steps[result.steps.length - 1] = {
        step: "Contaminant Check - MycoBLAST Flags",
        status: "pass",
        message: "No MycoBLAST hits at >= " + LOCAL_CONTAMINANT_IDENTITY_THRESHOLD + "% identity to check",
        details: [
          "Contaminant flag check skipped - no qualifying hits",
          "Contaminant check passed - analysis continues",
        ],
      };
    }
  }

  // ===== Determine query sequence source key for same-specimen exclusion =====
  let querySourceKey: string | null = null;
  let sameSpecimenSkipCount = 0;
  if (sequenceId && localResult) {
    for (const hit of localResult.hits) {
      const seqRecord = findSequenceRecordForHit(hit, sequenceMap);
      if (seqRecord && String(seqRecord.id) === String(sequenceId)) {
        querySourceKey = getHitSourceKey(hit, seqRecord);
        break;
      }
    }
    if (!querySourceKey) {
      const queryRec = Object.values(sequenceMap).find(s => String(s.id) === String(sequenceId));
      if (queryRec?.observationId) {
        querySourceKey = `obs:${queryRec.observationId}`;
      }
    }
    if (querySourceKey) {
      ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: Source key: ${querySourceKey} — same-specimen hits will be excluded`);
    }
  }

  // ===== STEP 3: LOCAL HIT ANALYSIS - FILTERING =====
  addStep({
    step: "Local Hit Analysis - Filtering",
    status: "running",
    message: "Filtering local BLAST hits by adjusted identity and validation status...",
  });

  const qualifiedHits: {
    hit: BlastHit;
    adjustedIdentity: number;
    queryCoverage: number;
    speciesName: string | null;
    isContaminant: boolean;
    isValidated: boolean;
    /** The observation the hit's sequence came from; its reads vote once (specimenVotes.ts). */
    specimenKey?: string | null;
  }[] = [];

  let debugSkipTrash = 0, debugSkipLowQuality = 0, debugSkipNoAdj = 0, debugSkipLowAdj = 0, debugSkipNotValidated = 0;
  for (const hit of localResult.hits) {
    const seqRecord = findSequenceRecordForHit(hit, sequenceMap);
    if (isTrashReference(seqRecord)) { debugSkipTrash++; continue; }
    if (isExcludedReference(seqRecord)) { debugSkipLowQuality++; continue; }

    if (querySourceKey) {
      const isOrigin = String(seqRecord?.id) === String(sequenceId);
      if (isOrigin) { sameSpecimenSkipCount++; continue; }
      const hitSourceKey = getHitSourceKey(hit, seqRecord || null);
      if (hitSourceKey && hitSourceKey === querySourceKey) { sameSpecimenSkipCount++; continue; }
    }

    const adjIdentity = localAdjustedMap[hit.num];
    if (adjIdentity === undefined) { debugSkipNoAdj++; continue; }
    if (adjIdentity < effectiveIdentityThreshold) { debugSkipLowAdj++; continue; }

    const validated = isHitValidated(hit, sequenceMap, genbankMap);
    if (!isEdnaSequence && !validated) {
      const rec = sequenceMap[hit.accession];
      if (debugSkipNotValidated < 5) {
        ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: Hit ${hit.num} acc=${hit.accession} NOT validated: inMap=${!!rec}, validated=${rec?.validated}, validationStatus=${rec?.validationStatus}, adjId=${adjIdentity}`);
      }
      debugSkipNotValidated++;
      continue;
    }

    const queryCov = calculateQueryCover(hit, localResult.queryLen);
    const speciesName = getSpeciesNameFromHit(hit, sequenceMap, genbankMap, ednaSpeciesIdMap);
    const flags = seqRecord?.flags || [];
    const contaminant = isContaminantFlag(flags);

    qualifiedHits.push({
      hit,
      adjustedIdentity: adjIdentity,
      queryCoverage: queryCov,
      speciesName,
      isContaminant: contaminant,
      isValidated: validated,
      specimenKey: getHitSourceKey(hit, seqRecord || null),
    });
  }

  let envBlastQualifiedCount = 0;
  if (isEdnaSequence) {
    const ednaVarId = sequenceId.replace("edna-", "");
    try {
      const variantRow = await edna.variantEnvBlastFile(parseInt(ednaVarId, 10));
      const envXml = edna.readEdnaBlastXml(variantRow?.envBlastFile);
      if (envXml) {
        const envResult = edna.parseBlastXml(envXml);
        if (envResult && envResult.hits.length > 0) {
          for (const { hit, rawIdentity } of qualifyingEnvBlastHits(envResult, ednaVarId, effectiveIdentityThreshold, localResult.queryLen || envResult.queryLen, ampliconFamily)) {
            qualifiedHits.push({
              hit,
              adjustedIdentity: rawIdentity,
              queryCoverage: calculateQueryCover(hit, localResult.queryLen || envResult.queryLen),
              speciesName: null,
              isContaminant: false,
              isValidated: true,
            });
            envBlastQualifiedCount++;
          }
          ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: envBLAST hits total=${envResult.hits.length}, qualified (99%+, excl self)=${envBlastQualifiedCount}`);
        }
      }
    } catch (envErr: any) {
      ports.logger.warn(`[BatchAnalysis] Seq ${sequenceId}: Failed to load envBLAST file:`, envErr.message);
    }
  }

  const mycoblastQualified = qualifiedHits.length - envBlastQualifiedCount;
  seen.mycomapQualified = mycoblastQualified;
  result.passingObservationRangeContext = buildPassingObservationRangeContext(
    qualifiedHits.map(item => ({
      accession: item.hit.accession,
      speciesName: item.speciesName,
      adjustedIdentity: item.adjustedIdentity,
    })),
    sequenceMap,
  );
  ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: Filtering summary - total=${localResult.hits.length}, qualified=${mycoblastQualified}, envBlastQualified=${envBlastQualifiedCount}, combinedQualified=${qualifiedHits.length}, skipTrash=${debugSkipTrash}, skipLowQuality=${debugSkipLowQuality}, skipNoAdj=${debugSkipNoAdj}, skipLowAdj=${debugSkipLowAdj}, skipNotValidated=${debugSkipNotValidated}, skipSameSpecimen=${sameSpecimenSkipCount}`);

  const nonSelfHits = localResult.hits.length - debugSkipTrash - debugSkipLowQuality - sameSpecimenSkipCount;
  if (localResult.hits.length === 0 || (nonSelfHits <= 0 && localResult.hits.length > 0)) {
    result.noBlastHits = true;
    ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: noBlastHits=true (total=${localResult.hits.length}, nonSelf=${nonSelfHits})`);
  }

  const filteringDetails = [
    `Total MycoBLAST hits: ${localResult.hits.length}`,
    ...(sameSpecimenSkipCount > 0 ? [`Same-specimen hits excluded: ${sameSpecimenSkipCount}`] : []),
    ...(debugSkipLowQuality > 0 ? [`Low Q reference hits retained as context but excluded from deciding evidence: ${debugSkipLowQuality}`] : []),
    `MycoBLAST ${isEdnaSequence ? "qualifying" : "validated"} hits at threshold: ${mycoblastQualified}`,
    ...(isEdnaSequence ? [`envBLAST hits (99%+, excl. self): ${envBlastQualifiedCount}`] : []),
    ...(envBlastQualifiedCount > 0 ? [`Combined qualifying hits: ${qualifiedHits.length}`] : []),
  ];
  if (isEdnaSequence && mycoblastQualified === 0 && localResult.hits.length > 0) {
    const nonTrashNonSelf = localResult.hits.length - debugSkipTrash - sameSpecimenSkipCount;
    if (nonTrashNonSelf > 0) {
      const coverageBelow = localResult.hits.filter(h => {
        const rec = findSequenceRecordForHit(h, sequenceMap);
        if (isTrashReference(rec)) return false;
        if (isExcludedReference(rec)) return false;
        return isEdnaSequence
          ? !meetsEdnaCoverageThreshold(h, localResult.queryLen, ampliconFamily)
          : calculateQueryCover(h, localResult.queryLen) < QUERY_COVERAGE_THRESHOLD;
      }).length;
      const covDesc = isEdnaSequence
        ? `failing coverage threshold (< ${effectiveQueryCoverageThreshold}% QC and < ${COMBINED_COVERAGE_THRESHOLD}% combined QC+SC or QC/SC < ${Math.round(QC_SC_RATIO_THRESHOLD * 100)}%)`
        : `with query coverage < ${effectiveQueryCoverageThreshold}%`;
      filteringDetails.push(`${nonTrashNonSelf} MycoBLAST hits total, ${coverageBelow} ${covDesc}`);
    }
  }
  result.steps[result.steps.length - 1] = {
    step: "Local Hit Analysis - Filtering",
    status: qualifiedHits.length >= MIN_VALIDATED_HITS ? "pass" : "info",
    message: `Found ${qualifiedHits.length} ${isEdnaSequence ? "qualifying" : "validated"} hits with adjusted identity >= ${effectiveIdentityThreshold}%`,
    details: filteringDetails,
  };

  if (isEdnaSequence && mycoblastQualified === 0 && localResult.hits.length > 0) {
    singletonReasons.push(`MycoBLAST: ${localResult.hits.length} hit${localResult.hits.length === 1 ? "" : "s"} returned, but none at >= ${effectiveIdentityThreshold}% adjusted identity`);
  } else if (isEdnaSequence && localResult.hits.length === 0) {
    singletonReasons.push("MycoBLAST: no hits returned");
  }

  if (isEdnaSequence) {
    const queryLen = localResult.queryLen || ncbiResult?.queryLen || 0;

    const rawNonTrashHits = localResult.hits.filter(h => {
      const rec = findSequenceRecordForHit(h, sequenceMap);
      if (isTrashReference(rec)) return false;
      if (isExcludedReference(rec)) return false;
      if (querySourceKey) {
        const isOrigin = String(rec?.id) === String(sequenceId);
        if (isOrigin) return false;
        const hitSrcKey = getHitSourceKey(h, rec || null);
        if (hitSrcKey && hitSrcKey === querySourceKey) return false;
      }
      return true;
    });
    const rawHitsWithCoverage = rawNonTrashHits.map(h => ({
      hit: h,
      queryCoverage: calculateQueryCover(h, localResult.queryLen),
    }));
    const rawLowCoverageCount = rawHitsWithCoverage.filter(h => !meetsEdnaCoverageThreshold(h.hit, localResult.queryLen, ampliconFamily)).length;
    const rawTotalCount = rawHitsWithCoverage.length;

    const rawPassingCount = rawTotalCount - rawLowCoverageCount;
    const isChimera = rawTotalCount > 0 && rawLowCoverageCount === rawTotalCount && queryLen > effectiveChimeraLengthThreshold;

    if (isChimera) {
      addStep({
        step: "Chimeric Sequence Detection (MycoBLAST)",
        status: "fail",
        message: `Likely chimeric sequence — all ${rawTotalCount} MycoBLAST hits fail coverage threshold and query length is ${queryLen}bp (>${effectiveChimeraLengthThreshold}bp)`,
        details: [
          `${rawTotalCount} total MycoBLAST hits (excluding trash/self)`,
          `All ${rawTotalCount} hits fail coverage threshold (< ${effectiveQueryCoverageThreshold}% QC and < ${COMBINED_COVERAGE_THRESHOLD}% combined QC+SC or QC/SC < ${Math.round(QC_SC_RATIO_THRESHOLD * 100)}%)`,
          `Query sequence length: ${queryLen}bp (exceeds ${effectiveChimeraLengthThreshold}bp chimeric threshold)`,
          "This pattern indicates the query sequence is likely a chimeric artifact",
        ],
      });
      result.finalSpecies = ednaIsMultiVariant ? "Likely Chimera" : "Likely Chimera - Singleton Sequence";
      result.finalConfidence = 0;
      result.status = "complete";
      await ports.saveInterimResult(sequenceId, result);
      return result;
    } else if (rawTotalCount > 0) {
      const reasons: string[] = [];
      if (rawPassingCount > 0) {
        reasons.push(`${rawPassingCount}/${rawTotalCount} MycoBLAST hits pass coverage threshold (>= ${effectiveQueryCoverageThreshold}% QC or >= ${COMBINED_COVERAGE_THRESHOLD}% combined QC+SC with QC/SC >= ${Math.round(QC_SC_RATIO_THRESHOLD * 100)}%)`);
        const passingHits = rawHitsWithCoverage.filter(h => meetsEdnaCoverageThreshold(h.hit, localResult.queryLen, ampliconFamily));
        for (const ph of passingHits) {
          const qCov = ph.queryCoverage.toFixed(1);
          const sCov = calculateSubjectCover(ph.hit).toFixed(1);
          const combined = (ph.queryCoverage + calculateSubjectCover(ph.hit)).toFixed(1);
          const species = getSpeciesNameFromHit(ph.hit, sequenceMap, genbankMap, ednaSpeciesIdMap) || "Unknown species";
          reasons.push(`  → ${ph.hit.accession} (${species}) — QC: ${qCov}%, SC: ${sCov}%, Combined: ${combined}%`);
        }
      }
      if (queryLen <= effectiveChimeraLengthThreshold) {
        reasons.push(`Query length ${queryLen}bp does not exceed ${effectiveChimeraLengthThreshold}bp chimeric threshold`);
      }
      reasons.push(`${rawLowCoverageCount}/${rawTotalCount} hits fail coverage threshold`);
      addStep({
        step: "Chimeric Sequence Detection (MycoBLAST)",
        status: "pass",
        message: `Not chimeric — ${rawPassingCount}/${rawTotalCount} MycoBLAST hits pass coverage, query length ${queryLen}bp`,
        details: reasons,
      });
    }

    const beforeFilter = qualifiedHits.length;
    const removed = qualifiedHits.filter(h => !meetsEdnaCoverageThreshold(h.hit, localResult.queryLen, ampliconFamily));
    if (removed.length > 0) {
      const kept = qualifiedHits.filter(h => meetsEdnaCoverageThreshold(h.hit, localResult.queryLen, ampliconFamily));
      qualifiedHits.length = 0;
      qualifiedHits.push(...kept);
      const newEnvCount = qualifiedHits.filter(h => h.speciesName === null && h.isValidated).length;
      envBlastQualifiedCount = newEnvCount;
      ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: eDNA query coverage filter removed ${removed.length}/${beforeFilter} hits (kept ${qualifiedHits.length})`);
      if (qualifiedHits.length === 0) {
        singletonReasons.push(`MycoBLAST: ${removed.length} hit${removed.length === 1 ? "" : "s"} at >= ${effectiveIdentityThreshold}% identity, but none met coverage threshold (>= ${effectiveQueryCoverageThreshold}% QC or >= ${COMBINED_COVERAGE_THRESHOLD}% combined QC+SC with QC/SC >= ${Math.round(QC_SC_RATIO_THRESHOLD * 100)}%)`);
      }
    }
  }

  const insufficientLocalHits = isEdnaSequence
    ? qualifiedHits.length === 0
    : qualifiedHits.length < MIN_VALIDATED_HITS;

  if (insufficientLocalHits) {
    addStep({
      step: "Local Hit Analysis - Minimum Hits",
      status: "info",
      message: isEdnaSequence
        ? `No MycoBLAST hits at >= ${effectiveIdentityThreshold}% adjusted identity — skipping MycoBLAST consensus`
        : `Insufficient MycoBLAST validated hits - found ${qualifiedHits.length}, need at least ${MIN_VALIDATED_HITS}`,
      details: [
        isEdnaSequence
          ? `0 hits found at >= ${effectiveIdentityThreshold}% adjusted identity in MycoBLAST`
          : `Only ${qualifiedHits.length} validated record${qualifiedHits.length === 1 ? " was" : "s were"} found at >= ${effectiveIdentityThreshold}% adjusted identity`,
        ...(isEdnaSequence ? [] : [`A minimum of ${MIN_VALIDATED_HITS} validated hits is required for MycoBLAST consensus`]),
        "Skipping MycoBLAST-specific steps, proceeding to NCBI consensus...",
      ],
    });
  }

  let localAnalysisAborted = false;
  let localEdnaGenusConsensus: string | null = null;

  if (!insufficientLocalHits) {
    // ===== STEP 3b: QUERY COVERAGE CHECK =====
    addStep({
      step: "Local Hit Analysis - Query Coverage",
      status: "running",
      message: "Checking query coverage of qualified hits...",
    });

    const queryLenForCov = localResult?.queryLen || 0;
    const badCoverageHits = qualifiedHits.filter(
      (h) => isEdnaSequence ? !meetsEdnaCoverageThreshold(h.hit, queryLenForCov, ampliconFamily) : h.queryCoverage < QUERY_COVERAGE_THRESHOLD
    );
    const badCoverageRatio = badCoverageHits.length / qualifiedHits.length;

    if (badCoverageRatio > BAD_COVERAGE_MAJORITY) {
      const covLabel = isEdnaSequence
        ? `coverage threshold (< ${effectiveQueryCoverageThreshold}% QC and < ${COMBINED_COVERAGE_THRESHOLD}% combined QC+SC or QC/SC < ${Math.round(QC_SC_RATIO_THRESHOLD * 100)}%)`
        : `coverage below ${effectiveQueryCoverageThreshold}%`;
      result.steps[result.steps.length - 1] = {
        step: "Local Hit Analysis - Query Coverage",
        status: "fail",
        message: `Query coverage check failed - ${badCoverageHits.length}/${qualifiedHits.length} hits (${(badCoverageRatio * 100).toFixed(0)}%) fail ${covLabel}`,
        details: [
          `${badCoverageHits.length} of ${qualifiedHits.length} qualified hits fail ${covLabel}`,
          `Threshold: > ${(BAD_COVERAGE_MAJORITY * 100).toFixed(0)}% with bad coverage causes skip`,
          "MycoBLAST consensus skipped, proceeding to NCBI consensus...",
        ],
      };
      localAnalysisAborted = true;
    }

    if (!localAnalysisAborted) {
      const goodCoverageHits = qualifiedHits.filter(
        (h) => isEdnaSequence ? meetsEdnaCoverageThreshold(h.hit, queryLenForCov, ampliconFamily) : h.queryCoverage >= QUERY_COVERAGE_THRESHOLD
      );

      result.steps[result.steps.length - 1] = {
        step: "Local Hit Analysis - Query Coverage",
        status: "pass",
        message: `Query coverage check passed - ${goodCoverageHits.length}/${qualifiedHits.length} hits have adequate coverage`,
        details: [
          `${goodCoverageHits.length} hits with query coverage >= ${effectiveQueryCoverageThreshold}%`,
          badCoverageHits.length > 0
            ? `${badCoverageHits.length} hits with poor coverage (excluded from further analysis)`
            : "All qualified hits have adequate coverage",
        ],
      };

      // ===== STEP 3c: CONTAMINANT THRESHOLD CHECK =====
      const contaminantCount = goodCoverageHits.filter((h) => h.isContaminant).length;

      if (isEdnaSequence) {
        addStep({
          step: "Local Hit Analysis - Contaminant Check",
          status: "pass",
          message: contaminantCount > 0
            ? `eDNA - ${contaminantCount} non-target hit(s) excluded from species consensus`
            : "eDNA - no non-target flags found",
        });
      }
      const contaminantRatio = goodCoverageHits.length > 0 ? contaminantCount / goodCoverageHits.length : 0;

      if (!isEdnaSequence && contaminantRatio >= CONTAMINANT_FLAG_THRESHOLD) {
        addStep({
          step: "Local Hit Analysis - Contaminant Check",
          status: "fail",
          message: `Contaminant threshold exceeded - ${contaminantCount}/${goodCoverageHits.length} hits (${(contaminantRatio * 100).toFixed(0)}%) are flagged as contaminants`,
          details: [
            `${contaminantCount} of ${goodCoverageHits.length} qualified hits are flagged as contaminant/non-target`,
            `Threshold: >= ${(CONTAMINANT_FLAG_THRESHOLD * 100).toFixed(0)}% contaminants flags sequence as contaminant`,
            "Sequence flagged as contaminant",
          ],
        });
        result.flaggedContaminant = true;
        noteContaminantLikelyName(result, likelyContaminantNameFromNcbi(ncbiResult.hits, genbankMap, ncbiAdjustedMap, null));
        result.status = "complete";
        return result;
      }

      if (!isEdnaSequence && contaminantRatio >= CONTAMINANT_SKIP_THRESHOLD) {
        result.steps[result.steps.length - 1] = {
          step: "Local Hit Analysis - Contaminant Check",
          status: "skip",
          message: `Contaminant level ambiguous - ${contaminantCount}/${goodCoverageHits.length} hits (${(contaminantRatio * 100).toFixed(0)}%) are flagged`,
          details: [
            `${contaminantCount} of ${goodCoverageHits.length} qualified hits are flagged as contaminant/non-target`,
            `Between ${(CONTAMINANT_SKIP_THRESHOLD * 100).toFixed(0)}% and ${(CONTAMINANT_FLAG_THRESHOLD * 100).toFixed(0)}% - sequence skipped (no result)`,
            "MycoBLAST consensus skipped, proceeding to NCBI consensus...",
          ],
        };
        localAnalysisAborted = true;
      }

      if (!localAnalysisAborted) {
        if (!isEdnaSequence) {
          result.steps[result.steps.length - 1] = {
            step: "Local Hit Analysis - Contaminant Check",
            status: "pass",
            message: contaminantCount > 0
              ? `Contaminant check passed - ${contaminantCount}/${goodCoverageHits.length} hits flagged (below threshold)`
              : `Contaminant check passed - no contaminant flags found`,
            details: [
              contaminantCount > 0
                ? `${contaminantCount} of ${goodCoverageHits.length} hits flagged as contaminant/non-target (${(contaminantRatio * 100).toFixed(0)}%)`
                : "No contaminant/non-target flags found on qualified hits",
              `Threshold: < ${(CONTAMINANT_SKIP_THRESHOLD * 100).toFixed(0)}% - analysis continues`,
            ],
          };
        }

        // ===== STEP 4: MycoBLAST SPECIES CONSENSUS =====
        addStep({
          step: isEdnaSequence ? "MycoBLAST eDNA Consensus" : "MycoBLAST Species Consensus",
          status: "running",
          message: "Analyzing species distribution among qualified MycoBLAST hits...",
        });

        const validHits = goodCoverageHits.filter((h) => !h.isContaminant);
        const speciesValidHits = isEdnaSequence
          ? validHits.filter((h) => h.isValidated)
          : validHits;
        const unverifiedExcluded = validHits.length - speciesValidHits.length;
        const localSpeciesCountsRaw = new Map<string, number>();

        for (const h of speciesValidHits) {
          if (isConsensusVoteName(h.speciesName)) {
            const current = localSpeciesCountsRaw.get(h.speciesName) || 0;
            localSpeciesCountsRaw.set(h.speciesName, current + 1);
          }
        }

        const { normalized: localNormalized } = groupByNormalizedName(localSpeciesCountsRaw);
        const localSortedNormalized = Array.from(localNormalized.entries())
          .sort((a, b) => b[1].count - a[1].count);

        const totalHitsWithSpecies = Array.from(localSpeciesCountsRaw.values()).reduce((a, b) => a + b, 0);
        const hitsWithoutSpecies = speciesValidHits.length - totalHitsWithSpecies;

        const localSpeciesDetails: string[] = [];
        for (const [_key, group] of localSortedNormalized) {
          localSpeciesDetails.push(
            `${group.canonical}: ${group.count}/${totalHitsWithSpecies} (${((group.count / totalHitsWithSpecies) * 100).toFixed(0)}%)`
          );
          if (group.variants.size > 1) {
            for (const [variant, vCount] of group.variants.entries()) {
              if (variant !== group.canonical) {
                localSpeciesDetails.push(`  \u2192 ${variant}: ${vCount} record${vCount !== 1 ? 's' : ''} need name updated`);
              }
            }
          }
        }

        if (isEdnaSequence && speciesValidHits.length > 0) {
          const localCulturedHits = speciesValidHits.filter(h => h.speciesName && !isUnculturedName(h.speciesName));
          if (localCulturedHits.length > 0) {
            const localGenusCounts = new Map<string, number>();
            for (const h of localCulturedHits) {
              const genus = extractGenus(h.speciesName!);
              if (genus) localGenusCounts.set(genus, (localGenusCounts.get(genus) || 0) + 1);
            }
            const sortedLocalGenera = Array.from(localGenusCounts.entries()).sort((a, b) => b[1] - a[1]);
            if (sortedLocalGenera.length > 0) {
              const [topGenus, topGenusCount] = sortedLocalGenera[0];
              const genusRatio = topGenusCount / localCulturedHits.length;
              localSpeciesDetails.push("");
              localSpeciesDetails.push("Genus-level consensus:");
              for (const [genus, count] of sortedLocalGenera) {
                localSpeciesDetails.push(`  ${genus}: ${count}/${localCulturedHits.length} (${((count / localCulturedHits.length) * 100).toFixed(0)}%)`);
              }
              if (genusRatio >= SPECIES_CONSENSUS_THRESHOLD) {
                localEdnaGenusConsensus = topGenus;
              }
            }
          }
        }

        if (localSortedNormalized.length === 0) {
          const noSpeciesDetails = [
            `${speciesValidHits.length} verified hits analyzed but none had recognizable species names`,
            ...(unverifiedExcluded > 0 ? [`${unverifiedExcluded} unverified hit${unverifiedExcluded !== 1 ? 's' : ''} excluded from species consensus`] : []),
            "Unable to determine species consensus from MycoBLAST",
          ];
          result.steps[result.steps.length - 1] = {
            step: isEdnaSequence ? "MycoBLAST eDNA Consensus" : "MycoBLAST Species Consensus",
            status: "fail",
            message: speciesValidHits.length === 0 && unverifiedExcluded > 0
              ? `No verified MycoBLAST hits for species consensus (${unverifiedExcluded} unverified excluded)`
              : "No valid species names found among qualified MycoBLAST hits",
            details: noSpeciesDetails,
          };
        } else {
          // Decide the winning name and whether the determination passes.
          //  - Regular (non-eDNA): tiered iterative consensus (Tier A 100%/100%,
          //    B 99.5%/70%, C 99.35%/70%) with MIN_VALIDATED_HITS as the per-tier
          //    record floor. A perfect match resolves at Tier A; a looser match
          //    drops to Tier B/C; the first passing tier wins.
          //  - eDNA: unchanged single-pass at SPECIES_CONSENSUS_THRESHOLD.
          // Regardless of which tier resolves, the name-agreement penalty in
          // computeConfidenceScore is still computed over the FULL qualifying pool
          // (localConsensusCount / totalHitsWithSpecies below), so the tier's
          // agreement gate and the separate name-agreement penalty don't
          // double-count or contradict each other.
          let determinationPassed: boolean;
          let winnerCanonical: string;
          let regularConsensus: IterativeConsensusResult | null = null;

          let winnerKey: string | null = null;
          let specimenNote: string | null = null;
          if (!isEdnaSequence) {
            const regularEntries = localConsensusEntries(speciesValidHits);
            specimenNote = specimenVoteNote(totalHitsWithSpecies, regularEntries.length);
            regularConsensus = iterativeBinomialConsensus(regularEntries, REGULAR_CONSENSUS_TIERS);
            determinationPassed = regularConsensus.tier !== null && !!regularConsensus.topCanonical;
            winnerCanonical = regularConsensus.topCanonical ?? localSortedNormalized[0][1].canonical;
            winnerKey = regularConsensus.topKey;
          } else {
            const localTopEntry = localSortedNormalized[0];
            winnerCanonical = localTopEntry[1].canonical;
            winnerKey = localTopEntry[0];
            determinationPassed = (localTopEntry[1].count / totalHitsWithSpecies) >= SPECIES_CONSENSUS_THRESHOLD;
          }

          // Full-pool stats for the winning name (independent of the resolved tier).
          // Match by the normalized-group key (stable across subsets); fall back to
          // canonical string, then to the full-pool top.
          const fullPoolEntry =
            (winnerKey ? localSortedNormalized.find(([k]) => k === winnerKey) : undefined) ??
            localSortedNormalized.find(([_k, g]) => g.canonical === winnerCanonical) ??
            localSortedNormalized[0];
          const localTopCanonical = fullPoolEntry[1].canonical;
          const localTopCount = fullPoolEntry[1].count;
          const localTopRatio = totalHitsWithSpecies > 0 ? localTopCount / totalHitsWithSpecies : 0;

          result.localConsensusSpecies = localTopCanonical;
          result.localConsensusCount = localTopCount;
          result.localConsensusTotalWithSpecies = totalHitsWithSpecies;
          result.localConsensusThreshold = effectiveIdentityThreshold;

          const nameUpdateDetails: string[] = [];
          if (fullPoolEntry[1].variants.size > 1) {
            for (const [variant, vCount] of fullPoolEntry[1].variants.entries()) {
              if (variant !== localTopCanonical) {
                nameUpdateDetails.push(`${variant}: ${vCount} record${vCount !== 1 ? 's' : ''} need name updated to ${localTopCanonical}`);
              }
            }
          }

          if (determinationPassed) {
            const hasNameUpdates = nameUpdateDetails.length > 0;
            const otherDetails = localSortedNormalized
              .filter(([_k, group]) => group.canonical !== localTopCanonical)
              .map(([_key, group]) =>
                `Other: ${group.canonical}: ${group.count}/${totalHitsWithSpecies} (${((group.count / totalHitsWithSpecies) * 100).toFixed(0)}%)`
              );
            if (!isEdnaSequence && regularConsensus) {
              result.steps[result.steps.length - 1] = {
                step: "MycoBLAST Species Consensus",
                status: hasNameUpdates ? "skip" : "pass",
                message: hasNameUpdates
                  ? `MycoBLAST consensus: ${localTopCanonical} (name updates needed) — Tier ${regularConsensus.tier}`
                  : `MycoBLAST consensus: ${localTopCanonical} — Tier ${regularConsensus.tier}`,
                details: [
                  "Iterative consensus tiers:",
                  ...formatTierAttempts(regularConsensus.attempts),
                  `→ Resolved at ${regularConsensus.annotation}`,
                  ...(specimenNote ? [specimenNote] : []),
                  `Chosen tier: ${localTopCanonical} ${regularConsensus.topCount}/${regularConsensus.total} (${(regularConsensus.ratio * 100).toFixed(0)}%)`,
                  ...(unverifiedExcluded > 0 ? [`${unverifiedExcluded} unverified hit${unverifiedExcluded !== 1 ? 's' : ''} excluded from species consensus`] : []),
                  ...(hitsWithoutSpecies > 0 ? [`${hitsWithoutSpecies} hit${hitsWithoutSpecies > 1 ? 's' : ''} had no species name, or one above genus such as Fungi (excluded from consensus calculation)`] : []),
                  ...nameUpdateDetails,
                  ...otherDetails,
                ],
              };
            } else {
              result.steps[result.steps.length - 1] = {
                step: isEdnaSequence ? "MycoBLAST eDNA Consensus" : "MycoBLAST Species Consensus",
                status: hasNameUpdates ? "skip" : "pass",
                message: hasNameUpdates
                  ? `MycoBLAST consensus: ${localTopCanonical} (name updates needed)`
                  : `MycoBLAST consensus: ${localTopCanonical}`,
                details: [
                  `${localTopCanonical}: ${localTopCount}/${totalHitsWithSpecies} hits with species (${(localTopRatio * 100).toFixed(0)}%)`,
                  `Threshold: >= ${(SPECIES_CONSENSUS_THRESHOLD * 100).toFixed(0)}% agreement required`,
                  ...(unverifiedExcluded > 0 ? [`${unverifiedExcluded} unverified hit${unverifiedExcluded !== 1 ? 's' : ''} excluded from species consensus`] : []),
                  ...(hitsWithoutSpecies > 0 ? [`${hitsWithoutSpecies} hit${hitsWithoutSpecies > 1 ? 's' : ''} had no species name, or one above genus such as Fungi (excluded from consensus calculation)`] : []),
                  ...nameUpdateDetails,
                  ...otherDetails,
                ],
              };
            }
            result.finalSpecies = localTopCanonical;

            const lowIdLocalMatches: { accession: string; identity: number; speciesName: string; excludeReason?: string }[] = [];
            const highIdLocalObservations = new Set<string>();
            for (const hit of localResult.hits) {
              const adjId = localAdjustedMap[hit.num];
              if (adjId === undefined || adjId < effectiveLowIdThreshold) continue;
              const seqRec = findSequenceRecordForHit(hit, sequenceMap);
              if (isTrashReference(seqRec) || isExcludedReference(seqRec)) continue;
              if (seqRec?.observationId) {
                const hitSpecies = getSpeciesNameFromHit(hit, sequenceMap, genbankMap, ednaSpeciesIdMap);
                if (hitSpecies && speciesNamesMatch(hitSpecies, localTopCanonical)) {
                  highIdLocalObservations.add(String(seqRec.observationId));
                }
              }
            }
            for (const hit of localResult.hits) {
              const adjId = localAdjustedMap[hit.num];
              if (adjId === undefined) continue;
              if (adjId >= effectiveLowIdThreshold) continue;
              const hitSpecies = getSpeciesNameFromHit(hit, sequenceMap, genbankMap, ednaSpeciesIdMap);
              if (hitSpecies && speciesNamesMatch(hitSpecies, localTopCanonical)) {
                const seqRec = findSequenceRecordForHit(hit, sequenceMap);
                  if (isTrashReference(seqRec) || isExcludedReference(seqRec)) continue;
                let excludeReason: string | undefined;
                if (seqRec?.observationId && highIdLocalObservations.has(String(seqRec.observationId))) {
                  excludeReason = "specimen also has high-ID hit";
                } else if (!isHitValidated(hit, sequenceMap, genbankMap)) {
                  excludeReason = "observation not validated";
                }
                lowIdLocalMatches.push({
                  accession: hit.accession,
                  identity: Math.round(adjId * 100) / 100,
                  speciesName: hitSpecies,
                  excludeReason,
                });
              }
            }

            const countingMatches = lowIdLocalMatches.filter(m => !m.excludeReason);
            const excludedByHighId = lowIdLocalMatches.filter(m => m.excludeReason === "specimen also has high-ID hit").length;
            const excludedByValidation = lowIdLocalMatches.filter(m => m.excludeReason === "observation not validated").length;
            const totalExcluded = excludedByHighId + excludedByValidation;

            const excludeDetails: string[] = [];
            if (excludedByHighId > 0) excludeDetails.push(`${excludedByHighId} excluded (specimen also has high-ID hit)`);
            if (excludedByValidation > 0) excludeDetails.push(`${excludedByValidation} excluded (observation not validated)`);

            if (countingMatches.length > 0) {
              addStep({
                step: "MycoBLAST Low-Identity Name Check",
                status: "info",
                message: `"${localTopCanonical}" also found in ${countingMatches.length} validated hit${countingMatches.length !== 1 ? 's' : ''} below ${effectiveLowIdThreshold}% adjusted identity`,
                details: [
                  `Species name appears at both high (>= ${effectiveIdentityThreshold}%) and low (< ${effectiveLowIdThreshold}%) identity levels`,
                  ...countingMatches.slice(0, 10).map(m => `${m.accession}: ${m.identity}% adjusted identity`),
                  ...(countingMatches.length > 10 ? [`... and ${countingMatches.length - 10} more`] : []),
                  ...excludeDetails,
                  "Low-identity occurrences will reduce confidence score",
                ],
              });
            } else if (totalExcluded > 0) {
              addStep({
                step: "MycoBLAST Low-Identity Name Check",
                status: "pass",
                message: `"${localTopCanonical}" found in ${totalExcluded} hit${totalExcluded !== 1 ? 's' : ''} below ${effectiveLowIdThreshold}%, but all excluded`,
                details: [
                  ...excludeDetails,
                  "Confidence unaffected",
                ],
              });
            } else {
              addStep({
                step: "MycoBLAST Low-Identity Name Check",
                status: "pass",
                message: `"${localTopCanonical}" not found below ${effectiveLowIdThreshold}% adjusted identity`,
                details: [
                  "No same-species hits at low identity - confidence unaffected",
                ],
              });
            }
          } else if (!isEdnaSequence && regularConsensus) {
            result.steps[result.steps.length - 1] = {
              step: "MycoBLAST Species Consensus",
              status: "fail",
              message: regularConsensus.topCanonical
                ? `No MycoBLAST consensus across tiers A/B/C — top: ${regularConsensus.topCanonical} (${(regularConsensus.ratio * 100).toFixed(0)}%)`
                : "No MycoBLAST consensus — no qualifying hits across tiers A/B/C",
              details: [
                "Iterative consensus tiers:",
                ...formatTierAttempts(regularConsensus.attempts),
                `→ ${regularConsensus.annotation}`,
                ...(specimenNote ? [specimenNote] : []),
                ...(unverifiedExcluded > 0 ? [`${unverifiedExcluded} unverified hit${unverifiedExcluded !== 1 ? 's' : ''} excluded from species consensus`] : []),
                ...(hitsWithoutSpecies > 0 ? [`${hitsWithoutSpecies} hit${hitsWithoutSpecies > 1 ? 's' : ''} had no species name, or one above genus such as Fungi (excluded from consensus calculation)`] : []),
                ...localSpeciesDetails,
              ],
            };
          } else {
            result.steps[result.steps.length - 1] = {
              step: isEdnaSequence ? "MycoBLAST eDNA Consensus" : "MycoBLAST Species Consensus",
              status: "fail",
              message: `No MycoBLAST consensus - top species "${localTopCanonical}" at ${(localTopRatio * 100).toFixed(0)}% (needs ${(SPECIES_CONSENSUS_THRESHOLD * 100).toFixed(0)}%)`,
              details: [
                `No single species reached the ${(SPECIES_CONSENSUS_THRESHOLD * 100).toFixed(0)}% threshold among hits with species names`,
                ...(unverifiedExcluded > 0 ? [`${unverifiedExcluded} unverified hit${unverifiedExcluded !== 1 ? 's' : ''} excluded from species consensus`] : []),
                ...(hitsWithoutSpecies > 0 ? [`${hitsWithoutSpecies} hit${hitsWithoutSpecies > 1 ? 's' : ''} had no species name, or one above genus such as Fungi (excluded from consensus calculation)`] : []),
                ...localSpeciesDetails,
              ],
            };
          }
        }
      }
    }
  }

  // ===== MycoBLAST BINOMIAL CONSENSUS (eDNA only) =====
  // Parallel consensus that IGNORES env-code overlays, surfacing the underlying
  // canonical binomial. Used to auto-map env codes → real species when evidence
  // is strong enough (Path A: NCBI agrees; Path B: >=80% MycoBLAST binomial agreement).
  if (isEdnaSequence && localResult && localResult.hits.length > 0) {
    addStep({
      step: "MycoBLAST Species Consensus",
      status: "running",
      message: "Computing parallel binomial consensus (ignoring env-code overlays)...",
    });

    const binomialEntries: { binomial: string; adjIdentity: number }[] = [];
    let excludedEnvCode = 0;
    let excludedNonBinomial = 0;
    let excludedUncultured = 0;

    for (const hit of localResult.hits) {
      const seqRecord = findSequenceRecordForHit(hit, sequenceMap);
      if (isTrashReference(seqRecord)) continue;
      if (isExcludedReference(seqRecord)) continue;
      if (querySourceKey) {
        const isOrigin = String(seqRecord?.id) === String(sequenceId);
        if (isOrigin) continue;
        const hitSourceKey = getHitSourceKey(hit, seqRecord || null);
        if (hitSourceKey && hitSourceKey === querySourceKey) continue;
      }
      const adjIdentity = localAdjustedMap[hit.num];
      if (adjIdentity === undefined || adjIdentity < EDNA_ADJUSTED_IDENTITY_THRESHOLD) continue;
      if (!meetsEdnaCoverageThreshold(hit, localResult.queryLen, ampliconFamily)) continue;
      if (!isHitValidated(hit, sequenceMap, genbankMap)) continue;
      const flags = seqRecord?.flags || [];
      if (isContaminantFlag(flags)) continue;

      const binomial = getBinomialSpeciesNameFromHit(hit, sequenceMap, genbankMap);
      if (!binomial) continue;
      if (isUnculturedName(binomial)) { excludedUncultured++; continue; }
      if (isEnvCodeName(binomial)) { excludedEnvCode++; continue; }
      if (!isBinomialName(binomial)) { excludedNonBinomial++; continue; }

      binomialEntries.push({ binomial, adjIdentity });
    }

    const consensus = iterativeBinomialConsensus(binomialEntries);
    const exclusionTail: string[] = [];
    if (excludedEnvCode > 0) exclusionTail.push(`(${excludedEnvCode} env-coded hit(s) excluded)`);
    if (excludedUncultured > 0) exclusionTail.push(`(${excludedUncultured} uncultured hit(s) excluded)`);
    if (excludedNonBinomial > 0) exclusionTail.push(`(${excludedNonBinomial} non-binomial hit(s) excluded)`);

    if (binomialEntries.length === 0) {
      result.steps[result.steps.length - 1] = {
        step: "MycoBLAST Species Consensus",
        status: "info",
        message: "No qualifying MycoBLAST binomial hits found",
        details: [
          `Filters: >= ${EDNA_ADJUSTED_IDENTITY_THRESHOLD}% adjusted identity, validated, non-contaminant, real binomial`,
          ...(excludedEnvCode > 0 ? [`${excludedEnvCode} hit(s) excluded as env codes`] : []),
          ...(excludedUncultured > 0 ? [`${excludedUncultured} hit(s) excluded as uncultured`] : []),
          ...(excludedNonBinomial > 0 ? [`${excludedNonBinomial} hit(s) excluded as non-binomial`] : []),
        ],
      };
    } else {
      const winningSorted = consensus.sorted;
      const winningTotal = consensus.total;
      const details: string[] = [];
      details.push("Iterative consensus tiers:");
      details.push(...formatTierAttempts(consensus.attempts));
      details.push(consensus.tier ? `→ Resolved at ${consensus.annotation}` : `→ ${consensus.annotation}`);
      if (winningSorted.length > 0 && winningTotal > 0) {
        details.push(`Breakdown at chosen tier (≥${consensus.identityThreshold}% identity):`);
        for (const [_k, g] of winningSorted) {
          details.push(`  ${g.canonical}: ${g.count}/${winningTotal} (${((g.count / winningTotal) * 100).toFixed(0)}%)`);
        }
      }
      details.push(...exclusionTail);

      // Populate top-candidate fields whenever there is one (matches pre-tier behavior
      // so downstream Path A/B mapping that uses >=2 hit thresholds keeps working).
      // Status "pass" still requires a tier to win.
      if (consensus.topCanonical && consensus.total > 0) {
        result.localBinomialConsensus = consensus.topCanonical;
        result.localBinomialCount = consensus.topCount;
        result.localBinomialTotal = consensus.total;
      }

      result.steps[result.steps.length - 1] = {
        step: "MycoBLAST Species Consensus",
        status: consensus.tier ? "pass" : "info",
        message: consensus.tier
          ? `Top binomial: ${consensus.topCanonical} (${consensus.topCount}/${consensus.total}, ${(consensus.ratio * 100).toFixed(0)}%) — Tier ${consensus.tier}`
          : (consensus.topCanonical
              ? `No binomial consensus — top: ${consensus.topCanonical} (${(consensus.ratio * 100).toFixed(0)}%); tried tiers A/B/C`
              : "No binomial consensus — no qualifying hits across tiers A/B/C"),
        details,
      };
    }
  }

  // ===== NCBI CHIMERA CHECK (eDNA) =====
  if (isEdnaSequence && ncbiResult && ncbiResult.hits.length > 0 && !result.finalSpecies) {
    const ncbiQueryLen = ncbiResult.queryLen || (localResult?.queryLen || 0);
    const ncbiHitsWithCoverage = ncbiResult.hits.map(h => ({
      hit: h,
      queryCoverage: calculateQueryCover(h, ncbiQueryLen),
    }));
    const ncbiLowCoverageCount = ncbiHitsWithCoverage.filter(h => !meetsEdnaCoverageThreshold(h.hit, ncbiQueryLen, ampliconFamily)).length;
    const ncbiTotalForChimera = ncbiHitsWithCoverage.length;

    const ncbiPassingCount = ncbiTotalForChimera - ncbiLowCoverageCount;
    const isNcbiChimera = ncbiTotalForChimera > 0 && ncbiLowCoverageCount === ncbiTotalForChimera && ncbiQueryLen > effectiveChimeraLengthThreshold;

    if (isNcbiChimera) {
      addStep({
        step: "Chimeric Sequence Detection (NCBI)",
        status: "fail",
        message: `Likely chimeric sequence — all ${ncbiTotalForChimera} NCBI hits fail coverage threshold and query length is ${ncbiQueryLen}bp (>${effectiveChimeraLengthThreshold}bp)`,
        details: [
          `${ncbiTotalForChimera} total NCBI hits`,
          `All ${ncbiTotalForChimera} hits fail coverage threshold (< ${effectiveQueryCoverageThreshold}% QC and < ${COMBINED_COVERAGE_THRESHOLD}% combined QC+SC or QC/SC < ${Math.round(QC_SC_RATIO_THRESHOLD * 100)}%)`,
          `Query sequence length: ${ncbiQueryLen}bp (exceeds ${effectiveChimeraLengthThreshold}bp chimeric threshold)`,
          "This pattern indicates the query sequence is likely a chimeric artifact",
        ],
      });
      result.finalSpecies = ednaIsMultiVariant ? "Likely Chimera" : "Likely Chimera - Singleton Sequence";
      result.finalConfidence = 0;
      result.status = "complete";
      await ports.saveInterimResult(sequenceId, result);
      return result;
    } else {
      const ncbiReasons: string[] = [];
      if (ncbiPassingCount > 0) {
        ncbiReasons.push(`${ncbiPassingCount}/${ncbiTotalForChimera} NCBI hits pass coverage threshold (>= ${effectiveQueryCoverageThreshold}% QC or >= ${COMBINED_COVERAGE_THRESHOLD}% combined QC+SC with QC/SC >= ${Math.round(QC_SC_RATIO_THRESHOLD * 100)}%)`);
        const ncbiPassingHits = ncbiHitsWithCoverage.filter(h => meetsEdnaCoverageThreshold(h.hit, ncbiQueryLen, ampliconFamily));
        for (const ph of ncbiPassingHits) {
          const qCov = ph.queryCoverage.toFixed(1);
          const sCov = calculateSubjectCover(ph.hit).toFixed(1);
          const combined = (ph.queryCoverage + calculateSubjectCover(ph.hit)).toFixed(1);
          const species = extractSpeciesName(ph.hit.def) || "Unknown species";
          ncbiReasons.push(`  → ${ph.hit.accession} (${species}) — QC: ${qCov}%, SC: ${sCov}%, Combined: ${combined}%`);
        }
      }
      if (ncbiQueryLen <= effectiveChimeraLengthThreshold) {
        ncbiReasons.push(`Query length ${ncbiQueryLen}bp does not exceed ${effectiveChimeraLengthThreshold}bp chimeric threshold`);
      }
      ncbiReasons.push(`${ncbiLowCoverageCount}/${ncbiTotalForChimera} hits fail coverage threshold`);
      addStep({
        step: "Chimeric Sequence Detection (NCBI)",
        status: "pass",
        message: `Not chimeric — ${ncbiPassingCount}/${ncbiTotalForChimera} NCBI hits pass coverage, query length ${ncbiQueryLen}bp`,
        details: ncbiReasons,
      });
    }
  }

  // ===== STEP 5: NCBI SPECIES CONSENSUS =====
  addStep({
    step: isEdnaSequence ? "NCBI eDNA Consensus" : "NCBI Species Consensus",
    status: "running",
    message: "Analyzing species distribution among NCBI hits with high adjusted identity...",
  });

  const ncbiQualifiedHits: { hit: BlastHit; speciesName: string; usedAdjusted: boolean; identity: number }[] = [];
  let ncbiAdjustedCount = 0;
  let ncbiRawFallbackCount = 0;

  for (const hit of ncbiResult.hits) {
    let speciesName: string | null = null;
    if (ednaSpeciesIdMap && ednaSpeciesIdMap[hit.accession]) {
      speciesName = ednaSpeciesIdMap[hit.accession];
    } else if (genbankMap[hit.accession]) {
      const meta = genbankMap[hit.accession];
      speciesName = (meta.scientificName || meta.organism || null) as string | null;
    }
    if (!speciesName) {
      speciesName = extractSpeciesName(hit.def);
    }
    if (!isConsensusVoteName(speciesName)) continue;

    if (isEdnaSequence) {
      if (!meetsEdnaCoverageThreshold(hit, ncbiResult.queryLen, ampliconFamily)) continue;
    }

    const adjIdentity = ncbiAdjustedMap[hit.num];
    if (adjIdentity !== undefined) {
      if (adjIdentity < effectiveIdentityThreshold) continue;
      ncbiAdjustedCount++;
      ncbiQualifiedHits.push({ hit, speciesName, usedAdjusted: true, identity: adjIdentity });
    } else {
      const hsp = hit.hsps[0];
      if (!hsp) continue;
      const rawIdentity = hsp.alignLen > 0 ? (hsp.identity / hsp.alignLen) * 100 : 0;
      if (rawIdentity < effectiveIdentityThreshold) continue;
      ncbiRawFallbackCount++;
      ncbiQualifiedHits.push({ hit, speciesName, usedAdjusted: false, identity: rawIdentity });
    }
  }

  if (isEdnaSequence && ncbiQualifiedHits.length === 0 && ncbiResult.hits.length > 0) {
    const ncbiCovFails = ncbiResult.hits.filter(h => !meetsEdnaCoverageThreshold(h, ncbiResult.queryLen, ampliconFamily)).length;
    if (ncbiCovFails > 0) {
      singletonReasons.push(`NCBI: ${ncbiResult.hits.length} hit${ncbiResult.hits.length === 1 ? "" : "s"} returned, but none met both identity (>= ${effectiveIdentityThreshold}%) and coverage (>= ${effectiveQueryCoverageThreshold}% QC or >= ${COMBINED_COVERAGE_THRESHOLD}% combined) thresholds`);
    } else {
      singletonReasons.push(`NCBI: ${ncbiResult.hits.length} hit${ncbiResult.hits.length === 1 ? "" : "s"} returned, but none at >= ${effectiveIdentityThreshold}% adjusted identity`);
    }
  } else if (isEdnaSequence && ncbiResult.hits.length === 0) {
    singletonReasons.push("NCBI: no hits returned");
  }

  const ncbiCulturedHitsForConsensus = ncbiQualifiedHits.filter(h => !isUnculturedName(h.speciesName));
  const ncbiUnculturedHitsForConsensus = ncbiQualifiedHits.filter(h => isUnculturedName(h.speciesName));

  const ncbiSpeciesCountsRaw = new Map<string, number>();
  for (const h of ncbiCulturedHitsForConsensus) {
    const current = ncbiSpeciesCountsRaw.get(h.speciesName) || 0;
    ncbiSpeciesCountsRaw.set(h.speciesName, current + 1);
  }

  const { normalized: ncbiNormalized } = groupByNormalizedName(ncbiSpeciesCountsRaw);
  const ncbiSortedNormalized = Array.from(ncbiNormalized.entries())
    .sort((a, b) => b[1].count - a[1].count);
  const ncbiTotalWithSpecies = ncbiCulturedHitsForConsensus.length;

  const ncbiSpeciesDetails: string[] = [];
  for (const [_key, group] of ncbiSortedNormalized) {
    ncbiSpeciesDetails.push(
      `${group.canonical}: ${group.count}/${ncbiTotalWithSpecies} (${((group.count / ncbiTotalWithSpecies) * 100).toFixed(0)}%)`
    );
    if (group.variants.size > 1) {
      for (const [variant, vCount] of group.variants.entries()) {
        if (variant !== group.canonical) {
          ncbiSpeciesDetails.push(`  \u2192 ${variant}: ${vCount} record${vCount !== 1 ? 's' : ''} need name updated`);
        }
      }
    }
  }

  if (ncbiUnculturedHitsForConsensus.length > 0) {
    ncbiSpeciesDetails.push("");
    ncbiSpeciesDetails.push(`Uncultured records excluded from consensus (${ncbiUnculturedHitsForConsensus.length}):`);
    const unculturedCounts = new Map<string, number>();
    for (const h of ncbiUnculturedHitsForConsensus) {
      unculturedCounts.set(h.speciesName, (unculturedCounts.get(h.speciesName) || 0) + 1);
    }
    const sortedUncultured = Array.from(unculturedCounts.entries()).sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sortedUncultured) {
      ncbiSpeciesDetails.push(`  ${name}: ${count}`);
    }
  }

  let ncbiEdnaGenusConsensus: string | null = null;
  if (isEdnaSequence && ncbiQualifiedHits.length > 0) {
    const ncbiCulturedHits = ncbiQualifiedHits.filter(h => !isUnculturedName(h.speciesName));
    if (ncbiCulturedHits.length > 0) {
      const ncbiGenusCounts = new Map<string, number>();
      for (const h of ncbiCulturedHits) {
        const genus = extractGenus(h.speciesName);
        if (genus) ncbiGenusCounts.set(genus, (ncbiGenusCounts.get(genus) || 0) + 1);
      }
      const sortedNcbiGenera = Array.from(ncbiGenusCounts.entries()).sort((a, b) => b[1] - a[1]);
      if (sortedNcbiGenera.length > 0) {
        const [topGenus, topGenusCount] = sortedNcbiGenera[0];
        const genusRatio = topGenusCount / ncbiCulturedHits.length;
        ncbiSpeciesDetails.push("");
        ncbiSpeciesDetails.push("Genus-level consensus (excluding uncultured):");
        for (const [genus, count] of sortedNcbiGenera) {
          ncbiSpeciesDetails.push(`  ${genus}: ${count}/${ncbiCulturedHits.length} (${((count / ncbiCulturedHits.length) * 100).toFixed(0)}%)`);
        }
        if (genusRatio >= SPECIES_CONSENSUS_THRESHOLD) {
          ncbiEdnaGenusConsensus = topGenus;
        }
      }
    }
  }

  const identityLabel = isEdnaSequence
    ? "adjusted"
    : ncbiAdjustedCount > 0
      ? (ncbiRawFallbackCount > 0 ? "adjusted/raw" : "adjusted")
      : "raw";

  if (ncbiSortedNormalized.length === 0) {
    result.steps[result.steps.length - 1] = {
      step: isEdnaSequence ? "NCBI eDNA Consensus" : "NCBI Species Consensus",
      status: "info",
      message: `No NCBI hits found at >= ${effectiveIdentityThreshold}% ${identityLabel} identity with valid species names (excluding uncultured)`,
      details: [
        `${ncbiResult.hits.length} total NCBI hits checked`,
        `Filtered by ${identityLabel} identity >= ${effectiveIdentityThreshold}%`,
        ...(ncbiUnculturedHitsForConsensus.length > 0 ? [`${ncbiUnculturedHitsForConsensus.length} uncultured records excluded`] : []),
        ...(ncbiRawFallbackCount > 0 ? [`${ncbiRawFallbackCount} hits used raw identity (adjusted not available)`] : []),
      ],
    };
  } else {
    const ncbiTopEntry = ncbiSortedNormalized[0];
    const ncbiTopCanonical = ncbiTopEntry[1].canonical;
    const ncbiTopCount = ncbiTopEntry[1].count;
    const ncbiTopRatio = ncbiTopCount / ncbiTotalWithSpecies;

    result.ncbiConsensusSpecies = ncbiTopCanonical;
    result.ncbiConsensusCount = ncbiTopCount;
    result.ncbiConsensusTotalWithSpecies = ncbiTotalWithSpecies;
    result.ncbiConsensusThreshold = effectiveIdentityThreshold;

    result.steps[result.steps.length - 1] = {
      step: isEdnaSequence ? "NCBI eDNA Consensus" : "NCBI Species Consensus",
      status: (ncbiTopRatio >= SPECIES_CONSENSUS_THRESHOLD || (isEdnaSequence && ncbiEdnaGenusConsensus)) ? "pass" : "info",
      message: ncbiTopRatio >= SPECIES_CONSENSUS_THRESHOLD
        ? `NCBI top species: ${ncbiTopCanonical} (${ncbiTopCount}/${ncbiTotalWithSpecies} at >= ${effectiveIdentityThreshold}% ${identityLabel} identity)`
        : (isEdnaSequence && ncbiEdnaGenusConsensus
          ? `No NCBI species consensus (excluding uncultured) — Genus consensus: ${ncbiEdnaGenusConsensus}`
          : `NCBI top species: ${ncbiTopCanonical} (${ncbiTopCount}/${ncbiTotalWithSpecies} at >= ${effectiveIdentityThreshold}% ${identityLabel} identity)`),
      details: [
        ...ncbiSpeciesDetails,
        `Filtered by ${identityLabel} identity >= ${effectiveIdentityThreshold}%`,
        ...(ncbiRawFallbackCount > 0 ? [`${ncbiRawFallbackCount} hits used raw identity (adjusted not available)`] : []),
      ],
    };

    if (ncbiTopRatio >= SPECIES_CONSENSUS_THRESHOLD) {
      const lowIdNcbiMatches: { accession: string; identity: number }[] = [];
      for (const hit of ncbiResult.hits) {
        const adjId = ncbiAdjustedMap[hit.num];
        let hitIdentity: number | null = null;
        if (adjId !== undefined) {
          hitIdentity = adjId;
        } else {
          const hsp = hit.hsps[0];
          if (hsp && hsp.alignLen > 0) {
            hitIdentity = (hsp.identity / hsp.alignLen) * 100;
          }
        }
        if (hitIdentity === null || hitIdentity >= effectiveLowIdThreshold) continue;

        let hitSpecies: string | null = null;
        if (ednaSpeciesIdMap && ednaSpeciesIdMap[hit.accession]) {
          hitSpecies = ednaSpeciesIdMap[hit.accession];
        } else if (genbankMap[hit.accession]) {
          const meta = genbankMap[hit.accession];
          hitSpecies = (meta.scientificName || meta.organism || null) as string | null;
        }
        if (!hitSpecies) {
          hitSpecies = extractSpeciesName(hit.def);
        }
        if (hitSpecies && speciesNamesMatch(hitSpecies, ncbiTopCanonical)) {
          lowIdNcbiMatches.push({
            accession: hit.accession,
            identity: Math.round(hitIdentity * 100) / 100,
          });
        }
      }

      if (lowIdNcbiMatches.length > 0) {
        addStep({
          step: "NCBI Low-Identity Name Check",
          status: "info",
          message: `"${ncbiTopCanonical}" also found in ${lowIdNcbiMatches.length} NCBI hit${lowIdNcbiMatches.length > 1 ? 's' : ''} below ${effectiveLowIdThreshold}% identity`,
          details: [
            `Species name appears at both high (>= ${effectiveIdentityThreshold}%) and low (< ${effectiveLowIdThreshold}%) identity levels in NCBI results`,
            ...lowIdNcbiMatches.slice(0, 10).map(m => `${m.accession}: ${m.identity}% identity`),
            ...(lowIdNcbiMatches.length > 10 ? [`... and ${lowIdNcbiMatches.length - 10} more`] : []),
            "Low-identity NCBI occurrences noted for confidence scoring",
          ],
        });
      }
    }
  }

  // ===== NCBI BINOMIAL CONSENSUS (eDNA only) =====
  // Mirror of MycoBLAST Species Consensus — uses ncbiQualifiedHits but
  // ignores env-code overlays so underlying binomial can be surfaced.
  if (isEdnaSequence && ncbiQualifiedHits.length > 0) {
    addStep({
      step: "NCBI Species Consensus",
      status: "running",
      message: "Computing parallel NCBI binomial consensus (ignoring env-code overlays)...",
    });

    const ncbiBinomialEntries: { binomial: string; adjIdentity: number }[] = [];
    let ncbiExcludedEnvCode = 0;
    let ncbiExcludedUncultured = 0;
    let ncbiExcludedNonBinomial = 0;

    for (const h of ncbiQualifiedHits) {
      const binomial = getBinomialSpeciesNameFromHit(h.hit, sequenceMap, genbankMap);
      if (!binomial) continue;
      if (isUnculturedName(binomial)) { ncbiExcludedUncultured++; continue; }
      if (isEnvCodeName(binomial)) { ncbiExcludedEnvCode++; continue; }
      if (!isBinomialName(binomial)) { ncbiExcludedNonBinomial++; continue; }

      ncbiBinomialEntries.push({ binomial, adjIdentity: h.identity });
    }

    const ncbiConsensus = iterativeBinomialConsensus(ncbiBinomialEntries);
    const ncbiExclusionTail: string[] = [];
    if (ncbiExcludedEnvCode > 0) ncbiExclusionTail.push(`(${ncbiExcludedEnvCode} env-coded hit(s) excluded)`);
    if (ncbiExcludedUncultured > 0) ncbiExclusionTail.push(`(${ncbiExcludedUncultured} uncultured hit(s) excluded)`);
    if (ncbiExcludedNonBinomial > 0) ncbiExclusionTail.push(`(${ncbiExcludedNonBinomial} non-binomial hit(s) excluded)`);

    if (ncbiBinomialEntries.length === 0) {
      result.steps[result.steps.length - 1] = {
        step: "NCBI Species Consensus",
        status: "info",
        message: "No qualifying NCBI binomial hits found",
        details: [
          `Filters: >= ${effectiveIdentityThreshold}% identity, real binomial`,
          ...(ncbiExcludedEnvCode > 0 ? [`${ncbiExcludedEnvCode} hit(s) excluded as env codes`] : []),
          ...(ncbiExcludedUncultured > 0 ? [`${ncbiExcludedUncultured} hit(s) excluded as uncultured`] : []),
          ...(ncbiExcludedNonBinomial > 0 ? [`${ncbiExcludedNonBinomial} hit(s) excluded as non-binomial`] : []),
        ],
      };
    } else {
      const details: string[] = [];
      details.push("Iterative consensus tiers:");
      details.push(...formatTierAttempts(ncbiConsensus.attempts));
      details.push(ncbiConsensus.tier ? `→ Resolved at ${ncbiConsensus.annotation}` : `→ ${ncbiConsensus.annotation}`);
      if (ncbiConsensus.sorted.length > 0 && ncbiConsensus.total > 0) {
        details.push(`Breakdown at chosen tier (≥${ncbiConsensus.identityThreshold}% identity):`);
        for (const [_k, g] of ncbiConsensus.sorted) {
          details.push(`  ${g.canonical}: ${g.count}/${ncbiConsensus.total} (${((g.count / ncbiConsensus.total) * 100).toFixed(0)}%)`);
        }
      }
      details.push(...ncbiExclusionTail);

      // Populate top-candidate fields whenever there is one (matches pre-tier behavior
      // so downstream Path A/B mapping that uses >=2 hit thresholds keeps working).
      // Status "pass" still requires a tier to win.
      if (ncbiConsensus.topCanonical && ncbiConsensus.total > 0) {
        result.ncbiBinomialConsensus = ncbiConsensus.topCanonical;
        result.ncbiBinomialCount = ncbiConsensus.topCount;
        result.ncbiBinomialTotal = ncbiConsensus.total;
      }

      // Promote NCBI binomial consensus to finalSpecies when a tier passes and
      // MycoBLAST doesn't disagree. Without this, downstream secondary/broadened
      // steps run unnecessarily and the NCBI "pass" is decorative.
      if (
        ncbiConsensus.tier &&
        !result.finalSpecies &&
        isRealBinomial(ncbiConsensus.topCanonical)
      ) {
        // Only treat MycoBLAST as "disagreeing" when it has strong binomial
        // evidence (>=2 hits). A weak/noisy single local top hit shouldn't
        // block NCBI promotion — otherwise secondary/broadened run unnecessarily.
        const MIN_LOCAL_DISAGREEMENT_HITS = 2;
        const localBin = result.localBinomialConsensus ?? null;
        const localBinCount = result.localBinomialCount ?? 0;
        const localDisagrees =
          isRealBinomial(localBin) &&
          localBinCount >= MIN_LOCAL_DISAGREEMENT_HITS &&
          !speciesNamesMatch(localBin, ncbiConsensus.topCanonical);
        if (!localDisagrees) {
          result.finalSpecies = ncbiConsensus.topCanonical;
          result.ncbiConsensusSpecies = ncbiConsensus.topCanonical;
          result.ncbiConsensusCount = ncbiConsensus.topCount;
          result.ncbiConsensusTotalWithSpecies = ncbiConsensus.total;
        }
      }

      result.steps[result.steps.length - 1] = {
        step: "NCBI Species Consensus",
        status: ncbiConsensus.tier ? "pass" : "info",
        message: ncbiConsensus.tier
          ? `Top NCBI binomial: ${ncbiConsensus.topCanonical} (${ncbiConsensus.topCount}/${ncbiConsensus.total}, ${(ncbiConsensus.ratio * 100).toFixed(0)}%) — Tier ${ncbiConsensus.tier}`
          : (ncbiConsensus.topCanonical
              ? `No NCBI binomial consensus — top: ${ncbiConsensus.topCanonical} (${(ncbiConsensus.ratio * 100).toFixed(0)}%); tried tiers A/B/C`
              : "No NCBI binomial consensus — no qualifying hits across tiers A/B/C"),
        details,
      };
    }
  }

  let ncbiBroadenedConsensus: { rank: string; name: string; count?: number; total?: number } | null = null;

  // ===== eDNA GENUS CONSENSUS + TEMP CODE =====
  if (isEdnaSequence) {
    const ednaVariantIdStr = sequenceId.replace("edna-", "");
    const ednaVariantIdNum = parseInt(ednaVariantIdStr, 10);
    const combinedGenusConsensus = ncbiEdnaGenusConsensus || localEdnaGenusConsensus;
    const consensusBase = combinedGenusConsensus;
    const consensusSource = combinedGenusConsensus
      ? (ncbiEdnaGenusConsensus ? "NCBI genus" : "MycoBLAST genus")
      : null;

    if (consensusBase && !isNaN(ednaVariantIdNum)) {
      result.ednaGenusConsensus = combinedGenusConsensus;

      addStep({
        step: "eDNA Genus Consensus & Temp Code",
        status: "running",
        message: `Generating temp code for genus: ${consensusBase}...`,
      });

      try {
        let tempCode: string;
        let variantExistingEdnaId: string | null = null;
        if (!isNaN(ednaVariantIdNum)) {
          const varRow = await edna.variantSpeciesId(ednaVariantIdNum);
          if (varRow?.ednaSpeciesId && /sp\.\s*'env\d+'/i.test(varRow.ednaSpeciesId)) {
            const existingGenus = varRow.ednaSpeciesId.split(" sp.")[0];
            if (existingGenus.toLowerCase() === consensusBase.toLowerCase()) {
              variantExistingEdnaId = varRow.ednaSpeciesId;
            }
          }
        }
        const existingEdnaId = variantExistingEdnaId
          || ((result.ncbiConsensusSpecies && /sp\.\s*'env\d+'/i.test(result.ncbiConsensusSpecies))
            ? result.ncbiConsensusSpecies
            : (result.finalSpecies && /sp\.\s*'env\d+'/i.test(result.finalSpecies))
              ? result.finalSpecies
              : null);

        if (existingEdnaId) {
          tempCode = existingEdnaId;
        } else {
          const pattern = `${consensusBase} sp. 'env%'`;
          const existing = await edna.speciesIdNamesLike(pattern);

          let maxNum = 0;
          for (const row of existing) {
            const match = row.scientificName.match(/env(\d+)/);
            if (match) {
              const num = parseInt(match[1], 10);
              if (num > maxNum) maxNum = num;
            }
          }
          const nextNum = maxNum + 1;
          tempCode = `${consensusBase} sp. 'env${String(nextNum).padStart(3, "0")}'`;
        }
        result.ednaTempCode = tempCode;

        const qualifyingAccessions: { accession: string; source: string }[] = [];

        const queryLen = localResult.queryLen || ncbiResult.queryLen || 0;

        for (const hit of ncbiResult.hits) {
          const adjId = ncbiAdjustedMap[hit.num];
          let hitIdentity: number | null = null;
          if (adjId !== undefined) {
            hitIdentity = adjId;
          } else {
            const hsp = hit.hsps[0];
            if (hsp && hsp.alignLen > 0) {
              hitIdentity = (hsp.identity / hsp.alignLen) * 100;
            }
          }
          if (hitIdentity === null || hitIdentity < EDNA_ADJUSTED_IDENTITY_THRESHOLD) continue;
          if (!meetsEdnaCoverageThreshold(hit, ncbiResult.queryLen || queryLen, ampliconFamily)) continue;
          qualifyingAccessions.push({ accession: hit.accession, source: "ncbi" });
        }

        for (const hit of localResult.hits) {
          const adjId = localAdjustedMap[hit.num];
          let hitIdentity: number | null = null;
          if (adjId !== undefined) {
            hitIdentity = adjId;
          } else {
            const hsp = hit.hsps[0];
            if (hsp && hsp.alignLen > 0) {
              hitIdentity = (hsp.identity / hsp.alignLen) * 100;
            }
          }
          if (hitIdentity === null || hitIdentity < EDNA_ADJUSTED_IDENTITY_THRESHOLD) continue;
          if (!meetsEdnaCoverageThreshold(hit, localResult.queryLen || queryLen, ampliconFamily)) continue;
          qualifyingAccessions.push({ accession: hit.accession, source: "mycoblast" });
        }

        if (isEdnaSequence) {
          const ednaVarIdForEnv = sequenceId.replace("edna-", "");
          try {
            const variantRow = await edna.variantEnvBlastFile(parseInt(ednaVarIdForEnv, 10));
            const envXml = edna.readEdnaBlastXml(variantRow?.envBlastFile);
            if (envXml) {
              const envResult = edna.parseBlastXml(envXml);
              if (envResult && envResult.hits.length > 0) {
                for (const { hit, variantId } of qualifyingEnvBlastHits(envResult, ednaVarIdForEnv, EDNA_ADJUSTED_IDENTITY_THRESHOLD, envResult.queryLen || queryLen, ampliconFamily)) {
                  const envAccession = variantId ? `variant-${variantId}` : (hit.def || `envblast-${hit.num}`);
                  qualifyingAccessions.push({ accession: envAccession, source: "envblast" });
                }
              }
            }
          } catch (envErr: any) {
            ports.logger.warn(`[BatchAnalysis] Seq ${sequenceId}: Failed to load envBLAST for temp code:`, envErr.message);
          }
        }

        if (qualifyingAccessions.length > 0) {
          let appliedCount = 0;
          let renamedCount = 0;
          let skippedExisting = 0;
          const skippedAccessions: string[] = [];
          const renamedAccessions: string[] = [];
          const taxonomy = await edna.resolveTaxonomy(tempCode);
          const { renameEdnaSpeciesId, setVariantEdnaSpeciesId } = await edna.ednaSynonyms();

          for (const acc of qualifyingAccessions) {
            const existingRows = await edna.speciesIdRowsFor(acc);

            if (existingRows.length > 0) {
              const existing = existingRows[0];
              if (existing.scientificName === tempCode) {
                // Already correct — nothing to do.
                skippedExisting++;
                continue;
              }
              // Preserve human-curated rows; rename anything else
              // (analyzer-, batch-, or legacy-null-owned).
              if (existing.updatedBy === "manual-edit") {
                skippedExisting++;
                skippedAccessions.push(`${acc.accession} (${acc.source}) → kept curated "${existing.scientificName}"`);
                continue;
              }
              // Stale auto-assigned row — rename + record synonymy.
              await renameEdnaSpeciesId({
                id: existing.id,
                accession: acc.accession,
                source: acc.source,
                newName: tempCode,
                taxonomy,
                changedBy: `server-analysis:${sequenceId}`,
                reason: `analyzer re-applied consensus from ${consensusSource}`,
              });
              renamedCount++;
              renamedAccessions.push(`${acc.accession} (${acc.source}): ${existing.scientificName} → ${tempCode}`);
              continue;
            }

            await edna.upsertAnalyzerSpeciesId({ acc, tempCode, sequenceId, taxonomy });
            appliedCount++;
          }

          {
            await setVariantEdnaSpeciesId({
              variantId: ednaVariantIdNum,
              newName: tempCode,
              changedBy: `server-analysis:${sequenceId}`,
              reason: `analyzer consensus from ${consensusSource}`,
            });
          }

          result.ednaAppliedCount = appliedCount;
          result.ednaSkippedExisting = skippedExisting;

          const details = [
            `Consensus: ${consensusBase} (from ${consensusSource})`,
            existingEdnaId ? `Reusing existing eDNA ID: ${tempCode}` : `Temp code: ${tempCode}`,
            `Applied eDNA ID to ${appliedCount} new record(s) (>= ${EDNA_ADJUSTED_IDENTITY_THRESHOLD}% identity, >= ${effectiveQueryCoverageThreshold}% query coverage)`,
            `Set variant eDNA ID to: ${tempCode}`,
          ];
          if (renamedCount > 0) {
            details.push(`Renamed ${renamedCount} previously analyzer-assigned record(s) to match new consensus`);
            for (const r of renamedAccessions.slice(0, 10)) {
              details.push(`  Renamed: ${r}`);
            }
            if (renamedAccessions.length > 10) {
              details.push(`  ... and ${renamedAccessions.length - 10} more`);
            }
          }
          if (skippedExisting > 0) {
            details.push(`${skippedExisting} record(s) already current or curated — skipped`);
            for (const skipped of skippedAccessions.slice(0, 10)) {
              details.push(`  Skipped: ${skipped}`);
            }
            if (skippedAccessions.length > 10) {
              details.push(`  ... and ${skippedAccessions.length - 10} more`);
            }
          }

          result.steps[result.steps.length - 1] = {
            step: "eDNA Genus Consensus & Temp Code",
            status: "pass",
            message: `eDNA temp code assigned: ${tempCode} (${appliedCount} records)`,
            details,
          };
          result.finalSpecies = tempCode;

          // ===== eDNA SPECIES MAPPING (binomial consensus driven) =====
          // Uses the parallel binomial consensus (computed earlier with env-code
          // overlays IGNORED) to decide whether we have strong enough evidence
          // to auto-map an env code → canonical binomial.
          //   Path A: >=2 validated MycoBLAST binomial hits AND NCBI binomial agrees
          //   Path B: >=80% MycoBLAST binomial agreement (>=2 hits), NCBI not disagreeing
          const MIN_BINOMIAL_HITS = 2;
          const BINOMIAL_AGREEMENT_THRESHOLD = 0.80;

          const localBinomial = result.localBinomialConsensus ?? null;
          const ncbiBinomial = result.ncbiBinomialConsensus ?? null;
          const localBCount = result.localBinomialCount ?? 0;
          const localBTotal = result.localBinomialTotal ?? 0;
          const ncbiBCount = result.ncbiBinomialCount ?? 0;
          const ncbiBTotal = result.ncbiBinomialTotal ?? 0;
          const localBRatio = localBTotal > 0 ? localBCount / localBTotal : 0;
          const ncbiBRatio = ncbiBTotal > 0 ? ncbiBCount / ncbiBTotal : 0;

          let mappingSpecies: string | null = null;
          let mappingSource = "";
          let mappingPath = "";

          // Path A: MycoBLAST binomial + NCBI binomial agree (>=2 each)
          if (
            isRealBinomial(localBinomial) && localBCount >= MIN_BINOMIAL_HITS &&
            isRealBinomial(ncbiBinomial) && ncbiBCount >= MIN_BINOMIAL_HITS &&
            speciesNamesMatch(localBinomial, ncbiBinomial)
          ) {
            mappingSpecies = localBinomial;
            mappingPath = "A";
            mappingSource = `MycoBLAST + NCBI binomial consensus match (MB: ${localBCount}/${localBTotal} ${(localBRatio * 100).toFixed(0)}%, NCBI: ${ncbiBCount}/${ncbiBTotal} ${(ncbiBRatio * 100).toFixed(0)}%)`;
          }
          // Path B: MycoBLAST binomial >= 80% agreement (>=2 hits), NCBI not disagreeing
          else if (isRealBinomial(localBinomial) && localBCount >= MIN_BINOMIAL_HITS && localBRatio >= BINOMIAL_AGREEMENT_THRESHOLD) {
            const ncbiDisagrees = isRealBinomial(ncbiBinomial) && ncbiBCount >= MIN_BINOMIAL_HITS && !speciesNamesMatch(localBinomial, ncbiBinomial);
            if (!ncbiDisagrees) {
              mappingSpecies = localBinomial;
              mappingPath = "B";
              mappingSource = `MycoBLAST binomial consensus (${localBCount}/${localBTotal}, ${(localBRatio * 100).toFixed(0)}%${isRealBinomial(ncbiBinomial) && ncbiBCount >= MIN_BINOMIAL_HITS ? `; NCBI agrees: ${ncbiBinomial}` : "; NCBI insufficient/neutral"})`;
            }
          }

          // Always compute Species Name Confidence whenever EITHER side has binomial
          // signal (local OR NCBI), regardless of auto-mapping. Feeds dashboard summary.
          {
            const hasLocal = isRealBinomial(localBinomial) && localBCount > 0;
            const hasNcbi = isRealBinomial(ncbiBinomial) && ncbiBCount > 0;
            if (hasLocal || hasNcbi) {
              const speciesForScore = mappingSpecies || (hasLocal ? localBinomial : ncbiBinomial);
              try {
                result.binomialConfidence = computeConfidenceScore({
                  validatedHitCount: hasLocal ? localBCount : 0,
                  ncbiConsensusSpecies: hasNcbi ? ncbiBinomial : null,
                  ncbiConsensusCount: hasNcbi ? ncbiBCount : 0,
                  ncbiTotalWithSpecies: ncbiBTotal,
                  localSpecies: speciesForScore!,
                  localConsensusCount: hasLocal ? localBCount : 0,
                  localTotalWithSpecies: localBTotal,
                  lowIdentityMatches: [],
                  familyMismatch: false,
                  sourceRic: null,
                  sourceSpeciesName: null,
                  isEdna: true,
                  ncbiQualifiedHitCount: ncbiBTotal,
                });
              } catch (confErr: any) {
                ports.logger.warn(`[BatchAnalysis] Binomial confidence computation error for ${tempCode}:`, confErr.message);
              }
            }
          }

          if (mappingSpecies) {

            try {
              const existing = await edna.mappingFor(tempCode);

              if (existing && existing.source === "manual") {
                result.ednaSpeciesMapping = { envCode: tempCode, resolvedSpecies: existing.resolvedSpecies, source: "manual (preserved)" };
                addStep({
                  step: "eDNA Species Mapping",
                  status: "info",
                  message: `Existing manual mapping preserved: ${tempCode} → ${existing.resolvedSpecies}`,
                  details: [
                    `Auto-mapping would set: ${mappingSpecies} (Path ${mappingPath})`,
                    `Manual mapping not overwritten`,
                  ],
                });
              } else {
                await edna.upsertAutoMapping({ tempCode, mappingSpecies, localBinomial, ncbiBinomial });
                edna.clearEdnaSpeciesMappingsCache();
                result.ednaSpeciesMapping = { envCode: tempCode, resolvedSpecies: mappingSpecies, source: mappingSource };
                addStep({
                  step: "eDNA Species Mapping",
                  status: "pass",
                  message: `Mapped ${tempCode} → ${mappingSpecies} (Path ${mappingPath})`,
                  details: [
                    `Source: ${mappingSource}`,
                    `MycoBLAST binomial: ${localBinomial} (${localBCount}/${localBTotal}, ${(localBRatio * 100).toFixed(0)}%)`,
                    isRealBinomial(ncbiBinomial)
                      ? `NCBI binomial: ${ncbiBinomial} (${ncbiBCount}/${ncbiBTotal}, ${(ncbiBRatio * 100).toFixed(0)}%)`
                      : "NCBI: no binomial consensus or insufficient qualifying hits",
                    ...(result.binomialConfidence ? [`Binomial confidence: ${result.binomialConfidence.finalScore}%`] : []),
                  ],
                });
              }
            } catch (mapErr: any) {
              ports.logger.error(`[BatchAnalysis] Species mapping error for ${tempCode}:`, mapErr.message);
            }
          } else if (isRealBinomial(localBinomial) || isRealBinomial(ncbiBinomial)) {
            // Binomial evidence exists but didn't meet thresholds — emit info step
            addStep({
              step: "eDNA Species Mapping",
              status: "info",
              message: `Binomial evidence insufficient for auto-mapping of ${tempCode}`,
              details: [
                isRealBinomial(localBinomial)
                  ? `MycoBLAST binomial: ${localBinomial} (${localBCount}/${localBTotal}, ${(localBRatio * 100).toFixed(0)}%)`
                  : "MycoBLAST: no binomial consensus",
                isRealBinomial(ncbiBinomial)
                  ? `NCBI binomial: ${ncbiBinomial} (${ncbiBCount}/${ncbiBTotal}, ${(ncbiBRatio * 100).toFixed(0)}%)`
                  : "NCBI: no binomial consensus",
                `Path A needs: >=${MIN_BINOMIAL_HITS} MycoBLAST + >=${MIN_BINOMIAL_HITS} NCBI binomial hits that agree`,
                `Path B needs: >=${(BINOMIAL_AGREEMENT_THRESHOLD * 100).toFixed(0)}% MycoBLAST binomial agreement (>=${MIN_BINOMIAL_HITS} hits) with NCBI not disagreeing`,
              ],
            });
          }
        } else {
          if (ednaIsMultiVariant) {
            result.steps[result.steps.length - 1] = {
              step: "Manual Validation Required",
              status: "skip",
              message: `Manual validation needed — no qualifying hits at >= ${EDNA_ADJUSTED_IDENTITY_THRESHOLD}% identity across any BLAST source`,
              details: [
                `Consensus: ${consensusBase} (from ${consensusSource})`,
                `Temp code: ${tempCode}`,
                `No hits found at >= ${EDNA_ADJUSTED_IDENTITY_THRESHOLD}% identity and >= ${effectiveQueryCoverageThreshold}% query coverage in NCBI, MycoBLAST, or envBLAST`,
                `Sequence has ${ednaVariantSiblingCount} variants — not a singleton, so this variant is held for manual validation rather than auto-labeled as "Singleton Sequence"`,
              ],
            };
            result.finalSpecies = "Manual Validation Needed";
            result.finalConfidence = 0;
            result.ednaTempCode = tempCode;
          } else {
            const rescue = await edna.findEnvBlastSiblingEdnaId(ednaVariantIdNum, ednaVariantIdStr, queryLen, ampliconFamily);
            if (rescue) {
              try {
                const { setVariantEdnaSpeciesId } = await edna.ednaSynonyms();
                await setVariantEdnaSpeciesId({
                  variantId: ednaVariantIdNum,
                  newName: rescue.siblingEdnaId,
                  changedBy: `server-analysis:${sequenceId}`,
                  reason: "envBLAST sibling rescue (genus path)",
                });
              } catch (err: any) {
                ports.logger.warn(`[BatchAnalysis] Seq ${sequenceId}: setVariantEdnaSpeciesId failed during envBLAST sibling rescue:`, err?.message || err);
              }
              result.steps[result.steps.length - 1] = {
                step: "eDNA Genus Consensus & Temp Code",
                status: "pass",
                message: `Adopted env-coded ID from envBLAST sibling: ${rescue.siblingEdnaId}`,
                details: [
                  `Consensus: ${consensusBase} (from ${consensusSource})`,
                  `Not a singleton — ${rescue.matchCount} sibling variant(s) matched in envBLAST at >= ${EDNA_ADJUSTED_IDENTITY_THRESHOLD}% identity`,
                  `Reusing existing eDNA ID: ${rescue.siblingEdnaId}`,
                  `Set variant eDNA ID to: ${rescue.siblingEdnaId}`,
                ],
              };
              result.finalSpecies = rescue.siblingEdnaId;
              result.finalConfidence = 0;
              result.ednaTempCode = rescue.siblingEdnaId;
            } else {
              const singletonName = `Singleton Sequence - ${tempCode}`;
              result.steps[result.steps.length - 1] = {
                step: "eDNA Genus Consensus & Temp Code",
                status: "info",
                message: `Singleton — no qualifying hits at >= ${EDNA_ADJUSTED_IDENTITY_THRESHOLD}% identity across any BLAST source`,
                details: [
                  `Consensus: ${consensusBase} (from ${consensusSource})`,
                  `Temp code: ${tempCode}`,
                  `No hits found at >= ${EDNA_ADJUSTED_IDENTITY_THRESHOLD}% identity and >= ${effectiveQueryCoverageThreshold}% query coverage in NCBI, MycoBLAST, or envBLAST`,
                  `Result: ${singletonName}`,
                ],
              };
              result.finalSpecies = singletonName;
              result.finalConfidence = 0;
              result.ednaTempCode = tempCode;
            }
          }
        }
      } catch (err: any) {
        result.steps[result.steps.length - 1] = {
          step: "eDNA Genus Consensus & Temp Code",
          status: "fail",
          message: `Error generating eDNA temp code: ${err.message}`,
          details: [`Consensus: ${consensusBase} (from ${consensusSource})`, `Error: ${err.message}`],
        };
      }
    }
  }

  // ===== SOURCE RECORD COMPARISON =====
  let familyMismatch = false;
  if (result.finalSpecies && result.localConsensusSpecies) {
    addStep({
      step: "Source Record Comparison",
      status: "running",
      message: "Comparing MycoBLAST consensus with source record...",
    });

    const localConsensusGenus = extractGenus(result.localConsensusSpecies);
    const _ncbiConsensusGenus = result.ncbiConsensusSpecies ? extractGenus(result.ncbiConsensusSpecies) : null;

    let localFamilyResolution: FamilyResolution | null = null;
    let sourceFamilyResolution: FamilyResolution | null = null;
    let localFamily: string | null = null;
    let sourceFamily: string | null = null;

    if (localConsensusGenus) {
      localFamilyResolution = await ports.family(localConsensusGenus, "genus");
      localFamily = localFamilyResolution.family;
    }
    if (sourceSpeciesName && orderFamilyOverride) {
      sourceFamily = orderFamilyOverride;
    } else if (sourceSpeciesName && !supragenericSource) {
      if (isFamilyRank) {
        sourceFamily = sourceSpeciesName;
      } else if (isBetweenFamilyAndGenusRank(effectiveRank)) {
        sourceFamilyResolution = await ports.family(sourceSpeciesName, effectiveRank || undefined);
        sourceFamily = sourceFamilyResolution.family;
      } else if (infraspecificSource) {
        const sourceGenus = extractGenus(sourceSpeciesName);
        const isSingleWordInfra = sourceSpeciesName.trim().split(/\s+/).length === 1;
        if (sourceGenus && !isSingleWordInfra) {
          sourceFamilyResolution = await ports.family(sourceGenus, "genus");
          sourceFamily = sourceFamilyResolution.family;
        } else {
          sourceFamilyResolution = await ports.family(sourceSpeciesName, effectiveRank || undefined);
          sourceFamily = sourceFamilyResolution.family;
        }
      } else {
        const sourceGenus = extractGenus(sourceSpeciesName);
        if (sourceGenus) {
          sourceFamilyResolution = await ports.family(sourceGenus, "genus");
          sourceFamily = sourceFamilyResolution.family;
        }
      }
    }

    const comparisonDetails: string[] = [];
    comparisonDetails.push(`MycoBLAST consensus: ${result.localConsensusSpecies}${localFamily ? ` (Family: ${localFamily})` : ""}`);
    if (localFamilyResolution) comparisonDetails.push(...formatFamilyResolution(localFamilyResolution).map(d => `Consensus ${d}`));
    if (sourceFamilyResolution) comparisonDetails.push(...formatFamilyResolution(sourceFamilyResolution).map(d => `Source ${d}`));
    if (result.ncbiConsensusSpecies) {
      comparisonDetails.push(`NCBI consensus: ${result.ncbiConsensusSpecies}`);
    }
    if (orderFamilyOverride && supragenericSource && sourceSpeciesName) {
      comparisonDetails.push(`Source record: ${sourceSpeciesName} (rank: ${effectiveRank}, mapped to Family: ${orderFamilyOverride})`);
    } else if (supragenericSource && sourceSpeciesName) {
      comparisonDetails.push(`Source record: ${sourceSpeciesName} (rank: ${effectiveRank}, too high for family comparison)`);
    } else if (isFamilyRank && sourceSpeciesName) {
      comparisonDetails.push(`Source record: ${sourceSpeciesName} (rank: family)${sourceFamily ? ` (Family: ${sourceFamily})` : ""}`);
    } else if (infraspecificSource && sourceSpeciesName) {
      const sourceGenus = extractGenus(sourceSpeciesName);
      if (sourceGenus) {
        comparisonDetails.push(`Source record: ${sourceSpeciesName} (rank: ${effectiveRank}, family lookup by genus "${sourceGenus}")${sourceFamily ? ` (Family: ${sourceFamily})` : ""}`);
      } else {
        comparisonDetails.push(`Source record: ${sourceSpeciesName} (rank: ${effectiveRank}, direct family lookup)${sourceFamily ? ` (Family: ${sourceFamily})` : ""}`);
      }
    } else {
      comparisonDetails.push(`Source record: ${sourceSpeciesName || "N/A"}${sourceFamily ? ` (Family: ${sourceFamily})` : ""}`);
    }

    if (supragenericSource && !orderFamilyOverride) {
      comparisonDetails.push(`Source identified only to ${effectiveRank} level - family comparison skipped`);
      result.steps[result.steps.length - 1] = {
        step: "Source Record Comparison",
        status: "info",
        message: `Source record identified to ${effectiveRank} level - too high for family comparison`,
        details: comparisonDetails,
      };
    } else if (localFamily && sourceFamily) {
      if (localFamily.toLowerCase() !== sourceFamily.toLowerCase()) {
        familyMismatch = true;
        comparisonDetails.push(`Family mismatch: ${localFamily} vs ${sourceFamily} -> -50% confidence penalty`);
        result.steps[result.steps.length - 1] = {
          step: "Source Record Comparison",
          status: "fail",
          message: `Family mismatch between MycoBLAST consensus (${localFamily}) and source record (${sourceFamily})`,
          details: comparisonDetails,
        };
      } else {
        const genusGroups = GENUS_MATCH_FAMILIES[localFamily.toLowerCase()];
        const sourceGenus = sourceSpeciesName ? extractGenus(sourceSpeciesName) : null;
        if (genusGroups && sourceGenus && localConsensusGenus) {
          const sourceGroup = genusGroups.find(g => g.some(gn => gn.toLowerCase() === sourceGenus.toLowerCase()));
          const resultGroup = genusGroups.find(g => g.some(gn => gn.toLowerCase() === localConsensusGenus.toLowerCase()));
          if (sourceGroup && resultGroup && sourceGroup !== resultGroup) {
            familyMismatch = true;
            comparisonDetails.push(`Families match (${localFamily}) but genus group mismatch: source genus "${sourceGenus}" and result genus "${localConsensusGenus}" are in different genus groups within ${localFamily} -> -50% confidence penalty`);
            result.steps[result.steps.length - 1] = {
              step: "Source Record Comparison",
              status: "fail",
              message: `Genus group mismatch within ${localFamily}: "${sourceGenus}" vs "${localConsensusGenus}"`,
              details: comparisonDetails,
            };
          } else if (sourceGroup && !resultGroup) {
            familyMismatch = true;
            comparisonDetails.push(`Families match (${localFamily}) but result genus "${localConsensusGenus}" not in any defined genus group for ${localFamily} -> -50% confidence penalty`);
            result.steps[result.steps.length - 1] = {
              step: "Source Record Comparison",
              status: "fail",
              message: `Genus group mismatch within ${localFamily}: "${localConsensusGenus}" not in expected genus group for "${sourceGenus}"`,
              details: comparisonDetails,
            };
          } else {
            const matchNote = sourceGroup ? `Genus group match within ${localFamily}: ${sourceGroup.join(', ')}` : `Families match: ${localFamily} (genus-level check: source genus "${sourceGenus}" not in any restricted group)`;
            comparisonDetails.push(`${matchNote} - no penalty`);
            result.steps[result.steps.length - 1] = {
              step: "Source Record Comparison",
              status: "pass",
              message: sourceGroup ? `Genus group match within ${localFamily}` : `Families match: ${localFamily}`,
              details: comparisonDetails,
            };
          }
        } else {
          comparisonDetails.push(`Families match: ${localFamily} - no penalty`);
          result.steps[result.steps.length - 1] = {
            step: "Source Record Comparison",
            status: "pass",
            message: `Families match: ${localFamily}`,
            details: comparisonDetails,
          };
        }
      }
    } else {
      comparisonDetails.push(`Family lookup ${!localFamily && !sourceFamily ? "failed for both" : !localFamily ? "failed for MycoBLAST consensus" : "failed for source record"} - comparison skipped`);
      result.steps[result.steps.length - 1] = {
        step: "Source Record Comparison",
        status: "info",
        message: "Family comparison could not be completed",
        details: comparisonDetails,
      };
    }
  }

  // ===== CONFIDENCE SCORING =====
  if (result.finalSpecies) {
    addStep({
      step: "Confidence Scoring",
      status: "running",
      message: "Computing confidence score...",
    });

    const allLowIdMatches: { identity: number; source: "local" | "ncbi" }[] = [];

    const highIdObservations = new Set<string>();
    for (const hit of localResult.hits) {
      const adjId = localAdjustedMap[hit.num];
      if (adjId === undefined || adjId < effectiveLowIdThreshold) continue;
      const seqRec = findSequenceRecordForHit(hit, sequenceMap);
      if (isTrashReference(seqRec) || isExcludedReference(seqRec)) continue;
      if (seqRec?.observationId) {
        const hitSpecies = getSpeciesNameFromHit(hit, sequenceMap, genbankMap, ednaSpeciesIdMap);
        if (hitSpecies && speciesNamesMatch(hitSpecies, result.finalSpecies)) {
          highIdObservations.add(String(seqRec.observationId));
        }
      }
    }

    let lowIdExcludedByHighId = 0;
    let lowIdExcludedByValidation = 0;
    for (const hit of localResult.hits) {
      const adjId = localAdjustedMap[hit.num];
      if (adjId === undefined) continue;
      if (adjId >= effectiveLowIdThreshold) continue;
      const hitSpecies = getSpeciesNameFromHit(hit, sequenceMap, genbankMap, ednaSpeciesIdMap);
      if (hitSpecies && speciesNamesMatch(hitSpecies, result.finalSpecies)) {
        const seqRec = findSequenceRecordForHit(hit, sequenceMap);
          if (isTrashReference(seqRec) || isExcludedReference(seqRec)) continue;
        if (seqRec?.observationId && highIdObservations.has(String(seqRec.observationId))) {
          lowIdExcludedByHighId++;
          continue;
        }
        if (!isHitValidated(hit, sequenceMap, genbankMap)) {
          lowIdExcludedByValidation++;
          continue;
        }
        allLowIdMatches.push({ identity: adjId, source: "local" });
      }
    }

    for (const hit of ncbiResult.hits) {
      const adjId = ncbiAdjustedMap[hit.num];
      let hitIdentity: number | null = null;
      if (adjId !== undefined) {
        hitIdentity = adjId;
      } else {
        const hsp = hit.hsps[0];
        if (hsp && hsp.alignLen > 0) {
          hitIdentity = (hsp.identity / hsp.alignLen) * 100;
        }
      }
      if (hitIdentity === null || hitIdentity >= effectiveLowIdThreshold) continue;
      let hitSpecies: string | null = null;
      if (ednaSpeciesIdMap && ednaSpeciesIdMap[hit.accession]) {
        hitSpecies = ednaSpeciesIdMap[hit.accession];
      } else if (genbankMap[hit.accession]) {
        const meta = genbankMap[hit.accession];
        hitSpecies = (meta.scientificName || meta.organism || null) as string | null;
      }
      if (!hitSpecies) {
        hitSpecies = extractSpeciesName(hit.def);
      }
      if (hitSpecies && speciesNamesMatch(hitSpecies, result.finalSpecies)) {
        allLowIdMatches.push({ identity: hitIdentity, source: "ncbi" });
      }
    }

    // Base counts specimens: reads of one specimen (variants, samples -1/-2) are one record.
    // eDNA keeps counting hits until its rules are revisited.
    const validatedHits = qualifiedHits.filter(h => {
      const speciesName = h.speciesName;
      return speciesName !== null && speciesNamesMatch(speciesName, result.finalSpecies!);
    });
    const validatedHitCount = isEdnaSequence ? validatedHits.length : countSpecimens(validatedHits);

    const isUnculturedOnly = !!(result.broadenedSource && result.broadenedSource.includes("uncultured"));
    const breakdown = computeConfidenceScore({
      validatedHitCount,
      validatedHitReads: validatedHits.length,
      ncbiConsensusSpecies: result.ncbiConsensusSpecies,
      ncbiConsensusCount: result.ncbiConsensusCount || 0,
      ncbiTotalWithSpecies: result.ncbiConsensusTotalWithSpecies || 0,
      localSpecies: result.finalSpecies,
      localConsensusCount: result.localConsensusCount || 0,
      localTotalWithSpecies: result.localConsensusTotalWithSpecies || 0,
      lowIdentityMatches: allLowIdMatches,
      familyMismatch,
      sourceRic: sourceRic ?? null,
      sourceSpeciesName: sourceSpeciesName ?? null,
      isOnlySequenceForRecord,
      isEdna: isEdnaSequence,
      ncbiQualifiedHitCount: ncbiQualifiedHits.length,
      envBlastReplicationParam: envBlastReplication,
      isUnculturedOnly,
    });

    result.confidenceBreakdown = breakdown;
    result.finalConfidence = breakdown.finalScore;

    const confidenceDetails = [
      `Base: ${breakdown.baseScore}% (${breakdown.baseReason})`,
      `NCBI: ${breakdown.ncbiAdjustment >= 0 ? '+' : ''}${breakdown.ncbiAdjustment}% (${breakdown.ncbiReason})`,
      `Family mismatch: ${breakdown.familyMismatchPenalty > 0 ? '-' : ''}${breakdown.familyMismatchPenalty}% (${breakdown.familyMismatchReason})`,
      `Genus match: +${breakdown.genusMatchBonus}% (${breakdown.genusMatchReason})`,
      `Species match: +${breakdown.speciesMatchBonus}% (${breakdown.speciesMatchReason})`,
      `RiC penalty: ${breakdown.ricPenalty > 0 ? '-' : ''}${breakdown.ricPenalty}% (${breakdown.ricReason})`,
      ...(!isEdnaSequence ? [`Name agreement: ${breakdown.nameAgreementPenalty > 0 ? '-' : ''}${breakdown.nameAgreementPenalty} (${breakdown.nameAgreementReason})`] : []),
      `Low-ID penalty: ${breakdown.lowIdentityPenalty > 0 ? '-' : ''}${breakdown.lowIdentityPenalty}% (${breakdown.lowIdentityReason})`,
      ...(lowIdExcludedByHighId > 0 ? [`(${lowIdExcludedByHighId} low-ID MycoBLAST hit${lowIdExcludedByHighId !== 1 ? 's' : ''} excluded - specimen also has high-ID hit)`] : []),
      ...(lowIdExcludedByValidation > 0 ? [`(${lowIdExcludedByValidation} low-ID MycoBLAST hit${lowIdExcludedByValidation !== 1 ? 's' : ''} excluded - observation not validated)`] : []),
      ...(isEdnaSequence ? [`envBLAST replication: +${breakdown.envBlastReplicationBonus}% (${breakdown.envBlastReplicationReason})`] : []),
      ...(breakdown.unculturedPenalty > 0 ? [`Uncultured: -${breakdown.unculturedPenalty}% (${breakdown.unculturedPenaltyReason})`] : []),
    ];
    if (breakdown.capApplied && breakdown.capReason) {
      confidenceDetails.push(`Cap applied: ${breakdown.capReason}`);
    }
    confidenceDetails.push(`Final confidence: ${breakdown.finalScore}%`);

    const confidenceStatus: "pass" | "info" | "fail" = breakdown.finalScore >= 70 ? "pass" : breakdown.finalScore >= 50 ? "info" : "fail";

    result.steps[result.steps.length - 1] = {
      step: "Confidence Scoring",
      status: confidenceStatus,
      message: `Confidence: ${breakdown.finalScore}% for "${result.finalSpecies}"`,
      details: confidenceDetails,
    };

    
    setDeterministicCurationRecommendations(result, localResult, ncbiResult, sequenceMap, localAdjustedMap, obsSpeciesMap, genbankMap, ncbiAdjustedMap);

    result.status = "complete";
    return result;
  }

  // ===== SECONDARY 99% LOOP =====
  // Primary analysis at 99.5% failed to determine a species.
  // Re-filter hits at secondary threshold with halved base confidence.
  const effectiveSecondaryThreshold = isEdnaSequence ? EDNA_SECONDARY_IDENTITY_THRESHOLD : SECONDARY_IDENTITY_THRESHOLD;
  addStep({
    step: `Secondary ${effectiveSecondaryThreshold}% Analysis`,
    status: "running",
    message: `Primary analysis at ${effectiveIdentityThreshold}% found no species — retrying at ${effectiveSecondaryThreshold}%...`,
  });

  const sec99QualifiedHits: {
    hit: BlastHit;
    adjustedIdentity: number;
    queryCoverage: number;
    speciesName: string | null;
    isContaminant: boolean;
    isValidated: boolean;
    specimenKey?: string | null;
  }[] = [];

  for (const hit of localResult.hits) {
    const seqRecord = findSequenceRecordForHit(hit, sequenceMap);
    if (isTrashReference(seqRecord)) continue;
    if (isExcludedReference(seqRecord)) continue;
    if (querySourceKey) {
      const isOrigin = String(seqRecord?.id) === String(sequenceId);
      if (isOrigin) continue;
      const hitSourceKey = getHitSourceKey(hit, seqRecord || null);
      if (hitSourceKey && hitSourceKey === querySourceKey) continue;
    }
    const adjIdentity = localAdjustedMap[hit.num];
    if (adjIdentity === undefined) continue;
    if (adjIdentity < effectiveSecondaryThreshold) continue;
    if (isEdnaSequence && !meetsEdnaCoverageThreshold(hit, localResult.queryLen, ampliconFamily)) continue;
    const validated = isHitValidated(hit, sequenceMap, genbankMap);
    if (!validated) continue;
    const hsp = hit.hsps[0];
    const queryCoverage = hsp ? ((hsp.queryTo - hsp.queryFrom + 1) / localResult.queryLen) * 100 : 0;
    const speciesName = getSpeciesNameFromHit(hit, sequenceMap, genbankMap, ednaSpeciesIdMap);
    const flags = seqRecord?.flags || [];
    const isContaminant = isContaminantFlag(flags);
    sec99QualifiedHits.push({ hit, adjustedIdentity: adjIdentity, queryCoverage, speciesName, isContaminant, isValidated: true, specimenKey: getHitSourceKey(hit, seqRecord || null) });
  }

  const sec99ValidHits = sec99QualifiedHits.filter(h => !h.isContaminant);
  const sec99SpeciesCountsRaw = new Map<string, number>();
  const sec99HitsWithoutSpecies = sec99ValidHits.filter(h => !isConsensusVoteName(h.speciesName)).length;
  for (const h of sec99ValidHits) {
    if (isConsensusVoteName(h.speciesName)) {
      sec99SpeciesCountsRaw.set(h.speciesName, (sec99SpeciesCountsRaw.get(h.speciesName) || 0) + 1);
    }
  }

  const { normalized: sec99LocalNormalized } = groupByNormalizedName(sec99SpeciesCountsRaw);
  const sec99LocalSorted = Array.from(sec99LocalNormalized.entries()).sort((a, b) => b[1].count - a[1].count);
  const sec99TotalWithSpecies = sec99ValidHits.filter(h => h.speciesName).length;

  // The vote at 99%, like the one at 99.5%, gives each specimen one vote per name
  // (specimenVotes.ts; 2026-11-17), so variant reads of one specimen can't
  // outvote other records. A named hit outside the vote ("Fungi") still counts against the
  // top name, once per specimen. eDNA still votes per hit. The winner's counts reported
  // below (and the name-agreement check) stay per hit, as at 99.5%.
  const sec99NamedHits = sec99ValidHits.filter(h => h.speciesName);
  const sec99VoteEntries = isEdnaSequence
    ? sec99ValidHits.filter(h => isConsensusVoteName(h.speciesName)).map(h => ({ binomial: h.speciesName as string, adjIdentity: h.adjustedIdentity }))
    : localConsensusEntries(sec99ValidHits);
  const sec99VoteTotal = isEdnaSequence
    ? sec99NamedHits.length
    : oneVotePerSpecimen(sec99NamedHits.map(h => ({ binomial: h.speciesName as string, adjIdentity: h.adjustedIdentity, specimenKey: h.specimenKey }))).length;
  const sec99VoteCountsRaw = new Map<string, number>();
  for (const e of sec99VoteEntries) sec99VoteCountsRaw.set(e.binomial, (sec99VoteCountsRaw.get(e.binomial) || 0) + 1);
  const sec99VoteSorted = Array.from(groupByNormalizedName(sec99VoteCountsRaw).normalized.entries()).sort((a, b) => b[1].count - a[1].count);
  const sec99VoteNote = isEdnaSequence ? null : specimenVoteNote(sec99NamedHits.length, sec99VoteTotal);

  let sec99LocalConsensus: string | null = null;
  let sec99LocalCount = 0;
  let sec99LocalTotal = 0;
  let sec99TopVotes = 0;

  if (sec99VoteSorted.length > 0 && sec99VoteTotal > 0) {
    const [sec99TopKey, sec99TopVote] = sec99VoteSorted[0];
    if (sec99TopVote.count / sec99VoteTotal >= SPECIES_CONSENSUS_THRESHOLD) {
      const fullPool = sec99LocalNormalized.get(sec99TopKey);
      sec99LocalConsensus = fullPool?.canonical ?? sec99TopVote.canonical;
      sec99LocalCount = fullPool?.count ?? sec99TopVote.count;
      sec99LocalTotal = sec99TotalWithSpecies;
      sec99TopVotes = sec99TopVote.count;
    }
  }

  let sec99NcbiConsensus: string | null = null;
  let sec99NcbiCount = 0;
  let sec99NcbiTotal = 0;

  const sec99NcbiQualified: { hit: BlastHit; speciesName: string }[] = [];
  for (const hit of ncbiResult.hits) {
    let speciesName: string | null = null;
    if (ednaSpeciesIdMap && ednaSpeciesIdMap[hit.accession]) {
      speciesName = ednaSpeciesIdMap[hit.accession];
    } else if (genbankMap[hit.accession]) {
      const meta = genbankMap[hit.accession];
      speciesName = (meta.scientificName || meta.organism || null) as string | null;
    }
    if (!speciesName) speciesName = extractSpeciesName(hit.def);
    if (!isConsensusVoteName(speciesName)) continue;
    const adjIdentity = ncbiAdjustedMap[hit.num];
    if (adjIdentity !== undefined) {
      if (adjIdentity < effectiveSecondaryThreshold) continue;
    } else {
      const hsp = hit.hsps[0];
      if (!hsp) continue;
      const rawIdentity = hsp.alignLen > 0 ? (hsp.identity / hsp.alignLen) * 100 : 0;
      if (rawIdentity < effectiveSecondaryThreshold) continue;
    }
    if (isEdnaSequence && !meetsEdnaCoverageThreshold(hit, ncbiResult.queryLen || localResult.queryLen, ampliconFamily)) continue;
    sec99NcbiQualified.push({ hit, speciesName });
  }

  const sec99NcbiCulturedQualified = sec99NcbiQualified.filter(h => !isUnculturedName(h.speciesName));

  const sec99NcbiCountsRaw = new Map<string, number>();
  for (const h of sec99NcbiCulturedQualified) {
    sec99NcbiCountsRaw.set(h.speciesName, (sec99NcbiCountsRaw.get(h.speciesName) || 0) + 1);
  }

  const { normalized: sec99NcbiNormalized } = groupByNormalizedName(sec99NcbiCountsRaw);
  const sec99NcbiSorted = Array.from(sec99NcbiNormalized.entries()).sort((a, b) => b[1].count - a[1].count);
  const sec99NcbiTotalWithSpecies = sec99NcbiCulturedQualified.length;

  if (sec99NcbiSorted.length > 0 && sec99NcbiTotalWithSpecies > 0) {
    const ncbiTop = sec99NcbiSorted[0];
    const ncbiRatio = ncbiTop[1].count / sec99NcbiTotalWithSpecies;
    if (ncbiRatio >= SPECIES_CONSENSUS_THRESHOLD) {
      sec99NcbiConsensus = ncbiTop[1].canonical;
      sec99NcbiCount = ncbiTop[1].count;
      sec99NcbiTotal = sec99NcbiTotalWithSpecies;
    }
  }

  if (sec99LocalConsensus) {
    result.localConsensusSpecies = sec99LocalConsensus;
    result.localConsensusCount = sec99LocalCount;
    result.localConsensusTotalWithSpecies = sec99LocalTotal;
    result.localConsensusThreshold = effectiveSecondaryThreshold;
    result.finalSpecies = sec99LocalConsensus;

    if (sec99NcbiConsensus) {
      result.ncbiConsensusSpecies = sec99NcbiConsensus;
      result.ncbiConsensusCount = sec99NcbiCount;
      result.ncbiConsensusTotalWithSpecies = sec99NcbiTotal;
      result.ncbiConsensusThreshold = effectiveSecondaryThreshold;
    }

    const sec99SpeciesDetails: string[] = [];
    for (const [_key, group] of sec99LocalSorted) {
      sec99SpeciesDetails.push(`${group.canonical}: ${group.count}/${sec99TotalWithSpecies} (${((group.count / sec99TotalWithSpecies) * 100).toFixed(0)}%)`);
    }

    addStep({
      step: `Secondary ${effectiveSecondaryThreshold}% MycoBLAST Consensus`,
      status: "pass",
      message: `Secondary analysis found consensus: ${sec99LocalConsensus} at >= ${effectiveSecondaryThreshold}%`,
      details: [
        `Re-filtered local hits at ${effectiveSecondaryThreshold}% threshold (down from ${effectiveIdentityThreshold}%)`,
        `${sec99ValidHits.length} validated hits found (${sec99HitsWithoutSpecies} without species names)`,
        `${sec99LocalConsensus}: ${sec99LocalCount}/${sec99TotalWithSpecies} (${((sec99LocalCount / sec99TotalWithSpecies) * 100).toFixed(0)}%)`,
        ...(sec99VoteNote ? [sec99VoteNote, `${sec99LocalConsensus}: ${sec99TopVotes}/${sec99VoteTotal} specimen votes (${((sec99TopVotes / sec99VoteTotal) * 100).toFixed(0)}%)`] : []),
        `Threshold: >= ${(SPECIES_CONSENSUS_THRESHOLD * 100).toFixed(0)}% agreement required`,
        // The other names: the winner can differ from the most-read name once specimens vote.
        ...sec99SpeciesDetails.filter((_, i) => sec99LocalSorted[i][1].canonical !== sec99LocalConsensus),
      ],
    });

    if (sec99NcbiConsensus) {
      addStep({
        step: `Secondary ${effectiveSecondaryThreshold}% NCBI Consensus`,
        status: speciesNamesMatch(sec99NcbiConsensus, sec99LocalConsensus) ? "pass" : "info",
        message: `NCBI secondary consensus: ${sec99NcbiConsensus} (${sec99NcbiCount}/${sec99NcbiTotal})`,
        details: [
          `Re-filtered NCBI hits at ${effectiveSecondaryThreshold}% threshold`,
          speciesNamesMatch(sec99NcbiConsensus, sec99LocalConsensus)
            ? `NCBI agrees with MycoBLAST consensus`
            : `NCBI disagrees: "${sec99NcbiConsensus}" vs MycoBLAST "${sec99LocalConsensus}"`,
        ],
      });
    }

    let sec99FamilyMismatch = false;
    const sec99LocalGenus = extractGenus(sec99LocalConsensus);
    let sec99LocalResolution: FamilyResolution | null = null;
    let sec99SourceResolution: FamilyResolution | null = null;
    let sec99LocalFamily: string | null = null;
    if (sec99LocalGenus) {
      sec99LocalResolution = await ports.family(sec99LocalGenus, "genus");
      sec99LocalFamily = sec99LocalResolution.family;
    }
    let sec99SourceFamily: string | null = null;
    if (sourceSpeciesName && orderFamilyOverride) {
      sec99SourceFamily = orderFamilyOverride;
    } else if (sourceSpeciesName && !supragenericSource) {
      if (isFamilyRank) {
        sec99SourceFamily = sourceSpeciesName;
      } else if (isBetweenFamilyAndGenusRank(effectiveRank)) {
        sec99SourceResolution = await ports.family(sourceSpeciesName, effectiveRank || undefined);
        sec99SourceFamily = sec99SourceResolution.family;
      } else if (infraspecificSource) {
        const sg = extractGenus(sourceSpeciesName);
        const isSingleWordInfra = sourceSpeciesName.trim().split(/\s+/).length === 1;
        if (sg && !isSingleWordInfra) {
          sec99SourceResolution = await ports.family(sg, "genus");
          sec99SourceFamily = sec99SourceResolution.family;
        } else {
          sec99SourceResolution = await ports.family(sourceSpeciesName, effectiveRank || undefined);
          sec99SourceFamily = sec99SourceResolution.family;
        }
      } else {
        const sg = extractGenus(sourceSpeciesName);
        if (sg) {
          sec99SourceResolution = await ports.family(sg, "genus");
          sec99SourceFamily = sec99SourceResolution.family;
        }
      }
    }
    if (sec99LocalFamily && sec99SourceFamily) {
      if (sec99LocalFamily.toLowerCase() !== sec99SourceFamily.toLowerCase()) {
        sec99FamilyMismatch = true;
      } else {
        const genusGroups = GENUS_MATCH_FAMILIES[sec99LocalFamily.toLowerCase()];
        const sourceGenus = sourceSpeciesName ? extractGenus(sourceSpeciesName) : null;
        if (genusGroups && sourceGenus && sec99LocalGenus) {
          const srcGroup = genusGroups.find(g => g.some(gn => gn.toLowerCase() === sourceGenus.toLowerCase()));
          const resGroup = genusGroups.find(g => g.some(gn => gn.toLowerCase() === sec99LocalGenus.toLowerCase()));
          if ((srcGroup && resGroup && srcGroup !== resGroup) || (srcGroup && !resGroup)) {
            sec99FamilyMismatch = true;
          }
        }
      }
    }

    const sec99ComparisonDetails: string[] = [];
    sec99ComparisonDetails.push(`MycoBLAST consensus (secondary): ${sec99LocalConsensus}${sec99LocalFamily ? ` (Family: ${sec99LocalFamily})` : ""}`);
    sec99ComparisonDetails.push(`Source record: ${sourceSpeciesName || "N/A"}${sec99SourceFamily ? ` (Family: ${sec99SourceFamily})` : ""}`);
    if (sec99LocalResolution) sec99ComparisonDetails.push(...formatFamilyResolution(sec99LocalResolution).map(d => `Consensus ${d}`));
    if (sec99SourceResolution) sec99ComparisonDetails.push(...formatFamilyResolution(sec99SourceResolution).map(d => `Source ${d}`));
    if (sec99FamilyMismatch) {
      const sourceGenus = sourceSpeciesName ? extractGenus(sourceSpeciesName) : null;
      const isGenusGroupMismatch = sec99LocalFamily && sec99SourceFamily && sec99LocalFamily.toLowerCase() === sec99SourceFamily.toLowerCase();
      if (isGenusGroupMismatch) {
        sec99ComparisonDetails.push(`Genus group mismatch within ${sec99LocalFamily}: "${sourceGenus}" vs "${sec99LocalGenus}" -> -50% confidence penalty`);
      } else {
        sec99ComparisonDetails.push(`Family mismatch: ${sec99LocalFamily} vs ${sec99SourceFamily} -> -50% confidence penalty`);
      }
      addStep({
        step: "Source Record Comparison",
        status: "fail",
        message: isGenusGroupMismatch
          ? `Genus group mismatch within ${sec99LocalFamily}: "${sourceGenus}" vs "${sec99LocalGenus}"`
          : `Family mismatch between secondary consensus (${sec99LocalFamily}) and source record (${sec99SourceFamily})`,
        details: sec99ComparisonDetails,
      });
    } else if (sec99LocalFamily && sec99SourceFamily) {
      sec99ComparisonDetails.push(`Families match: ${sec99LocalFamily} - no penalty`);
      addStep({
        step: "Source Record Comparison",
        status: "pass",
        message: `Families match: ${sec99LocalFamily}`,
        details: sec99ComparisonDetails,
      });
    }

    const sec99LowIdMatches: { identity: number; source: "local" | "ncbi" }[] = [];
    let sec99LowIdExcludedByHighId = 0;
    let sec99LowIdExcludedByValidation = 0;
    const sec99HighIdObservations = new Set<string>();
    for (const hit of localResult.hits) {
      const adjId = localAdjustedMap[hit.num];
      if (adjId === undefined || adjId < effectiveLowIdThreshold) continue;
      const seqRec = findSequenceRecordForHit(hit, sequenceMap);
      if (isTrashReference(seqRec) || isExcludedReference(seqRec)) continue;
      if (seqRec?.observationId) {
        const hitSpecies = getSpeciesNameFromHit(hit, sequenceMap, genbankMap, ednaSpeciesIdMap);
        if (hitSpecies && speciesNamesMatch(hitSpecies, sec99LocalConsensus)) {
          sec99HighIdObservations.add(String(seqRec.observationId));
        }
      }
    }
    for (const hit of localResult.hits) {
      const adjId = localAdjustedMap[hit.num];
      if (adjId === undefined) continue;
      if (adjId >= effectiveLowIdThreshold) continue;
      const hitSpecies = getSpeciesNameFromHit(hit, sequenceMap, genbankMap, ednaSpeciesIdMap);
      if (hitSpecies && speciesNamesMatch(hitSpecies, sec99LocalConsensus)) {
        const seqRec = findSequenceRecordForHit(hit, sequenceMap);
          if (isTrashReference(seqRec) || isExcludedReference(seqRec)) continue;
        if (seqRec?.observationId && sec99HighIdObservations.has(String(seqRec.observationId))) {
          sec99LowIdExcludedByHighId++;
          continue;
        }
        if (!isHitValidated(hit, sequenceMap, genbankMap)) {
          sec99LowIdExcludedByValidation++;
          continue;
        }
        sec99LowIdMatches.push({ identity: adjId, source: "local" });
      }
    }
    for (const hit of ncbiResult.hits) {
      const adjId = ncbiAdjustedMap[hit.num];
      let hitIdentity: number | null = null;
      if (adjId !== undefined) { hitIdentity = adjId; }
      else {
        const hsp = hit.hsps[0];
        if (hsp && hsp.alignLen > 0) hitIdentity = (hsp.identity / hsp.alignLen) * 100;
      }
      if (hitIdentity === null || hitIdentity >= effectiveLowIdThreshold) continue;
      let hitSpecies: string | null = null;
      if (ednaSpeciesIdMap && ednaSpeciesIdMap[hit.accession]) {
        hitSpecies = ednaSpeciesIdMap[hit.accession];
      } else if (genbankMap[hit.accession]) {
        const meta = genbankMap[hit.accession];
        hitSpecies = (meta.scientificName || meta.organism || null) as string | null;
      }
      if (!hitSpecies) hitSpecies = extractSpeciesName(hit.def);
      if (hitSpecies && speciesNamesMatch(hitSpecies, sec99LocalConsensus)) {
        sec99LowIdMatches.push({ identity: hitIdentity, source: "ncbi" });
      }
    }

    const sec99ValidatedHits = sec99QualifiedHits.filter(h => {
      return h.speciesName !== null && speciesNamesMatch(h.speciesName!, sec99LocalConsensus!);
    });
    const sec99ValidatedHitCount = isEdnaSequence ? sec99ValidatedHits.length : countSpecimens(sec99ValidatedHits);

    const sec99Breakdown = computeConfidenceScore({
      validatedHitCount: sec99ValidatedHitCount,
      validatedHitReads: sec99ValidatedHits.length,
      ncbiConsensusSpecies: sec99NcbiConsensus,
      ncbiConsensusCount: sec99NcbiCount,
      ncbiTotalWithSpecies: sec99NcbiTotal,
      localSpecies: sec99LocalConsensus,
      localConsensusCount: sec99LocalCount,
      localTotalWithSpecies: sec99LocalTotal,
      lowIdentityMatches: sec99LowIdMatches,
      familyMismatch: sec99FamilyMismatch,
      sourceRic: sourceRic ?? null,
      sourceSpeciesName: sourceSpeciesName ?? null,
      isOnlySequenceForRecord,
      isEdna: isEdnaSequence,
      ncbiQualifiedHitCount: sec99NcbiQualified.length,
      envBlastReplicationParam: envBlastReplication,
    });

    const originalBase = sec99Breakdown.baseScore;
    sec99Breakdown.baseScore = Math.round(originalBase / 2);
    sec99Breakdown.baseReason = `${validatedHitPhrase(sec99ValidatedHitCount, sec99ValidatedHits.length)} at >= ${effectiveSecondaryThreshold}% identity (halved: secondary threshold)`;
    const baseDelta = originalBase - sec99Breakdown.baseScore;
    sec99Breakdown.finalScore = Math.max(0, Math.min(100, sec99Breakdown.finalScore - baseDelta));

    result.confidenceBreakdown = sec99Breakdown;
    result.finalConfidence = sec99Breakdown.finalScore;

    const sec99ConfidenceDetails = [
      `Base: ${sec99Breakdown.baseScore}% (${sec99Breakdown.baseReason})`,
      `NCBI: ${sec99Breakdown.ncbiAdjustment >= 0 ? '+' : ''}${sec99Breakdown.ncbiAdjustment}% (${sec99Breakdown.ncbiReason})`,
      `Family mismatch: ${sec99Breakdown.familyMismatchPenalty > 0 ? '-' : ''}${sec99Breakdown.familyMismatchPenalty}% (${sec99Breakdown.familyMismatchReason})`,
      `Genus match: +${sec99Breakdown.genusMatchBonus}% (${sec99Breakdown.genusMatchReason})`,
      `Species match: +${sec99Breakdown.speciesMatchBonus}% (${sec99Breakdown.speciesMatchReason})`,
      `RiC penalty: ${sec99Breakdown.ricPenalty > 0 ? '-' : ''}${sec99Breakdown.ricPenalty}% (${sec99Breakdown.ricReason})`,
      ...(!isEdnaSequence ? [`Name agreement: ${sec99Breakdown.nameAgreementPenalty > 0 ? '-' : ''}${sec99Breakdown.nameAgreementPenalty} (${sec99Breakdown.nameAgreementReason})`] : []),
      `Low-ID penalty: ${sec99Breakdown.lowIdentityPenalty > 0 ? '-' : ''}${sec99Breakdown.lowIdentityPenalty}% (${sec99Breakdown.lowIdentityReason})`,
      ...(sec99LowIdExcludedByHighId > 0 ? [`(${sec99LowIdExcludedByHighId} low-ID MycoBLAST hit${sec99LowIdExcludedByHighId !== 1 ? 's' : ''} excluded - specimen also has high-ID hit)`] : []),
      ...(sec99LowIdExcludedByValidation > 0 ? [`(${sec99LowIdExcludedByValidation} low-ID MycoBLAST hit${sec99LowIdExcludedByValidation !== 1 ? 's' : ''} excluded - observation not validated)`] : []),
    ];
    if (sec99Breakdown.capApplied && sec99Breakdown.capReason) {
      sec99ConfidenceDetails.push(`Cap applied: ${sec99Breakdown.capReason}`);
    }
    sec99ConfidenceDetails.push(`Final confidence: ${sec99Breakdown.finalScore}%`);

    const sec99ConfidenceStatus: "pass" | "info" | "fail" = sec99Breakdown.finalScore >= 70 ? "pass" : sec99Breakdown.finalScore >= 50 ? "info" : "fail";

    addStep({
      step: `Secondary ${effectiveSecondaryThreshold}% Confidence Scoring`,
      status: sec99ConfidenceStatus,
      message: `Secondary confidence: ${sec99Breakdown.finalScore}% for "${sec99LocalConsensus}" (base halved for lower threshold)`,
      details: sec99ConfidenceDetails,
    });

    
    setDeterministicCurationRecommendations(result, localResult, ncbiResult, sequenceMap, localAdjustedMap, obsSpeciesMap, genbankMap, ncbiAdjustedMap);

    result.status = "complete";
    ports.logger.log(`[BatchAnalysis] Seq ${sequenceId}: Secondary ${effectiveSecondaryThreshold}% loop found species "${result.finalSpecies}" (${sec99Breakdown.finalScore}% confidence)`);
    return result;
  }

  // Secondary loop did not find a consensus either
  const sec99Details: string[] = [
    `Re-filtered at ${effectiveSecondaryThreshold}% threshold: ${sec99ValidHits.length} validated local hits, ${sec99TotalWithSpecies} with species names`,
  ];
  if (sec99LocalSorted.length > 0 && sec99TotalWithSpecies > 0) {
    const topEntry = sec99LocalSorted[0];
    const topRatio = topEntry[1].count / sec99TotalWithSpecies;
    sec99Details.push(`Top species: ${topEntry[1].canonical} at ${(topRatio * 100).toFixed(0)}% (needs ${(SPECIES_CONSENSUS_THRESHOLD * 100).toFixed(0)}%)`);
  } else {
    sec99Details.push("No valid species names found among secondary-threshold hits");
  }

  addStep({
    step: `Secondary ${effectiveSecondaryThreshold}% Analysis`,
    status: "fail",
    message: `Secondary analysis at ${effectiveSecondaryThreshold}% also found no consensus species`,
    details: sec99Details,
  });

  // ===== BROADENED TAXONOMY + UNCULTURED FALLBACK (eDNA, after secondary fails) =====
  if (isEdnaSequence && !result.finalSpecies && (!result.ncbiConsensusSpecies || (ncbiSortedNormalized.length > 0 && ncbiSortedNormalized[0][1].count / ncbiTotalWithSpecies < SPECIES_CONSENSUS_THRESHOLD))) {
    const BROADENED_IDENTITY_THRESHOLD = 90;
    const ncbiQueryLen = ncbiResult.queryLen || localResult.queryLen || 0;
    const broadenedHits: { speciesName: string }[] = [];
    let broadSkipNoName = 0;
    let broadSkipUncultured = 0;
    let broadSkipIdentity = 0;
    let broadSkipCoverage = 0;
    for (const hit of ncbiResult.hits) {
      let speciesName: string | null = null;
      if (ednaSpeciesIdMap && ednaSpeciesIdMap[hit.accession]) {
        speciesName = ednaSpeciesIdMap[hit.accession];
      } else if (genbankMap[hit.accession]) {
        const meta = genbankMap[hit.accession];
        speciesName = (meta.scientificName || meta.organism || null) as string | null;
      }
      if (!speciesName) speciesName = extractSpeciesName(hit.def);
      if (!isConsensusVoteName(speciesName)) { broadSkipNoName++; continue; }
      if (isUnculturedName(speciesName)) { broadSkipUncultured++; continue; }

      const adjIdentity = ncbiAdjustedMap[hit.num];
      if (adjIdentity !== undefined) {
        if (adjIdentity < BROADENED_IDENTITY_THRESHOLD) { broadSkipIdentity++; continue; }
      } else {
        const hsp = hit.hsps[0];
        if (!hsp) { broadSkipIdentity++; continue; }
        const rawIdentity = hsp.alignLen > 0 ? (hsp.identity / hsp.alignLen) * 100 : 0;
        if (rawIdentity < BROADENED_IDENTITY_THRESHOLD) { broadSkipIdentity++; continue; }
      }
      if (!meetsEdnaCoverageThreshold(hit, ncbiQueryLen, ampliconFamily)) { broadSkipCoverage++; continue; }
      broadenedHits.push({ speciesName });
    }

    if (broadenedHits.length > 0) {
      const uniqueSpecies = [...new Set(broadenedHits.map(h => h.speciesName))];
      const taxonomyMap: Record<string, { kingdom: string | null; phylum: string | null; family: string | null; class: string | null; order: string | null }> = {};
      for (const sp of uniqueSpecies) {
        let family = await edna.lookupFamily(sp);
        let order = await edna.lookupOrder(sp);
        let cls: string | null = null;
        let kingdom: string | null = null;
        let phylum: string | null = null;
        try {
          const cacheResult = await edna.classificationCacheRanks(sp);
          if (cacheResult.rows.length > 0) {
            const row = cacheResult.rows[0] as any;
            kingdom = row.kingdom || null;
            phylum = row.phylum || null;
            cls = row.class || null;
          }
          if (!cls) {
            const obsClsResult = await edna.observationClassRows(sp);
            if (obsClsResult.rows.length > 0) cls = obsClsResult.rows[0].class as string;
          }
        } catch {}

        if (!kingdom || !phylum || !family || !cls || !order) {
          const ncbiTax = await edna.lookupFullTaxonomyFromNCBI(sp);
          if (!kingdom && ncbiTax.kingdom) kingdom = ncbiTax.kingdom;
          if (!phylum && ncbiTax.phylum) phylum = ncbiTax.phylum;
          if (!family && ncbiTax.family) family = ncbiTax.family;
          if (!cls && ncbiTax.class) cls = ncbiTax.class;
          if (!order && ncbiTax.order) order = ncbiTax.order;
          if (ncbiTax.kingdom || ncbiTax.phylum || ncbiTax.family || ncbiTax.class || ncbiTax.order) {
            try {
              await edna.cacheClassification({ sp, kingdom, phylum, family, cls, order });
            } catch {}
          }
        }

        taxonomyMap[sp] = { kingdom, phylum, family, class: cls, order };
      }

      const broadenedDetails: string[] = [`Broadened search: ${broadenedHits.length} NCBI hits at >= ${BROADENED_IDENTITY_THRESHOLD}% identity, >= ${effectiveQueryCoverageThreshold}% query coverage (excluding uncultured)`];

      broadenedDetails.push("");
      broadenedDetails.push(`Species taxonomy lookup (${uniqueSpecies.length} unique species):`);
      for (const sp of uniqueSpecies) {
        const tax = taxonomyMap[sp];
        const hitCount = broadenedHits.filter(h => h.speciesName === sp).length;
        if (tax && (tax.kingdom || tax.phylum || tax.family || tax.class || tax.order)) {
          const parts: string[] = [];
          if (tax.kingdom) parts.push(`kingdom: ${tax.kingdom}`);
          if (tax.phylum) parts.push(`phylum: ${tax.phylum}`);
          if (tax.class) parts.push(`class: ${tax.class}`);
          if (tax.order) parts.push(`order: ${tax.order}`);
          if (tax.family) parts.push(`family: ${tax.family}`);
          broadenedDetails.push(`  ${sp} (${hitCount} hit${hitCount > 1 ? "s" : ""}): ${parts.join(", ")}`);
        } else {
          broadenedDetails.push(`  ${sp} (${hitCount} hit${hitCount > 1 ? "s" : ""}): no taxonomy resolved`);
        }
      }

      const taxonomicRanks: { rank: string; label: string; getter: (sp: string) => string | null }[] = [
        { rank: "kingdom", label: "Kingdom", getter: (sp) => taxonomyMap[sp]?.kingdom || null },
        { rank: "phylum", label: "Phylum", getter: (sp) => taxonomyMap[sp]?.phylum || null },
        { rank: "class", label: "Class", getter: (sp) => taxonomyMap[sp]?.class || null },
        { rank: "order", label: "Order", getter: (sp) => taxonomyMap[sp]?.order || null },
        { rank: "family", label: "Family", getter: (sp) => taxonomyMap[sp]?.family || null },
        { rank: "genus", label: "Genus", getter: (sp) => { const g = sp.split(/\s+/)[0]; return (g && /^[A-Z][a-z]+$/.test(g)) ? g : null; } },
      ];

      for (const { rank, label, getter } of taxonomicRanks) {
        const rankCounts = new Map<string, number>();
        let totalWithRank = 0;
        for (const h of broadenedHits) {
          const val = getter(h.speciesName);
          if (val) {
            rankCounts.set(val, (rankCounts.get(val) || 0) + 1);
            totalWithRank++;
          }
        }
        const sorted = Array.from(rankCounts.entries()).sort((a, b) => b[1] - a[1]);
        if (sorted.length > 0) {
          broadenedDetails.push("");
          broadenedDetails.push(`${label}-level consensus:`);
          for (const [name, count] of sorted) {
            broadenedDetails.push(`  ${name}: ${count}/${totalWithRank} (${((count / totalWithRank) * 100).toFixed(0)}%)`);
          }
          const [topName, topCount] = sorted[0];
          const topRatio = topCount / totalWithRank;
          if (topRatio >= SPECIES_CONSENSUS_THRESHOLD) {
            broadenedDetails.push(`${label} consensus: ${topName} (${(topRatio * 100).toFixed(0)}%)`);
            // Iteration goes coarsest (kingdom) → finest (genus). Overwrite on
            // each pass so we keep the FINEST rank that achieves consensus
            // (e.g. family-level "Archaeorhizomycetaceae" instead of
            // kingdom-level "Fungi" when both have 100%).
            ncbiBroadenedConsensus = { rank, name: topName, count: topCount, total: totalWithRank };
          } else {
            broadenedDetails.push(`No ${label.toLowerCase()} consensus (top: ${topName} at ${(topRatio * 100).toFixed(0)}%)`);
          }
        } else {
          broadenedDetails.push("");
          broadenedDetails.push(`${label}-level consensus:`);
          broadenedDetails.push(`  No ${label.toLowerCase()} data available`);
        }
      }

      const consensusStatus = ncbiBroadenedConsensus ? "pass" : "info";
      const consensusMsg = ncbiBroadenedConsensus
        ? `Broadened NCBI consensus at ${ncbiBroadenedConsensus.rank} level: ${ncbiBroadenedConsensus.name}`
        : `No taxonomic consensus found at family/class/order level among ${broadenedHits.length} NCBI hits at >= ${BROADENED_IDENTITY_THRESHOLD}%`;

      addStep({
        step: "NCBI Broadened Taxonomy Consensus",
        status: consensusStatus,
        message: consensusMsg,
        details: broadenedDetails,
      });

      if (ncbiBroadenedConsensus && !result.ncbiConsensusSpecies) {
        result.ncbiConsensusSpecies = ncbiBroadenedConsensus.name;
        result.ncbiConsensusCount = ncbiBroadenedConsensus.count ?? broadenedHits.length;
        result.ncbiConsensusTotalWithSpecies = ncbiBroadenedConsensus.total ?? broadenedHits.length;
        result.broadenedSource = `NCBI broadened taxonomy (${ncbiBroadenedConsensus.rank} level)`;
      }
    } else {
      const skipDetails: string[] = [
        `Broadened search: ${ncbiResult.hits.length} NCBI hits checked at >= ${BROADENED_IDENTITY_THRESHOLD}% identity (excluding uncultured)`,
        `0 hits qualified — breakdown of ${ncbiResult.hits.length} excluded:`,
      ];
      if (broadSkipNoName > 0) skipDetails.push(`  ${broadSkipNoName} — no valid species name`);
      if (broadSkipUncultured > 0) skipDetails.push(`  ${broadSkipUncultured} — uncultured (handled separately)`);
      if (broadSkipIdentity > 0) skipDetails.push(`  ${broadSkipIdentity} — identity below ${BROADENED_IDENTITY_THRESHOLD}%`);
      if (broadSkipCoverage > 0) skipDetails.push(`  ${broadSkipCoverage} — failed coverage threshold (< ${effectiveQueryCoverageThreshold}% QC or < ${COMBINED_COVERAGE_THRESHOLD}% combined QC+SC or QC/SC < ${Math.round(QC_SC_RATIO_THRESHOLD * 100)}%)`);
      addStep({
        step: "NCBI Broadened Taxonomy Consensus",
        status: "info",
        message: `No cultured NCBI hits at >= ${BROADENED_IDENTITY_THRESHOLD}% identity with adequate coverage`,
        details: skipDetails,
      });
      const primaryReason = broadSkipCoverage > 0 && broadSkipIdentity === 0
        ? `no cultured NCBI hits with adequate coverage (>= ${effectiveQueryCoverageThreshold}% QC or >= ${COMBINED_COVERAGE_THRESHOLD}% combined with QC/SC >= ${Math.round(QC_SC_RATIO_THRESHOLD * 100)}%)`
        : broadSkipIdentity > 0 && broadSkipCoverage === 0
          ? `no cultured NCBI hits at >= ${BROADENED_IDENTITY_THRESHOLD}% identity`
          : `no cultured NCBI hits at >= ${BROADENED_IDENTITY_THRESHOLD}% identity with adequate coverage`;
      singletonReasons.push(`Broadened: ${primaryReason}`);
    }

    const ncbiConsensusIsUncultured = result.ncbiConsensusSpecies ? isUnculturedName(result.ncbiConsensusSpecies) : false;
    if (!ncbiBroadenedConsensus && (!result.ncbiConsensusSpecies || ncbiConsensusIsUncultured) && !ncbiEdnaGenusConsensus && !localEdnaGenusConsensus) {
      const unculturedHits: { speciesName: string; originalName: string }[] = [];

      const unculturedNameMap: Record<string, string> = {
        "fungus": "Fungi",
        "soil": "Fungi",
        "soil fungus": "Fungi",
        "fungal": "Fungi",
        "organism": "Fungi",
        "eukaryote": "Eukaryota",
        "basidiomycete": "Basidiomycota",
        "basidiomycete yeast": "Basidiomycota",
        "ascomycete": "Ascomycota",
        "ectomycorrhiza": "Fungi",
        "ectomycorrhizal fungus": "Fungi",
        "mycorrhiza": "Fungi",
        "mycorrhizal fungus": "Fungi",
        "endophyte": "Fungi",
        "endophytic fungus": "Fungi",
        "bacterium": "Bacteria",
      };

      let uncultSkipNoName = 0;
      let uncultSkipNotUncultured = 0;
      let uncultSkipIdentity = 0;
      let uncultSkipCoverage = 0;
      let uncultSkipUnresolved = 0;
      for (const hit of ncbiResult.hits) {
        let speciesName: string | null = null;
        if (ednaSpeciesIdMap && ednaSpeciesIdMap[hit.accession]) {
          speciesName = ednaSpeciesIdMap[hit.accession];
        } else if (genbankMap[hit.accession]) {
          const meta = genbankMap[hit.accession];
          speciesName = (meta.scientificName || meta.organism || null) as string | null;
        }
        if (!speciesName) speciesName = extractSpeciesName(hit.def);
        if (!speciesName) { uncultSkipNoName++; continue; }

        if (!isUnculturedName(speciesName)) { uncultSkipNotUncultured++; continue; }

        const adjIdentity = ncbiAdjustedMap[hit.num];
        if (adjIdentity !== undefined) {
          if (adjIdentity < BROADENED_IDENTITY_THRESHOLD) { uncultSkipIdentity++; continue; }
        } else {
          const hsp = hit.hsps[0];
          if (!hsp) { uncultSkipIdentity++; continue; }
          const rawIdentity = hsp.alignLen > 0 ? (hsp.identity / hsp.alignLen) * 100 : 0;
          if (rawIdentity < BROADENED_IDENTITY_THRESHOLD) { uncultSkipIdentity++; continue; }
        }
        if (!meetsEdnaCoverageThreshold(hit, ncbiQueryLen, ampliconFamily)) { uncultSkipCoverage++; continue; }

        const stripped = speciesName.replace(/^uncultured\s+/i, "").trim();
        const mapped = unculturedNameMap[stripped.toLowerCase()] || null;
        const resolvedName = mapped || (stripped.charAt(0) === stripped.charAt(0).toUpperCase() ? stripped : null);
        if (!resolvedName) { uncultSkipUnresolved++; continue; }

        unculturedHits.push({ speciesName: resolvedName, originalName: speciesName });
      }

      if (unculturedHits.length > 0) {
        const unculturedDetails: string[] = [`Uncultured fallback: ${unculturedHits.length} NCBI hits at >= ${BROADENED_IDENTITY_THRESHOLD}% identity, >= ${effectiveQueryCoverageThreshold}% query coverage (uncultured names only)`];

        const nameCounts = new Map<string, number>();
        for (const h of unculturedHits) {
          nameCounts.set(h.speciesName, (nameCounts.get(h.speciesName) || 0) + 1);
        }

        const uniqueUnculturedNames = [...nameCounts.keys()];
        const unculturedTaxMap: Record<string, { genus: string | null; family: string | null; class: string | null; order: string | null; phylum: string | null; kingdom: string | null }> = {};

        for (const sp of uniqueUnculturedNames) {
          let genus: string | null = null;
          let family: string | null = null;
          let order: string | null = null;
          let cls: string | null = null;
          let phylum: string | null = null;
          let kingdom: string | null = null;

          const ncbiTax = await edna.lookupFullTaxonomyFromNCBI(sp);
          if ((ncbiTax as any).genus) genus = (ncbiTax as any).genus;
          if (ncbiTax.family) family = ncbiTax.family;
          if (ncbiTax.class) cls = ncbiTax.class;
          if (ncbiTax.order) order = ncbiTax.order;
          if ((ncbiTax as any).phylum) phylum = (ncbiTax as any).phylum;
          if ((ncbiTax as any).kingdom) kingdom = (ncbiTax as any).kingdom;

          if (!phylum || !kingdom) {
            try {
              const cacheResult = await edna.classificationCacheFull(sp);
              if (cacheResult.rows.length > 0) {
                const row = cacheResult.rows[0];
                if (!genus && row.genus) genus = row.genus as string;
                if (!family && row.family) family = row.family as string;
                if (!cls && row.class) cls = row.class as string;
                if (!order && row.order) order = row.order as string;
                if (!phylum && row.phylum) phylum = row.phylum as string;
                if (!kingdom && row.kingdom) kingdom = row.kingdom as string;
              }
            } catch {}
          }

          unculturedTaxMap[sp] = { genus, family, class: cls, order, phylum, kingdom };
        }

        unculturedDetails.push("");
        unculturedDetails.push(`Uncultured taxonomy lookup (${uniqueUnculturedNames.length} unique resolved names):`);
        for (const name of uniqueUnculturedNames) {
          const tax = unculturedTaxMap[name];
          const hitCount = nameCounts.get(name) || 0;
          if (tax && (tax.genus || tax.family || tax.order || tax.class || tax.phylum || tax.kingdom)) {
            const parts: string[] = [];
            if (tax.genus) parts.push(`genus: ${tax.genus}`);
            if (tax.family) parts.push(`family: ${tax.family}`);
            if (tax.order) parts.push(`order: ${tax.order}`);
            if (tax.class) parts.push(`class: ${tax.class}`);
            if (tax.phylum) parts.push(`phylum: ${tax.phylum}`);
            if (tax.kingdom) parts.push(`kingdom: ${tax.kingdom}`);
            unculturedDetails.push(`  ${name} (${hitCount} hit${hitCount > 1 ? "s" : ""}): ${parts.join(", ")}`);
          } else {
            unculturedDetails.push(`  ${name} (${hitCount} hit${hitCount > 1 ? "s" : ""}): no taxonomy resolved`);
          }
        }

        const sorted = Array.from(nameCounts.entries()).sort((a, b) => b[1] - a[1]);
        const [topName, topCount] = sorted[0];
        const topRatio = topCount / unculturedHits.length;

        if (topRatio >= SPECIES_CONSENSUS_THRESHOLD) {
          ncbiBroadenedConsensus = { rank: "uncultured", name: topName };
          unculturedDetails.push("");
          unculturedDetails.push(`Resolved-name consensus: ${topName} — ${topCount}/${unculturedHits.length} (${(topRatio * 100).toFixed(0)}%)`);
          if (!result.ncbiConsensusSpecies) {
            result.ncbiConsensusSpecies = topName;
            result.ncbiConsensusCount = topCount;
            result.ncbiConsensusTotalWithSpecies = unculturedHits.length;
            result.broadenedSource = "NCBI uncultured taxonomy fallback (uncultured level)";
          }
        } else {
          unculturedDetails.push("");
          unculturedDetails.push(`No resolved-name consensus (top: ${topName} at ${(topRatio * 100).toFixed(0)}%, need >= ${(SPECIES_CONSENSUS_THRESHOLD * 100).toFixed(0)}%)`);
        }

        const taxRanks: { rank: string; label: string; getter: (sp: string) => string | null }[] = [
          { rank: "genus", label: "Genus", getter: (sp) => unculturedTaxMap[sp]?.genus || null },
          { rank: "family", label: "Family", getter: (sp) => unculturedTaxMap[sp]?.family || null },
          { rank: "order", label: "Order", getter: (sp) => unculturedTaxMap[sp]?.order || null },
          { rank: "class", label: "Class", getter: (sp) => unculturedTaxMap[sp]?.class || null },
          { rank: "phylum", label: "Phylum", getter: (sp) => unculturedTaxMap[sp]?.phylum || null },
          { rank: "kingdom", label: "Kingdom", getter: (sp) => unculturedTaxMap[sp]?.kingdom || null },
        ];

        for (const { rank, label, getter } of taxRanks) {
          const rankCounts = new Map<string, number>();
          let totalWithRank = 0;
          for (const h of unculturedHits) {
            const val = getter(h.speciesName);
            if (val) {
              rankCounts.set(val, (rankCounts.get(val) || 0) + 1);
              totalWithRank++;
            }
          }
          if (rankCounts.size > 0) {
            const rSorted = Array.from(rankCounts.entries()).sort((a, b) => b[1] - a[1]);
            unculturedDetails.push("");
            unculturedDetails.push(`${label}-level consensus:`);
            for (const [name, count] of rSorted) {
              unculturedDetails.push(`  ${name}: ${count}/${totalWithRank} (${((count / totalWithRank) * 100).toFixed(0)}%)`);
            }
            const [rTopName, rTopCount] = rSorted[0];
            const rTopRatio = rTopCount / totalWithRank;
            if (rTopRatio >= SPECIES_CONSENSUS_THRESHOLD) {
              unculturedDetails.push(`${label} consensus: ${rTopName} (${(rTopRatio * 100).toFixed(0)}%)`);
              if (!ncbiBroadenedConsensus) {
                ncbiBroadenedConsensus = { rank, name: rTopName };
                if (!result.ncbiConsensusSpecies) {
                  result.ncbiConsensusSpecies = rTopName;
                  result.ncbiConsensusCount = rTopCount;
                  result.ncbiConsensusTotalWithSpecies = totalWithRank;
                  result.broadenedSource = `NCBI uncultured taxonomy fallback (${rank} level)`;
                }
              }
            } else {
              unculturedDetails.push(`No ${label.toLowerCase()} consensus (top: ${rTopName} at ${(rTopRatio * 100).toFixed(0)}%)`);
            }
          } else {
            unculturedDetails.push("");
            unculturedDetails.push(`${label}-level consensus:`);
            unculturedDetails.push(`  No ${label.toLowerCase()} data available`);
          }
        }

        if (!ncbiBroadenedConsensus && unculturedHits.length >= 2) {
          const pluralitySorted = Array.from(nameCounts.entries()).sort((a, b) => b[1] - a[1]);
          const [pluralityName, pluralityCount] = pluralitySorted[0];
          const pluralityRatio = pluralityCount / unculturedHits.length;
          ncbiBroadenedConsensus = { rank: "uncultured-plurality", name: pluralityName };
          unculturedDetails.push("");
          unculturedDetails.push(`No consensus at >= ${(SPECIES_CONSENSUS_THRESHOLD * 100).toFixed(0)}% threshold at any taxonomic rank`);
          unculturedDetails.push(`Plurality fallback: ${pluralityName} is most common with ${pluralityCount}/${unculturedHits.length} hits (${(pluralityRatio * 100).toFixed(0)}%)`);
          if (!result.ncbiConsensusSpecies) {
            result.ncbiConsensusSpecies = pluralityName;
            result.ncbiConsensusCount = pluralityCount;
            result.ncbiConsensusTotalWithSpecies = unculturedHits.length;
            result.broadenedSource = `NCBI uncultured taxonomy fallback (plurality — ${pluralityName} ${pluralityCount}/${unculturedHits.length})`;
          }
        }

        unculturedDetails.push("");
        unculturedDetails.push("--- Confidence scoring (uncultured) ---");
        if (ncbiBroadenedConsensus) {
          const rankConfidenceBase: Record<string, number> = {
            genus: 30, family: 20, order: 15, class: 10, phylum: 5, kingdom: 3, uncultured: 10, "uncultured-plurality": 3,
          };
          const baseConf = rankConfidenceBase[ncbiBroadenedConsensus.rank] ?? 3;
          unculturedDetails.push(`Rank base confidence: ${baseConf}% (${ncbiBroadenedConsensus.rank} level → ${ncbiBroadenedConsensus.name})`);

          const hitReplicationBonus = Math.min(15, Math.floor(unculturedHits.length / 2));
          unculturedDetails.push(`Hit replication bonus: +${hitReplicationBonus}% (${unculturedHits.length} uncultured hits, +1% per 2 hits, max 15%)`);

          const consensusCount = result.ncbiConsensusCount || 0;
          const consensusTotal = result.ncbiConsensusTotalWithSpecies || unculturedHits.length;
          const consensusRatio = consensusTotal > 0 ? consensusCount / consensusTotal : 0;
          const agreementBonus = consensusRatio >= 0.9 ? 5 : consensusRatio >= 0.75 ? 3 : 0;
          unculturedDetails.push(`Agreement bonus: +${agreementBonus}% (${consensusCount}/${consensusTotal} = ${(consensusRatio * 100).toFixed(0)}% consensus${consensusRatio >= 0.9 ? " — strong" : consensusRatio >= 0.75 ? " — moderate" : " — weak"})`);

          const totalUnculturedConfidence = Math.min(50, baseConf + hitReplicationBonus + agreementBonus);
          unculturedDetails.push(`Total uncultured confidence: ${totalUnculturedConfidence}% (capped at 50%)`);
        } else {
          unculturedDetails.push("No consensus reached — confidence: 0%");
        }

        addStep({
          step: "NCBI Uncultured Taxonomy Fallback",
          status: ncbiBroadenedConsensus ? "pass" : "info",
          message: ncbiBroadenedConsensus
            ? `Uncultured consensus at ${ncbiBroadenedConsensus.rank} level: ${ncbiBroadenedConsensus.name}`
            : `No taxonomic consensus found from ${unculturedHits.length} uncultured NCBI hits`,
          details: unculturedDetails,
        });
      } else {
        const uncultSkipDetails: string[] = [
          `Uncultured fallback: ${ncbiResult.hits.length} NCBI hits checked for uncultured names at >= ${BROADENED_IDENTITY_THRESHOLD}% identity`,
          `0 uncultured hits qualified — breakdown of ${ncbiResult.hits.length} excluded:`,
        ];
        if (uncultSkipNotUncultured > 0) uncultSkipDetails.push(`  ${uncultSkipNotUncultured} — not uncultured (already checked in broadened step)`);
        if (uncultSkipNoName > 0) uncultSkipDetails.push(`  ${uncultSkipNoName} — no species name`);
        if (uncultSkipIdentity > 0) uncultSkipDetails.push(`  ${uncultSkipIdentity} — identity below ${BROADENED_IDENTITY_THRESHOLD}%`);
        if (uncultSkipCoverage > 0) uncultSkipDetails.push(`  ${uncultSkipCoverage} — failed coverage threshold`);
        if (uncultSkipUnresolved > 0) uncultSkipDetails.push(`  ${uncultSkipUnresolved} — uncultured name could not be resolved to taxonomy`);
        addStep({
          step: "NCBI Uncultured Taxonomy Fallback",
          status: "info",
          message: `No uncultured NCBI hits at >= ${BROADENED_IDENTITY_THRESHOLD}% identity with adequate coverage`,
          details: uncultSkipDetails,
        });
        singletonReasons.push(`Uncultured fallback: no qualifying uncultured NCBI hits`);
      }
    }

    // Bacterial 16S kingdom-level fallback: bacterial eDNA sequences should
    // never end up in manual validation just because no taxonomic consensus
    // could be reached. Force a kingdom-level "Bacteria" consensus so the
    // downstream temp-code generator assigns the next "Bacteria sp. 'envNNN'".
    if (!ncbiBroadenedConsensus && isBacterial16s) {
      ncbiBroadenedConsensus = { rank: "kingdom", name: "Bacteria" };
      if (!result.ncbiConsensusSpecies) {
        result.ncbiConsensusSpecies = "Bacteria";
        result.ncbiConsensusCount = 0;
        result.ncbiConsensusTotalWithSpecies = 0;
        result.broadenedSource = "Bacterial 16S kingdom-level fallback";
      }
      addStep({
        step: "Bacterial 16S Kingdom Fallback",
        status: "pass",
        message: "Bacterial 16S sequence — assigning kingdom-level Bacteria temp code",
        details: [
          "No species/genus/family/etc. consensus could be reached for this bacterial 16S sequence",
          "Bacterial eDNA variants without consensus are auto-assigned a Bacteria sp. 'envNNN' temp code rather than going to manual validation",
        ],
      });
    }

    if (ncbiBroadenedConsensus) {
      const broadenedName = ncbiBroadenedConsensus.name;
      const broadenedRank = ncbiBroadenedConsensus.rank;
      const ednaVariantIdStr = sequenceId.replace("edna-", "");
      const ednaVariantIdNum = parseInt(ednaVariantIdStr, 10);

      if (!isNaN(ednaVariantIdNum)) {
        result.ednaGenusConsensus = broadenedName;

        addStep({
          step: "eDNA Broadened Consensus & Temp Code",
          status: "running",
          message: `Generating temp code for broadened ${broadenedRank}: ${broadenedName}...`,
        });

        try {
          let tempCode: string;
          // Kingdom-level fallback names are coarser than family/genus broadened
          // consensus and should NOT be reused when a finer consensus exists —
          // otherwise the variants tab keeps a stale "Fungi sp. 'envNNN'" code
          // while the BLAST tab mints a fresh family-level code, diverging.
          const KINGDOM_FALLBACK_GENERA = new Set([
            "fungi", "bacteria", "archaea", "eukarya", "eukaryota",
            "plantae", "animalia", "protista", "chromista",
          ]);
          const isKingdomFallback = (name: string | null | undefined): boolean => {
            if (!name) return false;
            const m = name.match(/^([^\s]+)\s+sp\./i);
            if (!m) return false;
            return KINGDOM_FALLBACK_GENERA.has(m[1].toLowerCase());
          };
          const broadenedIsFinerThanKingdom = broadenedRank !== "kingdom"
            && !KINGDOM_FALLBACK_GENERA.has(broadenedName.toLowerCase());

          let variantExistingEdnaId: string | null = null;
          const varRow = await edna.variantSpeciesId(ednaVariantIdNum);
          if (varRow?.ednaSpeciesId && /sp\.\s*'env\d+'/i.test(varRow.ednaSpeciesId)) {
            const existingGenus = varRow.ednaSpeciesId.split(" sp.")[0];
            if (existingGenus.toLowerCase() === broadenedName.toLowerCase()) {
              variantExistingEdnaId = varRow.ednaSpeciesId;
            } else if (isKingdomFallback(varRow.ednaSpeciesId) && broadenedIsFinerThanKingdom) {
              // Upgrade: existing is kingdom-level, new consensus is finer — let
              // the code below mint a fresh family/genus-level temp code so the
              // rename is recorded via setVariantEdnaSpeciesId.
              variantExistingEdnaId = null;
            }
          }

          const consensusCandidate = (result.ncbiConsensusSpecies && /sp\.\s*'env\d+'/i.test(result.ncbiConsensusSpecies))
            ? result.ncbiConsensusSpecies
            : (result.finalSpecies && /sp\.\s*'env\d+'/i.test(result.finalSpecies))
              ? result.finalSpecies
              : null;
          const consensusCandidateUsable = consensusCandidate
            && !(isKingdomFallback(consensusCandidate) && broadenedIsFinerThanKingdom);

          const existingEdnaId = variantExistingEdnaId
            || (consensusCandidateUsable ? consensusCandidate : null);

          if (existingEdnaId) {
            tempCode = existingEdnaId;
          } else {
            const pattern = `${broadenedName} sp. 'env%'`;
            const existing = await edna.speciesIdNamesLike(pattern);

            let maxNum = 0;
            for (const row of existing) {
              const match = row.scientificName.match(/env(\d+)/);
              if (match) {
                const num = parseInt(match[1], 10);
                if (num > maxNum) maxNum = num;
              }
            }
            const nextNum = maxNum + 1;
            tempCode = `${broadenedName} sp. 'env${String(nextNum).padStart(3, "0")}'`;
          }
          result.ednaTempCode = tempCode;

          const qualifyingAccessions: { accession: string; source: string }[] = [];
          const queryLen = localResult.queryLen || ncbiResult.queryLen || 0;

          for (const hit of ncbiResult.hits) {
            const adjId = ncbiAdjustedMap[hit.num];
            let hitIdentity: number | null = null;
            if (adjId !== undefined) {
              hitIdentity = adjId;
            } else {
              const hsp = hit.hsps[0];
              if (hsp && hsp.alignLen > 0) {
                hitIdentity = (hsp.identity / hsp.alignLen) * 100;
              }
            }
            if (hitIdentity === null || hitIdentity < EDNA_ADJUSTED_IDENTITY_THRESHOLD) continue;
            if (!meetsEdnaCoverageThreshold(hit, ncbiResult.queryLen || queryLen, ampliconFamily)) continue;
            qualifyingAccessions.push({ accession: hit.accession, source: "ncbi" });
          }

          for (const hit of localResult.hits) {
            const adjId = localAdjustedMap[hit.num];
            let hitIdentity: number | null = null;
            if (adjId !== undefined) {
              hitIdentity = adjId;
            } else {
              const hsp = hit.hsps[0];
              if (hsp && hsp.alignLen > 0) {
                hitIdentity = (hsp.identity / hsp.alignLen) * 100;
              }
            }
            if (hitIdentity === null || hitIdentity < EDNA_ADJUSTED_IDENTITY_THRESHOLD) continue;
            if (!meetsEdnaCoverageThreshold(hit, localResult.queryLen || queryLen, ampliconFamily)) continue;
            qualifyingAccessions.push({ accession: hit.accession, source: "mycoblast" });
          }

          try {
            const variantRow = await edna.variantEnvBlastFile(ednaVariantIdNum);
            const envXml = edna.readEdnaBlastXml(variantRow?.envBlastFile);
            if (envXml) {
              const envResult = edna.parseBlastXml(envXml);
              if (envResult && envResult.hits.length > 0) {
                for (const { hit, variantId } of qualifyingEnvBlastHits(envResult, ednaVariantIdStr, EDNA_ADJUSTED_IDENTITY_THRESHOLD, envResult.queryLen || queryLen, ampliconFamily)) {
                  const envAccession = variantId ? `variant-${variantId}` : (hit.def || `envblast-${hit.num}`);
                  qualifyingAccessions.push({ accession: envAccession, source: "envblast" });
                }
              }
            }
          } catch (envErr: any) {
            ports.logger.warn(`[BatchAnalysis] Seq ${sequenceId}: Failed to load envBLAST for broadened temp code:`, envErr.message);
          }

          if (qualifyingAccessions.length > 0) {
            let appliedCount = 0;
            let renamedCount = 0;
            let skippedExisting = 0;
            const skippedAccessions: string[] = [];
            const renamedAccessions: string[] = [];
            const taxonomy = await edna.resolveTaxonomy(tempCode);
            const { renameEdnaSpeciesId, setVariantEdnaSpeciesId } = await edna.ednaSynonyms();

            for (const acc of qualifyingAccessions) {
              const existingRows = await edna.speciesIdRowsFor(acc);

              if (existingRows.length > 0) {
                const existing = existingRows[0];
                if (existing.scientificName === tempCode) {
                  skippedExisting++;
                  continue;
                }
                // Preserve human-curated rows; rename anything else
                // (analyzer-, batch-, or legacy-null-owned).
                if (existing.updatedBy === "manual-edit") {
                  skippedExisting++;
                  skippedAccessions.push(`${acc.accession} (${acc.source}) → kept curated "${existing.scientificName}"`);
                  continue;
                }
                await renameEdnaSpeciesId({
                  id: existing.id,
                  accession: acc.accession,
                  source: acc.source,
                  newName: tempCode,
                  taxonomy,
                  changedBy: `server-analysis:${sequenceId}`,
                  reason: `analyzer re-applied broadened ${broadenedRank} consensus: ${broadenedName}`,
                });
                renamedCount++;
                renamedAccessions.push(`${acc.accession} (${acc.source}): ${existing.scientificName} → ${tempCode}`);
                continue;
              }

              await edna.upsertAnalyzerSpeciesId({ acc, tempCode, sequenceId, taxonomy });
              appliedCount++;
            }

            {
              await setVariantEdnaSpeciesId({
                variantId: ednaVariantIdNum,
                newName: tempCode,
                changedBy: `server-analysis:${sequenceId}`,
                reason: `analyzer broadened ${broadenedRank} consensus: ${broadenedName}`,
              });
            }

            result.ednaAppliedCount = appliedCount;
            result.ednaSkippedExisting = skippedExisting;

            const details = [
              `Consensus: ${broadenedName} (from NCBI broadened ${broadenedRank})`,
              existingEdnaId ? `Reusing existing eDNA ID: ${tempCode}` : `Temp code: ${tempCode}`,
              `Applied eDNA ID to ${appliedCount} new record(s) (>= ${EDNA_ADJUSTED_IDENTITY_THRESHOLD}% identity, >= ${effectiveQueryCoverageThreshold}% query coverage)`,
              `Set variant eDNA ID to: ${tempCode}`,
            ];
            if (renamedCount > 0) {
              details.push(`Renamed ${renamedCount} previously analyzer-assigned record(s) to match new consensus`);
              for (const r of renamedAccessions.slice(0, 10)) {
                details.push(`  Renamed: ${r}`);
              }
              if (renamedAccessions.length > 10) {
                details.push(`  ... and ${renamedAccessions.length - 10} more`);
              }
            }
            if (skippedExisting > 0) {
              details.push(`${skippedExisting} record(s) already current or curated — skipped`);
              for (const skipped of skippedAccessions.slice(0, 10)) {
                details.push(`  Skipped: ${skipped}`);
              }
              if (skippedAccessions.length > 10) {
                details.push(`  ... and ${skippedAccessions.length - 10} more`);
              }
            }

            result.steps[result.steps.length - 1] = {
              step: "eDNA Broadened Consensus & Temp Code",
              status: "pass",
              message: `eDNA temp code assigned: ${tempCode} (${appliedCount} records)`,
              details,
            };
            result.finalSpecies = tempCode;
            const rankConfidence: Record<string, number> = {
              genus: 30,
              family: 20,
              order: 15,
              class: 10,
              phylum: 5,
              kingdom: 3,
              uncultured: 10,
              "uncultured-plurality": 3,
            };
            const broadenedRankBase = rankConfidence[broadenedRank] ?? 3;

            const consensusHitCount = result.ncbiConsensusTotalWithSpecies || 0;
            const hitReplicationBonus = Math.min(15, Math.floor(consensusHitCount / 2));
            const bConsensusCount = result.ncbiConsensusCount || 0;
            const bConsensusRatio = consensusHitCount > 0 ? bConsensusCount / consensusHitCount : 0;
            const agreementBonus = bConsensusRatio >= 0.9 ? 5 : bConsensusRatio >= 0.75 ? 3 : 0;

            const broadenedBaseConf = broadenedRankBase + hitReplicationBonus + agreementBonus;

            const isUnculturedOnlyBroadened = !!(result.broadenedSource && result.broadenedSource.includes("uncultured"));
            const unculturedPenaltyBroadened = isUnculturedOnlyBroadened ? 20 : 0;
            const broadenedFinalConf = Math.max(0, Math.min(50, broadenedBaseConf - unculturedPenaltyBroadened));
            result.finalConfidence = broadenedFinalConf;
            const baseReasonParts = [`Rank base: ${broadenedRankBase}% (${broadenedRank} level → ${broadenedName})`];
            if (hitReplicationBonus > 0) baseReasonParts.push(`hit replication: +${hitReplicationBonus}% (${consensusHitCount} hits)`);
            if (agreementBonus > 0) baseReasonParts.push(`agreement: +${agreementBonus}% (${(bConsensusRatio * 100).toFixed(0)}% consensus)`);
            result.confidenceBreakdown = {
              baseScore: broadenedBaseConf,
              baseReason: baseReasonParts.join(", "),
              ncbiAdjustment: 0,
              ncbiReason: "N/A (broadened consensus)",
              familyMismatchPenalty: 0,
              familyMismatchReason: "N/A",
              genusMatchBonus: 0,
              genusMatchReason: "N/A",
              speciesMatchBonus: 0,
              speciesMatchReason: "N/A",
              ricPenalty: 0,
              ricReason: "N/A (broadened consensus)",
              ricPenaltyWaived: false,
              nameAgreementPenalty: 0,
              nameAgreementReason: "N/A",
              nameAgreementPct: null,
              lowIdentityPenalty: 0,
              lowIdentityReason: "N/A",
              capApplied: false,
              capReason: null,
              finalScore: broadenedFinalConf,
              validatedHitCount: appliedCount,
              ncbiMatchType: "no_consensus",
              ncbiRecordCount: 0,
              lowIdentityOccurrences: 0,
              deepOccurrences: 0,
              envBlastReplicationBonus: 0,
              envBlastReplicationReason: "N/A (broadened consensus)",
              envBlastReplicatingSamples: 0,
              envBlastReplicatingVariants: 0,
              envBlastSampleRic: 0,
              envBlastVariantRic: 0,
              unculturedPenalty: unculturedPenaltyBroadened,
              unculturedPenaltyReason: isUnculturedOnlyBroadened
                ? "Uncultured-only penalty: -20% (identification based entirely on uncultured NCBI hits)"
                : "No uncultured penalty",
            };
          } else {
            if (ednaIsMultiVariant) {
              result.steps[result.steps.length - 1] = {
                step: "Manual Validation Required",
                status: "skip",
                message: `Manual validation needed — no qualifying hits at >= ${EDNA_ADJUSTED_IDENTITY_THRESHOLD}% identity across any BLAST source`,
                details: [
                  `Consensus: ${broadenedName} (from NCBI broadened ${broadenedRank})`,
                  `Temp code: ${tempCode}`,
                  `No hits found at >= ${EDNA_ADJUSTED_IDENTITY_THRESHOLD}% identity and >= ${effectiveQueryCoverageThreshold}% query coverage in NCBI, MycoBLAST, or envBLAST`,
                  `Sequence has ${ednaVariantSiblingCount} variants — not a singleton, so this variant is held for manual validation rather than auto-labeled as "Singleton Sequence"`,
                ],
              };
              result.finalSpecies = "Manual Validation Needed";
              result.finalConfidence = 0;
              result.ednaTempCode = tempCode;
            } else {
              const rescue = await edna.findEnvBlastSiblingEdnaId(ednaVariantIdNum, ednaVariantIdStr, queryLen, ampliconFamily);
              if (rescue) {
                try {
                  const { setVariantEdnaSpeciesId } = await edna.ednaSynonyms();
                  await setVariantEdnaSpeciesId({
                    variantId: ednaVariantIdNum,
                    newName: rescue.siblingEdnaId,
                    changedBy: `server-analysis:${sequenceId}`,
                    reason: "envBLAST sibling rescue (broadened path)",
                  });
                } catch (err: any) {
                  ports.logger.warn(`[BatchAnalysis] Seq ${sequenceId}: setVariantEdnaSpeciesId failed during envBLAST sibling rescue:`, err?.message || err);
                }
                result.steps[result.steps.length - 1] = {
                  step: "eDNA Broadened Consensus & Temp Code",
                  status: "pass",
                  message: `Adopted env-coded ID from envBLAST sibling: ${rescue.siblingEdnaId}`,
                  details: [
                    `Consensus: ${broadenedName} (from NCBI broadened ${broadenedRank})`,
                    `Not a singleton — ${rescue.matchCount} sibling variant(s) matched in envBLAST at >= ${EDNA_ADJUSTED_IDENTITY_THRESHOLD}% identity`,
                    `Reusing existing eDNA ID: ${rescue.siblingEdnaId}`,
                    `Set variant eDNA ID to: ${rescue.siblingEdnaId}`,
                  ],
                };
                result.finalSpecies = rescue.siblingEdnaId;
                result.finalConfidence = 0;
                result.ednaTempCode = rescue.siblingEdnaId;
              } else {
                const singletonName = `Singleton Sequence - ${tempCode}`;
                result.steps[result.steps.length - 1] = {
                  step: "eDNA Broadened Consensus & Temp Code",
                  status: "info",
                  message: `Singleton — no qualifying hits at >= ${EDNA_ADJUSTED_IDENTITY_THRESHOLD}% identity across any BLAST source`,
                  details: [
                    `Consensus: ${broadenedName} (from NCBI broadened ${broadenedRank})`,
                    `Temp code: ${tempCode}`,
                    `No hits found at >= ${EDNA_ADJUSTED_IDENTITY_THRESHOLD}% identity and >= ${effectiveQueryCoverageThreshold}% query coverage in NCBI, MycoBLAST, or envBLAST`,
                    `Result: ${singletonName}`,
                  ],
                };
                result.finalSpecies = singletonName;
                result.finalConfidence = 0;
                result.ednaTempCode = tempCode;
              }
            }
          }
        } catch (err: any) {
          result.steps[result.steps.length - 1] = {
            step: "eDNA Broadened Consensus & Temp Code",
            status: "fail",
            message: `Error generating eDNA temp code: ${err.message}`,
            details: [`Consensus: ${broadenedName} (from NCBI broadened ${broadenedRank})`, `Error: ${err.message}`],
          };
        }
      }
    }

    if (result.finalSpecies) {
      setDeterministicCurationRecommendations(result, localResult, ncbiResult, sequenceMap, localAdjustedMap, obsSpeciesMap, genbankMap, ncbiAdjustedMap);
      result.status = "complete";
      return result;
    }
  }

    if (isEdnaSequence) {
    if (ednaIsMultiVariant) {
      let bacterialFallbackAssigned = false;
      if (isBacterial16s) {
        try {
          const ednaVariantIdNum = parseInt(sequenceId.replace(/^edna-/, ""), 10);
          if (!Number.isNaN(ednaVariantIdNum)) {
            const fallbackBase = "Bacteria";
            let tempCode: string | null = null;

            const varRow = await edna.variantSpeciesId(ednaVariantIdNum);
            if (varRow?.ednaSpeciesId && /sp\.\s*'env\d+'/i.test(varRow.ednaSpeciesId)) {
              const existingGenus = varRow.ednaSpeciesId.split(" sp.")[0];
              if (existingGenus.toLowerCase() === fallbackBase.toLowerCase()) {
                tempCode = varRow.ednaSpeciesId;
              }
            }

            if (!tempCode) {
              const pattern = `${fallbackBase} sp. 'env%'`;
              const existing = await edna.speciesIdNamesLike(pattern);
              let maxNum = 0;
              for (const row of existing) {
                const match = row.scientificName.match(/env(\d+)/);
                if (match) {
                  const num = parseInt(match[1], 10);
                  if (num > maxNum) maxNum = num;
                }
              }
              const nextNum = maxNum + 1;
              tempCode = `${fallbackBase} sp. 'env${String(nextNum).padStart(3, "0")}'`;
            }

            // Reserve the env code in ednaSpeciesIds so subsequent allocations
            // don't reuse the same number. There are no qualifying BLAST hits
            // in this branch, so we insert a synthetic placeholder accession
            // keyed by variant id (unique on (accession, source)).
            {
              const placeholderAccession = `edna-variant-${ednaVariantIdNum}`;
              const placeholderSource = "placeholder";
              const priorRow = await edna.placeholderSpeciesIdName({ placeholderAccession, placeholderSource });
              const priorName = priorRow?.scientificName ?? null;

              await edna.upsertPlaceholderSpeciesId({ placeholderAccession, placeholderSource, tempCode, fallbackBase, sequenceId });

              if (priorName && priorName !== tempCode) {
                try {
                  await edna.recordPlaceholderSynonym({ priorName, tempCode, placeholderAccession, placeholderSource, sequenceId });
                } catch (synErr) {
                  ports.logger.error(`[ednaSynonyms] Failed to record placeholder synonym ${priorName} → ${tempCode}:`, synErr);
                  throw synErr;
                }
              }
            }

            {
              const { setVariantEdnaSpeciesId } = await edna.ednaSynonyms();
              await setVariantEdnaSpeciesId({
                variantId: ednaVariantIdNum,
                newName: tempCode,
                changedBy: `server-analysis:${sequenceId}`,
                reason: `bacterial default temp code`,
              });
            }

            result.finalSpecies = tempCode;
            result.finalConfidence = 0;
            result.ednaTempCode = tempCode;
            addStep({
              step: "Bacterial Default Temp Code",
              status: "info",
              message: `Assigned default bacterial temp code: ${tempCode}`,
              details: [
                ...(singletonReasons.length > 0
                  ? singletonReasons
                  : [`No species could be determined at ${effectiveIdentityThreshold}% or ${effectiveSecondaryThreshold}% thresholds`]),
                `Sequence has ${ednaVariantSiblingCount} variants — not a singleton`,
                `No genus/broadened consensus available; falling back to default base "${fallbackBase}"`,
                `Result: ${tempCode}`,
              ],
            });
            bacterialFallbackAssigned = true;
          }
        } catch (err: any) {
          ports.logger.error(`[BatchAnalysis] Seq ${sequenceId}: Failed to assign bacterial default temp code:`, err?.message || err);
        }
      }

      if (!bacterialFallbackAssigned) {
        result.finalSpecies = "Manual Validation Needed";
        result.finalConfidence = 0;
        const summaryMsg = singletonReasons.length > 0
          ? `Manual validation needed — ${singletonReasons[singletonReasons.length - 1]}`
          : "Manual validation needed — no species could be determined";
        addStep({
          step: "Manual Validation Required",
          status: "skip",
          message: summaryMsg,
          details: [
            ...(singletonReasons.length > 0
              ? singletonReasons
              : [`No species could be determined at ${effectiveIdentityThreshold}% or ${effectiveSecondaryThreshold}% thresholds`]),
            `Sequence has ${ednaVariantSiblingCount} variants — not a singleton, so this variant is held for manual validation rather than auto-labeled as "Singleton Sequence"`,
          ],
        });
      }
    } else {
      // Before declaring singleton, check envBLAST for any qualifying sibling
      // variant (>= EDNA_ADJUSTED_IDENTITY_THRESHOLD identity + coverage). If a
      // sibling already carries an env-coded eDNA ID, adopt it — this isn't a
      // singleton; the same sequence has been seen elsewhere and already named.
      let envRescueName: string | null = null;
      const envRescueMatches: { variantId: string; identity: number; name: string | null }[] = [];
      try {
        const ednaVariantIdNum = parseInt(sequenceId.replace(/^edna-/, ""), 10);
        const ednaVariantIdStr = String(ednaVariantIdNum);
        if (!Number.isNaN(ednaVariantIdNum)) {
          const variantRow = await edna.variantEnvBlastFile(ednaVariantIdNum);
          const envXml = edna.readEdnaBlastXml(variantRow?.envBlastFile);
          if (envXml) {
            const envResult = edna.parseBlastXml(envXml);
            const queryLen = envResult?.queryLen || localResult.queryLen || ncbiResult.queryLen || 0;
            if (envResult && envResult.hits.length > 0) {
              const candidateVariantIds = new Set<string>();
              for (const { variantId: hitVariantId, rawIdentity } of qualifyingEnvBlastHits(envResult, ednaVariantIdStr, EDNA_ADJUSTED_IDENTITY_THRESHOLD, queryLen, ampliconFamily)) {
                if (!hitVariantId) continue;
                envRescueMatches.push({
                  variantId: hitVariantId,
                  identity: Math.round(rawIdentity * 100) / 100,
                  name: null,
                });
                candidateVariantIds.add(hitVariantId);
              }
              if (candidateVariantIds.size > 0) {
                const siblingRows = await edna.variantSpeciesIds(candidateVariantIds);
                const idToName = new Map<string, string | null>();
                for (const row of siblingRows) {
                  idToName.set(String(row.id), row.ednaSpeciesId ?? null);
                }
                for (const m of envRescueMatches) {
                  m.name = idToName.get(m.variantId) ?? null;
                }
                // Prefer the highest-identity sibling that already has an env-coded ID.
                envRescueMatches.sort((a, b) => b.identity - a.identity);
                const envNamed = envRescueMatches.find(
                  m => m.name && /sp\.\s*'env\d+'/i.test(m.name)
                );
                if (envNamed?.name) {
                  envRescueName = envNamed.name;
                }
              }
            }
          }
        }
      } catch (envErr: any) {
        ports.logger.warn(`[BatchAnalysis] Seq ${sequenceId}: envBLAST singleton rescue check failed:`, envErr.message);
      }

      if (envRescueName) {
        // Adopt the env-coded name from the matching sibling variant.
        try {
          const { setVariantEdnaSpeciesId } = await edna.ednaSynonyms();
          const ednaVariantIdNum = parseInt(sequenceId.replace(/^edna-/, ""), 10);
          if (!Number.isNaN(ednaVariantIdNum)) {
            await setVariantEdnaSpeciesId({
              variantId: ednaVariantIdNum,
              newName: envRescueName,
              changedBy: `server-analysis:${sequenceId}`,
              reason: `envBLAST sibling rescue: matched variant already carries env-coded ID`,
            });
          }
        } catch (assignErr: any) {
          ports.logger.warn(`[BatchAnalysis] Seq ${sequenceId}: failed to assign env rescue name:`, assignErr.message);
        }
        result.finalSpecies = envRescueName;
        result.ednaTempCode = envRescueName;
        result.finalConfidence = 0;
        addStep({
          step: "envBLAST Sibling Rescue",
          status: "pass",
          message: `Adopted env-coded ID from matching sibling variant: ${envRescueName}`,
          details: [
            `Not a singleton — ${envRescueMatches.length} other variant(s) matched at >= ${EDNA_ADJUSTED_IDENTITY_THRESHOLD}% identity in envBLAST`,
            ...envRescueMatches.slice(0, 5).map(m =>
              `  variant-${m.variantId}: ${m.identity}% identity${m.name ? ` (eDNA ID: ${m.name})` : " (no eDNA ID)"}`
            ),
            ...(envRescueMatches.length > 5 ? [`  ... and ${envRescueMatches.length - 5} more`] : []),
            `Adopted name: ${envRescueName}`,
          ],
        });
      } else if (envRescueMatches.length > 0) {
        // Siblings replicate this sequence but none carry an env-coded ID —
        // hold for manual validation instead of declaring a singleton.
        result.finalSpecies = "Manual Validation Needed";
        result.finalConfidence = 0;
        addStep({
          step: "envBLAST Sibling Match — Manual Validation",
          status: "skip",
          message: `Not a singleton — ${envRescueMatches.length} other variant(s) match in envBLAST, but none have an eDNA ID yet`,
          details: [
            ...envRescueMatches.slice(0, 5).map(m =>
              `  variant-${m.variantId}: ${m.identity}% identity${m.name ? ` (eDNA ID: ${m.name})` : " (no eDNA ID)"}`
            ),
            ...(envRescueMatches.length > 5 ? [`  ... and ${envRescueMatches.length - 5} more`] : []),
            "Held for manual validation rather than auto-labeled as a singleton",
          ],
        });
      } else {
        result.finalSpecies = "Singleton Sequence";
        result.finalConfidence = 0;
        const summaryMsg = singletonReasons.length > 0
          ? `Singleton — ${singletonReasons[singletonReasons.length - 1]}`
          : "Singleton sequence — no species could be determined";
        addStep({
          step: "Singleton Sequence",
          status: "info",
          message: summaryMsg,
          details: singletonReasons.length > 0
            ? [...singletonReasons, "envBLAST checked: no sibling variants matched at >= " + EDNA_ADJUSTED_IDENTITY_THRESHOLD + "% identity", "This eDNA variant did not produce sufficient qualifying matches for species identification"]
            : [`No species could be determined at ${effectiveIdentityThreshold}% or ${effectiveSecondaryThreshold}% thresholds`, `envBLAST checked: no sibling variants matched at >= ${EDNA_ADJUSTED_IDENTITY_THRESHOLD}% identity`, "This eDNA variant did not produce sufficient qualifying matches for species identification"],
        });
      }
    }
  } else {
    result.barcodeGapNeeded = true;
    addStep({
      step: "Barcode Gap Analysis",
      status: "info",
      message: "Barcode gap analysis will be required to determine species identity",
      details: [
        `No species could be determined at ${effectiveIdentityThreshold}% or ${effectiveSecondaryThreshold}% thresholds`,
        "Barcode gap analysis compares distance patterns between BLAST hits to identify species boundaries",
        "This analysis can be run from the Barcode Gap Analysis tab",
      ],
    });
  }
  setDeterministicCurationRecommendations(result, localResult, ncbiResult, sequenceMap, localAdjustedMap, obsSpeciesMap, genbankMap, ncbiAdjustedMap);

  result.skipped = true;
  result.status = "complete";
  return result;
}
