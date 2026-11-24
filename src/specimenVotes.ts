// One vote per specimen in the MycoBLAST species vote.
//
// A specimen sequenced several times (variant reads v1, v2, v13…, or samples -1, -2 of one
// observation) is still one record. Counted per read, four low-RiC variants of one well
// (A08-iNat397552553) outvoted eight other records on seq 865264 and carried the consensus to
// Strobilomyces strobilaceus 4/4 at tier A (2026-11-10). Each specimen now gives one vote for
// each name its reads carry, at the best identity among those reads.

import { normalizeSpeciesName } from "./speciesNames";

export interface SpecimenVoteEntry {
  binomial: string;
  adjIdentity: number;
  /** "inat:123", "mo:456", "obs:789"; null when the hit can't be tied to a specimen (it then votes alone). */
  specimenKey?: string | null;
}

/**
 * Collapse reads of one specimen to one vote per name. Keeps, for each specimen and name,
 * the read with the highest identity, so a specimen counts at a tier when any of its reads
 * reaches that tier's identity. Entries without a specimen key are kept as they are.
 */
export function oneVotePerSpecimen<T extends SpecimenVoteEntry>(entries: T[]): T[] {
  const best = new Map<string, T>();
  const unkeyed: T[] = [];
  for (const e of entries) {
    const specimen = e.specimenKey?.trim();
    if (!specimen) { unkeyed.push(e); continue; }
    const key = `${specimen.toLowerCase()}\u0000${normalizeSpeciesName(e.binomial)}`;
    const kept = best.get(key);
    if (!kept || e.adjIdentity > kept.adjIdentity) best.set(key, e);
  }
  return [...best.values(), ...unkeyed];
}

/** A detail line for the analysis when reads were collapsed, or null when every read was its own specimen. */
export function specimenVoteNote(readCount: number, voteCount: number): string | null {
  if (voteCount >= readCount) return null;
  return `${readCount} hits came from ${voteCount} specimen votes: reads of one specimen vote once per name`;
}

/**
 * How many specimens a set of hits comes from: reads sharing a specimen key count once, and a
 * hit with no key counts alone. The confidence score's Base counts these, not reads
 * (2026-11-17: three variant reads of one Piloderma specimen gave "3 validated hits").
 */
export function countSpecimens(entries: Array<{ specimenKey?: string | null }>): number {
  const keyed = new Set<string>();
  let unkeyed = 0;
  for (const e of entries) {
    const specimen = e.specimenKey?.trim();
    if (specimen) keyed.add(specimen.toLowerCase());
    else unkeyed++;
  }
  return keyed.size + unkeyed;
}

/** Base's reason, naming specimens when reads were collapsed and keeping the old wording otherwise. */
export function validatedHitPhrase(specimens: number, reads: number): string {
  if (reads > specimens) {
    return `${specimens} validated MycoBLAST specimen${specimens !== 1 ? "s" : ""} (${reads} hits; reads of one specimen count once)`;
  }
  return `${specimens} validated MycoBLAST hit${specimens !== 1 ? "s" : ""}`;
}
