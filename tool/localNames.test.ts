// Local names: how they are spelled, which reads get one, and the stop that
// keeps them out of anything shared (plan decision of 16 November 2026).
//   node --import tsx --test tool/localNames.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AnalysisResult } from "../src/analysisRules";
import { main } from "./cli";
import { inTempDir, makeRunFolder } from "./exportFixture";
import { InputError } from "./fasta";
import { hasLocalName, isLocalName, localNameBase, localNameFor, localNameId, needsNewName, stopOnLocalNames } from "./localNames";

test("a local name is spelled Genus sp. 'local-<read id>', so it cannot be taken for a registered one", () => {
  assert.equal(localNameFor("Russula", "plate7-A02"), "Russula sp. 'local-plate7-A02'");
  assert.equal(localNameFor("Fungi", "MM 12/'x'"), "Fungi sp. 'local-MM-12-x'", "a quote or a space in the id never breaks the name");
  assert.equal(localNameId("'''"), "read");
  assert.equal(isLocalName("Russula sp. 'local-plate7-A02'"), true);
  for (const registered of ["Russula sp. 'IN172'", "Fungi sp. 'env014'", "Russula emetica", "Russula sp. 'locality-1'", null]) {
    assert.equal(isLocalName(registered), false, String(registered));
  }
  assert.equal(hasLocalName("Russula emetica; Russula sp. 'local-A02'"), true);
  assert.equal(hasLocalName("Russula sp. 'IN172'"), false);
});

const result = (over: Partial<AnalysisResult>): AnalysisResult => ({
  status: "complete", steps: [], finalSpecies: null, finalConfidence: null, confidenceBreakdown: null, flaggedContaminant: false, flaggedNonTarget: false,
  skipped: true, barcodeGapNeeded: true, ncbiConsensusSpecies: null, ncbiConsensusCount: null, ncbiConsensusTotalWithSpecies: null,
  localConsensusSpecies: null, localConsensusCount: null, localConsensusTotalWithSpecies: null, ...over,
} as AnalysisResult);

test("a read needs a new name only when nothing named it and it is not a contaminant, another organism or an error", () => {
  assert.equal(needsNewName(result({})), true);
  assert.equal(needsNewName(result({ finalSpecies: "Russula" })), true, "a genus is no species");
  assert.equal(needsNewName(result({ finalSpecies: "Russula emetica", barcodeGapNeeded: false })), false);
  assert.equal(needsNewName(result({ flaggedContaminant: true })), false);
  assert.equal(needsNewName(result({ flaggedNonTarget: true })), false);
  assert.equal(needsNewName(result({ status: "error" })), false);
  assert.equal(needsNewName(result({ barcodeGapNeeded: false })), false);
});

test("with no genus, family or order holding most of the vote, the base is Fungi", () => {
  const empty = { queryLen: 500, hits: [] };
  assert.equal(localNameBase({ engineId: "query:a", record: null, mycomap: empty, ncbi: null, mycomapAdjusted: {}, ncbiAdjusted: {}, records: new Map(), families: new Map() }), "Fungi");
});

test("the export stop: anything that would share a local name stops, naming each and saying how to get a registered name; registered names pass", () => {
  stopOnLocalNames([{ where: "inat:1", name: "Russula emetica" }, { where: "inat:2", name: "Russula sp. 'IN172'" }, { where: "inat:3", name: null }], "The GenBank files");
  assert.throws(
    () => stopOnLocalNames([{ where: "inat:1", name: "Russula emetica" }, { where: "inat:2 (plate7-A02)", name: "Russula sp. 'local-plate7-A02'" }], "The GenBank files"),
    (e: unknown) => e instanceof InputError
      && /^The GenBank files would carry a local name: inat:2 \(plate7-A02\) \(Russula sp\. 'local-plate7-A02'\)\. /.test(e.message)
      && /not posted, uploaded or exported/.test(e.message)
      && /mycomap-validation contribute <run folder>.*contribute --status renames it/.test(e.message),
  );
  const many = Array.from({ length: 7 }, (_, i) => ({ where: `r${i}`, name: `Fungi sp. 'local-r${i}'` }));
  assert.throws(() => stopOnLocalNames(many, "The iNaturalist fields"), (e: unknown) => e instanceof InputError && /7 local names: r0 .*r4 \(Fungi sp\. 'local-r4'\), …\./.test(e.message));
});

test("export stops on a local name: a validated record carrying one writes no file, and says which and what to do", () => inTempDir(async (dir) => {
  const folder = makeRunFolder(dir);
  const file = path.join(folder, "results.json");
  const results = JSON.parse(fs.readFileSync(file, "utf8"));
  const validated = results.records.find((r: { decision: string }) => r.decision === "validate");
  validated.species = "Russula sp. 'local-A02'";
  fs.writeFileSync(file, JSON.stringify(results));
  const printed: string[] = [];
  assert.equal(await main(["export", folder], (l) => printed.push(l)), 1);
  const said = printed.join("\n");
  assert.ok(said.startsWith(`The exports would carry a local name: ${validated.record} (Russula sp. 'local-A02'). `), said);
  assert.ok(said.includes("mycomap-validation contribute <run folder>"), said);
  for (const f of ["darwin-core.csv", "genbank.fasta", "genbank-source.tsv", "inaturalist.txt", "export-report.txt"]) assert.equal(fs.existsSync(path.join(folder, f)), false, `${f} is not written`);
}));
