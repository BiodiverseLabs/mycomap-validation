// Reading the sequences to check and the sheet of records: what is read, and
// every file the tool refuses, with the words it says.
//   node --import tsx --test tool/fasta.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { InputError, readFasta, readRecordsSheet, withRecords } from "./fasta";

test("a FASTA file: each header's first word is the id, the bases are joined, cleaned and upper-cased, and a ric= word is the read count", () => {
  const seqs = readFasta("﻿>spec-1 ric=40 primers=ITS1F\r\nacgu\r\nAC-GT\n\n>spec-2 reads=7\nNNAC.GT\n>spec-3 Russula emetica\nACGT\n");
  assert.deepEqual(seqs.map((s) => [s.id, s.bases, s.readCount, s.recordName]), [
    ["spec-1", "ACGTACGT", 40, null],
    ["spec-2", "NNACGT", 7, null],
    ["spec-3", "ACGT", null, null],
  ]);
  assert.equal(seqs[0].description, "ric=40 primers=ITS1F");
});

test("a FASTA file the tool cannot read is refused with what to change", () => {
  const refused = (text: string, words: RegExp) => assert.throws(() => readFasta(text, "my.fasta"), (e: unknown) => e instanceof InputError && words.test(e.message));
  refused("", /has no sequences/);
  refused("ACGT\n>a\nACGT\n", /line 1: bases before the first header/);
  refused(">a\nACGT\n>a\nACGG\n", /two sequences are called "a"/);
  refused(">a\n>b\nACGT\n", /line 1: "a" has no bases/);
  refused(">a\nACGTQZ\n", /not DNA bases \(Q Z\)/);
  refused("> \nACGT\n", /a header with no name/);
});

test("a records sheet gives each sequence its record name and read count, from a CSV with quotes or a TSV, by column names in any case", () => {
  const csv = readRecordsSheet('Sequence,Name,Reads\nspec-1,"Russula sp. \'IN01\', the red one",40\nspec-2,Amanita,\n');
  assert.deepEqual(csv.get("spec-1"), { name: "Russula sp. 'IN01', the red one", readCount: 40, record: null });
  assert.deepEqual(csv.get("spec-2"), { name: "Amanita", readCount: null, record: null });
  const tsv = readRecordsSheet("id\tscientific_name\tric\tSpecimen\nspec-1\tRussula emetica\t12\tOMDL-1\n");
  assert.deepEqual(tsv.get("spec-1"), { name: "Russula emetica", readCount: 12, record: "OMDL-1" });
});

test("the sheet's name and read count go on the matching sequences; the sheet's read count wins over the header's", () => {
  const seqs = readFasta(">spec-1 ric=40\nACGT\n>spec-2 ric=9\nACGT\n");
  const merged = withRecords(seqs, readRecordsSheet("sequence,name,reads\nspec-1,Russula emetica,12\n"));
  assert.deepEqual(merged.map((s) => [s.id, s.recordName, s.readCount, s.record]), [["spec-1", "Russula emetica", 12, null], ["spec-2", null, 9, null]]);
  const grouped = withRecords(seqs, readRecordsSheet("sequence,record\nspec-1,iNat 123\nspec-2,iNat 123\n"));
  assert.deepEqual(grouped.map((s) => s.record), ["iNat 123", "iNat 123"], "a sheet may give only the record");
});

test("a records sheet the tool cannot use is refused with what to change", () => {
  const refused = (fn: () => unknown, words: RegExp) => assert.throws(fn, (e: unknown) => e instanceof InputError && words.test(e.message));
  refused(() => readRecordsSheet("name\nRussula\n"), /no column for the sequence/);
  refused(() => readRecordsSheet("sequence,colour\na,x\n"), /no "name" column \(the record's identification\), no "reads" column and no "record" column/);
  refused(() => readRecordsSheet("sequence,name\na,x\na,y\n"), /line 3: "a" is listed twice/);
  refused(() => readRecordsSheet("sequence,reads\na,forty\n"), /"forty" is not a whole number/);
  refused(() => withRecords(readFasta(">a\nACGT\n"), readRecordsSheet("sequence,name\nb,Russula\n")), /does not have: b\. The ids must match/);
});

test("a sheet with both a voucher and a record column takes the record from the record column, whichever comes first; voucher alone is still the record", () => {
  assert.equal(readRecordsSheet("sequence,voucher,record\na,OMDL-1,inat:5\n").get("a")?.record, "inat:5");
  assert.equal(readRecordsSheet("sequence,voucher,observation\na,OMDL-1,mo:6\n").get("a")?.record, "mo:6");
  assert.equal(readRecordsSheet("sequence,voucher\na,OMDL-1\n").get("a")?.record, "OMDL-1");
});

test("the sheet's optional columns for the exports are read by their names or common other names, and an empty cell is no value", () => {
  const sheet = readRecordsSheet([
    "Sequence,Record,Name,Country,State,County,Locality,Decimal Latitude,Decimal Longitude,Date,Collector,Specimen Voucher,Isolate,Identified By,Forward Primer,Reverse Primer,Notes,GenBank Accession,Geo_Loc_Name",
    'a,inat:1,Russula,USA,Michigan,Marquette County,"Presque Isle Park, Marquette",46.58,-87.38,2026-07-18,A. Collector,MICH 1,MM-1,B. Person,ITS1F,ITS4,on moss,PQ000001,',
    "b,inat:1,Russula,,,,,,,,,,,,,,,,",
  ].join("\n"));
  assert.deepEqual(sheet.get("a"), {
    name: "Russula", readCount: null, record: "inat:1",
    details: {
      country: "USA", stateProvince: "Michigan", county: "Marquette County", locality: "Presque Isle Park, Marquette", latitude: "46.58", longitude: "-87.38",
      collectionDate: "2026-07-18", collectedBy: "A. Collector", specimenVoucher: "MICH 1", isolate: "MM-1", identifiedBy: "B. Person",
      fwdPrimer: "ITS1F", revPrimer: "ITS4", note: "on moss", accession: "PQ000001",
    },
  });
  assert.equal(sheet.get("b")?.details, undefined, "a row with every detail empty has none");
  // A sheet of collection details alone is a sheet; they ride on the sequences into the run.
  const only = readRecordsSheet("sequence\tcollection_date\na\t2026-07\n");
  assert.deepEqual(withRecords(readFasta(">a\nACGT\n"), only)[0].details, { collectionDate: "2026-07" });
});
