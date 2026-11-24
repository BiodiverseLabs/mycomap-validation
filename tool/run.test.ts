// `mycomap-validation run` from start to finish: a FASTA file in, a name per
// sequence out, through the user's own BLAST+ and a names table. The searches
// run the real blastn and makeblastdb, so these tests are skipped (and say so)
// where BLAST+ is not installed.
//   node --import tsx --test tool/run.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";
import { databaseSearch, runProgram } from "./blast";
import { defaultOutFolder, main, parseArgs, summaryLine } from "./cli";
import { exportRun } from "./export";
import { InputError } from "./fasta";
import { engineSequenceId, engineVersion, isOnlySequence, RESULT_COLUMNS, resultsCsv, runValidation, type SequenceOutcome } from "./run";
import { serve } from "./testSupport";

// A key or address in the shell must never send these tests' records to MycoMap Vision.
delete process.env.MYCOMAP_VISION_KEY;
delete process.env.MYCOMAP_VISION_URL;

const hasBlast = spawnSync("blastn", ["-version"]).status === 0 && spawnSync("makeblastdb", ["-version"]).status === 0;
const needsBlast = hasBlast ? {} : { skip: "BLAST+ (blastn, makeblastdb) is not installed" };

/** A made-up ITS-length sequence, the same every run. */
function bases(seed: number, length = 560): string {
  let x = seed;
  let out = "";
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += "ACGT"[(x >> 16) & 3];
  }
  return out;
}
/** The sequence with a base changed every `every` positions. */
function changed(seq: string, every: number): string {
  return [...seq].map((c, i) => (i % every === every - 1 ? ({ A: "C", C: "G", G: "T", T: "A" } as Record<string, string>)[c] : c)).join("");
}

const COLUMNS = ["mm_id", "sequence_id", "name", "mycobank_number", "kingdom", "phylum", "class", "order", "family", "genus", "method", "on_validated_record", "in_reference_set", "reference_exclusion", "flags", "reads_in_consensus", "length", "genbank_accession", "observation", "observation_url", "updated_at"];

/**
 * A data folder as the Data Downloads page gives it: a MycoMap BLAST database
 * (made with the nightly build's makeblastdb arguments) and its names table.
 * Russula emetica has three sequences from three specimens; Russula nobilis
 * one, 10% different; Hypomyces (a mould on mushrooms) one.
 */
function dataFolder(dir: string, opts: { validated: boolean }): string {
  const data = path.join(dir, "data");
  fs.mkdirSync(path.join(data, "mycomap_db"), { recursive: true });
  const emetica = bases(1);
  const refs = [
    { id: 11, name: "Russula emetica", seq: emetica, genus: "Russula", family: "Russulaceae", obs: "inat:101" },
    { id: 12, name: "Russula emetica", seq: emetica, genus: "Russula", family: "Russulaceae", obs: "inat:102" },
    { id: 13, name: "Russula emetica", seq: emetica, genus: "Russula", family: "Russulaceae", obs: "mo:103" },
    { id: 14, name: "Russula nobilis", seq: changed(emetica, 10), genus: "Russula", family: "Russulaceae", obs: "inat:104" },
    { id: 15, name: "Hypomyces chrysospermus", seq: bases(7), genus: "Hypomyces", family: "Hypocreaceae", obs: "inat:105" },
  ];
  // makeblastdb cannot work inside a folder with a space in its name (BLAST+ splits paths at
  // spaces), so the database is made in a plain one and copied in. The tool never runs it.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "mmv-db-"));
  try {
    fs.writeFileSync(path.join(plain, "mycomap.fasta"), refs.map((r) => `>MM${r.id} ${r.name}
${r.seq}
`).join(""));
    const made = spawnSync("makeblastdb", ["-in", "mycomap.fasta", "-dbtype", "nucl", "-parse_seqids", "-blastdb_version", "5", "-title", "MycoMap reference sequences 2026-11-21", "-out", "mycomap"], { encoding: "utf8", cwd: plain });
    assert.equal(made.status, 0, made.stderr);
    for (const f of fs.readdirSync(plain)) if (f.startsWith("mycomap.n")) fs.copyFileSync(path.join(plain, f), path.join(data, "mycomap_db", f));
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
  const rows = refs.map((r) => COLUMNS.map((c) => ({
    mm_id: `MM${r.id}`, sequence_id: String(r.id), name: r.name, family: r.family, genus: r.genus, method: "ont",
    on_validated_record: opts.validated ? "yes" : "no", reads_in_consensus: "40", length: String(r.seq.length), observation: r.obs,
  } as Record<string, string>)[c] ?? "").join("\t"));
  fs.writeFileSync(path.join(data, "mycomap_sequences_2026-11-20.tsv.gz"), zlib.gzipSync(`${COLUMNS.join("\t")}\n${rows.join("\n")}\n`));
  return data;
}

function inTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmv run "));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const QUERIES = (emetica: string) => `>spec-1 ric=40\n${changed(emetica, 600).slice(5)}\n>spec-2\n${bases(99, 300)}\n`;

test("a sequence that matches three validated MycoMap specimens is named, and the results are stamped and written", needsBlast, () => inTemp(async (dir) => {
  const data = dataFolder(dir, { validated: true });
  const fasta = path.join(dir, "my sequences.fasta");
  fs.writeFileSync(fasta, QUERIES(bases(1)));
  fs.writeFileSync(path.join(dir, "records.csv"), "sequence,name\nspec-1,Russula emetica\n");
  const out = path.join(dir, "results");
  const said: string[] = [];
  const output = await runValidation({ fasta, records: path.join(dir, "records.csv"), data, out, threads: 1, ncbi: true, say: (l) => said.push(l), now: () => new Date("2026-11-20T12:00:00Z") });

  const [one, two] = output.sequences;
  assert.equal(one.result.finalSpecies, "Russula emetica");
  assert.ok((one.result.finalConfidence ?? 0) >= 80, `confidence ${one.result.finalConfidence}`);
  assert.equal(one.recordName, "Russula emetica");
  assert.equal(one.readCount, 40);
  assert.deepEqual(one.mycomapHits.slice(0, 3).map((h) => [h.name, h.validated, h.adjustedIdentity]), [["Russula emetica", true, 100], ["Russula emetica", true, 100], ["Russula emetica", true, 100]]);
  assert.equal(one.ncbiHits, null, "GenBank was not downloaded, so not searched");
  assert.equal(two.result.finalSpecies, null, "a sequence with no MycoMap hit gets no name");
  assert.equal(two.mycomapHitCount, 0);

  assert.deepEqual(output.stamp, {
    tool: "mycomap-validation", engineVersion: engineVersion(), ranAt: "2026-11-20T12:00:00.000Z", blast: output.stamp.blast, blastSource: "on the PATH",
    databases: { mycomap: { version: "2026-11-21", namesTable: "mycomap_sequences_2026-11-20.tsv.gz", rows: 5 }, ncbi: null },
    settings: { hitsPerSequence: 50, threads: 1 },
    vision: null,
  });
  assert.ok(said.some((l) => /GenBank's fungal ITS database is not in/.test(l)), "says GenBank was left out");

  const csv = fs.readFileSync(output.files.csv, "utf8").split("\r\n");
  assert.equal(csv[0], RESULT_COLUMNS.join(","));
  assert.match(csv[1], /^spec-1,Russula emetica,40,555,Russula emetica,\d+,,/);
  assert.match(csv[1], /,2026-11-21,not searched$/, "the database's date comes from its own title, not the names table's file name");
  const json = JSON.parse(fs.readFileSync(output.files.json, "utf8"));
  assert.equal(json.engineVersion, engineVersion());
  assert.equal(json.sequences[0].result.steps.length > 0, true);
  assert.equal(fs.existsSync(path.join(out, "query.fasta")), false, "the working copy of the FASTA is removed");
  assert.equal(fs.existsSync(output.files.mycomapBlast), true, "BLAST's own table is kept");

  // Each sequence is its own record here (no record column): spec-1's observer name is in the DNA genus.
  assert.deepEqual(output.records.map((r) => [r.record, r.decision, r.species]), [["spec-1", "validate", "Russula emetica"], ["spec-2", "held", null]]);
  assert.equal(output.records[0].secondSource, "the observer's identification (Russula emetica) is in Russula");
  assert.match(output.records[1].reason, /^No sequences finished with a usable species name/);
  const recordsCsvLines = fs.readFileSync(output.files.recordsCsv, "utf8").split("\r\n");
  assert.match(recordsCsvLines[1], /^spec-1,spec-1,Russula emetica,validate,Russula emetica,spec-1,spec-1,/);
  assert.equal(json.records.length, 2, "results.json holds the records too");

  // The inputs are kept in the results folder, so the exports need only the folder (export.ts).
  assert.deepEqual(output.inputFiles, { fasta: "input_my_sequences.fasta", records: "input_records.csv" });
  assert.deepEqual(json.inputFiles, output.inputFiles);
  assert.equal(fs.readFileSync(path.join(out, "input_my_sequences.fasta"), "utf8"), QUERIES(bases(1)));
  const exported = exportRun({ folder: out });
  const occurrence = fs.readFileSync(path.join(out, "darwin-core.csv"), "utf8").split("\r\n")[1];
  assert.ok(occurrence.startsWith(`spec-1,MaterialSample,,,,,,,,,,Fungi,Russula emetica,Russula emetica,MycoMap Validation ${engineVersion()},2026-11-20,`), occurrence);
  assert.match(exported.report, /spec-1: an isolate or specimen voucher .*; a location .*; a collection date/);
}));

test("the same hits on records that are not validated do not name the sequence", needsBlast, () => inTemp(async (dir) => {
  const data = dataFolder(dir, { validated: false });
  const fasta = path.join(dir, "q.fasta");
  fs.writeFileSync(fasta, QUERIES(bases(1)));
  const output = await runValidation({ fasta, data, out: path.join(dir, "out"), threads: 1, ncbi: false });
  const one = output.sequences[0];
  assert.equal(one.mycomapHitCount, 3, "the three Russula emetica reads (megablast finds no 28 matching bases in a row in the 10%-different nobilis)");
  assert.equal(one.mycomapHits[0].validated, false);
  assert.equal(one.result.finalSpecies, null);
}));

test("the command line runs end to end and says where the results are; a problem is said in words with exit code 1", needsBlast, () => inTemp(async (dir) => {
  const data = dataFolder(dir, { validated: true });
  const fasta = path.join(dir, "q.fasta");
  fs.writeFileSync(fasta, QUERIES(bases(1)));
  const printed: string[] = [];
  // `pnpm tool run q.fasta` runs in the repository's folder: the paths typed are read from where pnpm was run.
  const before = process.env.INIT_CWD;
  process.env.INIT_CWD = dir;
  try {
    assert.equal(await main(["run", "q.fasta", "--data", "data", "--threads", "1"], (l) => printed.push(l)), 0);
  } finally {
    if (before === undefined) delete process.env.INIT_CWD; else process.env.INIT_CWD = before;
  }
  assert.ok(printed.some((l) => /^  spec-1: Russula emetica \(\d+%\)$/.test(l)), printed.join("\n"));
  assert.ok(printed.some((l) => l === "  spec-2: no DNA name  [barcode gap check needed; no MycoMap hits]"), printed.join("\n"));
  assert.ok(fs.existsSync(path.join(dir, "q_mycomap-validation", "results.csv")));
  const refused: string[] = [];
  assert.equal(await main(["run", fasta, "--data", path.join(dir, "nowhere")], (l) => refused.push(l)), 1);
  assert.match(refused.join("\n"), /The data folder .* does not exist/);
}));

test("without a Vision key nothing is sent to MycoMap Vision; with one an inat: record is asked about by its number, and the results say what Vision answered; --no-vision turns it off", needsBlast, () => inTemp(async (dir) => {
  const data = dataFolder(dir, { validated: true });
  fs.writeFileSync(path.join(dir, "q.fasta"), QUERIES(bases(1)));
  fs.writeFileSync(path.join(dir, "sheet.csv"), "sequence,record,name\nspec-1,inat:1001,Russula emetica\nspec-2,OMDL-7,Russula\n");
  const usage = (used: number) => ({ plan: "member", used, limit: 300, period: "2026-11", resets_at: "2026-12-01T00:00:00Z" });
  const vision = await serve({}, {
    "GET /api/v1/usage": () => ({ status: 200, body: { usage: usage(4) } }),
    "POST /api/v1/identify/inat/1001": () => ({
      status: 200,
      body: {
        model: { name: "MycoMap Vision", version: "2026-11-15", answers_version: "av-test-1" }, gate: { verdict: "fungus" },
        ranks: { species: [{ name: "Russula emetica", confidence: 0.71 }], genus: [{ name: "Russula", confidence: 0.93 }], family: [{ name: "Russulaceae", confidence: 0.97 }] },
        usage: usage(5),
      },
    }),
  });
  const before = { ...process.env };
  process.env.INIT_CWD = dir;
  process.env.MYCOMAP_VISION_URL = vision.base;
  const run = async (args: string[]) => {
    const printed: string[] = [];
    assert.equal(await main(["run", "q.fasta", "--records", "sheet.csv", "--data", "data", "--threads", "1", ...args], (l) => printed.push(l)), 0, printed.join("\n"));
    return { printed, csv: fs.readFileSync(path.join(dir, "q_mycomap-validation", "records.csv"), "utf8").split("\r\n") };
  };
  try {
    const noKey = await run([]);
    assert.equal(vision.requests.length, 0, "no key: nothing asked, not even the quota");
    assert.ok(noKey.printed.includes("Records (as auto-validation would decide them; MycoMap Vision not asked: no key):"), noKey.printed.join("\n"));
    assert.match(noKey.csv[1], /,not asked: no Vision key was given,,,,/);

    process.env.MYCOMAP_VISION_KEY = "vision_test_key";
    const withKey = await run([]);
    assert.deepEqual(vision.requests.map((r) => `${r.method} ${r.path}`), ["GET /api/v1/usage", "POST /api/v1/identify/inat/1001"],
      "the quota, then the one record that is an observation (OMDL-7 has no number and no photos)");
    assert.ok(vision.requests.every((r) => r.headers?.authorization === "Bearer vision_test_key"));
    assert.deepEqual(JSON.parse(vision.requests[1].body!.toString()), { top_k: 5, use_place: true, use_date: true });
    assert.ok(withKey.printed.includes("Records (as auto-validation would decide them; MycoMap Vision answered 1 of the 1 it was asked about):"), withKey.printed.join("\n"));
    assert.ok(withKey.printed.includes("  Vision quota: 5 of 300 used, 295 left this month (2026-11); resets 2026-12-01 00:00 UTC."), withKey.printed.join("\n"));
    assert.match(withKey.csv[1], /^inat:1001,spec-1,Russula emetica,validate,Russula emetica,spec-1,spec-1,MycoMap Vision shows Russula emetica at 71%,/);
    assert.match(withKey.csv[1], /,answered \(by observation number\),Russula emetica 71%; genus Russula 93%; family Russulaceae 97%,2026-11-15,av-test-1,/);
    const jsonText = fs.readFileSync(path.join(dir, "q_mycomap-validation", "results.json"), "utf8");
    assert.deepEqual(JSON.parse(jsonText).vision, {
      url: vision.base, asked: 1, answered: 1, models: ["2026-11-15"], answersVersions: ["av-test-1"],
      usage: { plan: "member", used: 5, limit: 300, period: "2026-11", resetsAt: "2026-12-01T00:00:00Z" }, problem: null,
    });
    assert.doesNotMatch(jsonText, /vision_test_key/, "the key is never written down");

    await run(["--no-vision"]);
    assert.equal(vision.requests.length, 2, "--no-vision: nothing more asked");
  } finally {
    for (const k of ["INIT_CWD", "MYCOMAP_VISION_URL", "MYCOMAP_VISION_KEY"]) {
      if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
    }
    await vision.close();
  }
}));

test("the command line's arguments: run with options, help, and the mistakes it refuses with exit code 2", async () => {
  assert.deepEqual(parseArgs(["run", "a.fasta", "--records", "r.csv", "--data", "d", "--out", "o", "--threads", "8", "--no-ncbi", "--blast", "b"]),
    { command: "run", fasta: "a.fasta", records: "r.csv", data: "d", out: "o", threads: 8, ncbi: false, blast: "b" });
  assert.equal(parseArgs([]).command, "help");
  for (const argv of [["run", "--help"], ["init", "-h"], ["ui", "--help"], ["export", "folder", "--help"], ["contribute", "--help"], ["run", "a.fasta", "--no-ncbi", "--help"]]) {
    assert.equal(parseArgs(argv).command, "help", argv.join(" "));
  }
  assert.equal(parseArgs(["--version"]).command, "version");
  const refused = (argv: string[], words: RegExp) => assert.throws(() => parseArgs(argv), (e: unknown) => e instanceof InputError && words.test(e.message));
  refused(["validate"], /no "validate" command/);
  refused(["run"], /Say which FASTA file/);
  refused(["run", "a.fasta", "b.fasta"], /One FASTA file at a time/);
  refused(["run", "a.fasta", "--threads", "0"], /whole number of 1 or more/);
  refused(["run", "a.fasta", "--data"], /--data needs a value/);
  refused(["run", "a.fasta", "--fast"], /no --fast option/);
  const printed: string[] = [];
  assert.equal(await main(["run"], (l) => printed.push(l)), 2);
  assert.equal(await main(["help"], (l) => printed.push(l)), 0);
  assert.match(printed.join("\n"), /mycomap-validation run <sequences\.fasta> \[options\]/);
  assert.match(printed.join("\n"), /mycomap-validation contribute <run folder> \[options\]/, "every command is in the usage");
  assert.equal(await main(["run", "--help"], (l) => printed.push(l)), 0);
  assert.equal(await main(["--version"], (l) => printed.push(l)), 0);
  assert.equal(printed[printed.length - 1], `mycomap-validation ${engineVersion()}`);
});

test("the results go next to the FASTA file, in a folder named after it", () => {
  assert.equal(defaultOutFolder(path.join("D:", "fungi", "plate 7.fasta")), path.resolve("D:", "fungi", "plate 7_mycomap-validation"));
});

test("blastn is given database names and finds them on BLASTDB, so a folder with a space in its name cannot break the search", () => {
  const search = databaseSearch([path.join("C:", "my data", "ncbi its", "genbank_its"), path.join("C:", "my data", "ncbi its", "refseq_its"), path.join("C:", "my data", "mycomap")]);
  assert.deepEqual(search.names, ["genbank_its", "refseq_its", "mycomap"]);
  assert.equal(search.searchPath, [path.join("C:", "my data", "ncbi its"), path.join("C:", "my data")].join(path.delimiter));
});

test("results.csv quotes a field with a comma or a quote, and names a contaminant's likely name and GenBank's likely name in their own columns", () => {
  const outcome = {
    id: 'plate 7, "A1"', recordName: "Russula", readCount: null, length: 300,
    result: { finalSpecies: null, finalConfidence: null, flaggedContaminant: true, flaggedNonTarget: false, barcodeGapNeeded: false, noBlastHits: false, status: "complete", steps: [],
      contaminantLikelyName: { name: "Hypomyces chrysospermus" }, genbankLikelyName: { name: "Hypomyces rosellus", confidence: 62, likelyFamily: "Hypocreaceae", recordFamily: "Russulaceae", familyDiffers: true } },
    mycomapHits: [], ncbiHits: [], mycomapHitCount: 0, ncbiHitCount: 0,
  } as unknown as SequenceOutcome;
  const stamp = { engineVersion: "2.0.0-beta.7", databases: { mycomap: { version: "2026-11-20" }, ncbi: { version: "2026-11-15" } } } as never;
  const row = resultsCsv([outcome], stamp).split("\r\n")[1];
  assert.equal(row, '"plate 7, ""A1""",Russula,,300,,,contaminant,Hypomyces chrysospermus,Hypomyces rosellus,GenBank points to Hypocreaceae; the record is Russulaceae: possibly a specimen switch or an off-target read.,,0,,,0,,,2.0.0-beta.7,2026-11-20,2026-11-15');
  assert.equal(summaryLine(outcome), '  plate 7, "A1": no DNA name  [contaminant; likely Hypomyces chrysospermus; GenBank suggests Hypomyces rosellus (62%)]');
});

test("run uses the BLAST+ init installed in the data folder, one named with --blast before it, and says which in the results", () => inTemp(async (dir) => {
  const data = path.join(dir, "data");
  fs.mkdirSync(path.join(data, "mycomap", "2026-11-20"), { recursive: true });
  fs.writeFileSync(path.join(data, "mycomap", "2026-11-20", "mycomap.nin"), "");
  fs.writeFileSync(path.join(data, "mycomap_sequences_2026-11-20.tsv.gz"), zlib.gzipSync(`${COLUMNS.join("\t")}\n`));
  fs.mkdirSync(path.join(data, "blast", "2.17.0"), { recursive: true });
  fs.writeFileSync(path.join(data, "blast", "2.17.0", process.platform === "win32" ? "blastn.exe" : "blastn"), "");
  const fasta = path.join(dir, "q.fasta");
  fs.writeFileSync(fasta, ">a\nACGTACGTAC\n");
  const started: string[] = [];
  // Stands in for BLAST+: answers -version and -info, and writes an empty table for a search.
  const run = async (program: string, args: string[], place: { cwd?: string } = {}) => {
    started.push(program);
    if (args.includes("-version")) return { code: 0, stdout: "blastn: 2.17.0+", stderr: "" };
    if (args.includes("-info")) return { code: 0, stdout: "Database: MycoMap reference sequences 2026-11-20\n", stderr: "" };
    fs.writeFileSync(path.join(place.cwd!, args[args.indexOf("-out") + 1]), "");
    return { code: 0, stdout: "", stderr: "" };
  };
  const installed = await runValidation({ fasta, data, out: path.join(dir, "out1"), threads: 1, ncbi: false, run });
  assert.equal(installed.stamp.blastSource, "installed by init");
  assert.deepEqual([...new Set(started.map((p) => path.relative(data, p).split(path.sep).join("/")))], ["blast/2.17.0/blastn", "blast/2.17.0/blastdbcmd"]);
  started.length = 0;
  const named = await runValidation({ fasta, data, out: path.join(dir, "out2"), threads: 1, ncbi: false, run, blastFolder: "D:/my blast/bin" });
  assert.equal(named.stamp.blastSource, "named with --blast");
  assert.deepEqual([...new Set(started)], ["D:/my blast/bin/blastn", "D:/my blast/bin/blastdbcmd"]);
}));

test("BLAST+ is told not to report its use to NCBI, so nothing leaves the computer", needsBlast, () => inTemp(async (dir) => {
  const data = dataFolder(dir, { validated: true });
  fs.writeFileSync(path.join(dir, "q.fasta"), QUERIES(bases(1)));
  // blastn's trace log says whether it will report ("Phone home enabled" when nothing stops it).
  const answer = await runProgram("blastn", ["-query", "q.fasta", "-db", "mycomap", "-outfmt", "6", "-out", "hits.tsv"], {
    cwd: dir, env: { BLASTDB: path.join(data, "mycomap_db"), DIAG_TRACE: "1", DIAG_POST_LEVEL: "Trace", BLAST_USAGE_REPORT: "true" },
  });
  assert.equal(answer.code, 0, answer.stderr);
  assert.match(answer.stderr, /Phone home disabled/, "even when the user's own setting says true");
  assert.doesNotMatch(answer.stderr, /Phone home enabled/);
}));

test("a sequence that is one of MycoMap's own goes in by its MycoMap id, so its own read and its specimen's other reads are not counted as support for itself", () => {
  const records = new Map([["MM854648", { id: "MM854648" }]]) as never;
  assert.equal(engineSequenceId("MM854648", records), "MM854648");
  assert.equal(engineSequenceId("854648", records), "MM854648", "a bare MycoMap number, when that sequence is among the hits");
  assert.equal(engineSequenceId("854649", records), "query:854649", "a number MycoMap's hits do not have is the user's own");
  assert.equal(engineSequenceId("plate7-A01", records), "query:plate7-A01");
  assert.equal(engineSequenceId("edna-5", records), "query:edna-5", "never taken for one of the server's eDNA uploads");
});

test("a sequence is its record's only one unless the sheet gives another sequence the same record", () => {
  const s = (id: string, record: string | null) => ({ id, record }) as never;
  const all = [s("a", "R1"), s("b", "R1"), s("c", "R2"), s("d", null)];
  assert.deepEqual(all.map((x) => isOnlySequence(x, all)), [false, false, true, true]);
});

test("run on one of MycoMap's own sequences leaves out its own read; two reads of one record keep the low read count penalty", needsBlast, () => inTemp(async (dir) => {
  const data = dataFolder(dir, { validated: true });
  const emetica = bases(1);
  const fasta = path.join(dir, "q.fasta");
  // MM11 is in the database: run as itself, its own hit (and nothing else of inat:101) is left out.
  fs.writeFileSync(fasta, `>MM11 ric=3\n${emetica}\n>new-1 ric=3\n${emetica}\n>new-2 ric=3\n${emetica}\n>new-3 ric=3\n${emetica}\n`);
  fs.writeFileSync(path.join(dir, "records.csv"), "sequence,name,record\nMM11,Russula emetica,\nnew-1,Russula emetica,\nnew-2,Russula emetica,R7\nnew-3,Russula emetica,R7\n");
  const output = await runValidation({ fasta, records: path.join(dir, "records.csv"), data, out: path.join(dir, "out"), threads: 1, ncbi: false });
  const filtering = (i: number) => output.sequences[i].result.steps.find((st) => st.step === "Local Hit Analysis - Filtering")?.message ?? "";
  assert.match(filtering(0), /^Found 2 validated hits/, "MycoMap's own MM11 does not support itself");
  assert.match(filtering(1), /^Found 3 validated hits/, "a new sequence counts all three specimens");
  const waived = (i: number) => output.sequences[i].result.confidenceBreakdown?.ricPenaltyWaived;
  assert.equal(waived(1), true, "the only sequence of its record, genus matching: the low read count is waived");
  assert.equal(waived(2), false, "one of two reads of record R7: the penalty stands");
  assert.ok((output.sequences[2].result.finalConfidence ?? 0) < (output.sequences[1].result.finalConfidence ?? 0));
}));

test("run keeps sequences.fasta (the cleaned sequences); a read nothing names, on a record nothing validated, gets a local name in results.json, results.csv and records.csv; nothing is sent to mycomap.org, even with a member key set", needsBlast, () => inTemp(async (dir) => {
  const data = dataFolder(dir, { validated: true });
  const e = bases(1);
  // A Russula nothing in MycoMap names: long stretches of emetica, with its middle changed.
  const unnamed = e.slice(0, 150) + changed(e.slice(150, 410), 4) + e.slice(410);
  const fasta = path.join(dir, "plate7.fasta");
  fs.writeFileSync(fasta, `>spec-1 ric=40\n${e.slice(0, 300)}\n${e.slice(300).toLowerCase()}\n>new-1\n${unnamed}\n>junk\n${bases(99, 300)}\n>stray\n${unnamed}\n`);
  fs.writeFileSync(path.join(dir, "sheet.csv"), "sequence,record,name\nspec-1,inat:1,Russula emetica\nnew-1,inat:2,Russula\njunk,inat:3,Russula\nstray,inat:1,Russula emetica\n");
  const out = path.join(dir, "out");
  const site = await serve({}, { "/api/contributions": () => ({ status: 202, body: { id: "C-1" } }) });
  const saved = { key: process.env.MYCOMAP_MEMBER_KEY, url: process.env.MYCOMAP_SITE_URL };
  process.env.MYCOMAP_MEMBER_KEY = "mm_member_test_key";
  process.env.MYCOMAP_SITE_URL = site.base;
  const printed: string[] = [];
  try {
    assert.equal(await main(["run", fasta, "--records", path.join(dir, "sheet.csv"), "--data", data, "--out", out, "--threads", "1"], (l) => printed.push(l)), 0, printed.join("\n"));
  } finally {
    process.env.MYCOMAP_MEMBER_KEY = saved.key;
    process.env.MYCOMAP_SITE_URL = saved.url;
    if (saved.key === undefined) delete process.env.MYCOMAP_MEMBER_KEY;
    if (saved.url === undefined) delete process.env.MYCOMAP_SITE_URL;
    await site.close();
  }
  assert.equal(site.requests.length, 0, "run sends nothing to mycomap.org");

  assert.equal(fs.readFileSync(path.join(out, "sequences.fasta"), "utf8"), `>spec-1\n${e}\n>new-1\n${unnamed}\n>junk\n${bases(99, 300)}\n>stray\n${unnamed}\n`, "one line of upper-case bases each");
  assert.equal(fs.existsSync(path.join(out, "query.fasta")), false);
  const json = JSON.parse(fs.readFileSync(path.join(out, "results.json"), "utf8"));
  const localOf = (id: string) => json.sequences.find((s: SequenceOutcome) => s.id === id).localName;
  assert.equal(localOf("new-1"), "Russula sp. 'local-new-1'", "the base is the genus its closest hits agree on");
  assert.equal(localOf("spec-1"), null, "a named read has no local name");
  assert.equal(localOf("junk"), null, "a read nothing resembles has nothing to be named from");
  assert.equal(localOf("stray"), null, "a stray read on a validated record is no new name");
  assert.deepEqual(json.records.map((r: any) => [r.record, r.decision, r.newName]), [["inat:1", "validate", null], ["inat:2", "held", "Russula sp. 'local-new-1'"], ["inat:3", "held", null]]);
  const results = fs.readFileSync(path.join(out, "results.csv"), "utf8").split("\r\n");
  const at = results[0].split(",").indexOf("new_name");
  assert.ok(at > 0);
  assert.equal(results[2].split(",")[0], "new-1");
  assert.ok(results[2].includes(",Russula sp. 'local-new-1',"));
  assert.match(fs.readFileSync(path.join(out, "records.csv"), "utf8"), /\r\ninat:2,new-1,Russula,held,.*,Russula sp. 'local-new-1',/);
  assert.ok(printed.some((l) => /^One read has a local name \(Genus sp\. 'local-<read>'\).*mycomap-validation contribute /.test(l)), printed.join("\n"));
  assert.ok(printed.includes("  sequences.fasta  the sequences as the tool read them (what contribute sends)"));
}));

test("run will not overwrite the FASTA file it reads with its sequences.fasta", () => inTemp(async (dir) => {
  const fasta = path.join(dir, "sequences.fasta");
  fs.writeFileSync(fasta, `>a ric=40\n${bases(1)}\n`);
  await assert.rejects(runValidation({ fasta, data: dir, out: dir, threads: 1, ncbi: false, run: async () => ({ code: 0, stdout: "blastn: 2.17.0+", stderr: "" }) }),
    (e: unknown) => e instanceof InputError && /keeps its sequences as sequences\.fasta in the results folder, and that is the FASTA file being read/.test(e.message));
  assert.equal(fs.readFileSync(fasta, "utf8"), `>a ric=40\n${bases(1)}\n`);
}));
