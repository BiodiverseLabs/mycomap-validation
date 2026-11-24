// The browser app's Contribute, over real HTTP: a run in the app's runs
// folder, the app's own server, and a stand-in mycomap.org on this computer
// (testSupport.ts serve), never the real site.
//   node --import tsx --test tool/ui/contribute.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { serve, type Handler, type Served } from "../testSupport";
import { startUi } from "./server";

delete process.env.MYCOMAP_MEMBER_KEY;
delete process.env.MYCOMAP_SITE_URL;

const PAGE_KEY = "test-key";
const MEMBER_KEY = "mm_member_secret_123";
const RUN = "2026-11-21_101500_plate7";
const LOCAL = "Russula sp. 'local-A02'";
const BASES = "ACGT".repeat(140);

function request(url: string, opts: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const text = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request({
      host: "127.0.0.1", port: u.port, path: u.pathname, method: opts.method ?? "GET",
      headers: { Host: `localhost:${u.port}`, "x-mmv-key": PAGE_KEY, ...(text ? { "content-type": "application/json" } : {}) },
    }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode!, json: body ? JSON.parse(body) : null }));
    });
    req.on("error", reject);
    if (text) req.write(text);
    req.end();
  });
}

/** A finished run in the app's runs folder, as the app leaves it. */
function writeRun(data: string): string {
  const folder = path.join(data, "runs", RUN);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "results.json"), JSON.stringify({
    engineVersion: "2.0.0-beta.13", ranAt: "2026-11-21T15:15:00.000Z", databases: { mycomap: { version: "2026-11-21" }, ncbi: null },
    sequences: [
      { id: "A01", readCount: 64, result: { finalSpecies: "Amanita alpinicola", finalConfidence: 100 }, localName: null },
      { id: "A02", readCount: 40, result: { finalSpecies: null, finalConfidence: null, barcodeGapNeeded: true }, localName: LOCAL },
    ],
    records: [
      { record: "inat:1", sequenceIds: ["A01"], decision: "validate", species: "Amanita alpinicola", reason: "Validated." },
      { record: "inat:2", sequenceIds: ["A02"], decision: "held", species: null, reason: "Held for a person.", newName: LOCAL },
    ],
    input: { fasta: "plate7.fasta", records: null },
  }));
  fs.writeFileSync(path.join(folder, "sequences.fasta"), `>A01\n${BASES}\n>A02\n${BASES}\n`);
  fs.writeFileSync(path.join(folder, "records.csv"), `record,new_name\r\ninat:1,\r\ninat:2,${LOCAL}\r\n`);
  return folder;
}

async function withApp<T>(handlers: Record<string, Handler>, fn: (app: { url: string; folder: string; site: Served }) => Promise<T>, opts: { memberKey?: string } = {}): Promise<T> {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "mmv ui contribute "));
  const folder = writeRun(data);
  const site = await serve({}, handlers);
  const ui = await startUi({ data, port: 0, threads: 1, key: PAGE_KEY, memberKey: opts.memberKey ?? null, mycomapUrl: site.base, runValidation: async () => { throw new Error("no run in these tests"); } });
  try {
    return await fn({ url: ui.url, folder, site });
  } finally {
    await ui.close();
    await site.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
}

const taken: Handler = () => ({ status: 202, body: { id: "C-000123", status: "received", page: "https://mycomap.org/contributions/C-000123" } });
const api = (url: string, rest = "") => `${url}api/runs/${RUN}/contribution${rest}`;

test("the page reads what Contribute would send (nothing is sent); sending needs the CC BY 4.0 box ticked and a member key, and each refusal is said in words", () => withApp({ "POST /api/contributions": taken }, async ({ url, folder, site }) => {
  const view = await request(api(url));
  assert.equal(view.status, 200);
  assert.equal(view.json.keyGiven, false);
  assert.equal(view.json.site, site.base);
  assert.equal(view.json.contribution, null);
  assert.equal(view.json.preview.sequences, 2);
  assert.ok(view.json.preview.lines.some((l: string) => l.includes(`local name ${LOCAL}`)));
  assert.ok(view.json.preview.lines.some((l: string) => /CC BY 4\.0/.test(l)));

  const notAgreed = await request(api(url), { method: "POST", body: { key: MEMBER_KEY } });
  assert.equal(notAgreed.status, 400);
  assert.match(notAgreed.json.error, /^Tick that you agree to CC BY 4\.0/);
  const noKey = await request(api(url), { method: "POST", body: { agree: true } });
  assert.equal(noKey.status, 400);
  assert.match(noKey.json.error, /^Type your MycoMap member key, or start the tool with MYCOMAP_MEMBER_KEY set/);
  assert.equal((await request(`${url}api/runs/2026-11-21_000000_none/contribution`)).status, 404);
  assert.equal(site.requests.length, 0, "nothing reached mycomap.org");

  const sent = await request(api(url), { method: "POST", body: { key: MEMBER_KEY, agree: true } });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.equal(site.requests.length, 1);
  assert.equal(site.requests[0].headers?.["x-api-key"], MEMBER_KEY);
  assert.equal(sent.json.lines.length, 1, "the preview and the command line's hints are not repeated");
  assert.match(sent.json.lines[0], /^Sent C-000123: 2 sequences of 2 records, received\./);
  assert.deepEqual(sent.json.contribution.contributions.map((c: any) => [c.id, c.status]), [["C-000123", "received"]]);
  assert.equal(sent.json.preview.sequences, 0, "nothing is left to send");
  for (const f of fs.readdirSync(folder)) assert.ok(!fs.readFileSync(path.join(folder, f), "utf8").includes(MEMBER_KEY), `the typed key is never written down (${f})`);
}));

test("mycomap.org's refusal reaches the page in words: only mycomap.org takes contributions", () => withApp({ "POST /api/contributions": () => ({ status: 423, body: { error: "Contributions are taken only on mycomap.org." } }) }, async ({ url }) => {
  const refused = await request(api(url), { method: "POST", body: { key: MEMBER_KEY, agree: true } });
  assert.equal(refused.status, 502);
  assert.match(refused.json.error, /^Only mycomap\.org takes contributions: .* \(the dev site and local copies refuse them\)\. Nothing was taken\./);
  assert.equal(refused.json.contribution, null);
}));

test("with a key the tool was started with, the page sends without one typed; Withdraw needs confirming; Check again renames the local name", () => {
  let named = false;
  return withApp({
    "POST /api/contributions": taken,
    "GET /api/contributions/C-000123": () => ({ status: 200, body: { id: "C-000123", status: named ? "accepted" : "in_review", records: [{ record: "inat:2", status: "waiting", sequences: [{ id: "A02", status: "waiting", name: named ? { kind: "new", value: "Russula sp. 'IN172'" } : { kind: "new", value: null, pending: true } }] }] } }),
    "DELETE /api/contributions/C-000123": () => ({ status: 200, body: { id: "C-000123", status: "withdrawn" } }),
  }, async ({ url, folder, site }) => {
    assert.equal((await request(api(url))).json.keyGiven, true);
    assert.equal((await request(api(url), { method: "POST", body: { agree: true } })).status, 200);
    assert.equal(site.requests.at(-1)!.headers?.["x-api-key"], MEMBER_KEY);

    const waiting = await request(api(url, "/status"), { method: "POST", body: {} });
    assert.equal(waiting.status, 200);
    assert.deepEqual(waiting.json.lines, ["1 read still has its local name: mycomap.org names them when the contribution is accepted."], "only what happened: the page shows the contribution itself");
    assert.equal(waiting.json.contribution.contributions[0].answer.records[0].sequences[0].name.pending, true);
    const unconfirmed = await request(api(url, "/withdraw"), { method: "POST", body: {} });
    assert.equal(unconfirmed.status, 400);
    assert.equal(site.requests.filter((r) => r.method === "DELETE").length, 0);
    const withdrawn = await request(api(url, "/withdraw"), { method: "POST", body: { confirm: true } });
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.json));
    assert.equal(withdrawn.json.contribution.contributions[0].status, "withdrawn");

    // The stand-in now answers with the name, as mycomap.org does once a contribution is accepted.
    named = true;
    const renamed = await request(api(url, "/status"), { method: "POST", body: {} });
    assert.ok(renamed.json.lines.some((l: string) => l.startsWith(`Renamed A02: ${LOCAL} -> Russula sp. 'IN172'`)), renamed.json.lines.join("\n"));
    assert.equal(fs.readFileSync(path.join(folder, "records.csv"), "utf8"), "record,new_name\r\ninat:1,\r\ninat:2,Russula sp. 'IN172'\r\n");
  }, { memberKey: MEMBER_KEY });
});
