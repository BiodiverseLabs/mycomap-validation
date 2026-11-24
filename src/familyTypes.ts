// The answer to "which family is this name in": the shape the analysis is
// handed, and how it is written into the analysis steps. Moved unchanged from
// mycomap.org's family lookups (familyTaxonomyResolver.ts), which still exports all of it and keeps
// the lookups themselves.
export type FamilyAuthority = "inaturalist" | "ncbi" | "mycomap";

export interface FamilyAuthorityResult {
  authority: FamilyAuthority;
  family: string | null;
  matchedName: string | null;
  resolvedAt: number;
  status: "resolved" | "not_found" | "unavailable";
}

export interface FamilyResolution {
  requestedName: string;
  family: string | null;
  authority: FamilyAuthority | null;
  resolvedAt: number;
  authorities: FamilyAuthorityResult[];
  disagreements: string[];
}

export function formatFamilyResolution(result: FamilyResolution): string[] {
  if (!result.family || !result.authority) {
    return [`Family unresolved for "${result.requestedName}" after iNaturalist, NCBI, and MycoMap lookups`];
  }
  const details = [`Family authority: ${result.authority === "inaturalist" ? "iNaturalist" : result.authority === "ncbi" ? "NCBI" : "MycoMap"} (${result.family})`];
  details.push(...result.disagreements);
  return details;
}
