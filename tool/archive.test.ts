// Unpacking the downloaded archives: every file arrives whole, and an archive
// that would write outside its folder, or is cut short, is refused.
//   node --import tsx --test tool/archive.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { ArchiveError, unpackTarGz } from "./archive";
import { tarGz } from "./testSupport";

function inTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmv archive "));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test("files, folders, an empty file, a long GNU name and a file larger than one read all arrive whole", () => inTemp(async (dir) => {
  const big = crypto.randomBytes(3 * 1024 * 1024 + 17);
  const longName = `ncbi-its-blastdb-2026-11-15/${"a".repeat(120)}.txt`;
  const archive = path.join(dir, "db.tar.gz");
  fs.writeFileSync(archive, tarGz([
    { name: "ncbi-its-blastdb-2026-11-15/" },
    { name: "ncbi-its-blastdb-2026-11-15/genbank_its.nsq", body: big },
    { name: "ncbi-its-blastdb-2026-11-15/empty.txt", body: "" },
    { name: longName, body: "long", longName: true },
    { name: "./README.txt", body: "hello" },
  ]));
  const out = path.join(dir, "out");
  const files = await unpackTarGz(archive, out);
  assert.deepEqual(files.map((f) => [f.name, f.bytes]), [
    ["ncbi-its-blastdb-2026-11-15/genbank_its.nsq", big.length],
    ["ncbi-its-blastdb-2026-11-15/empty.txt", 0],
    [longName, 4],
    ["README.txt", 5],
  ]);
  assert.ok(fs.readFileSync(path.join(out, "ncbi-its-blastdb-2026-11-15/genbank_its.nsq")).equals(big));
  assert.equal(fs.readFileSync(path.join(out, longName), "utf8"), "long");
  assert.equal(fs.statSync(path.join(out, "ncbi-its-blastdb-2026-11-15/empty.txt")).size, 0);
}));

test("only the chosen entries are written, each where the choice says", () => inTemp(async (dir) => {
  const archive = path.join(dir, "blast.tar.gz");
  fs.writeFileSync(archive, tarGz([{ name: "x/bin/blastn", body: "1" }, { name: "x/doc/manual.pdf", body: "2" }]));
  const files = await unpackTarGz(archive, path.join(dir, "out"), (name) => (name.endsWith("blastn") ? "tools/blastn" : null));
  assert.deepEqual(files.map((f) => path.relative(path.join(dir, "out"), f.path).split(path.sep).join("/")), ["tools/blastn"]);
  assert.equal(fs.existsSync(path.join(dir, "out", "x")), false);
}));

test("an entry that would land outside the folder is refused, and nothing is written there", () => inTemp(async (dir) => {
  for (const name of ["../escaped.txt", "a/../../escaped.txt", "/etc/escaped.txt", "C:/escaped.txt"]) {
    const archive = path.join(dir, "bad.tar.gz");
    fs.writeFileSync(archive, tarGz([{ name, body: "x" }]));
    await assert.rejects(unpackTarGz(archive, path.join(dir, "out")), (e: unknown) => e instanceof ArchiveError && /a path outside the folder/.test(e.message), name);
    assert.equal(fs.existsSync(path.join(dir, "escaped.txt")), false, name);
  }
}));

test("an archive cut short is refused, saying to download it again", () => inTemp(async (dir) => {
  const archive = path.join(dir, "short.tar");
  fs.writeFileSync(archive, tarGz([{ name: "mycomap.nsq", body: crypto.randomBytes(5000) }], { gzip: false, cutAt: 2048 }));
  await assert.rejects(unpackTarGz(archive, path.join(dir, "out")), /ends in the middle of a file\. It may be cut short: download it again/);
  const gz = path.join(dir, "short.tar.gz");
  fs.writeFileSync(gz, tarGz([{ name: "mycomap.nsq", body: crypto.randomBytes(5000) }]).subarray(0, 200));
  await assert.rejects(unpackTarGz(gz, path.join(dir, "out2")), /could not be unpacked .*download it again/);
}));

test("a large file cut short is refused cleanly: its queued writes finish, the part written is removed, and nothing fails afterwards", () => inTemp(async (dir) => {
  // Big enough that writes are still queued when the archive runs out (the CI failure of beta.8:
  // destroying the file at once made a queued write fail after the test had ended).
  const archive = path.join(dir, "big-short.tar");
  fs.writeFileSync(archive, tarGz([{ name: "mycomap.nsq", body: crypto.randomBytes(24 * 1024 * 1024) }], { gzip: false, cutAt: 12 * 1024 * 1024 }));
  const out = path.join(dir, "out");
  await assert.rejects(unpackTarGz(archive, out), /ends in the middle of a file/);
  assert.equal(fs.existsSync(path.join(out, "mycomap.nsq")), false, "no half-written file is left");
  // Anything still queued would fail here, inside the test, rather than after it.
  await new Promise((resolve) => setTimeout(resolve, 200));
}));

test("every file is closed by the time unpacking returns, so its folder can be renamed at once on Windows", () => inTemp(async (dir) => {
  const archive = path.join(dir, "db.tar.gz");
  fs.writeFileSync(archive, tarGz([{ name: "a.nsq", body: crypto.randomBytes(2 * 1024 * 1024) }, { name: "b.nin", body: "x" }]));
  const opened: fs.WriteStream[] = [];
  const real = fs.createWriteStream;
  (fs as { createWriteStream: typeof fs.createWriteStream }).createWriteStream = ((...args: Parameters<typeof fs.createWriteStream>) => {
    const s = real(...args);
    opened.push(s);
    return s;
  }) as typeof fs.createWriteStream;
  try {
    await unpackTarGz(archive, path.join(dir, "out.unpacking"));
  } finally {
    (fs as { createWriteStream: typeof fs.createWriteStream }).createWriteStream = real;
  }
  assert.equal(opened.length, 2);
  assert.ok(opened.every((s) => s.closed), "each file's handle is closed, not only flushed");
  fs.renameSync(path.join(dir, "out.unpacking"), path.join(dir, "out"));
}));
