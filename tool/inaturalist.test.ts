// The iNaturalist-ready text (inaturalist.ts): the observation fields and the
// comment mycomap.org posts, for each validated iNaturalist record, in a file
// to paste from. Nothing is ever sent.
//   node --import tsx --test tool/inaturalist.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureBases, inTempDir, makeRunFolder } from "./exportFixture";
import { buildInaturalist, isProvisionalSpeciesName, providerLine, sequenceSummary } from "./inaturalist";
import { readRunFolder } from "./runFolder";

const load = (dir: string, opts = {}) => readRunFolder(makeRunFolder(dir, opts));

test("the species goes in Species Name Override, or Provisional Species Name for a provisional name, as mycomap.org writes it", () => inTempDir((dir) => {
  const { entries } = buildInaturalist(load(dir));
  assert.deepEqual(entries.map((e) => [e.record, e.speciesField.name, e.speciesField.id, e.speciesField.value]), [
    ["inat:1001", "Species Name Override", 20259, "Russula emetica"],
    ["OMDL-7", "Provisional Species Name", 10675, 'Cortinarius "sp-IN02"'],
  ]);
  assert.equal(isProvisionalSpeciesName("Russula sp. 'IN01'"), true);
  assert.equal(isProvisionalSpeciesName("Russula emetica"), false);
}));

test("DNA Barcode ITS holds the bases of the read that stands for the record, and Reads in Consensus its read count", () => inTempDir((dir) => {
  const [inat, omdl] = buildInaturalist(load(dir)).entries;
  assert.deepEqual([inat.dnaBarcodeIts.id, inat.dnaBarcodeIts.sequence, inat.dnaBarcodeIts.value], [2330, "plate1-A01", fixtureBases(1)]);
  assert.deepEqual(inat.readsInConsensus, { id: 16718, name: "Reads in Consensus", value: "40" });
  assert.equal(omdl.readsInConsensus, null, "a Sanger read has no read count");
  assert.equal(inat.url, "https://www.inaturalist.org/observations/1001");
  assert.equal(omdl.url, null);
}));

test("the comment is mycomap.org's: the introduction (naming the tool and the databases), the read's top-line summary, and MycoMap Vision's part when it answered", () => inTempDir((dir) => {
  const [inat, omdl] = buildInaturalist(load(dir)).entries;
  assert.equal(inat.comment, [
    "The ID in the observation field was made from this observation's DNA sequence with MycoMap Validation 2.0.0-test (MycoMap reference sequences 2026-11-20; GenBank fungal ITS 2026-11-16), which applies MycoMap's automated identification rules. Please review your results and place your identification on the observation.",
    "More information: www.MycoMap.org/automated-ids",
    "",
    "**Here is a top-line summary of your sequence results from MycoBLAST:**",
    "",
    "Sequence #plate1-A01: Russula emetica (ID Confidence: 92%)",
    "MycoBLAST: Russula emetica (3/3 validated matches at ≥ 99.5% sequence similarity)",
    "NCBI: Russula emetica (4/5 matches at ≥ 99% sequence similarity)",
    "",
    "MycoMap Vision (photos): Russula emetica 62%; genus Russula 91%; family Russulaceae 97%",
  ].join("\n"));
  assert.doesNotMatch(inat.comment!, /ID Update Needed/, "the closing paragraph asks for MycoMap's validators, who never see this run");
  assert.match(omdl.comment!, /\nNCBI: [^\n]*\)$/, "Vision not asked: the comment ends with the summary");
}));

test("GenBank not searched is said as such, never as no usable matches", () => inTempDir((dir) => {
  const [inat] = buildInaturalist(load(dir, { ncbi: false })).entries;
  assert.match(inat.comment!, /\nNCBI: not searched \(GenBank's fungal ITS was not part of this run\)\.\n/);
  assert.match(inat.comment!, /GenBank fungal ITS not searched\)/);
}));

test("the provider lines read as mycomap.org's do, and evidence that does not add up gives no comment", () => {
  assert.deepEqual(providerLine({ label: "NCBI", species: null, count: 2, total: 6, threshold: 99, noun: "matches" }), { kind: "none", line: "NCBI: No species consensus among 6 matches at ≥ 99% sequence similarity." });
  assert.deepEqual(providerLine({ label: "NCBI", species: null, count: null, total: null, threshold: null, noun: "matches" }), { kind: "none", line: "NCBI: No usable matches were available." });
  assert.deepEqual(providerLine({ label: "NCBI", species: "Russula", count: 3, total: 4, threshold: null, noun: "matches", source: "the genus" }), { kind: "matches", line: "NCBI: Russula (3/4 matches via the genus)" });
  assert.equal(providerLine({ label: "MycoBLAST", species: "Russula emetica", count: 5, total: 4, threshold: 99.5, noun: "validated matches" }), null);
  assert.equal(sequenceSummary("x", { status: "error", finalSpecies: null, finalConfidence: null } as never, true), null);
});

test("the file to paste holds every iNaturalist record's fields and comment; Mushroom Observer, held and rejected records are left out and said", () => inTempDir((dir) => {
  const inat = buildInaturalist(load(dir));
  assert.match(inat.text, /^iNaturalist fields and comments for 2 validated records\n/);
  assert.match(inat.text, /Nothing here has\nbeen sent to iNaturalist\./);
  assert.match(inat.text, /\ninat:1001 \(plate1-A01, plate1-A02\)\nObservation: https:\/\/www\.inaturalist\.org\/observations\/1001\n\nSpecies Name Override \(observation field 20259\):\nRussula emetica\n\nDNA Barcode ITS \(observation field 2330\), read plate1-A01, 560 bases:\n[ACGT]{560}\n\nReads in Consensus \(observation field 16718\):\n40\n\nComment:\nThe ID/);
  assert.doesNotMatch(inat.text, /mo:2002|inat:1003|plate1-E01/);
  assert.deepEqual(inat.notes, [
    "1 validated record is on Mushroom Observer, so it is left out: these are iNaturalist's fields.",
    "2 records were not validated (held or rejected), so they are not in the file.",
    "1 record has no iNaturalist address: write the record as inat:<number> in the sheet to have it.",
  ]);
}));

test("nothing in the export can post to iNaturalist: no network call in the files that make it", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const file of ["inaturalist.ts", "export.ts", "runFolder.ts", "genbank.ts", "darwinCore.ts"]) {
    const text = fs.readFileSync(path.join(here, file), "utf8");
    assert.doesNotMatch(text, /\bfetch\(|node:https?|node:net|api\.inaturalist\.org/, `${file} must not reach the network`);
  }
});
