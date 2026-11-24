/**
 * Reading the species names a deterministic analysis writes, for auto-validation
 * rules v2 (mycomap.org's autovalidationV2.ts).
 *
 * v2 validates only when the DNA reaches species (2026-10-20, #271 7.5):
 * a binomial or a provisional name counts, in every style the data holds;
 * a bare "Genus sp." or a genus alone does not. An analysis can also put a
 * verdict where the name goes ("Manual Validation Needed", "Singleton
 * Sequence", "Non-Target: …", "Likely Chimera - …"); that is not a name.
 *
 * Styles seen in blast_analysis_results.finalSpecies (prod, 2026-10-20):
 *   Abortiporus biennis                     binomial
 *   Agaricus sylvaticus occidentalis        binomial (infraspecific)
 *   Agaricus porphyrocephalus var. pallidus binomial (infraspecific)
 *   Adelphella sp. 'babingtonii-CA01'       provisional
 *   Adelphella "babingtonii-CA01"           provisional
 *   Alnicola 'escharioides PNW01'           provisional
 *   Cortinarius sp-IN48 / "sp-IN48"         provisional
 *   Amylocystis PNW01                       provisional
 *   Abies sp. 'env001'                      provisional (eDNA code)
 *   Helotiales sp. 'PA05'                   provisional (2026-11-10: a
 *   Fungi sp. 'env001'                      provisional is a species whatever
 *                                           its first word)
 *   Agaricales / Fungi / Agaricales sp.     above genus
 */

import { isAboveGenusName, provisionalCode } from "./aboveGenusNames";

export type SpeciesNameKind =
  | "binomial"
  | "provisional"
  | "genus_only"
  | "bare_sp"
  | "above_genus"
  | "verdict"
  | "empty"
  | "unparsed";

export interface ParsedSpeciesName {
  kind: SpeciesNameKind;
  /** The name as given, trimmed. */
  name: string;
  /** The first word when it reads as a genus (or a higher taxon for above_genus). */
  genus: string | null;
  /** binomial: the epithet (and infraspecific part); provisional: its code. */
  rest: string | null;
}

/** What an analysis writes in place of a name when it reached no name. */
const VERDICT_PATTERN = /^(manual validation needed|singleton\b|likely chimera|chimera\b|non-target\b|non target\b|contaminant\b|no blast hits|no hits|unidentified|unknown\b)/i;
const GENUS_PATTERN = /^[A-Z][a-zë]+$/;
const BARE_SP_PATTERN = /^(sp|spp|species)\.?$/i;
const EPITHET_PATTERN = /^[a-zë][a-zë-]+$/;
const INFRA_PATTERN = /^(var\.|subsp\.|ssp\.|f\.|forma|subvar\.)$/;
const QUOTE_PATTERN = /['"‘’“”]/;
const QUOTES_GLOBAL = /['"‘’“”]/g;

export function isVerdictText(name: string | null | undefined): boolean {
  return VERDICT_PATTERN.test(String(name ?? "").trim());
}

export function parseSpeciesName(raw: string | null | undefined): ParsedSpeciesName {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!name) return { kind: "empty", name, genus: null, rest: null };
  if (isVerdictText(name)) return { kind: "verdict", name, genus: null, rest: null };

  const [first, ...others] = name.split(" ");
  const rest = others.join(" ").trim();
  // The whole name, not the first word: a provisional name is a species whatever its
  // first word ("Helotiales sp. 'PA05'"), so only an above-genus name without a code stops here.
  if (isAboveGenusName(name)) {
    return { kind: "above_genus", name, genus: first, rest: rest || null };
  }
  // A provisional under a higher group ("Helotiales sp. 'PA05'", "Fungi sp. 'env001'") keeps
  // that word in `genus`, as the name was written.
  const code = provisionalCode(rest);
  if (code && (GENUS_PATTERN.test(first) || isAboveGenusName(first))) {
    return { kind: "provisional", name, genus: first, rest: code };
  }
  if (!GENUS_PATTERN.test(first)) return { kind: "unparsed", name, genus: null, rest: null };
  if (!rest) return { kind: "genus_only", name, genus: first, rest: null };
  if (BARE_SP_PATTERN.test(rest)) return { kind: "bare_sp", name, genus: first, rest: null };
  // Quoted but with no code: "Cortinarius sp. ''".
  if (QUOTE_PATTERN.test(rest)) return { kind: "bare_sp", name, genus: first, rest: null };

  const words = rest.split(" ");
  if (EPITHET_PATTERN.test(words[0]) && words.slice(1).every((w) => EPITHET_PATTERN.test(w) || INFRA_PATTERN.test(w))) {
    return { kind: "binomial", name, genus: first, rest };
  }
  return { kind: "unparsed", name, genus: first, rest };
}

/** Rule 10: the DNA reached species (a binomial or a provisional name). */
export function reachesSpecies(parsed: ParsedSpeciesName): boolean {
  return parsed.kind === "binomial" || parsed.kind === "provisional";
}

/**
 * One key per taxon whatever the style, so "Alnicola sp. 'escharioides-PNW01'"
 * and "Alnicola 'escharioides PNW01'" count as one species, not a tie between
 * two. The genus is given canonical (after synonyms) by the caller.
 */
export function speciesKey(parsed: ParsedSpeciesName, canonicalGenus: string | null = parsed.genus): string {
  const genus = (canonicalGenus ?? parsed.genus ?? "").toLowerCase();
  if (!parsed.rest) return `${genus}|${parsed.kind}`;
  const rest = parsed.rest
    .toLowerCase()
    .replace(QUOTES_GLOBAL, " ")
    .replace(/\bsp[.\-\s]+/g, " ")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${genus}|${rest}`;
}

/** Loose whole-name equality (quote glyphs + whitespace + case insensitive). */
export function namesAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) =>
    (s || "").normalize("NFKC").replace(/[`'’‘′“”"]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a) !== "" && norm(a) === norm(b);
}
