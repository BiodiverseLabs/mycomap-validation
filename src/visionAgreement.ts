// MycoMap Vision beside the deterministic analysis in auto-validation
// (2026-10-23). Pure: no I/O. The auto-validate route
// (routes/admin/observations.ts, processRecord) and the analysis panel's route
// (routes/visionAgreement.ts) both decide with decideVisionAgreement.
//
// The rule, as it was settled:
//
//   The analysis gives a species S (genus G). Whatever its name confidence,
//   the record is green-checked as S, tagged "DNA + MycoMap Vision", when
//     (a) Vision's top species is S, at a probability above 0.50, or
//     (b) Vision's top genus is G, at a probability above 0.50.
//   "No score cutoff if Vision matches analysis top choice."
//
//   Veto: when Vision's top genus is not G, at a probability above 0.50, the
//   record is NOT green-checked, even at 70% name confidence or more ("if
//   vision says a different genus it would block"). It goes to Autovalidation
//   Assist for a person instead.
//
//   Unless Vision also shows the DNA's name (2026-10-23, confirmed
//   2026-10-25): when Vision's genus rank has G at 0.30 or more, or its
//   species list has S at 0.30 or more, the veto does not fire and the DNA
//   stands. "DNA says Russula at 90%; Vision lists Boletus 55%, Russula 35%:
//   this should follow the DNA because Russula is in the list." A record at
//   70% or more then validates on the DNA alone; one below 70% still needs (a)
//   or (b), or goes to Assist as before.
//
//   Unless the observer agrees with the DNA (2026-11-01, tracker #364):
//   when the observer's identification is in G, the veto does not fire either
//   and the record goes on through the DNA rules the same way. Two of the
//   three sources agree, so the odd one out does not block. The observer's
//   identification is their own on iNaturalist or Mushroom Observer, else the
//   observation's name (mycomap.org's observerIdentification.ts). Accepted caveat:
//   on MycoMap the observation's name is sometimes set to the DNA result after
//   sequencing, so the agreement can be the DNA echoing itself.
//
// Guards that hold for all of it: the record is not eDNA ("eDNA would never
// have vision run"), Vision's not-a-fungus gate said "fungus", and no sequence
// of the record carries the analysis' contaminant flag. The verdict name is
// always the DNA's S, never Vision's.
//
// The -50 for the observer's family (2026-11-04): the analysis takes 50
// off when the DNA's family differs from the family of the observer's name.
// When Vision's top list (autovalidationVisionSupport.ts: at most 3 per
// rank, 10% or more as displayed) shows the DNA's family or genus, Vision agrees
// with the DNA, so the 50 does not count: the record is judged at 70 on the score
// without it, and tagged "DNA + MycoMap Vision" like any validation Vision made.
// The genus counts because Vision and iNaturalist can file a genus under
// different families. Other penalties stand, and no other cutoff moves.
//
// A floor of 20 (2026-11-05, inat:351375760): below 70, with Vision's top
// names not the DNA's above 50%, the record is still green-checked as S when
// Vision's top list shows the DNA's family or genus and the score is 20 or more.
// The same guards hold. It reads the score as the analysis gives it, so a −50 that
// has not been lifted counts. Vision's dataset takes these as a record of the genus
// (mycomap.org's visionGreenRecords.ts).
//
// The rule as it was simplified (2026-11-06, replacing one-off spares). Vision
// backs the DNA, stays neutral, or is against it:
//
//   backs    its top genus or top family is the DNA's above 50%, or nothing is
//            above 50% and it shows the DNA;
//   neutral  no answer, shows nothing while unsure, or sure of another genus but
//            shows the DNA;
//   against  sure of another genus and doesn't show the DNA.
//
// "Shows" is the DNA's genus or family on the top list (10% or more as displayed,
// 3 per rank) or its exact species anywhere on the species list. Against holds the
// record for a person, unless the observer is in the DNA's genus (#364). Neutral
// and against never lift the -50 or apply the floor, so such a record needs its
// own 70.
//
// A second source (2026-11-09, after DNA from the wrong specimen validated
// on its own score). False validations matter far more than extra work for a
// person, and DNA alone can't see that it came from another specimen. So every
// auto-validation also needs one source that doesn't come from the DNA:
//
//   1. the DNA's exact species on Vision's species list at 10% or more (as shown);
//   2. Vision's top genus is the DNA's, or Vision shows the DNA's genus at 30% or more;
//   3. the observer's own identification (iNaturalist, Mushroom Observer) is in the
//      DNA's genus.
//
// Otherwise a person decides. A shared family counts for nothing: Vision and
// observers both confuse genera inside a family (inat:391659828). A contaminant
// flag on one read doesn't turn this off. Until Vision has answered, nothing is
// decided or written (routes/admin/observations.ts); when Vision finds no usable
// photos, only the observer can be the second source. The observation's name never counts: on
// MycoMap it can be the DNA's own result, set after sequencing. eDNA samples have
// no photos and stay out. Thresholds backtested on real records, 2026-11-09.
//
// A record that is one of Vision's own DNA references counts as "fungus"
// (2026-11-03, inat:363245311). Vision answers it from the reference
// photos it already holds, with the record left out, and runs no gate on that
// path, so the answer has no verdict at all. The photos were taken into the
// reference as a DNA-verified fungus, so the gate has nothing left to check.
// A verdict Vision does report on such a record still decides.
//
// Names are compared after the auto-validation name rules
// (autovalidationTaxonomy.ts: the genus- and species-synonym tables;
// autovalidationNames.ts: one key per taxon whatever the style, so a
// provisional name counts when both give the same code). G is always the DNA
// species' own genus, never Vision's: if Vision's ranks disagree with each
// other, the DNA species decides which genus is compared.
import { isEdnaAnalysisKey, isEdnaAnalysisResult } from "./analysisRowOwnership";
import { parseSpeciesName, reachesSpecies, speciesKey } from "./autovalidationNames";
import { canonicalGenus, canonicalSpeciesName, sameName } from "./autovalidationTaxonomy";
import { displayedPercent, visionNamesShown } from "./autovalidationVisionSupport";

/** Vision's probability must be strictly above this (0.50 itself does not count). */
export const VISION_AGREEMENT_MIN_PROBABILITY = 0.5;

/** The analysis' penalty lifted, the score must still reach this (AUTOVALIDATION_MIN_CONFIDENCE). */
export const FAMILY_PENALTY_LIFT_MIN_CONFIDENCE = 70;

/** With the DNA's family or genus in Vision's top list, the score must reach this. */
export const TOP_LIST_MIN_DNA_CONFIDENCE = 20;

/** observation_validation_methods.evidence of a validation Vision's agreement made. */
export const VISION_AGREEMENT_EVIDENCE = "dna_vision";
/** How that validation method reads wherever validation methods show. */
export const VISION_AGREEMENT_METHOD_LABEL = "DNA + MycoMap Vision";
/** How a record Vision's genus veto held back reads. */
export const VISION_HOLD_LABEL = "Held by MycoMap Vision";
/**
 * observation_validation_methods.evidence of a validation the DNA made after
 * the observer's identification kept Vision's genus veto from firing (#364).
 */
export const VISION_OBSERVER_SPARE_EVIDENCE = "dna_observer";
/** How that validation method reads wherever validation methods show. */
export const VISION_OBSERVER_SPARE_LABEL = "DNA + observer's ID over MycoMap Vision";
/**
 * observation_validation_methods.evidence of a validation the DNA made on its
 * own score, with MycoMap Vision as the second source rules v1.4 require
 * (the DNA's species at 10%, or its genus top or at 30%).
 */
export const VISION_SECOND_SOURCE_EVIDENCE = "dna_vision_second_source";
/** How that validation method reads wherever validation methods show. */
export const VISION_SECOND_SOURCE_LABEL = "DNA, with MycoMap Vision as second source";
/**
 * observation_validation_methods.evidence of a validation the DNA made on its
 * own score, with the observer's identification in the DNA's genus as the
 * only second source (rules v1.4).
 */
export const OBSERVER_SECOND_SOURCE_EVIDENCE = "dna_observer_second_source";
/** How that validation method reads wherever validation methods show. */
export const OBSERVER_SECOND_SOURCE_LABEL = "DNA, with the observer's ID as second source";

export interface VisionCandidate {
  name: string;
  confidence: number | null;
}

/** The DNA side, for the whole record. */
export interface VisionAgreementDna {
  /** The analysis' species result S (the one name all usable sequences agree on), or null. */
  species: string | null;
  /** The analysis' name confidence for S (the panel's badge), or null. Shown only: the rule has no cutoff. */
  nameConfidence: number | null;
  /** Any sequence of the record carries the analysis' contaminant flag. */
  contaminant: boolean;
  /** The record is an eDNA sample. */
  edna: boolean;
}

/** The record's newest done Vision answer, or null when there is none. */
export interface VisionAgreementVision {
  runId: number | null;
  modelVersion: string | null;
  answersVersion: string | null;
  /** Vision's not-a-fungus gate: "fungus" | "unsure" | "not_fungus" | null (not reported). */
  gateVerdict: string | null;
  /** Vision's combined ranks, best first. */
  species: VisionCandidate[];
  genus: VisionCandidate[];
  /** Vision's families, best first: the iNat comment, its top list, and whether it backs the DNA. */
  family?: VisionCandidate[];
}

export type VisionAgreementBranch = "species" | "genus" | "family_penalty" | "top_list";

/** The DNA's family or genus as Vision's top list shows it. */
export interface VisionTopListMatch {
  rank: "family" | "genus" | "species";
  name: string;
  percent: number;
}

/** What lifted the observer's-family penalty: the DNA's name in Vision's top list, and the score it leaves. */
export interface VisionFamilyPenaltyLift {
  rank: "family" | "genus" | "species";
  name: string;
  percent: number;
  penalty: number;
  sequenceId: string;
  withoutPenalty: number;
}

export type VisionAgreementNoneReason =
  | "edna"
  | "no_dna_species"
  | "no_vision_answer"
  | "gate_not_passed"
  | "contaminant"
  | "names_differ"
  | "not_above_half"
  /** Vision is sure of another genus, but the DNA stands: it also shows the DNA, or the observer is in its genus. */
  | "vision_prefers_another_genus";

interface VisionTop {
  name: string;
  probability: number | null;
}

/** Where the observer's name came from: their own identification (iNat, MO), else the observation's name. */
export type ObserverNameSource = "observer_identification" | "observation_name";

/** The observer's side, for the record (mycomap.org's observerIdentification.ts). */
export interface VisionAgreementObserver {
  name: string | null;
  source: ObserverNameSource;
}

/** The observer's identification in the DNA genus, which kept Vision's genus veto from firing (#364). */
export interface VisionVetoObserverSpare {
  name: string;
  source: ObserverNameSource;
  /** Its genus after the synonym tables: the DNA genus G. */
  genus: string;
}

/** The DNA name Vision also showed, which kept its genus veto from firing. */
export interface VisionVetoSpare {
  rank: "genus" | "species" | "family";
  name: string;
  probability: number;
}

interface DecisionCommon {
  dnaSpecies: string | null;
  dnaGenus: string | null;
  nameConfidence: number | null;
  visionSpecies: VisionTop | null;
  visionGenus: (VisionTop & { computed: boolean }) | null;
  /** Set when Vision's top genus is another genus above 0.50 but Vision also shows the DNA. */
  vetoSpared: VisionVetoSpare | null;
  /** Set when the veto would still fire but the observer's identification is in G (#364). */
  vetoSparedByObserver: VisionVetoObserverSpare | null;
  /** The observer's name the rule was given, or null. */
  observer: VisionAgreementObserver | null;
  runId: number | null;
  answersVersion: string | null;
  modelVersion: string | null;
}

export type VisionAgreementDecision =
  | (DecisionCommon & { outcome: "agrees"; branch: VisionAgreementBranch; verdictName: string; familyPenaltyLift?: VisionFamilyPenaltyLift; topListMatch?: VisionTopListMatch })
  | (DecisionCommon & { outcome: "vetoes" })
  | (DecisionCommon & { outcome: "none"; reason: VisionAgreementNoneReason });

const above = (p: number | null | undefined): boolean =>
  typeof p === "number" && Number.isFinite(p) && p > VISION_AGREEMENT_MIN_PROBABILITY;

function genusKey(name: string | null | undefined): string | null {
  const g = canonicalGenus(name);
  return g ? g.toLowerCase() : null;
}

/** A species name's key and genus after the name rules, or null when it is not a species. */
function speciesIdentity(name: string | null | undefined): { key: string; genus: string; kind: string } | null {
  const parsed = parseSpeciesName(canonicalSpeciesName(name));
  if (!reachesSpecies(parsed) || !parsed.genus) return null;
  const genus = canonicalGenus(parsed.genus)!;
  return { key: speciesKey(parsed, genus), genus, kind: parsed.kind };
}

/**
 * Vision's top genus as Vision reports it. Only when Vision gives no genus rank
 * is it summed from its species list (marked computed): a lower bound, since
 * only the top few species are kept.
 */
export function visionTopGenus(vision: Pick<VisionAgreementVision, "species" | "genus">): (VisionTop & { computed: boolean }) | null {
  const reported = (vision.genus ?? []).find((c) => c && typeof c.name === "string" && c.name.trim());
  if (reported) return { name: reported.name.trim(), probability: reported.confidence ?? null, computed: false };
  const sums = new Map<string, { name: string; probability: number }>();
  for (const c of vision.species ?? []) {
    const parsed = parseSpeciesName(canonicalSpeciesName(c?.name));
    if (!parsed.genus || typeof c.confidence !== "number") continue;
    const genus = canonicalGenus(parsed.genus)!;
    const at = sums.get(genus.toLowerCase()) ?? { name: genus, probability: 0 };
    at.probability += c.confidence;
    sums.set(genus.toLowerCase(), at);
  }
  const best = [...sums.values()].sort((a, b) => b.probability - a.probability)[0];
  return best ? { name: best.name, probability: best.probability, computed: true } : null;
}

/**
 * Where Vision shows the DNA: its genus on the top list (summed from Vision's species
 * when it gives no genus rank, as visionTopGenus does), its exact species anywhere on
 * the species list, or its family on the top list.
 */
function visionShowsDnaName(vision: VisionAgreementVision, dna: { genus: string; key: string; kind: string }, dnaFamily: string | null | undefined): VisionVetoSpare | null {
  const dnaGenus = dna.genus.toLowerCase();
  if ((vision.genus ?? []).length > 0) {
    const shown = visionNamesShown(vision.genus).find((n) => genusKey(n.name) === dnaGenus);
    if (shown) return { rank: "genus", name: shown.name, probability: shown.percent / 100 };
  } else {
    let sum = 0;
    for (const c of vision.species ?? []) {
      const parsed = parseSpeciesName(canonicalSpeciesName(c?.name));
      if (parsed.genus && typeof c.confidence === "number" && canonicalGenus(parsed.genus)!.toLowerCase() === dnaGenus) sum += c.confidence;
    }
    if ((displayedPercent(sum) ?? 0) >= 10) return { rank: "genus", name: dna.genus, probability: sum };
  }
  for (const c of vision.species ?? []) {
    if (!c || typeof c.name !== "string") continue;
    const id = speciesIdentity(c.name);
    if (id && id.key === dna.key && id.kind === dna.kind) return { rank: "species", name: c.name.trim(), probability: c.confidence ?? 0 };
  }
  const family = dnaFamily ? visionNamesShown(vision.family ?? []).find((n) => sameName(n.name, dnaFamily)) : undefined;
  return family ? { rank: "family", name: family.name, probability: family.percent / 100 } : null;
}

/** Vision's top family is this one, above 50%. */
function visionTopFamilyIs(vision: VisionAgreementVision, family: string | null | undefined): boolean {
  if (!family) return false;
  const top = [...(vision.family ?? [])]
    .filter((c) => c && typeof c.name === "string" && typeof c.confidence === "number")
    .sort((a, b) => b.confidence! - a.confidence!)[0];
  return !!top && above(top.confidence) && sameName(top.name, family);
}

/**
 * The observer's name when it is in the DNA genus, after the genus- and
 * species-synonym tables; null when it names another genus, only a rank above
 * genus, or nothing.
 */
function observerInDnaGenus(observer: VisionAgreementObserver | null | undefined, dnaGenus: string): VisionVetoObserverSpare | null {
  const name = observer?.name?.trim();
  if (!observer || !name) return null;
  const parsed = parseSpeciesName(canonicalSpeciesName(name));
  if (!parsed.genus || parsed.kind === "above_genus") return null;
  const genus = canonicalGenus(parsed.genus)!;
  if (genus.toLowerCase() !== dnaGenus.toLowerCase()) return null;
  return { name, source: observer.source, genus };
}

/** Why a record waits (rules v1.4): until Vision has answered, nothing is decided or written. */
export const WAITING_FOR_VISION_TEXT = "Waiting for MycoMap Vision's answer: nothing is decided or written until it arrives, then the record runs again.";

/** Vision must show the DNA's exact species at this percent (as displayed) to be its second source. */
export const SECOND_SOURCE_SPECIES_MIN_PERCENT = 10;
/** Vision must show the DNA's genus at this percent (as displayed), unless it is Vision's top genus. */
export const SECOND_SOURCE_GENUS_MIN_PERCENT = 30;

/** The source other than the DNA that lets a record auto-validate. */
export type SecondSource =
  | { source: "vision_species"; name: string; percent: number }
  | { source: "vision_genus"; name: string; percent: number | null; top: boolean }
  | { source: "observer_genus"; name: string; genus: string };

const dnaGenusOf = (species: string | null | undefined): string | null => {
  const parsed = parseSpeciesName(canonicalSpeciesName(species));
  return parsed.genus && parsed.kind !== "above_genus" ? canonicalGenus(parsed.genus) : null;
};

/** Vision's probability for a genus: its genus rank, or its species summed when it gives no genus rank. */
function visionGenusProbability(vision: VisionAgreementVision, dnaGenusKey: string): number | null {
  if ((vision.genus ?? []).length > 0) {
    const found = vision.genus.find((c) => genusKey(c?.name) === dnaGenusKey);
    return found?.confidence ?? null;
  }
  let sum: number | null = null;
  for (const c of vision.species ?? []) {
    const parsed = parseSpeciesName(canonicalSpeciesName(c?.name));
    if (parsed.genus && typeof c.confidence === "number" && genusKey(parsed.genus) === dnaGenusKey) sum = (sum ?? 0) + c.confidence;
  }
  return sum;
}

/** Vision as the second source for the DNA's name, or null. Only an answer that passed Vision's fungus check counts. */
export function secondSourceFromVision(species: string | null | undefined, vision: VisionAgreementVision | null): SecondSource | null {
  if (!vision || vision.gateVerdict !== "fungus") return null;
  const dna = speciesIdentity(species);
  if (dna) {
    for (const c of vision.species ?? []) {
      const seen = speciesIdentity(c?.name);
      const percent = displayedPercent(c?.confidence);
      if (seen && seen.key === dna.key && seen.kind === dna.kind && percent != null && percent >= SECOND_SOURCE_SPECIES_MIN_PERCENT) {
        return { source: "vision_species", name: c.name.trim(), percent };
      }
    }
  }
  const dnaGenus = dnaGenusOf(species);
  if (!dnaGenus) return null;
  const key = dnaGenus.toLowerCase();
  const top = genusKey(visionTopGenus(vision)?.name) === key;
  const percent = displayedPercent(visionGenusProbability(vision, key));
  if (top || (percent != null && percent >= SECOND_SOURCE_GENUS_MIN_PERCENT)) {
    return { source: "vision_genus", name: dnaGenus, percent, top };
  }
  return null;
}

/** The observer's own identification as the second source, or null. The observation's name doesn't count. */
export function secondSourceFromObserver(species: string | null | undefined, observer: VisionAgreementObserver | null | undefined): SecondSource | null {
  if (observer?.source !== "observer_identification") return null;
  const dnaGenus = dnaGenusOf(species);
  const match = dnaGenus ? observerInDnaGenus(observer, dnaGenus) : null;
  return match ? { source: "observer_genus", name: match.name, genus: match.genus } : null;
}

/** Why a record with no second source goes to a person (Autovalidation Assist, the job's results, the analysis panel). */
export function noSecondSourceReason(input: {
  species: string | null | undefined;
  vision: VisionAgreementVision | null;
  observer: VisionAgreementObserver | null | undefined;
}): string {
  const dnaGenus = dnaGenusOf(input.species) ?? "the DNA's genus";
  const top = input.vision ? visionTopGenus(input.vision) : null;
  const vision = !input.vision ? "MycoMap Vision found no usable photos"
    : input.vision.gateVerdict !== "fungus" ? "MycoMap Vision's fungus check did not pass"
    : `MycoMap Vision's top genus is ${top ? `${top.name} (${pct(top.probability)})` : "unknown"}, and it shows neither ${dnaGenus} at ${SECOND_SOURCE_GENUS_MIN_PERCENT}% nor the DNA's species at ${SECOND_SOURCE_SPECIES_MIN_PERCENT}%`;
  const observer = input.observer?.source === "observer_identification" && input.observer.name?.trim()
    ? `the observer's identification (${input.observer.name.trim()}) is not in ${dnaGenus}`
    : "there is no identification from the observer";
  return `No second source for the DNA's ${input.species ?? "name"}: ${vision}, and ${observer}. Held for a person.`;
}

export function decideVisionAgreement(input: {
  dna: VisionAgreementDna;
  vision: VisionAgreementVision | null;
  /** The observer's identification (#364); without one the veto fires as before. */
  observer?: VisionAgreementObserver | null;
  /** The DNA species' family, when it can be placed; without it only the genus and species can match. */
  dnaFamily?: string | null;
}): VisionAgreementDecision {
  const { dna, vision } = input;
  const dnaIdentity = speciesIdentity(dna.species);
  const topSpecies = vision?.species?.find((c) => c && typeof c.name === "string" && c.name.trim()) ?? null;
  const common: DecisionCommon = {
    dnaSpecies: dna.species?.trim() || null,
    dnaGenus: dnaIdentity?.genus ?? null,
    nameConfidence: dna.nameConfidence ?? null,
    visionSpecies: topSpecies ? { name: topSpecies.name.trim(), probability: topSpecies.confidence ?? null } : null,
    visionGenus: vision ? visionTopGenus(vision) : null,
    vetoSpared: null,
    vetoSparedByObserver: null,
    observer: input.observer ?? null,
    runId: vision?.runId ?? null,
    answersVersion: vision?.answersVersion ?? null,
    modelVersion: vision?.modelVersion ?? null,
  };
  const none = (reason: VisionAgreementNoneReason): VisionAgreementDecision => ({ ...common, outcome: "none", reason });

  if (dna.edna) return none("edna");
  if (!dnaIdentity) return none("no_dna_species");
  if (!vision) return none("no_vision_answer");
  if (vision.gateVerdict !== "fungus") return none("gate_not_passed");
  if (dna.contaminant) return none("contaminant");

  const dnaGenus = dnaIdentity.genus.toLowerCase();
  const genus = common.visionGenus;
  const genusAbove = !!genus && above(genus.probability);
  const genusSame = !!genus && genusKey(genus.name) === dnaGenus;

  // Sure of another genus. Its top family being the DNA's still backs the DNA.
  // Otherwise it is against the DNA, unless it also shows the DNA or the observer
  // is in the DNA's genus (#364): then the DNA stands on its own score.
  let otherGenusStands = false;
  if (genus && genusAbove && !genusSame && !visionTopFamilyIs(vision, input.dnaFamily)) {
    common.vetoSpared = visionShowsDnaName(vision, dnaIdentity, input.dnaFamily);
    if (!common.vetoSpared) common.vetoSparedByObserver = observerInDnaGenus(input.observer, dnaIdentity.genus);
    if (!common.vetoSpared && !common.vetoSparedByObserver) return { ...common, outcome: "vetoes" };
    otherGenusStands = true;
  }

  const visionIdentity = topSpecies ? speciesIdentity(topSpecies.name) : null;
  const speciesSame = !!visionIdentity && visionIdentity.key === dnaIdentity.key && visionIdentity.kind === dnaIdentity.kind;
  const verdictName = common.dnaSpecies!;
  if (speciesSame && above(topSpecies!.confidence)) {
    return { ...common, outcome: "agrees", branch: "species", verdictName };
  }
  if (genusSame && genusAbove) {
    return { ...common, outcome: "agrees", branch: "genus", verdictName };
  }
  return none(otherGenusStands ? "vision_prefers_another_genus" : speciesSame || genusSame ? "not_above_half" : "names_differ");
}

/** Where Vision's top list shows the DNA's genus, else its family; null when it shows neither. */
export function visionTopListMatch(vision: VisionAgreementVision, dnaFamily: string | null, dnaGenus: string, dnaSpecies?: string | null): VisionTopListMatch | null {
  const key = dnaGenus.toLowerCase();
  const genus = visionNamesShown(vision.genus ?? []).find((n) => genusKey(n.name) === key);
  if (genus) return { rank: "genus", ...genus };
  const family = dnaFamily ? visionNamesShown(vision.family ?? []).find((n) => sameName(n.name, dnaFamily)) : undefined;
  if (family) return { rank: "family", ...family };
  if (dnaSpecies) {
    const dna = speciesIdentity(dnaSpecies);
    for (const c of vision.species ?? []) {
      const id = c && typeof c.name === "string" ? speciesIdentity(c.name) : null;
      if (dna && id && id.key === dna.key && id.kind === dna.kind) return { rank: "species", name: c.name.trim(), percent: displayedPercent(c.confidence) ?? 0 };
    }
  }
  return null;
}

/** The best score of a sequence of this species with the observer's-family penalty taken off, or null. */
export function scoreWithoutFamilyPenalty(
  species: string | null,
  sequences: Array<{ analysis: { finalSpecies?: string | null; finalConfidence?: number | null; confidenceBreakdown?: { familyMismatchPenalty?: unknown } | null; [k: string]: unknown } | null | undefined }>,
): number | null {
  let best: number | null = null;
  for (const s of sequences) {
    const a = s.analysis;
    if (!a || !species || a.finalSpecies?.trim() !== species || typeof a.finalConfidence !== "number") continue;
    const penalty = a.confidenceBreakdown?.familyMismatchPenalty;
    const score = Math.min(100, a.finalConfidence + (typeof penalty === "number" && penalty > 0 ? penalty : 0));
    if (best === null || score > best) best = score;
  }
  return best;
}

/**
 * The floor of 20: the rule decided "none" because Vision's top names were not
 * the DNA's above 50%, and the score is under 70. When it is 20 or more, with the
 * observer's-family penalty off, and Vision's top list shows the DNA, the decision
 * becomes an agreement on the "top_list" branch. Any other "none" and a veto stay.
 */
export function decideTopListAgreement(input: {
  decision: VisionAgreementDecision;
  dnaFamily: string | null;
  vision: VisionAgreementVision | null;
  /** The score with the observer's-family penalty off (scoreWithoutFamilyPenalty); Vision backing the DNA clears it. */
  scoreWithoutPenalty?: number | null;
}): (VisionAgreementDecision & { outcome: "agrees" }) | null {
  const { decision, vision } = input;
  if (decision.outcome !== "none" || (decision.reason !== "names_differ" && decision.reason !== "not_above_half")) return null;
  if (!vision || !decision.dnaGenus || !decision.dnaSpecies) return null;
  const score = Math.max(decision.nameConfidence ?? -1, input.scoreWithoutPenalty ?? -1);
  if (score < TOP_LIST_MIN_DNA_CONFIDENCE) return null;
  const shown = visionTopListMatch(vision, input.dnaFamily, decision.dnaGenus, decision.dnaSpecies);
  if (!shown) return null;
  const { reason: _reason, ...common } = decision;
  return { ...common, outcome: "agrees", branch: "top_list", verdictName: decision.dnaSpecies, topListMatch: shown };
}

/**
 * The rule above decided "none" because Vision's top names were not the DNA's
 * above 50%. If the observer's-family penalty is all that keeps a sequence of the
 * DNA species under 70, and Vision's top list shows the DNA's family or genus,
 * the decision becomes an agreement on the "family_penalty" branch. Any other
 * "none" (eDNA, no species, no answer, the fungus gate, a contaminant) and a
 * veto stay as they are.
 */
export function decideFamilyPenaltyLift(input: {
  decision: VisionAgreementDecision;
  /** The DNA species' family, when it can be placed; without it only the genus can match. */
  dnaFamily: string | null;
  vision: VisionAgreementVision | null;
  sequences: Array<{ id: string; analysis: { finalSpecies?: string | null; finalConfidence?: number | null; confidenceBreakdown?: { familyMismatchPenalty?: unknown } | null; [k: string]: unknown } | null | undefined }>;
}): (VisionAgreementDecision & { outcome: "agrees" }) | null {
  const { decision, vision } = input;
  if (decision.outcome !== "none" || (decision.reason !== "names_differ" && decision.reason !== "not_above_half")) return null;
  if (!vision || !decision.dnaGenus || !decision.dnaSpecies) return null;
  let best: { sequenceId: string; penalty: number; withoutPenalty: number } | null = null;
  for (const s of input.sequences) {
    const a = s.analysis;
    const penalty = a?.confidenceBreakdown?.familyMismatchPenalty;
    if (!a || a.finalSpecies?.trim() !== decision.dnaSpecies || typeof a.finalConfidence !== "number") continue;
    if (typeof penalty !== "number" || !(penalty > 0)) continue;
    const withoutPenalty = Math.min(100, a.finalConfidence + penalty);
    if (withoutPenalty >= FAMILY_PENALTY_LIFT_MIN_CONFIDENCE && (!best || withoutPenalty > best.withoutPenalty)) {
      best = { sequenceId: String(s.id), penalty, withoutPenalty };
    }
  }
  if (!best) return null;
  const shown = visionTopListMatch(vision, input.dnaFamily, decision.dnaGenus, decision.dnaSpecies);
  if (!shown) return null;
  const { reason: _reason, ...common } = decision;
  return {
    ...common,
    outcome: "agrees",
    branch: "family_penalty",
    verdictName: decision.dnaSpecies,
    familyPenaltyLift: { rank: shown.rank, name: shown.name, percent: shown.percent, ...best },
  };
}

/** The record's DNA side from its sequences' analyses (the ones auto-validation reads). */
export function visionAgreementDna(input: {
  species: string | null;
  sequences: Array<{ id: string; analysis: { finalSpecies?: string | null; finalConfidence?: number | null; flaggedContaminant?: boolean | null; [k: string]: unknown } | null | undefined }>;
}): VisionAgreementDna {
  const species = input.species?.trim() || null;
  let nameConfidence: number | null = null;
  let contaminant = false;
  let edna = false;
  for (const s of input.sequences) {
    if (isEdnaAnalysisKey(String(s.id))) edna = true;
    const a = s.analysis;
    if (!a) continue;
    if (isEdnaAnalysisResult(a)) edna = true;
    if (a.flaggedContaminant === true) contaminant = true;
    if (typeof a.finalSpecies === "string" && /^contaminant:/i.test(a.finalSpecies.trim())) contaminant = true;
    if (species && a.finalSpecies?.trim() === species && typeof a.finalConfidence === "number") {
      nameConfidence = nameConfidence == null ? a.finalConfidence : Math.max(nameConfidence, a.finalConfidence);
    }
  }
  return { species, nameConfidence, contaminant, edna };
}

/**
 * A saved run's gate verdict: the one Vision reported, else "fungus" for one of
 * Vision's own DNA references (no gate runs on that path), else null.
 */
export function visionRunGateVerdict(result: { gateVerdict?: string | null; excludedReference?: boolean | null }): string | null {
  if (typeof result.gateVerdict === "string" && result.gateVerdict.trim()) return result.gateVerdict;
  return result.excludedReference === true ? "fungus" : null;
}

/** A saved Vision run (mycomap.org's recordVisionRuns.ts RecordVisionRun) as the rule reads it; null unless done. */
export function visionAgreementVisionFromRun(run: {
  id: number;
  status: string;
  modelVersion?: string | null;
  answersVersion?: string | null;
  result: { gateVerdict?: string | null; excludedReference?: boolean | null; combined?: { species?: VisionCandidate[]; genus?: VisionCandidate[]; family?: VisionCandidate[] } | null } | null;
} | null | undefined): VisionAgreementVision | null {
  if (!run || run.status !== "done" || !run.result) return null;
  const list = (l: unknown): VisionCandidate[] => (Array.isArray(l) ? l : [])
    .filter((c: any) => c && typeof c.name === "string")
    .map((c: any) => ({ name: c.name, confidence: typeof c.confidence === "number" ? c.confidence : null }));
  return {
    runId: run.id,
    modelVersion: run.modelVersion ?? null,
    answersVersion: run.answersVersion ?? null,
    gateVerdict: visionRunGateVerdict(run.result),
    species: list(run.result.combined?.species),
    genus: list(run.result.combined?.genus),
    family: list(run.result.combined?.family),
  };
}

const pct = (p: number | null | undefined) => (typeof p === "number" ? `${Math.round(p * 100)}%` : "?%");

const NONE_TEXT: Record<VisionAgreementNoneReason, string> = {
  edna: "not used for eDNA samples",
  no_dna_species: "no DNA species result to compare",
  no_vision_answer: "no Vision answer yet",
  gate_not_passed: "Vision's fungus check did not pass",
  contaminant: "the analysis flagged a contaminant",
  names_differ: "Vision's top names differ from the DNA species",
  not_above_half: "agrees, but not above 50%",
  vision_prefers_another_genus: "Vision's top genus is another, so the DNA must reach 70 on its own",
};

const OBSERVER_SOURCE_TEXT: Record<ObserverNameSource, string> = {
  observer_identification: "the observer's identification",
  observation_name: "the observation's name",
};

/**
 * Why the genus veto did not fire, e.g. "Vision's top genus is Boletus (55%),
 * but it also shows Russula (35%), so the DNA stands.", or "Vision's top genus
 * is Leccinum (78%), but the observer's identification Xanthoconium affine
 * reticulatum is in the DNA genus Xanthoconium, so the DNA stands."
 */
export function visionVetoSparedText(d: VisionAgreementDecision): string | null {
  const top = d.visionGenus ? `${d.visionGenus.name} (${pct(d.visionGenus.probability)})` : "another genus";
  if (d.vetoSpared) return `Vision's top genus is ${top}, but it also shows ${d.vetoSpared.name} (${pct(d.vetoSpared.probability)}), so the DNA stands.`;
  const o = d.vetoSparedByObserver;
  if (o) return `Vision's top genus is ${top}, but ${OBSERVER_SOURCE_TEXT[o.source]} ${o.name} is in the DNA genus ${o.genus}, so the DNA stands.`;
  return null;
}

/**
 * Why the genus veto fired: Vision shows neither the DNA genus nor the DNA
 * species at 30% or more, and the observer's name, when there is one, is not
 * in the DNA genus either.
 */
function neitherShown(d: VisionAgreementDecision): string {
  const shown = `neither ${d.dnaGenus ?? "the DNA genus"} nor ${d.dnaSpecies ?? "the DNA species"} on its list`;
  const observer = d.observer?.name?.trim();
  return observer ? `${shown}, and ${OBSERVER_SOURCE_TEXT[d.observer!.source]} ${observer} is not in ${d.dnaGenus ?? "the DNA genus"}` : shown;
}

/**
 * One line for the analysis panel and the job log, e.g.
 * "Vision: Picipes tubaeformis 99% — agrees → green-checked (DNA + MycoMap Vision)".
 * `applied` says whether the record was in fact green-checked (or held) this way.
 */
export function describeVisionAgreement(d: VisionAgreementDecision, applied = false): string {
  const species = d.visionSpecies ? `${d.visionSpecies.name} ${pct(d.visionSpecies.probability)}` : null;
  const genus = d.visionGenus ? `genus ${d.visionGenus.name} ${pct(d.visionGenus.probability)}` : null;
  const spared = visionVetoSparedText(d);
  if (d.outcome === "agrees" && d.familyPenaltyLift) {
    const l = d.familyPenaltyLift;
    return `Vision lists ${l.rank} ${l.name} ${l.percent}%, as the DNA says, so the ${l.penalty} off for the observer's family does not count (DNA ${l.withoutPenalty}%) → ${applied ? "green-checked" : "green-checks"} (${VISION_AGREEMENT_METHOD_LABEL})`;
  }
  if (d.outcome === "agrees" && d.topListMatch) {
    const m = d.topListMatch;
    return `Vision lists ${m.rank} ${m.name} ${m.percent}%, as the DNA says, with the DNA at ${d.nameConfidence}% (${TOP_LIST_MIN_DNA_CONFIDENCE}% or more) → ${applied ? "green-checked" : "green-checks"} (${VISION_AGREEMENT_METHOD_LABEL})`;
  }
  if (d.outcome === "agrees") {
    const what = d.branch === "species"
      ? `Vision: ${species} — agrees`
      : `Vision: ${genus} supports the DNA species`;
    const line = `${what} → ${applied ? "green-checked" : "green-checks"} (${VISION_AGREEMENT_METHOD_LABEL})`;
    return spared ? `${line}. ${spared}` : line;
  }
  if (d.outcome === "vetoes") {
    return `Vision says ${genus}, DNA says ${d.dnaGenus}, and Vision shows ${neitherShown(d)}: ${applied ? "held" : "holds the record"} for a person (${VISION_HOLD_LABEL})`;
  }
  if (spared) return `${spared} Below 70%, Vision does not green-check it: ${NONE_TEXT[d.reason]}.`;
  const lead = species ?? genus;
  return lead ? `Vision: ${lead} — rule not applied: ${NONE_TEXT[d.reason]}` : `Vision: rule not applied: ${NONE_TEXT[d.reason]}`;
}

/** The Autovalidation Assist reason for a vetoed record. */
export function visionVetoReason(d: VisionAgreementDecision): string {
  const genus = d.visionGenus ? `${d.visionGenus.name} (${pct(d.visionGenus.probability)})` : "another genus";
  return `MycoMap Vision says genus ${genus}, DNA says ${d.dnaGenus ?? "?"}, and Vision shows ${neitherShown(d)}: held for a person.`;
}

/** What the validation-method row keeps of an agreement (observation_validation_methods.vision_agreement). */
export function visionAgreementDetail(d: VisionAgreementDecision & { outcome: "agrees" }) {
  return {
    branch: d.branch,
    dnaSpecies: d.dnaSpecies,
    dnaGenus: d.dnaGenus,
    nameConfidence: d.nameConfidence,
    visionName: d.familyPenaltyLift?.name ?? d.topListMatch?.name ?? (d.branch === "species" ? d.visionSpecies?.name ?? null : d.visionGenus?.name ?? null),
    visionProbability: d.familyPenaltyLift ? d.familyPenaltyLift.percent / 100 : d.topListMatch ? d.topListMatch.percent / 100 : d.branch === "species" ? d.visionSpecies?.probability ?? null : d.visionGenus?.probability ?? null,
    visionGenusComputed: d.branch === "genus" ? d.visionGenus?.computed ?? false : false,
    ...(d.familyPenaltyLift ? { familyPenaltyLift: d.familyPenaltyLift } : {}),
    ...(d.topListMatch ? { topListMatch: d.topListMatch } : {}),
    runId: d.runId,
    answersVersion: d.answersVersion,
    modelVersion: d.modelVersion,
  };
}
export type VisionAgreementDetail = ReturnType<typeof visionAgreementDetail>;

/**
 * What the validation-method row keeps (observation_validation_methods.vision_agreement)
 * when the observer's identification kept the veto from firing and the DNA
 * then validated the record (evidence VISION_OBSERVER_SPARE_EVIDENCE).
 */
export function visionObserverSpareDetail(d: VisionAgreementDecision & { vetoSparedByObserver: VisionVetoObserverSpare }) {
  return {
    spared: "observer" as const,
    observerName: d.vetoSparedByObserver.name,
    observerSource: d.vetoSparedByObserver.source,
    observerGenus: d.vetoSparedByObserver.genus,
    dnaSpecies: d.dnaSpecies,
    dnaGenus: d.dnaGenus,
    nameConfidence: d.nameConfidence,
    visionName: d.visionGenus?.name ?? null,
    visionProbability: d.visionGenus?.probability ?? null,
    visionGenusComputed: d.visionGenus?.computed ?? false,
    reason: visionVetoSparedText(d),
    runId: d.runId,
    answersVersion: d.answersVersion,
    modelVersion: d.modelVersion,
  };
}

/** The second sources (rules v1.4) a validation passed, as the job found them. */
export interface ValidationSecondSources {
  vision: SecondSource | null;
  observer: SecondSource | null;
  /** The Vision answer the Vision source was read from, for its run and versions. */
  visionAnswer: VisionAgreementVision | null;
}

/**
 * The evidence an auto-validation's provenance row records: Vision's agreement
 * made it, the observer's identification set Vision's veto aside (#364), or the
 * DNA on its own score with the v1.4 second source(s) that let it through.
 * Every v1.4 second source found is kept in vision_agreement.secondSources, so a
 * row says what besides the DNA it rested on. {} (the columns' null) only when
 * there was no second source at all: eDNA, MyCoPortal, or rules before v1.4.
 */
export function visionValidationEvidence(
  visionMakesIt: (VisionAgreementDecision & { outcome: "agrees" }) | null,
  decision: VisionAgreementDecision | null,
  second?: ValidationSecondSources | null,
): { evidence?: string; visionAgreement?: Record<string, unknown> } {
  const secondSources = [second?.vision, second?.observer].filter((s): s is SecondSource => !!s);
  const withSources = (detail: Record<string, unknown>) =>
    secondSources.length > 0 ? { ...detail, secondSources } : detail;
  if (visionMakesIt) return { evidence: VISION_AGREEMENT_EVIDENCE, visionAgreement: withSources(visionAgreementDetail(visionMakesIt)) };
  if (decision?.vetoSparedByObserver) {
    return {
      evidence: VISION_OBSERVER_SPARE_EVIDENCE,
      visionAgreement: withSources(visionObserverSpareDetail(decision as VisionAgreementDecision & { vetoSparedByObserver: VisionVetoObserverSpare })),
    };
  }
  if (secondSources.length === 0) return {};
  const answer = second?.visionAnswer ?? null;
  return {
    evidence: second?.vision ? VISION_SECOND_SOURCE_EVIDENCE : OBSERVER_SECOND_SOURCE_EVIDENCE,
    visionAgreement: {
      secondSources,
      runId: answer?.runId ?? null,
      answersVersion: answer?.answersVersion ?? null,
      modelVersion: answer?.modelVersion ?? null,
    },
  };
}

/**
 * A validation-method row's evidence as the pages show it: Validate Records
 * (GET /api/admin/validation-methods/:projectId) and the BLAST results page
 * (lib/localBlastEnrichment.ts).
 */
export function validationEvidenceFields(row: { evidence?: string | null; visionAgreement?: unknown }): {
  evidence: string | null;
  evidenceLabel: string | null;
  visionBranch: string | null;
} {
  const evidence = typeof row.evidence === "string" && row.evidence ? row.evidence : null;
  const isVision = evidence === VISION_AGREEMENT_EVIDENCE;
  const branch = isVision && row.visionAgreement && typeof row.visionAgreement === "object"
    ? (row.visionAgreement as { branch?: unknown }).branch
    : null;
  return {
    evidence,
    evidenceLabel: isVision ? VISION_AGREEMENT_METHOD_LABEL
      : evidence === VISION_OBSERVER_SPARE_EVIDENCE ? VISION_OBSERVER_SPARE_LABEL
      : evidence === VISION_SECOND_SOURCE_EVIDENCE ? VISION_SECOND_SOURCE_LABEL
      : evidence === OBSERVER_SECOND_SOURCE_EVIDENCE ? OBSERVER_SECOND_SOURCE_LABEL
      : null,
    visionBranch: branch === "species" || branch === "genus" || branch === "family_penalty" || branch === "top_list" ? branch : null,
  };
}
