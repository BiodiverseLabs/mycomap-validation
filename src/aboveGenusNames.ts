// Names above genus: a kingdom word ("Fungi"), or one word with the ending of a family,
// order, class or phylum and their sub-ranks (Cortinariaceae, Agaricales, Agaricomycetes,
// Basidiomycota). Used by the analysis and by the server's record rules
// (autovalidationNames.ts), so both read a name the same way.
//
// A provisional name is created at species rank whatever its first word is
// (2026-11-10): "Helotiales sp. 'PA05'" is a species, not an order. Its first word only says
// where the species was placed when it was named. So a name carrying a provisional code is
// never above genus. The case: seq 865264 (inat:390496302), whose 8 MycoBLAST hits named
// Helotiales sp. 'PA05' were dropped from the vote and 4 variant reads of one other well
// carried the consensus to Strobilomyces strobilaceus.

/** Endings of names above genus (family, order, class, phylum and their sub-ranks). */
export const ABOVE_GENUS_PATTERN = /(aceae|ales|ineae|oideae|mycetes|mycetidae|mycota|mycotina|phyceae|phyta|opsida)$/;
/** Words that name a group above genus whatever their ending. */
export const ABOVE_GENUS_WORDS = new Set(["fungi", "fungal", "incertae", "eukaryota", "viridiplantae", "metazoa", "bacteria"]);
const GENUS_WORD = /^[A-Z][a-zë]+$/;

const BARE_SP_PATTERN = /^(sp|spp|species)\.?$/i;
/** A provisional code without quotes: "sp-IN67", "sp. IN67", "sp.IN67". */
const SP_CODE_PATTERN = /^sp(?:\.|-|\.\s*|\s+)-?[A-Za-z0-9][A-Za-z0-9-]*$/i;
/** A bare region-and-number code: "PNW01", "IN67", "CA01a". */
const BARE_CODE_PATTERN = /^[A-Z]{1,6}\d{1,4}[A-Za-z0-9-]*$/;
const QUOTE_PATTERN = /['"‘’“”]/;
const QUOTES_GLOBAL = /['"‘’“”]/g;

/**
 * The provisional code in what follows a name's first word, or null when there is none:
 * "sp. 'PA05'" → "PA05", "'escharioides PNW01'" → "escharioides PNW01", "sp-IN67" → "IN67",
 * "PNW01" → "PNW01". A bare "sp." or an empty quote is no code.
 */
export function provisionalCode(rest: string | null | undefined): string | null {
  const text = String(rest ?? "").trim().replace(/\s+/g, " ");
  if (!text) return null;
  if (QUOTE_PATTERN.test(text)) {
    const code = text.replace(/^(?:sp|spp)\.?\s*/i, "").replace(QUOTES_GLOBAL, "").trim();
    return code && !BARE_SP_PATTERN.test(code) ? code : null;
  }
  if (SP_CODE_PATTERN.test(text)) return text.replace(/^sp[.\-\s]*/i, "");
  if (BARE_CODE_PATTERN.test(text)) return text;
  return null;
}

/**
 * The name is a group above genus: "Fungi", "Fungi sp.", "Cortinariaceae", "Agaricales sp.".
 * A provisional name ("Helotiales sp. 'PA05'") is a species, so it is not.
 */
export function isAboveGenusName(name: string | null | undefined): boolean {
  const [first = "", ...others] = String(name ?? "").trim().split(/\s+/);
  if (!first) return false;
  const aboveGenusWord = ABOVE_GENUS_WORDS.has(first.toLowerCase()) || (GENUS_WORD.test(first) && ABOVE_GENUS_PATTERN.test(first));
  return aboveGenusWord && provisionalCode(others.join(" ")) === null;
}
