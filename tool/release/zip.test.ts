// The downloads' .zip: what goes in comes out, programs stay runnable on
// macOS and Linux, and a name that would land outside the folder is refused.
//   node --import tsx --test tool/release/zip.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";
import { zipBytes } from "./zip";

/** Reads a zip the way an unzipper does: from its central directory. */
function readZip(zip: Buffer): Array<{ name: string; mode: number; madeBy: number; data: Buffer }> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "the zip has an end record");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50, "a central directory entry");
    const madeBy = zip.readUInt16LE(at + 4) >> 8;
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const mode = (zip.readUInt32LE(at + 38) >>> 16) & 0o7777;
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const localNameLength = zip.readUInt16LE(offset + 26);
    const body = zip.subarray(offset + 30 + localNameLength, offset + 30 + localNameLength + packed);
    const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    assert.equal(data.length, size, `${name}: its size`);
    assert.equal(zlib.crc32(data), crc, `${name}: its CRC`);
    out.push({ name, mode, madeBy, data });
    at += 46 + nameLength;
  }
  return out;
}

const program = Buffer.concat([Buffer.from("#!/bin/sh\necho hello\n"), Buffer.alloc(5000, 7)]);

test("what goes into the zip comes out the same, and a program keeps its run permission", () => {
  const zip = zipBytes([
    { name: "tool-1.0/run", data: program, mode: 0o755 },
    { name: "tool-1.0/README.txt", data: Buffer.from("Read me ü\n") },
    { name: "tool-1.0/lib/empty", data: Buffer.alloc(0) },
    { name: "tool-1.0/lib/random.bin", data: Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7919) % 251)) },
  ], new Date(2026, 10, 20, 12, 0, 0));
  const entries = readZip(zip);
  assert.deepEqual(entries.map((e) => [e.name, e.mode.toString(8), e.madeBy]), [
    ["tool-1.0/run", "755", 3],
    ["tool-1.0/README.txt", "644", 3],
    ["tool-1.0/lib/empty", "644", 3],
    ["tool-1.0/lib/random.bin", "644", 3],
  ]);
  assert.deepEqual(entries[0].data, program);
  assert.equal(entries[1].data.toString("utf8"), "Read me ü\n");
  assert.equal(entries[2].data.length, 0);
  assert.ok(zip.length < program.length, "the files are compressed");
});

test("the system's own unzipper opens it, with the program still runnable where that applies", (t) => {
  // bsdtar reads zips (Windows 10 and later, macOS); Linux has unzip.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmv-zip-"));
  try {
    const zip = path.join(dir, "t.zip");
    fs.writeFileSync(zip, zipBytes([{ name: "t/run", data: program, mode: 0o755 }, { name: "t/notes.txt", data: Buffer.from("notes") }]));
    const out = path.join(dir, "out");
    fs.mkdirSync(out);
    const tools: Array<[string, string[]]> = [["unzip", ["-q", zip, "-d", out]], ["tar", ["-xf", zip, "-C", out]]];
    const used = tools.find(([cmd, args]) => spawnSync(cmd, args).status === 0 && fs.existsSync(path.join(out, "t", "run")));
    if (!used) { t.skip("no unzip or bsdtar here"); return; }
    assert.deepEqual(fs.readFileSync(path.join(out, "t", "run")), program);
    assert.equal(fs.readFileSync(path.join(out, "t", "notes.txt"), "utf8"), "notes");
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(out, "t", "run")).mode & 0o111, 0o111, `${used[0]} kept the run permission`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a name that would land outside the folder, or is there twice, is refused", () => {
  for (const name of ["/etc/passwd", "a/../../b", "a\\b", ""]) {
    assert.throws(() => zipBytes([{ name, data: Buffer.from("x") }]), /not a name a zip may hold/, name);
  }
  assert.throws(() => zipBytes([{ name: "a", data: Buffer.from("x") }, { name: "a", data: Buffer.from("y") }]), /twice/);
});
