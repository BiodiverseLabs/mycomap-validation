/**
 * The new-name rules of the validation engine (lib/validation-engine
 * newNameSuggestion.ts; 2026-11-16): which cluster makes a record a
 * candidate for a new provisional name, and which genus the name takes.
 *
 *   node --import tsx --test src/services/validationEngineNewNameSuggestion.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  barcodeGapFasta,
  barcodeGapQueryHeader,
  closestTaxonConsensus,
  hasLowQualityFlag,
  isUnnameableRead,
  isUnusableReference,
  nameBase,
  newNameVerdict,
  newNameVotePool,
  placeVoteHits,
  queryClusterAccessions,
  recordKeyOfSequence,
  recordReadsOutsideCluster,
  taxonWordsToPlace,
  existingSpeciesName,
  type NameVoteHit,
} from "../src/newNameSuggestion";
import type { TaxonLookup } from "../src/autovalidationTaxonomy";
import type { BlastHit, GenBankRecord, SequenceRecord } from "../src/analysisRules";

const hit = (num: number, accession: string, over: { def?: string; qseq?: string; hseq?: string; hitFrom?: number; hitTo?: number; cover?: number } = {}): BlastHit => ({
  num, def: over.def ?? accession, accession, id: accession, len: 600, identity: 590, alignLen: 600, queryLen: 600, queryCoverage: over.cover ?? 100,
  hsps: [{ identity: 590, alignLen: 600, queryFrom: 1, queryTo: 600, hitFrom: over.hitFrom ?? 1, hitTo: over.hitTo ?? 600, qseq: over.qseq ?? "ACGTACGT", hseq: over.hseq ?? "ACGTACGA", midline: "" }],
});

const seq = (id: string, over: Partial<SequenceRecord> & Record<string, unknown> = {}): SequenceRecord => ({
  id, scientificName: "Inocybe sindonia", validated: null, validationStatus: "not_assessed", flags: [], species: null,
  observationId: null, inatObservationId: null, moObservationId: null, platform: null, ...over,
});

// ── the barcode gap input ──

test("the barcode gap input is the query as its first hit aligned it, then every hit, gaps removed", () => {
  const input = barcodeGapFasta("893184", [
    hit(1, "893189", { qseq: "ACG-TAC", hseq: "ACGTT-C" }),
    hit(2, "387751", { qseq: "ACGTAC", hseq: "AC--AC" }),
  ]);
  assert.ok(input);
  assert.equal(input.queryHeader, "Query_893184");
  assert.equal(input.sequences, 3);
  assert.deepEqual(input.fasta.split("\n"), [">Query_893184 | Query sequence", "ACGTAC", ">893189 | hit #1", "ACGTTC", ">387751 | hit #2", "ACAC"]);
  assert.equal(barcodeGapQueryHeader("12"), "Query_12");
  // The BLAST page's tab names the query "Query_" + the BLAST result's own query id; with none, "Query_sequence".
  assert.equal(barcodeGapQueryHeader("Query_1"), "Query_Query_1");
  assert.equal(barcodeGapQueryHeader(null), "Query_sequence");
  assert.equal(barcodeGapQueryHeader("  "), "Query_sequence");
  assert.equal(barcodeGapFasta(null, [hit(1, "77")])!.queryHeader, "Query_sequence");
});

test("a hit on the other strand is turned to the query's strand", () => {
  const input = barcodeGapFasta("1", [hit(1, "77", { hseq: "AAC-GT", hitFrom: 600, hitTo: 1 })]);
  assert.deepEqual(input!.fasta.split("\n").slice(2), [">77 [RC] | hit #1", "ACGTT"]);
});

test("with no alignment to compare there is no barcode gap input", () => {
  assert.equal(barcodeGapFasta("1", []), null);
  assert.equal(barcodeGapFasta("1", [hit(1, "77", { qseq: "", hseq: "" })]), null);
  const long = barcodeGapFasta("1", [hit(1, "77", { qseq: "A".repeat(170), hseq: "C".repeat(90) })])!;
  assert.deepEqual(long.fasta.split("\n").map((line) => line.length), [">Query_1 | Query sequence".length, 80, 80, 10, ">77 | hit #1".length, 80, 10], "sequences are wrapped at 80");
});

// ── the query's cluster ──

test("the query's cluster is read whole (not the 20 shown), without the query itself", () => {
  const gap = {
    query_cluster_index: 1,
    clusters: [
      { sequence_ids: ["1", "2"], all_sequence_ids: ["1", "2", "3"] },
      { sequence_ids: ["Query_Query_1", "893184"], all_sequence_ids: ["Query_Query_1", "893184", "893189", "893187", "893189"] },
    ],
  };
  assert.deepEqual(queryClusterAccessions(gap), ["893184", "893189", "893187"]);
  assert.deepEqual(queryClusterAccessions({ query_cluster_index: 0, clusters: [{ sequence_ids: ["Query_9", "5"] }] }), ["5"], "an answer with only the short list still counts");
});

test("an answer that does not place the query gives no cluster", () => {
  assert.equal(queryClusterAccessions(null), null);
  assert.equal(queryClusterAccessions({ clusters: [], query_cluster_index: 0 }), null);
  assert.equal(queryClusterAccessions({ clusters: [{ all_sequence_ids: ["1"] }], query_cluster_index: null }), null);
  assert.equal(queryClusterAccessions({ clusters: [{ all_sequence_ids: ["1"] }], query_cluster_index: 3 }), null);
  assert.equal(queryClusterAccessions({ clusters: [{}], query_cluster_index: 0 }), null);
});

// ── the cluster rule ──

test("a sequence's record is its iNaturalist or MO observation, else its own record number", () => {
  assert.equal(recordKeyOfSequence(seq("1", { inatObservationId: 373500727, observationId: "1994911" })), "inat:373500727");
  assert.equal(recordKeyOfSequence(seq("1", { moObservationId: "55" })), "mo:55");
  assert.equal(recordKeyOfSequence(seq("1", { observationId: "4903394", platform: "MyCoPortal" })), "mycoportal:4903394");
  assert.equal(recordKeyOfSequence(seq("1")), null);
  assert.equal(recordKeyOfSequence(null), null);
});

test("A real example (seq 893184): the cluster is the record's own three reads, so it is a candidate for a new name", () => {
  const sequenceMap = {
    "893184": seq("893184", { inatObservationId: "373500727" }),
    "893189": seq("893189", { inatObservationId: "373500727" }),
    "893187": seq("893187", { inatObservationId: "373500727" }),
  };
  const verdict = newNameVerdict({ sequenceId: "893184", ownRecord: "inat:373500727", clusterAccessions: ["893184", "893189", "893187"], sequenceMap });
  assert.equal(verdict.candidate, true);
  assert.equal(verdict.reason, "no_validated_record_in_cluster");
  assert.deepEqual(verdict.ownSequenceIds, ["893184", "893189", "893187"]);
  assert.deepEqual(verdict.validated, []);
  assert.deepEqual(verdict.sharedWith, []);
});

test("a record validated green in the cluster means no new name, and says which record", () => {
  const verdict = newNameVerdict({
    sequenceId: "10", ownRecord: "inat:1", clusterAccessions: ["20", "21"],
    sequenceMap: {
      "20": seq("20", { inatObservationId: "2", validated: true, validationStatus: "verified", scientificName: "Inocybe sp. 'IN04'" }),
      "21": seq("21", { inatObservationId: "2" }),
    },
  });
  assert.equal(verdict.candidate, false);
  assert.equal(verdict.reason, "validated_record_in_cluster");
  assert.deepEqual(verdict.validated, [{ record: "inat:2", sequenceIds: ["20", "21"], name: "Inocybe sp. 'IN04'" }], "the record's other read goes with it");
  assert.deepEqual(verdict.sharedWith, []);
});

test("other records that are not validated do not block it: they are candidates for the same name", () => {
  const verdict = newNameVerdict({
    sequenceId: "10", ownRecord: "inat:1", clusterAccessions: ["11", "30", "31", "40"],
    sequenceMap: {
      "11": seq("11", { inatObservationId: "1" }),
      "30": seq("30", { inatObservationId: "3", validationStatus: "not_assessed" }),
      "31": seq("31", { inatObservationId: "3", validationStatus: "rejected", validated: false }),
      "40": seq("40", { moObservationId: "9" }),
    },
  });
  assert.equal(verdict.candidate, true);
  assert.deepEqual(verdict.ownSequenceIds, ["10", "11"]);
  assert.deepEqual(verdict.sharedWith.map((r) => [r.record, r.sequenceIds]), [["inat:3", ["30", "31"]], ["mo:9", ["40"]]]);
});

test("a trashed or flagged reference neither blocks nor shares, even when it is validated", () => {
  const verdict = newNameVerdict({
    sequenceId: "10", ownRecord: "inat:1", clusterAccessions: ["50", "51"],
    sequenceMap: {
      "50": seq("50", { inatObservationId: "5", validated: true, validationStatus: "verified", flags: ["contaminant"] }),
      "51": seq("51", { inatObservationId: "6", validated: true, validationStatus: "verified", categoryName: "Trash" }),
    },
  });
  assert.equal(verdict.candidate, true);
  assert.deepEqual(verdict.validated, []);
  assert.deepEqual(verdict.sharedWith, []);
});

test("a record whose read carries the Low quality flag still shares the cluster and may take the name; validated, it neither blocks nor shares", () => {
  // 2026-11-16, sequence 892664: the Indiana records' reads are flagged Low quality and sit in its cluster.
  const verdict = newNameVerdict({
    sequenceId: "892664", ownRecord: "inat:378649754", clusterAccessions: ["542662", "839610", "543574", "600", "601", "602", "603"],
    sequenceMap: {
      "542662": seq("542662", { inatObservationId: "301539572", scientificName: "Cantharellus", flags: ["low"] }),
      "839610": seq("839610", { inatObservationId: "394177587", scientificName: "Cantharellus" }),
      "543574": seq("543574", { inatObservationId: "301539524", scientificName: "Cantharellus", flags: ['{"low":1,"contaminant":0}'] }),
      // Validated with a Low quality read: no evidence for a validated name, and not a record to rename.
      "600": seq("600", { inatObservationId: "6", validated: true, validationStatus: "verified", flags: ["low"] }),
      // Low quality and also a contaminant, on the wrong specimen, or trashed: no record is named through it.
      "601": seq("601", { inatObservationId: "7", flags: ["low", "contaminant"] }),
      "602": seq("602", { inatObservationId: "8", flags: ["low", "wrong"] }),
      "603": seq("603", { inatObservationId: "9", flags: ["low"], categoryName: "Trash" }),
    },
  });
  assert.equal(verdict.candidate, true);
  assert.deepEqual(verdict.validated, []);
  assert.deepEqual(verdict.sharedWith, [
    { record: "inat:301539572", sequenceIds: ["542662"], name: "Cantharellus" },
    { record: "inat:394177587", sequenceIds: ["839610"], name: "Cantharellus" },
    { record: "inat:301539524", sequenceIds: ["543574"], name: "Cantharellus" },
  ]);

  // A record with one good validated read is validated, and its Low quality read goes with it.
  const withValidated = newNameVerdict({
    sequenceId: "10", ownRecord: "inat:1", clusterAccessions: ["50", "51"],
    sequenceMap: {
      "50": seq("50", { inatObservationId: "5", flags: ["low"] }),
      "51": seq("51", { inatObservationId: "5", validated: true, validationStatus: "verified", scientificName: "Inocybe sindonia" }),
    },
  });
  assert.equal(withValidated.candidate, false);
  assert.deepEqual(withValidated.validated.map((r) => [r.record, r.sequenceIds.sort()]), [["inat:5", ["50", "51"]]]);
  assert.deepEqual(withValidated.sharedWith, []);
});

test("the Low quality flag is read however it is written; it alone does not make a read unnameable, but it is still no reference for a name", () => {
  for (const flags of [["low"], ["L"], ["Low Quality"], ["low ric"], ['{"low":1}']]) {
    assert.equal(hasLowQualityFlag(seq("1", { flags })), true, JSON.stringify(flags));
    assert.equal(isUnnameableRead(seq("1", { flags })), false, JSON.stringify(flags));
    assert.equal(isUnusableReference(seq("1", { flags })), true, "it still does not vote on a genus or stand as a reference");
  }
  assert.equal(hasLowQualityFlag(seq("1", { flags: [], field_sequence_flags: { low: 1 } })), true);
  for (const flags of [[], ["contaminant"], ['{"low":0}'], ["wrong"]]) assert.equal(hasLowQualityFlag(seq("1", { flags })), false, JSON.stringify(flags));
  assert.equal(isUnnameableRead(seq("1", { flags: ["contaminant"] })), true);
  assert.equal(isUnnameableRead(seq("1", { flags: ["wrong"] })), true);
  assert.equal(isUnnameableRead(seq("1", { flags: [], field_sequence_flags: { wrong: 1 } })), true);
  assert.equal(isUnnameableRead(seq("1", { categoryName: "Trash" })), true);
  assert.equal(isUnnameableRead(seq("1")), false);
});

test("cluster members MycoMap holds no sequence for are counted, and never block", () => {
  const verdict = newNameVerdict({ sequenceId: "10", ownRecord: null, clusterAccessions: ["df-47-72-10562", "60"], sequenceMap: { "60": seq("60") } });
  assert.equal(verdict.candidate, true);
  assert.deepEqual(verdict.unknownAccessions, ["df-47-72-10562"]);
  assert.deepEqual(verdict.sharedWith, [{ record: null, sequenceIds: ["60"], name: "Inocybe sindonia" }], "a sequence with no record stands for itself");
  assert.deepEqual(verdict.ownSequenceIds, ["10"], "with no record of its own, only the sequence itself is its own");
});

// ── the name's base: genus, else family, else order (2026-11-18) ──

const named = (id: string, name: string, over: Partial<SequenceRecord> & Record<string, unknown> = {}) => seq(id, { scientificName: name, inatObservationId: `9${id}`, ...over });
const genbank = (accession: string, organism: string): GenBankRecord => ({ accession, scientificName: organism, organism, isVerified: false, isType: false });
const place = (rows: Record<string, [family: string | null, order: string | null]>): TaxonLookup =>
  new Map(Object.entries(rows).map(([word, [family, order]]) => [word.toLowerCase(), { kingdom: "Fungi", family, order }]));
const AGARICS = place({
  Inocybe: ["Inocybaceae", "Agaricales"], Inosperma: ["Inocybaceae", "Agaricales"], Pseudosperma: ["Inocybaceae", "Agaricales"],
  Russula: ["Russulaceae", "Russulales"], Inocybaceae: [null, "Agaricales"],
});

function genus(over: Partial<Parameters<typeof closestTaxonConsensus>[0]> = {}) {
  return closestTaxonConsensus({
    localHits: [], ncbiHits: [], localAdjusted: {}, ncbiAdjusted: {}, sequenceMap: {}, genbankMap: {}, ownSequenceIds: ["10"], ownRecord: "inat:1", lookup: AGARICS, ...over,
  });
}

test("a genus that holds more than half the identity-weighted vote of the closest hits is the name's base", () => {
  const result = genus({
    localHits: [hit(1, "101"), hit(2, "102")],
    localAdjusted: { 1: 97.2, 2: 96.1 },
    sequenceMap: { "101": named("101", "Inocybe sindonia"), "102": named("102", "Inosperma calamistratum") },
    ncbiHits: [hit(1, "MK1"), hit(2, "MK2"), hit(3, "MK3")],
    ncbiAdjusted: { 1: 98.4, 2: 96.5, 3: 80 },
    genbankMap: { MK1: genbank("MK1", "Inocybe geophylla"), MK2: genbank("MK2", "Inocybe sp. 'IN03'"), MK3: genbank("MK3", "Russula sp.") },
  });
  assert.equal(result.genus, "Inocybe");
  assert.equal(result.rank, "genus");
  assert.equal(result.reason, "consensus");
  assert.deepEqual(result.considered.map((h) => `${h.source}:${h.accession}:${h.identity}`), ["ncbi:MK1:98.4", "local:101:97.2", "ncbi:MK2:96.5", "local:102:96.1", "ncbi:MK3:80"], "closest first, whichever list");
  assert.deepEqual(result.votes.map((v) => [v.genus, v.count, v.share]), [["Inocybe", 3, 0.624], ["Inosperma", 1, 0.205], ["Russula", 1, 0.171]], "Inocybe holds 292.1 of 468.2");
});

test("when no genus holds more than half, the family does; when no family does, the order", () => {
  // Inocybe 3 of 7 hits (45% of the weight); Inocybaceae 5 of 7.
  const family = genus({
    localHits: [hit(1, "101"), hit(2, "102"), hit(3, "103")],
    localAdjusted: { 1: 97.2, 2: 96.1, 3: 90 },
    sequenceMap: { "101": named("101", "Inocybe sindonia"), "102": named("102", "Inosperma calamistratum"), "103": named("103", "Russula emetica") },
    ncbiHits: [hit(1, "MK1"), hit(2, "MK2"), hit(3, "MK3"), hit(4, "MK4")],
    ncbiAdjusted: { 1: 98.4, 2: 96.5, 3: 95, 4: 80 },
    genbankMap: { MK1: genbank("MK1", "Inocybe geophylla"), MK2: genbank("MK2", "Inocybe sp. 'IN03'"), MK3: genbank("MK3", "Pseudosperma rimosum"), MK4: genbank("MK4", "Russula sp.") },
  });
  assert.equal(family.genus, "Inocybaceae");
  assert.equal(family.rank, "family");
  assert.deepEqual(family.tallies.map((t) => [t.rank, t.taxa[0].taxon, t.taxa[0].share]), [["genus", "Inocybe", 0.447], ["family", "Inocybaceae", 0.74], ["order", "Agaricales", 0.74]]);

  const order = genus({
    localHits: [hit(1, "201"), hit(2, "202"), hit(3, "203")],
    localAdjusted: { 1: 95, 2: 94, 3: 93 },
    sequenceMap: { "201": named("201", "Inocybe a"), "202": named("202", "Agaricales sp. 'IN01'"), "203": named("203", "Russula b") },
    lookup: place({ Inocybe: ["Inocybaceae", "Agaricales"], Russula: ["Russulaceae", "Russulales"] }),
  });
  assert.equal(order.genus, "Agaricales");
  assert.equal(order.rank, "order");
});

test("a taxon needs two hits, and a hit placed nowhere at a rank still counts in that rank's whole", () => {
  // One hit holds all of the genus weight it can: no name from one record.
  const one = genus({ localHits: [hit(1, "301"), hit(2, "302")], localAdjusted: { 1: 99, 2: 50 }, sequenceMap: { "301": named("301", "Inocybe a"), "302": named("302", "Helotiales sp. 'CA04'") } });
  assert.equal(one.genus, null);
  assert.equal(one.reason, "no_majority");
  // Two Inocybe and two hits whose genus has no family in the lookup: Inocybaceae holds half, not more.
  const unplaced = genus({
    localHits: [hit(1, "401"), hit(2, "402"), hit(3, "403"), hit(4, "404")],
    localAdjusted: { 1: 95, 2: 95, 3: 95, 4: 95 },
    sequenceMap: { "401": named("401", "Inocybe a"), "402": named("402", "Inocybe b"), "403": named("403", "Unplacedia c"), "404": named("404", "Unplacedia d") },
  });
  assert.equal(unplaced.genus, null, "Inocybe 50%, Unplacedia 50%: neither is more than half; Inocybaceae 50% and Agaricales 50% likewise");
  assert.deepEqual(unplaced.votes, [{ genus: "Agaricales", count: 2, share: 0.5 }], "the order tally is shown when no rank agrees");
});

test("names say how far they go: a family or order name votes at its own rank and above, never at genus", () => {
  assert.deepEqual(nameBase("Mollisia sp."), { word: "Mollisia", rank: "genus" });
  assert.deepEqual(nameBase("Patellariopsis atrovinosa"), { word: "Patellariopsis", rank: "genus" });
  assert.deepEqual(nameBase("Alnicola escharoides"), { word: "Naucoria", rank: "genus" }, "the canonical genus");
  assert.deepEqual(nameBase("Mollisiaceae"), { word: "Mollisiaceae", rank: "family" });
  assert.deepEqual(nameBase("Helotiales"), { word: "Helotiales", rank: "order" });
  assert.deepEqual(nameBase("Helotiales sp. 'CA04'"), { word: "Helotiales", rank: "order" });
  for (const none of ["Fungi", "Ascomycota", "Agaricomycetes", "Pezizomycotina sp.", "Uncultured Ascomycota", "uncultured Helotiaceae", "Vouchered mycorrhizae (Basidiomycota)", "", null]) {
    assert.equal(nameBase(none), null, String(none));
  }
});

test("each list gives its 10 closest usable hits, and a MycoBLAST record votes once", () => {
  const local = Array.from({ length: 14 }, (_, i) => hit(i + 1, String(500 + i)));
  const ncbi = Array.from({ length: 14 }, (_, i) => hit(i + 1, `N${i}`));
  const sequenceMap = Object.fromEntries(local.map((h, i) => [h.accession, named(h.accession, "Inocybe a", { inatObservationId: i < 3 ? "777" : `8${i}` })]));
  const result = genus({
    localHits: local, localAdjusted: Object.fromEntries(local.map((h, i) => [h.num, 99 - i])), sequenceMap,
    ncbiHits: ncbi, ncbiAdjusted: Object.fromEntries(ncbi.map((h, i) => [h.num, 98.5 - i])),
    genbankMap: Object.fromEntries(ncbi.map((h) => [h.accession, genbank(h.accession, "Inocybe b")])),
  });
  const fromLocal = result.considered.filter((h) => h.source === "local").map((h) => h.accession);
  assert.deepEqual(fromLocal, ["500", "503", "504", "505", "506", "507", "508", "509", "510", "511"], "501 and 502 are the same record as 500");
  assert.equal(result.considered.filter((h) => h.source === "ncbi").length, 10);
});

test("uncultured names, names above order, the record's own reads and flagged or trashed references do not vote", () => {
  const result = genus({
    localHits: [hit(1, "10"), hit(2, "11"), hit(3, "201"), hit(4, "202"), hit(5, "203"), hit(6, "204"), hit(7, "205"), hit(8, "206")],
    localAdjusted: { 1: 100, 2: 99.9, 3: 99, 4: 98.9, 5: 98, 6: 97, 7: 96.5, 8: 96.4 },
    sequenceMap: {
      "10": named("10", "Russula emetica", { inatObservationId: "1" }),
      "11": named("11", "Russula emetica", { inatObservationId: "1" }),
      "201": named("201", "Russula emetica", { flags: ["contaminant"] }),
      "202": named("202", "Russula emetica", { categoryName: "Trash" }),
      "203": named("203", "Inocybe sindonia"),
      "204": named("204", "Inocybe geophylla"),
      "205": named("205", "Fungi"),
      "206": named("206", "Agaricomycetes"),
    },
    ncbiHits: [hit(1, "U1"), hit(2, "F1")],
    ncbiAdjusted: { 1: 99.5, 2: 99.4 },
    genbankMap: { U1: genbank("U1", "uncultured Russula"), F1: genbank("F1", "Fungi") },
  });
  assert.deepEqual(result.considered.map((h) => h.accession), ["203", "204"]);
  assert.equal(result.genus, "Inocybe");
});

test("one named hit is too few to choose a base", () => {
  const result = genus({ localHits: [hit(1, "401")], localAdjusted: { 1: 97 }, sequenceMap: { "401": named("401", "Inocybe a") } });
  assert.equal(result.genus, null);
  assert.equal(result.reason, "too_few_named_hits");
  assert.equal(genus().reason, "too_few_named_hits");
});

test("a hit with no adjusted identity does not vote", () => {
  const result = genus({
    localHits: [hit(1, "501"), hit(2, "502")],
    localAdjusted: { 1: 96 },
    sequenceMap: { "501": named("501", "Inocybe a"), "502": named("502", "Russula b") },
    ncbiHits: [hit(1, "N1")],
    ncbiAdjusted: { 1: 96 },
    genbankMap: { N1: genbank("N1", "Inocybe c") },
  });
  assert.deepEqual(result.considered.map((h) => h.accession), ["501", "N1"], "equal identity keeps MycoBLAST first");
  assert.equal(result.genus, "Inocybe");
});

test("the record's own reads never vote, even when MycoMap returns no record for them", () => {
  const result = genus({
    ownSequenceIds: ["10", "11"],
    localHits: [hit(1, "10", { def: "Russula emetica" }), hit(2, "11", { def: "Russula emetica" }), hit(3, "601"), hit(4, "602")],
    localAdjusted: { 1: 100, 2: 100, 3: 96, 4: 95 },
    sequenceMap: { "601": named("601", "Inocybe a"), "602": named("602", "Inocybe b") },
  });
  assert.deepEqual(result.considered.map((h) => h.accession), ["601", "602"]);
  assert.equal(result.genus, "Inocybe");
});

test("only the genera and families are looked up; an order name places itself", () => {
  const pool = newNameVotePool({
    localHits: [hit(1, "701"), hit(2, "702"), hit(3, "703")], localAdjusted: { 1: 95, 2: 94, 3: 93 },
    sequenceMap: { "701": named("701", "Mollisia sp. 'CA14'"), "702": named("702", "Mollisiaceae"), "703": named("703", "Helotiales") },
    ncbiHits: [], ncbiAdjusted: {}, genbankMap: {}, ownSequenceIds: [], ownRecord: null,
  });
  assert.deepEqual(taxonWordsToPlace(pool), ["Mollisia", "Mollisiaceae"]);
  const placed = placeVoteHits(pool, place({ Mollisia: ["Mollisiaceae", "Helotiales"], Mollisiaceae: [null, "Helotiales"] }));
  assert.deepEqual(placed.map((h) => [h.genus, h.family, h.order]), [["Mollisia", "Mollisiaceae", "Helotiales"], [null, "Mollisiaceae", "Helotiales"], [null, null, "Helotiales"]]);
});

// 2026-11-18: sequence 782936 (inat:378278818) was suggested
// "Mollisia sp. 'BC06'" from the 5 closest hits (Mollisia 3, Orbilia 1, Patellariopsis 1). The hits
// below are the page's, read that day: MycoBLAST in adjusted identity order with its flags (contaminant,
// wrong specimen, flagged), NCBI with the adjusted identities the saved suggestion kept for the closest
// four and the raw ones shown on the page for the rest. Taxonomy as iNaturalist and NCBI place them:
// Mollisia in Mollisiaceae, Patellariopsis and Rhexocercosporidium in Helotiales with no family.
test("sequence 782936: the 10 closest usable hits of each list agree on the order Helotiales, not on a genus or family", () => {
  const localRows: Array<[string, string, number, number, string?]> = [
    ["782936", "Ascomycota", 100, 100],
    ["552627", "Mollisiaceae", 94.22, 98], ["549410", "Orbilia sp. 'PA02'", 93.87, 98], ["483213", "Fungi", 92.22, 81, "low_quality"],
    ["594514", "Pseudohydnum", 91.97, 81, "contaminant"], ["476420", "Leptodontidium camptobactrum", 91.67, 81, "contaminant"],
    ["66397", "Leptodontidium camptobactrum", 91.67, 81, "contaminant"], ["16681", "Agaricomycetes", 91.67, 81, "contaminant"],
    ["772190", "Helotiales", 91.52, 81], ["394709", "Steccherinum ochraceum", 91.52, 81, "contaminant"],
    ["557322", "Nectria dematiosa", 91.47, 81], ["749982", "Polyporales", 91.45, 81, "contaminant"], ["484310", "Lyomyces crustosus", 91.45, 81],
    ["698836", "Pycnonotus sinensis formosae", 91.3, 81, "wrong"], ["402844", "Ascomycota", 91.3, 81], ["171353", "Helotiales sp. 'CA04'", 91.3, 81],
    ["73431", "Helotiales sp. 'CA04'", 91.3, 81], ["72088", "Helotiales", 91.3, 81], ["343800", "Heterosphaeria patella", 91.01, 81],
    ["614069", "Ascocoryne sarcoides", 90.91, 81, "contaminant"], ["551796", "Arachnopeziza", 90.79, 81], ["516225", "Chlorociboria aeruginosa", 90.65, 81],
  ];
  const ncbiRows: Array<[string, string, number, number]> = [
    ["AY969930", "uncultured Ascomycota", 96, 91], ["MG195548", "Mollisia sp.", 95.46, 100], ["MG195546", "Mollisia sp.", 94.8, 98],
    ["MG195547", "Mollisia sp.", 94.75, 100], ["MN535817", "Patellariopsis atrovinosa", 93.72, 73], ["OL604443", "Patellariopsis atrovinosa", 90.7, 81],
    ["OL604442", "Patellariopsis atrovinosa", 90.7, 81], ["KY970066", "Patellariopsis atrovinosa", 90.7, 81], ["KY462814", "Patellariopsis atrovinosa", 90.7, 81],
    ["MN124207", "Rhexocercosporidium sp.", 89.43, 81], ["MN124206", "Rhexocercosporidium sp.", 89.43, 81], ["MN124204", "Rhexocercosporidium sp.", 89.43, 81],
    ["MG707582", "uncultured Ascomycota", 89.43, 81], ["MG195564", "Mollisia sp.", 89.43, 81],
  ];
  const localHits = localRows.map(([accession, , , cover], i) => hit(i + 1, accession, { cover }));
  const ncbiHits = ncbiRows.map(([accession, , , cover], i) => hit(i + 1, accession, { cover }));
  const sequenceMap = Object.fromEntries(localRows.map(([accession, name, , , flag], i) => [accession, named(accession, name, {
    inatObservationId: accession === "782936" ? "378278818" : `5${i}`,
    ...(flag === "contaminant" ? { flags: ["contaminant"] } : flag === "wrong" ? { flags: ["wrong"] } : flag === "low_quality" ? { flags: ["low_quality"] } : {}),
  })]));
  const lookup = place({
    Mollisia: ["Mollisiaceae", "Helotiales"], Mollisiaceae: [null, "Helotiales"], Patellariopsis: [null, "Helotiales"], Rhexocercosporidium: [null, "Helotiales"],
    Orbilia: ["Orbiliaceae", "Orbiliales"], Nectria: ["Nectriaceae", "Hypocreales"], Lyomyces: ["Corticiaceae", "Corticiales"],
    Heterosphaeria: ["Heterosphaeriaceae", "Helotiales"], Arachnopeziza: ["Arachnopezizaceae", "Helotiales"], Chlorociboria: ["Chlorociboriaceae", "Helotiales"],
  });
  const input = {
    localHits, ncbiHits, sequenceMap, lookup,
    localAdjusted: Object.fromEntries(localRows.map(([, , identity], i) => [i + 1, identity])),
    ncbiAdjusted: Object.fromEntries(ncbiRows.map(([, , identity], i) => [i + 1, identity])),
    genbankMap: Object.fromEntries(ncbiRows.map(([accession, name]) => [accession, genbank(accession, name)])),
    ownSequenceIds: ["782936"], ownRecord: "inat:378278818",
  };
  const result = closestTaxonConsensus(input);

  assert.deepEqual(result.considered.filter((h) => h.source === "local").map((h) => h.accession),
    ["552627", "549410", "772190", "557322", "484310", "171353", "73431", "72088", "343800", "551796"],
    "no flagged read, no read naming only a class or phylum (Ascomycota, Fungi)");
  assert.deepEqual(result.considered.filter((h) => h.source === "ncbi").map((h) => h.accession),
    ["MG195548", "MG195546", "MG195547", "MN535817", "OL604443", "OL604442", "KY970066", "KY462814", "MN124207", "MN124206"],
    "no uncultured record");
  assert.equal(result.reason, "consensus");
  assert.equal(result.rank, "order");
  assert.equal(result.genus, "Helotiales");
  const leader = (rank: string) => result.tallies.find((t) => t.rank === rank)!.taxa[0];
  assert.deepEqual([leader("genus").taxon, leader("family").taxon], ["Patellariopsis", "Mollisiaceae"]);
  assert.ok(leader("genus").share < 0.5 && leader("family").share < 0.5);
  assert.ok(leader("order").share > 0.75, `Helotiales holds ${leader("order").share}`);
  assert.ok(!result.tallies.some((t) => t.taxa.some((x) => x.taxon === "Dermateaceae")), "no source places these genera in Dermateaceae");
});

// ── guards (sequence 892545, 2026-11-16) ──

test("a hit votes only when it covers most of the read: a short match on a conserved stretch names nothing", () => {
  // 892545: every named match covered about a fifth of the read (Pseudopirsonia at 95% over 167 bp, other records' stray reads).
  const result = genus({
    localHits: [hit(1, "701", { cover: 20 }), hit(2, "702", { cover: 34 }), hit(3, "703", { cover: 69.9 })],
    localAdjusted: { 1: 95.9, 2: 95.6, 3: 94.6 },
    sequenceMap: { "701": named("701", "Tremella mesenterica"), "702": named("702", "Cantharellus chicagoensis"), "703": named("703", "Neofavolus americanus") },
    ncbiHits: [hit(1, "PQ590051", { cover: 27 })],
    ncbiAdjusted: { 1: 94.6 },
    genbankMap: { PQ590051: genbank("PQ590051", "Pseudopirsonia sp.") },
  });
  assert.deepEqual(result.considered, []);
  assert.equal(result.genus, null);
  assert.equal(result.reason, "too_few_named_hits");

  const covered = genus({
    localHits: [hit(1, "701", { cover: 20 }), hit(2, "704", { cover: 70 }), hit(3, "705", { cover: 92 })],
    localAdjusted: { 1: 99, 2: 90, 3: 88 },
    sequenceMap: { "701": named("701", "Tremella mesenterica"), "704": named("704", "Inocybe a"), "705": named("705", "Inocybe b") },
  });
  assert.deepEqual(covered.considered.map((h) => h.accession), ["704", "705"], "the analysis's own rule: 70% of the read or more");
  assert.equal(covered.genus, "Inocybe");
});

test("a read speaks for its record only when the record's other usable reads cluster with it", () => {
  const reads = (ids: string[], unusable: string[] = []) => ids.map((id) => ({ id, usable: !unusable.includes(id) }));
  assert.deepEqual(recordReadsOutsideCluster({ sequenceId: "893184", clusterOwnSequenceIds: ["893184", "893189", "893187"], recordReads: reads(["893184", "893189", "893187"]) }), []);
  assert.deepEqual(recordReadsOutsideCluster({ sequenceId: "892545", clusterOwnSequenceIds: ["892545"], recordReads: reads(["892535", "892536", "892545", "892547"], ["892547"]) }), ["892535", "892536"], "the flagged read is not counted");
  assert.deepEqual(recordReadsOutsideCluster({ sequenceId: "1", clusterOwnSequenceIds: [], recordReads: reads(["1"]) }), [], "a record with one read");
  assert.deepEqual(recordReadsOutsideCluster({ sequenceId: "1", clusterOwnSequenceIds: ["1"], recordReads: reads(["2", "2", "1"]) }), ["2"]);
  assert.deepEqual(recordReadsOutsideCluster({ sequenceId: "1", clusterOwnSequenceIds: ["1"], recordReads: [] }), []);
});

// ── GenBank's stand-in names (2026-11-16, sequence 881628: "Vouchered is not a genus. It is a GenBank status like uncultured") ──

import { isPlaceholderGenusWord, isPlaceholderOrganismName } from "../src/speciesNames";

test("GenBank's stand-in organism names are no taxon, whatever their first word looks like", () => {
  for (const name of [
    "Vouchered mycorrhizae", "Vouchered mycorrhizae (Basidiomycota)", "vouchered mycorrhizae (Ascomycota)",
    "Ectomycorrhizal fungus", "Mycorrhizal fungal sp.", "Endophytic fungus", "Soil fungus", "Lichenized fungus",
    "Root associated fungus", "Unidentified fungus", "Fungal sp.", "Fungal endophyte sp.", "Uncultured ectomycorrhiza",
    "Collembola environmental sample", "Russula environmental samples", "Orchid mycorrhizal sp.", "Ericoid mycorrhizal sp.",
    // A first word that could pass for a genus, a stand-in word after it.
    "Dark septate endophyte", "Helotiaceous fungus", "Pezizomycete symbiont", "Leotiomycete fungi",
  ]) assert.equal(isPlaceholderOrganismName(name), true, name);
  for (const name of ["Russula emetica", "Inocybe sp. 'IN05'", "Pandora neoaphidis", "Tomocerus jesonicus", "Fungi", "Cortinarius sect. Verni", "Entoloma strictius", "", null, undefined]) {
    assert.equal(isPlaceholderOrganismName(name), false, String(name));
  }
  assert.equal(isPlaceholderGenusWord("Vouchered"), true);
  assert.equal(isPlaceholderGenusWord(" vouchered "), true);
  assert.equal(isPlaceholderGenusWord("Ectomycorrhizal"), true);
  assert.equal(isPlaceholderGenusWord("Russula"), false);
  assert.equal(isPlaceholderGenusWord(null), false);
});

test("sequence 881628: the five closest hits are all 'Vouchered mycorrhizae'; they name no genus, and the named hits further down do", () => {
  const vouchered = (num: number, accession: string, identity: number) => ({ hit: hit(num, accession, { def: "Vouchered mycorrhizae (Basidiomycota) isolate x 18S ribosomal RNA gene" }), identity, name: "Vouchered mycorrhizae (Basidiomycota)" });
  const named = (num: number, accession: string, identity: number, name: string) => ({ hit: hit(num, accession), identity, name });
  const rows = [
    vouchered(1, "AB370317", 94.68), vouchered(2, "AB370316", 94.68), vouchered(3, "AB370315", 94.66), vouchered(4, "AB370314", 94.66), vouchered(5, "AB370326", 94.49),
    named(6, "N1", 93.1, "Sebacina incrustans"), named(7, "N2", 93.0, "Sebacina epigaea"), named(8, "N3", 92.8, "Sebacina dimitica"),
    named(9, "N4", 92.0, "Serendipita vermifera"), named(10, "N5", 91.5, "Ectomycorrhizal fungus"),
  ];
  const genbankMap = Object.fromEntries(rows.map((r) => [r.hit.accession, { scientificName: r.name } as GenBankRecord]));
  const result = closestTaxonConsensus({
    localHits: [], ncbiHits: rows.map((r) => r.hit), localAdjusted: {}, ncbiAdjusted: Object.fromEntries(rows.map((r) => [r.hit.num, r.identity])),
    sequenceMap: {}, genbankMap, ownSequenceIds: ["881628"], ownRecord: "inat:405934521", lookup: new Map(),
  });
  assert.equal(result.genus, "Sebacina");
  assert.deepEqual(result.considered.map((h) => h.name), ["Sebacina incrustans", "Sebacina epigaea", "Sebacina dimitica", "Serendipita vermifera"]);
  assert.ok(!result.votes.some((v) => v.genus === "Vouchered" || v.genus === "Ectomycorrhizal"));
  // Nothing but stand-ins: no genus, so it is asked for.
  const only = closestTaxonConsensus({
    localHits: [], ncbiHits: rows.slice(0, 5).map((r) => r.hit), localAdjusted: {}, ncbiAdjusted: Object.fromEntries(rows.map((r) => [r.hit.num, r.identity])),
    sequenceMap: {}, genbankMap, ownSequenceIds: [], ownRecord: null, lookup: new Map(),
  });
  assert.equal(only.genus, null);
  assert.equal(only.reason, "too_few_named_hits");
});

// ── an existing name before a new one (2026-11-19, sequence 884957) ──

const existingRange = (n: number) => Array.from({ length: n }, (_, i) => i);
const existingVote = (source: "local" | "ncbi", accession: string, name: string, identity: number): NameVoteHit =>
  ({ source, accession, name, identity, base: name.split(" ")[0], baseRank: "genus" });
// 884957 as the BLAST page showed it: GenBank Hydnellum mirabile at 99.56-99.57%, H. aurantiacum at 99.52%,
// and three unvalidated MycoMap records, two of them H. mirabile.
const existingPool = [
  existingVote("ncbi", "AY569029", "Hydnellum mirabile", 99.57), existingVote("ncbi", "PQ641266", "Hydnellum mirabile", 99.57),
  existingVote("ncbi", "MK602728", "Hydnellum mirabile", 99.56), existingVote("ncbi", "MK602730", "Hydnellum mirabile", 99.56),
  existingVote("ncbi", "MK602729", "Hydnellum mirabile", 99.56), existingVote("ncbi", "HQ650729", "Hydnellum aurantiacum", 99.52),
  existingVote("local", "901001", "Hydnellum mirabile", 99.5), existingVote("local", "901002", "Hydnellum mirabile", 99.5), existingVote("local", "901003", "Hydnellum", 99.4),
];
const existingGenbank = { name: "Hydnellum mirabile", rank: "species", count: 7, total: 8, identityThreshold: 99.5 };
const existingShared = ["Hydnellum mirabile", "Hydnellum mirabile", "Hydnellum"];

test("existing name: 884957: Hydnellum mirabile, with H. aurantiacum named as within 0.1%", () => {
  const { suggestion, refusal } = existingSpeciesName({ pool: existingPool, genbank: existingGenbank, sharedNames: existingShared, recordFamily: "Bankeraceae", nameFamily: "Bankeraceae" });
  assert.equal(refusal, null);
  assert.equal(suggestion?.name, "Hydnellum mirabile");
  assert.equal(suggestion?.share, 0.875, "7 of the 8 hits that name a species; the bare genus is neither for nor against");
  assert.deepEqual(suggestion?.genbank, { count: 7, total: 8, identityThreshold: 99.5 });
  assert.deepEqual(suggestion?.shared, { agree: 2, total: 2 }, "a bare genus is not a species for or against");
  assert.deepEqual(suggestion?.rival, { name: "Hydnellum aurantiacum", identity: 99.52, nameIdentity: 99.57 });
});

test("existing name: no rival when the closest other species is more than 0.1% behind", () => {
  const apart = existingPool.map((hit) => (hit.name === "Hydnellum aurantiacum" ? { ...hit, identity: 99.4 } : hit));
  assert.equal(existingSpeciesName({ pool: apart, genbank: existingGenbank, sharedNames: existingShared }).suggestion?.rival, null);
});

test("existing name: each condition refuses on its own, and the new name is made as before", () => {
  const refusal = (over: Partial<Parameters<typeof existingSpeciesName>[0]>) => existingSpeciesName({ pool: existingPool, genbank: existingGenbank, sharedNames: existingShared, ...over }).refusal;
  assert.equal(refusal({ genbank: null }), "no_genbank_species");
  assert.equal(refusal({ genbank: { ...existingGenbank, rank: "genus", name: "Hydnellum sp." } }), "no_genbank_species", "GenBank naming only a genus");
  assert.equal(refusal({ genbank: { ...existingGenbank, count: 1, total: 1 } }), "no_genbank_species", "one GenBank record is not enough");
  assert.equal(refusal({ pool: [...existingPool.slice(0, 2), ...existingRange(6).map((i) => existingVote("ncbi", `X${i}`, "Hydnellum aurantiacum", 99.6))] }), "closest_hits_disagree");
  assert.equal(refusal({ sharedNames: ["Hydnellum caeruleum", "Hydnellum caeruleum", "Hydnellum mirabile"] }), "mycomap_names_another");
  assert.equal(refusal({ pool: [...existingPool, existingVote("ncbi", "FAR1", "Hydnellum mirabile", 97.9)] }), "name_on_distant_sequence");
  assert.equal(refusal({ recordFamily: "Fomitopsidaceae", nameFamily: "Bankeraceae" }), "family_differs");
  assert.equal(refusal({ recordFamily: null, nameFamily: "Bankeraceae" }), null, "an unknown family does not refuse");
});
