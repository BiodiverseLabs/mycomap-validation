/**
 * What a batch analysis run keeps about each read it analysed (moved from
 * mycomap.org's batchAnalysisService.ts): the cross-read passes read and
 * change it.
 */
import type { AnalysisResult } from "./analysisRules";
import type { ContaminantLikelyName } from "./contaminantLikelyName";

export interface FungaiPrerequisiteProvenance {
  version: "fungai-deterministic-prerequisite/2";
  platform: string;
  source: {
    observationRowId: number;
    observationId: string;
  };
  sequence: {
    requestedSampleId: string;
    sourceSequenceId: string | null;
    sourceSequenceSha256: string | null;
  };
  /** The NCBI result file it was built from (fungaiAnalysis.ts ncbiResultFile). */
  blast?: { ncbiXml: string | null };
}

export interface AnalysisJobResult {
  sequenceId: string;
  status: "complete" | "error" | "skipped";
  analysisRunId?: string;
  finalSpecies: string | null;
  finalConfidence: number | null;
  errorMessage?: string;
  flaggedContaminant?: boolean;
  contaminantLikelyName?: ContaminantLikelyName | null;
  flaggedNonTarget?: boolean;
  barcodeGapNeeded?: boolean;
  localConsensusSpecies?: string | null;
  localConsensusCount?: number | null;
  localConsensusTotalWithSpecies?: number | null;
  localConsensusThreshold?: number | null;
  ncbiConsensusSpecies?: string | null;
  ncbiConsensusCount?: number | null;
  ncbiConsensusTotalWithSpecies?: number | null;
  ncbiConsensusThreshold?: number | null;
  broadenedSource?: string | null;
  analyzedAt?: string;
  saveFailed?: boolean;
  resultData?: AnalysisResult & {
    fungaiPrerequisiteProvenance?: FungaiPrerequisiteProvenance & { createdAt: string };
  };
}
