// Reading MycoMap's names table (mycomap_sequences_<date>.tsv.gz) into what the
// engine asks about each MycoMap hit: only a hit on a validated record counts
// towards a name, and a flagged one is read as flagged.
//   node --import tsx --test tool/namesTable.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { InputError } from "./fasta";
import { namesTableFromLines, readNamesTable, sequenceRecordFromRow } from "./namesTable";

// The table's columns, as the nightly build writes them (the Data Downloads page's mycomap_sequences file).
const COLUMNS = ["mm_id", "sequence_id", "name", "mycobank_number", "kingdom", "phylum", "class", "order", "family", "genus", "method", "on_validated_record", "in_reference_set", "reference_exclusion", "flags", "reads_in_consensus", "length", "genbank_accession", "observation", "observation_url", "updated_at"];
const line = (v: Record<string, string>) => COLUMNS.map((c) => v[c] ?? "").join("\t");
const TABLE = [
  COLUMNS.join("\t"),
  line({ mm_id: "MM1", name: "Russula emetica", family: "Russulaceae", genus: "Russula", method: "ont", on_validated_record: "yes", reads_in_consensus: "40", observation: "inat:123" }),
  line({ mm_id: "MM2", name: "Russula emetica", family: "Russulaceae", genus: "Russula", method: "sanger", on_validated_record: "no", flags: "contaminant,low", observation: "mo:77" }),
  line({ mm_id: "MM3", name: "Russula nobilis", family: "Russulaceae", genus: "Russula", method: "inaturalist", on_validated_record: "yes" }),
  line({ mm_id: "MM4", name: "Lactarius deliciosus", family: "Russulaceae", genus: "Lactarius", method: "ont", on_validated_record: "yes" }),
  line({ mm_id: "MM5", name: "Lactarius sp.", family: "Lactariaceae", genus: "Lactarius", method: "ont", on_validated_record: "yes" }),
];

test("a row on a validated record is a verified hit; any other is unverified, so it does not count towards a name", () => {
  const validated = sequenceRecordFromRow({ mm_id: "MM1", name: "Russula emetica", on_validated_record: "yes", method: "ont", reads_in_consensus: "40", observation: "inat:123", flags: "" });
  assert.equal(validated.validated, true);
  assert.equal(validated.validationStatus, "verified");
  assert.equal(validated.scientificName, "Russula emetica");
  assert.equal(validated.ric, 40);
  assert.equal(validated.categoryName, "ONT Sequences");
  assert.equal(validated.inatObservationId, 123);
  assert.equal(validated.observationId, "inat:123", "two reads of one observation are one specimen");
  const other = sequenceRecordFromRow({ mm_id: "MM2", name: "Russula emetica", on_validated_record: "no", method: "sanger", flags: "contaminant,low", observation: "mo:77" });
  assert.equal(other.validated, false);
  assert.equal(other.validationStatus, "unverified");
  assert.deepEqual(other.flags, ["contaminant", "low"]);
  assert.equal(other.moObservationId, 77);
  assert.equal(other.categoryName, "Sanger Sequences");
});

test("only the rows BLAST hit are kept, and each genus gets the family most of its rows carry (a tie goes to the first in alphabetical order)", async () => {
  const table = await namesTableFromLines(TABLE, new Set(["MM2", "MM9"]));
  assert.deepEqual([...table.records.keys()], ["MM2"]);
  assert.equal(table.rows, 5);
  assert.equal(table.families.get("Russula"), "Russulaceae");
  assert.equal(table.families.get("Lactarius"), "Lactariaceae");
});

test("the gzipped file from the Data Downloads page is read as it comes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmv-names-"));
  try {
    const file = path.join(dir, "mycomap_sequences_2026-11-20.tsv.gz");
    fs.writeFileSync(file, zlib.gzipSync(`${TABLE.join("\n")}\n`));
    const table = await readNamesTable(file, new Set(["MM1"]));
    assert.equal(table.records.get("MM1")?.scientificName, "Russula emetica");
    fs.writeFileSync(file, zlib.gzipSync(`${TABLE.join("\n")}\n`).subarray(0, 60));
    await assert.rejects(readNamesTable(file, new Set()), (e: unknown) => e instanceof InputError && /could not be read .*Download it again/.test(e.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that is not the names table is refused, naming the columns it lacks", async () => {
  await assert.rejects(namesTableFromLines(["mm_id\tname", "MM1\tRussula"], new Set()), (e: unknown) => e instanceof InputError && /no family, genus, method, on_validated_record, flags, reads_in_consensus, observation columns/.test(e.message));
  await assert.rejects(namesTableFromLines([], new Set()), /is empty/);
});

test("the validation column, when the table has it, says whether a hit counts: a verified read of a validated specimen counts though no record names it", async () => {
  const withValidation = [
    [...COLUMNS, "validation"].join("\t"),
    `${line({ mm_id: "MM8", name: "Cantharellus minor", genus: "Cantharellus", family: "Hydnaceae", method: "ont", on_validated_record: "no", observation: "inat:387036324" })}\tverified`,
    `${line({ mm_id: "MM9", name: "Cantharellus minor", genus: "Cantharellus", family: "Hydnaceae", method: "ont", on_validated_record: "yes" })}\trejected`,
    `${line({ mm_id: "MM10", name: "Cantharellus minor", genus: "Cantharellus", family: "Hydnaceae", method: "ont", on_validated_record: "no" })}\tnot_assessed`,
  ];
  const table = await namesTableFromLines(withValidation, new Set(["MM8", "MM9", "MM10"]));
  assert.deepEqual(["MM8", "MM9", "MM10"].map((id) => [table.records.get(id)!.validated, table.records.get(id)!.validationStatus]),
    [[true, "verified"], [false, "rejected"], [false, "not_assessed"]]);
});

test("a table built before the validation column falls back to on_validated_record", async () => {
  const table = await namesTableFromLines(TABLE, new Set(["MM1", "MM2"]));
  assert.equal(table.records.get("MM1")!.validationStatus, "verified");
  assert.equal(table.records.get("MM2")!.validationStatus, "unverified");
});

test("'[]', the record store's empty list that older tables wrote as a flag, is no flag", () => {
  assert.deepEqual(sequenceRecordFromRow({ mm_id: "MM1", flags: "[]" }).flags, []);
  assert.deepEqual(sequenceRecordFromRow({ mm_id: "MM1", flags: "contaminant,low" }).flags, ["contaminant", "low"]);
});
