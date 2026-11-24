// The Darwin Core export (darwinCore.ts): one occurrence per validated record,
// under Darwin Core's own term names, with the identification fields naming
// the tool, its version and the databases' dates.
//   node --import tsx --test tool/darwinCore.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDarwinCore, DWC_COLUMNS } from "./darwinCore";
import { inTempDir, makeRunFolder } from "./exportFixture";
import { readRunFolder } from "./runFolder";

/** The Darwin Core terms (https://dwc.tdwg.org/list/, 2026-10-13) the export may use: none deprecated. */
const DARWIN_CORE_TERMS = new Set([
  "occurrenceID", "basisOfRecord", "catalogNumber", "recordedBy", "eventDate", "country", "stateProvince", "county", "locality",
  "decimalLatitude", "decimalLongitude", "kingdom", "scientificName", "previousIdentifications", "identifiedBy", "dateIdentified",
  "identificationReferences", "identificationRemarks", "associatedSequences",
]);

const load = (dir: string, opts = {}) => readRunFolder(makeRunFolder(dir, opts));

test("every column is a Darwin Core term, spelled as the standard spells it", () => {
  for (const c of DWC_COLUMNS) assert.ok(DARWIN_CORE_TERMS.has(c), `${c} is not a Darwin Core term`);
});

test("only validated records become occurrences: a held or rejected record has no name to give", () => inTempDir((dir) => {
  const dwc = buildDarwinCore(load(dir));
  assert.deepEqual(dwc.rows.map((r) => r.scientificName), ["Russula emetica", 'Cortinarius "sp-IN02"', "Amanita muscaria"]);
  assert.match(dwc.notes.join(" "), /2 records were not validated/);
  assert.equal(dwc.csv.split("\r\n")[0], DWC_COLUMNS.join(","));
}));

test("the identification names the tool and its version, the databases' dates (and Vision's model when it answered), the reason and the reads", () => inTempDir((dir) => {
  const [row, omdl] = buildDarwinCore(load(dir)).rows;
  assert.equal(row.identifiedBy, "MycoMap Validation 2.0.0-test");
  assert.equal(row.dateIdentified, "2026-11-20");
  assert.equal(row.identificationReferences, "MycoMap reference sequences 2026-11-20 (https://mycomap.org/data-downloads) | GenBank fungal ITS 2026-11-16 | BLAST+ 2.17.0 | MycoMap Vision vision-test-1, answers answers-test-1 | MycoMap Validation (https://github.com/BiodiverseLabs/mycomap-validation)");
  assert.equal(omdl.identificationReferences, "MycoMap reference sequences 2026-11-20 (https://mycomap.org/data-downloads) | GenBank fungal ITS 2026-11-16 | BLAST+ 2.17.0 | MycoMap Validation (https://github.com/BiodiverseLabs/mycomap-validation)", "Vision not asked: not named");
  assert.equal(row.identificationRemarks, "Validated as Russula emetica, carried by plate1-A01; second source: MycoMap Vision shows Russula emetica at 62%. ITS sequence plate1-A01: 92% confidence.");
  assert.equal(row.previousIdentifications, "Russula emetica", "the observer's identification");
  // A02 has a GenBank accession in the sheet; A01 is named as the FASTA names it.
  assert.equal(row.associatedSequences, "plate1-A01 | PQ000002");
  assert.equal(row.kingdom, "Fungi");
}));

test("GenBank not searched is said in the references, not left out", () => inTempDir((dir) => {
  const [row] = buildDarwinCore(load(dir, { ncbi: false })).rows;
  assert.match(row.identificationReferences, /\| GenBank fungal ITS not searched \|/);
}));

test("the occurrence comes from the sheet: place, date, collector, and the voucher making it a preserved specimen", () => inTempDir((dir) => {
  const [inat, omdl, mo] = buildDarwinCore(load(dir)).rows;
  assert.deepEqual(
    [inat.occurrenceID, inat.basisOfRecord, inat.catalogNumber, inat.recordedBy, inat.eventDate, inat.country, inat.stateProvince, inat.county, inat.locality, inat.decimalLatitude, inat.decimalLongitude],
    ["https://www.inaturalist.org/observations/1001", "PreservedSpecimen", "MICH 12345", "a-collector", "2026-07-18", "USA", "Michigan", "Marquette County", "Marquette", "46.5436", "-87.3954"],
  );
  // No voucher: the sequenced material. The country is the one its geo_loc_name starts with; a month stays a month.
  assert.deepEqual([omdl.occurrenceID, omdl.basisOfRecord, omdl.country, omdl.eventDate], ["OMDL-7", "MaterialSample", "Czechia", "2025-09"]);
  assert.equal(mo.occurrenceID, "https://mushroomobserver.org/obs/2002");
}));

test("what a row lacks is said record by record, and a date or coordinate that does not read is not written", () => inTempDir((dir) => {
  const sheet = "sequence,record,name,collection_date,latitude,longitude,country\nplate1-A01,inat:1001,Russula,18/07/2026,46.5,200,USA\n";
  const dwc = buildDarwinCore(load(dir, { sheet }));
  const row = dwc.rows[0];
  assert.deepEqual([row.eventDate, row.decimalLatitude, row.decimalLongitude], ["", "", ""]);
  assert.deepEqual(dwc.missing.find((m) => m.record === "inat:1001")?.missing, [
    'a collection date that reads as one ("18/07/2026": write 2026-07-18, 2026-07 or 2026)',
    'coordinates in decimal degrees ("46.5", "200")',
  ]);
  assert.deepEqual(dwc.missing.find((m) => m.record === "mo:2002")?.missing, ["collection date (column collection_date)", "country (column country)", "coordinates (columns latitude, longitude)"]);
}));
