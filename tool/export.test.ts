// `mycomap-validation export`: a run folder in, the files to submit or share
// out (export.ts), read back from what the run kept (runFolder.ts, inputs.ts).
// The run folders are made by hand (exportFixture.ts), so no BLAST is needed;
// run.test.ts exports a real run's folder.
//   node --import tsx --test tool/export.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main, parseArgs } from "./cli";
import { EXPORT_FORMATS, exportRun, parseFormats, REPORT_FILE } from "./export";
import { FIXTURE_FASTA, FIXTURE_SHEET, inTempDir, makeRunFolder } from "./exportFixture";
import { InputError } from "./fasta";
import { keepInputs } from "./inputs";
import { readRunFolder, recordDetails, recordLink } from "./runFolder";

const ALL_FILES = ["darwin-core.csv", "genbank.fasta", "genbank-source.tsv", "inaturalist.txt", REPORT_FILE];

test("export writes every file into the run folder and says in the terminal what each holds", () => inTempDir(async (dir) => {
  const folder = makeRunFolder(dir);
  const printed: string[] = [];
  assert.equal(await main(["export", folder], (l) => printed.push(l)), 0);
  for (const f of ALL_FILES) assert.ok(fs.existsSync(path.join(folder, f)), `${f} is written`);
  assert.deepEqual(printed.slice(0, 3), [
    "darwin-core.csv: 3 occurrences; 2 lack facts the sheet could add.",
    "genbank.fasta, genbank-source.tsv: 2 of 3 validated records; 1 left out until the sheet gives what NCBI requires.",
    "inaturalist.txt: fields and a comment for 2 records, to paste. Nothing is sent.",
  ]);
  assert.match(printed.join("\n"), /export-report\.txt says what was left out and why/);
}));

test("the report says, record by record, what the sheet must add for GenBank, and stamps the run", () => inTempDir((dir) => {
  const out = exportRun({ folder: makeRunFolder(dir) });
  assert.match(out.report, /^Exports from the run in .*plate1_mycomap-validation\nMycoMap Validation 2\.0\.0-test; MycoMap reference sequences 2026-11-20; GenBank fungal ITS 2026-11-16; run 2026-11-20 16:25 UTC\n5 records, 3 validated\. Sequences from input_plate1\.fasta; records sheet input_plate1_sheet\.csv\./);
  assert.match(out.report, /Left out: add these to the records sheet, then export again with --records <sheet>:\n  mo:2002 \(plate1-C01\): a location \(column country.*\); a collection date \(column collection_date/);
  assert.equal(fs.readFileSync(path.join(out.out, REPORT_FILE), "utf8"), out.report);
}));

test("--format writes only the files asked for; --out writes them elsewhere and leaves the run folder as it was", () => inTempDir(async (dir) => {
  const folder = makeRunFolder(dir);
  assert.equal(await main(["export", folder, "--format", "genbank", "--out", path.join(dir, "for-ncbi")], () => undefined), 0);
  assert.deepEqual(fs.readdirSync(path.join(dir, "for-ncbi")).sort(), ["export-report.txt", "genbank-source.tsv", "genbank.fasta"]);
  assert.ok(!fs.existsSync(path.join(folder, "genbank.fasta")));
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "for-ncbi", REPORT_FILE), "utf8"), /DARWIN CORE|INATURALIST/);
  assert.deepEqual(parseFormats("dwc, iNaturalist,dwc"), ["dwc", "inat"]);
  assert.deepEqual(parseFormats("all"), [...EXPORT_FORMATS]);
}));

test("a sheet named at export time takes the run's own sheet's place, so details can be added after the run", () => inTempDir(async (dir) => {
  const folder = makeRunFolder(dir);
  const later = path.join(dir, "filled in.csv");
  fs.writeFileSync(later, `${FIXTURE_SHEET.trimEnd()}\n`.replace("plate1-C01,mo:2002,Amanita,,,,,,,,,,,,,", "plate1-C01,mo:2002,Amanita,Canada,Ontario,,,,,2024-08-02,,,,,,"));
  assert.match(exportRun({ folder, formats: ["genbank"] }).summary[0], /: 2 of 3 validated records; 1 left out/, "with the run's own sheet");
  assert.equal(await main(["export", folder, "--records", later, "--format", "genbank"], () => undefined), 0);
  const tsv = fs.readFileSync(path.join(folder, "genbank-source.tsv"), "utf8");
  assert.match(tsv, /\nplate1-C01\tAmanita muscaria\tmo:2002\t\tCanada: Ontario\t\t02-Aug-2024\t/);
  const report = fs.readFileSync(path.join(folder, REPORT_FILE), "utf8");
  assert.match(report, /records sheet filled in\.csv\./);
  assert.match(report, /genbank-source\.tsv: 3 of 3 validated records\.\n/);
}));

test("a run from the browser app of an earlier version is found by the names its files were chosen under", () => inTempDir((dir) => {
  const run = readRunFolder(makeRunFolder(dir, { inputs: "browser" }));
  assert.equal(path.basename(run.sources.fasta), "input_plate_1.fasta");
  assert.equal(path.basename(run.sources.records!), "input_sheet.csv");
  assert.equal(run.reads.get("plate1-A01")?.details.country, "USA");
}));

test("a run that kept no FASTA file asks for --fasta, and takes it; a FASTA without the run's sequences is refused", () => inTempDir(async (dir) => {
  const folder = makeRunFolder(dir, { inputs: "none" });
  const printed: string[] = [];
  assert.equal(await main(["export", folder], (l) => printed.push(l)), 1);
  assert.match(printed.join("\n"), /did not keep its FASTA file .*Name it with --fasta <file>\./);
  const fasta = path.join(dir, "plate1.fasta");
  fs.writeFileSync(fasta, FIXTURE_FASTA);
  assert.equal(await main(["export", folder, "--fasta", fasta], () => undefined), 0);
  // No sheet: nothing says where or when, so GenBank gets nothing, and the report says why.
  assert.equal(fs.readFileSync(path.join(folder, "genbank.fasta"), "utf8"), "");
  fs.writeFileSync(fasta, ">other\nACGT\n");
  const wrong: string[] = [];
  assert.equal(await main(["export", folder, "--fasta", fasta], (l) => wrong.push(l)), 1);
  assert.match(wrong.join("\n"), /plate1\.fasta does not have 6 of the sequences the run named \(plate1-A01, plate1-A02, plate1-B01, plate1-C01, plate1-D01, …\)\. Is it the FASTA file the run was made from\?/);
}));

test("what is not a run folder, or a sheet naming reads the run does not have, is refused in words", () => inTempDir(async (dir) => {
  const printed: string[] = [];
  assert.equal(await main(["export", dir], (l) => printed.push(l)), 1);
  assert.match(printed.join("\n"), /is not a run folder: it has no results\.json/);
  const folder = makeRunFolder(dir);
  const sheet = path.join(dir, "s.csv");
  fs.writeFileSync(sheet, "sequence,country\nplate9-H12,USA\n");
  assert.throws(() => exportRun({ folder, records: sheet }), (e: unknown) => e instanceof InputError && /lists a sequence the run does not have: plate9-H12/.test(e.message));
}));

test("export's arguments, and the mistakes it refuses with exit code 2", async () => {
  assert.deepEqual(parseArgs(["export", "f", "--format", "dwc,inat", "--records", "r.csv", "--fasta", "a.fasta", "--out", "o"]),
    { command: "export", ncbi: true, folder: "f", formats: ["dwc", "inat"], records: "r.csv", fasta: "a.fasta", out: "o" });
  const refused = (argv: string[], words: RegExp) => assert.throws(() => parseArgs(argv), (e: unknown) => e instanceof InputError && words.test(e.message));
  refused(["export"], /Say which run folder to export/);
  refused(["export", "a", "b"], /One run folder at a time/);
  refused(["export", "a", "--format", "csv"], /--format takes dwc, genbank, inat or all/);
  refused(["export", "a", "--format"], /--format needs a value/);
  refused(["export", "a", "--threads", "2"], /export has no --threads option/);
  const printed: string[] = [];
  assert.equal(await main(["export", "a", "--format", "pdf"], (l) => printed.push(l)), 2);
  assert.equal(await main(["help"], (l) => printed.push(l)), 0);
  assert.match(printed.join("\n"), /mycomap-validation export <run folder> \[options\]/);
});

test("a record's details are its standing read's, with the gaps filled from its other reads", () => inTempDir((dir) => {
  const run = readRunFolder(makeRunFolder(dir));
  const d = recordDetails(run, run.records[0]);
  assert.equal(d.country, "USA");
  assert.equal(d.accession, "PQ000002", "only A02 has one");
  assert.equal(d.fwdPrimer, "ITS1F");
}));

test("a record's address: iNaturalist and Mushroom Observer, by prefix or by address; anything else has none", () => {
  assert.equal(recordLink("inat:1234567").url, "https://www.inaturalist.org/observations/1234567");
  assert.equal(recordLink("iNat 123").url, "https://www.inaturalist.org/observations/123");
  assert.equal(recordLink("https://www.inaturalist.org/observations/77").number, "77");
  assert.equal(recordLink("MO:55").url, "https://mushroomobserver.org/obs/55");
  assert.deepEqual(recordLink("OMDL-1234"), { platform: null, number: null, url: null });
});

test("a run keeps its FASTA file and sheet in its folder, copied unless they are there already", () => inTempDir((dir) => {
  const out = path.join(dir, "out");
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(dir, "my reads.fasta"), ">a\nACGT\n");
  fs.writeFileSync(path.join(dir, "sheet.tsv"), "sequence\tcountry\na\tUSA\n");
  assert.deepEqual(keepInputs(path.join(dir, "my reads.fasta"), path.join(dir, "sheet.tsv"), out), { fasta: "input_my_reads.fasta", records: "input_sheet.tsv" });
  assert.equal(fs.readFileSync(path.join(out, "input_my_reads.fasta"), "utf8"), ">a\nACGT\n");
  fs.writeFileSync(path.join(out, "input_x.fasta"), ">b\nACGT\n");
  assert.deepEqual(keepInputs(path.join(out, "input_x.fasta"), null, out), { fasta: "input_x.fasta", records: null });
  assert.equal(fs.readdirSync(out).length, 3, "a file already in the folder is not copied again");
}));
