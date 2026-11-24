/**
 * The stray-read rule of the validation engine (lib/validation-engine
 * strayRead.ts; 2026-11-16, sequence 892545): a read the analysis could
 * not name, on a record its other reads name, that does not align with them,
 * is a contaminant; and what it most likely is.
 *
 *   node --import tsx --test src/services/validationEngineStrayRead.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alignsWithReads,
  isUnnamedRead,
  primerAmplicon,
  primerSite,
  recordAnchor,
  strayReadLikelyName,
  strayReadStep,
  strayReadVerdict,
  STRAY_READ_ANCHOR_CONFIDENCE,
  STRAY_READ_MIN_NAMING_READS,
  type CoveringNcbiHit,
  type RecordReadSummary,
} from "../src/strayRead";
import * as engine from "../src/index";
import type { BlastHit } from "../src/analysisRules";

// The record's lab well: ITS1Fngs / ITS4ngsUni.
const ITS = "ITS1F/ITS4";
const named = (id: string, confidence: number, over: Partial<RecordReadSummary> = {}): RecordReadSummary => ({
  id, status: "complete", finalSpecies: "Cantharellus tenuithrix", finalConfidence: confidence, flaggedContaminant: false, flaggedNonTarget: false, barcodeGapNeeded: false, amplicon: ITS, ...over,
});
const unnamed = (id: string, over: Partial<RecordReadSummary> = {}): RecordReadSummary => ({
  id, status: "complete", finalSpecies: "", finalConfidence: 0, flaggedContaminant: false, flaggedNonTarget: false, barcodeGapNeeded: true, amplicon: ITS, ...over,
});
const hit = (accession: string, cover: number): BlastHit => ({
  num: 1, def: accession, accession, id: accession, len: 800, identity: 780, alignLen: 800, queryLen: 872, queryCoverage: cover, hsps: [],
});
const ncbi = (accession: string, name: string | null, identity: number, cover: number, title = name ?? ""): CoveringNcbiHit => ({ accession, name, title, identity, queryCoverage: cover });

// The record of sequence 892545: six reads of Cantharellus tenuithrix at 74 to 96%, and the stray one.
const record = [named("892540", 96), named("892541", 91), named("892542", 88), named("892543", 80), named("892544", 77), named("892546", 74)];
const stray = unnamed("892545");

test("a record has a name when at least two reads name the same species, none names another, and one reaches the validation threshold", () => {
  assert.equal(STRAY_READ_MIN_NAMING_READS, 2);
  assert.equal(STRAY_READ_ANCHOR_CONFIDENCE, 70);
  assert.deepEqual(recordAnchor([...record, stray]), {
    species: "Cantharellus tenuithrix", bestConfidence: 96,
    sequenceIds: ["892540", "892541", "892542", "892543", "892544", "892546"],
  });
  // Best confidence first, whatever order they come in.
  assert.deepEqual(recordAnchor([named("b", 40), named("a", 70)])?.sequenceIds, ["a", "b"]);
  assert.equal(recordAnchor([named("a", 70), named("b", 40, { finalSpecies: "cantharellus  TENUITHRIX" })])?.species, "Cantharellus tenuithrix", "spelling of case and spaces aside");

  assert.equal(recordAnchor([named("a", 96)]), null, "one read does not name a record");
  assert.equal(recordAnchor([named("a", 69), named("b", 60)]), null, "none reaches the threshold");
  assert.equal(recordAnchor([named("a", 96), named("b", 90), named("c", 80, { finalSpecies: "Cantharellus formosus" })]), null, "the reads disagree");
  assert.equal(recordAnchor([]), null);
});

test("a read that is flagged, unfinished or carries a placeholder does not name the record", () => {
  const good = named("a", 96);
  for (const other of [
    named("b", 90, { flaggedContaminant: true }),
    named("b", 90, { flaggedNonTarget: true }),
    named("b", 90, { status: "error" }),
    named("b", 90, { status: "analyzing" }),
    named("b", 90, { finalSpecies: "Contaminant: Cladosporium sp." }),
    named("b", 90, { finalSpecies: "Non-Target: No BLAST hits" }),
    named("b", 90, { finalSpecies: "Manual Validation Needed" }),
    named("b", 90, { finalSpecies: "Singleton Sequence" }),
    named("b", 90, { finalSpecies: "   " }),
    named("b", 90, { finalSpecies: null }),
  ]) {
    assert.equal(recordAnchor([good, other]), null, JSON.stringify(other));
    // And it does not count as disagreeing either: two real reads still name the record.
    assert.equal(recordAnchor([good, named("c", 80), other])?.sequenceIds.join(","), "a,c", JSON.stringify(other));
  }
});

test("an unnamed read is a finished one with no species that the analysis sent to the barcode gap, and no flag", () => {
  assert.equal(isUnnamedRead(stray), true);
  assert.equal(isUnnamedRead(unnamed("x", { finalSpecies: null })), true);
  assert.equal(isUnnamedRead(unnamed("x", { finalSpecies: "  " })), true);
  assert.equal(isUnnamedRead(unnamed("x", { barcodeGapNeeded: false })), false, "the analysis did not send it to the barcode gap");
  assert.equal(isUnnamedRead(unnamed("x", { barcodeGapNeeded: null })), false);
  assert.equal(isUnnamedRead(unnamed("x", { finalSpecies: "Cantharellus tenuithrix" })), false);
  assert.equal(isUnnamedRead(unnamed("x", { flaggedContaminant: true })), false, "flagged already");
  assert.equal(isUnnamedRead(unnamed("x", { flaggedNonTarget: true })), false);
  assert.equal(isUnnamedRead(unnamed("x", { status: "error" })), false);
});

test("a read aligns with the record when one of the naming reads is among its MycoBLAST hits over most of its length", () => {
  const ids = ["892540", "892541"];
  assert.equal(alignsWithReads([hit("OTU1846", 29), hit("892541", 70)], ids), true);
  assert.equal(alignsWithReads([hit("892541", 69)], ids), false, "a short shared stretch is not the same specimen");
  assert.equal(alignsWithReads([hit("892599", 100)], ids), false, "another record's read");
  assert.equal(alignsWithReads([], ids), false);
});

test("sequence 892545: no name, six reads of the record agree, and none of them is among its hits: a contaminant", () => {
  // Its MycoBLAST hits: an eDNA OTU over 29% of it, nothing of its own record.
  const verdict = strayReadVerdict({ read: stray, recordReads: [...record, stray], localHits: [hit("OTU1846", 29), hit("700001", 31)] });
  assert.equal(verdict.stray, true);
  assert.deepEqual(verdict.stray && verdict.anchor.sequenceIds, ["892540", "892541", "892542", "892543", "892544", "892546"]);
  assert.equal(verdict.stray && verdict.anchor.species, "Cantharellus tenuithrix");
  assert.equal(verdict.stray && verdict.amplicon, "ITS1F/ITS4");
});

test("two names for one primer site are one site, and a pair needs both primers", () => {
  for (const name of ["ITS1F", "its1f", "ITS1Fngs", "ITS1-F", "ITS5", "ITS1"]) assert.equal(primerSite(name), "ITS1F", name);
  for (const name of ["ITS4", "ITS4ngsUni", "ITS4B", "its4"]) assert.equal(primerSite(name), "ITS4", name);
  for (const name of ["gITS7", "fITS7", "ITS3"]) assert.equal(primerSite(name), "ITS3", name);
  for (const name of ["LR0R", "LROR", "lror"]) assert.equal(primerSite(name), "LR0R", name);
  assert.equal(primerSite("LR5"), "LR5");
  assert.equal(primerSite("EF1.983F"), "EF1983F", "any other primer is its own name");
  for (const none of [null, undefined, "", "  ", "*"]) assert.equal(primerSite(none), null);

  assert.equal(primerAmplicon("ITS1Fngs", "ITS4ngsUni"), "ITS1F/ITS4");
  assert.equal(primerAmplicon("its1f", "its4"), "ITS1F/ITS4", "the sequence's spelling and the lab well's give one amplicon");
  assert.equal(primerAmplicon("gITS7", "ITS4"), "ITS3/ITS4", "ITS2 alone is another amplicon than the whole ITS");
  assert.equal(primerAmplicon("ITS1F", "LR7"), "ITS1F/LR7", "and so is the ITS running into the LSU");
  assert.equal(primerAmplicon("LROR", "LR5"), "LR0R/LR5");
  assert.equal(primerAmplicon("FungalPoolF", "FungalPoolR"), "FUNGALPOOLF/FUNGALPOOLR");
  assert.equal(primerAmplicon("its1f", null), null, "half a pair does not say where the read ends");
  assert.equal(primerAmplicon(null, "its4"), null);
  assert.equal(primerAmplicon("*", "*"), null);
});

test("a read is compared only with reads made with the same primers: another region of the same specimen is not a contaminant", () => {
  // An LSU read on the record: it does not align with the ITS reads, and it is the specimen.
  const lsu = unnamed("892560", { amplicon: "LR0R/LR5" });
  assert.deepEqual(strayReadVerdict({ read: lsu, recordReads: [...record, lsu], localHits: [] }), { stray: false, reason: "another_amplicon" });
  // ITS2 alone, or the ITS running into the LSU: another stretch, not compared either.
  for (const amplicon of ["ITS3/ITS4", "ITS1F/LR7"]) {
    const other = unnamed("892561", { amplicon });
    assert.deepEqual(strayReadVerdict({ read: other, recordReads: [...record, other], localHits: [] }), { stray: false, reason: "another_amplicon" }, amplicon);
  }
  // Primers nobody recorded: there is no telling, so it is left as it is.
  for (const amplicon of [null, undefined, ""]) {
    const unknown = unnamed("892562", { amplicon });
    assert.deepEqual(strayReadVerdict({ read: unknown, recordReads: [...record, unknown], localHits: [] }), { stray: false, reason: "amplicon_unknown" });
  }
  // The reads that name the record have no primers recorded: nothing to compare the read with.
  const noPrimers = record.map((read) => ({ ...read, amplicon: null }));
  assert.deepEqual(strayReadVerdict({ read: stray, recordReads: [...noPrimers, stray], localHits: [] }), { stray: false, reason: "another_amplicon" });
  // The reads of its own primer pair must name the record by themselves: one of them is not enough.
  const mixed = [named("a", 96), named("b", 90, { amplicon: "ITS3/ITS4" }), named("c", 85, { amplicon: "ITS3/ITS4" }), stray];
  assert.deepEqual(strayReadVerdict({ read: stray, recordReads: mixed, localHits: [] }), { stray: false, reason: "another_amplicon" });
  // With two of its own pair it is judged, against those two only: a match with a read of the other pair is not alignment.
  const two = [named("a", 96), named("a2", 80), named("b", 90, { amplicon: "ITS3/ITS4" }), stray];
  const verdict = strayReadVerdict({ read: stray, recordReads: two, localHits: [hit("b", 100)] });
  assert.deepEqual(verdict.stray && verdict.anchor.sequenceIds, ["a", "a2"]);
  assert.equal(strayReadVerdict({ read: stray, recordReads: two, localHits: [hit("a2", 80)] }).stray, false);
  // A record with no name at all is said so first, whatever the primers.
  assert.deepEqual(strayReadVerdict({ read: lsu, recordReads: [named("a", 96), lsu], localHits: [] }), { stray: false, reason: "record_has_no_name" });
});

test("a poor read of the same specimen, a named read, and a read on a record with no name are left as they are", () => {
  const reads = [...record, stray];
  assert.deepEqual(strayReadVerdict({ read: stray, recordReads: reads, localHits: [hit("892542", 95)] }), { stray: false, reason: "aligns_with_the_record" },
    "it still matches its own record's reads end to end");
  assert.deepEqual(strayReadVerdict({ read: record[5], recordReads: reads, localHits: [] }), { stray: false, reason: "read_has_a_name_or_flag" });
  assert.deepEqual(strayReadVerdict({ read: unnamed("x", { flaggedNonTarget: true }), recordReads: reads, localHits: [] }), { stray: false, reason: "read_has_a_name_or_flag" });
  assert.deepEqual(strayReadVerdict({ read: stray, recordReads: [named("a", 96), stray], localHits: [] }), { stray: false, reason: "record_has_no_name" }, "one naming read is not enough");
  assert.deepEqual(strayReadVerdict({ read: stray, recordReads: [named("a", 96), named("b", 90, { finalSpecies: "Cantharellus formosus" }), stray], localHits: [] }),
    { stray: false, reason: "record_has_no_name" }, "the record's reads disagree");
  assert.deepEqual(strayReadVerdict({ read: stray, recordReads: [stray, unnamed("y")], localHits: [] }), { stray: false, reason: "record_has_no_name" });
  // A match with a read of the record that does not name it (flagged) is not alignment with the specimen.
  const flagged = named("f", 90, { flaggedContaminant: true });
  assert.equal(strayReadVerdict({ read: stray, recordReads: [...record, flagged, stray], localHits: [hit("f", 100)] }).stray, true);
});

test("what a stray read most likely is: a genus named NCBI records agree on; else Fungi when its closest covering match is an unnamed fungus; else nothing", () => {
  // 892545 itself: 99 of 100 NCBI hits "uncultured fungus"; the one covering the read is at 86%; the one named hit covers 27% of it.
  const likely = strayReadLikelyName([
    ncbi("FJ237197", "uncultured fungus", 86, 92, "Uncultured fungus clone 1 18S ribosomal RNA gene, partial sequence"),
    ncbi("XX000001", "Pseudopirsonia sp.", 95, 27),
    ncbi("XX000002", "uncultured fungus", 99, 30),
  ]);
  assert.deepEqual(likely, {
    name: "Fungi", rank: "above_genus", confidence: 43, source: "closest_ncbi_hit", count: 1, total: 1, identityThreshold: null, onContaminantList: false,
    summary: "Likely Fungi: the closest NCBI match covering the read is FJ237197 at 86.0% identity, an unnamed fungus; no named record covers it",
  });

  // Named records that cover the read and agree on a genus at 97% or more: the contaminant genus rule.
  const genus = strayReadLikelyName([
    ncbi("A1", "Cladosporium cladosporioides", 99, 95), ncbi("A2", "Cladosporium herbarum", 98, 96), ncbi("A3", "uncultured fungus", 99.5, 99),
  ]);
  assert.equal(genus?.name, "Cladosporium sp.");
  assert.equal(genus?.source, "ncbi_genus");
  // The same records over a third of the read name nothing.
  assert.equal(strayReadLikelyName([ncbi("A1", "Cladosporium cladosporioides", 99, 30), ncbi("A2", "Cladosporium herbarum", 98, 31)]), null);

  // A kingdom from one match is said with little weight, within 10 to 50.
  const fungus = (identity: number) => strayReadLikelyName([ncbi("U1", null, identity, 80, "Uncultured fungus isolate X")])?.confidence;
  assert.equal(fungus(100), 50);
  assert.equal(fungus(86), 43);
  assert.equal(fungus(12), 10);
  assert.equal(strayReadLikelyName([ncbi("U1", "fungal sp.", 90, 80)])?.name, "Fungi");
  assert.equal(strayReadLikelyName([ncbi("U1", "Fungi sp.", 90, 80)])?.name, "Fungi");

  // The closest covering match is what counts: a bacterium, a plant or a single named fungus gives no likely name.
  assert.equal(strayReadLikelyName([ncbi("B1", "uncultured bacterium", 95, 90), ncbi("U1", "uncultured fungus", 80, 90)]), null);
  assert.equal(strayReadLikelyName([ncbi("N1", "Russula emetica", 88, 90)]), null, "one named record is not a consensus, and it is not an unnamed fungus");
  assert.equal(strayReadLikelyName([]), null);
  assert.equal(strayReadLikelyName([ncbi("U1", "uncultured fungus", Number.NaN, 90)]), null);
});

test("the step a stray read gets says why, names the reads it was compared with, and what it likely is", () => {
  const anchor = recordAnchor(record)!;
  const likely = strayReadLikelyName([ncbi("FJ237197", "uncultured fungus", 86, 92)]);
  assert.deepEqual(strayReadStep(anchor, likely, "ITS1F/ITS4"), {
    step: "Cross-Sequence Stray Read Detection",
    status: "fail",
    message: "Flagged as a contaminant: no species for this read, while 6 other reads of the record are Cantharellus tenuithrix and none of them is among its MycoBLAST matches",
    details: [
      "The record's reads name it Cantharellus tenuithrix (best 96%): 892540, 892541, 892542, 892543, 892544, 892546",
      "They were made with the same primers as this read (ITS1F/ITS4), so it covers the same stretch of DNA",
      "None of those reads matches this one over 70% or more of its length, so it is not a poor read of the same specimen",
      "Likely Fungi: the closest NCBI match covering the read is FJ237197 at 86.0% identity, an unnamed fungus; no named record covers it",
    ],
  });
  assert.equal(strayReadStep(anchor, null, "ITS1F/ITS4").details[3], "No likely name: nothing in NCBI covers this read");
});

test("the rule is part of the engine's public surface", () => {
  assert.equal(engine.strayReadVerdict, strayReadVerdict);
  assert.equal(engine.strayReadLikelyName, strayReadLikelyName);
  assert.equal(engine.primerAmplicon, primerAmplicon);
});

test("a stray read's likely name leaves GenBank's stand-in names out of the genus vote, and 'Vouchered mycorrhizae' is a fungus", () => {
  // Stand-ins at 97% or more agree on nothing: they are no genus.
  assert.equal(strayReadLikelyName([ncbi("V1", "Vouchered mycorrhizae", 99, 95), ncbi("V2", "Vouchered mycorrhizae", 98, 96), ncbi("V3", "Vouchered mycorrhizae", 98, 94)])?.name, "Fungi",
    "the closest covering match is an unnamed fungus");
  assert.equal(strayReadLikelyName([ncbi("E1", "Ectomycorrhizal fungus", 99, 95), ncbi("E2", "Ectomycorrhizal fungus", 99, 95)])?.source, "closest_ncbi_hit");
  // Not a fungus: no likely name.
  assert.equal(strayReadLikelyName([ncbi("C1", "Collembola environmental sample", 97, 95), ncbi("C2", "Collembola environmental sample", 97, 95)]), null);
});
