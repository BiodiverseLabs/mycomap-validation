/**
 * Record cases (recordCase.ts): a record's decision written down as it is made, and made again from
 * what was written down. Stand-ins only: no database, no network.
 *
 * Every scenario of recordDecision.test.ts is also recorded and replayed
 * there; this file is about the recording and the replay themselves.
 *
 *   node --import tsx --test src/services/recordCase.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AnalysisReplayMiss, firstDifference } from "../src/analysisCase";
import { buildRecordCase, portsFromRecordCase, recordingPorts, replayRecordCase, RECORD_QUESTION_PORTS, RECORD_WRITE_PORTS, type RecordCase } from "../src/recordCase";
import { decideRecord, type RecordDecision, type RecordDecisionInput, type RecordDecisionPorts } from "../src/recordDecision";
import type { VisionAgreementVision } from "../src/visionAgreement";

const SPECIES = "Picipes tubaeformis";
const vision = (over: Partial<VisionAgreementVision> = {}): VisionAgreementVision => ({
  runId: 7, modelVersion: "m1", answersVersion: "a1", gateVerdict: "fungus",
  species: [{ name: SPECIES, confidence: 0.99 }, { name: "Picipes badius", confidence: 0.005 }],
  genus: [{ name: "Picipes", confidence: 0.995 }],
  ...over,
});
const input = (over: Partial<RecordDecisionInput> = {}): RecordDecisionInput => ({
  platform: "inat", observationId: "9001", sequenceIds: ["501"],
  analysisResults: { "501": { status: "complete", finalSpecies: SPECIES, finalConfidence: 85, flaggedContaminant: false, flaggedNonTarget: false } },
  sequenceMetadata: { "501": { ricScore: 5 } },
  ...over,
});
/** Stand-in ports for a record that validates: BLAST in, Vision agrees. `seen` is what reached them. */
function livePorts(over: Partial<RecordDecisionPorts> = {}) {
  const seen: string[] = [];
  const ports: RecordDecisionPorts = {
    ncbiReadiness: async () => ({ ready: true, listed: true, sequences: [], waiting: [], exempt: [] }),
    noteNcbiWait: async (sequences) => { seen.push(`noteNcbiWait ${sequences.length}`); },
    clearNcbiWait: async () => { seen.push("clearNcbiWait"); },
    waitForVision: async () => ({ vision: vision(), waitedMs: 1200, timedOut: false }),
    settleReads: async () => ({ trashed: [], visionMissing: false, kept: [], pickedFlagged: null, pickState: null }),
    visionFoundNoPhotos: async () => false,
    latestVisionAnswer: async () => vision(),
    recordVisionEvents: async (events) => { seen.push(`recordVisionEvents ${events.map((e) => e.kind).join(",")}`); },
    recordVisionHold: async (decision) => { seen.push(`recordVisionHold ${decision.outcome}`); },
    loadDnaFamily: async () => "Polyporaceae",
    loadObserverIdentification: async () => null,
    loadStoredAnalyses: async () => ({}),
    fetchRic: async () => ({ ok: true, status: 200, rics: [] }),
    jobLog: (line) => { seen.push(`jobLog ${line}`); },
    info: (line) => { seen.push(`info ${line}`); },
    warn: (line) => { seen.push(`warn ${line}`); },
    ...over,
  };
  return { ports, seen };
}

async function record(given: RecordDecisionInput, ports: RecordDecisionPorts): Promise<{ decision: RecordDecision; recorded: RecordCase }> {
  const args = JSON.parse(JSON.stringify(given)) as RecordDecisionInput;
  const recording = recordingPorts(ports);
  const decision = await decideRecord(given, recording.ports);
  const built = buildRecordCase({ args, decision, recorded: recording.recorded(), rulesVersion: "1.4", capturedAt: "2026-11-16T20:00:00.000Z" });
  // As it comes back from the table: through JSON.
  return { decision, recorded: JSON.parse(JSON.stringify(built)) as RecordCase };
}

test("recording changes nothing: the decision gets each port's own answer and failure, and the ports get what the decision handed them", async () => {
  const answer = { vision: vision(), waitedMs: 5, timedOut: false };
  const failure = new Error("observer could not be read");
  const handed: unknown[][] = [];
  const { ports, seen } = livePorts({
    waitForVision: async () => answer,
    loadObserverIdentification: async () => { throw failure; },
    loadDnaFamily: async (...args) => { handed.push(args); return "Polyporaceae"; },
  });
  const recording = recordingPorts(ports);
  assert.equal(await recording.ports.waitForVision(), answer, "the very object, not a copy");
  await assert.rejects(recording.ports.loadObserverIdentification(), (error) => error === failure, "the very error");
  assert.equal(await recording.ports.loadDnaFamily(SPECIES), "Polyporaceae");
  assert.deepEqual(handed, [[SPECIES]]);
  recording.ports.jobLog("a line");
  recording.ports.warn("careful");
  await recording.ports.clearNcbiWait();
  assert.deepEqual(seen, ["jobLog a line", "warn careful", "clearNcbiWait"], "logs and writes still happen");

  // With and without recording the same record comes to the same decision.
  const plain = await decideRecord(input(), livePorts().ports);
  const listened = await decideRecord(input(), recordingPorts(livePorts().ports).ports);
  assert.equal(firstDifference(plain, listened), null);
  assert.equal(plain.kind, "validate");
});

test("what is written down: each port's answers in the order asked, the writes in order, and the log lines", async () => {
  let asked = 0;
  const { ports } = livePorts({ latestVisionAnswer: async () => (++asked === 1 ? null : vision()) });
  const recording = recordingPorts(ports);
  assert.equal(await recording.ports.latestVisionAnswer(), null);
  assert.equal((await recording.ports.latestVisionAnswer())?.runId, 7);
  await recording.ports.loadStoredAnalyses(["501", "502"]);
  await recording.ports.noteNcbiWait([{ id: "501", why: "no_ncbi", detail: "NCBI BLAST has not run" }]);
  await recording.ports.recordVisionEvents([{ kind: "dna_validated" } as any]);
  await recording.ports.clearNcbiWait();
  recording.ports.info("one");
  recording.ports.jobLog("two");
  const written = recording.recorded();
  assert.equal(written.incomplete, null);
  assert.deepEqual(written.calls.latestVisionAnswer.map((c) => (c.answer as any).value?.runId ?? null), [null, 7], "the same question, answered differently, kept in order");
  assert.deepEqual(written.calls.loadStoredAnalyses, [{ asked: '[["501","502"]]', answer: { value: {} } }]);
  assert.deepEqual(written.effects, [
    { port: "noteNcbiWait", asked: '[[{"detail":"NCBI BLAST has not run","id":"501","why":"no_ncbi"}]]' },
    { port: "recordVisionEvents", asked: '[[{"kind":"dna_validated"}]]' },
    { port: "clearNcbiWait", asked: "[]" },
  ]);
  assert.deepEqual(written.log, [{ to: "info", line: "one" }, { to: "job", line: "two" }]);
});

test("an answer is kept as it was when given: the decision changing it afterwards does not change the case", async () => {
  const stored = { "501": { finalSpecies: SPECIES } };
  const recording = recordingPorts(livePorts({ loadStoredAnalyses: async () => stored }).ports);
  const got = await recording.ports.loadStoredAnalyses(["501"]);
  got["501"].finalSpecies = "changed afterwards";
  assert.deepEqual(recording.recorded().calls.loadStoredAnalyses[0].answer, { value: { "501": { finalSpecies: SPECIES } } });
});

test("an answer that can't be written down marks the recording incomplete and still reaches the decision", async () => {
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  const recording = recordingPorts(livePorts({ loadStoredAnalyses: async () => loop as any }).ports);
  assert.equal(await recording.ports.loadStoredAnalyses(["1"]), loop);
  assert.match(recording.recorded().incomplete ?? "", /^loadStoredAnalyses answer: /);
  const big = recordingPorts(livePorts({ fetchRic: async () => ({ ok: true, status: 200, rics: [{ id: "1", ric: 5n as any, possiblySanger: false }] }) }).ports);
  await big.ports.fetchRic(["1"]);
  assert.match(big.recorded().incomplete ?? "", /^fetchRic answer: /);
});

test("a recorded decision, made again from its case alone, comes to the same decision, the same writes and the same log lines", async () => {
  const { recorded, decision } = await record(input(), livePorts().ports);
  assert.equal(decision.kind, "validate");
  assert.equal(recorded.format, 1);
  assert.equal(recorded.rulesVersion, "1.4");
  assert.deepEqual(recorded.args, input());
  const again = await replayRecordCase(recorded);
  assert.equal(firstDifference(recorded.result, again.result), null);
  assert.equal(again.result.decision.kind, "validate");
  assert.ok(again.result.log.length > 0, "the log lines are part of what is compared");
  assert.deepEqual(again.unused, [], "every kept answer was asked for");

  // A record left for a person, with a port that failed: the failure is kept and happens again.
  const held = await record(input(), livePorts({
    waitForVision: async () => ({ vision: vision({ species: [{ name: "Russula emetica", confidence: 0.97 }], genus: [{ name: "Russula", confidence: 0.98 }] }), waitedMs: 0, timedOut: false }),
    latestVisionAnswer: async () => null,
    recordVisionHold: async () => { throw new Error("hold not saved"); },
  }).ports);
  assert.equal(held.decision.kind, "stop");
  assert.deepEqual(held.recorded.calls.recordVisionHold.map((c) => c.answer), [{ threw: "hold not saved" }]);
  const heldAgain = await replayRecordCase(held.recorded);
  assert.equal(firstDifference(held.recorded.result, heldAgain.result), null);
});

test("a replay shows when the rules or the answers are not the recorded ones", async () => {
  const { recorded } = await record(input(), livePorts().ports);
  // The same case under a decision that answers differently: the difference is found and named.
  const other = await replayRecordCase(recorded, async (given, ports) => {
    const decision = await decideRecord(given, ports);
    return decision.kind === "validate" ? { ...decision, species: "Picipes badius" } : decision;
  });
  assert.equal(firstDifference(recorded.result, other.result), 'decision.species: "Picipes tubaeformis" vs "Picipes badius"');
  // A decision that writes something the recorded one did not.
  const extra = await replayRecordCase(recorded, async (given, ports) => {
    const decision = await decideRecord(given, ports);
    await ports.noteNcbiWait([]);
    return decision;
  });
  assert.match(firstDifference(recorded.result, extra.result) ?? "", /^effects: \d+ items vs \d+$/);
  // A decision that says one more thing in the log.
  const chatty = await replayRecordCase(recorded, async (given, ports) => { ports.info("new line"); return decideRecord(given, ports); });
  assert.match(firstDifference(recorded.result, chatty.result) ?? "", /^log/);
  // The case's own answers changed (Vision now sure of another genus): the replay decides from them.
  const edited = JSON.parse(JSON.stringify(recorded)) as RecordCase;
  (edited.calls.waitForVision[0].answer as any).value.vision = vision({ species: [{ name: "Russula emetica", confidence: 0.97 }], genus: [{ name: "Russula", confidence: 0.98 }] });
  const changed = await replayRecordCase(edited);
  assert.notEqual(firstDifference(recorded.result, changed.result), null);
});

test("a replay never reaches outside: a question the case does not hold, or asked differently, stops it; a write is only written down", async () => {
  const { ports, effects, log, unused } = portsFromRecordCase({
    loadDnaFamily: [{ asked: '["Picipes tubaeformis"]', answer: { value: "Polyporaceae" } }, { asked: '["Russula emetica"]', answer: { value: "Russulaceae" } }],
    loadObserverIdentification: [{ asked: "[]", answer: { threw: "iNaturalist answered 502" } }],
    recordVisionHold: [{ asked: "ignored", answer: { threw: "hold not saved" } }],
  });
  assert.equal(await ports.loadDnaFamily(SPECIES), "Polyporaceae");
  await assert.rejects(ports.loadDnaFamily("Amanita muscaria"), (error) => error instanceof AnalysisReplayMiss && error.door === "loadDnaFamily", "asked differently than recorded");
  await assert.rejects(ports.loadDnaFamily("Russula emetica"), AnalysisReplayMiss, "nothing more is kept for this port");
  await assert.rejects(ports.waitForVision(), (error) => error instanceof AnalysisReplayMiss && error.door === "waitForVision", "a port the case never recorded");
  await assert.rejects(ports.loadObserverIdentification(), /iNaturalist answered 502/, "a kept failure fails again");

  // Writes: done nowhere, written down; one the case does not hold is not an error (the comparison shows it).
  assert.equal(await ports.clearNcbiWait(), undefined);
  assert.equal(await ports.recordVisionEvents([{ kind: "dna_validated" } as any]), undefined);
  ports.jobLog("line");
  assert.deepEqual(effects(), [{ port: "clearNcbiWait", asked: "[]" }, { port: "recordVisionEvents", asked: '[[{"kind":"dna_validated"}]]' }]);
  assert.deepEqual(log(), [{ to: "job", line: "line" }]);
  // The same question asked twice gets its two kept answers, in order; then nothing is left.
  const twice = portsFromRecordCase({ latestVisionAnswer: [{ asked: "[]", answer: { value: null } }, { asked: "[]", answer: { value: vision() } }] });
  assert.equal(await twice.ports.latestVisionAnswer(), null);
  assert.equal((await twice.ports.latestVisionAnswer())?.runId, 7);
  assert.deepEqual(twice.unused(), []);
  await assert.rejects(twice.ports.latestVisionAnswer(), AnalysisReplayMiss);
  // A kept answer never asked for is listed.
  const spare = portsFromRecordCase({ fetchRic: [{ asked: '[["501"]]', answer: { value: { ok: true, status: 200, rics: [] } } }] });
  assert.deepEqual(spare.unused(), ['fetchRic [["501"]]']);
});

test("a replayed answer is a copy: the decision changing it leaves the case as it was", async () => {
  const calls = { loadStoredAnalyses: [{ asked: '[["501"]]', answer: { value: { "501": { finalSpecies: SPECIES } } } }] };
  const { ports } = portsFromRecordCase(calls);
  const got = await ports.loadStoredAnalyses(["501"]);
  got["501"].finalSpecies = "changed";
  assert.deepEqual(calls.loadStoredAnalyses[0].answer, { value: { "501": { finalSpecies: SPECIES } } });
  // And the record it was given is a copy too.
  const { recorded } = await record(input(), livePorts().ports);
  await replayRecordCase(recorded, async (given, ports) => { given.sequenceIds.push("999"); return decideRecord(input(), ports); });
  assert.deepEqual(recorded.args.sequenceIds, ["501"]);
});

test("every port of the decision is either a question, a write or a log line, and the case code needs nothing of the server", () => {
  const engine = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const source = engine("recordDecision.ts");
  const ports = source.slice(source.indexOf("export interface RecordDecisionPorts {"), source.indexOf("/** What Vision's rule decided, for the run's results. */"));
  const names = [...ports.matchAll(/^  ([a-zA-Z]+)\(/gm)].map((m) => m[1]).sort();
  assert.deepEqual(names, [...RECORD_QUESTION_PORTS, ...RECORD_WRITE_PORTS, "jobLog", "info", "warn"].sort(), "a new port has to be given its kind in recordCase.ts");
  // It is in the validation engine with the decision: no database, no route, no service.
  const own = engine("recordCase.ts");
  const imports = [...own.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./analysisCase", "./recordDecision"]);
});
