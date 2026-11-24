// Whether a name can be used as a taxon name at all. Moved unchanged from the
// server's family lookups (mycomap.org's familyTaxonomyResolver.ts),
// which still exports both.
const PLACEHOLDER_NAMES = new Set([
  "no definition",
  "no definition line",
  "unknown",
  "unidentified",
  "not identified",
  "n/a",
  "na",
  "none",
]);

export function isTaxonomicPlaceholder(name: string | null | undefined): boolean {
  if (!name) return true;
  const normalized = name.trim().toLowerCase().replace(/[\s.!?,;:]+$/g, "").trim();
  return !normalized
    || PLACEHOLDER_NAMES.has(normalized)
    || /^(unknown|unidentified|no definition)\b/.test(normalized);
}

export function isUsableTaxonName(name: string | null | undefined): name is string {
  if (!name || isTaxonomicPlaceholder(name)) return false;
  return /^[A-Z][a-z]+(?:\s+.+)?$/.test(name.trim());
}
