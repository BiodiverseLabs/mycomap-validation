// Whether a sequence sits in the ONT Trashcan. Moved unchanged from the server
// (mycomap.org's sequenceCategory.ts), which still exports both
// and keeps the part that moves a sequence there.
export function sequenceHasTrashCategory(value: unknown): boolean {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const category = record.category;
  const categoryRecord = category && typeof category === "object"
    ? category as Record<string, unknown>
    : {};
  // 169 is the established recoverable ONT Trashcan category. Keep the name
  // check too: older API responses do not consistently include categoryId.
  if (Number(record.categoryId ?? record.category_id ?? categoryRecord.id) === 169) return true;
  return [record.categoryName, categoryRecord.name, typeof category === "string" ? category : null]
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .some(name => name.toLowerCase().includes("trash"));
}

export const RECOVERABLE_TRASH_CATEGORY_ID = 169;

/** The record store's "ONT Sequences": consensus sequences from the nanopore barcoding runs. */
export const ONT_SEQUENCE_CATEGORY_ID = 168;

/** The ONT categories: ONT Sequences and the ONT Trashcan they are moved to. */
const ONT_CATEGORY_IDS = new Set([ONT_SEQUENCE_CATEGORY_ID, RECOVERABLE_TRASH_CATEGORY_ID]);

/**
 * Whether the sequence is in an ONT category (168 ONT Sequences, 169 ONT
 * Trashcan), from its category id or, when an answer has no id, its name.
 * False for every other category the record store has: 132 Sanger, 165 Mushroom Observer,
 * 166 Environmental, 167 iNaturalist, 170 User Submission. Null when the
 * value carries no category at all.
 */
export function sequenceIsOntCategory(value: unknown): boolean | null {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const category = record.category;
  const categoryRecord = category && typeof category === "object"
    ? category as Record<string, unknown>
    : {};
  const rawId = record.categoryId ?? record.category_id ?? categoryRecord.id;
  if (rawId !== null && rawId !== undefined && String(rawId).trim() !== "") {
    const id = Number(rawId);
    if (Number.isInteger(id) && id > 0) return ONT_CATEGORY_IDS.has(id);
  }
  const names = [record.categoryName, categoryRecord.name, typeof category === "string" ? category : null]
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  if (names.length === 0) return null;
  return names.some(name => /\bont\b/i.test(name) || name.toLowerCase().includes("trash"));
}

/**
 * The reads in consensus (RiC) the rules judge a sequence by, or null when the
 * sequence is "possibly Sanger" and RiC says nothing about it.
 *
 * RiC is a quality signal of a nanopore consensus only (the `-RiC<n>` of an
 * ONT run's file name or summary). A Sanger read has none, and an iNaturalist
 * or Mushroom Observer sequence may be either. 2026-11-16: "Any other
 * category sequence (iNat, MO, Sanger) should be treated as possible Sanger.
 * No RiC would be a good indicator of which is Sanger and which is not."
 * So a sequence is possibly Sanger when
 * - its category is known and is not an ONT one, or
 * - it has no recorded RiC (`recordedRic` null), whatever its category.
 * Only an ONT sequence with a recorded RiC is judged by it. A sequence whose
 * category is unknown is judged by a recorded RiC, since only ONT reads have one.
 *
 * `recordedRic` must already tell a recorded value from a missing one: The record store's
 * API casts a missing reads_in_consensus to 0, so a 0 read from it is not a
 * recorded 0 until the stored value says so (the server's withStoredRic).
 */
export function ricForRules(sequence: unknown, recordedRic: number | null | undefined): number | null {
  if (recordedRic === null || recordedRic === undefined || !Number.isFinite(recordedRic)) return null;
  if (sequenceIsOntCategory(sequence) === false) return null;
  return recordedRic;
}

/** The record store's categories for sequences imported from the observation's own platform. */
export const INAT_SEQUENCE_CATEGORY_ID = 167;
export const MO_SEQUENCE_CATEGORY_ID = 165;

/**
 * Whether the sequence is a copy of one held on iNaturalist or Mushroom
 * Observer (categories 167 and 165, or their names): imported from there, so
 * pushing it back would add nothing. By id when the answer has one, else by name.
 */
export function sequenceIsPlatformCopy(value: unknown): boolean {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const category = record.category;
  const categoryRecord = category && typeof category === "object"
    ? category as Record<string, unknown>
    : {};
  const rawId = record.categoryId ?? record.category_id ?? categoryRecord.id;
  if (rawId !== null && rawId !== undefined && String(rawId).trim() !== "") {
    const id = Number(rawId);
    if (Number.isInteger(id) && id > 0) return id === INAT_SEQUENCE_CATEGORY_ID || id === MO_SEQUENCE_CATEGORY_ID;
  }
  return [record.categoryName, categoryRecord.name, typeof category === "string" ? category : null]
    .filter((name): name is string => typeof name === "string")
    .some(name => {
      const lower = name.toLowerCase();
      return lower.includes("inaturalist") || lower.includes("mushroom observer") || lower.includes("mo sequences");
    });
}

/** True when RiC says nothing about the sequence (see ricForRules). */
export function isPossiblySanger(sequence: unknown, recordedRic: number | null | undefined): boolean {
  return ricForRules(sequence, recordedRic) === null;
}
