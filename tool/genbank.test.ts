// The GenBank submission files (genbank.ts, with genbankRules.ts): the FASTA
// file and source table NCBI's Submission Portal takes, in mycomap.org's
// shape, and every record left out with all it lacks.
//   node --import tsx --test tool/genbank.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureBases, inTempDir, makeRunFolder } from "./exportFixture";
import { buildGenbank, SOURCE_MODIFIER_HEADER } from "./genbank";
import { composeNote, formatCollectionDate, formatLatLon, formatOrganism, normalizeGeoLocName, toAscii, trimAmbiguousEnds } from "./genbankRules";
import { readRunFolder } from "./runFolder";

const load = (dir: string, opts = {}) => readRunFolder(makeRunFolder(dir, opts));

test("a validated record with everything NCBI requires is one line: the read that stands for it, in mycomap.org's columns", () => inTempDir((dir) => {
  const gb = buildGenbank(load(dir));
  assert.equal(gb.tsv.split("\n")[0], SOURCE_MODIFIER_HEADER.join("\t"));
  assert.deepEqual(gb.lines[0].columns, {
    Sequence_ID: "plate1-A01",
    organism: "Russula emetica",
    isolate: "inat:1001",
    specimen_voucher: "MICH 12345",
    geo_loc_name: "USA: Michigan, Marquette County, Marquette",
    lat_lon: "46.5436 N 87.3954 W",
    collection_date: "18-Jul-2026",
    collected_by: "a-collector",
    fwd_primer_name: "ITS1F",
    rev_primer_name: "ITS4",
    note: "Identified by MycoMap Validation 2.0.0-test; RiC 40",
  });
  assert.ok(gb.fasta.startsWith(`>plate1-A01\n${fixtureBases(1)}\n>plate1-B01\n`), "the FASTA file holds the same reads, by the same Sequence_ID");
}));

test("a provisional name, a geo_loc_name with an older country name and a month go as NCBI takes them; a Sanger read has no RiC", () => inTempDir((dir) => {
  const line = buildGenbank(load(dir)).lines.find((l) => l.record === "OMDL-7")!;
  assert.equal(line.columns.organism, "Cortinarius sp. 'IN02'");
  assert.equal(line.columns.geo_loc_name, "Czechia: Sumava");
  assert.equal(line.columns.collection_date, "Sep-2025");
  assert.equal(line.columns.isolate, "OMDL-7", "with no isolate column, the record is the isolate");
  assert.equal(line.columns.note, "Identified by MycoMap Validation 2.0.0-test");
}));

test("a record without what NCBI requires is left out, with everything it lacks; held and rejected records are never in", () => inTempDir((dir) => {
  const gb = buildGenbank(load(dir));
  assert.deepEqual(gb.lines.map((l) => l.record), ["inat:1001", "OMDL-7"]);
  assert.deepEqual(gb.leftOut, [{
    record: "mo:2002", sequence: "plate1-C01",
    missing: ["a location (column country, with state_province, county and locality; or geo_loc_name)", "a collection date (column collection_date: 2026-07-18, 2026-07 or 2026)"],
  }]);
  assert.match(gb.notes.join(" "), /2 records were not validated/);
}));

test("with no record and no isolate or voucher there is nothing to tell NCBI's sources apart, and a bad country or date is named", () => inTempDir((dir) => {
  const sheet = "sequence,name,geo_loc_name,collection_date\nplate1-B01,Cortinarius,Bohemia: Sumava,yesterday\n";
  const gb = buildGenbank(load(dir, { sheet }));
  const omdl = gb.leftOut.find((l) => l.sequence === "plate1-B01");
  // The fixture's results still name the record OMDL-7, so the isolate is there; the place and the date are not.
  assert.deepEqual(omdl?.missing, [
    `a location NCBI takes: "Bohemia" is not on NCBI's country list; use NCBI's name (e.g. USA, Czechia, Russia, Viet Nam)`,
    `a collection date NCBI takes ("yesterday" is not one: write 2026-07-18, 2026-07 or 2026)`,
  ]);
  const own = buildGenbank(load(dir, { sheet: "sequence,name\nplate1-E01,x\n" }));
  assert.equal(own.lines.length, 0);
}));

test("a read named by its record (no record column) has no isolate, so NCBI's isolate or voucher is asked for", () => inTempDir((dir) => {
  const run = load(dir);
  const record = { ...run.records[0], record: "plate1-A01" };
  run.reads.get("plate1-A01")!.details = { country: "USA", collectionDate: "2026-07-18" };
  run.reads.get("plate1-A02")!.details = {};
  const gb = buildGenbank({ ...run, records: [record] });
  assert.deepEqual(gb.leftOut[0].missing, ["an isolate or specimen voucher (column isolate or specimen_voucher; or a record column, whose name is then the isolate)"]);
}));

test("a Sequence_ID NCBI would refuse is left out with the rule; two reads of one specimen get numbered isolates", () => inTempDir((dir) => {
  const run = load(dir);
  const long = "x".repeat(50);
  run.reads.set(long, run.reads.get("plate1-A01")!);
  const gb = buildGenbank({ ...run, records: [{ ...run.records[0], selectedSequenceId: long }, run.records[0], { ...run.records[0], selectedSequenceId: "plate1-A02" }] });
  assert.match(gb.leftOut[0].missing[0], /a Sequence_ID NCBI takes: rename the read "x{50}"/);
  assert.deepEqual(gb.lines.map((l) => [l.columns.Sequence_ID, l.columns.isolate, l.columns.specimen_voucher]), [
    ["plate1-A01", "inat:1001", "MICH 12345"],
    ["plate1-A02", "inat:1001(2)", "MICH 12345(2)"],
  ]);
}));

test("what goes but is worth checking is said: ASCII, the collector's label, trimmed ends, a short or repeated sequence", () => inTempDir((dir) => {
  const run = load(dir);
  run.reads.get("plate1-A01")!.bases = `NR${"ACGT".repeat(40)}`;
  run.reads.get("plate1-A02")!.bases = `NR${"ACGT".repeat(40)}`;
  const gb = buildGenbank({ ...run, records: [run.records[0], { ...run.records[0], selectedSequenceId: "plate1-A02" }, run.records[1]] });
  const said = gb.warnings.map((w) => `${w.sequence}: ${w.message}`);
  assert.ok(said.includes("plate1-A01: 160 bases: NCBI asks for at least 200"), said.join("\n"));
  assert.ok(said.includes("plate1-A01: trimmed 2 from the start (NR): ambiguous bases at the ends"));
  assert.ok(said.includes('plate1-A01: collected_by sent without "iNaturalist User": "a-collector"'));
  assert.ok(said.includes("plate1-A02: the same bases as plate1-A01 (a duplicate sequence)"));
  assert.ok(said.includes(`plate1-B01: geo_loc_name sent as "Czechia: Sumava" (NCBI's name for the country, plain ASCII)`));
  assert.equal(gb.lines[0].sequence, "ACGT".repeat(40));
}));

// ── The text rules, as mycomap.org's export applies them ──

test("NCBI's text rules: ASCII, provisional names, dates, coordinates, countries and territories", () => {
  assert.equal(toAscii("São Tomé – Łódź").text, "Sao Tome - Lodz");
  assert.equal(formatOrganism('Russula "sp-IN01"'), "Russula sp. 'IN01'");
  assert.equal(formatOrganism("Russula emetica"), "Russula emetica");
  assert.deepEqual(["2026-07-18", "2026-07", "2026", "1956-01-00", "2026-02-30", "18 July"].map(formatCollectionDate), ["18-Jul-2026", "Jul-2026", "2026", "Jan-1956", "", ""]);
  assert.equal(formatLatLon("-33.8688", "151.2093"), "33.8688 S 151.2093 E");
  assert.equal(formatLatLon("0", "0"), "");
  assert.deepEqual(normalizeGeoLocName("United States: Michigan"), { value: "USA: Michigan", problem: null });
  assert.deepEqual(normalizeGeoLocName("USA: Puerto Rico, Rio Grande"), { value: "Puerto Rico: Rio Grande", problem: null });
  assert.deepEqual(normalizeGeoLocName("Ontario", "CA"), { value: "Canada: Ontario", problem: null });
  assert.equal(composeNote({ note: "Sanger; Sanger; RiC 9", identifiedBy: "A. Person", ric: 40 }), "Sanger; Identified by A. Person; RiC 40");
  assert.deepEqual(trimAmbiguousEnds("ACNTACGTACGTACGTACGTRA"), { sequence: "TACGTACGTACGTACGT", trimmedStart: "ACN", trimmedEnd: "RA", problem: null });
});
