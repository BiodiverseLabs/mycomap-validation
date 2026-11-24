// The engine's questions about one sequence, answered from the user's own
// computer: its BLAST hits from the local search, each MycoMap hit's record
// from the names table, and each genus's family from the same table.
//
// What mycomap.org answers from live services the tool cannot reach offline:
//   - a record name's rank from the fungal-names index: read from the name
//     itself (one word is a genus, two or more a species);
//   - the name on a MycoMap hit's iNaturalist or Mushroom Observer
//     observation: the names table's own name is used, as it already is
//     whenever it reads as a taxon;
//   - MycoMap's curation of GenBank records (verified accessions): none, so
//     each GenBank hit is named from its title, as mycomap.org does for any
//     accession it has not curated.
import { adjustedIdentityByHit } from "../src/adjustedIdentity";
import type { AnalysisPorts } from "../src/analysis";
import type { BlastEvidence, SequenceRecord } from "../src/analysisRules";
import type { FamilyResolution } from "../src/familyTypes";
import type { ParsedBlastResult } from "./blast";

/** Each hit's adjusted identity, from its first HSP's aligned strands, as mycomap.org works it out. */
export function adjustedIdentities(result: ParsedBlastResult): Record<number, number> {
  return adjustedIdentityByHit(result.hits
    .filter((h) => h.hsps[0]?.qseq && h.hsps[0]?.hseq)
    .map((h) => ({ num: h.num, qseq: h.hsps[0].qseq, hseq: h.hsps[0].hseq })));
}

export function familyAnswer(name: string, families: ReadonlyMap<string, string>): FamilyResolution {
  const first = name.trim().split(/\s+/)[0] ?? "";
  const family = /aceae$/.test(first) ? first : families.get(first) ?? null;
  return {
    requestedName: name,
    family,
    authority: family ? "mycomap" : null,
    resolvedAt: 0,
    authorities: [{ authority: "mycomap", family, matchedName: family ? first : null, resolvedAt: 0, status: family ? "resolved" : "not_found" }],
    disagreements: [],
  };
}

export function rankOfName(name: string | null, provided: string | null | undefined): string | null {
  if (provided) return provided;
  if (!name?.trim()) return null;
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return /aceae$/.test(words[0]) ? "family" : "genus";
  return "species";
}

export interface LocalEvidence {
  mycomap: ParsedBlastResult;
  /** Null when the NCBI database was not searched. */
  ncbi: ParsedBlastResult | null;
  records: ReadonlyMap<string, SequenceRecord>;
  families: ReadonlyMap<string, string>;
  /** Where the analysis's working notes go; nothing by default. */
  log?: (line: string) => void;
}

export function localPorts(evidence: LocalEvidence): AnalysisPorts {
  const ncbi = evidence.ncbi ?? { queryLen: evidence.mycomap.queryLen, hits: [] };
  const note = evidence.log ?? (() => undefined);
  return {
    recordName: async () => null,
    blastEvidence: async () => ({
      failure: null,
      localResult: evidence.mycomap,
      ncbiResult: ncbi,
      localAdjustedMap: adjustedIdentities(evidence.mycomap),
      ncbiAdjustedMap: adjustedIdentities(ncbi),
      localIdentityAsked: evidence.mycomap.hits.filter((h) => h.hsps[0]?.qseq && h.hsps[0]?.hseq).length,
      ncbiIdentityAsked: ncbi.hits.filter((h) => h.hsps[0]?.qseq && h.hsps[0]?.hseq).length,
      xmlSources: "local blastn",
    } satisfies BlastEvidence),
    // Copies: the analysis may fill a record's name in, and must not change the table's own.
    sequenceMetadata: async (accessions) => Object.fromEntries(accessions.flatMap((acc) => {
      const record = evidence.records.get(acc);
      return record ? [[acc, { ...record, flags: record.flags ? [...record.flags] : null, species: record.species ? { ...record.species } : null }]] : [];
    })),
    observationSpecies: async () => ({}),
    genbankMetadata: async () => ({}),
    sourceRank: async (name, provided) => rankOfName(name, provided),
    family: async (name) => familyAnswer(name, evidence.families),
    saveInterimResult: async () => undefined,
    logger: {
      log: (...args) => note(args.map(String).join(" ")),
      warn: (...args) => note(args.map(String).join(" ")),
      error: (...args) => note(args.map(String).join(" ")),
    },
    edna: null,
  };
}
