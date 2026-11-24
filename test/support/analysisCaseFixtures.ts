// Analysis cases built by hand, for tests that replay the deterministic
// analysis or run the validation engine directly: a case is what one analysis
// was asked plus what each outside call answered (services/analysisCase.ts).
import type { AnalysisCaseCalls } from "../../src/analysisCase";
import type { AnalysisCaseArgs } from "../../src/caseReplay";

type CaseArgs = AnalysisCaseArgs;

// ---- building a case by hand ----

const QUERY_LEN = 600;

function hit(num: number, accession: string, def: string, identityPct = 100) {
  const identity = Math.round((identityPct / 100) * QUERY_LEN);
  return {
    num, def, accession, id: `gnl|${accession}`, len: QUERY_LEN, identity, alignLen: QUERY_LEN, queryLen: QUERY_LEN, queryCoverage: 100,
    hsps: [{ identity, alignLen: QUERY_LEN, queryFrom: 1, queryTo: QUERY_LEN, hitFrom: 1, hitTo: QUERY_LEN, qseq: "", hseq: "", midline: "" }],
  };
}

/** A validated MycoMap sequence on its own iNaturalist observation. */
function mycomapRecord(id: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    id: String(id), scientificName: name, validated: true, validationStatus: "verified", flags: [],
    species: { sequence: name, parent: `inat:${5000 + id}` }, observationId: String(70000 + id), categoryName: "ONT Sequences", ric: 40,
    title: `ONT-${id} iNat${5000 + id}`, inatObservationId: 5000 + id, ...extra,
  };
}

const family = (requestedName: string, name: string | null) => ({
  requestedName, family: name, authority: name ? "inaturalist" : null, resolvedAt: 0, authorities: [], disagreements: [],
});

const answers = (door: Record<string, unknown>) => Object.entries(door).map(([asked, answer]) => ({ asked, answer }));

export function buildCase(input: {
  sequenceId: string;
  source: { name: string | null; rank: string | null };
  local: Array<{ accession: string; name: string; identity?: number; record?: Record<string, unknown> }>;
  ncbi: Array<{ accession: string; name: string; identity?: number }>;
  families: Record<string, string | null>;
}): { args: CaseArgs; calls: AnalysisCaseCalls } {
  const localHits = input.local.map((h, i) => hit(i + 1, h.accession, `${h.name} ONT-${h.accession}`, h.identity));
  const ncbiHits = input.ncbi.map((h, i) => hit(i + 1, h.accession, `${h.name} voucher V${i} internal transcribed spacer 1, partial sequence`, h.identity));
  const adjusted = (hits: Array<{ num: number }>, source: Array<{ identity?: number }>) =>
    Object.fromEntries(hits.map((h, i) => [h.num, source[i].identity ?? 100]));
  const localAccessions = localHits.map((h) => h.accession);
  const ncbiAccessions = ncbiHits.map((h) => h.accession);
  const sequenceMetadata = Object.fromEntries(input.local.map((h) => [h.accession, mycomapRecord(Number(h.accession), h.name, h.record)]));
  const genbankMetadata = Object.fromEntries(input.ncbi.map((h) => [h.accession, {
    accession: h.accession, scientificName: h.name, organism: h.name, isVerified: false, isType: false,
  }]));
  const calls: AnalysisCaseCalls = {
    recordName: answers({ [JSON.stringify([input.source.name])]: null }),
    blastEvidence: answers({
      [JSON.stringify([input.sequenceId])]: {
        failure: null,
        localResult: { queryLen: QUERY_LEN, hits: localHits },
        ncbiResult: { queryLen: QUERY_LEN, hits: ncbiHits },
        localAdjustedMap: adjusted(localHits, input.local),
        ncbiAdjustedMap: adjusted(ncbiHits, input.ncbi),
        localIdentityAsked: localHits.length,
        ncbiIdentityAsked: ncbiHits.length,
        xmlSources: "local=case, ncbi=case",
      },
    }),
    sequenceMetadata: answers({ [JSON.stringify(localAccessions)]: sequenceMetadata }),
    // Asked only when a MycoBLAST hit sits on an observation.
    ...(input.local.length > 0 ? {
      observationSpecies: answers({
        [JSON.stringify(input.local.map((h) => ({ id: String(5000 + Number(h.accession)), source: "inat" })))]:
          Object.fromEntries(input.local.map((h) => [`inat:${5000 + Number(h.accession)}`, h.name])),
      }),
    } : {}),
    genbankMetadata: answers({ [JSON.stringify(ncbiAccessions)]: genbankMetadata }),
    sourceRank: answers({ [JSON.stringify([input.source.name, input.source.rank])]: input.source.rank }),
    family: Object.entries(input.families).flatMap(([name, fam]) => [
      { asked: JSON.stringify([name, "genus"]), answer: family(name, fam) },
      { asked: JSON.stringify([name, "species"]), answer: family(name, fam) },
      { asked: JSON.stringify([name, null]), answer: family(name, fam) },
    ]),
  };
  return {
    args: {
      sequenceId: input.sequenceId, hasNcbiXml: true, hasLocalXml: true,
      sourceSpeciesName: input.source.name, sourceRic: 40, sourceRank: input.source.rank, isOnlySequenceForRecord: true, envBlastReplication: null,
    },
    calls,
  };
}

export const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** A Russula emetica specimen: six validated MycoMap matches and eight NCBI records, all the same species at 100%. */
export const cleanSpecies = () => buildCase({
  sequenceId: "900001",
  source: { name: "Russula emetica", rank: "species" },
  local: range(6).map((i) => ({ accession: String(101 + i), name: "Russula emetica" })),
  ncbi: range(8).map((i) => ({ accession: `MK10000${i}`, name: "Russula emetica" })),
  families: { Russula: "Russulaceae", "Russula emetica": "Russulaceae" },
});

/** A Russula specimen whose sequence is a mould: every NCBI hit is Cladosporium cladosporioides. */
export const contaminant = () => buildCase({
  sequenceId: "900002",
  source: { name: "Russula emetica", rank: "species" },
  local: [],
  ncbi: range(6).map((i) => ({ accession: `MZ20000${i}`, name: "Cladosporium cladosporioides" })),
  families: { Russula: "Russulaceae", "Russula emetica": "Russulaceae", Cladosporium: "Cladosporiaceae" },
});
