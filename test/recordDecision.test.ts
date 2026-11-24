/**
 * What auto-validation decides about one record (recordDecision.ts;
 *: the deciding half of the job, run
 * here with stand-ins for everything it asks for. No database, no network.
 *
 *   node --import tsx --test src/services/recordDecision.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { firstDifference } from "../src/analysisCase";
import { decideRecord, type RecordDecisionInput, type RecordDecisionPorts, type RecordVisionEvent } from "../src/recordDecision";
import { buildRecordCase, recordingPorts, replayRecordCase, type RecordCase } from "../src/recordCase";
import type { VisionAgreementObserver, VisionAgreementVision } from "../src/visionAgreement";

const SPECIES = "Picipes tubaeformis";

const analysis = (over: Record<string, unknown> = {}) => ({
  status: "complete", finalSpecies: SPECIES, finalConfidence: 85, flaggedContaminant: false, flaggedNonTarget: false, ...over,
});

const vision = (over: Partial<VisionAgreementVision> = {}): VisionAgreementVision => ({
  runId: 7, modelVersion: "m1", answersVersion: "a1", gateVerdict: "fungus",
  species: [{ name: SPECIES, confidence: 0.99 }, { name: "Picipes badius", confidence: 0.005 }],
  genus: [{ name: "Picipes", confidence: 0.995 }],
  ...over,
});
/** Vision sure of another genus, showing nothing of the DNA's. */
const otherGenus = (): VisionAgreementVision => vision({
  species: [{ name: "Russula emetica", confidence: 0.97 }],
  genus: [{ name: "Russula", confidence: 0.98 }],
});
/** Vision answered, unsure of everything: no agreement, no veto, no second source. */
const unsure = (): VisionAgreementVision => vision({
  species: [{ name: "Russula emetica", confidence: 0.2 }, { name: "Amanita muscaria", confidence: 0.15 }],
  genus: [{ name: "Russula", confidence: 0.25 }, { name: "Amanita", confidence: 0.2 }],
});

type Setup = {
  platform?: string;
  sequences?: Record<string, Record<string, unknown> | null>;
  meta?: RecordDecisionInput["sequenceMetadata"];
  ports?: Partial<RecordDecisionPorts>;
  vision?: VisionAgreementVision | null;
  observer?: VisionAgreementObserver | null;
  noPhotos?: boolean;
};

async function decide(setup: Setup = {}) {
  const sequences = setup.sequences ?? { "501": analysis() };
  const ids = Object.keys(sequences);
  const input: RecordDecisionInput = {
    platform: setup.platform ?? "inat",
    observationId: "9001",
    sequenceIds: ids,
    analysisResults: Object.fromEntries(Object.entries(sequences).filter(([, a]) => a !== null)),
    sequenceMetadata: setup.meta ?? Object.fromEntries(ids.map((id) => [id, { ricScore: 5 }])),
  };
  const metaBefore = JSON.stringify(input.sequenceMetadata);
  const asked: string[] = [];
  const events: RecordVisionEvent[] = [];
  const holds: Array<{ outcome: string; event: RecordVisionEvent }> = [];
  const log: string[] = [];
  const ports: RecordDecisionPorts = {
    ncbiReadiness: async () => { asked.push("ncbiReadiness"); return { ready: true, listed: true, sequences: [], waiting: [], exempt: [] }; },
    noteNcbiWait: async () => { asked.push("noteNcbiWait"); },
    clearNcbiWait: async () => { asked.push("clearNcbiWait"); },
    waitForVision: async () => { asked.push("waitForVision"); return { vision: setup.vision === undefined ? vision() : setup.vision, waitedMs: 0, timedOut: false }; },
    settleReads: async () => { asked.push("settleReads"); return { trashed: [], visionMissing: false, kept: [], pickedFlagged: null, pickState: null }; },
    visionFoundNoPhotos: async () => { asked.push("visionFoundNoPhotos"); return !!setup.noPhotos; },
    latestVisionAnswer: async () => (setup.vision === undefined ? vision() : setup.vision),
    recordVisionEvents: async (list) => { events.push(...list); },
    recordVisionHold: async (decision, event) => { holds.push({ outcome: decision.outcome, event }); },
    loadDnaFamily: async () => "Polyporaceae",
    loadObserverIdentification: async () => { asked.push("loadObserverIdentification"); return setup.observer ?? null; },
    loadStoredAnalyses: async () => ({}),
    fetchRic: async (list) => { asked.push(`fetchRic ${list.join(",")}`); return { ok: true, status: 200, rics: [] }; },
    jobLog: (line) => { log.push(line); },
    info: () => {},
    warn: () => {},
    ...setup.ports,
  };
  // Every scenario in this file is also written down as a case and decided again from the case alone
  // (recordCase.ts): the same decision, the same writes, the same log lines.
  const given = JSON.parse(JSON.stringify(input)) as RecordDecisionInput;
  const recording = recordingPorts(ports);
  const decision = await decideRecord(input, recording.ports);
  assert.equal(JSON.stringify(input.sequenceMetadata), metaBefore, "the sequence metadata it was given is left as it was");
  const written = recording.recorded();
  assert.equal(written.incomplete, null, "everything it was answered can be written down");
  const kept = JSON.parse(JSON.stringify(buildRecordCase({ args: given, decision, recorded: written, rulesVersion: "test", capturedAt: "2026-11-16T00:00:00.000Z" }))) as RecordCase;
  const again = await replayRecordCase(kept);
  assert.equal(firstDifference(kept.result, again.result), null, "decided again from its case, it comes out the same");
  assert.deepEqual(again.unused, [], "and asks for every answer it was given");
  return { decision, asked, events, holds, log };
}

const stopOf = (d: Awaited<ReturnType<typeof decide>>["decision"]) => {
  assert.equal(d.kind, "stop", `expected a stop, got ${d.kind}`);
  return (d as Extract<typeof d, { kind: "stop" }>).result;
};
const validateOf = (d: Awaited<ReturnType<typeof decide>>["decision"]) => {
  assert.equal(d.kind, "validate", `expected a validation, got ${d.kind}${d.kind === "stop" ? `: ${d.result.error}` : ""}`);
  return d as Extract<typeof d, { kind: "validate" }>;
};
const kinds = (events: RecordVisionEvent[]) => events.map((e) => (e.reason ? `${e.kind}:${e.reason}` : e.kind));

test("the decision reaches nothing outside itself except through its ports", () => {
  // The decision itself is in the validation engine; recordDecision.ts only passes it on.
  const source = readFileSync(new URL("../src/recordDecision.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.ok(source.includes("export async function decideRecord("));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\bconsole\./, "it logs through its ports");
  assert.doesNotMatch(code, /(?<!ports\.)\bfetch\(/, "it calls no web address");
  assert.doesNotMatch(code, /\bpool\b|\bdb\.|@workspace\/db|from "pg"/, "it holds no database");
  assert.doesNotMatch(code, /process\.env|child_process|setTimeout/, "no environment, no process, no timer of its own");
  assert.doesNotMatch(code, /https?:\/\//, "it holds no web address");
});

test("a record whose BLAST results are not all in waits, and nothing else is asked or decided", async () => {
  const waiting = [{ id: "501", state: "waiting" as const, why: "ncbi_pending", detail: "NCBI results not in" }];
  const { decision, asked, events } = await decide({
    ports: { ncbiReadiness: async () => ({ ready: false, listed: true, sequences: waiting as any, waiting: waiting as any, exempt: [] }) },
  });
  const result = stopOf(decision);
  assert.equal(result.action, "skipped");
  assert.equal(result.success, true);
  assert.deepEqual(result.waitingForBlast, [{ id: "501", why: "ncbi_pending", detail: "NCBI results not in" }]);
  assert.match(result.error ?? "", /Waiting for BLAST results/);
  assert.deepEqual(asked, ["noteNcbiWait"], "it is put on the waiting list and Vision is not asked");
  assert.deepEqual(events, []);
});

test("a record with no sequences is rejected, once it is off the waiting list", async () => {
  const { decision, asked } = await decide({ sequences: {} });
  assert.equal(decision.kind, "reject");
  assert.equal(decision.kind === "reject" && decision.why, "no_sequences");
  assert.deepEqual(asked, ["ncbiReadiness", "clearNcbiWait"]);
});

test("a record with only contaminant sequences is rejected", async () => {
  const { decision, asked } = await decide({
    sequences: { "501": analysis({ flaggedContaminant: true }), "502": analysis({ finalSpecies: "Contaminant: Penicillium" }) },
  });
  assert.equal(decision.kind === "reject" && decision.why, "only_contaminants");
  assert.ok(!asked.includes("waitForVision"));
});

test("a contaminant beside a sequence not analysed yet waits; it is not rejected", async () => {
  const { decision } = await decide({ sequences: { "501": analysis({ flaggedContaminant: true }), "502": null } });
  const result = stopOf(decision);
  assert.equal(result.action, "skipped");
  assert.match(result.error ?? "", /Not every sequence has been analysed yet \(seq 502\); nothing was rejected/);
});

test("sequences that finished with no species name leave the record for a person, saying why per sequence", async () => {
  const { decision } = await decide({ sequences: { "501": analysis({ finalSpecies: null, finalConfidence: null }) } });
  const result = stopOf(decision);
  assert.match(result.error ?? "", /No sequences finished with a usable species name\. Per-sequence: seq 501: complete but no species determination/);
});

test("one species at 70% or more, a good read, and Vision as second source: validate as the DNA's species", async () => {
  const { decision, events, asked } = await decide({ sequences: { "501": analysis(), "502": analysis({ finalConfidence: 40 }) } });
  const v = validateOf(decision);
  assert.equal(v.species, SPECIES);
  assert.equal(v.selectedSequenceId, "501");
  assert.deepEqual(v.agreeingSequenceIds, [501, 502]);
  assert.equal(v.visionMakesIt, null, "the DNA made it by itself");
  assert.equal(v.secondSourceVision?.source, "vision_species");
  assert.deepEqual(kinds(events), ["second_source_vision"]);
  assert.deepEqual(v.markedNonTarget, []);
  assert.ok(!asked.includes("settleReads"), "reads that agree are not put to Vision to pick between");
});

test("until Vision has answered nothing is decided: the record waits for Vision", async () => {
  const { decision, events, holds } = await decide({ vision: null });
  const result = stopOf(decision);
  assert.equal(result.waitingForVision, true);
  assert.equal(result.visionPending, true);
  assert.deepEqual(kinds(events), ["vision_no_answer:waiting"]);
  assert.deepEqual(holds, []);
});

test("Vision found no usable photos: the observer's identification in the DNA genus is the second source", async () => {
  const { decision, events } = await decide({
    vision: null, noPhotos: true, observer: { name: "Picipes badius", source: "observer_identification" },
  });
  const v = validateOf(decision);
  assert.equal(v.secondSourceVision, null);
  assert.equal(v.secondSourceByObserver?.source, "observer_genus");
  assert.deepEqual(kinds(events), ["vision_no_answer:no_usable_photos", "second_source_observer"], "Vision is recorded as not answering, the observer as the second source");
});

test("no second source: a record at 70% or more is still held for a person, and the hold is recorded", async () => {
  const { decision, holds, events } = await decide({ vision: unsure(), observer: null });
  const result = stopOf(decision);
  assert.equal(result.action, "skipped");
  assert.match(result.error ?? "", /there is no identification from the observer/);
  assert.deepEqual(holds.map((h) => `${h.event.kind}:${h.event.reason}`), ["hold:no_second_source"]);
  assert.deepEqual(holds[0].event.sequenceIds, ["501"]);
  assert.deepEqual(events, [], "the hold carries its own event");
});

test("the observation's name is not the observer's identification: it is no second source", async () => {
  const { decision } = await decide({ vision: unsure(), observer: { name: "Picipes badius", source: "observation_name" } });
  assert.equal(stopOf(decision).action, "skipped");
});

test("Vision sure of another genus holds even a record at 70% or more", async () => {
  const { decision, holds } = await decide({ vision: otherGenus(), observer: null });
  const result = stopOf(decision);
  assert.equal(result.vision?.outcome, "vetoes");
  assert.deepEqual(holds.map((h) => `${h.outcome} ${h.event.kind}:${h.event.reason}`), ["vetoes hold:genus_veto"]);
});

test("the observer's identification in the DNA genus sets Vision's veto aside", async () => {
  const { decision, events, holds } = await decide({
    vision: otherGenus(), observer: { name: "Picipes sp.", source: "observer_identification" },
  });
  const v = validateOf(decision);
  assert.equal(v.species, SPECIES);
  assert.deepEqual(holds, []);
  assert.deepEqual(kinds(events), ["observer_over_vision", "second_source_observer"]);
});

test("below 70%, Vision's agreement makes the validation, as the DNA's species", async () => {
  const { decision, events } = await decide({ sequences: { "501": analysis({ finalConfidence: 55 }) } });
  const v = validateOf(decision);
  assert.equal(v.species, SPECIES);
  assert.equal(v.visionMakesIt?.outcome, "agrees");
  assert.equal(v.vision?.outcome, "agrees");
  assert.deepEqual(kinds(events), ["agreement_validated", "second_source_vision"]);
});

test("below 70% with nothing from Vision to lift it: left for a person, and recorded as not lifted", async () => {
  const { decision, events } = await decide({ sequences: { "501": analysis({ finalConfidence: 55 }) }, vision: unsure() });
  const result = stopOf(decision);
  assert.match(result.error ?? "", /none reach the 70% confidence threshold \(best: 55%/);
  assert.deepEqual(kinds(events), ["skipped_for_person:below_threshold_not_lifted"]);
});

test("reads that disagree go to Vision to pick; the read it sets aside is marked and the record goes on with the other", async () => {
  const { decision, asked } = await decide({
    sequences: { "501": analysis(), "502": analysis({ finalSpecies: "Trametes versicolor", finalConfidence: 90 }) },
    ports: { settleReads: async () => ({ trashed: [], visionMissing: false, kept: ["501"], pickedFlagged: null, pickState: "picked" }) },
  });
  const v = validateOf(decision);
  assert.equal(v.species, SPECIES);
  assert.equal(v.selectedSequenceId, "501");
  assert.deepEqual(v.markedNonTarget, ["502"]);
  assert.ok(asked.indexOf("waitForVision") >= 0);
});

test("a read Vision sent to the trash is marked too, and no longer counts", async () => {
  const { decision } = await decide({
    sequences: { "501": analysis(), "502": analysis({ finalSpecies: "Trametes versicolor", finalConfidence: 90 }) },
    ports: { settleReads: async () => ({ trashed: ["502"], visionMissing: false, kept: ["501"], pickedFlagged: null, pickState: "picked" }) },
  });
  const v = validateOf(decision);
  assert.deepEqual(v.markedNonTarget, ["502"]);
  assert.deepEqual(v.agreeingSequenceIds, [501]);
});

test("reads that disagree and Vision could not pick: a person decides, and that is recorded", async () => {
  const { decision, events } = await decide({
    sequences: { "501": analysis(), "502": analysis({ finalSpecies: "Trametes versicolor", finalConfidence: 90 }) },
    ports: { settleReads: async () => ({ trashed: [], visionMissing: false, kept: [], pickedFlagged: null, pickState: "no_pick" }) },
  });
  const result = stopOf(decision);
  assert.match(result.error ?? "", /^Sequences disagree on species: .*Manual review needed\.$/);
  assert.equal(result.waitingForVision, undefined);
  assert.deepEqual(kinds(events), ["skipped_for_person:no_read_pick"]);
});

test("reads that disagree before Vision has answered wait for Vision; nothing goes to a person yet", async () => {
  const { decision, events } = await decide({
    vision: null,
    sequences: { "501": analysis(), "502": analysis({ finalSpecies: "Trametes versicolor", finalConfidence: 90 }) },
    ports: { settleReads: async () => ({ trashed: [], visionMissing: true, kept: [], pickedFlagged: null, pickState: "no_answer" }) },
  });
  const result = stopOf(decision);
  assert.equal(result.waitingForVision, true);
  assert.equal(result.visionPending, true);
  assert.deepEqual(kinds(events), ["vision_no_answer:waiting"]);
});

test("Vision picking a read the analysis marked Non-Target sends the record to a person", async () => {
  const { decision, events } = await decide({
    sequences: { "501": analysis(), "502": analysis({ finalSpecies: "Non-Target: Trametes versicolor", flaggedNonTarget: true }) },
    ports: { settleReads: async () => ({ trashed: [], visionMissing: false, kept: ["502"], pickedFlagged: { name: "Trametes versicolor", sequenceIds: ["502"] }, pickState: "picked" }) },
  });
  const result = stopOf(decision);
  assert.match(result.error ?? "", /MycoMap Vision picked Trametes versicolor \(seq 502\), a read the analysis marked Non-Target/);
  assert.deepEqual(kinds(events), ["flagged_read_to_person"]);
  assert.deepEqual(events[0].sequenceIds, ["502"]);
});

test("a RiC score the job was not given is asked for, for exactly the sequences missing one", async () => {
  const { decision, asked } = await decide({
    sequences: { "501": analysis(), "502": analysis() },
    meta: { "501": { ricScore: null }, "502": { ricScore: 4 } },
    ports: { fetchRic: async (ids) => { asked_ric.push(...ids); return { ok: true, status: 200, rics: [{ id: "501", ric: 5, possiblySanger: false }] }; } },
  });
  assert.deepEqual(asked_ric, ["501"]);
  assert.equal(validateOf(decision).selectedSequenceId, "501");
  assert.ok(asked.length > 0);
});
const asked_ric: string[] = [];

test("no read at RiC 3 or more: left for a person, also when the scores could not be fetched", async () => {
  const low = await decide({ meta: { "501": { ricScore: 2 } } });
  assert.match(stopOf(low.decision).error ?? "", /none reach the RiC ≥ 3 threshold \(best: 2; seq 501: RiC 2\)/);

  const failed = await decide({ meta: { "501": {} }, ports: { fetchRic: async () => { throw new Error("the record store timed out"); } } });
  assert.match(stopOf(failed.decision).error ?? "", /none reach the RiC ≥ 3 threshold \(best: n\/a; seq 501: RiC n\/a\)/);
  assert.ok(failed.log.some((l) => /RiC fallback fetch error: the record store timed out/.test(l)));

  const refused = await decide({ meta: { "501": {} }, ports: { fetchRic: async () => ({ ok: false, status: 503, rics: [] }) } });
  assert.equal(stopOf(refused.decision).action, "skipped");
  assert.ok(refused.log.some((l) => /RiC fallback fetch failed \(HTTP 503\)/.test(l)));
});

// 2026-11-16: "Sanger only should not be held for a person." The record store sends a missing RiC as 0,
// so the page posts 0 for a Sanger read; the server's own reading says it is possibly Sanger.
test("a Sanger-only record is not held for its RiC once the server reads it as possibly Sanger", async () => {
  const asked: string[] = [];
  const { decision, log } = await decide({
    meta: { "501": { ricScore: 0 } },
    ports: { fetchRic: async (ids) => { asked.push(...ids); return { ok: true, status: 200, rics: [{ id: "501", ric: null, possiblySanger: true }] }; } },
  });
  assert.deepEqual(asked, ["501"], "a RiC that does not clear the rule is read again");
  const validated = validateOf(decision);
  assert.equal(validated.selectedSequenceId, "501");
  assert.ok(log.some((l) => /seq 501: possibly Sanger/.test(l)));
});

test("an ONT read and a Sanger read of the same species: the ONT read is pushed, the Sanger read qualifies too", async () => {
  const { decision } = await decide({
    sequences: { "501": analysis({ finalConfidence: 90 }), "502": analysis({ finalConfidence: 80 }) },
    meta: { "501": { ricScore: 0 }, "502": { ricScore: 12 } },
    ports: { fetchRic: async () => ({ ok: true, status: 200, rics: [{ id: "501", ric: null, possiblySanger: true }] }) },
  });
  const validated = validateOf(decision);
  assert.equal(validated.selectedSequenceId, "502");
  assert.deepEqual(validated.eligibleSequenceIds, ["502", "501"]);
});

test("a read the page calls possibly Sanger is read again even with a RiC, and pushed after the ONT reads", async () => {
  const asked: string[] = [];
  const { decision } = await decide({
    sequences: { "501": analysis({ finalConfidence: 90 }), "502": analysis({ finalConfidence: 80 }) },
    meta: { "501": { ricScore: 50, possiblySanger: true }, "502": { ricScore: 12 } },
    ports: { fetchRic: async (ids) => { asked.push(...ids); return { ok: true, status: 200, rics: [{ id: "501", ric: null, possiblySanger: true }] }; } },
  });
  assert.deepEqual(asked, ["501"]);
  const validated = validateOf(decision);
  assert.equal(validated.selectedSequenceId, "502", "the ONT read stands for the record");
  assert.deepEqual(validated.eligibleSequenceIds, ["502", "501"]);
});

test("the page's word alone never makes a read possibly Sanger", async () => {
  // The server reads an ONT read with RiC 1: held, whatever the page said.
  const ont = await decide({
    meta: { "501": { ricScore: null, possiblySanger: true } },
    ports: { fetchRic: async () => ({ ok: true, status: 200, rics: [{ id: "501", ric: 1, possiblySanger: false }] }) },
  });
  assert.match(stopOf(ont.decision).error ?? "", /none reach the RiC ≥ 3 threshold \(best: 1; seq 501: RiC 1\)/);
  // The reading fails: nothing is learnt, so the read is held.
  const failed = await decide({
    meta: { "501": { ricScore: null, possiblySanger: true } },
    ports: { fetchRic: async () => { throw new Error("the record store timed out"); } },
  });
  assert.equal(stopOf(failed.decision).action, "skipped");
  // The reading leaves the sequence out: judged by its RiC.
  const missing = await decide({
    meta: { "501": { ricScore: 0, possiblySanger: true } },
    ports: { fetchRic: async () => ({ ok: true, status: 200, rics: [] }) },
  });
  assert.equal(stopOf(missing.decision).action, "skipped");
});

test("a MyCoPortal record never asks Vision; a read marked as another organism holds it for a person", async () => {
  const clean = await decide({ platform: "mycoport" });
  assert.equal(validateOf(clean.decision).species, SPECIES);
  assert.ok(!clean.asked.includes("waitForVision") && !clean.asked.includes("settleReads") && !clean.asked.includes("loadObserverIdentification"));
  assert.deepEqual(clean.events, []);

  const flagged = await decide({
    platform: "mycoport",
    sequences: { "501": analysis(), "502": analysis({ finalSpecies: "Non-Target: Trametes versicolor", flaggedNonTarget: true }) },
  });
  assert.match(stopOf(flagged.decision).error ?? "", /MycoMap Vision does not check MyCoPortal records\. Held for a person\./);
  assert.ok(!flagged.asked.includes("settleReads"));
});

test("an eDNA sample never takes Vision or a second source", async () => {
  const { decision, asked, events } = await decide({ sequences: { "501": analysis({ ednaTempCode: "eDNA-OTU-12" }) } });
  assert.equal(validateOf(decision).species, SPECIES);
  assert.ok(!asked.includes("waitForVision") && !asked.includes("loadObserverIdentification"));
  assert.deepEqual(events, []);
});

test("a hold that cannot be saved does not change the decision", async () => {
  const { decision } = await decide({
    vision: otherGenus(), observer: null,
    ports: { recordVisionHold: async () => { throw new Error("database closed"); } },
  });
  assert.equal(stopOf(decision).vision?.outcome, "vetoes");
});

test("an iNaturalist copy stands for the record only when no own read qualifies", async () => {
  const both = await decide({
    sequences: { "501": analysis({ finalConfidence: 95 }), "502": analysis({ finalConfidence: 80 }) },
    meta: { "501": { ricScore: 0 }, "502": { ricScore: 0 } },
    ports: { fetchRic: async () => ({ ok: true, status: 200, rics: [
      { id: "501", ric: null, possiblySanger: true, platformCopy: true },
      { id: "502", ric: null, possiblySanger: true, platformCopy: false },
    ] }) },
  });
  assert.equal(validateOf(both.decision).selectedSequenceId, "502", "the Sanger read, though the copy scores higher");
  const alone = await decide({
    meta: { "501": { ricScore: 0 } },
    ports: { fetchRic: async () => ({ ok: true, status: 200, rics: [{ id: "501", ric: null, possiblySanger: true, platformCopy: true }] }) },
  });
  assert.equal(validateOf(alone.decision).selectedSequenceId, "501");
});
