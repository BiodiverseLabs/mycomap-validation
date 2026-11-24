/**
 * Pure species-name helpers shared by the deterministic analysis, FungAI
 * Method 2 and the Jev evaluation. No I/O: safe to import from pure modules.
 */

export function isUnculturedName(name: string): boolean {
  return /^uncultured\s/i.test(name);
}

/**
 * GenBank's stand-in organism names: no taxon, only a description of what was
 * sequenced ("Vouchered mycorrhizae (Basidiomycota)", "Ectomycorrhizal fungus",
 * "Soil fungus", "Collembola environmental sample"). Like "uncultured fungus"
 * they name no genus, whatever their first word looks like (2026-11-16:
 * "Vouchered is not a genus. It is a GenBank status like uncultured").
 *
 * Used where a genus is read from a hit's name (a new name's genus, a stray
 * read's likely name). The analysis's own species votes do not use it.
 */
const PLACEHOLDER_FIRST_WORDS = new Set([
  "vouchered", "uncultured", "unidentified", "unclassified", "unknown", "environmental",
  "fungal", "mycorrhizal", "ectomycorrhizal", "endomycorrhizal", "arbuscular", "ericoid", "orchid",
  "endophytic", "endophyte", "root", "soil", "lichenized", "lichen", "marine", "freshwater",
  "leaf", "wood", "plant", "symbiotic", "rhizosphere",
]);
const PLACEHOLDER_LATER_WORDS = new Set(["fungus", "fungi", "fungal", "mycorrhizae", "mycorrhiza", "mycorrhizal", "endophyte", "endophytes", "symbiont"]);

/** A first word that is a GenBank stand-in, never a genus ("Vouchered", "Ectomycorrhizal", "Soil"). */
export function isPlaceholderGenusWord(word: string | null | undefined): boolean {
  return PLACEHOLDER_FIRST_WORDS.has(String(word ?? "").trim().toLowerCase());
}

/** Whether a hit's organism name is one of GenBank's stand-ins rather than a taxon. */
export function isPlaceholderOrganismName(name: string | null | undefined): boolean {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  if (isPlaceholderGenusWord(words[0])) return true;
  if (/\benvironmental samples?\b/i.test(words.join(" "))) return true;
  return words.slice(1).some((word) => PLACEHOLDER_LATER_WORDS.has(word.toLowerCase().replace(/[^a-z]/g, "")));
}

export function normalizeSpeciesName(name: string): string {
  if (!name) return name;
  const hasQuotes = /['""\u201C\u201D\u2018\u2019]/.test(name);
  const hasSp = /\bsp[\.\-]\s*/i.test(name);
  if (hasSp && !hasQuotes) {
    const spMatch = name.match(/^([A-Z][a-z]+)\s+sp[\.\-]\s*.+$/);
    if (spMatch) {
      return `${spMatch[1]} sp.`;
    }
  }
  const hasNumerals = /\d/.test(name);
  if (!hasQuotes && !hasNumerals && !hasSp) return name;
  const match = name.match(/^([A-Z][a-z]+)\s+(?:sp[\.\-]\s*)?['""\u201C\u201D\u2018\u2019]*(?:sp[\-]\s*)?([^'""'\u201C\u201D\u2018\u2019]+?)['""\u201C\u201D\u2018\u2019]*$/);
  if (!match) return name;
  const genus = match[1];
  const epithet = match[2].trim().replace(/\s+/g, '-').replace(/-(?=\d+$)/, '');
  return `${genus} sp. '${epithet}'`;
}

export function speciesNamesMatch(a: string, b: string): boolean {
  return normalizeSpeciesName(a) === normalizeSpeciesName(b);
}

/**
 * A rename, validation, or accession override may only point at a
 * species-level unit: a real binomial or a quoted temporary code. A bare genus
 * or section ("Samsoniella", "Vaginatae"), an unquoted "Genus sp." label, an
 * uncultured label, or a lifecycle sentinel would downgrade or corrupt a
 * record that already carries a more specific name.
 */
export function isSpeciesLevelCurationTarget(name: string | null | undefined): name is string {
  if (!name) return false;
  const trimmed = name.trim();
  if (!trimmed || /^(Singleton|Likely Chimera|Manual Validation|Barcode Gap)/i.test(trimmed)) return false;
  if (isUnculturedName(trimmed)) return false;
  if (isRealBinomial(trimmed)) return true;
  // A temporary code or nom. prov. is recognisable by its quoted epithet. A
  // bare "Genus sp." also normalizes to a quoted form, so require the quote in
  // the name as written.
  if (!/['"“”‘’]/.test(trimmed)) return false;
  const code = normalizeSpeciesName(trimmed).match(/^[A-Z][a-z]+ sp\. '([^']+)'$/);
  return Boolean(code && !/^sp\.?$/i.test(code[1]));
}

export function isEnvCodeName(s: string | null | undefined): boolean {
  return !!s && /sp\.\s*'env\d+'/i.test(s);
}

export function isBinomialName(s: string | null | undefined): boolean {
  if (!s) return false;
  const trimmed = s.trim();
  // Reject any qualifier tokens that mark a non-canonical / provisional name.
  // Catches: "Genus sp.", "Genus cf.", "Genus aff.", "Genus nr.", "Genus indet.",
  // "Genus sect.", "Genus subgen.", "Genus sp. nov.", "Genus sp. 'env001'", etc.
  if (/\b(sp|cf|aff|nr|indet|subgen|subg|sect|gr|grp|complex|clade|nov|s\.l|s\.s)\.?(\s|$|')/i.test(trimmed)) return false;
  if (/\bunidentified\b/i.test(trimmed)) return false;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return false;
  if (!/^[A-Z][a-z]+$/.test(parts[0])) return false;
  // Species epithet: lowercase, alphabetic (allow hyphens), at least 2 chars
  if (!/^[a-z][a-z-]{1,}$/.test(parts[1])) return false;
  return true;
}

export function isRealBinomial(s: string | null | undefined): s is string {
  return !!s
    && !isUnculturedName(s)
    && !isEnvCodeName(s)
    && !/^(Singleton|Likely Chimera|Manual Validation|Barcode Gap)/i.test(s)
    && isBinomialName(s);
}
