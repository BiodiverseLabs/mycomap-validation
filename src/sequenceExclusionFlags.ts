/**
 * The sequence flags that keep a sequence out of naming and validation.
 *
 * The record store keeps a sequence's flags as JSON in field_718; mycomap.org reads them raw
 * (`{"contaminant":true,"wrong":1}`, the sequences mirror's `flags`) or as
 * the API's labels (comMirror/sequenceAnswers.ts FLAG_LABELS:
 * contaminant -> "non-target", wrong -> "wrong-specimen").
 *
 *  - contaminant / non-target: the sequence is another organism than its
 *    specimen.
 *  - wrong: the sequence is attached to the wrong observation or specimen.
 *    2026-10-13: such sequences "are generally excluded from any
 *    future use", so mycomap.org treats them like contaminant ones.
 */

const CONTAMINANT_NAMES = new Set(["contaminant", "non-target", "non_target", "nontarget"]);
const WRONG_SPECIMEN_NAMES = new Set(["wrong", "wrong-specimen", "wrong_specimen", "wrongspecimen"]);
/** Flags that also block auto-validation's choice of sequence: mycotroph and low RiC. */
const OTHER_BLOCKING_NAMES = new Set(["m", "mycotroph", "l", "lowric", "low-ric"]);

function normalize(flag: unknown): string {
  return typeof flag === "string" ? flag.trim().toLowerCase() : "";
}

export function isContaminantFlagName(flag: unknown): boolean {
  return CONTAMINANT_NAMES.has(normalize(flag));
}

export function isWrongSpecimenFlagName(flag: unknown): boolean {
  return WRONG_SPECIMEN_NAMES.has(normalize(flag));
}

/** Contaminant (non-target) or wrong specimen. */
export function isExcludedSequenceFlag(flag: unknown): boolean {
  return isContaminantFlagName(flag) || isWrongSpecimenFlagName(flag);
}

/** A flag that keeps a sequence from being the one auto-validation pushes: excluded, mycotroph or low RiC. */
export function isBlockingSequenceFlag(flag: unknown): boolean {
  return isExcludedSequenceFlag(flag) || OTHER_BLOCKING_NAMES.has(normalize(flag));
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

/**
 * The flag names a sequence carries, from any of the shapes mycomap.org sees: an
 * array of labels, an array holding the record store's JSON string, the JSON string
 * itself, or the parsed object. In JSON only keys whose value is set count.
 */
export function sequenceFlagNames(flags: unknown): string[] {
  if (flags === null || flags === undefined) return [];
  if (Array.isArray(flags)) return flags.flatMap((flag) => sequenceFlagNames(flag));
  if (typeof flags === "string") {
    const trimmed = flags.trim();
    if (!trimmed.startsWith("{")) return trimmed ? [trimmed] : [];
    try {
      return sequenceFlagNames(JSON.parse(trimmed));
    } catch {
      return [trimmed];
    }
  }
  if (typeof flags === "object") {
    return Object.entries(flags as Record<string, unknown>).filter(([, value]) => truthy(value)).map(([name]) => name);
  }
  return [];
}

/** True when the sequence is flagged contaminant (non-target) or wrong specimen. */
export function hasExcludedSequenceFlag(flags: unknown): boolean {
  return sequenceFlagNames(flags).some(isExcludedSequenceFlag);
}

/** True when the sequence is flagged wrong specimen. */
export function hasWrongSpecimenFlag(flags: unknown): boolean {
  return sequenceFlagNames(flags).some(isWrongSpecimenFlagName);
}
