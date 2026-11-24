// Names as taxonomy places them: synonyms, the canonical genus and species, and where a name
// sits. Moved unchanged from mycomap.org's autovalidationTaxonomy.ts
// which keeps the lookup that reads the database.
import { type ParsedSpeciesName, parseSpeciesName } from "./autovalidationNames";

/**
 * Genera that name the same group in the data, to their canonical genus (the
 * one mycomap.org's iNaturalist taxonomy uses). From the #271 review §3.2: Naucoria /
 * Alnicola ×13 and Collybiopsis / Gymnopus. Data, versioned with the rules.
 */
export const GENUS_SYNONYMS: Readonly<Record<string, string>> = {
  alnicola: "Naucoria",
  collybiopsis: "Gymnopus",
};

/** Species placed in another genus by one side: the DNA's name to iNaturalist's. */
export const SPECIES_SYNONYMS: Readonly<Record<string, string>> = {
  "lentinula reticeps": "Rhodotus reticeps",
};

export interface TaxonRow {
  kingdom: string | null;
  order: string | null;
  family: string | null;
}

/** What mycomap.org knows: genus (lower case, canonical) → its placement. */
export type TaxonLookup = ReadonlyMap<string, TaxonRow>;
export type PlacementRank = "species" | "genus" | "family" | "order" | "higher" | "none";
export interface Placement {
  name: string;
  parsed: ParsedSpeciesName;
  rank: PlacementRank;
  genus: string | null;
  family: string | null;
  order: string | null;
  kingdom: string | null;
}

export function canonicalGenus(genus: string | null | undefined): string | null {
  const g = String(genus ?? "").trim();
  if (!g) return null;
  return GENUS_SYNONYMS[g.toLowerCase()] ?? g;
}

/** The name after the species-synonym table. */
export function canonicalSpeciesName(name: string | null | undefined): string {
  const n = String(name ?? "").trim().replace(/\s+/g, " ");
  return SPECIES_SYNONYMS[n.toLowerCase()] ?? n;
}

/** Where a name sits, from the lookup. A name mycomap.org can't place keeps its genus. */
export function placeName(name: string | null | undefined, lookup: TaxonLookup): Placement {
  const canonical = canonicalSpeciesName(name);
  const parsed = parseSpeciesName(canonical);
  const none = { name: canonical, parsed, genus: null, family: null, order: null, kingdom: null };
  if (parsed.kind === "empty" || parsed.kind === "verdict" || !parsed.genus) return { ...none, rank: "none" };
  if (parsed.kind === "above_genus") {
    const word = parsed.genus;
    const row = lookup.get(word.toLowerCase()) ?? null;
    if (/aceae$/.test(word)) return { ...none, rank: "family", family: word, order: row?.order ?? null, kingdom: row?.kingdom ?? null };
    if (/ales$/.test(word)) return { ...none, rank: "order", order: word, kingdom: row?.kingdom ?? null };
    return { ...none, rank: "higher", kingdom: /^fungi|^fungal/i.test(word) ? "Fungi" : row?.kingdom ?? null };
  }
  const genus = canonicalGenus(parsed.genus)!;
  const row = lookup.get(genus.toLowerCase()) ?? null;
  return {
    name: canonical,
    parsed,
    rank: parsed.kind === "binomial" || parsed.kind === "provisional" ? "species" : "genus",
    genus,
    family: row?.family ?? null,
    order: row?.order ?? null,
    kingdom: row?.kingdom ?? null,
  };
}

export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}
