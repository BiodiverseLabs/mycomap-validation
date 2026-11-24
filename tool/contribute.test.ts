// `mycomap-validation contribute`: a run's sequences sent to a stand-in
// mycomap.org on this computer (testSupport.ts serve), never the real site.
// What is sent (section 7.1 of the design), asking first, each refusal in
// words, following a contribution and renaming local names (7.2), withdrawing
// (7.3), and the command line.
//   node --import tsx --test tool/contribute.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, parseArgs } from "./cli";
import {
  applyNames, CONTRIBUTION_FILE, contributeSettings, LICENCE_WORDS, loadRun, MAX_SEQUENCES_PER_CONTRIBUTION, parseCsv, planContribution,
  answerLines, readContributionDetails, readContributionFile, refusalWords, renameInCsv, sendRun, statusOfRun, withdrawRun, type ContributionBody,
} from "./contribute";
import { InputError } from "./fasta";
import { serve, type Handler, type Served } from "./testSupport";

// A key or address in the shell must never send these tests' sequences anywhere.
delete process.env.MYCOMAP_MEMBER_KEY;
delete process.env.MYCOMAP_SITE_URL;

const KEY = "mm_member_test_key";

function bases(seed: number, length = 560): string {
  let x = seed;
  let out = "";
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += "ACGT"[(x >> 16) & 3];
  }
  return out;
}

const LOCAL = "Russula sp. 'local-plate7-A02'";

interface FixtureRead { id: string; record: string; bases?: string; readCount?: number | null; localName?: string | null; decision?: string; species?: string | null; dnaName?: string | null }

/**
 * A run folder as `run` writes it: results.json, records.csv, results.csv and
 * sequences.fasta, and a records sheet kept as the browser app keeps it.
 */
function makeRun(dir: string, reads: FixtureRead[], opts: { sheet?: string | null } = {}): string {
  const folder = path.join(dir, "2026-11-21_101500_plate7");
  fs.mkdirSync(folder, { recursive: true });
  const records = new Map<string, FixtureRead[]>();
  for (const r of reads) records.set(r.record, [...(records.get(r.record) ?? []), r]);
  const results = {
    tool: "mycomap-validation", engineVersion: "2.0.0-beta.13", ranAt: "2026-11-21T15:15:00.000Z",
    databases: { mycomap: { version: "2026-11-21" }, ncbi: { version: "2026-11-15" } },
    sequences: reads.map((r) => ({
      id: r.id, recordName: null, readCount: r.readCount === undefined ? 64 : r.readCount, length: (r.bases ?? bases(1)).length,
      result: { finalSpecies: r.dnaName === undefined ? "Amanita alpinicola" : r.dnaName, finalConfidence: r.dnaName === null ? null : 100, flaggedContaminant: false, flaggedNonTarget: false, barcodeGapNeeded: r.dnaName === null, noBlastHits: false, status: "complete" },
      localName: r.localName ?? null,
    })),
    records: [...records].map(([record, rs]) => ({
      record, sequenceIds: rs.map((r) => r.id), decision: rs[0].decision ?? "validate", species: rs[0].species === undefined ? "Amanita alpinicola" : rs[0].species,
      reason: rs[0].decision === "held" ? "Held for a person." : "Validated as Amanita alpinicola, carried by plate7-A01.",
      newName: rs.map((r) => r.localName).filter(Boolean).join("; ") || null,
    })),
    input: { fasta: "plate7.fasta", records: opts.sheet === null ? null : "plate7.csv" },
  };
  fs.writeFileSync(path.join(folder, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(folder, "sequences.fasta"), reads.map((r) => `>${r.id}\n${r.bases ?? bases(1)}\n`).join(""));
  fs.writeFileSync(path.join(folder, "records.csv"), [
    "record,sequences,decision,species,new_name",
    ...results.records.map((r) => [r.record, r.sequenceIds.join("; "), r.decision, r.species ?? "", r.newName ?? ""].join(",")),
  ].join("\r\n") + "\r\n");
  fs.writeFileSync(path.join(folder, "results.csv"), [
    "sequence,dna_name,new_name",
    ...results.sequences.map((s) => [s.id, s.result.finalSpecies ?? "", s.localName ?? ""].join(",")),
  ].join("\r\n") + "\r\n");
  if (opts.sheet !== null) {
    fs.writeFileSync(path.join(folder, "input_plate7.csv"), opts.sheet ?? [
      "sequence,record,name,reads,voucher,fwd_primer,rev_primer,run,plate,well,method",
      "plate7-A01,inat:248540387,Amanita,64,OMDL-0101,ITS1F,ITS4,Run163,P7,A01,ONT",
      "plate7-A02,inat:248540388,Russula,40,,ITS1F,ITS4,Run163,P7,A02,nanopore",
      "spec-9,my-own-9,Russula,12,,,,,,,",
    ].join("\n"));
  }
  return folder;
}

const STANDARD: FixtureRead[] = [
  { id: "plate7-A01", record: "inat:248540387" },
  { id: "plate7-A02", record: "inat:248540388", readCount: 40, localName: LOCAL, decision: "held", species: null, dnaName: null },
  { id: "spec-9", record: "my-own-9", readCount: 12 },
];

async function inTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmv contribute "));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A stand-in mycomap.org: the handlers answer, every request is kept. */
async function standIn<T>(handlers: Record<string, Handler>, fn: (site: Served) => Promise<T>): Promise<T> {
  const site = await serve({}, handlers);
  try {
    return await fn(site);
  } finally {
    await site.close();
  }
}

const taken: Handler = (req) => ({ status: 202, body: { id: "C-000123", status: "received", page: "https://mycomap.org/contributions/C-000123", got: JSON.parse(req.body.toString()) } });
const bodyOf = (site: Served, i = 0) => JSON.parse(site.requests.filter((r) => r.method === "POST")[i].body!.toString()) as ContributionBody;

function flow(folder: string, site: Served, extra: Partial<Parameters<typeof sendRun>[0]> = {}) {
  const said: string[] = [];
  return { said, opts: { folder, settings: { key: KEY, url: site.base }, say: (l: string) => said.push(l), now: () => new Date("2026-11-21T15:20:00Z"), ...extra } };
}

test("the body is built from the run as 7.1 says: each observation, its voucher, each read's cleaned bases and the sheet's columns, the tool's results as notes", () => inTemp(async (dir) => {
  const folder = makeRun(dir, STANDARD);
  const plan = planContribution(loadRun(folder));
  assert.equal(plan.parts.length, 1);
  const body = plan.parts[0];
  assert.equal(body.licence, "CC-BY-4.0");
  assert.deepEqual(body.tool, { engineVersion: "2.0.0-beta.13", mycomapDatabase: "2026-11-21", ncbiDatabase: "2026-11-15", run: "2026-11-21_101500_plate7" });
  assert.deepEqual(body.records.map((r) => r.record), ["inat:248540387", "inat:248540388"]);
  const [first, second] = body.records;
  assert.equal(first.voucher, "OMDL-0101");
  assert.deepEqual(first.sequences[0], {
    id: "plate7-A01", bases: bases(1), readCount: 64, method: "ont", primers: "ITS1F/ITS4", run: "Run163", plate: "P7", well: "A01",
    localName: null, toolResult: { dnaName: "Amanita alpinicola", confidence: 100, flags: [] },
  });
  assert.deepEqual(first.toolDecision, { decision: "validate", species: "Amanita alpinicola", reason: "Validated as Amanita alpinicola, carried by plate7-A01." });
  assert.equal(second.voucher, null);
  assert.equal(second.sequences[0].localName, LOCAL, "a local name goes for mycomap.org to register");
  assert.equal(second.sequences[0].method, "ont", "nanopore is ont");
  assert.deepEqual(second.sequences[0].toolResult, { dnaName: null, confidence: null, flags: ["barcode gap check needed"] });
  assert.equal(second.toolDecision.decision, "held");
  // A record that is not an observation is left out, and says why.
  assert.deepEqual(plan.leftOut.map((l) => l.record), ["my-own-9"]);
  assert.match(plan.leftOut[0].why, /not an iNaturalist or Mushroom Observer observation/);
  // Nothing that is not in 7.1 goes: no coordinates, names of places or photos.
  assert.doesNotMatch(JSON.stringify(body), /latitude|longitude|locality|photo/i);
}));

test("a Sanger read goes with no read count; a read outside 50 to 3,000 bases is left out with its length; with no sheet the reads go without its columns", () => inTemp(async (dir) => {
  const folder = makeRun(dir, [
    { id: "s1", record: "mo:555", readCount: null },
    { id: "s2", record: "mo:556", bases: bases(2, 49) },
    { id: "s3", record: "mo:557", bases: bases(3, 3001) },
    { id: "s4", record: "MO:558", bases: bases(4, 3000) },
  ], { sheet: null });
  const run = loadRun(folder);
  assert.equal(run.sheet, null);
  const plan = planContribution(run);
  const reads = plan.parts[0].records.flatMap((r) => r.sequences);
  assert.deepEqual(reads.map((s) => [s.id, s.method, s.readCount, s.primers]), [["s1", "sanger", null, null], ["s4", "ont", 64, null]]);
  // The sheet saying sanger wins over a read count, which a Sanger read never goes with.
  fs.writeFileSync(path.join(folder, "sheet.csv"), "sequence,record,method\ns4,mo:558,sanger\n");
  const sanger = planContribution(loadRun(folder, { records: path.join(folder, "sheet.csv") })).parts[0].records[1].sequences[0];
  assert.deepEqual([sanger.id, sanger.method, sanger.readCount], ["s4", "sanger", null]);
  assert.deepEqual(plan.parts[0].records.map((r) => r.record), ["mo:555", "mo:558"], "the platform is written in lower case");
  assert.deepEqual(plan.leftOut.map((l) => [l.sequence, l.why]), [
    ["s2", "49 bases long; mycomap.org takes 50 to 3,000"], [undefined, "none of its reads can be sent"],
    ["s3", "3001 bases long; mycomap.org takes 50 to 3,000"], [undefined, "none of its reads can be sent"],
  ]);
}));

test("the limit: at most 500 sequences in a contribution, so a larger run goes as several, never splitting a record; a record of more than 500 reads is left out", () => inTemp(async (dir) => {
  const reads: FixtureRead[] = [];
  for (let i = 0; i < 300; i++) reads.push({ id: `a${i}`, record: "inat:1" });
  for (let i = 0; i < 250; i++) reads.push({ id: `b${i}`, record: "inat:2" });
  for (let i = 0; i < 10; i++) reads.push({ id: `c${i}`, record: "inat:3" });
  for (let i = 0; i < 501; i++) reads.push({ id: `d${i}`, record: "inat:4" });
  const plan = planContribution(loadRun(makeRun(dir, reads, { sheet: null })));
  const sizes = plan.parts.map((p) => p.records.reduce((n, r) => n + r.sequences.length, 0));
  assert.deepEqual(sizes, [300, 260]);
  assert.ok(sizes.every((n) => n <= MAX_SEQUENCES_PER_CONTRIBUTION));
  assert.deepEqual(plan.parts.map((p) => p.records.map((r) => r.record)), [["inat:1"], ["inat:2", "inat:3"]]);
  assert.deepEqual(plan.leftOut, [{ record: "inat:4", why: "501 reads; a contribution takes at most 500" }]);
}));

test("the records sheet's columns: voucher only when another column names the record, primers from one column or forward and reverse, and a method mycomap.org does not take is refused with its line", () => {
  const both = readContributionDetails("sequence,voucher,record,primers,method\na,V-1,inat:1,ITS1F/ITS4,sanger\n");
  assert.deepEqual(both.get("a"), { voucher: "V-1", primers: "ITS1F/ITS4", run: null, plate: null, well: null, method: "sanger" });
  // "voucher" alone is the record column (fasta.ts), not a voucher.
  assert.equal(readContributionDetails("sequence,voucher\na,V-1\n").get("a")?.voucher, null);
  assert.equal(readContributionDetails("sequence,record,specimen_voucher\na,inat:1,V-2\n").get("a")?.voucher, "V-2");
  assert.throws(() => readContributionDetails("sequence,method\na,pacbio\n", "plate7.csv"), (e: unknown) => e instanceof InputError && /plate7\.csv, line 2: the method "pacbio".*ont \(nanopore\) or sanger/.test(e.message));
});

test("contribute shows what goes and the licence, and asks first: answered no, or with no way to ask and no --yes, nothing is sent", () => inTemp(async (dir) => {
  const folder = makeRun(dir, STANDARD);
  await standIn({ "POST /api/contributions": taken }, async (site) => {
    const asked: string[] = [];
    const no = flow(folder, site, { ask: async (q) => { asked.push(q); return false; } });
    assert.equal((await sendRun(no.opts)).code, 0);
    assert.match(asked[0], /^Send 2 sequences to http:\/\/127\.0\.0\.1:\d+, and agree to CC BY 4\.0 for them\? \[y\/N\] $/);
    assert.ok(no.said.includes(LICENCE_WORDS), "the licence is said plainly before asking");
    assert.match(LICENCE_WORDS, /CC BY 4\.0 \(https:\/\/creativecommons\.org\/licenses\/by\/4\.0\/\).*credits them to you by your display name/);
    assert.ok(no.said.some((l) => /^  inat:248540387 \(voucher OMDL-0101\): plate7-A01 \(ONT, 64 reads, 560 bases\); the tool: validated as Amanita alpinicola$/.test(l)), no.said.join("\n"));
    assert.ok(no.said.some((l) => l.includes(`local name ${LOCAL}`)));
    assert.ok(no.said.some((l) => /^  my-own-9: not an iNaturalist/.test(l)), "what is left out is said");
    assert.ok(no.said.some((l) => /never validate anything/.test(l)) && no.said.some((l) => /Not sent: coordinates/.test(l)));
    assert.equal(no.said.at(-1), "Nothing was sent.");

    const cannotAsk = flow(folder, site);
    assert.equal((await sendRun(cannotAsk.opts)).code, 1);
    assert.match(cannotAsk.said.at(-1)!, /^Nothing was sent\. To send without being asked, add --yes/);
    assert.equal(site.requests.length, 0, "nothing reached mycomap.org");
    assert.equal(readContributionFile(folder), null);
  });
}));

test("sent with the member key once agreed: contribution.json keeps its number, and the same records are not sent twice", () => inTemp(async (dir) => {
  const folder = makeRun(dir, STANDARD);
  await standIn({ "POST /api/contributions": taken }, async (site) => {
    const yes = flow(folder, site, { ask: async () => true });
    const done = await sendRun(yes.opts);
    assert.equal(done.code, 0);
    assert.equal(site.requests.length, 1);
    const req = site.requests[0];
    assert.equal(req.path, "/api/contributions");
    assert.equal(req.headers?.["x-api-key"], KEY);
    assert.equal(req.headers?.["content-type"], "application/json");
    assert.equal(bodyOf(site).licence, "CC-BY-4.0");
    const file = readContributionFile(folder)!;
    assert.deepEqual(file.contributions.map((c) => [c.id, c.status, c.records, c.sequences, c.site, c.page, c.sentAt]), [
      ["C-000123", "received", ["inat:248540387", "inat:248540388"], ["plate7-A01", "plate7-A02"], site.base, "https://mycomap.org/contributions/C-000123", "2026-11-21T15:20:00.000Z"],
    ]);
    assert.ok(yes.said.some((l) => /^Sent C-000123: 2 sequences of 2 records, received\. Its page: https:\/\/mycomap\.org\/contributions\/C-000123$/.test(l)));

    const again = flow(folder, site, { yes: true });
    assert.equal((await sendRun(again.opts)).code, 1, "only the record that cannot go is left");
    assert.equal(site.requests.length, 1, "what was sent is not sent again");
    assert.match(again.said[0], /Nothing in this run can be sent/);
  });
}));

test("every refusal from mycomap.org is said in words, and nothing is kept as sent", async () => {
  const cases: Array<[number, unknown, RegExp]> = [
    [400, { error: "bases must be 50 to 3000 long", item: { record: 1, sequence: 0 } }, /could not take the contribution: bases must be 50 to 3000 long\. \(record inat:248540388, read plate7-A02\) Nothing was taken; correct it/],
    [401, { error: "Invalid API key" }, /does not know this key.*api-docs.*Nothing was taken/],
    [403, { error: "No contribute grant" }, /cannot send contributions: it has no "contribute" grant, or it is pending, disabled or revoked\. Ask a MycoMap admin to give your key the contribute grant\. mycomap\.org said: "No contribute grant\."/],
    [413, { error: "Too many sequences" }, /too large: at most 500 sequences/],
    [423, { error: "Contributions are taken only on mycomap.org." }, /^Only mycomap\.org takes contributions: http:\/\/127\.0\.0\.1:\d+ does not \(the dev site and local copies refuse them\)\. Nothing was taken\. Send to https:\/\/mycomap\.org/],
    [429, { error: "Daily limit reached", retryAfter: "2026-11-22T05:00:00Z" }, /^Today's contributions for this key are used up\. Send the rest after 2026-11-22 05:00 UTC: run contribute again/],
    [503, "busy", /could not answer now \(HTTP 503\)\. Nothing was taken\. Try again later/],
  ];
  for (const [status, body, words] of cases) {
    await inTemp(async (dir) => {
      const folder = makeRun(dir, STANDARD);
      await standIn({ "POST /api/contributions": () => ({ status, body }) }, async (site) => {
        const f = flow(folder, site, { yes: true });
        const done = await sendRun(f.opts);
        assert.equal(done.code, 1, `HTTP ${status}`);
        assert.match(done.problem ?? "", words, `HTTP ${status}: ${done.problem}`);
        assert.ok(f.said.includes(done.problem!), "it is said");
        assert.equal(readContributionFile(folder), null, `HTTP ${status}: nothing is kept as sent`);
      });
    });
  }
  // mycomap.org out of reach.
  await inTemp(async (dir) => {
    const folder = makeRun(dir, STANDARD);
    const site = await serve({});
    const base = site.base;
    await site.close();
    const said: string[] = [];
    const done = await sendRun({ folder, settings: { key: KEY, url: base }, say: (l) => said.push(l), yes: true });
    assert.match(done.problem ?? "", /^No answer came from http:\/\/127\.0\.0\.1:\d+ \(.*\), so it is not known whether the contribution was taken/);
    assert.equal(readContributionFile(folder), null);
  });
});

test("a large run split in two: when the second part is refused (today's limit), the first is kept, and contribute again sends only the rest", () => inTemp(async (dir) => {
  const reads: FixtureRead[] = [];
  for (let i = 0; i < 400; i++) reads.push({ id: `a${i}`, record: "inat:1" });
  for (let i = 0; i < 200; i++) reads.push({ id: `b${i}`, record: "inat:2" });
  const folder = makeRun(dir, reads, { sheet: null });
  let n = 0;
  let limit = true;
  await standIn({
    "POST /api/contributions": () => {
      n++;
      if (n === 2 && limit) return { status: 429, body: { error: "Daily limit", retryAfter: "2026-11-22T05:00:00Z" } };
      return { status: 202, body: { id: `C-00012${n}`, status: "received" } };
    },
  }, async (site) => {
    const first = flow(folder, site, { yes: true });
    const done = await sendRun(first.opts);
    assert.equal(done.code, 1);
    assert.ok(first.said.some((l) => /^1 contribution of 2 was taken before this; run contribute again to send the rest\.$/.test(l)), first.said.join("\n"));
    assert.deepEqual(readContributionFile(folder)!.contributions.map((c) => [c.id, c.records]), [["C-000121", ["inat:1"]]]);
    limit = false;
    const second = flow(folder, site, { yes: true });
    assert.equal((await sendRun(second.opts)).code, 0);
    assert.deepEqual(bodyOf(site, 2).records.map((r) => r.record), ["inat:2"], "only what was not taken goes");
    assert.ok(second.said.some((l) => /^Already sent, so not sent again: inat:1 \(C-000121\)\.$/.test(l)));
    assert.deepEqual(readContributionFile(folder)!.contributions.map((c) => c.id), ["C-000121", "C-000123"]);
  });
}));

test("the key: --key, else MYCOMAP_MEMBER_KEY, never MYCOMAP_API_KEY; it goes only over https or to this computer", () => {
  assert.deepEqual(contributeSettings({ key: " k1 ", env: {} }), { key: "k1", url: "https://mycomap.org" });
  assert.deepEqual(contributeSettings({ env: { MYCOMAP_MEMBER_KEY: "k2", MYCOMAP_SITE_URL: "http://127.0.0.1:5000/" } }), { key: "k2", url: "http://127.0.0.1:5000" });
  assert.throws(() => contributeSettings({ env: { MYCOMAP_API_KEY: "server-key" } }), (e: unknown) => e instanceof InputError && /--key <key>, or set MYCOMAP_MEMBER_KEY.*MYCOMAP_API_KEY is set, but it is never read/.test(e.message));
  assert.throws(() => contributeSettings({ key: "k", url: "http://mycomap.org", env: {} }), (e: unknown) => e instanceof InputError && /only sent over https/.test(e.message));
  assert.throws(() => contributeSettings({ key: "k", url: "not a site", env: {} }), (e: unknown) => e instanceof InputError && /is not a web address/.test(e.message));
});

/** 7.2's answer for the standard run, with the local-named read's name as given. */
function answer(name: unknown, status = "in_review") {
  return {
    id: "C-000123", status, receivedAt: "2026-11-21T15:02:00Z", decidedAt: status === "accepted" ? "2026-11-22T09:00:00Z" : null,
    records: [
      { record: "inat:248540387", status: "waiting", reason: null, sequences: [{ id: "plate7-A01", status: "waiting", check: { dnaName: "Amanita alpinicola", confidence: 100, flags: [], duplicateOf: null }, mycomapSequenceId: null, name: null }] },
      { record: "inat:248540388", status: "waiting", reason: null, sequences: [{ id: "plate7-A02", status: status === "accepted" ? "accepted" : "waiting", check: { dnaName: null, confidence: null, flags: ["barcode gap check needed"], duplicateOf: null }, mycomapSequenceId: status === "accepted" ? 912345 : null, name }] },
    ],
  };
}

async function sentRun(dir: string, site: Served): Promise<string> {
  const folder = makeRun(dir, STANDARD);
  await sendRun(flow(folder, site, { yes: true }).opts);
  return folder;
}

test("--status shows each record and read; a local name waits while the name is pending, and is renamed in results.json, records.csv and results.csv once it arrives, saying so", () => inTemp(async (dir) => {
  let current: unknown = answer({ kind: "new", value: null, pending: true });
  await standIn({ "POST /api/contributions": taken, "GET /api/contributions/C-000123": () => ({ status: 200, body: current }) }, async (site) => {
    const folder = await sentRun(dir, site);
    const waiting = flow(folder, site);
    const first = await statusOfRun(waiting.opts);
    assert.equal(first.code, 0, waiting.said.join("\n"));
    const get = site.requests.at(-1)!;
    assert.equal(get.method, "GET");
    assert.equal(get.headers?.["x-api-key"], KEY);
    assert.deepEqual(waiting.said, [
      "C-000123: in review (received 2026-11-21 15:02 UTC)",
      "  inat:248540387: waiting",
      "    plate7-A01: waiting; mycomap.org's check: Amanita alpinicola (100%)",
      "  inat:248540388: waiting",
      "    plate7-A02: waiting; mycomap.org's check: no DNA name [barcode gap check needed]; waiting for a MycoMap name",
      "1 read still has its local name: mycomap.org names them when the contribution is accepted.",
    ]);
    assert.equal(readContributionFile(folder)!.contributions[0].status, "in_review");
    assert.ok(fs.readFileSync(path.join(folder, "records.csv"), "utf8").includes(LOCAL), "nothing renamed yet");

    current = answer({ kind: "new", value: "Russula sp. 'IN172'" }, "accepted");
    const named = flow(folder, site);
    const done = await statusOfRun(named.opts);
    assert.deepEqual(done.renames, [{ sequence: "plate7-A02", from: LOCAL, to: "Russula sp. 'IN172'", kind: "new", contribution: "C-000123" }]);
    assert.ok(named.said.includes(`Renamed plate7-A02: ${LOCAL} -> Russula sp. 'IN172' (a new MycoMap name, from C-000123), in results.json, records.csv and results.csv.`), named.said.join("\n"));
    assert.ok(named.said.includes("    plate7-A02: accepted; mycomap.org's check: no DNA name [barcode gap check needed]; MycoMap sequence 912345; name: Russula sp. 'IN172' (a new MycoMap name)"));
    const results = JSON.parse(fs.readFileSync(path.join(folder, "results.json"), "utf8"));
    const read = results.sequences.find((s: any) => s.id === "plate7-A02");
    assert.equal(read.localName, LOCAL, "the local name is kept as history");
    assert.deepEqual(read.mycomapName, { kind: "new", value: "Russula sp. 'IN172'", contribution: "C-000123" });
    assert.equal(results.records[1].newName, "Russula sp. 'IN172'");
    for (const csv of ["records.csv", "results.csv"]) {
      const text = fs.readFileSync(path.join(folder, csv), "utf8");
      assert.ok(!text.includes("'local-"), `${csv} has no local name left`);
      assert.ok(text.includes("Russula sp. 'IN172'"), `${csv} has the new name`);
    }
    const kept = readContributionFile(folder)!.contributions[0];
    assert.equal(kept.status, "accepted");
    assert.equal(kept.answer?.decidedAt, "2026-11-22T09:00:00Z", "the last answer is kept");

    // Asked again, the same name renames nothing.
    const again = flow(folder, site);
    assert.deepEqual((await statusOfRun(again.opts)).renames, []);
    assert.ok(!again.said.some((l) => l.startsWith("Renamed")));
    // Everything is sent; and a renamed read would no longer go with its local name.
    assert.equal(planContribution(loadRun(folder), readContributionFile(folder)).parts.length, 0);
    const resent = planContribution(loadRun(folder)).parts[0].records[1].sequences[0];
    assert.equal(resent.localName, null);
  });
}));

test("an existing name renames the local name too, and a name for a read that had no local name changes nothing", () => inTemp(async (dir) => {
  const folder = makeRun(dir, STANDARD);
  const before = fs.readFileSync(path.join(folder, "results.csv"), "utf8");
  const a = answer({ kind: "existing", value: "Russula emetica" }, "accepted");
  (a.records[0].sequences[0] as any).name = { kind: "existing", value: "Amanita muscaria" };
  const renames = applyNames(folder, [a as never]);
  assert.deepEqual(renames.map((r) => [r.sequence, r.to, r.kind]), [["plate7-A02", "Russula emetica", "existing"]]);
  const after = fs.readFileSync(path.join(folder, "results.csv"), "utf8");
  assert.equal(after, before.replace(LOCAL, "Russula emetica"));
  assert.ok(!after.includes("Amanita muscaria"));
}));

test("renaming in a CSV changes only whole cells and list entries, and keeps quoting", () => {
  const text = `a,b\r\n"x, y",${LOCAL}\r\n"${LOCAL}; Fungi sp. 'local-z'","not ${LOCAL}"\r\n`;
  const out = renameInCsv(text, [{ from: LOCAL, to: 'Russula "new", sp.' }]);
  assert.deepEqual(parseCsv(out), [["a", "b"], ["x, y", 'Russula "new", sp.'], [`Russula "new", sp.; Fungi sp. 'local-z'`, `not ${LOCAL}`]]);
});

test("--status refused, or for a run never sent, is said in words", () => inTemp(async (dir) => {
  await standIn({ "POST /api/contributions": taken, "GET /api/contributions/C-000123": () => ({ status: 404, body: { error: "Not found" } }) }, async (site) => {
    const never = makeRun(path.join(dir, "never"), STANDARD);
    await assert.rejects(statusOfRun(flow(never, site).opts), (e: unknown) => e instanceof InputError && /^Nothing from this run has been sent to MycoMap\. Send it with: mycomap-validation contribute /.test(e.message));
    const folder = await sentRun(dir, site);
    const f = flow(folder, site);
    const done = await statusOfRun(f.opts);
    assert.equal(done.code, 1);
    assert.match(done.problem!, /^C-000123: mycomap\.org has no contribution C-000123 that this key can read: only the member who sent it, or an admin, can/);
  });
  assert.match(refusalWords(403, {}, "status"), /cannot follow contributions/);
}));

test("--withdraw asks first, sends DELETE, keeps the withdrawal, and its records can be sent again; a decided one is not asked about, and 409 is said in words", () => inTemp(async (dir) => {
  let deleteAnswer: { status: number; body: unknown } = { status: 200, body: { ...answer(null), status: "withdrawn" } };
  await standIn({ "POST /api/contributions": taken, "DELETE /api/contributions/C-000123": () => deleteAnswer }, async (site) => {
    const folder = await sentRun(dir, site);
    const no = flow(folder, site, { ask: async () => false });
    await withdrawRun(no.opts);
    assert.equal(no.said.at(-1), "Nothing was withdrawn.");
    assert.equal(site.requests.filter((r) => r.method === "DELETE").length, 0);

    deleteAnswer = { status: 409, body: { error: "Already decided" } };
    const late = flow(folder, site, { yes: true });
    assert.equal((await withdrawRun(late.opts)).code, 1);
    assert.match(late.said.at(-1)!, /^C-000123: C-000123 has been decided, so it can no longer be withdrawn\. Removing accepted sequences goes through a person: write to info@mycomap\.org\.$/);

    deleteAnswer = { status: 200, body: { ...answer(null), status: "withdrawn" } };
    const yes = flow(folder, site, { yes: true });
    assert.equal((await withdrawRun(yes.opts)).code, 0);
    assert.equal(site.requests.filter((r) => r.method === "DELETE").at(-1)!.headers?.["x-api-key"], KEY);
    assert.equal(readContributionFile(folder)!.contributions[0].status, "withdrawn");
    assert.deepEqual(planContribution(loadRun(folder), readContributionFile(folder)).parts[0].records.map((r) => r.record), ["inat:248540387", "inat:248540388"], "a withdrawn contribution's records can go again");

    const nothing = flow(folder, site, { yes: true });
    await withdrawRun(nothing.opts);
    assert.equal(nothing.said[0], "Nothing to withdraw: C-000123 is withdrawn.");
    assert.equal(site.requests.filter((r) => r.method === "DELETE").length, 2);
  });
}));

test("the command line: contribute, --status and --withdraw with their options, the mistakes it refuses, and a run sent end to end with --yes", () => inTemp(async (dir) => {
  assert.deepEqual(parseArgs(["contribute", "run1", "--key", "k", "--site", "http://127.0.0.1:1", "--yes", "--records", "s.csv"]).contribute,
    { folder: "run1", action: "send", key: "k", site: "http://127.0.0.1:1", records: "s.csv" });
  assert.equal(parseArgs(["contribute", "--status", "run1"]).contribute?.action, "status");
  assert.equal(parseArgs(["contribute", "run1", "--withdraw", "-y"]).yes, true);
  const refused = (argv: string[], words: RegExp) => assert.throws(() => parseArgs(argv), (e: unknown) => e instanceof InputError && words.test(e.message));
  refused(["contribute"], /Say which run to send/);
  refused(["contribute", "a", "b"], /One run folder at a time/);
  refused(["contribute", "a", "--status", "--withdraw"], /use one at a time/);
  refused(["contribute", "a", "--key"], /--key needs a value/);
  refused(["contribute", "a", "--vision-key", "x"], /contribute has no --vision-key option/);
  refused(["contribute", "a", "--status", "--records", "s.csv"], /are for sending/);

  const folder = makeRun(dir, STANDARD);
  const printed: string[] = [];
  assert.equal(await main(["contribute", folder], (l) => printed.push(l), async () => true), 1, "no key");
  assert.match(printed[0], /Give your MycoMap member key/);
  await standIn({ "POST /api/contributions": taken }, async (site) => {
    const out: string[] = [];
    assert.equal(await main(["contribute", folder, "--key", KEY, "--site", site.base, "--yes"], (l) => out.push(l)), 0, out.join("\n"));
    assert.equal(site.requests.length, 1);
    assert.ok(out.some((l) => l.startsWith("Sent C-000123")));
    assert.ok(fs.existsSync(path.join(folder, CONTRIBUTION_FILE)));
  });
}));

test("a refusal's reason is shown once, without its closing stop running into what follows", () => {
  const reason = "Test contribution; refused on purpose so nothing is imported.";
  const lines = answerLines({
    id: "C-000001", status: "refused", receivedAt: "2026-11-20T19:38:09.558Z", decidedAt: "2026-11-20T19:39:55.246Z",
    records: [
      { record: "inat:248540387", status: "refused", reason, sequences: [
        { id: "plate7-A04", status: "refused", reason, check: { dnaName: "Trametes versicolor", confidence: 100, flags: [], duplicateOf: null }, mycomapSequenceId: null, name: null },
        { id: "plate7-A05", status: "refused", reason: "Too short to name.", check: null, mycomapSequenceId: null, name: null },
      ] },
    ],
  } as Parameters<typeof answerLines>[0]);
  assert.deepEqual(lines, [
    "C-000001: refused (received 2026-11-20 19:38 UTC, decided 2026-11-20 19:39 UTC)",
    "  inat:248540387: refused - Test contribution; refused on purpose so nothing is imported",
    "    plate7-A04: refused; mycomap.org's check: Trametes versicolor (100%)",
    "    plate7-A05: refused - Too short to name",
  ]);
});
