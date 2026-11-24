// The analysis names the DNA whatever the record is called (2026-11-06).
// A record with no family, or a name above family, used to stop as Manual
// Validation Needed; sequence 859229 did, at Hertzogia martiorum 100%.
//
// These ran against the admin BLAST page's own copy of the analysis until that
// copy was deleted. They run against
// the validation engine now, from cases built by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replayCase } from "../src/caseReplay";
import type { AnalysisResult } from "../src/analysisRules";
import { buildCase, range } from "./support/analysisCaseFixtures";

const RANKS = ["genus", "species", "family", "order", "class", "phylum", "kingdom", null];
const familyAnswer = (requestedName: string, name: string | null) => ({
  requestedName, family: name, authority: name ? "inaturalist" : null, resolvedAt: 0, authorities: [], disagreements: [],
});

async function analyse(source: { name: string | null; rank: string | null }, dna: string, families: Record<string, string | null>): Promise<AnalysisResult> {
  const built = buildCase({
    sequenceId: "900100",
    source,
    local: range(12).map((i) => ({ accession: String(100 + i), name: dna })),
    ncbi: range(12).map((i) => ({ accession: `MK${1000 + i}`, name: dna })),
    families: {},
  });
  // Whatever rank the analysis asks a family at, the answer is the same.
  built.calls.family = Object.entries(families).flatMap(([name, fam]) =>
    RANKS.map((rank) => ({ asked: JSON.stringify([name, rank]), answer: familyAnswer(name, fam) })));
  return (await replayCase(built)).result;
}
const noStop = (r: AnalysisResult) => assert.ok(!r.steps.some((s) => s.step === "Manual Validation Required"), JSON.stringify(r.steps.map((s) => s.step)));

test("sequence 859229: a genus with no family in any taxonomy gets its result (Hertzogia)", async () => {
  const r = await analyse({ name: "Hertzogia", rank: "genus" }, "Hertzogia martiorum", { Hertzogia: null, "Hertzogia martiorum": null });
  assert.equal(r.finalSpecies, "Hertzogia martiorum");
  assert.equal(typeof r.finalConfidence, "number");
  noStop(r);
});

test("a family-less genus with the DNA in another genus gets its result too: the score and Vision decide the record", async () => {
  const r = await analyse({ name: "Neocotylidia", rank: "genus" }, "Thelephora terrestris", { Neocotylidia: null, Thelephora: "Thelephoraceae", "Thelephora terrestris": "Thelephoraceae" });
  assert.equal(r.finalSpecies, "Thelephora terrestris");
  noStop(r);
});

for (const [name, rank] of [["Fungi", "kingdom"], ["Basidiomycota", "phylum"], ["Agaricales", "order"], [null, null]] as const) {
  test(`a record named ${name ?? "nothing"} gets its result`, async () => {
    const r = await analyse({ name, rank }, "Russula brevipes", { ...(name ? { [name]: null } : {}), Russula: "Russulaceae", "Russula brevipes": "Russulaceae" });
    assert.equal(r.finalSpecies, "Russula brevipes");
    assert.equal((r.finalConfidence ?? 0) >= 70, true, String(r.finalConfidence));
    noStop(r);
  });
}

test("the observer's other family still costs its 50 points in the score", async () => {
  const r = await analyse({ name: "Amanita muscaria", rank: "species" }, "Russula brevipes", {
    Amanita: "Amanitaceae", "Amanita muscaria": "Amanitaceae", Russula: "Russulaceae", "Russula brevipes": "Russulaceae",
  });
  assert.equal(r.finalSpecies, "Russula brevipes");
  assert.equal(r.confidenceBreakdown?.familyMismatchPenalty, 50);
});
