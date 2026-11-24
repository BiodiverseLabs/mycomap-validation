/**
 * The cross-read passes (crossReadPasses.ts): the rules the batch analysis applies across one
 * record's reads once each has been analysed. Stand-ins for every port: no
 * database, no network. Until this split, only the stray-read pass had tests.
 *
 *   node --import tsx --test src/services/crossReadPasses.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstDifference } from "../src/analysisCase";
import { runCrossReadPasses, type CrossReadPassesPorts, type CrossReadSequence } from "../src/crossReadPasses";
import { buildCrossReadCase, crossReadCaseArgs, recordingCrossReadPorts, replayCrossReadCase, type CrossReadCase } from "../src/crossReadCase";
import type { AnalysisJobResult } from "../src/analysisJobResult";

const OBS = "obs-1";
const read = (id: string, ric: number | null, sourceName: string | null = "Russula emetica", observationId = OBS): CrossReadSequence =>
  ({ id, observationId, ric, scientificName: sourceName });
const summary = (id: string, finalSpecies: string | null, finalConfidence: number | null, over: Partial<AnalysisJobResult> = {}): AnalysisJobResult =>
  ({ sequenceId: id, status: "complete", finalSpecies, finalConfidence, flaggedContaminant: false, flaggedNonTarget: false, ...over });
/** A saved analysis; `family` is what its Source Record Comparison step said. */
const saved = (finalSpecies: string | null, finalConfidence: number | null, over: Record<string, unknown> = {}, family?: "pass" | "fail") => ({
  status: "complete", finalSpecies, finalConfidence, flaggedContaminant: false, flaggedNonTarget: false,
  steps: family ? [{ step: "Source Record Comparison", status: family, message: "", details: [] }] : [],
  ...over,
});

type Setup = {
  reads: CrossReadSequence[];
  results: Record<string, AnalysisJobResult>;
  saved: Record<string, any>;
  canFlag?: boolean;
  ports?: Partial<CrossReadPassesPorts>;
};

async function run(setup: Setup) {
  const calls: string[] = [];
  const store: Record<string, any> = JSON.parse(JSON.stringify(setup.saved));
  const ports: CrossReadPassesPorts = {
    checkAborted: () => {},
    // As the database gives them: a copy of each saved analysis that exists.
    loadSavedResults: async (ids) => { calls.push(`load ${ids.join(",")}`); return ids.filter((id) => store[id]).map((id) => ({ sampleId: id, resultData: JSON.parse(JSON.stringify(store[id])) })); },
    saveResult: async (id, result) => { calls.push(`save ${id}`); store[id] = JSON.parse(JSON.stringify(result)); },
    postSequenceFlags: async (id, body) => { calls.push(`flags ${id} ${body}`); return { ok: true, status: 200, text: async () => "" }; },
    // No read's primers are known: the stray-read pass judges nothing here.
    strayReadAmpliconOf: () => async () => null,
    strayReadHits: async () => null,
    info: () => {},
    warn: () => {},
    error: (...args) => { calls.push(`error ${String(args[0])}`); },
    ...setup.ports,
  };
  const results = JSON.parse(JSON.stringify(setup.results)) as Record<string, AnalysisJobResult>;
  // As the job runs them since 1.7b: record by record, each written down as a case and replayed from it alone,
  // which must come to the same summaries, saves, flags and log lines.
  const byRecord = new Map<string, CrossReadSequence[]>();
  for (const r of setup.reads) byRecord.set(r.observationId, [...(byRecord.get(r.observationId) ?? []), r]);
  for (const recordReads of byRecord.values()) {
    const input = { jobId: "job-1", results, reads: recordReads, canFlagSequences: setup.canFlag ?? true };
    const args = crossReadCaseArgs(input);
    const recording = recordingCrossReadPorts(ports);
    await runCrossReadPasses(input, recording.ports);
    const written = recording.recorded();
    assert.equal(written.incomplete, null, "everything the passes were answered can be written down");
    const kept = JSON.parse(JSON.stringify(buildCrossReadCase({ args, resultsAfter: results, recorded: written, rulesVersion: "test", capturedAt: "2026-11-17T00:00:00.000Z" }))) as CrossReadCase;
    const again = await replayCrossReadCase(kept);
    assert.equal(firstDifference(kept.result, again.result), null, "run again from its case, the passes come to the same");
    assert.deepEqual(again.unused, [], "and ask for every answer they were given");
  }
  return { results, store, calls };
}
const steps = (store: Record<string, any>, id: string) => (store[id]?.steps ?? []).map((s: any) => `${s.step}:${s.status}`);

// ── cross-sequence non-target detection ──

test("a low-RiC read of another family beside a family-matching read with a good RiC is non-target, saved, and flagged in the record store", async () => {
  const { results, store, calls } = await run({
    reads: [read("1", 25), read("2", 5)],
    results: { "1": summary("1", "Russula emetica", 85), "2": summary("2", "Mycena galericulata", 40) },
    saved: { "1": saved("Russula emetica", 85, {}, "pass"), "2": saved("Mycena galericulata", 40, {}, "fail") },
  });
  assert.equal(results["2"].flaggedNonTarget, true);
  assert.equal(results["2"].finalSpecies, "Non-Target: Mycena galericulata");
  assert.equal(results["1"].flaggedNonTarget, false, "the family-matching read is kept");
  assert.equal(store["2"].finalSpecies, "Non-Target: Mycena galericulata");
  assert.deepEqual(steps(store, "2"), ["Source Record Comparison:fail", "Cross-Sequence Non-Target Detection:fail"]);
  assert.ok(calls.includes("flags 2 flags[contaminant]=1"));
  assert.ok(!calls.some((c) => c.startsWith("flags 1 ")));
});

test("a sole family-matching anchor with RiC over 10 sets aside every read of another family, whatever its own RiC", async () => {
  const { results, store } = await run({
    reads: [read("1", 25), read("2", 40)],
    results: { "1": summary("1", "Russula emetica", 85), "2": summary("2", "Mycena galericulata", 40) },
    saved: { "1": saved("Russula emetica", 85, {}, "pass"), "2": saved("Mycena galericulata", 40, {}, "fail") },
  });
  assert.equal(results["2"].flaggedNonTarget, true);
  assert.match(store["2"].steps.at(-1).message, /sole family-matching anchor \(RiC > 10\)/);
});

test("an anchor whose RiC is not known (possibly Sanger) is no sole anchor, and a read with no RiC is never low-RiC", async () => {
  for (const [anchorRic, otherRic] of [[null, 40], [null, null], [10, 40]] as const) {
    const { results, calls } = await run({
      reads: [read("1", anchorRic), read("2", otherRic)],
      results: { "1": summary("1", "Russula emetica", 85), "2": summary("2", "Mycena galericulata", 40) },
      saved: { "1": saved("Russula emetica", 85, {}, "pass"), "2": saved("Mycena galericulata", 40, {}, "fail") },
    });
    assert.equal(results["2"].flaggedNonTarget, false, `anchor RiC ${anchorRic}, other RiC ${otherRic}`);
    assert.ok(!calls.some((c) => c.startsWith("flags ")));
  }
  // Two strong family matches (no sole anchor, no dominance): only a low-RiC read of another family is set aside,
  // and a read with no RiC is not low.
  const legacy = await run({
    reads: [read("1", 25), read("2", 30), read("3", null), read("4", 4)],
    results: { "1": summary("1", "Russula emetica", 60), "2": summary("2", "Russula emetica", 55), "3": summary("3", "Mycena galericulata", 40), "4": summary("4", "Inocybe geophylla", 40) },
    saved: { "1": saved("Russula emetica", 60, {}, "pass"), "2": saved("Russula emetica", 55, {}, "pass"), "3": saved("Mycena galericulata", 40, {}, "fail"), "4": saved("Inocybe geophylla", 40, {}, "fail") },
  });
  assert.equal(legacy.results["3"].flaggedNonTarget, false, "no RiC: not low");
  assert.equal(legacy.results["4"].flaggedNonTarget, true, "RiC 4: low");
});

test("a confidence-dominant family anchor (70% or more, the other family matches under 30%) sets aside the reads of another family", async () => {
  const { results, store } = await run({
    reads: [read("1", 20), read("2", 3), read("3", 40)],
    results: { "1": summary("1", "Russula emetica", 80), "2": summary("2", "Russula nobilis", 20), "3": summary("3", "Mycena galericulata", 50) },
    saved: { "1": saved("Russula emetica", 80, {}, "pass"), "2": saved("Russula nobilis", 20, {}, "pass"), "3": saved("Mycena galericulata", 50, {}, "fail") },
  });
  assert.equal(results["3"].flaggedNonTarget, true);
  assert.match(store["3"].steps.at(-1).message, /confidence-dominant family anchor/);
  // The family-matching read at 20% is not set aside by this pass; the confidence-dominance pass after it does.
  assert.deepEqual(steps(store, "2"), ["Source Record Comparison:pass", "Cross-Sequence Confidence Dominance:fail"]);
});

test("reads that all name the same species are left alone, and so is a record with one read", async () => {
  const same = await run({
    reads: [read("1", 25), read("2", 5)],
    results: { "1": summary("1", "Russula emetica", 85), "2": summary("2", "russula emetica", 40) },
    saved: { "1": saved("Russula emetica", 85, {}, "pass"), "2": saved("russula emetica", 40, {}, "fail") },
  });
  assert.ok(!same.results["2"].flaggedNonTarget);
  assert.ok(!same.calls.some((c) => c.startsWith("save") || c.startsWith("flags")));
  const one = await run({ reads: [read("1", 25)], results: { "1": summary("1", "Russula emetica", 85) }, saved: { "1": saved("Russula emetica", 85, {}, "pass") } });
  assert.deepEqual(one.calls, []);
});

test("a family-matching read whose RiC penalty stands is no anchor: nothing is set aside on its word, and nothing is waived", async () => {
  // Its penalty makes it a low-RiC read. (So the waiver this pass offers the last read left, which needs a standing
  // penalty on a read that anchored, never comes into play: noted to 2026-11-17, not changed in this move.)
  const breakdown = { ricPenalty: 10, ricPenaltyWaived: false, genusMatchBonus: 5, finalScore: 62 };
  const { results, store, calls } = await run({
    reads: [read("1", 25), read("2", 5)],
    results: { "1": summary("1", "Russula emetica", 62), "2": summary("2", "Mycena galericulata", 40) },
    saved: { "1": saved("Russula emetica", 62, { confidenceBreakdown: breakdown }, "pass"), "2": saved("Mycena galericulata", 40, {}, "fail") },
  });
  assert.equal(results["2"].flaggedNonTarget, false);
  assert.equal(results["1"].finalConfidence, 62);
  assert.deepEqual(steps(store, "1"), ["Source Record Comparison:pass"]);
  assert.ok(!calls.some((c) => c.startsWith("flags ") || c.startsWith("save ")));
  // Waived already: it anchors.
  const waived = await run({
    reads: [read("1", 25), read("2", 5)],
    results: { "1": summary("1", "Russula emetica", 72), "2": summary("2", "Mycena galericulata", 40) },
    saved: { "1": saved("Russula emetica", 72, { confidenceBreakdown: { ...breakdown, ricPenaltyWaived: true } }, "pass"), "2": saved("Mycena galericulata", 40, {}, "fail") },
  });
  assert.equal(waived.results["2"].flaggedNonTarget, true);
});

test("without the key nothing is flagged in the record store, and a refused flag is logged and the run goes on", async () => {
  const setup = {
    reads: [read("1", 25), read("2", 5)],
    results: { "1": summary("1", "Russula emetica", 85), "2": summary("2", "Mycena galericulata", 40) },
    saved: { "1": saved("Russula emetica", 85, {}, "pass"), "2": saved("Mycena galericulata", 40, {}, "fail") },
  };
  const noKey = await run({ ...setup, canFlag: false });
  assert.equal(noKey.results["2"].flaggedNonTarget, true, "still set aside in the analysis");
  assert.ok(!noKey.calls.some((c) => c.startsWith("flags ")));
  const refused = await run({ ...setup, ports: { postSequenceFlags: async () => ({ ok: false, status: 500, text: async () => "boom" }) } });
  assert.equal(refused.results["2"].flaggedNonTarget, true);
  assert.ok(refused.calls.some((c) => c.startsWith("error ") && c.includes("Failed to auto-flag non-target 2")));
  const threw = await run({ ...setup, ports: { postSequenceFlags: async () => { throw new Error("socket hang up"); } } });
  assert.equal(threw.results["2"].flaggedNonTarget, true);
  assert.ok(threw.calls.some((c) => c.includes("Error auto-flagging non-target 2")));
});

// ── cross-sequence confidence dominance ──

test("one species at 70% or more and every other name under 30%: the other names are non-target", async () => {
  const { results, store, calls } = await run({
    reads: [read("1", 20), read("2", 20), read("3", 20)],
    results: { "1": summary("1", "Russula emetica", 85), "2": summary("2", "Mycena galericulata", 20), "3": summary("3", "Inocybe geophylla", 25) },
    saved: { "1": saved("Russula emetica", 85), "2": saved("Mycena galericulata", 20), "3": saved("Inocybe geophylla", 25) },
  });
  for (const id of ["2", "3"]) {
    assert.equal(results[id].flaggedNonTarget, true, id);
    assert.deepEqual(steps(store, id), ["Cross-Sequence Confidence Dominance:fail"]);
    assert.ok(calls.includes(`flags ${id} flags[contaminant]=1`));
  }
  assert.equal(results["1"].flaggedNonTarget, false);
});

test("a species at exactly 70% is high enough to dominate", async () => {
  const { results } = await run({
    reads: [read("1", 20), read("2", 20)],
    results: { "1": summary("1", "Russula emetica", 70), "2": summary("2", "Mycena galericulata", 29) },
    saved: { "1": saved("Russula emetica", 70), "2": saved("Mycena galericulata", 29) },
  });
  assert.equal(results["2"].flaggedNonTarget, true);
});

test("confidence dominance holds back when another name reaches 30%, when two names reach 70%, or a confidence is unknown", async () => {
  for (const [second, third] of [[20, 35], [75, 20], [20, null]] as const) {
    const { results } = await run({
      reads: [read("1", 20), read("2", 20), read("3", 20)],
      results: { "1": summary("1", "Russula emetica", 85), "2": summary("2", "Mycena galericulata", second), "3": summary("3", "Inocybe geophylla", third) },
      saved: { "1": saved("Russula emetica", 85), "2": saved("Mycena galericulata", second), "3": saved("Inocybe geophylla", third) },
    });
    assert.ok(!results["2"].flaggedNonTarget && !results["3"].flaggedNonTarget, `${second} / ${third}`);
  }
});

// ── the kingdom / phylum / class override ──

test("a record named only Fungi whose reads all come to one species, one at 70% or more, gets that species instead of manual validation", async () => {
  const { results, store } = await run({
    reads: [read("1", 20, "Fungi"), read("2", 20, "Fungi")],
    results: { "1": summary("1", "Manual Validation Needed", null), "2": summary("2", "Manual Validation Needed", null) },
    saved: {
      "1": saved("Manual Validation Needed", null, { provisionalFinalSpecies: "Russula emetica", provisionalFinalConfidence: 75 }),
      "2": saved("Manual Validation Needed", null, { provisionalFinalSpecies: "Russula emetica", provisionalFinalConfidence: 60 }),
    },
  });
  assert.deepEqual([results["1"].finalSpecies, results["1"].finalConfidence], ["Russula emetica", 75]);
  assert.deepEqual([results["2"].finalSpecies, results["2"].finalConfidence], ["Russula emetica", 60]);
  assert.deepEqual(steps(store, "1"), ["Kingdom/Phylum Override:pass"]);
});

test("the override holds back for a record named below class, for reads that disagree, and with no read at 70%", async () => {
  const cases: Array<[string, string, number, string, number]> = [
    ["Russula", "Russula emetica", 75, "Russula emetica", 60],
    ["Basidiomycota", "Russula emetica", 75, "Russula nobilis", 60],
    ["Agaricomycetes", "Russula emetica", 65, "Russula emetica", 60],
  ];
  for (const [source, a, ca, b, cb] of cases) {
    const { results } = await run({
      reads: [read("1", 20, source), read("2", 20, source)],
      results: { "1": summary("1", "Manual Validation Needed", null), "2": summary("2", "Manual Validation Needed", null) },
      saved: {
        "1": saved("Manual Validation Needed", null, { provisionalFinalSpecies: a, provisionalFinalConfidence: ca }),
        "2": saved("Manual Validation Needed", null, { provisionalFinalSpecies: b, provisionalFinalConfidence: cb }),
      },
    });
    assert.equal(results["1"].finalSpecies, "Manual Validation Needed", source);
  }
});

// ── no BLAST hits ──

test("a read with no BLAST hits beside a read with a result is non-target: no BLAST hits", async () => {
  const { results, store, calls } = await run({
    reads: [read("1", 20), read("2", 4)],
    results: { "1": summary("1", "Russula emetica", 85), "2": summary("2", null, null, { status: "error" }) },
    saved: { "1": saved("Russula emetica", 85), "2": saved(null, null, { noBlastHits: true }) },
  });
  assert.deepEqual([results["2"].flaggedNonTarget, results["2"].finalSpecies, results["2"].status], [true, "Non-Target: No BLAST hits", "complete"]);
  assert.deepEqual(steps(store, "2"), ["Cross-Sequence Non-Target Detection:fail"]);
  assert.ok(calls.includes("flags 2 flags[contaminant]=1"));
  // Only reads with no hits: nothing to compare them with.
  const none = await run({
    reads: [read("2", 4), read("3", 6)],
    results: { "2": summary("2", null, null), "3": summary("3", null, null) },
    saved: { "2": saved(null, null, { noBlastHits: true }), "3": saved(null, null, { noBlastHits: true }) },
  });
  assert.ok(!none.results["2"].flaggedNonTarget && !none.results["3"].flaggedNonTarget);
  // Alone on its record: nothing to compare it with.
  const alone = await run({ reads: [read("2", 4)], results: { "2": summary("2", null, null) }, saved: { "2": saved(null, null, { noBlastHits: true }) } });
  assert.equal(alone.results["2"].flaggedNonTarget, false);
});

// ── the run ──

test("the passes go record by record and in order: a read set aside by one pass is no longer weighed by the next", async () => {
  // Read 2 is set aside as non-target by family; then the dominance pass sees only reads 1 and 3.
  const { results, store } = await run({
    reads: [read("1", 25), read("2", 5), read("3", 20), read("9", 20, "Russula emetica", "obs-2")],
    results: { "1": summary("1", "Russula emetica", 85), "2": summary("2", "Mycena galericulata", 10), "3": summary("3", "Russula emetica", 40), "9": summary("9", "Russula emetica", 90) },
    saved: { "1": saved("Russula emetica", 85, {}, "pass"), "2": saved("Mycena galericulata", 10, {}, "fail"), "3": saved("Russula emetica", 40, {}, "pass"), "9": saved("Russula emetica", 90) },
  });
  assert.equal(results["2"].flaggedNonTarget, true);
  assert.deepEqual(steps(store, "2"), ["Source Record Comparison:fail", "Cross-Sequence Non-Target Detection:fail"], "once, not again by dominance");
  assert.equal(results["9"].flaggedNonTarget, false, "another record is weighed on its own");
});

test("a run that is being stopped stops before the next record, and nothing more is written", async () => {
  let checks = 0;
  const calls: string[] = [];
  await assert.rejects(runCrossReadPasses({
    jobId: "job-1",
    results: { "1": summary("1", "Russula emetica", 85), "2": summary("2", "Mycena galericulata", 40) },
    reads: [read("1", 25), read("2", 5)],
    canFlagSequences: true,
  }, {
    checkAborted: () => { checks++; throw new Error("shutting down"); },
    loadSavedResults: async () => { calls.push("load"); return []; },
    saveResult: async () => { calls.push("save"); },
    postSequenceFlags: async () => { calls.push("flags"); return { ok: true, status: 200, text: async () => "" }; },
    strayReadAmpliconOf: () => async () => null,
    strayReadHits: async () => null,
    info: () => {}, warn: () => {}, error: () => {},
  }), /shutting down/);
  assert.equal(checks, 1);
  assert.deepEqual(calls, []);
});

test("the stray-read pass asks the job for a record's primers and a read's hits, with that record's reads", async () => {
  const asked: string[] = [];
  await run({
    reads: [read("1", 20), read("2", 20), read("3", 20), read("9", 20, "Russula emetica", "obs-2")],
    results: { "1": summary("1", "Russula emetica", 90), "2": summary("2", "Russula emetica", 80), "3": summary("3", "", 0, { barcodeGapNeeded: true }), "9": summary("9", "Russula emetica", 70) },
    saved: { "1": saved("Russula emetica", 90), "2": saved("Russula emetica", 80), "3": saved("", 0), "9": saved("Russula emetica", 70) },
    ports: {
      strayReadAmpliconOf: (obsId, recordReads) => { asked.push(`primers ${obsId} [${recordReads.map((r) => r.id).join(",")}]`); return async () => "ITS1F/ITS4"; },
      strayReadHits: async (sequenceId, recordReads) => { asked.push(`hits ${sequenceId} [${recordReads.map((r) => r.id).join(",")}]`); return null; },
    },
  });
  // Each record is handed only its own reads (the lookup is made for every record; a record of one read asks nothing of it).
  assert.deepEqual(asked, ["primers obs-1 [1,2,3]", "hits 3 [1,2,3]", "primers obs-2 [9]"]);
});
