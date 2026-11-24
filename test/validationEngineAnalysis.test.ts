// The deterministic analysis lives in the validation engine
// (lib/validation-engine) and asks the outside world only through the `ports`
// it is handed steps 1.3c and 1.3d). So it must
// run a specimen analysis with no server at all, from a recorded case alone;
// and give the answer the server's own ports give (that half, and the
// package's boundary in this repository, are in validationEngineAnalysisServer.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runDeterministicAnalysis } from "../src/analysis";
import { AnalysisReplayMiss, firstDifference } from "../src/analysisCase";
import { portsFromCase, replayCase } from "../src/caseReplay";
import { deterministicCurationRecommendationId } from "../src/curationRules";
import { utf8Base64Url, utf8Bytes } from "../src/encoding";
import { cleanSpecies, contaminant } from "./support/analysisCaseFixtures";

process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/unused";

// ---- a specimen analysis from a case alone ----

test("the engine names a clean specimen from a case alone: no server code, no eDNA operations", async () => {
  const { result, unused } = await replayCase(cleanSpecies());
  assert.equal(result.status, "complete");
  assert.equal(result.finalSpecies, "Russula emetica");
  assert.ok((result.finalConfidence ?? 0) >= 70);
  assert.deepEqual(unused.filter((u) => !u.startsWith("family ")), []);
});

test("the engine flags a contaminant and names it, and gives the specimen no species", async () => {
  const { result } = await replayCase(contaminant());
  assert.equal(result.flaggedContaminant, true);
  assert.equal(result.finalSpecies, null);
  assert.equal(result.contaminantLikelyName?.name, "Cladosporium cladosporioides");
});

test("a question the case has no answer for stops the engine's replay, naming the door", async () => {
  const without = cleanSpecies();
  delete without.calls.genbankMetadata;
  await assert.rejects(replayCase(without), (error: unknown) => {
    assert.ok(error instanceof AnalysisReplayMiss, String(error));
    assert.equal(error.door, "genbankMetadata");
    return true;
  });
});

test("the engine's replay lists recorded answers it never asked for", async () => {
  const extra = cleanSpecies();
  extra.calls.order = [{ asked: '["Russula"]', answer: "Russulales" }];
  const { unused } = await replayCase(extra);
  assert.ok(unused.includes('order ["Russula"]'), unused.join(" | "));
});

test("without the server's eDNA operations an eDNA sequence is refused before anything is asked", async () => {
  const asked: string[] = [];
  const { ports } = portsFromCase(cleanSpecies().calls);
  const counting = new Proxy(ports, {
    get(target, key) {
      const value = (target as unknown as Record<string | symbol, unknown>)[key];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => { asked.push(String(key)); return (value as (...a: unknown[]) => unknown)(...args); };
    },
  });
  await assert.rejects(
    runDeterministicAnalysis(counting, "edna-77", "case:ncbi", "case:local", null, null),
    /An eDNA analysis \(edna-77\) needs the server's eDNA operations/,
  );
  assert.deepEqual(asked, []);
  const edna = cleanSpecies();
  edna.args.sequenceId = "edna-12";
  await assert.rejects(replayCase(edna), /eDNA analysis \(edna-12\) cannot be recorded or replayed/);
});

test("the engine reports through the logger it is handed, never the console", async () => {
  const logged: string[] = [];
  const line = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  const real = { log: console.log, warn: console.warn, error: console.error };
  let toConsole = 0;
  console.log = console.warn = console.error = () => { toConsole++; };
  try {
    await replayCase(cleanSpecies(), { log: line, warn: line, error: line });
    // And with no logger handed in, a replay is silent.
    await replayCase(cleanSpecies());
  } finally {
    Object.assign(console, real);
  }
  assert.equal(toConsole, 0);
  assert.ok(logged.some((l) => l.includes("[BatchAnalysis] Seq 900001")), logged.slice(0, 3).join(" | "));
});

// ---- the recommendation ids, without Node ----

test("the engine's base64url of UTF-8 is byte for byte what Node's Buffer gives", () => {
  const samples = [
    "", "a", "ab", "abc", "abcd", "Russula emetica", "Entoloma sp. 'Nolanea-conica-PNW07'",
    "é", "ß→µ", "日本語", "🍄", "a🍄b", "\ud83c", "\udf44x", "x\ud83c", "\u0000\u007f\u0080߿ࠀ￿",
  ];
  for (let code = 0; code < 0x10000; code += 13) samples.push(String.fromCharCode(code), `q${String.fromCharCode(code)}${String.fromCharCode((code * 31) & 0xffff)}`);
  for (const text of samples) {
    assert.equal(utf8Base64Url(text), Buffer.from(text, "utf8").toString("base64url"), JSON.stringify(text));
    assert.deepEqual(utf8Bytes(text), [...Buffer.from(text, "utf8")], JSON.stringify(text));
  }
});

test("a curation recommendation's id is the same as it always was", () => {
  // Made with Buffer before the id moved into the engine.
  const tuple = JSON.stringify(["mycoblast", "886670", "update_sequence_name", "Entoloma sp. 'Nolanea-conica-PNW07'"]);
  assert.equal(
    deterministicCurationRecommendationId("mycoblast", "886670", "update_sequence_name", "Entoloma sp. 'Nolanea-conica-PNW07'"),
    `curation:${Buffer.from(tuple, "utf8").toString("base64url")}`,
  );
  assert.equal(
    deterministicCurationRecommendationId("mycoblast", "1", "validate_sequence", null),
    `curation:${Buffer.from(JSON.stringify(["mycoblast", "1", "validate_sequence", null]), "utf8").toString("base64url")}`,
  );
});
