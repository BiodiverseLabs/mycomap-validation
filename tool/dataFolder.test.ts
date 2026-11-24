// Finding the downloaded databases in the data folder, and saying what is
// missing and where to get it.
//   node --import tsx --test tool/dataFolder.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultDataFolder, findDataFiles, mycomapVersionOf } from "./dataFolder";
import { InputError } from "./fasta";

function folderWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmv-data-"));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test("the databases are found wherever they were unpacked under the folder; the newest names table is used; GenBank's date comes from its info.txt", () => {
  const dir = folderWith({
    "mycomap_db/mycomap.nin": "", "mycomap_db/mycomap.nsq": "",
    "mycomap_sequences_2026-11-19.tsv.gz": "", "mycomap_sequences_2026-11-20.tsv.gz": "",
    "ncbi_its_db/ncbi-its-blastdb-2026-11-15/genbank_its.nin": "",
    "ncbi_its_db/ncbi-its-blastdb-2026-11-15/refseq_its.nin": "",
    "ncbi_its_db/ncbi-its-blastdb-2026-11-15/info.txt": "Built:    2026-11-15 04:08:12 EST\nBLAST:    blastn: 2.6.0+\n",
  });
  try {
    const files = findDataFiles(dir, { ncbi: true });
    assert.equal(files.mycomapDb, path.join(dir, "mycomap_db", "mycomap"));
    assert.equal(path.basename(files.namesTable), "mycomap_sequences_2026-11-20.tsv.gz");
    assert.equal(mycomapVersionOf(files), "2026-11-20");
    assert.equal(mycomapVersionOf(files, "Database: MycoMap reference sequences 2026-11-21\n\t5 sequences"), "2026-11-21", "the database's own title wins");
    assert.equal(mycomapVersionOf({ ...files, namesTable: path.join(dir, "mycomap_sequences.tsv.gz") }), null, "a file saved from a latest link has no date in its name");
    assert.deepEqual(files.ncbiDbs!.map((d) => path.basename(d)), ["genbank_its", "refseq_its"]);
    assert.equal(files.ncbiVersion, "2026-11-15");
    assert.equal(findDataFiles(dir, { ncbi: false }).ncbiDbs, null, "--no-ncbi leaves GenBank out");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GenBank's database is optional: without it only MycoMap's sequences are searched", () => {
  const dir = folderWith({ "mycomap.nin": "", "mycomap_sequences_2026-11-20.tsv": "" });
  try {
    const files = findDataFiles(dir, { ncbi: true });
    assert.equal(files.ncbiDbs, null);
    assert.equal(files.ncbiVersion, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing folder, or missing files, are refused with which ones and where to download them", () => {
  const empty = folderWith({ "notes.txt": "" });
  try {
    assert.throws(() => findDataFiles(path.join(empty, "nowhere"), { ncbi: true }), (e: unknown) => e instanceof InputError && /does not exist\. Download the files from https:\/\/mycomap\.org\/data-downloads/.test(e.message));
    assert.throws(() => findDataFiles(empty, { ncbi: true }), (e: unknown) => e instanceof InputError
      && /the MycoMap BLAST database \(mycomap\.n\* files, from https:\/\/mycomap\.org\/api\/downloads\/latest\/mycomap-blastdb, unpacked\); and the names table/.test(e.message));
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("the data folder is MYCOMAP_VALIDATION_DATA when set, else mycomap-validation-data in the home folder", () => {
  assert.equal(defaultDataFolder({ MYCOMAP_VALIDATION_DATA: " D:/fungi/data " }), "D:/fungi/data");
  assert.equal(defaultDataFolder({}), path.join(os.homedir(), "mycomap-validation-data"));
});
