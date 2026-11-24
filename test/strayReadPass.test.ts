/**
 * The stray-read pass of an analysis run (strayReadPass.ts), from
 * stand-ins: no database, no network. The rule itself:
 * validationEngineStrayRead.test.ts.
 *
 *   node --import tsx --test src/services/strayReadPass.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { flagStrayReads, STRAY_READ_MIN_RECORD_READS, type StrayReadFlag, type StrayReadPassDeps } from "../src/strayReadPass";
import type { RecordReadSummary } from "../src/strayRead";
import type { BlastHit } from "../src/analysisRules";

const named = (id: string, confidence: number, over: Partial<RecordReadSummary> = {}): RecordReadSummary => ({
  id, status: "complete", finalSpecies: "Cantharellus tenuithrix", finalConfidence: confidence, flaggedContaminant: false, flaggedNonTarget: false, barcodeGapNeeded: false, ...over,
});
const unnamed = (id: string): RecordReadSummary => ({
  id, status: "complete", finalSpecies: "", finalConfidence: 0, flaggedContaminant: false, flaggedNonTarget: false, barcodeGapNeeded: true,
});
const hit = (accession: string, cover: number): BlastHit => ({
  num: 1, def: accession, accession, id: accession, len: 800, identity: 780, alignLen: 800, queryLen: 872, queryCoverage: cover, hsps: [],
});
const unnamedFungus = [{ accession: "FJ237197", name: "uncultured fungus", title: "Uncultured fungus clone", identity: 86, queryCoverage: 92 }];

async function run(reads: RecordReadSummary[], over: Partial<StrayReadPassDeps> = {}) {
  const calls: string[] = [];
  const errors: string[] = [];
  const saved: StrayReadFlag[] = [];
  const flags = await flagStrayReads(reads, {
    // Every read of the record came from one well: the same primers.
    ampliconOf: async (id) => { calls.push(`ampliconOf ${id}`); return "ITS1F/ITS4"; },
    loadHits: async (id) => { calls.push(`loadHits ${id}`); return { localHits: [hit("OTU1846", 29)], ncbiHits: unnamedFungus }; },
    saveFlag: async (flag) => { calls.push(`saveFlag ${flag.sequenceId}`); saved.push(flag); },
    flagSequence: async (id) => { calls.push(`flagSequence ${id}`); },
    logError: (message) => { errors.push(message); },
    ...over,
  });
  return { flags, calls, errors, saved };
}

const record = [named("1", 96), named("2", 80)];

test("a stray read is saved as a contaminant with its likely name and step, then flagged on its sequence", async () => {
  const { flags, calls, saved } = await run([...record, unnamed("3")]);
  assert.deepEqual(calls, ["ampliconOf 1", "ampliconOf 2", "ampliconOf 3", "loadHits 3", "saveFlag 3", "flagSequence 3"],
    "every read's primers, then only the unnamed read's hits; saved before the sequence is flagged");
  assert.match(flags[0].step.details[1], /made with the same primers as this read \(ITS1F\/ITS4\)/);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].sequenceId, "3");
  assert.equal(flags[0].likely?.name, "Fungi");
  assert.equal(flags[0].step.step, "Cross-Sequence Stray Read Detection");
  assert.match(flags[0].step.message, /2 other reads of the record are Cantharellus tenuithrix/);
  assert.deepEqual(saved, flags);
});

test("a record with too few reads, with no name, or with no unnamed read is not looked at: nothing is read", async () => {
  assert.equal(STRAY_READ_MIN_RECORD_READS, 3);
  for (const reads of [
    [named("1", 96), unnamed("3")],
    [unnamed("3"), unnamed("4"), unnamed("5")],
    [named("1", 96), named("2", 80, { finalSpecies: "Cantharellus formosus" }), unnamed("3")],
    [named("1", 60), named("2", 50), unnamed("3")],
    [named("1", 96), named("2", 80), named("3", 75)],
    [],
  ]) {
    const { flags, calls } = await run(reads);
    assert.deepEqual(flags, []);
    assert.deepEqual(calls, [], JSON.stringify(reads.map((r) => r.id)));
  }
});

test("a read made with other primers than the reads that name the record, or with primers nobody recorded, is not judged", async () => {
  const noWrites = (calls: string[]) => !calls.some((c) => c.startsWith("saveFlag") || c.startsWith("flagSequence"));
  // An LSU read on a record its ITS reads name: another region of the same specimen, not a contaminant.
  const lsu = await run([...record, unnamed("3")], { ampliconOf: async (id) => (id === "3" ? "LR0R/LR5" : "ITS1F/ITS4") });
  assert.deepEqual(lsu.flags, []);
  assert.ok(noWrites(lsu.calls));
  // Its primers are not known: its hits are not even read.
  const unknown = await run([...record, unnamed("3")], { ampliconOf: async (id) => (id === "3" ? null : "ITS1F/ITS4") });
  assert.deepEqual(unknown.flags, []);
  assert.deepEqual(unknown.calls, []);
  // The naming reads' primers are not known: there is nothing to compare it with.
  const anchorUnknown = await run([...record, unnamed("3")], { ampliconOf: async (id) => (id === "3" ? "ITS1F/ITS4" : null) });
  assert.deepEqual(anchorUnknown.flags, []);
  assert.ok(noWrites(anchorUnknown.calls));
  // Primers that cannot be read at all are unknown, not a failure of the run.
  const broken = await run([...record, unnamed("3")], { ampliconOf: async () => { throw new Error("db down"); } });
  assert.deepEqual(broken.flags, []);
  assert.deepEqual(broken.errors, ["the primers of read 1 could not be read", "the primers of read 2 could not be read", "the primers of read 3 could not be read"]);
  // Two ITS reads name it; the unnamed read is ITS2 alone, like one other read: one read of its own pair is not enough.
  const short = await run([named("1", 96), named("2", 80), named("4", 90), unnamed("3")], { ampliconOf: async (id) => (id === "3" || id === "4" ? "ITS3/ITS4" : "ITS1F/ITS4") });
  assert.deepEqual(short.flags, []);
  assert.ok(noWrites(short.calls));
});

test("a read that aligns with its record's reads, or whose hits cannot be read, stays as the analysis left it", async () => {
  const aligned = await run([...record, unnamed("3")], { loadHits: async () => ({ localHits: [hit("2", 95)], ncbiHits: unnamedFungus }) });
  assert.deepEqual(aligned.flags, []);
  assert.ok(!aligned.calls.some((c) => c.startsWith("saveFlag") || c.startsWith("flagSequence")));
  const unread = await run([...record, unnamed("3")], { loadHits: async () => null });
  assert.deepEqual(unread.flags, []);
  assert.ok(!unread.calls.some((c) => c.startsWith("saveFlag") || c.startsWith("flagSequence")), "unknown is not 'does not align'");
});

test("it never fails the run: a read that cannot be loaded or saved is left, and the next read is still judged", async () => {
  const reads = [...record, unnamed("3"), unnamed("4")];
  const loadFails = await run(reads, { loadHits: async (id) => { if (id === "3") throw new Error("S3 timeout"); return { localHits: [], ncbiHits: [] }; } });
  assert.deepEqual(loadFails.flags.map((f) => f.sequenceId), ["4"]);
  assert.equal(loadFails.flags[0].likely, null, "nothing in NCBI covers it: flagged with no likely name");
  assert.deepEqual(loadFails.errors, ["stray-read detection failed for 3"]);

  const saveFails = await run(reads, { saveFlag: async (flag) => { if (flag.sequenceId === "3") throw new Error("db down"); } });
  assert.deepEqual(saveFails.flags.map((f) => f.sequenceId), ["4"], "a flag that was not saved is not reported as flagged");
  assert.ok(!saveFails.calls.includes("flagSequence 3"), "and its sequence is not flagged");
  assert.ok(saveFails.calls.includes("flagSequence 4"));

  // The saved analysis is flagged even when the sequence's own flag could not be set.
  const flagFails = await run(reads, { flagSequence: async () => { throw new Error("502"); } });
  assert.deepEqual(flagFails.flags.map((f) => f.sequenceId), ["3", "4"]);
  assert.deepEqual(flagFails.errors, ["stray read 3 could not be flagged on its sequence", "stray read 4 could not be flagged on its sequence"]);
});
