// `mycomap-validation init`: what it says it will download, that it asks
// first, that each file is checked and unpacked where `run` finds it, that a
// second run downloads only what changed, that a broken download carries on,
// and that a computer with no internet can be set up from a copied folder.
// The downloads come from a server on this computer, never the internet.
//   node --import tsx --test tool/init.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { blastEntry, blastPlatform, installedBlastFolder } from "./blastPlus";
import { parseArgs } from "./cli";
import { findDataFiles, mycomapVersionOf } from "./dataFolder";
import { downloadFile } from "./download";
import { InputError } from "./fasta";
import { downloadsFrom, planText, readInstalled, renameWhenFree, runInit, SAVED_LIST, spaceProblem, stillNeeded, type InitOptions } from "./init";
import { serve, tarGz, type Served } from "./testSupport";

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/** One night's files, as the nightly build publishes them, and GenBank's and BLAST+'s. */
function release(version: string) {
  const db = tarGz([{ name: "mycomap.nin", body: `index ${version}` }, { name: "mycomap.nsq", body: crypto.randomBytes(4000) }]);
  const names = zlib.gzipSync(`mm_id\tname\nMM1\tRussula emetica ${version}\n`);
  return { db, names };
}
const ncbi = tarGz([
  { name: "ncbi-its-blastdb-2026-11-15/" },
  { name: "ncbi-its-blastdb-2026-11-15/genbank_its.nin", body: "g" },
  { name: "ncbi-its-blastdb-2026-11-15/refseq_its.nin", body: "r" },
  { name: "ncbi-its-blastdb-2026-11-15/info.txt", body: "Built:    2026-11-15 04:08:12 EST\n" },
]);
const blast = tarGz([
  { name: "ncbi-blast-2.17.0+/bin/blastn.exe", body: "blastn" },
  { name: "ncbi-blast-2.17.0+/bin/blastn", body: "blastn" },
  { name: "ncbi-blast-2.17.0+/bin/blastdbcmd", body: "blastdbcmd" },
  { name: "ncbi-blast-2.17.0+/bin/makeblastdb", body: "not wanted" },
  { name: "ncbi-blast-2.17.0+/bin/nghttp2.dll", body: "dll" },
  { name: "ncbi-blast-2.17.0+/doc/README", body: "not wanted" },
]);

/** The server's files and its /api/downloads list for one night. */
function filesFor(base: () => string, version: string, r = release(version)) {
  return {
    [`/files/${version}/mycomap_blastdb_${version}.tar.gz`]: r.db,
    [`/files/${version}/mycomap_sequences_${version}.tsv.gz`]: r.names,
    "/files/ncbi-its-blastdb-2026-11-15.tar.gz": ncbi,
    "/files/blast.tar.gz": blast,
    "/api/downloads": () => JSON.stringify({
      latest: {
        version,
        files: [
          { id: "mycomap-blastdb", fileName: `mycomap_blastdb_${version}.tar.gz`, url: `${base()}/files/${version}/mycomap_blastdb_${version}.tar.gz`, bytes: r.db.length, sha256: sha(r.db) },
          { id: "mycomap-sequences", fileName: `mycomap_sequences_${version}.tsv.gz`, url: `${base()}/files/${version}/mycomap_sequences_${version}.tsv.gz`, bytes: r.names.length, sha256: sha(r.names) },
          { id: "validated-records", fileName: "x.csv.gz", url: `${base()}/files/x`, bytes: 1, sha256: "0" },
        ],
      },
      ncbiIts: { version: "2026-11-15", fileName: "ncbi-its-blastdb-2026-11-15.tar.gz", url: `${base()}/files/ncbi-its-blastdb-2026-11-15.tar.gz`, bytes: ncbi.length, sha256: sha(ncbi) },
    }),
  };
}

async function withServer<T>(version: string, fn: (s: Served, opts: (data: string, more?: Partial<InitOptions>) => InitOptions, dir: string) => Promise<T>): Promise<T> {
  let server: Served | null = null;
  const files = filesFor(() => server!.base, version);
  server = await serve(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "function" ? "" : v])));
  server.files.set("/api/downloads", (files["/api/downloads"] as () => string)());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmv init "));
  const opts = (data: string, more: Partial<InitOptions> = {}): InitOptions => ({
    data, ncbi: true, blast: true, platform: "x64-win64", yes: true, listUrl: `${server!.base}/api/downloads`,
    blastBuildFor: (platform) => ({ platform, fileName: `ncbi-blast-2.17.0+-${platform}.tar.gz`, url: `${server!.base}/files/blast.tar.gz`, bytes: blast.length, sha256: sha(blast) }),
    ...more,
  });
  try {
    return await fn(server, opts, dir);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("init downloads, checks and unpacks everything where run finds it, keeps only blastn, blastdbcmd and their libraries, and records what it installed", () => withServer("2026-11-20", async (server, opts, dir) => {
  const data = path.join(dir, "data");
  const said: string[] = [];
  const result = await runInit(opts(data, { say: (l) => said.push(l), now: () => new Date("2026-11-20T10:00:00Z") }));
  assert.deepEqual(result.downloaded.map((d) => d.part), ["mycomap-db", "names", "ncbi", "blast"]);
  assert.match(said[0], /^To download into .*data:\n  MycoMap BLAST database +2026-11-20 /);
  assert.match(said[0], /  BLAST\+ \(x64-win64\) +2\.17\.0 /);
  assert.match(said[0], /in all$/);

  const files = findDataFiles(data, { ncbi: true });
  assert.equal(files.mycomapDb, path.join(data, "mycomap", "2026-11-20", "mycomap"));
  assert.equal(path.basename(files.namesTable), "mycomap_sequences_2026-11-20.tsv.gz");
  assert.equal(mycomapVersionOf(files), "2026-11-20");
  assert.deepEqual(files.ncbiDbs!.map((d) => path.relative(data, d).split(path.sep).join("/")), ["ncbi_its/2026-11-15/genbank_its", "ncbi_its/2026-11-15/refseq_its"]);
  assert.equal(files.ncbiVersion, "2026-11-15");
  assert.equal(installedBlastFolder(data), path.join(data, "blast", "2.17.0"));
  assert.deepEqual(fs.readdirSync(path.join(data, "blast", "2.17.0")).sort(), ["blastdbcmd", "blastn", "blastn.exe", "nghttp2.dll"]);
  assert.equal(fs.existsSync(path.join(data, ".downloads")), false, "the downloaded archives are removed once unpacked");

  const installed = readInstalled(data);
  assert.equal(installed["mycomap-db"]?.version, "2026-11-20");
  assert.equal(installed.blast?.version, "2.17.0");
  assert.equal(installed.blastPlatform, "x64-win64");
  assert.equal(installed.at, "2026-11-20T10:00:00.000Z");
  assert.ok(!server.requests.some((r) => r.path === "/files/x"), "only the files the tool uses are downloaded");
}));

test("run again, init downloads nothing when nothing changed, and only the new night's files when MycoMap's database is rebuilt, replacing the old ones", () => withServer("2026-11-20", async (server, opts, dir) => {
  const data = path.join(dir, "data");
  await runInit(opts(data));
  const before = server.requests.length;
  const said: string[] = [];
  const again = await runInit(opts(data, { say: (l) => said.push(l) }));
  assert.equal(again.upToDate, true);
  assert.deepEqual(server.requests.slice(before).map((r) => r.path), ["/api/downloads"]);
  assert.match(said[0], /^Everything in .* is up to date: MycoMap BLAST database 2026-11-20; MycoMap names table 2026-11-20; GenBank fungal ITS database 2026-11-15; BLAST\+ \(x64-win64\) 2\.17\.0\.$/);

  const next = filesFor(() => server.base, "2026-11-21");
  for (const [k, v] of Object.entries(next)) server.files.set(k, typeof v === "function" ? v() : v);
  const update = await runInit(opts(data));
  assert.deepEqual(update.downloaded.map((d) => d.part), ["mycomap-db", "names"]);
  assert.deepEqual(fs.readdirSync(path.join(data, "mycomap")), ["2026-11-21"]);
  assert.deepEqual(fs.readdirSync(data).filter((f) => f.startsWith("mycomap_sequences")), ["mycomap_sequences_2026-11-21.tsv.gz"]);
  assert.equal(fs.readFileSync(path.join(data, "mycomap", "2026-11-21", "mycomap.nin"), "utf8"), "index 2026-11-21");
}));

test("a download cut off part-way says to run the command again, and the next run asks only for the rest", () => withServer("2026-11-20", async (server, opts, dir) => {
  const data = path.join(dir, "data");
  const ncbiPath = "/files/ncbi-its-blastdb-2026-11-15.tar.gz";
  server.cutOnce.set(ncbiPath, 100);
  await assert.rejects(runInit(opts(data)), (e: unknown) => e instanceof InputError && /The download of GenBank fungal ITS database stopped part-way .* Run the same command again; it carries on where it stopped\./.test(e.message));
  assert.equal(readInstalled(data).ncbi, undefined, "GenBank is not recorded as installed");
  assert.equal(readInstalled(data)["mycomap-db"]?.version, "2026-11-20", "what finished before it stays installed");
  await runInit(opts(data));
  const tries = server.requests.filter((r) => r.path === ncbiPath);
  assert.deepEqual(tries.map((r) => r.range), [null, "bytes=100-"]);
  assert.equal(readInstalled(data).ncbi?.version, "2026-11-15");
  assert.equal(fs.readFileSync(path.join(data, "ncbi_its", "2026-11-15", "info.txt"), "utf8"), "Built:    2026-11-15 04:08:12 EST\n");
}));

test("a file that is not the published one is refused and removed, so the next run downloads it afresh; nothing of it is installed", () => withServer("2026-11-20", async (server, opts, dir) => {
  const data = path.join(dir, "data");
  const names = "/files/2026-11-20/mycomap_sequences_2026-11-20.tsv.gz";
  const good = server.files.get(names) as Buffer;
  const bad = Buffer.from(good);
  bad[bad.length - 1] ^= 1;
  server.files.set(names, bad);
  await assert.rejects(runInit(opts(data)), /The downloaded MycoMap names table is not the published file: its SHA-256 checksum is not the published one\. It has been removed/);
  assert.equal(fs.existsSync(path.join(data, ".downloads", "mycomap_sequences_2026-11-20.tsv.gz.part")), false);
  assert.equal(fs.readdirSync(data).some((f) => f.startsWith("mycomap_sequences")), false);
  server.files.set(names, good);
  await runInit(opts(data));
  assert.equal(readInstalled(data).names?.version, "2026-11-20");
}));

test("init asks before downloading: without --yes it asks, and a no, or no way to ask, downloads nothing", () => withServer("2026-11-20", async (server, opts, dir) => {
  const data = path.join(dir, "data");
  const asked: string[] = [];
  await assert.rejects(runInit(opts(data, { yes: false, ask: async (q) => { asked.push(q); return false; } })), /Nothing was downloaded/);
  assert.deepEqual(asked, ["Download and install these files? [y/N] "]);
  await assert.rejects(runInit(opts(data, { yes: false })), /Run the command again with --yes to go ahead/);
  assert.deepEqual(server.requests.map((r) => r.path), ["/api/downloads", "/api/downloads"]);
  await runInit(opts(data, { yes: false, ask: async () => true }));
  assert.equal(readInstalled(data)["mycomap-db"]?.version, "2026-11-20");
}));

test("--no-ncbi and --no-blast leave those out", () => withServer("2026-11-20", async (server, opts, dir) => {
  const data = path.join(dir, "data");
  const result = await runInit(opts(data, { ncbi: false, blast: false }));
  assert.deepEqual(result.downloaded.map((d) => d.part), ["mycomap-db", "names"]);
  assert.equal(installedBlastFolder(data), null);
  assert.equal(findDataFiles(data, { ncbi: true }).ncbiDbs, null);
}));

test("for a computer with no internet: --download-only fills a folder with the files and their list, and --from sets up from it without the network", () => withServer("2026-11-20", async (_server, opts, dir) => {
  const stick = path.join(dir, "usb stick");
  await runInit(opts(path.join(dir, "unused"), { downloadOnly: stick, platform: "aarch64-macosx" }));
  assert.deepEqual(fs.readdirSync(stick).sort(), [SAVED_LIST, "mycomap_blastdb_2026-11-20.tar.gz", "mycomap_sequences_2026-11-20.tsv.gz", "ncbi-blast-2.17.0+-aarch64-macosx.tar.gz", "ncbi-its-blastdb-2026-11-15.tar.gz"].sort());
  assert.equal(fs.existsSync(path.join(dir, "unused")), false, "nothing is installed by --download-only");

  const offline = path.join(dir, "offline data");
  const noNetwork = (async () => { throw new Error("no network on this computer"); }) as unknown as typeof fetch;
  const result = await runInit({ ...opts(offline, { from: stick, fetch: noNetwork, platform: "aarch64-macosx" }), listUrl: "http://unreachable.invalid/" });
  assert.deepEqual(result.downloaded.map((d) => d.part), ["mycomap-db", "names", "ncbi", "blast"]);
  assert.equal(findDataFiles(offline, { ncbi: true }).ncbiVersion, "2026-11-15");
  assert.equal(readInstalled(offline).blastPlatform, "aarch64-macosx");

  fs.appendFileSync(path.join(stick, "mycomap_sequences_2026-11-20.tsv.gz"), "x");
  await assert.rejects(runInit({ ...opts(path.join(dir, "third"), { from: stick, fetch: noNetwork, platform: "aarch64-macosx" }) }), /The downloaded MycoMap names table is not the published file: it is [\d,]+ bytes/);
  await assert.rejects(runInit(opts(path.join(dir, "fourth"), { from: path.join(dir, "empty") })), /has no mycomap-validation-downloads\.json/);
}));

test("no MycoMap database published yet, or no mycomap.org, is said in words", async () => {
  assert.throws(() => downloadsFrom({ latest: null }, { ncbi: true, blast: null }), /mycomap\.org has not published a MycoMap database yet/);
  const unreachable = (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as unknown as typeof fetch;
  await assert.rejects(runInit({ data: "x", ncbi: true, blast: false, yes: true, fetch: unreachable }), /Could not reach mycomap\.org \(getaddrinfo ENOTFOUND\)\. Check the internet connection, or set up from a folder copied from another computer with --from/);
});

test("init refuses early when the disk cannot hold the unpacked databases", () => {
  const needed = [{ part: "ncbi", bytes: 180e6 }, { part: "names", bytes: 20e6 }] as never;
  assert.equal(spaceProblem(needed, 2e9), null);
  assert.match(spaceProblem(needed, 500e6) ?? "", /^There is not enough room: this needs about 1\.1 GB free, and the disk has 500 MB\. Free some space, or name a folder on another disk with --data\.$/);
  assert.equal(spaceProblem(needed, null), null, "a disk whose free space cannot be read is not refused");
});

test("a part counts as installed only with the same checksum, and BLAST+ only for the same kind of computer", () => {
  const d = (part: string, sha256: string) => ({ part, sha256 }) as never;
  const installed = { "mycomap-db": { version: "a", fileName: "f", sha256: "1" }, blast: { version: "2.17.0", fileName: "b", sha256: "9" }, blastPlatform: "x64-linux" };
  assert.deepEqual(stillNeeded([d("mycomap-db", "1"), d("names", "2"), d("blast", "9")], installed, "x64-linux").map((x: { part: string }) => x.part), ["names"]);
  assert.deepEqual(stillNeeded([d("mycomap-db", "2"), d("blast", "9")], installed, "aarch64-linux").map((x: { part: string }) => x.part), ["mycomap-db", "blast"]);
  assert.match(planText([], [{ what: "MycoMap BLAST database", version: "2026-11-20" }] as never, "D:/data"), /^Everything in D:\/data is up to date: MycoMap BLAST database 2026-11-20\.$/);
});

test("BLAST+ is NCBI's build for this kind of computer, and only blastn, blastdbcmd and Windows libraries are kept", () => {
  assert.equal(blastPlatform("win32", "x64"), "x64-win64");
  assert.equal(blastPlatform("win32", "arm64"), "x64-win64", "Windows on ARM runs the x64 build");
  assert.equal(blastPlatform("linux", "x64"), "x64-linux");
  assert.equal(blastPlatform("linux", "arm64"), "aarch64-linux");
  assert.equal(blastPlatform("darwin", "x64"), "x64-macosx");
  assert.equal(blastPlatform("darwin", "arm64"), "aarch64-macosx");
  assert.equal(blastPlatform("freebsd", "x64"), null);
  assert.equal(blastEntry("ncbi-blast-2.17.0+/bin/blastn.exe"), "blastn.exe");
  assert.equal(blastEntry("ncbi-blast-2.17.0+/bin/blastdbcmd"), "blastdbcmd");
  assert.equal(blastEntry("ncbi-blast-2.17.0+/bin/ncbi-vdb-md.dll"), "ncbi-vdb-md.dll");
  assert.equal(blastEntry("ncbi-blast-2.17.0+/bin/blastn.exe.manifest"), "blastn.exe.manifest");
  assert.equal(blastEntry("ncbi-blast-2.17.0+/bin/makeblastdb"), null);
  assert.equal(blastEntry("ncbi-blast-2.17.0+/bin/makeblastdb.exe.manifest"), null);
  assert.equal(blastEntry("ncbi-blast-2.17.0+/doc/README"), null);
});

test("init's arguments, and the mistakes it refuses", () => {
  assert.deepEqual(parseArgs(["init"]), { command: "init", ncbi: true, installBlast: true, yes: false });
  assert.deepEqual(parseArgs(["init", "--data", "d", "--no-ncbi", "--no-blast", "--yes"]), { command: "init", ncbi: false, installBlast: false, yes: true, data: "d" });
  assert.equal(parseArgs(["init", "--download-only", "E:/mm", "--platform", "x64-linux"]).platform, "x64-linux");
  const refused = (argv: string[], words: RegExp) => assert.throws(() => parseArgs(argv), (e: unknown) => e instanceof InputError && words.test(e.message));
  refused(["init", "--platform", "x64-linux"], /--platform is for --download-only/);
  refused(["init", "--download-only", "a", "--platform", "windows"], /--platform takes one of x64-win64, /);
  refused(["init", "--download-only", "a", "--from", "b"], /go on different computers/);
  refused(["init", "my.fasta"], /init takes no file name/);
  refused(["init", "--records", "r.csv"], /init has no --records option/);
});

test("downloadFile on its own: a server that sends the whole file again to a Range request still gives a whole file", () => withServer("2026-11-20", async (server, _opts, dir) => {
  const body = server.files.get("/files/blast.tar.gz") as Buffer;
  const dest = path.join(dir, "blast.tar.gz");
  fs.writeFileSync(`${dest}.part`, body.subarray(0, 10));
  const wholeAgain = (async (input: string | URL | Request) => fetch(String(input))) as typeof fetch;
  await downloadFile(`${server.base}/files/blast.tar.gz`, dest, { bytes: body.length, sha256: sha(body) }, { fetch: wholeAgain });
  assert.ok(fs.readFileSync(dest).equals(body));
}));

test("a rename Windows refuses for a moment (a virus scanner holding a new file) is tried again, and given up in words", async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => { waits.push(ms); };
  const busy = (code: string) => Object.assign(new Error(code), { code });
  let calls = 0;
  await renameWhenFree("a", "b", { rename: () => { calls++; if (calls < 3) throw busy("EPERM"); }, sleep });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 500]);
  await assert.rejects(renameWhenFree("a", "b", { rename: () => { throw busy("ENOENT"); }, sleep }), /ENOENT/, "any other error is passed on at once");
  waits.length = 0;
  await assert.rejects(renameWhenFree("a", path.join("x", "2026-11-16"), { rename: () => { throw busy("EBUSY"); }, sleep }),
    (e: unknown) => e instanceof InputError && /^2026-11-16 could not be put in place: Windows kept it busy \(EBUSY\), most likely a virus scanner .* Run the same command again in a minute/.test(e.message));
  assert.deepEqual(waits, [250, 500, 1000, 2000, 4000]);
});

test("on Windows, a folder holding an open file is put in place once the file is closed", { skip: process.platform !== "win32" && "only Windows refuses to rename a folder with a file open in it" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmv rename "));
  try {
    const from = path.join(dir, "2026-11-16.unpacking");
    fs.mkdirSync(from);
    const fd = fs.openSync(path.join(from, "genbank_its.nsq"), "w");
    let closed = false;
    await renameWhenFree(from, path.join(dir, "2026-11-16"), { sleep: async () => { if (!closed) { fs.closeSync(fd); closed = true; } } });
    assert.ok(closed, "the first try was refused while the file was open");
    assert.ok(fs.existsSync(path.join(dir, "2026-11-16", "genbank_its.nsq")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
