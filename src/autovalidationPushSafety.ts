// Which of a record's sequences auto-validation may act on, and the one it cites: the
// eligibility gate (70% and reads in consensus). Moved unchanged from
// mycomap.org's autovalidationPushSafety.ts, which keeps the hand-off to iNaturalist and Mushroom Observer.
import { hasExcludedSequenceFlag } from "./sequenceExclusionFlags";

export const AUTOVALIDATION_MIN_CONFIDENCE = 70;
export const AUTOVALIDATION_MIN_RIC = 3;
export type AutovalidationAnalysis = {
  status?: string | null;
  finalSpecies?: string | null;
  finalConfidence?: number | null;
  flaggedContaminant?: boolean | null;
  flaggedNonTarget?: boolean | null;
};

export type AutovalidationSequenceMetadata = {
  isNonTarget?: boolean;
  isChildSequence?: boolean;
  ricScore?: number | string | null;
  /**
   * Not an ONT consensus with a recorded RiC (a Sanger, iNaturalist or Mushroom
   * Observer sequence, or one with no RiC): RiC says nothing about it, so the
   * RiC rule does not hold it back. Only an explicit true counts; the server
   * works it out from the category and the stored RiC (validation engine,
   * ricForRules), since the record store sends a missing RiC as 0.
   */
  possiblySanger?: boolean;
  /**
   * An iNaturalist or Mushroom Observer copy (validation engine, sequenceIsPlatformCopy):
   * it can stand for the record, but is never pushed back to where it came from.
   * From the server's reading only, like possiblySanger.
   */
  platformCopy?: boolean;
  /** The sequence's flags, when the caller has them: contaminant and wrong specimen exclude it. */
  flags?: unknown;
};

export type AutovalidationEligibility =
  | {
      eligible: true;
      species: string;
      eligibleSequenceIds: string[];
      selectedSequenceId: string;
    }
  | {
      eligible: false;
      reason:
        | "no_sequences"
        | "no_target_results"
        | "no_complete_species"
        | "species_disagreement"
        | "confidence_below_threshold"
        | "ric_below_threshold";
      message: string;
    };
export function isExcluded(
  analysis: AutovalidationAnalysis | null | undefined,
  metadata: AutovalidationSequenceMetadata | undefined,
): boolean {
  if (!analysis) return true;
  const species = analysis.finalSpecies?.trim().toLowerCase() || "";
  return Boolean(
    analysis.flaggedContaminant
    || analysis.flaggedNonTarget
    || metadata?.isNonTarget
    || hasExcludedSequenceFlag(metadata?.flags)
    || species.startsWith("contaminant:")
    || species.startsWith("non-target:"),
  );
}

export function normalizeAutovalidationRic(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether the RiC rule lets the sequence through: an ONT consensus needs RiC
 * ≥ AUTOVALIDATION_MIN_RIC; a possibly-Sanger sequence is judged on its BLAST
 * evidence alone (2026-11-16: "Sanger only should not be held for a
 * person").
 */
export function passesAutovalidationRic(metadata: AutovalidationSequenceMetadata | undefined): boolean {
  if (metadata?.possiblySanger === true) return true;
  return (normalizeAutovalidationRic(metadata?.ricScore) ?? -Infinity) >= AUTOVALIDATION_MIN_RIC;
}

type PushCandidate = { id: string; analysis?: AutovalidationAnalysis | null; metadata?: AutovalidationSequenceMetadata };

/**
 * The order the record's sequences stand for it in a push:
 * 1. ONT consensus reads, most reads in consensus first (2026-11-07:
 *    "On-target sequences should be pushed in order of RiC only. Not the confidence");
 * 2. then possibly-Sanger sequences, which have no RiC to rank by: a record's
 *    own read before a copy (a child copy of another read, or an iNaturalist or
 *    Mushroom Observer sequence, which is never pushed back), then the higher name confidence, then the record's own order.
 * Array.prototype.sort is stable, so equal sequences keep the record's order.
 */
function pushOrder(a: PushCandidate, b: PushCandidate): number {
  const sangerA = a.metadata?.possiblySanger === true;
  const sangerB = b.metadata?.possiblySanger === true;
  if (sangerA !== sangerB) return sangerA ? 1 : -1;
  if (!sangerA) {
    return (normalizeAutovalidationRic(b.metadata?.ricScore) ?? -1)
      - (normalizeAutovalidationRic(a.metadata?.ricScore) ?? -1);
  }
  const isCopy = (item: PushCandidate) => item.metadata?.isChildSequence === true || item.metadata?.platformCopy === true;
  const childA = isCopy(a);
  const childB = isCopy(b);
  if (childA !== childB) return childA ? 1 : -1;
  const confidence = (item: PushCandidate) =>
    typeof item.analysis?.finalConfidence === "number" ? item.analysis.finalConfidence : -1;
  return confidence(b) - confidence(a);
}

export function evaluateAutovalidationEligibility(options: {
  sequenceIds: string[];
  analysisResults: Record<string, AutovalidationAnalysis | null | undefined>;
  sequenceMetadata: Record<string, AutovalidationSequenceMetadata | undefined>;
  /**
   * MycoMap Vision agreed with the DNA species (visionAgreement.ts):
   * "no score cutoff", so the name-confidence threshold is not applied. Every
   * other check (target, complete species, one species, RiC) still is.
   */
  waiveConfidenceThreshold?: boolean;
}): AutovalidationEligibility {
  const sequenceIds = options.sequenceIds.map(String);
  if (sequenceIds.length === 0) {
    return { eligible: false, reason: "no_sequences", message: "No sequences are associated with this record." };
  }

  const targetResults = sequenceIds
    .map(id => ({
      id,
      analysis: options.analysisResults[id],
      metadata: options.sequenceMetadata[id],
    }))
    .filter(item => !isExcluded(item.analysis, item.metadata));
  if (targetResults.length === 0) {
    return {
      eligible: false,
      reason: "no_target_results",
      message: "All submitted deterministic results are contaminant, non-target, or unavailable.",
    };
  }

  const complete = targetResults.filter(item =>
    item.analysis?.status === "complete"
    && typeof item.analysis.finalSpecies === "string"
    && item.analysis.finalSpecies.trim().length > 0,
  );
  if (complete.length === 0) {
    return {
      eligible: false,
      reason: "no_complete_species",
      message: "No target sequence has a complete deterministic species result.",
    };
  }

  const species = new Set(complete.map(item => item.analysis!.finalSpecies!.trim()));
  if (species.size !== 1) {
    return {
      eligible: false,
      reason: "species_disagreement",
      message: "Target sequences disagree on the deterministic species result.",
    };
  }

  const confident = options.waiveConfidenceThreshold ? complete : complete.filter(item =>
    typeof item.analysis!.finalConfidence === "number"
    && item.analysis!.finalConfidence! >= AUTOVALIDATION_MIN_CONFIDENCE,
  );
  if (confident.length === 0) {
    return {
      eligible: false,
      reason: "confidence_below_threshold",
      message: `No target sequence reaches the ${AUTOVALIDATION_MIN_CONFIDENCE}% confidence threshold.`,
    };
  }

  // RiC holds back only an ONT consensus; a possibly-Sanger sequence passes (passesAutovalidationRic).
  const ricEligible = confident.filter(item => passesAutovalidationRic(item.metadata));
  if (ricEligible.length === 0) {
    return {
      eligible: false,
      reason: "ric_below_threshold",
      message: `No target sequence reaches the RiC ≥ ${AUTOVALIDATION_MIN_RIC} threshold.`,
    };
  }

  // The read pushed to iNat or MO and cited in the comment: the on-target ONT read with the most
  // reads in consensus, whatever its own score (2026-11-07: "On-target sequences should
  // be pushed in order of RiC only. Not the confidence"), and after every ONT read a
  // possibly-Sanger one (pushOrder). The record still qualifies as above (a read at 70 or more,
  // or Vision's agreement, that passes the RiC rule); its score only decides whether the record
  // validates, never which ONT read stands for it. Before this, a RiC 6 read at 82% was pushed
  // over a RiC 221 read at 67% of the same species (inat:315261210).
  const onTarget = complete
    .filter(item => passesAutovalidationRic(item.metadata))
    .sort(pushOrder);
  ricEligible.sort(pushOrder);
  const selected = onTarget[0] ?? ricEligible[0];
  return {
    eligible: true,
    species: [...species][0],
    eligibleSequenceIds: [selected.id, ...ricEligible.map(item => item.id).filter(id => id !== selected.id)],
    selectedSequenceId: selected.id,
  };
}
