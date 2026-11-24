// MycoMap Vision in the record decisions, against a stand-in Vision on this
// computer (testSupport.ts serve): never vision.mycomap.org. Vision's answer is
// read as mycomap.org reads it, and the engine's own rules decide.
//   node --import tsx --test tool/vision.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalysisResult } from "../src/analysisRules";
import { readRecordsSheet } from "./fasta";
import { decideRecords } from "./records";
import { serve, type Handler, type Served } from "./testSupport";
import { createVisionClient, observationTarget, visionAnswerFromBody, visionSettings, VisionSettingError } from "./vision";
import { runVision } from "./ui/server";
// @ts-expect-error: view.js is the page's own plain JavaScript.
import { visionCellHtml, visionSummaryHtml } from "./ui/view.js";

delete process.env.MYCOMAP_VISION_KEY;
delete process.env.MYCOMAP_VISION_URL;

const seq = (id: string, record: string | null, recordName: string | null, readCount: number | null = 40, photos: string | null = null) =>
  ({ id, description: "", bases: "ACGT", recordName, readCount, record, photos });
const named = (finalSpecies: string | null, finalConfidence: number | null, extra: Partial<AnalysisResult> = {}) =>
  ({ status: "complete", steps: [], finalSpecies, finalConfidence, flaggedContaminant: false, flaggedNonTarget: false, ...extra }) as unknown as AnalysisResult;
const FAMILIES = new Map([["Russula", "Russulaceae"], ["Amanita", "Amanitaceae"], ["Hypomyces", "Hypocreaceae"]]);

type Ranks = { species?: Array<[string, number]>; genus?: Array<[string, number]>; family?: Array<[string, number]> };
/** A v1 answer from Vision's API, made up for the test. */
function answer(ranks: Ranks, extra: Record<string, unknown> = {}) {
  const list = (l: Array<[string, number]> = []) => l.map(([name, confidence]) => ({ name, confidence }));
  return {
    status: 200,
    body: {
      request_id: "r_test", model: { name: "MycoMap Vision", version: "2026-11-15", answers_version: "av-test-2" },
      gate: { verdict: "fungus" }, ranks: { species: list(ranks.species), genus: list(ranks.genus), family: list(ranks.family) },
      usage: { plan: "member", used: 8, limit: 300, period: "2026-11", resets_at: "2026-12-01T00:00:00Z" },
      ...extra,
    },
  };
}

/** A stand-in Vision, and a client for it whose waits are recorded, not slept. */
async function withVision<T>(handlers: Record<string, Handler>, fn: (v: { served: Served; client: ReturnType<typeof createVisionClient>; slept: number[] }) => Promise<T>): Promise<T> {
  const served = await serve({}, handlers);
  const slept: number[] = [];
  const client = createVisionClient({ key: "vision_test_key", url: served.base, sleep: async (ms) => { slept.push(ms); } });
  try {
    return await fn({ served, client, slept });
  } finally {
    await served.close();
  }
}
const identifyCalls = (s: Served) => s.requests.filter((r) => r.method === "POST").map((r) => r.path);

test("with no key there is no Vision: no settings from an empty environment, nothing asked, and the reasons say no key was given", async () => {
  assert.equal(visionSettings({ env: {} }), null);
  assert.equal(visionSettings({ key: "  ", env: {} }), null);
  assert.deepEqual(visionSettings({ env: { MYCOMAP_VISION_KEY: "vision_k" } }), { key: "vision_k", url: "https://vision.mycomap.org" });
  assert.deepEqual(visionSettings({ key: "vision_k", url: "http://127.0.0.1:9/", env: {} }), { key: "vision_k", url: "http://127.0.0.1:9" });
  assert.throws(() => visionSettings({ key: "vision_k", url: "http://vision.example.org", env: {} }), (e: unknown) => e instanceof VisionSettingError && /only sent over https/.test(e.message));
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; throw new Error("no call expected"); }) as typeof fetch;
  try {
    const [r] = await decideRecords([seq("a", "inat:2001", "Amanita")] as never, { a: named("Russula emetica", 95) }, FAMILIES);
    assert.equal(calls, 0);
    assert.equal(r.vision.status, "not_asked");
    assert.match(r.reason, /^No second source for the DNA's Russula emetica: MycoMap Vision was not asked \(no Vision key was given\), and/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Vision agreeing with the DNA validates a record at 64% (DNA + MycoMap Vision), stamped with the model and answers version", () => withVision({
  "POST /api/v1/identify/inat/2001": () => answer({ species: [["Russula emetica", 0.62]], genus: [["Russula", 0.9]], family: [["Russulaceae", 0.96]] }),
}, async ({ served, client }) => {
  const [r] = await decideRecords([seq("a", "inat:2001", null)] as never, { a: named("Russula emetica", 64) }, FAMILIES, { vision: client });
  assert.deepEqual(identifyCalls(served), ["/api/v1/identify/inat/2001"]);
  assert.equal(r.decision, "validate");
  assert.equal(r.species, "Russula emetica");
  assert.equal(r.secondSource, "MycoMap Vision shows Russula emetica at 62%");
  assert.match(r.reason, /Below 70% on the DNA alone: Vision: Russula emetica 62% — agrees → green-checked \(DNA \+ MycoMap Vision\)\.$/);
  assert.deepEqual({ ...r.vision }, {
    status: "answered", by: "observation", words: null, top: "Russula emetica 62%; genus Russula 90%; family Russulaceae 96%",
    gate: "fungus", model: "2026-11-15", answersVersion: "av-test-2", kept: false,
  });
  assert.deepEqual(client.lastUsage, { plan: "member", used: 8, limit: 300, period: "2026-11", resetsAt: "2026-12-01T00:00:00Z" });
}));

test("Vision sure of another genus, showing neither the DNA's genus nor its species, holds a record the DNA names at 92% (the genus veto)", () => withVision({
  "POST /api/v1/identify/mo/3001": () => answer({ species: [["Amanita muscaria", 0.8]], genus: [["Amanita", 0.85]], family: [["Amanitaceae", 0.9]] }),
}, async ({ client }) => {
  const [r] = await decideRecords([seq("a", "mo:3001", "Amanita muscaria")] as never, { a: named("Russula emetica", 92) }, FAMILIES, { vision: client });
  assert.equal(r.decision, "held");
  assert.equal(r.reason, "MycoMap Vision says genus Amanita (85%), DNA says Russula, and Vision shows neither Russula nor Russula emetica on its list, and the observer's identification Amanita muscaria is not in Russula: held for a person.");
  assert.equal(r.vision.status, "answered");
}));

test("when the reads disagree, Vision picks the one whose genus it shows; the other is reported as set aside, never moved, and the record validates", () => withVision({
  "POST /api/v1/identify/inat/4001": () => answer({ species: [["Russula emetica", 0.4]], genus: [["Russula", 0.9]], family: [["Russulaceae", 0.95]] }),
}, async ({ client }) => {
  const sequences = [seq("a", "inat:4001", null), seq("b", "inat:4001", null)];
  const results = { a: named("Russula emetica", 95), b: named("Hypomyces chrysospermus", 90) };
  const [without] = await decideRecords(sequences as never, results, FAMILIES);
  assert.equal(without.decision, "held", "without Vision nothing picks between them");
  assert.match(without.reason, /^Sequences disagree on species/);
  const [r] = await decideRecords(sequences as never, results, FAMILIES, { vision: client });
  assert.equal(r.decision, "validate");
  assert.equal(r.species, "Russula emetica");
  assert.deepEqual(r.agreeingSequenceIds, ["a"]);
  assert.deepEqual(r.setAsideSequenceIds, ["b"]);
  assert.equal(r.secondSource, "MycoMap Vision shows Russula emetica at 40%");
  assert.match(r.reason, / MycoMap Vision picked the record's read, so b is set aside as another organism \(reported only: nothing is moved\)\.$/);
}));

test("a refused key is said in words, and no record is sent: refused when the quota is read, or at the first record", async () => {
  await withVision({
    "GET /api/v1/usage": () => ({ status: 401, body: { code: "invalid_token", detail: "unknown token" } }),
    "POST /api/v1/identify/inat/5001": () => answer({ genus: [["Russula", 0.9]] }),
  }, async ({ served, client }) => {
    await client.usage();
    const [r] = await decideRecords([seq("a", "inat:5001", "Amanita")] as never, { a: named("Russula emetica", 95) }, FAMILIES, { vision: client });
    assert.deepEqual(identifyCalls(served), [], "the key was refused before any record was sent");
    assert.equal(client.stopped?.words, "MycoMap Vision refused the key (it does not know it; check the key mycomap.org/vision-keys gave you)");
    assert.equal(r.vision.status, "no_answer");
    assert.equal(r.decision, "held", "decided as without Vision");
    assert.match(r.reason, /^No second source for the DNA's Russula emetica: MycoMap Vision refused the key \(it does not know it; .*\), and the observer's identification \(Amanita\) is not in Russula\. Held for a person\.$/);
  });
  await withVision({
    "POST /api/v1/identify/inat/5002": () => ({ status: 403, body: { code: "key_inactive", reason: "pending", detail: "key pending" } }),
    "POST /api/v1/identify/inat/5003": () => answer({ genus: [["Russula", 0.9]] }),
  }, async ({ served, client }) => {
    const records = await decideRecords([seq("a", "inat:5002", null), seq("b", "inat:5003", null)] as never, { a: named("Russula emetica", 95), b: named("Russula emetica", 95) }, FAMILIES, { vision: client });
    assert.deepEqual(identifyCalls(served), ["/api/v1/identify/inat/5002"], "once refused, the next record is not sent");
    assert.deepEqual(records.map((r) => r.vision.words), ["MycoMap Vision refused the key (it is still waiting to be approved)", "MycoMap Vision refused the key (it is still waiting to be approved)"]);
  });
});

test("a used-up quota is said in words with when it resets, and stops the run's asks: from the quota read, or from Vision's refusal", async () => {
  await withVision({
    "POST /api/v1/identify/inat/6001": () => ({ status: 429, body: { code: "quota_exceeded", detail: "used up", used: 300, limit: 300, resets_at: "2026-12-01T00:00:00Z" } }),
    "POST /api/v1/identify/inat/6002": () => answer({ genus: [["Russula", 0.9]] }),
  }, async ({ served, client, slept }) => {
    const records = await decideRecords([seq("a", "inat:6001", null), seq("b", "inat:6002", null)] as never, { a: named("Russula emetica", 95), b: named("Russula emetica", 95) }, FAMILIES, { vision: client });
    assert.deepEqual(identifyCalls(served), ["/api/v1/identify/inat/6001"]);
    assert.deepEqual(slept, [], "a used-up quota is not a rate limit: not asked again");
    const words = "MycoMap Vision's quota for this key is used up (300 of 300; it resets 2026-12-01 00:00 UTC)";
    assert.equal(client.stopped?.words, words);
    assert.deepEqual(records.map((r) => [r.vision.status, r.vision.words]), [["no_answer", words], ["no_answer", words]]);
    assert.match(records[0].reason, /^No second source for the DNA's Russula emetica: MycoMap Vision's quota for this key is used up \(300 of 300; it resets 2026-12-01 00:00 UTC\), and there is no identification from the observer\. Held for a person\.$/);
  });
  await withVision({
    "GET /api/v1/usage": () => ({ status: 200, body: { usage: { plan: "member", used: 300, limit: 300, period: "2026-11", resets_at: "2026-12-01T00:00:00Z" } } }),
  }, async ({ served, client }) => {
    await client.usage();
    await decideRecords([seq("a", "inat:6003", null)] as never, { a: named("Russula emetica", 95) }, FAMILIES, { vision: client });
    assert.deepEqual(identifyCalls(served), [], "the quota said it was used up: nothing sent");
    assert.match(client.stopped!.words, /quota for this key is used up \(300 of 300/);
  });
});

test("Vision busy is asked again after its wait, and its answer then counts; busy past two minutes is said in words and decided as without Vision", async () => {
  let tries = 0;
  await withVision({
    "POST /api/v1/identify/inat/7001": () => (++tries === 1
      ? { status: 503, headers: { "Retry-After": "8" }, body: { code: "busy", detail: "the queue is full", estimated_wait_seconds: 8 } }
      : answer({ species: [["Russula emetica", 0.62]], genus: [["Russula", 0.9]], family: [["Russulaceae", 0.96]] })),
  }, async ({ served, client, slept }) => {
    const [r] = await decideRecords([seq("a", "inat:7001", null)] as never, { a: named("Russula emetica", 64) }, FAMILIES, { vision: client });
    assert.deepEqual(identifyCalls(served), ["/api/v1/identify/inat/7001", "/api/v1/identify/inat/7001"]);
    assert.deepEqual(slept, [8000], "Vision's Retry-After, longer than the first wait of 5 s");
    assert.equal(r.decision, "validate");
    assert.equal(r.vision.status, "answered");
  });
  await withVision({
    "POST /api/v1/identify/inat/7002": () => ({ status: 503, body: { code: "busy" } }),
  }, async ({ served, client, slept }) => {
    const [r] = await decideRecords([seq("a", "inat:7002", "Russula")] as never, { a: named("Russula emetica", 95) }, FAMILIES, { vision: client });
    assert.deepEqual(slept, [5000, 10000, 20000, 30000, 45000], "5, 10, 20, 30 and 45 s: the next would pass two minutes");
    assert.equal(identifyCalls(served).length, 6);
    assert.equal(r.vision.words, "MycoMap Vision was busy (busy) and did not answer (6 tries over 110 s)");
    assert.equal(client.stopped, null, "busy is not a reason to stop asking about other records");
    assert.equal(r.decision, "validate", "decided as without Vision: the observer's identification is the second source");
  });
});

test("a record with a photos folder and no observation number is asked about by its photos: at most ten, uploaded, with a reference that does not name the folder", () => withVision({
  "POST /api/v1/identify": () => answer({ species: [["Russula emetica", 0.62]], genus: [["Russula", 0.9]], family: [["Russulaceae", 0.96]] }, { photos: 2 }),
}, async ({ served, client }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmv-photos-"));
  try {
    const folder = path.join(dir, "OMDL-9 cap");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "b.jpg"), "jpeg bytes");
    fs.writeFileSync(path.join(folder, "a.png"), "png bytes");
    fs.writeFileSync(path.join(folder, "notes.txt"), "not a photo");
    const sheet = readRecordsSheet("sequence,record,photos\na,OMDL-9,OMDL-9 cap\n");
    assert.deepEqual(sheet.get("a"), { name: null, readCount: null, record: "OMDL-9", photos: "OMDL-9 cap" });
    const [r] = await decideRecords([seq("a", "OMDL-9", null, 40, "OMDL-9 cap")] as never, { a: named("Russula emetica", 64) }, FAMILIES, { vision: client, photosFrom: dir });
    assert.deepEqual(identifyCalls(served), ["/api/v1/identify"]);
    const body = served.requests[0].body!.toString("latin1");
    assert.equal((body.match(/name="photos"/g) ?? []).length, 2, "the two photos, not the notes");
    assert.ok(body.indexOf('filename="a.png"') < body.indexOf('filename="b.jpg"'), "in name order");
    assert.match(body, /name="top_k"\r\n\r\n5\r\n/);
    assert.match(body, /name="client_ref"\r\n\r\nmmv-[0-9a-f]{32}\r\n/);
    assert.doesNotMatch(body, /OMDL-9/, "neither the record nor its folder's name is sent");
    assert.equal(r.decision, "validate");
    assert.equal(r.vision.by, "photos");
    const [none] = await decideRecords([seq("b", "OMDL-10", null, 40, "missing")] as never, { b: named("Russula emetica", 64) }, FAMILIES, { vision: client, photosFrom: dir });
    assert.equal(identifyCalls(served).length, 1, "a folder that is not there sends nothing");
    assert.match(none.vision.words!, /^MycoMap Vision was not asked: the photos folder .*missing could not be read$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test("Vision's answer is read as mycomap.org reads it: five names a rank, the gate, a record left out of its own answer counts as a fungus, and the answers version", () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ name: `Russula sp${i}`, confidence: 0.1 }));
  const a = visionAnswerFromBody({ model: { version: "2026-11-15" }, gate: null, excluded_reference: { source: "inat", source_id: "1" }, ranks: { species: many, genus: [{ name: "Russula", confidence: null }] }, cached: true }, "observation");
  assert.equal(a.vision.species.length, 5);
  assert.equal(a.vision.gateVerdict, "fungus");
  assert.deepEqual(a.vision.genus, [{ name: "Russula", confidence: null }]);
  assert.equal(a.answersVersion, "release:2026-11-15", "without answers_version, the release");
  assert.equal(a.kept, true);
  assert.equal(visionAnswerFromBody({ gate: { verdict: "unsure" }, ranks: {} }, "photos").vision.gateVerdict, "unsure");
  assert.deepEqual(observationTarget("inat:12"), { kind: "observation", platform: "inat", id: "12" });
  assert.deepEqual(observationTarget(" MO:34 "), { kind: "observation", platform: "mo", id: "34" });
  assert.equal(observationTarget("inat:abc"), null);
  assert.equal(observationTarget("OMDL-1"), null);
});

test("the browser app asks Vision only when the page ticks it: with the key typed for that run, else the one the tool was started with", () => {
  const started = { key: "vision_started", url: "http://127.0.0.1:9" };
  assert.equal(runVision({}, started), null);
  assert.equal(runVision({ vision: false, visionKey: "vision_typed" }, started), null);
  assert.deepEqual(runVision({ vision: true }, started), started);
  assert.deepEqual(runVision({ vision: true, visionKey: " vision_typed " }, started), { key: "vision_typed", url: "http://127.0.0.1:9" });
  assert.deepEqual(runVision({ vision: true, visionKey: "vision_typed" }, null), { key: "vision_typed", url: "https://vision.mycomap.org" });
  assert.throws(() => runVision({ vision: true }, null), (e: unknown) => e instanceof VisionSettingError && /Type your MycoMap Vision key/.test(e.message));
});

test("the page shows which records Vision answered, the quota left, and why Vision stopped, in words", () => {
  assert.match(visionCellHtml({ status: "answered", by: "observation", top: "Russula emetica 62%", gate: "fungus" }), /^Russula emetica 62%<div class="muted">by observation number<\/div>$/);
  assert.match(visionCellHtml({ status: "no_answer", words: "busy" }), /no answer/);
  assert.match(visionSummaryHtml(null), /MycoMap Vision was not asked \(no key\)/);
  const html = visionSummaryHtml({ asked: 3, answered: 1, models: ["2026-11-15"], answersVersions: ["av-1"], usage: { used: 300, limit: 300, period: "2026-11" }, problem: "MycoMap Vision's quota for this key is used up <soon>" });
  assert.match(html, /it answered 1 of the 3 records it was asked about\. Model 2026-11-15; answers version av-1\. Quota: 300 of 300 used, 0 left this month \(2026-11\)\./);
  assert.match(html, /<div class="notice bad">MycoMap Vision&#39;s quota for this key is used up &lt;soon&gt;\.<\/div>/);
});
