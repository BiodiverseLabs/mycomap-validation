// `run --refresh-ncbi`: NCBI's BLAST URL API asked live, against a stand-in
// NCBI on this computer (testSupport standInNcbi). No test here can reach
// NCBI: fetch refuses any host but 127.0.0.1, and the clock is a test clock,
// so NCBI's minute-long waits take no time.
//   node --import tsx --test tool/ncbiRefresh.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { main, parseArgs } from "./cli";
import { InputError } from "./fasta";
import {
  answeredByWeekly, BUSY_WAITS_MS, GIVE_UP_AFTER_MS, keyCheckRequest, ncbiAccess, NCBI_KEY_CHECK_URL, POLL_EVERY_MS, readBlastXml, readKeyCheck, refreshFromNcbi, REQUEST_SPACING_MS, type NcbiService,
} from "./ncbiRefresh";
import { runValidation, type RunOptions } from "./run";
import { blastXml, qblastPut, qblastStatus, standInNcbi, type NcbiCall } from "./testSupport";

// Nothing in these tests may leave the computer.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "127.0.0.1") throw new Error(`tests must not call ${url.host}`);
  return realFetch(input, init);
}) as typeof fetch;

const ACCESS = { apiKey: "0123456789abcdef0123456789abcdef0123", email: "someone@example.org" };

/** A test clock: waiting moves it on at once. */
function testClock(start = Date.parse("2026-11-20T15:00:00Z")) {
  const c = { t: start, waits: [] as number[], now: () => c.t, wait: async (ms: number) => { c.waits.push(ms); c.t += ms; } };
  return c;
}

/** A stand-in NCBI whose every request is stamped with the test clock's time. */
async function ncbiWith(clock: ReturnType<typeof testClock>, answer: (call: NcbiCall, index: number) => { status?: number; body: string }) {
  const at: number[] = [];
  const ncbi = await standInNcbi((call, i) => { at.push(clock.t); return answer(call, i); });
  const service: NcbiService = { url: ncbi.url, now: clock.now, wait: clock.wait };
  return { ...ncbi, at, service };
}

const SEQ = "ACGT".repeat(150);
const xmlFor = (accession: string, identity: number) => blastXml(600, [{ accession, def: "Russula emetica voucher X internal transcribed spacer 1, partial sequence", identity, alignLen: 600, qseq: SEQ, hseq: SEQ }]);

test("a Put sends the search the record store makes (blastn, megablast, nr, 50 alignments) with the key on the address and TOOL and EMAIL; the RID is polled until NCBI answers in BLAST XML", async () => {
  const clock = testClock();
  const ncbi = await ncbiWith(clock, (call) => {
    if (call.body.CMD === "Put") return { body: qblastPut("RID123", 20) };
    const polls = ncbi.calls.filter((c) => c.query.CMD === "Get").length;
    return { body: polls < 3 ? qblastStatus("WAITING") : xmlFor("MN450208.1", 594) };
  });
  const said: string[] = [];
  try {
    const out = await refreshFromNcbi([{ id: "plate7-A01", bases: SEQ }], ACCESS, (l) => said.push(l), ncbi.service);
    const [put, ...gets] = ncbi.calls;
    assert.equal(put.method, "POST");
    assert.deepEqual(put.query, { api_key: ACCESS.apiKey }, "NCBI takes the key only on the address, even for a POST");
    assert.deepEqual(put.body, { CMD: "Put", PROGRAM: "blastn", DATABASE: "nr", QUERY: SEQ, MEGABLAST: "on", ALIGNMENTS: "50", TOOL: "mycomap-validation", EMAIL: ACCESS.email });
    assert.equal(gets.length, 3);
    for (const g of gets) assert.deepEqual(g.query, { CMD: "Get", RID: "RID123", FORMAT_TYPE: "XML", TOOL: "mycomap-validation", EMAIL: ACCESS.email, api_key: ACCESS.apiKey });

    assert.equal(out.stopped, null);
    assert.deepEqual(out.keptWeekly, []);
    assert.equal(out.searched.length, 1);
    const found = out.searched[0];
    assert.equal(found.id, "plate7-A01");
    assert.equal(found.rid, "RID123");
    assert.equal(found.answeredAt, new Date(ncbi.at[3]).toISOString());
    assert.equal(found.result.hits[0].accession, "MN450208");
    assert.equal(found.result.hits[0].identity, 99);
    assert.equal(found.result.hits[0].queryCoverage, 100);
    assert.match(found.xml, /<BlastOutput>/, "NCBI's own answer is kept");
    assert.ok(said.some((l) => /^Sent plate7-A01 to NCBI \(search RID123/.test(l)));
    assert.ok(said.some((l) => /^NCBI answered plate7-A01: 1 hit, the best at 99%/.test(l)));
  } finally {
    await ncbi.close();
  }
});

test("without an API key nothing of a key is sent or said, and a refusal does not blame a key; the email address still goes with every request", async () => {
  const clock = testClock();
  const noKey = { apiKey: null, email: ACCESS.email };
  const ncbi = await ncbiWith(clock, (call) => ({ body: call.body.CMD === "Put" ? qblastPut("RIDNOKEY", 20) : xmlFor("MN450208.1", 594) }));
  const said: string[] = [];
  try {
    const out = await refreshFromNcbi([{ id: "plate7-A01", bases: SEQ }], noKey, (l) => said.push(l), ncbi.service);
    const [put, get] = ncbi.calls;
    assert.deepEqual(put.query, {}, "no api_key on the Put address");
    assert.equal(put.body.EMAIL, ACCESS.email);
    assert.deepEqual(get.query, { CMD: "Get", RID: "RIDNOKEY", FORMAT_TYPE: "XML", TOOL: "mycomap-validation", EMAIL: ACCESS.email });
    assert.equal(out.searched.length, 1);
    assert.ok(said.some((l) => /^Sending 1 sequence .* to NCBI\. NCBI asks/.test(l)), said.join("\n"));
    assert.ok(!said.join("\n").includes("API key"), "nothing said about a key");
  } finally {
    await ncbi.close();
  }
  const refused = await ncbiWith(clock, () => ({ status: 403, body: "<html><body><p>Forbidden</p></body></html>" }));
  try {
    const out = await refreshFromNcbi([{ id: "a", bases: SEQ }], noKey, () => undefined, refused.service);
    assert.equal(out.stopped, "NCBI refused the request (HTTP 403: Forbidden).");
  } finally {
    await refused.close();
  }
});

test("NCBI's guidelines are kept: one request every 10 seconds at most, and no search polled more than once a minute", async () => {
  const clock = testClock();
  let rid = 0;
  const ridOf = new Map<string, number>();
  const ncbi = await ncbiWith(clock, (call) => {
    if (call.body.CMD === "Put") return { body: qblastPut(`R${++rid}`, 5) };
    const n = (ridOf.get(call.query.RID) ?? 0) + 1;
    ridOf.set(call.query.RID, n);
    return { body: n < 2 ? qblastStatus("WAITING") : xmlFor("AB1.1", 590) };
  });
  try {
    const sequences = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, bases: SEQ }));
    const out = await refreshFromNcbi(sequences, ACCESS, () => undefined, ncbi.service);
    assert.equal(out.searched.length, 7);
    for (let i = 1; i < ncbi.at.length; i++) assert.ok(ncbi.at[i] - ncbi.at[i - 1] >= REQUEST_SPACING_MS, `request ${i} came ${ncbi.at[i] - ncbi.at[i - 1]} ms after the one before`);
    // Each search's own requests (its Put, then its polls) are a minute apart or more.
    const byRid = new Map<string, number[]>();
    let putRid = 0;
    ncbi.calls.forEach((c, i) => {
      const r = c.body.CMD === "Put" ? `R${++putRid}` : c.query.RID;
      byRid.set(r, [...(byRid.get(r) ?? []), ncbi.at[i]]);
    });
    for (const [r, times] of byRid) for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= POLL_EVERY_MS, `${r} was asked about ${times[i] - times[i - 1]} ms after the last time`);
    assert.ok(Math.max(...[...byRid.values()].map((t) => t.length)) >= 3, "every search was polled until it answered");
  } finally {
    await ncbi.close();
  }
});

test("a slow NCBI is said to be slow; a search it never finishes is given up after an hour and its sequence keeps the weekly hits", async () => {
  const clock = testClock();
  const ncbi = await ncbiWith(clock, (call) => ({ body: call.body.CMD === "Put" ? qblastPut("SLOW1") : qblastStatus("WAITING") }));
  const said: string[] = [];
  try {
    const out = await refreshFromNcbi([{ id: "slowpoke", bases: SEQ }], ACCESS, (l) => said.push(l), ncbi.service);
    assert.equal(out.searched.length, 0);
    assert.equal(out.keptWeekly.length, 1);
    assert.match(out.keptWeekly[0].reason, /^NCBI had not finished after 60 minutes \(search SLOW1\)/);
    assert.equal(said.filter((l) => /^NCBI is slow: slowpoke has been searching for \d+ minutes/.test(l)).length, 1, "said once, not every minute");
    assert.ok(said.some((l) => /slowpoke: NCBI had not finished .*keeps the weekly database's hits/.test(l)));
    const polls = ncbi.calls.length - 1;
    assert.ok(polls <= GIVE_UP_AFTER_MS / POLL_EVERY_MS + 1, `${polls} polls in an hour`);
  } finally {
    await ncbi.close();
  }
});

test("a busy NCBI (code -99, temporarily unavailable, 429, 503) is waited for and asked again; one that stays busy stops the refresh, and every sequence keeps its weekly hits", async () => {
  const clock = testClock();
  const busyFirst = [
    { status: 200, body: "<p>Error: code: -99 too many requests</p>" },
    { status: 503, body: "Service Temporarily Unavailable" },
  ];
  const ncbi = await ncbiWith(clock, (call, i) => busyFirst[i] ?? (call.body.CMD === "Put" ? { body: qblastPut("B1") } : { body: xmlFor("AB2.1", 600) }));
  const said: string[] = [];
  try {
    const out = await refreshFromNcbi([{ id: "a", bases: SEQ }], ACCESS, (l) => said.push(l), ncbi.service);
    assert.equal(out.searched.length, 1, "answered once NCBI was free");
    assert.deepEqual(clock.waits.filter((w) => w >= BUSY_WAITS_MS[0]).slice(0, 2), [BUSY_WAITS_MS[0], BUSY_WAITS_MS[1]], "two minutes, then four");
    assert.ok(said.some((l) => /^NCBI is busy \(Error: code: -99 too many requests\) sending a\./.test(l)), said.join("\n"));
    assert.ok(said.some((l) => /^NCBI is busy \(HTTP 503: Service Temporarily Unavailable\) sending a\./.test(l)));
  } finally {
    await ncbi.close();
  }

  const clock2 = testClock();
  const always = await ncbiWith(clock2, () => ({ status: 429, body: "" }));
  const said2: string[] = [];
  try {
    const out = await refreshFromNcbi([{ id: "a", bases: SEQ }, { id: "b", bases: SEQ }], ACCESS, (l) => said2.push(l), always.service);
    assert.equal(always.calls.length, BUSY_WAITS_MS.length + 1, "asked again after each wait, then stopped");
    assert.match(out.stopped ?? "", /^NCBI stayed busy, so the refresh stopped\. Try --refresh-ncbi again later/);
    assert.deepEqual(out.keptWeekly.map((k) => k.id), ["a", "b"]);
    assert.ok(said2.some((l) => l === "2 sequences keep the weekly database's hits: a, b."));
  } finally {
    await always.close();
  }
});

test("NCBI refusing the key stops at once; NCBI refusing one search keeps that sequence's weekly hits and goes on to the next", async () => {
  const clock = testClock();
  const refused = await ncbiWith(clock, () => ({ status: 403, body: "<html><body><p>API key invalid</p></body></html>" }));
  try {
    const out = await refreshFromNcbi([{ id: "a", bases: SEQ }, { id: "b", bases: SEQ }], ACCESS, () => undefined, refused.service);
    assert.equal(refused.calls.length, 1, "nothing more is sent after NCBI refuses the key");
    assert.match(out.stopped ?? "", /^NCBI refused the request \(HTTP 403: API key invalid\)\. Check your NCBI API key\./);
    assert.deepEqual(out.keptWeekly.map((k) => k.id), ["a", "b"]);
  } finally {
    await refused.close();
  }

  const clock2 = testClock();
  const oneRefused = await ncbiWith(clock2, (call, i) => {
    if (i === 0) return { body: '<html><div class="error msInf">Message ID#24 Error: Query contains no sequence data</div></html>' };
    return call.body.CMD === "Put" ? { body: qblastPut("OK2") } : { body: xmlFor("AB3.1", 600) };
  });
  const said: string[] = [];
  try {
    const out = await refreshFromNcbi([{ id: "bad", bases: "NNNN" }, { id: "good", bases: SEQ }], ACCESS, (l) => said.push(l), oneRefused.service);
    assert.deepEqual(out.keptWeekly, [{ id: "bad", reason: "NCBI refused the search (Query contains no sequence data)" }]);
    assert.deepEqual(out.searched.map((s) => s.id), ["good"]);
    assert.equal(out.stopped, null);
    assert.ok(said.includes("bad: NCBI refused the search (Query contains no sequence data); it keeps the weekly database's hits."));
  } finally {
    await oneRefused.close();
  }
});

// NCBI's BLAST takes a key it does not know without a word, then never finishes the search (2026-11-24:
// a made-up key got HTTP 200, a search id, then WAITING for 50+ minutes), so the key is checked with
// E-utilities first, which refuses it.
const NOT_WELLFORMED = JSON.stringify({ error: "API key not wellformed", "api-key": ACCESS.apiKey, type: "api-key-fake", status: "unknown" });

test("a key NCBI does not know stops the refresh before any sequence is sent, in NCBI's own words", async () => {
  const clock = testClock();
  const ncbi = await standInNcbi(() => ({ body: qblastPut("NEVER") }), () => ({ status: 400, body: NOT_WELLFORMED }));
  const said: string[] = [];
  try {
    const out = await refreshFromNcbi([{ id: "a", bases: SEQ }, { id: "b", bases: SEQ }], ACCESS, (l) => said.push(l), { url: ncbi.url, now: clock.now, wait: clock.wait });
    assert.equal(ncbi.calls.length, 0, "no search is sent");
    assert.equal(ncbi.keyChecks.length, 1);
    assert.deepEqual(ncbi.keyChecks[0].query, { retmode: "json", tool: "mycomap-validation", email: ACCESS.email, api_key: ACCESS.apiKey });
    assert.match(out.stopped ?? "", /^NCBI says your API key is not valid \("API key not wellformed"\), so nothing was sent\. Check the key under API Key Management/);
    assert.deepEqual(out.keptWeekly.map((k) => k.id), ["a", "b"]);
    assert.ok(said.some((l) => l.startsWith("NCBI says your API key is not valid")));
  } finally {
    await ncbi.close();
  }
});

test("without a key nothing is checked; a key NCBI takes goes on to the searches; a check NCBI cannot answer does not stop them", async () => {
  const answer = (call: NcbiCall) => (call.body.CMD === "Put" ? { body: qblastPut("K1") } : { body: xmlFor("AB1.1", 600) });
  for (const [label, access, keyCheck, checks, note] of [
    ["no key", { apiKey: null, email: ACCESS.email }, undefined, 0, null],
    ["a key NCBI takes", ACCESS, undefined, 1, null],
    ["E-utilities busy", ACCESS, () => ({ status: 503, body: "<html>Service unavailable</html>" }), 1, "Could not check your NCBI API key with NCBI (HTTP 503); going on with it."],
    ["an answer that is neither", ACCESS, () => ({ body: "<html>maintenance</html>" }), 1, "Could not check your NCBI API key with NCBI (HTTP 200); going on with it."],
  ] as const) {
    const clock = testClock();
    const ncbi = await standInNcbi(answer, keyCheck as any);
    const said: string[] = [];
    try {
      const out = await refreshFromNcbi([{ id: "a", bases: SEQ }], access as any, (l) => said.push(l), { url: ncbi.url, now: clock.now, wait: clock.wait });
      assert.equal(ncbi.keyChecks.length, checks, label);
      assert.equal(out.stopped, null, label);
      assert.deepEqual(out.searched.map((x) => x.id), ["a"], label);
      if (note) assert.ok(said.includes(note), `${label}: ${said.join(" | ")}`);
      else assert.equal(said.some((l) => l.startsWith("Could not check")), false, label);
    } finally {
      await ncbi.close();
    }
  }
});

test("the key check asks E-utilities with the key, TOOL and EMAIL, and only a refusal that names the key counts as one", () => {
  const url = new URL(keyCheckRequest(ACCESS));
  assert.equal(`${url.origin}${url.pathname}`, NCBI_KEY_CHECK_URL);
  assert.deepEqual(Object.fromEntries(url.searchParams), { retmode: "json", tool: "mycomap-validation", email: ACCESS.email, api_key: ACCESS.apiKey });
  assert.equal(readKeyCheck(200, JSON.stringify({ header: {}, einforesult: { dblist: ["nuccore"] } })), "ok");
  assert.deepEqual(readKeyCheck(400, NOT_WELLFORMED), { refused: "API key not wellformed" });
  assert.deepEqual(readKeyCheck(400, JSON.stringify({ error: "API key invalid", type: "api-key-invalid" })), { refused: "API key invalid" });
  assert.deepEqual(readKeyCheck(200, JSON.stringify({ error: "API key invalid" })), { refused: "API key invalid" });
  assert.equal(readKeyCheck(400, JSON.stringify({ error: "Invalid db name specified: x" })), "unknown", "a refusal of something else is not the key's");
  assert.equal(readKeyCheck(429, JSON.stringify({ error: "API rate limit exceeded" })), "unknown");
  assert.equal(readKeyCheck(503, NOT_WELLFORMED), "unknown", "a server error is never read as a refusal");
  assert.equal(readKeyCheck(0, ""), "unknown");
});

test("NCBI's other answers: a failed search, one it lost (sent once more), and finished with no hits", async () => {
  const clock = testClock();
  let puts = 0;
  const ncbi = await ncbiWith(clock, (call) => {
    if (call.body.CMD === "Put") return { body: qblastPut(`L${++puts}`) };
    const rid = call.query.RID;
    if (rid === "L1") return { body: qblastStatus("FAILED") };
    if (rid === "L2") return { body: qblastStatus("UNKNOWN") };
    return { body: qblastStatus("READY", "no") };
  });
  try {
    const out = await refreshFromNcbi([{ id: "fails", bases: SEQ }, { id: "lost", bases: SEQ }], ACCESS, () => undefined, ncbi.service);
    assert.deepEqual(out.keptWeekly, [{ id: "fails", reason: "NCBI's search failed (search L1)" }]);
    assert.equal(puts, 3, "the lost search is sent once more");
    assert.deepEqual(out.searched.map((s) => [s.id, s.rid, s.result.hits.length]), [["lost", "L3", 0]]);
  } finally {
    await ncbi.close();
  }
});

test("an NCBI that cannot be reached says so in words, and stops", async () => {
  const ncbi = await standInNcbi(() => ({ body: "" }));
  const url = ncbi.url;
  await ncbi.close();
  const clock = testClock();
  const out = await refreshFromNcbi([{ id: "a", bases: SEQ }], ACCESS, () => undefined, { url, now: clock.now, wait: clock.wait });
  assert.match(out.stopped ?? "", /^NCBI could not be reached \(.+\)\. Are you online\?$/);
  assert.deepEqual(out.keptWeekly.map((k) => k.id), ["a"]);
});

test("a sequence is sent only when the weekly database has no hit at 97% or better (to two places, as the record store reads it)", () => {
  const hit = (identity: number) => ({ identity }) as never;
  assert.equal(answeredByWeekly({ queryLen: 600, hits: [hit(96.99)] }), false);
  assert.equal(answeredByWeekly({ queryLen: 600, hits: [hit(97)] }), true);
  assert.equal(answeredByWeekly({ queryLen: 600, hits: [hit(96.996)] }), true, "96.996 is 97.00 to two places");
  assert.equal(answeredByWeekly({ queryLen: 600, hits: [hit(90), hit(98.5)] }), true, "any hit, not only the first BLAST lists");
  assert.equal(answeredByWeekly({ queryLen: 600, hits: [] }), false, "no hits at all");
  assert.equal(answeredByWeekly(undefined), false);
});

test("BLAST XML is read as mycomap.org reads it: NCBI's order, first-HSP identity and coverage, names with their entities undone", () => {
  const xml = blastXml(500, [
    { accession: "NR_1.1", def: "Amanita muscaria &amp; friends &lt;type&gt;", identity: 450, alignLen: 500, queryFrom: 51, queryTo: 500 },
    { accession: "OQ2.1", def: "uncultured fungus", identity: 400, alignLen: 400 },
  ]);
  const r = readBlastXml(xml)!;
  assert.equal(r.queryLen, 500);
  assert.deepEqual(r.hits.map((h) => [h.num, h.accession, h.id, h.def, h.identity, h.queryCoverage]), [
    [1, "NR_1", "gb|NR_1.1|", "Amanita muscaria & friends <type>", 90, 90],
    [2, "OQ2", "gb|OQ2.1|", "uncultured fungus", 100, 80],
  ]);
  assert.equal(readBlastXml(qblastStatus("WAITING")), null, "not BLAST XML");
  assert.deepEqual(readBlastXml(blastXml(321, [])), { queryLen: 321, hits: [] });
});

test("the email address (required) and key (optional) come from the options or NCBI_API_KEY and NCBI_EMAIL; what is missing or wrong is said", () => {
  assert.deepEqual(ncbiAccess({ apiKey: ACCESS.apiKey, email: ACCESS.email }, {}), ACCESS);
  assert.deepEqual(ncbiAccess({}, { NCBI_API_KEY: ACCESS.apiKey, NCBI_EMAIL: ACCESS.email }), ACCESS);
  assert.deepEqual(ncbiAccess({ apiKey: "abcdefabcdef" }, { NCBI_API_KEY: ACCESS.apiKey, NCBI_EMAIL: ACCESS.email }).apiKey, "abcdefabcdef", "the option over the environment");
  assert.deepEqual(ncbiAccess({ email: ACCESS.email }, {}), { apiKey: null, email: ACCESS.email }, "the key is optional");
  assert.deepEqual(ncbiAccess({ apiKey: "  ", email: ACCESS.email }, {}), { apiKey: null, email: ACCESS.email }, "an empty key box is no key");
  assert.throws(() => ncbiAccess({}, {}), (e: Error) => e instanceof InputError && /needs your email address \(--ncbi-email, or NCBI_EMAIL\).*An NCBI API key is optional/.test(e.message));
  assert.throws(() => ncbiAccess({ apiKey: ACCESS.apiKey }, {}), /needs your email address \(--ncbi-email, or NCBI_EMAIL\)/, "a key without an email address is not enough");
  assert.throws(() => ncbiAccess({ apiKey: "my key!", email: ACCESS.email }, {}), /does not look like one/);
  assert.throws(() => ncbiAccess({ apiKey: ACCESS.apiKey, email: "nobody" }, {}), /"nobody" does not look like an email address/);
});

// ── run --refresh-ncbi, end to end, with BLAST+ stood in ──

const COLUMNS = ["mm_id", "sequence_id", "name", "mycobank_number", "kingdom", "phylum", "class", "order", "family", "genus", "method", "on_validated_record", "in_reference_set", "reference_exclusion", "flags", "reads_in_consensus", "length", "genbank_accession", "observation", "observation_url", "updated_at"];

function inTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmv ncbi "));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/**
 * A data folder (MycoMap's database, its names table, and GenBank's weekly
 * fungal ITS from 2026-11-15) and a stand-in blastn: MycoMap finds nothing;
 * the weekly GenBank database answers "known" at 99%, "far" only at 90%, and
 * "unknown" not at all.
 */
function setUp(dir: string, opts: { weekly?: boolean } = {}) {
  const data = path.join(dir, "data");
  fs.mkdirSync(path.join(data, "mycomap"), { recursive: true });
  fs.writeFileSync(path.join(data, "mycomap", "mycomap.nin"), "");
  fs.writeFileSync(path.join(data, "mycomap_sequences_2026-11-20.tsv.gz"), zlib.gzipSync(`${COLUMNS.join("\t")}\n`));
  if (opts.weekly !== false) {
    fs.mkdirSync(path.join(data, "ncbi_its_db"), { recursive: true });
    fs.writeFileSync(path.join(data, "ncbi_its_db", "genbank_its.nin"), "");
    fs.writeFileSync(path.join(data, "ncbi_its_db", "info.txt"), "Built: 2026-11-15\n");
  }
  const fasta = path.join(dir, "q.fasta");
  fs.writeFileSync(fasta, `>known\n${SEQ}\n>far\n${"GATTACA".repeat(80)}\n>unknown\n${"TTAGGC".repeat(90)}\n`);
  const row = (q: string, acc: string, nident: number) => [q, `gb|${acc}|`, acc, "600", "620", "600", String(nident), "1", "600", "1", "600", "ACGT", "ACGT", `${acc} Lactarius deliciosus voucher ITS region`].join("\t");
  const run: RunOptions["run"] = async (program, args, place = {}) => {
    if (args.includes("-version")) return { code: 0, stdout: "blastn: 2.17.0+", stderr: "" };
    if (args.includes("-info")) return { code: 0, stdout: "Database: MycoMap reference sequences 2026-11-20\n", stderr: "" };
    const db = args[args.indexOf("-db") + 1];
    const table = db.includes("genbank_its") ? [row("known", "KX1.1", 594), row("far", "KX2.1", 540)].join("\n") + "\n" : "";
    fs.writeFileSync(path.join(place.cwd!, args[args.indexOf("-out") + 1]), table);
    return { code: 0, stdout: "", stderr: "" };
  };
  return { data, fasta, run };
}

/** Every file a run left, as text, to look for the key in. */
function everything(folder: string): string {
  return fs.readdirSync(folder, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => fs.readFileSync(path.join(e.parentPath, e.name), "utf8")).join("\n");
}

test("run --refresh-ncbi sends only the sequences the weekly database does not answer; NCBI's hits replace theirs, and the stamp says NCBI: live with the date", () => inTemp(async (dir) => {
  const { data, fasta, run } = setUp(dir);
  const clock = testClock(Date.parse("2026-11-20T15:00:00Z"));
  let rid = 0;
  const ncbi = await ncbiWith(clock, (call) => call.body.CMD === "Put" ? { body: qblastPut(`RUN${++rid}`) } : { body: xmlFor(`LIVE${call.query.RID}.1`, 600) });
  const said: string[] = [];
  try {
    const out = path.join(dir, "out");
    const output = await runValidation({ fasta, data, out, threads: 1, ncbi: true, run, refreshNcbi: ACCESS, ncbiService: ncbi.service, say: (l) => said.push(l), now: () => new Date("2026-11-20T16:00:00Z") });
    const sent = ncbi.calls.filter((c) => c.body.CMD === "Put").map((c) => c.body.QUERY);
    assert.deepEqual(sent, ["GATTACA".repeat(80), "TTAGGC".repeat(90)], "far (90%) and unknown (no hit), never known (99%)");

    const [known, far, unknown] = output.sequences;
    assert.equal(known.ncbiLive, undefined);
    assert.equal(known.ncbiHits?.[0].accession, "KX1.1", "known keeps the weekly hits");
    assert.deepEqual(far.ncbiLive, { rid: "RUN1", answeredAt: far.ncbiLive!.answeredAt });
    assert.equal(far.ncbiHits?.[0].accession, "LIVERUN1", "far's GenBank hits are NCBI's live ones");
    assert.equal(far.ncbiHits?.[0].identity, 100);
    assert.equal(unknown.ncbiHits?.[0].accession, "LIVERUN2");
    assert.equal(far.ncbiHitCount, 1);

    const live = output.stamp.databases.ncbi!.live!;
    assert.equal(output.stamp.databases.ncbi!.version, "2026-11-15");
    assert.equal(live.label, "NCBI: live");
    assert.equal(live.date, "2026-11-20");
    assert.deepEqual(live.search, { program: "blastn", megablast: true, database: "nr", alignments: 50 });
    assert.equal(live.sentBelow, 97);
    assert.deepEqual(live.sequences.map((s) => [s.id, s.rid]), [["far", "RUN1"], ["unknown", "RUN2"]]);
    assert.deepEqual(live.keptWeekly, []);

    const csv = fs.readFileSync(output.files.csv, "utf8").split("\r\n");
    assert.match(csv[1], /^known,.*,2026-11-15$/);
    assert.match(csv[2], /^far,.*,NCBI: live 2026-11-20$/);
    assert.match(csv[3], /^unknown,.*,NCBI: live 2026-11-20$/);
    const records = fs.readFileSync(output.files.recordsCsv, "utf8").split("\r\n");
    assert.match(records[2], /^far,.*,NCBI: live 2026-11-20$/);
    const json = JSON.parse(fs.readFileSync(output.files.json, "utf8"));
    assert.equal(json.databases.ncbi.live.label, "NCBI: live");
    assert.deepEqual(fs.readdirSync(output.files.ncbiLive!).sort(), ["2_far.xml", "3_unknown.xml"], "NCBI's own answers are kept");

    assert.ok(said.includes("2 of 3 sequences have no weekly GenBank hit at 97% or better."));
    assert.ok(!everything(out).includes(ACCESS.apiKey), "the key is in no file the run leaves");
    assert.ok(!said.join("\n").includes(ACCESS.apiKey), "nor in anything said");
  } finally {
    await ncbi.close();
  }
}));

test("run --refresh-ncbi: a sequence NCBI does not answer keeps its weekly hits and date, and the stamp says why", () => inTemp(async (dir) => {
  const { data, fasta, run } = setUp(dir);
  const clock = testClock();
  const ncbi = await ncbiWith(clock, (call) => {
    if (call.body.CMD !== "Put") return { body: qblastStatus("FAILED") };
    return { body: qblastPut("F1") };
  });
  try {
    const output = await runValidation({ fasta, data, out: path.join(dir, "out"), threads: 1, ncbi: true, run, refreshNcbi: ACCESS, ncbiService: ncbi.service });
    const far = output.sequences[1];
    assert.equal(far.ncbiLive, undefined);
    assert.equal(far.ncbiHits?.[0].accession, "KX2.1");
    assert.deepEqual(output.stamp.databases.ncbi!.live!.keptWeekly.map((k) => k.id), ["far", "unknown"]);
    assert.match(fs.readFileSync(output.files.csv, "utf8").split("\r\n")[2], /,2026-11-15$/);
    assert.equal(output.files.ncbiLive, undefined);
  } finally {
    await ncbi.close();
  }
}));

test("without --refresh-ncbi nothing is sent to NCBI, even with an NCBI key set and sequences the weekly database does not answer", () => inTemp(async (dir) => {
  const { data, fasta, run } = setUp(dir);
  const clock = testClock();
  const ncbi = await ncbiWith(clock, () => ({ body: qblastPut("NEVER") }));
  const before = { key: process.env.NCBI_API_KEY, email: process.env.NCBI_EMAIL };
  process.env.NCBI_API_KEY = ACCESS.apiKey;
  process.env.NCBI_EMAIL = ACCESS.email;
  try {
    const output = await runValidation({ fasta, data, out: path.join(dir, "out"), threads: 1, ncbi: true, run, ncbiService: ncbi.service });
    assert.equal(ncbi.calls.length, 0);
    assert.equal(output.stamp.databases.ncbi!.live, undefined);
    assert.match(fs.readFileSync(output.files.csv, "utf8").split("\r\n")[2], /,2026-11-15$/);

    assert.equal(parseArgs(["run", "q.fasta"]).refreshNcbi, undefined, "the key in the environment is not an opt-in");
    assert.equal(parseArgs(["run", "q.fasta", "--refresh-ncbi"]).refreshNcbi, true);
    assert.deepEqual(parseArgs(["run", "q.fasta", "--refresh-ncbi", "--ncbi-key", "k", "--ncbi-email", "e@example.org"]), { command: "run", ncbi: true, fasta: "q.fasta", refreshNcbi: true, ncbiKey: "k", ncbiEmail: "e@example.org" });
    assert.throws(() => parseArgs(["run", "q.fasta", "--ncbi-key", "k"]), /--ncbi-key is for --refresh-ncbi, which was not given: nothing is sent to NCBI without it\./);
  } finally {
    for (const [k, v] of [["NCBI_API_KEY", before.key], ["NCBI_EMAIL", before.email]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await ncbi.close();
  }
}));

test("--refresh-ncbi needs the weekly database and an email address, and says so before anything is searched or sent", () => inTemp(async (dir) => {
  const { data, fasta, run } = setUp(dir, { weekly: false });
  const clock = testClock();
  const ncbi = await ncbiWith(clock, () => ({ body: qblastPut("NEVER") }));
  try {
    await assert.rejects(runValidation({ fasta, data, out: path.join(dir, "out"), threads: 1, ncbi: true, run, refreshNcbi: ACCESS, ncbiService: ncbi.service }),
      (e: Error) => e instanceof InputError && /that database is not in .*Download it first: mycomap-validation init/.test(e.message));
    await assert.rejects(runValidation({ fasta, data, out: path.join(dir, "out"), threads: 1, ncbi: false, run, refreshNcbi: ACCESS, ncbiService: ncbi.service }), /cannot go with --no-ncbi/);
    assert.equal(ncbi.calls.length, 0);

    const before = { key: process.env.NCBI_API_KEY, email: process.env.NCBI_EMAIL };
    delete process.env.NCBI_API_KEY;
    delete process.env.NCBI_EMAIL;
    try {
      const printed: string[] = [];
      assert.equal(await main(["run", fasta, "--data", data, "--refresh-ncbi"], (l) => printed.push(l)), 1);
      assert.match(printed.join("\n"), /^Refreshing from NCBI needs your email address/);
    } finally {
      if (before.key !== undefined) process.env.NCBI_API_KEY = before.key;
      if (before.email !== undefined) process.env.NCBI_EMAIL = before.email;
    }
  } finally {
    await ncbi.close();
  }
}));
