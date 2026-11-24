// The browser app's local server, over real HTTP: who it answers, what a run
// leaves on disk, and the refusals. The run itself is stood in (the tool's
// own tests cover it); everything else is the server as it ships.
//   node --import tsx --test tool/ui/server.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { InputError } from "../fasta";
import type { RunOptions, RunOutput } from "../run";
import { makeRunFolder } from "../exportFixture";
import { hostAllowed, listRuns, MAX_BODY_BYTES, runId, startUi } from "./server";

const KEY = "test-key";

/** One request, with the Host header chosen (fetch will not let a test set it). */
function request(url: string, opts: { method?: string; key?: string | null; host?: string; body?: string } = {}): Promise<{ status: number; type: string; body: string; disposition: string | undefined }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: u.port, path: u.pathname, method: opts.method ?? "GET",
      headers: {
        Host: opts.host ?? `localhost:${u.port}`,
        ...(opts.key === null ? {} : { "x-mmv-key": opts.key ?? KEY }),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
    }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode!, type: String(res.headers["content-type"]), body, disposition: res.headers["content-disposition"] as string | undefined }));
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** A data folder with the files the status reads, and a stand-in run that writes what the real one writes. */
async function withUi<T>(fn: (ui: { url: string; data: string; calls: RunOptions[]; release: () => void }) => Promise<T>, opts: { failWith?: Error; ready?: boolean; vision?: { key: string; url: string }; env?: NodeJS.ProcessEnv } = {}): Promise<T> {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "mmv ui "));
  if (opts.ready !== false) {
    fs.mkdirSync(path.join(data, "mycomap", "2026-11-20"), { recursive: true });
    fs.writeFileSync(path.join(data, "mycomap", "2026-11-20", "mycomap.nin"), "");
    fs.writeFileSync(path.join(data, "mycomap_sequences_2026-11-20.tsv.gz"), "");
  }
  const calls: RunOptions[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const runValidation = async (o: RunOptions): Promise<RunOutput> => {
    calls.push(o);
    o.say?.("Searching MycoMap's sequences…");
    await held;
    if (opts.failWith) throw opts.failWith;
    const results = { ranAt: "2026-11-20T16:25:00.000Z", engineVersion: "x", sequences: [{ id: "a" }], records: [{ decision: "validate" }, { decision: "held" }, { decision: "held" }] };
    fs.writeFileSync(path.join(o.out, "results.json"), JSON.stringify(results));
    fs.writeFileSync(path.join(o.out, "records.csv"), "record,decision\r\nR1,validate\r\n");
    return {} as RunOutput;
  };
  const ui = await startUi({ data, port: 0, threads: 1, runValidation, key: KEY, now: () => new Date("2026-11-20T16:24:46Z"), vision: opts.vision ?? null, env: opts.env ?? {} });
  try {
    return await fn({ url: ui.url, data, calls, release });
  } finally {
    release();
    await ui.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
}

async function until<T>(check: () => Promise<T | null>, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await check();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`never: ${what}`);
}

test("the page is served with its key and the engine version, and loads nothing from anywhere else", () => withUi(async ({ url }) => {
  const page = await request(url, { key: null });
  assert.equal(page.status, 200);
  assert.match(page.type, /^text\/html/);
  assert.match(page.body, /<meta name="mmv-key" content="test-key">/);
  assert.doesNotMatch(page.body, /\{\{/);
  assert.doesNotMatch(page.body, /https?:\/\//, "no outside address: the page works with no internet");
  const js = await request(`${url}view.js`, { key: null });
  assert.match(js.type, /^text\/javascript/);
}));

test("only localhost addresses are answered, and the API only with the page's key", () => withUi(async ({ url }) => {
  const port = new URL(url).port;
  assert.equal((await request(url, { host: `evil.example:${port}`, key: null })).status, 403, "a name pointed at this computer by another site");
  assert.equal((await request(`${url}api/status`, { key: null })).status, 403);
  assert.equal((await request(`${url}api/status`, { key: "guess" })).status, 403);
  assert.equal((await request(`${url}api/status`)).status, 200);
  assert.equal((await request(`${url}api/status`, { host: `127.0.0.1:${port}` })).status, 200);
  assert.equal(hostAllowed(`LOCALHOST:${port}`, Number(port)), true);
  assert.equal(hostAllowed(`localhost:${Number(port) + 1}`, Number(port)), false);
  assert.equal(hostAllowed(undefined, Number(port)), false);
}));

test("a run is given a folder of its own with its inputs, reports progress while it runs, and its results afterwards", () => withUi(async ({ url, data, calls, release }) => {
  const started = await request(`${url}api/runs`, { method: "POST", body: JSON.stringify({ fastaName: "plate 7.fasta", fasta: ">a\nACGT\n", recordsName: "plate7.csv", records: "sequence,name\na,Russula\n", ncbi: false }) });
  assert.equal(started.status, 202);
  const { id } = JSON.parse(started.body);
  assert.equal(id, "2026-11-20_162446_plate-7");
  const folder = path.join(data, "runs", id);
  assert.equal(fs.readFileSync(path.join(folder, "input_plate_7.fasta"), "utf8"), ">a\nACGT\n");
  assert.equal(fs.readFileSync(path.join(folder, "input_plate7.csv"), "utf8"), "sequence,name\na,Russula\n");
  assert.equal(calls[0].out, folder);
  assert.equal(calls[0].ncbi, false);
  assert.equal(calls[0].data, data);

  const progress = JSON.parse((await request(`${url}api/runs/${id}`)).body);
  assert.deepEqual(progress, { id, state: "running", lines: ["Searching MycoMap's sequences…"], error: null });
  assert.equal((await request(`${url}api/runs`, { method: "POST", body: JSON.stringify({ fasta: ">b\nACGT\n" }) })).status, 409, "one run at a time");
  assert.equal(JSON.parse((await request(`${url}api/status`)).body).running, id);

  release();
  const done = await until(async () => { const r = JSON.parse((await request(`${url}api/runs/${id}`)).body); return r.state === "done" ? r : null; }, "the run finishes");
  assert.deepEqual(done.results.input, { fasta: "plate 7.fasta", records: "plate7.csv" }, "the results say which files they came from");
  const status = JSON.parse((await request(`${url}api/status`)).body);
  assert.equal(status.running, null);
  assert.deepEqual(status.runs, [{ id, ranAt: "2026-11-20T16:25:00.000Z", fasta: "plate 7.fasta", sequences: 1, records: { validate: 1, held: 2 } }]);
  const csv = await request(`${url}api/runs/${id}/records.csv`);
  assert.equal(csv.body, "record,decision\r\nR1,validate\r\n");
  assert.equal(csv.disposition, `attachment; filename="${id}_records.csv"`);
}));

test("MycoMap Vision: a run asks it only when the page ticks it; the status says whether a key was given, never the key; ticked with no key is refused in words", async () => {
  await withUi(async ({ url, calls, release }) => {
    const statusText = (await request(`${url}api/status`)).body;
    assert.deepEqual(JSON.parse(statusText).vision, { keyGiven: true, url: "http://127.0.0.1:9" });
    assert.doesNotMatch(statusText, /vision_started/);
    await request(`${url}api/runs`, { method: "POST", body: JSON.stringify({ fastaName: "a.fasta", fasta: ">a\nACGT\n" }) });
    assert.equal(calls[0].vision, null, "not ticked: not asked, even with a key");
    release();
    await until(async () => (JSON.parse((await request(`${url}api/status`)).body).running ? null : true), "the run finishes");
    await request(`${url}api/runs`, { method: "POST", body: JSON.stringify({ fastaName: "b.fasta", fasta: ">a\nACGT\n", vision: true }) });
    assert.deepEqual(calls[1].vision, { key: "vision_started", url: "http://127.0.0.1:9" });
  }, { vision: { key: "vision_started", url: "http://127.0.0.1:9" } });
  await withUi(async ({ url, calls }) => {
    assert.deepEqual(JSON.parse((await request(`${url}api/status`)).body).vision, { keyGiven: false, url: null });
    const refused = await request(`${url}api/runs`, { method: "POST", body: JSON.stringify({ fastaName: "a.fasta", fasta: ">a\nACGT\n", vision: true }) });
    assert.equal(refused.status, 400);
    assert.match(JSON.parse(refused.body).error, /^Type your MycoMap Vision key/);
    assert.equal(calls.length, 0);
  });
});

test("a run that fails says why in words, and the next run can start", () => withUi(async ({ url, release }) => {
  const { id } = JSON.parse((await request(`${url}api/runs`, { method: "POST", body: JSON.stringify({ fastaName: "a.fasta", fasta: ">a\nACGT\n" }) })).body);
  release();
  const failed = await until(async () => { const r = JSON.parse((await request(`${url}api/runs/${id}`)).body); return r.state === "failed" ? r : null; }, "the run fails");
  assert.equal(failed.error, "BLAST+ was not found (blastn is not on your PATH). Install BLAST+.");
  assert.equal(JSON.parse((await request(`${url}api/status`)).body).running, null);
}, { failWith: new InputError("BLAST+ was not found (blastn is not on your PATH). Install BLAST+.") }));

test("what the server refuses: no FASTA file, something it cannot read, too much, and anything outside a run's own results", () => withUi(async ({ url, data }) => {
  assert.equal((await request(`${url}api/runs`, { method: "POST", body: JSON.stringify({ fasta: "  " }) })).status, 400);
  assert.equal((await request(`${url}api/runs`, { method: "POST", body: "{not json" })).status, 400);
  const tooBig = await request(`${url}api/runs`, { method: "POST", body: JSON.stringify({ fasta: "A".repeat(MAX_BODY_BYTES + 10) }) }).catch((e) => ({ status: 413, body: String(e) }));
  assert.equal(tooBig.status, 413);
  fs.mkdirSync(path.join(data, "runs", "2026-11-20_162446_x"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "2026-11-20_162446_x", "input_x.fasta"), "secret");
  fs.writeFileSync(path.join(data, "secret.txt"), "secret");
  assert.equal((await request(`${url}api/runs/2026-11-20_162446_x/input_x.fasta`)).status, 404, "only results.csv, records.csv and results.json");
  assert.equal((await request(`${url}api/runs/..%2F..%2Fsecret.txt`)).status, 404);
  assert.equal((await request(`${url}api/runs/..%2Fruns/results.json`)).status, 404);
  assert.equal((await request(`${url}api/runs/2026-11-20_999999_none`)).status, 404);
  // Only folders named as runs are: a folder of the user's own under runs/ is not served.
  fs.mkdirSync(path.join(data, "runs", "my-notes"), { recursive: true });
  fs.writeFileSync(path.join(data, "runs", "my-notes", "results.csv"), "private");
  assert.equal((await request(`${url}api/runs/my-notes/results.csv`)).status, 404);
  assert.equal((await request(`${url}api/runs/%2e%2e/results.csv`)).status, 404, "the address's own .. is never a run");
}));

test("the status says when the data folder is not set up, and how to set it up", () => withUi(async ({ url }) => {
  const status = JSON.parse((await request(`${url}api/status`)).body);
  assert.equal(status.data.ok, false);
  assert.match(status.data.problem, /Missing from .*Or run: mycomap-validation init$/);
}, { ready: false }));

test("a run's folder is named by its start time and its FASTA file; past runs are listed newest first, and a broken one still shows", () => {
  assert.equal(runId(new Date("2026-11-20T16:24:46.123Z"), "Plate 7 (ITS).fasta"), "2026-11-20_162446_Plate-7-ITS");
  assert.equal(runId(new Date("2026-11-20T16:24:46Z"), "<>.fasta"), "2026-11-20_162446", "a name with nothing usable left gives the time alone");
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "mmv runs "));
  try {
    for (const id of ["2026-11-19_100000_a", "2026-11-20_100000_b", "not-a-run"]) fs.mkdirSync(path.join(runs, id));
    fs.writeFileSync(path.join(runs, "2026-11-20_100000_b", "results.json"), JSON.stringify({ ranAt: "t", input: { fasta: "b.fasta" }, sequences: [], records: [] }));
    assert.deepEqual(listRuns(runs).map((r) => [r.id, r.fasta]), [["2026-11-20_100000_b", "b.fasta"], ["2026-11-19_100000_a", null]]);
    assert.deepEqual(listRuns(path.join(runs, "missing")), []);
  } finally {
    fs.rmSync(runs, { recursive: true, force: true });
  }
});

const NCBI_KEY = "0123456789abcdef0123456789abcdef0123";

test("asking NCBI live is off unless the page ticks it; then the run gets the key and email address, which no file keeps", () => withUi(async ({ url, data, calls, release }) => {
  const plain = JSON.parse((await request(`${url}api/runs`, { method: "POST", body: JSON.stringify({ fastaName: "a.fasta", fasta: ">a\nACGT\n" }) })).body);
  assert.equal(calls[0].refreshNcbi, null, "not ticked: nothing goes to NCBI");
  release();
  await until(async () => (JSON.parse((await request(`${url}api/status`)).body).running === null ? true : null), "the first run finishes");

  const asked = await request(`${url}api/runs`, { method: "POST", body: JSON.stringify({ fastaName: "b.fasta", fasta: ">b\nACGT\n", refreshNcbi: true, ncbiKey: NCBI_KEY, ncbiEmail: "someone@example.org" }) });
  assert.equal(asked.status, 202);
  assert.deepEqual(calls[1].refreshNcbi, { apiKey: NCBI_KEY, email: "someone@example.org" });
  const folder = path.join(data, "runs", JSON.parse(asked.body).id);
  release();
  await until(async () => (JSON.parse((await request(`${url}api/status`)).body).running === null ? true : null), "the second run finishes");
  const noKey = await request(`${url}api/runs`, { method: "POST", body: JSON.stringify({ fastaName: "c.fasta", fasta: ">c\nACGT\n", refreshNcbi: true, ncbiKey: "", ncbiEmail: "someone@example.org" }) });
  assert.equal(noKey.status, 202, "the key box may be left empty");
  assert.deepEqual(calls[2].refreshNcbi, { apiKey: null, email: "someone@example.org" });
  for (const f of fs.readdirSync(folder)) assert.ok(!fs.readFileSync(path.join(folder, f), "utf8").includes(NCBI_KEY), `${f} holds no key`);
  assert.ok(plain.id);
}));

test("ticked without an email address, the run is refused and says what is missing; set where the tool started, they need not be typed", async () => {
  await withUi(async ({ url, calls }) => {
    const refused = await request(`${url}api/runs`, { method: "POST", body: JSON.stringify({ fasta: ">a\nACGT\n", refreshNcbi: true }) });
    assert.equal(refused.status, 400);
    assert.match(JSON.parse(refused.body).error, /^Refreshing from NCBI needs your email address/);
    const keyOnly = await request(`${url}api/runs`, { method: "POST", body: JSON.stringify({ fasta: ">a\nACGT\n", refreshNcbi: true, ncbiKey: NCBI_KEY }) });
    assert.equal(keyOnly.status, 400, "a key without an email address is refused");
    const noGenBank = await request(`${url}api/runs`, { method: "POST", body: JSON.stringify({ fasta: ">a\nACGT\n", refreshNcbi: true, ncbi: false, ncbiKey: NCBI_KEY, ncbiEmail: "a@example.org" }) });
    assert.equal(noGenBank.status, 400);
    assert.equal(calls.length, 0, "no run started");
    assert.deepEqual(JSON.parse((await request(`${url}api/status`)).body).ncbiRefresh, { keyFromEnvironment: false, emailFromEnvironment: false });
  });
  await withUi(async ({ url, calls }) => {
    const status = await request(`${url}api/status`);
    assert.deepEqual(JSON.parse(status.body).ncbiRefresh, { keyFromEnvironment: true, emailFromEnvironment: true });
    assert.ok(!status.body.includes(NCBI_KEY), "the status says the key is set, never what it is");
    assert.equal((await request(`${url}api/runs`, { method: "POST", body: JSON.stringify({ fasta: ">a\nACGT\n", refreshNcbi: true }) })).status, 202);
    assert.deepEqual(calls[0].refreshNcbi, { apiKey: NCBI_KEY, email: "env@example.org" });
  }, { env: { NCBI_API_KEY: NCBI_KEY, NCBI_EMAIL: "env@example.org" } });
});

test("Save gives the exports, made from the run's own folder when asked for; a run that kept no FASTA file says why", () => withUi(async ({ url, data }) => {
  const id = "2026-11-20_162500_plate1";
  const made = makeRunFolder(data);
  fs.mkdirSync(path.join(data, "runs"), { recursive: true });
  fs.renameSync(made, path.join(data, "runs", id));

  const dwc = await request(`${url}api/runs/${id}/darwin-core.csv`);
  assert.equal(dwc.status, 200);
  assert.equal(dwc.type, "text/csv; charset=utf-8");
  assert.equal(dwc.disposition, `attachment; filename="${id}_darwin-core.csv"`);
  assert.match(dwc.body, /^occurrenceID,basisOfRecord,/);
  const fasta = await request(`${url}api/runs/${id}/genbank.fasta`);
  assert.match(fasta.body, /^>plate1-A01\n[ACGT]+\n>plate1-B01\n/);
  assert.match((await request(`${url}api/runs/${id}/genbank-source.tsv`)).body, /^Sequence_ID\torganism\t/);
  assert.match((await request(`${url}api/runs/${id}/inaturalist.txt`)).body, /^iNaturalist fields and comments for 2 validated records/);
  const report = (await request(`${url}api/runs/${id}/export-report.txt`)).body;
  assert.match(report, /\nDARWIN CORE\n[\s\S]*\nGENBANK\n[\s\S]*\nINATURALIST\n/, "the report covers every format");
  assert.equal((await request(`${url}api/runs/${id}/inaturalist.txt`, { key: null })).status, 403, "the exports need the page's key too");

  const bare = "2026-11-20_162600_bare";
  fs.mkdirSync(path.join(data, "runs", bare));
  fs.copyFileSync(path.join(data, "runs", id, "results.json"), path.join(data, "runs", bare, "results.json"));
  const refused = await request(`${url}api/runs/${bare}/genbank.fasta`);
  assert.equal(refused.status, 422);
  assert.match(JSON.parse(refused.body).error, /did not keep its FASTA file/);
}));
