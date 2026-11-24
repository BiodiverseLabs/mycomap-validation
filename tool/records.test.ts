// The record decisions: each record validated, rejected or held for a person,
// as mycomap.org's auto-validation decides a record MycoMap Vision cannot
// look at, so the observer's identification is the only second source. With
// MycoMap Vision asked: vision.test.ts.
//   node --import tsx --test tool/records.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AnalysisResult } from "../src/analysisRules";
import { recordLine } from "./cli";
import { decideRecords, groupRecords, recordPlatform } from "./records";
import { recordsCsv } from "./run";

const seq = (id: string, record: string | null, recordName: string | null, readCount: number | null = 40) =>
  ({ id, description: "", bases: "ACGT", recordName, readCount, record });
const named = (finalSpecies: string | null, finalConfidence: number | null, extra: Partial<AnalysisResult> = {}) =>
  ({ status: "complete", steps: [], finalSpecies, finalConfidence, flaggedContaminant: false, flaggedNonTarget: false, ...extra }) as unknown as AnalysisResult;
const FAMILIES = new Map([["Russula", "Russulaceae"], ["Lactarius", "Russulaceae"], ["Amanita", "Amanitaceae"]]);

test("sequences that share the sheet's record are one record, in the order first met; a sequence with none is a record of its own", () => {
  const groups = groupRecords([seq("a", "inat:1", null), seq("b", null, "Amanita"), seq("c", "inat:1", "Russula emetica")] as never);
  assert.deepEqual(groups, [
    { record: "inat:1", sequenceIds: ["a", "c"], observerName: "Russula emetica" },
    { record: "b", sequenceIds: ["b"], observerName: "Amanita" },
  ]);
  assert.equal(recordPlatform("mo:657366"), "mo");
  assert.equal(recordPlatform("inat:1"), "inat");
  assert.equal(recordPlatform("OMDL-1234"), "inat", "a record of the user's own is decided as one that takes a second source");
});

test("reads that agree at 70% or more, with the observer's identification in the DNA's genus, validate the record as the DNA's species; the read with the most reads in consensus carries it", async () => {
  const [r] = await decideRecords(
    [seq("plate7-A01", "OMDL-1", "Russula", 12), seq("plate7-A02", "OMDL-1", "Russula", 140)] as never,
    { "plate7-A01": named("Russula emetica", 92), "plate7-A02": named("Russula emetica", 81) },
    FAMILIES,
  );
  assert.equal(r.decision, "validate");
  assert.equal(r.species, "Russula emetica");
  assert.equal(r.selectedSequenceId, "plate7-A02");
  assert.deepEqual(r.agreeingSequenceIds, ["plate7-A01", "plate7-A02"], "the user's own read names, not dropped as non-numbers");
  assert.equal(r.secondSource, "the observer's identification (Russula) is in Russula");
  assert.equal(r.reason, "Validated as Russula emetica, carried by plate7-A02; second source: the observer's identification (Russula) is in Russula.");
});

test("with no second source the record is held for a person, saying Vision was not asked (no key) rather than that it found no photos", async () => {
  const [otherGenus, noName] = await decideRecords(
    [seq("a", "R1", "Amanita muscaria"), seq("b", "R2", null)] as never,
    { a: named("Russula emetica", 95), b: named("Russula emetica", 95) },
    FAMILIES,
  );
  assert.equal(otherGenus.decision, "held");
  assert.equal(otherGenus.reason, "No second source for the DNA's Russula emetica: MycoMap Vision was not asked (no Vision key was given), and the observer's identification (Amanita muscaria) is not in Russula. Held for a person.");
  assert.equal(noName.decision, "held");
  assert.match(noName.reason, /MycoMap Vision was not asked .*, and there is no identification from the observer\. Held for a person\.$/);
  assert.doesNotMatch(otherGenus.reason + noName.reason, /found no usable photos/);
});

test("reads that disagree go to a person: without Vision nothing picks between them", async () => {
  const [r] = await decideRecords(
    [seq("a", "R1", "Russula"), seq("b", "R1", "Russula")] as never,
    { a: named("Russula emetica", 95), b: named("Lactarius deliciosus", 90) },
    FAMILIES,
  );
  assert.equal(r.decision, "held");
  assert.match(r.reason, /^Sequences disagree on species: "Russula emetica" \(seq a 95%\) vs "Lactarius deliciosus" \(seq b 90%\)\. Manual review needed\.$/);
});

test("a record whose every read is a contaminant or another organism is rejected; a contaminant beside a good read does not stop it", async () => {
  const [onlyBad, mixed] = await decideRecords(
    [seq("a", "R1", "Russula"), seq("b", "R1", "Russula"), seq("c", "R2", "Russula"), seq("d", "R2", "Russula")] as never,
    {
      a: named(null, null, { flaggedContaminant: true }), b: named(null, null, { flaggedNonTarget: true }),
      c: named(null, null, { flaggedContaminant: true }), d: named("Russula emetica", 88),
    },
    FAMILIES,
  );
  assert.equal(onlyBad.decision, "reject");
  assert.equal(onlyBad.reason, "Rejected: every read of the record is a contaminant or another organism than the specimen.");
  assert.equal(mixed.decision, "validate");
  assert.deepEqual(mixed.agreeingSequenceIds, ["d"]);
});

test("below 70% confidence, or with no read at 3 reads in consensus, the record waits for a person; a Sanger read (no read count) is not held back", async () => {
  const [low, fewReads, sanger] = await decideRecords(
    [seq("a", "R1", "Russula", 40), seq("b", "R2", "Russula", 2), seq("c", "R3", "Russula", null)] as never,
    { a: named("Russula emetica", 64), b: named("Russula emetica", 95), c: named("Russula emetica", 95) },
    FAMILIES,
  );
  assert.equal(low.decision, "held");
  assert.match(low.reason, /none reach the 70% confidence threshold \(best: 64%/);
  assert.equal(fewReads.decision, "held");
  assert.match(fewReads.reason, /none reach the RiC ≥ 3 threshold/);
  assert.equal(sanger.decision, "validate");
});

test("records.csv gives one row per record with the decision and reason, and the terminal line says the same", async () => {
  const records = await decideRecords([seq("a", "inat:1", "Russula"), seq("b", "inat:1", "Russula"), seq("c", null, "Amanita")] as never,
    { a: named("Russula emetica", 92), b: named("Russula emetica", 81), c: named("Russula emetica", 95) }, FAMILIES);
  const stamp = { engineVersion: "2.0.0-beta.11", databases: { mycomap: { version: "2026-11-21" }, ncbi: null } } as never;
  const lines = recordsCsv(records, stamp).split("\r\n");
  assert.equal(lines[0], "record,sequences,record_name,decision,species,selected_sequence,agreeing_sequences,second_source,reason,new_name,set_aside,vision,vision_top,vision_model,vision_answers_version,validation_version,mycomap_database,ncbi_database");
  assert.equal(lines[1], "inat:1,a; b,Russula,validate,Russula emetica,a,a; b,the observer's identification (Russula) is in Russula,\"Validated as Russula emetica, carried by a; second source: the observer's identification (Russula) is in Russula.\",,,not asked: no Vision key was given,,,,2.0.0-beta.11,2026-11-21,not searched");
  assert.match(lines[2], /^c,c,Amanita,held,,,,,"No second source/);
  assert.equal(recordLine(records[0]), "  inat:1 (a, b): VALIDATED as Russula emetica");
  assert.match(recordLine(records[1]), /^  c: HELD for a person - No second source for the DNA's Russula emetica/);
});
