// A likely name from GenBank for a specimen MycoMap's own sequences could not
// name (2026-11-19: "if there are no local hits, couldn't we do a quick
// NCBI read for possible names, like we now do with the contaminant name
// search?").
//
// A specimen's DNA name comes from MycoMap's validated sequences; GenBank's
// hits only check it. So a specimen with only GenBank matches gets no name at
// all, even when every GenBank hit agrees. This says what GenBank points to,
// read the same way as a contaminant's likely name (contaminantLikelyName.ts):
// a species from the tiered consensus over the NCBI hits, else a genus most
// named NCBI hits at >= 97% identity share.
//
// It travels in its own field on the result (genbankLikelyName), never in
// finalSpecies / finalConfidence: nothing that decides (auto-validation,
// sequence names, comments) reads it, so no decision changes.
import type { AnalysisResult } from "./analysisRules";
import { MIN_VALIDATED_HITS } from "./analysisRules";
import type { ContaminantLikelyName } from "./contaminantLikelyName";
import type { FamilyResolution } from "./familyTypes";

/**
 * GenBank's likely name, with its family against the record's
 * (2026-11-19, "Warn on the panel", after sequence 900328: a Laricifomes
 * record whose read is Hyphodiscus). With no DNA name the analysis never
 * compares families with the record, so a specimen switch or off-target read
 * with only GenBank matches was not caught; this says so beside the name.
 * Information only: nothing that decides reads it.
 */
export interface GenbankLikelyName extends ContaminantLikelyName {
  /** The family of the likely name's genus, when it could be looked up. */
  likelyFamily?: string | null;
  /** The record's family, as the analysis resolved it. */
  recordFamily?: string | null;
  /** Both families known and different: a possible specimen switch or off-target read. */
  familyDiffers?: boolean;
}

/** When the analysis looks GenBank up for a likely name: what the run itself knew. */
export interface GenbankLikelyNameContext {
  /** An eDNA sample: GenBank can name one already, so it needs no suggestion. */
  isEdna: boolean;
  /** Validated MycoMap hits that qualified at the first pass (99.5% adjusted identity). */
  mycomapQualified: number;
}

/**
 * Whether a finished analysis gets a GenBank likely name: no DNA name, and only
 * GenBank to go on (fewer validated MycoMap hits than it takes to name a
 * specimen). A contaminant has its own likely name; a non-target read, a
 * chimera or an error gets none. (`skipped` is no bar: the analysis sets it
 * when it ends without a name, which is the case this is for.)
 */
export function genbankLikelyNameApplies(result: AnalysisResult, context: GenbankLikelyNameContext): boolean {
  if (context.isEdna) return false;
  if (result.status === "error") return false;
  if (result.flaggedContaminant || result.flaggedNonTarget) return false;
  const name = result.finalSpecies?.trim() ?? "";
  if (name && !/^manual validation needed$/i.test(name)) return false;
  return context.mycomapQualified < MIN_VALIDATED_HITS;
}

/**
 * The likely name's family against the record's: both known, and whether they
 * differ. `familyOf` asks the analysis's family port for the genus; when it
 * fails (or a replay holds no such answer), there is no check and no warning.
 */
export async function genbankFamilyCheck(
  likely: Pick<ContaminantLikelyName, "name">,
  recordFamily: string | null | undefined,
  familyOf: (genus: string) => Promise<Pick<FamilyResolution, "family">>,
): Promise<Pick<GenbankLikelyName, "likelyFamily" | "recordFamily" | "familyDiffers">> {
  const genus = likely.name.trim().split(/\s+/)[0];
  if (!recordFamily || !genus) return {};
  let likelyFamily: string | null = null;
  try {
    likelyFamily = (await familyOf(genus)).family ?? null;
  } catch {
    return {};
  }
  if (!likelyFamily) return {};
  return { likelyFamily, recordFamily, familyDiffers: likelyFamily.trim().toLowerCase() !== recordFamily.trim().toLowerCase() };
}

/** The warning beside a likely name in another family from the record, or null when there is none. */
export function genbankFamilyWarning(likely: Pick<GenbankLikelyName, "likelyFamily" | "recordFamily" | "familyDiffers"> | null | undefined): string | null {
  if (!likely?.familyDiffers || !likely.likelyFamily || !likely.recordFamily) return null;
  return `GenBank points to ${likely.likelyFamily}; the record is ${likely.recordFamily}: possibly a specimen switch or an off-target read.`;
}

/** "GenBank suggests Cantharellus cibarius (85%)", or null when there is no suggestion. */
export function genbankLikelyNameLabel(likely: { name: string; confidence: number } | null | undefined): string | null {
  return likely?.name ? `GenBank suggests ${likely.name} (${likely.confidence}%)` : null;
}
