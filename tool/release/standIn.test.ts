// init can be pointed at a stand-in for mycomap.org (the release's first-run
// check, or an institution's mirror) with MYCOMAP_VALIDATION_DOWNLOADS, and
// BLAST+ at a copy of NCBI's folder with MYCOMAP_VALIDATION_BLAST_MIRROR,
// whose files must still be NCBI's own.
//   node --import tsx --test tool/release/standIn.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { blastBuild, blastSource } from "../blastPlus";
import { findDataFiles } from "../dataFolder";
import { DOWNLOADS_LIST, downloadsListUrl, runInit } from "../init";
import { tarGz } from "../testSupport";
import { downloadsList, startStandIn } from "./standIn";

test("with neither set, init reads mycomap.org's list and BLAST+ comes from NCBI", () => {
  assert.equal(downloadsListUrl({}), DOWNLOADS_LIST);
  assert.equal(downloadsListUrl({ MYCOMAP_VALIDATION_DOWNLOADS: "  " }), DOWNLOADS_LIST);
  assert.equal(blastSource({}), "https://ftp.ncbi.nlm.nih.gov/blast/executables/blast+/2.17.0/");
});

test("a mirror of NCBI's folder changes only where BLAST+ comes from, not its checksum", () => {
  assert.equal(blastSource({ MYCOMAP_VALIDATION_BLAST_MIRROR: "http://mirror.example/blast" }), "http://mirror.example/blast/");
  const ncbi = blastBuild("x64-linux", blastSource({}))!;
  const mirrored = blastBuild("x64-linux", "http://mirror.example/blast/")!;
  assert.equal(mirrored.url, "http://mirror.example/blast/ncbi-blast-2.17.0+-x64-linux.tar.gz");
  assert.equal(mirrored.sha256, ncbi.sha256);
  assert.equal(mirrored.bytes, ncbi.bytes);
});

function inTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmv-standin-"));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test("init sets the data folder up from the stand-in named in MYCOMAP_VALIDATION_DOWNLOADS, never from mycomap.org", () => inTemp(async (dir) => {
  const db = path.join(dir, "mycomap_blastdb_2026-11-21.tar.gz");
  fs.writeFileSync(db, tarGz([{ name: "mycomap.nin", body: "index" }, { name: "mycomap.nsq", body: "sequences" }]));
  const names = path.join(dir, "mycomap_sequences_2026-11-21.tsv.gz");
  fs.writeFileSync(names, "names");
  const standIn = await startStandIn({ mycomapVersion: "2026-11-21", mycomapDb: db, names });
  const before = process.env.MYCOMAP_VALIDATION_DOWNLOADS;
  const asked: string[] = [];
  try {
    process.env.MYCOMAP_VALIDATION_DOWNLOADS = standIn.env.MYCOMAP_VALIDATION_DOWNLOADS;
    const data = path.join(dir, "data");
    // No listUrl: the address comes from the environment, as for the downloaded tool.
    // Anything but the stand-in is refused before it is sent.
    const onlyStandIn = (async (input: any, init?: any) => {
      asked.push(String(input));
      if (!String(input).startsWith(`${standIn.base}/`)) throw new Error(`refused ${input}`);
      return fetch(input, init);
    }) as typeof fetch;
    const result = await runInit({ data, ncbi: true, blast: false, yes: true, fetch: onlyStandIn });
    assert.deepEqual(result.downloaded.map((d) => d.part), ["mycomap-db", "names"]);
    assert.ok(asked.every((u) => u.startsWith(standIn.base)), `everything came from the stand-in: ${asked.join(", ")}`);
    assert.deepEqual(standIn.requests, ["/api/downloads", "/files/mycomap_blastdb_2026-11-21.tar.gz", "/files/mycomap_sequences_2026-11-21.tsv.gz"]);
    const files = findDataFiles(data, { ncbi: true });
    assert.equal(path.basename(files.namesTable), "mycomap_sequences_2026-11-21.tsv.gz");
    assert.equal(fs.readFileSync(`${files.mycomapDb}.nsq`, "utf8"), "sequences");
  } finally {
    if (before === undefined) delete process.env.MYCOMAP_VALIDATION_DOWNLOADS;
    else process.env.MYCOMAP_VALIDATION_DOWNLOADS = before;
    await standIn.close();
  }
}));

test("the stand-in answers a Range request with the rest of the file, as a file server does, and names its files as mycomap.org's list does", () => inTemp(async (dir) => {
  const archive = path.join(dir, "ncbi-blast-2.17.0+-x64-linux.tar.gz");
  fs.writeFileSync(archive, "0123456789abcdef");
  const db = path.join(dir, "db.tar.gz");
  fs.writeFileSync(db, "db");
  const standIn = await startStandIn({ mycomapVersion: "2026-11-21", mycomapDb: db, names: db, blast: [archive] });
  try {
    const rest = await fetch(`${standIn.base}/blast/ncbi-blast-2.17.0+-x64-linux.tar.gz`, { headers: { Range: "bytes=10-" } });
    assert.equal(rest.status, 206);
    assert.equal(await rest.text(), "abcdef");
    const whole = await fetch(`${standIn.env.MYCOMAP_VALIDATION_BLAST_MIRROR}ncbi-blast-2.17.0%2B-x64-linux.tar.gz`);
    assert.equal(await whole.text(), "0123456789abcdef", "a + written as %2B is the same file");
    assert.equal((await fetch(`${standIn.base}/files/other.tar.gz`)).status, 404);
    const list = downloadsList(standIn.base, { mycomapVersion: "2026-11-21", mycomapDb: db, names: db });
    assert.deepEqual(list.latest.files.map((f) => f.id), ["mycomap-blastdb", "mycomap-sequences"]);
    assert.equal(list.latest.files[0].bytes, 2);
    assert.equal(list.latest.files[0].sha256, crypto.createHash("sha256").update("db").digest("hex"));
    assert.equal(list.ncbiIts, null);
  } finally {
    await standIn.close();
  }
}));
