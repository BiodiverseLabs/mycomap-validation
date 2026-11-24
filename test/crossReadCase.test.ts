/**
 * Cross-read cases (crossReadCase.ts): one record's cross-read passes written down as they run, and run
 * again from what was written down. Stand-ins only: no database, no network.
 * Every scenario of crossReadPasses.test.ts is also recorded and replayed there.
 *
 *   node --import tsx --test src/services/crossReadCase.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AnalysisReplayMiss, firstDifference } from "../src/analysisCase";
import { buildCrossReadCase, caseRead, crossReadCaseArgs, logLine, portsFromCrossReadCase, recordingCrossReadPorts, replayCrossReadCase, type CrossReadCase } from "../src/crossReadCase";
import { runCrossReadPasses, type CrossReadPassesInput, type CrossReadPassesPorts, type CrossReadSequence } from "../src/crossReadPasses";
import type { AnalysisJobResult } from "../src/analysisJobResult";

const read = (id: string, ric: number | null, over: Partial<CrossReadSequence> = {}): CrossReadSequence =>
  ({ id, observationId: "obs-1", ric, scientificName: "Russula emetica", localBlastXml: `s3://bucket/seq${id}-Local-BLAST.xml`, ncbiBlastXml: `s3://bucket/seq${id}-NCBI-BLAST.xml`, ...over });
const summary = (id: string, finalSpecies: string | null, finalConfidence: number | null): AnalysisJobResult =>
  ({ sequenceId: id, status: "complete", finalSpecies, finalConfidence, flaggedContaminant: false, flaggedNonTarget: false });
const saved = (finalSpecies: string, finalConfidence: number, family: "pass" | "fail") =>
  ({ status: "complete", finalSpecies, finalConfidence, steps: [{ step: "Source Record Comparison", status: family, message: "", details: [] }] });

/** A record where the first pass sets read 2 aside: something is read, saved and flagged. */
function setup() {
  const store: Record<string, any> = { "1": saved("Russula emetica", 85, "pass"), "2": saved("Mycena galericulata", 40, "fail") };
  const seen: string[] = [];
  const ports: CrossReadPassesPorts = {
    checkAborted: () => { seen.push("checkAborted"); },
    loadSavedResults: async (ids) => { seen.push(`load ${ids.join(",")}`); return ids.filter((id) => store[id]).map((id) => ({ sampleId: id, resultData: JSON.parse(JSON.stringify(store[id])) })); },
    saveResult: async (id, result) => { seen.push(`save ${id}`); store[id] = JSON.parse(JSON.stringify(result)); },
    postSequenceFlags: async (id, body) => { seen.push(`flags ${id} ${body}`); return { ok: false, status: 503, text: async () => "busy" }; },
    strayReadAmpliconOf: () => async () => null,
    strayReadHits: async () => null,
    info: (...args) => { seen.push(`info ${logLine(args)}`); },
    warn: () => {},
    error: (...args) => { seen.push(`error ${logLine(args)}`); },
  };
  const input: CrossReadPassesInput = {
    jobId: "job-1",
    results: { "1": summary("1", "Russula emetica", 85), "2": summary("2", "Mycena galericulata", 40), "7": summary("7", "Amanita muscaria", 90) },
    reads: [read("1", 25), read("2", 5)],
    canFlagSequences: true,
  };
  return { store, seen, ports, input };
}

async function record() {
  const { ports, input, seen, store } = setup();
  const args = crossReadCaseArgs(input);
  const recording = recordingCrossReadPorts(ports);
  await runCrossReadPasses(input, recording.ports);
  const built = buildCrossReadCase({ args, resultsAfter: input.results, recorded: recording.recorded(), rulesVersion: "1.4", capturedAt: "2026-11-17T12:00:00.000Z" });
  return { recorded: JSON.parse(JSON.stringify(built)) as CrossReadCase, seen, store, input };
}

test("recording changes nothing: the passes get each port's own answer, and the ports still do their work", async () => {
  const plain = setup();
  await runCrossReadPasses(plain.input, plain.ports);
  const listened = setup();
  await runCrossReadPasses(listened.input, recordingCrossReadPorts(listened.ports).ports);
  assert.deepEqual(listened.seen, plain.seen, "the same calls, in the same order, with the same log lines");
  assert.equal(firstDifference(listened.store, plain.store), null, "the same saves");
  assert.equal(firstDifference(listened.input.results, plain.input.results), null, "the same summaries");
  // A port's failure reaches the passes as it is.
  const failure = new Error("database down");
  const broken = setup();
  broken.ports.loadSavedResults = async () => { throw failure; };
  await assert.rejects(runCrossReadPasses(broken.input, recordingCrossReadPorts(broken.ports).ports), (error) => error === failure);
});

test("a case keeps the record's reads without where their BLAST files are, and only that record's summaries", async () => {
  const { recorded } = await record();
  assert.deepEqual(recorded.args.reads.map((r) => [r.id, r.hasLocalXml, r.hasNcbiXml]), [["1", true, true], ["2", true, true]]);
  assert.doesNotMatch(JSON.stringify(recorded), /s3:\/\/|BLAST\.xml/, "no file address anywhere in the case");
  assert.deepEqual(Object.keys(recorded.args.results).sort(), ["1", "2"], "read 7 belongs to another record");
  assert.deepEqual(Object.keys(recorded.result.results).sort(), ["1", "2"]);
  assert.equal(recorded.args.results["2"].flaggedNonTarget, false, "as given, before the passes");
  assert.equal(recorded.result.results["2"].flaggedNonTarget, true, "as they left it");
  assert.deepEqual(caseRead(read("9", 3, { localBlastXml: undefined })), { id: "9", observationId: "obs-1", ric: 3, scientificName: "Russula emetica", hasLocalXml: false, hasNcbiXml: true });
});

test("what is written down: the saved analyses read, the saves and flags in order, the record store's answer, and the log", async () => {
  const { recorded } = await record();
  // The non-target pass reads both; the no-BLAST-hits pass then reads read 1 only (read 2 was set aside).
  assert.deepEqual(recorded.calls.loadSavedResults.map((c) => c.asked), ['[["1","2"]]', '[["1"]]']);
  assert.deepEqual(recorded.result.effects.map((e) => e.port), ["saveResult", "postSequenceFlags"]);
  assert.match(recorded.result.effects[0].asked, /^\["2",\{.*"finalSpecies":"Non-Target: Mycena galericulata"/);
  assert.equal(recorded.result.effects[1].asked, '["2","flags[contaminant]=1"]');
  // The record store's answer, its text included, so a replay gives the passes the same.
  assert.deepEqual(recorded.calls.postSequenceFlags, [{ asked: '["2","flags[contaminant]=1"]', answer: { value: { ok: false, status: 503, text: "busy" } } }]);
  assert.ok(recorded.result.log.some((l) => l.to === "error" && l.line.includes("Failed to auto-flag non-target 2: busy")));
  assert.ok(!("checkAborted" in recorded.calls), "the job's stop is not kept");
});

test("run again from its case alone, the passes come to the same, and every kept answer is asked for", async () => {
  const { recorded } = await record();
  const again = await replayCrossReadCase(recorded);
  assert.equal(firstDifference(recorded.result, again.result), null);
  assert.deepEqual(again.unused, []);
});

test("a replay shows when the passes or the answers are not the recorded ones", async () => {
  const { recorded } = await record();
  // Passes that also set read 1 aside.
  const other = await replayCrossReadCase(recorded, async (input, ports) => {
    await runCrossReadPasses(input, ports);
    input.results["1"].flaggedNonTarget = true;
  });
  assert.equal(firstDifference(recorded.result, other.result), "results.1.flaggedNonTarget: false vs true");
  // Passes that flag one more sequence: the flags' answer is not in the case.
  await assert.rejects(replayCrossReadCase(recorded, async (input, ports) => {
    await runCrossReadPasses(input, ports);
    await ports.postSequenceFlags("1", "flags[low]=0");
  }), (error) => error instanceof AnalysisReplayMiss && error.door === "postSequenceFlags");
  // A save more.
  const extra = await replayCrossReadCase(recorded, async (input, ports) => {
    await runCrossReadPasses(input, ports);
    await ports.saveResult("1", { steps: [] } as any);
  });
  assert.match(firstDifference(recorded.result, extra.result) ?? "", /^effects: 2 items vs 3$/);
  // The saved analyses changed in the case (read 2 now matches the family): the passes take another way, and the
  // replay stops at the first question the case cannot answer.
  const edited = JSON.parse(JSON.stringify(recorded)) as CrossReadCase;
  (edited.calls.loadSavedResults[0].answer as any).value[1].resultData.steps[0].status = "pass";
  await assert.rejects(replayCrossReadCase(edited), (error) => error instanceof AnalysisReplayMiss && error.door === "loadSavedResults");
});

test("a replay reports only the record's own reads, whatever else the case's summaries hold", async () => {
  const { recorded } = await record();
  const padded = JSON.parse(JSON.stringify(recorded)) as CrossReadCase;
  padded.args.results["7"] = { sequenceId: "7", status: "complete", finalSpecies: "Amanita muscaria", finalConfidence: 90 };
  const again = await replayCrossReadCase(padded);
  assert.deepEqual(Object.keys(again.result.results).sort(), ["1", "2"]);
  assert.equal(firstDifference(recorded.result, again.result), null);
});

test("a replay reaches nothing: a question the case does not hold, or asked differently, stops it", async () => {
  const { ports, unused, effects, log } = portsFromCrossReadCase({
    loadSavedResults: [{ asked: '[["1","2"]]', answer: { value: [] } }],
    strayReadHits: [{ asked: '["3",["1","2","3"]]', answer: { threw: "S3 timeout" } }],
    strayReadAmplicon: [{ asked: '["obs-1","3"]', answer: { value: "ITS1F/ITS4" } }],
  });
  // Asked something else than the case holds at this point: no answer, even though one is kept.
  const differently = portsFromCrossReadCase({ loadSavedResults: [{ asked: '[["1","2"]]', answer: { value: [] } }] });
  await assert.rejects(differently.ports.loadSavedResults(["9"]), (error) => error instanceof AnalysisReplayMiss && /the case holds an answer to/.test(error.asked));
  assert.deepEqual(await ports.loadSavedResults(["1", "2"]), []);
  await assert.rejects(ports.loadSavedResults(["1"]), AnalysisReplayMiss);
  await assert.rejects(ports.strayReadHits("3", [read("1", 1), read("2", 1), read("3", 1)]), /S3 timeout/, "a kept failure fails again");
  assert.equal(await ports.strayReadAmpliconOf("obs-1", [])("3"), "ITS1F/ITS4");
  await assert.rejects(ports.strayReadAmpliconOf("obs-2", [])("3"), (error) => error instanceof AnalysisReplayMiss && error.door === "strayReadAmplicon");
  assert.equal(await ports.saveResult("1", { steps: [] } as any), undefined, "a save is done nowhere");
  ports.checkAborted();
  ports.warn("careful", new Error("why"), { a: 1 });
  assert.deepEqual(effects(), [{ port: "saveResult", asked: '["1",{"steps":[]}]' }]);
  assert.deepEqual(log(), [{ to: "warn", line: 'careful Error: why {"a":1}' }]);
  const spare = portsFromCrossReadCase({ loadSavedResults: [{ asked: '[["9"]]', answer: { value: [] } }] });
  assert.deepEqual(spare.unused(), ['loadSavedResults [["9"]]']);
  void unused;
});

test("an answer is kept as it was given: the passes changing it afterwards change neither the case nor the next answer", async () => {
  const rows = [{ sampleId: "1", resultData: { finalSpecies: "Russula emetica", steps: [] } }];
  const recording = recordingCrossReadPorts({ ...setup().ports, loadSavedResults: async () => rows });
  const got = await recording.ports.loadSavedResults(["1"]);
  (got[0].resultData as any).finalSpecies = "changed";
  assert.deepEqual(recording.recorded().calls.loadSavedResults[0].answer, { value: [{ sampleId: "1", resultData: { finalSpecies: "Russula emetica", steps: [] } }] });
  const keptCalls = { loadSavedResults: [{ asked: '[["1"]]', answer: { value: [{ sampleId: "1", resultData: { finalSpecies: "Russula emetica", steps: [] } }] } }] };
  const replay = portsFromCrossReadCase(keptCalls);
  const first = await replay.ports.loadSavedResults(["1"]);
  (first[0].resultData as any).finalSpecies = "changed";
  assert.equal((keptCalls.loadSavedResults[0].answer.value[0].resultData as any).finalSpecies, "Russula emetica", "a replayed answer is a copy");
  // An answer that can't be written down marks the recording incomplete.
  const loop: any = {};
  loop.self = loop;
  const broken = recordingCrossReadPorts({ ...setup().ports, loadSavedResults: async () => [{ sampleId: "1", resultData: loop }] });
  await broken.ports.loadSavedResults(["1"]);
  assert.match(broken.recorded().incomplete ?? "", /^loadSavedResults answer: /);
});

test("the case code is the engine's and needs nothing of the server", () => {
  const own = readFileSync(new URL("../src/crossReadCase.ts", import.meta.url), "utf8");
  const imports = [...own.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./analysisCase", "./crossReadPasses", "./analysisJobResult"]);
  assert.match(own, /^import type \{ AnalysisJobResult \} from "\.\/analysisJobResult";$/m, "a type only");
});
