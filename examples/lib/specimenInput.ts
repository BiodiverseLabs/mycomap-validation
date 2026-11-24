// Turns a specimen written in plain terms (its name, its read count, the hits
// BLAST found and the family of each genus) into what the engine asks for.
//
// The engine never runs BLAST or looks anything up itself: whoever runs it
// answers its questions through "ports". mycomap.org answers them from its own
// data; this file answers them from one JSON file, so you can try the rules on
// a specimen of your own.
import type { AnalysisPorts } from "../../src/analysis";
import type { BlastEvidence, GenBankRecord, SequenceRecord } from "../../src/analysisRules";
import type { FamilyResolution } from "../../src/familyTypes";

export interface SpecimenInput {
  /** What the example is, in a sentence (printed above the result). */
  about?: string;
  /** The name on the record: the observer's identification. */
  recordName: string | null;
  /** For a nanopore (ONT) read, the number of reads in its consensus (RiC); null for a Sanger read. */
  readCount: number | null;
  /** Hits in MycoMap's own reference sequences (MycoBLAST), best first. */
  mycomapHits?: HitInput[];
  /** Hits in NCBI GenBank, best first. */
  ncbiHits?: HitInput[];
  /** The family of each genus the hits name ("Russula": "Russulaceae"). A genus left out has no family. */
  families?: Record<string, string>;
}

export interface HitInput {
  /** The name the reference sequence carries. */
  name: string;
  /** Plain percent identity to your sequence: identical bases / alignment length (NCBI's "Per. ident"). Default 100. */
  identity?: number;
  /**
   * Adjusted identity (README, example 6), when you have it: mycomap.org's BLAST
   * page shows it beside the plain identity. The rules use it when it is given.
   * A GenBank hit without it is judged on its plain identity; a MycoMap hit
   * without it is not counted, as on mycomap.org, which computes it for every
   * MycoMap hit.
   */
  adjustedIdentity?: number;
  /** Percent of your sequence the hit covers. Default 100. */
  coverage?: number;
  /** NCBI: the GenBank accession. */
  accession?: string;
  /** MycoMap: whether that reference sequence is itself DNA-validated. Default true. */
  validated?: boolean;
}

const QUERY_LEN = 600;

/**
 * Which identity the rules are given. "rule" is MycoMap's: adjusted identity
 * where a hit has it (a GenBank hit falls back to its plain identity). "plain"
 * is a what-if: every hit judged on its plain identity, as if nothing were
 * adjusted. Its results are not MycoMap's.
 */
export type IdentityMode = "rule" | "plain";

/** How many hits of each source the rules judge on adjusted and on plain identity, and how many they cannot count. */
export function identityUsed(input: SpecimenInput, mode: IdentityMode = "rule") {
  const count = (hits: HitInput[] = [], fallback: "plain" | "none") => {
    const adjusted = mode === "rule" ? hits.filter((h) => h.adjustedIdentity !== undefined).length : 0;
    const rest = hits.length - adjusted;
    return mode === "plain" ? { adjusted: 0, plain: hits.length, notCounted: 0 }
      : fallback === "plain" ? { adjusted, plain: rest, notCounted: 0 } : { adjusted, plain: 0, notCounted: rest };
  };
  return { mycomap: count(input.mycomapHits, "none"), ncbi: count(input.ncbiHits, "plain") };
}

function blastHit(num: number, accession: string, def: string, h: HitInput) {
  const identityPct = h.identity ?? 100;
  const coverage = h.coverage ?? 100;
  const alignLen = Math.max(1, Math.round((coverage / 100) * QUERY_LEN));
  // Not rounded to whole bases, so the plain identity the rules work out is exactly the one given.
  const identity = (identityPct / 100) * alignLen;
  return {
    num, def, accession, id: `gnl|${accession}`, len: QUERY_LEN, identity, alignLen, queryLen: QUERY_LEN, queryCoverage: coverage,
    hsps: [{ identity, alignLen, queryFrom: 1, queryTo: alignLen, hitFrom: 1, hitTo: alignLen, qseq: "", hseq: "", midline: "" }],
  };
}

function adjustedMap(hits: Array<{ num: number }>, given: HitInput[], mode: IdentityMode): Record<number, number> {
  return Object.fromEntries(hits.flatMap((h, i) => {
    const value = mode === "plain" ? given[i].identity ?? 100 : given[i].adjustedIdentity;
    return value === undefined ? [] : [[h.num, value]];
  }));
}

/** The sequence id the examples give the specimen. */
export const SPECIMEN_ID = "example-1";

/** Ports that answer the engine's questions from the input file alone. */
export function portsFromSpecimen(input: SpecimenInput, mode: IdentityMode = "rule"): AnalysisPorts {
  const mycomap = input.mycomapHits ?? [];
  const ncbi = input.ncbiHits ?? [];
  const localIds = mycomap.map((_, i) => String(1001 + i));
  const ncbiIds = ncbi.map((h, i) => h.accession ?? `ncbi-hit-${i + 1}`);
  const localHits = mycomap.map((h, i) => blastHit(i + 1, localIds[i], `${h.name} ONT-${localIds[i]}`, h));
  const ncbiHits = ncbi.map((h, i) => blastHit(i + 1, ncbiIds[i], `${h.name} voucher internal transcribed spacer 1, partial sequence`, h));
  const families = input.families ?? {};
  const familyOf = (name: string): string | null => families[name] ?? families[name.split(" ")[0]] ?? null;

  return {
    recordName: async () => null,
    blastEvidence: async () => ({
      failure: null,
      localResult: { queryLen: QUERY_LEN, hits: localHits },
      ncbiResult: { queryLen: QUERY_LEN, hits: ncbiHits },
      // A hit with no adjusted identity is left out of these maps: the rules then
      // judge a GenBank hit on its plain identity and do not count a MycoMap hit.
      // The plain what-if hands in each hit's plain identity as if it were adjusted.
      localAdjustedMap: adjustedMap(localHits, mycomap, mode),
      ncbiAdjustedMap: mode === "plain" ? {} : adjustedMap(ncbiHits, ncbi, mode),
      localIdentityAsked: localHits.length,
      ncbiIdentityAsked: ncbiHits.length,
      xmlSources: "example",
    } satisfies BlastEvidence),
    sequenceMetadata: async (accessions) => Object.fromEntries(accessions.flatMap((acc): Array<[string, SequenceRecord]> => {
      const i = localIds.indexOf(acc);
      if (i < 0) return [];
      const h = mycomap[i];
      const validated = h.validated ?? true;
      return [[acc, {
        id: acc, scientificName: h.name, validated, validationStatus: validated ? "verified" : "unverified", flags: [],
        species: { sequence: h.name, parent: `inat:${5000 + i}` }, observationId: String(70000 + i), categoryName: "ONT Sequences", ric: 40,
        title: `ONT-${acc} iNat${5000 + i}`, inatObservationId: 5000 + i,
      }]];
    })),
    observationSpecies: async (refs) => Object.fromEntries(refs.flatMap((ref) => {
      const i = Number(ref.id) - 5000;
      return mycomap[i] ? [[`inat:${ref.id}`, mycomap[i].name]] : [];
    })),
    genbankMetadata: async (accessions) => Object.fromEntries(accessions.flatMap((acc): Array<[string, GenBankRecord]> => {
      const i = ncbiIds.indexOf(acc);
      return i < 0 ? [] : [[acc, { accession: acc, scientificName: ncbi[i].name, organism: ncbi[i].name, isVerified: false, isType: false }]];
    })),
    sourceRank: async (name, provided) => provided ?? (name ? (name.trim().split(/\s+/).length >= 2 ? "species" : "genus") : null),
    family: async (name) => {
      const family = familyOf(name);
      return { requestedName: name, family, authority: family ? "inaturalist" : null, resolvedAt: 0, authorities: [], disagreements: [] } satisfies FamilyResolution;
    },
    saveInterimResult: async () => undefined,
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    edna: null,
  };
}
