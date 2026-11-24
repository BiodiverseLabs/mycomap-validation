/**
 * What MycoMap Vision "supports" under auto-validation rules v2, shared by
 * the decision (mycomap.org's autovalidationV2.ts) and the iNat comment
 * (mycomap.org's autovalidationComment.ts), so the comment always lists exactly the
 * names the decision counted.
 *
 * 2026-10-20 (from the #271 session's check on Vision's 12,874 held-out
 * validated finds): Vision supports a name when it shows at 10% or more AS
 * DISPLAYED (whole percent, so the cut-off is applied to the rounded figure),
 * at most 3 per rank, at family, genus and species. A DNA family is backed when
 * it is in that family set, or one of its genera is in that genus set. Vision
 * "clearly shows" a family when its top family is at 0.80 or more. Served 336 px
 * release; no new calibration.
 *
 * 2026-10-23: strong DNA is never blocked by Vision when Vision shows
 * the DNA's own name. A sequence above 70 whose genus or species Vision shows
 * at 30% or more as displayed backs its family, even when Vision's family and
 * genus lists alone would not (a species shown under a genus Vision lists
 * apart, or past the 3 per rank).
 */
import { parseSpeciesName, speciesKey } from "./autovalidationNames";

export const V2_VISION = {
  /** A name counts at this whole percent or more, as the comment displays it. */
  minDisplayedPercent: 10,
  /** At most this many names per rank. */
  maxPerRank: 3,
  /** Vision "clearly shows" a family: its top family at this confidence or more. */
  clearFamilyMinConfidence: 0.8,
  /** Possible specimen swap: the DNA's family is not among Vision's first this many families. */
  swapFamilyTopK: 3,
  /** Strong DNA: a sequence's DNA-only confidence above this... */
  strongDnaAbove: 70,
  /** ...that Vision shows by genus or species at this whole percent or more backs its family. */
  strongDnaShownMinPercent: 30,
  /** Vision picks between the DNA's families only when it shows one at least this many times as strongly as each rival. */
  decidesFamilyRatio: 2,
} as const;

/** A confidence (0–1) as the comment shows it: a whole percent. */
export function displayedPercent(confidence: number | null | undefined): number | null {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  return Math.round(confidence * 100);
}

/** One rank's supported names: ≥ 10% as displayed, best first, at most 3. */
export function visionNamesShown(names: V2VisionName[]): Array<{ name: string; percent: number }> {
  return names
    .map((n) => ({ name: n.name, percent: displayedPercent(n.confidence) }))
    .filter((n): n is { name: string; percent: number } => n.percent != null && n.percent >= V2_VISION.minDisplayedPercent && !!n.name)
    .sort((a, b) => b.percent - a.percent)
    .slice(0, V2_VISION.maxPerRank);
}

export interface VisionSupportSet { families: string[]; genera: string[]; species: string[] }

/** The names Vision supports at each rank (empty when Vision has no usable answer). */
export function visionSupportSet(vision: V2Vision): VisionSupportSet {
  if (vision.state !== "ok") return { families: [], genera: [], species: [] };
  const names = (list: V2VisionName[]) => visionNamesShown(list).map((n) => n.name);
  return { families: names(vision.families), genera: names(vision.genera), species: names(vision.species) };
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Whether Vision backs a DNA group: its family is in the family set, or one of its genera in the genus set. */
export function visionBacks(set: VisionSupportSet, family: string | null, genera: string[]): boolean {
  return (!!family && set.families.some((f) => same(f, family))) || genera.some((g) => set.genera.some((v) => same(v, g)));
}

/** A sequence's DNA answer, as the strong-DNA rule reads it. */
export interface DnaName { species: string | null; genus: string | null; confidence: number | null }

const speciesKeyOf = (name: string) => speciesKey(parseSpeciesName(name));

/**
 * Where Vision shows a strong DNA answer's own name (2026-10-23): the
 * first sequence above 70 whose genus or species Vision shows at 30% or more,
 * as "Russula xerampelina 34%"; null when there is none or Vision has no usable answer.
 */
export function visionShowsStrongDna(vision: V2Vision, dna: DnaName[]): string | null {
  if (vision.state !== "ok") return null;
  const shown = (list: V2VisionName[]) => list
    .map((n) => ({ name: n.name, percent: displayedPercent(n.confidence) }))
    .filter((n): n is { name: string; percent: number } => !!n.name && n.percent != null && n.percent >= V2_VISION.strongDnaShownMinPercent);
  const species = shown(vision.species);
  const genera = shown(vision.genera);
  for (const d of dna) {
    if (d.confidence == null || d.confidence <= V2_VISION.strongDnaAbove) continue;
    const key = d.species ? speciesKeyOf(d.species) : null;
    const sp = key ? species.find((v) => speciesKeyOf(v.name) === key) : undefined;
    if (sp) return `${sp.name} ${sp.percent}%`;
    const genus = d.genus ?? (d.species ? parseSpeciesName(d.species).genus : null);
    const g = genus ? genera.find((v) => same(v.name, genus)) : undefined;
    if (g) return `${g.name} ${g.percent}%`;
  }
  return null;
}

/**
 * How strongly Vision shows a DNA group: its best confidence for the group's
 * family, one of its genera, or the species of a strong sequence (> 70). Raw
 * confidences, not the displayed top 3: this weighs families against each
 * other, it doesn't decide whether Vision backs one. 0 when Vision shows none.
 */
export function visionStrength(vision: V2Vision, family: string | null, genera: string[], dna: DnaName[]): number {
  if (vision.state !== "ok") return 0;
  let best = 0;
  const take = (c: number | null) => { if (typeof c === "number" && Number.isFinite(c) && c > best) best = c; };
  if (family) for (const f of vision.families) if (same(f.name, family)) take(f.confidence);
  for (const g of vision.genera) if (genera.some((x) => same(x, g.name))) take(g.confidence);
  const keys = new Set(dna
    .filter((d) => d.species && d.confidence != null && d.confidence > V2_VISION.strongDnaAbove)
    .map((d) => speciesKeyOf(d.species!)));
  for (const sp of vision.species) if (keys.has(speciesKeyOf(sp.name))) take(sp.confidence);
  return best;
}

export type V2VisionState = "ok" | "no_answer" | "no_photos" | "not_fungus" | "unsure" | "error" | "unknown_taxon";
export interface V2VisionName { name: string; confidence: number | null }
export interface V2Vision {
  state: V2VisionState;
  runId: number | null;
  modelVersion: string | null;
  answersVersion: string | null;
  answeredAt: string | null;
  families: V2VisionName[];
  genera: V2VisionName[];
  species: V2VisionName[];
}
