// The confidence score's Base counts specimens, not reads (2026-11-17). Three
// variant reads of one Piloderma specimen showed as "3 validated MycoBLAST hits" and
// scored as three independent records. Reads of one specimen are one record, as in the
// species vote since 2026-11-10 (specimenVotes.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { replayCase } from "../src/caseReplay";
import { buildCase, cleanSpecies, range } from "./support/analysisCaseFixtures";

process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/unused";

const families = { Russula: "Russulaceae", "Russula emetica": "Russulaceae" };
const ncbi = range(8).map((i) => ({ accession: `MK10000${i}`, name: "Russula emetica" }));
/** A read of the specimen on observation `obs`; reads sharing `obs` are one specimen. */
const read = (accession: number, obs: string, identity = 100) =>
  ({ accession: String(accession), name: "Russula emetica", identity, record: { observationId: obs } });

test("three reads of one specimen and one of another are two specimens in Base, not four hits", async () => {
  const { result } = await replayCase(buildCase({
    sequenceId: "900101",
    source: { name: "Russula emetica", rank: "species" },
    local: [read(201, "81001"), read(202, "81001"), read(203, "81001"), read(204, "81002")],
    ncbi, families,
  }));
  const b = result.confidenceBreakdown!;
  assert.equal(result.finalSpecies, "Russula emetica");
  assert.equal(b.validatedHitCount, 2);
  assert.equal(b.baseScore, 70, "two specimens score as two hits did; four hits scored 79");
  assert.match(b.baseReason, /^2 validated MycoBLAST specimens \(4 hits; reads of one specimen count once\) at >= 99\.5% identity$/);
});

test("on the 99% path, three reads of one specimen are one specimen, halved", async () => {
  const { result } = await replayCase(buildCase({
    sequenceId: "900102",
    source: { name: "Russula emetica", rank: "species" },
    local: [read(211, "81011", 99.2), read(212, "81011", 99.2), read(213, "81011", 99.2)],
    ncbi, families,
  }));
  const b = result.confidenceBreakdown!;
  assert.equal(b.validatedHitCount, 1);
  assert.equal(b.baseScore, 30, "one specimen is 60, halved; three hits were 75, halved to 38");
  assert.match(b.baseReason, /^1 validated MycoBLAST specimen \(3 hits; reads of one specimen count once\) at >= 99% identity \(halved: secondary threshold\)$/);
});

test("when every hit is its own specimen, Base and its wording are as they always were", async () => {
  const { result } = await replayCase(cleanSpecies());
  const b = result.confidenceBreakdown!;
  assert.equal(b.validatedHitCount, 6);
  assert.equal(b.baseReason, "6 validated MycoBLAST hits at >= 99.5% identity");
});

// ---- the vote at 99% (2026-11-17: "Yes, add it") ----

const named = (accession: number, name: string, obs: string, identity = 99.2) =>
  ({ accession: String(accession), name, identity, record: { observationId: obs } });
const twoNames = { ...families, "Russula fragilis": "Russulaceae" };

test("at 99%, seven reads of one specimen no longer outvote three other specimens", async () => {
  const { result } = await replayCase(buildCase({
    sequenceId: "900103",
    source: { name: "Russula emetica", rank: "species" },
    local: [
      ...range(7).map((i) => named(221 + i, "Russula fragilis", "81021")),
      named(231, "Russula emetica", "81031"), named(232, "Russula emetica", "81032"), named(233, "Russula emetica", "81033"),
    ],
    ncbi, families: twoNames,
  }));
  // Counted per read, Russula fragilis held 7/10 (70%) and won. Per specimen it is 1 vote to 3.
  assert.equal(result.finalSpecies, "Russula emetica");
  assert.equal(result.localConsensusThreshold, 99);
  // The winner's reported count stays per read, as at 99.5%.
  assert.equal(result.localConsensusCount, 3);
  assert.equal(result.localConsensusTotalWithSpecies, 10);
  const step = result.steps.find((s) => s.step.startsWith("Secondary 99% MycoBLAST Consensus"))!;
  assert.ok(step.details!.includes("10 hits came from 4 specimen votes: reads of one specimen vote once per name"), step.details!.join(" | "));
  assert.ok(step.details!.includes("Russula emetica: 3/4 specimen votes (75%)"), step.details!.join(" | "));
  assert.ok(step.details!.some((d) => d.startsWith("Russula fragilis: 7/10")), "the losing name is still listed");
});

test("at 99%, when every hit is its own specimen the vote and its details are as before", async () => {
  const { result } = await replayCase(buildCase({
    sequenceId: "900104",
    source: { name: "Russula emetica", rank: "species" },
    local: [named(241, "Russula emetica", "81041"), named(242, "Russula emetica", "81042"), named(243, "Russula emetica", "81043")],
    ncbi, families,
  }));
  assert.equal(result.finalSpecies, "Russula emetica");
  const step = result.steps.find((s) => s.step.startsWith("Secondary 99% MycoBLAST Consensus"))!;
  assert.ok(!step.details!.some((d) => d.includes("specimen vote")), step.details!.join(" | "));
});
