/**
 * Names of groups inside a genus: subgenus, section, subsection, series,
 * subseries and complex. Shared by the API (batch analysis, auto-validation,
 * the classification route) and the BLAST results page (its own analysis), so
 * both read these names the same way (2026-11-03).
 *
 * iNaturalist names such a group with its last word alone: Cortinarius sect.
 * Verni is "Verni", Cortinarius subg. Telamonia is "Telamonia", the Amanita
 * complex Mappae is "Mappae". The legacy record store keeps that word as the record's
 * name, so a record reads "357361493 - Verni" with no genus in it. Read as a
 * genus, "Verni" has no family, and the record's analysis is held as "Manual
 * Validation Needed" however good its DNA is.
 *
 * The full name puts the genus back: "Cortinarius sect. Verni". Every parser
 * here and in the analyses reads that form, so a name is qualified once, where
 * it is read, and nothing downstream has to know about iNat's short form.
 * Which genus a bare word belongs to comes from the iNat fungal-names index
 * (mycomap.org's inatFungalNames.ts), never from a guess.
 *
 * Pure: no I/O.
 */

/** iNaturalist's ranks between genus and species, outermost first. */
export const INFRAGENERIC_RANKS = ["subgenus", "section", "subsection", "series", "subseries", "complex"] as const;
export type InfragenericRank = (typeof INFRAGENERIC_RANKS)[number];

/** Ranks between family and genus: the family is known once the taxon is ("Leccinoideae" is in Boletaceae). */
export const BETWEEN_FAMILY_AND_GENUS_RANKS = ["subfamily", "supertribe", "tribe", "subtribe"] as const;

export function isInfragenericRank(rank: string | null | undefined): rank is InfragenericRank {
  return !!rank && (INFRAGENERIC_RANKS as readonly string[]).includes(rank.trim().toLowerCase());
}

export function isBetweenFamilyAndGenusRank(rank: string | null | undefined): boolean {
  return !!rank && (BETWEEN_FAMILY_AND_GENUS_RANKS as readonly string[]).includes(rank.trim().toLowerCase());
}

/** How each rank is written between the genus and the group's name. */
const RANK_ABBREVIATION: Record<Exclude<InfragenericRank, "complex">, string> = {
  subgenus: "subg.",
  section: "sect.",
  subsection: "subsect.",
  series: "ser.",
  subseries: "subser.",
};

/** The spellings each rank is written with, longest first so "subsect." is not read as "sect.". */
const RANK_MARKERS: Array<[Exclude<InfragenericRank, "complex">, RegExp]> = [
  ["subsection", /^(?:subsect\.?|subsection)$/i],
  ["subseries", /^(?:subser\.?|subseries)$/i],
  ["subgenus", /^(?:subg\.?|subgen\.?|subgenus)$/i],
  ["section", /^(?:sect\.?|section)$/i],
  ["series", /^(?:ser\.?|series)$/i],
];

const GENUS_WORD = /^[A-Z][a-zë]+(?:-[a-z]+)?$/;
const GROUP_WORD = /^[A-Z][a-zë]+(?:-[a-z]+)?$/;

/** One Latin word with a capital, the way iNat writes a group inside a genus ("Verni"). */
export function isBareGroupWord(name: string | null | undefined): boolean {
  return GROUP_WORD.test(String(name ?? "").trim());
}

/**
 * The full name of a group inside a genus: "Cortinarius sect. Verni",
 * "Cortinarius subg. Telamonia", "Amanita Mappae complex".
 */
export function qualifiedInfragenericName(genus: string, rank: InfragenericRank, name: string): string {
  const g = genus.trim();
  const n = name.trim();
  return rank === "complex" ? `${g} ${n} complex` : `${g} ${RANK_ABBREVIATION[rank]} ${n}`;
}

export interface InfragenericName {
  genus: string;
  rank: InfragenericRank;
  /** The group's own name: "Verni". */
  name: string;
}

/**
 * Reads a full name of a group inside a genus, however it is spelled:
 * "Cortinarius sect. Verni", "Cortinarius section Verni", "Russula subsect.
 * Lilaceinae", "Cortinarius subg. Telamonia", "Amanita Mappae complex". Null
 * for anything else, a species included ("Amanita muscaria complex" is a
 * complex named after a species, and its first word is already its genus).
 */
export function parseInfragenericName(raw: string | null | undefined): InfragenericName | null {
  const words = String(raw ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 3 || !GENUS_WORD.test(words[0])) return null;
  if (words.length === 3 && /^complex$/i.test(words[2]) && GROUP_WORD.test(words[1])) {
    return { genus: words[0], rank: "complex", name: words[1] };
  }
  const marker = RANK_MARKERS.find(([, pattern]) => pattern.test(words[1]));
  if (!marker) return null;
  if (!GROUP_WORD.test(words[2])) return null;
  return { genus: words[0], rank: marker[0], name: words[2] };
}

/** What the iNat fungal-names index knows about a one-word name (an applied row). */
export interface IndexedGroup {
  rank: string | null;
  genus: string | null;
  family: string | null;
  /** The name iNat answered with, which may differ in case from the record's. */
  matchedName?: string | null;
}

/**
 * A record's name with its genus put back, when the name is iNat's one-word
 * form of a group inside a genus and the index places it: "Verni" with the
 * index's section in Cortinarius is "Cortinarius sect. Verni". Null when the
 * name needs nothing (a genus, a species, a name already qualified) or the
 * index does not place it.
 */
export function qualifyBareGroupName(name: string | null | undefined, indexed: IndexedGroup | null | undefined): InfragenericName & { qualified: string } | null {
  const word = String(name ?? "").trim();
  if (!isBareGroupWord(word) || !indexed) return null;
  if (!isInfragenericRank(indexed.rank) || !indexed.genus || !GENUS_WORD.test(indexed.genus)) return null;
  if (indexed.matchedName && indexed.matchedName.trim().toLowerCase() !== word.toLowerCase()) return null;
  const rank = indexed.rank.trim().toLowerCase() as InfragenericRank;
  const groupName = indexed.matchedName?.trim() || word;
  return { genus: indexed.genus, rank, name: groupName, qualified: qualifiedInfragenericName(indexed.genus, rank, groupName) };
}
