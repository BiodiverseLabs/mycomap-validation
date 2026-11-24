// What the browser app shows (view.js): every value from a file is escaped,
// each decision and step is marked as it should be.
//   node --import tsx --test tool/ui/view.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: view.js is the page's own plain JavaScript.
import { esc, exportsHtml, progressHtml, resultsHtml, runsListHtml, sequenceDetailHtml, statusHtml } from "./view.js";

const sequence = (over: Record<string, unknown> = {}) => ({
  id: "plate7-A01", mycomapHitCount: 2, ncbiHitCount: null, ncbiHits: null,
  mycomapHits: [{ accession: "MM1", name: "Russula emetica", identity: 99.67, adjustedIdentity: 100, coverage: 100, validated: true, flags: [] }],
  result: { finalSpecies: "Russula emetica", finalConfidence: 92, flaggedContaminant: false, flaggedNonTarget: false, barcodeGapNeeded: false, noBlastHits: false, steps: [] },
  ...over,
});
const results = (over: Record<string, unknown> = {}) => ({
  engineVersion: "2.0.0-beta.12", blast: "2.17.0", ranAt: "2026-11-20T16:25:00.000Z", input: { fasta: "plate7.fasta" },
  databases: { mycomap: { version: "2026-11-20" }, ncbi: null },
  sequences: [sequence()],
  records: [
    { record: "OMDL-1", observerName: "Russula", decision: "validate", species: "Russula emetica", reason: "Validated as Russula emetica." },
    { record: "OMDL-2", observerName: null, decision: "held", species: null, reason: "No second source." },
    { record: "OMDL-3", observerName: null, decision: "reject", species: null, reason: "Rejected: every read is a contaminant." },
  ],
  ...over,
});

test("anything read from a file is shown as text, never run as HTML", () => {
  assert.equal(esc(`<img src=x onerror="alert(1)">'&`), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;");
  const html = resultsHtml("r", results({
    input: { fasta: "<script>a()</script>.fasta" },
    sequences: [sequence({ id: "<b>A01</b>", result: { ...sequence().result, finalSpecies: "<i onclick=x>" } })],
    records: [{ record: "<svg onload=x>", observerName: "<u>", decision: "held", species: null, reason: "<script>b()</script>" }],
  }));
  assert.doesNotMatch(html, /<script>|<svg|<b>A01|<i onclick|<u>/);
  assert.match(html, /&lt;script&gt;a\(\)&lt;\/script&gt;\.fasta/);
});

test("each record shows its decision as a badge, its species in italics, and the reason; the heading counts them", () => {
  const html = resultsHtml("r", results());
  assert.match(html, /<span class="badge ok">Validated<\/span>[\s\S]*OMDL-1[\s\S]*<i>Russula emetica<\/i>[\s\S]*Validated as Russula emetica\./);
  assert.match(html, /<span class="badge wait">Held for a person<\/span>/);
  assert.match(html, /<span class="badge bad">Rejected<\/span>/);
  assert.match(html, /Records <span class="muted">1 validated, 1 held, 1 rejected<\/span>/);
  assert.match(html, /MycoMap database 2026-11-20 · GenBank not searched · BLAST\+ 2\.17\.0 · 2026-11-20 16:25 UTC/);
  assert.match(html, /data-file="records\.csv"/);
});

test("a sequence's row gives its DNA name, confidence, flags and best hit; with no name it says so", () => {
  const html = resultsHtml("r", results({ sequences: [
    sequence(),
    sequence({ id: "A02", mycomapHits: [], result: { ...sequence().result, finalSpecies: null, finalConfidence: null, flaggedContaminant: true, contaminantLikelyName: { name: "Hypomyces chrysospermus" } } }),
  ] }));
  assert.match(html, /<td class="num">92%<\/td>/);
  assert.match(html, /<i>Russula emetica<\/i> <span class="muted">100%<\/span>/, "the best hit's adjusted identity");
  assert.match(html, /no DNA name<\/span><div class="muted">likely <i>Hypomyces chrysospermus<\/i><\/div>/);
  assert.match(html, /<span class="badge flag">contaminant<\/span>/);
});

test("a sequence's detail marks each step as the rules ended it, and lists its hits; an unsearched database says so", () => {
  const html = sequenceDetailHtml(sequence({ result: { ...sequence().result, steps: [
    { step: "Preparation", status: "pass", message: "Both results are available" },
    { step: "Source Record Comparison", status: "fail", message: "Family mismatch" },
    { step: "NCBI Low-Identity Name Check", status: "info", message: "also found below 98.5%" },
  ] } }));
  assert.match(html, /<li class="step pass"><span class="mark" aria-hidden="true">✓<\/span>\s*<span class="step-name">Preparation<\/span>/);
  assert.match(html, /<li class="step fail"><span class="mark" aria-hidden="true">✗<\/span>/);
  assert.match(html, /<li class="step info"><span class="mark" aria-hidden="true">·<\/span>/);
  assert.match(html, /MycoMap: 2 hits, the best ten/);
  assert.match(html, /<td>MM1<\/td><td><i>Russula emetica<\/i><\/td><td class="num">99\.67%<\/td>\s*<td class="num">100%<\/td>/);
  assert.match(html, /GenBank: 0 hits, the best ten: not searched\./);
});

test("the side panels: the databases, a folder not set up, the past runs, and a run in progress or stopped", () => {
  assert.match(statusHtml({ engineVersion: "2.0.0", data: { ok: true, mycomap: "2026-11-20", ncbi: null, blast: "installed by init" } }), /GenBank fungal ITS<\/dt><dd>not downloaded/);
  assert.match(statusHtml({ engineVersion: "2.0.0", data: { ok: false, problem: "Missing <x>. Or run: mycomap-validation init" } }), /Not set up yet\.<\/strong> Missing &lt;x&gt;\. Or run: mycomap-validation init/);
  assert.match(runsListHtml([], null), /No runs yet/);
  const list = runsListHtml([{ id: "2026-11-20_162446_p", ranAt: "2026-11-20T16:25:00Z", fasta: "p.fasta", sequences: 1, records: { validate: 2 } }], "2026-11-20_162446_p");
  assert.match(list, /class="run-link current" data-run="2026-11-20_162446_p"/);
  assert.match(list, /1 sequence · 2 validated/);
  assert.match(progressHtml({ state: "running", lines: ["Searching…"] }), /Working…[\s\S]*<li>Searching…<\/li>/);
  assert.match(progressHtml({ state: "failed", lines: [], error: "BLAST+ was not found." }), /The run stopped\.<\/strong> BLAST\+ was not found\./);
});

test("hits NCBI answered live are marked so, with the date, and the run's stamp says how many", () => {
  const live = sequence({ ncbiHitCount: 1, ncbiLive: { rid: "R1", answeredAt: "2026-11-20T15:03:00.000Z" }, ncbiHits: [{ accession: "MN450208", name: "Russula emetica", identity: 99, adjustedIdentity: null, coverage: 100 }] });
  assert.match(sequenceDetailHtml(live), /<caption>GenBank \(NCBI: live, 2026-11-20\): 1 hits, the best ten<\/caption>/);
  assert.match(sequenceDetailHtml(sequence({ ncbiHitCount: 1, ncbiHits: live.ncbiHits })), /<caption>GenBank: 1 hits/, "weekly hits are not marked live");
  const html = resultsHtml("r", results({ databases: { mycomap: { version: "2026-11-20" }, ncbi: { version: "2026-11-15", live: { label: "NCBI: live", date: "2026-11-20", sequences: [{ id: "plate7-A01" }] } } } }));
  assert.match(html, /GenBank 2026-11-15 · NCBI: live 2026-11-20 for 1 sequence · BLAST\+/);
  assert.doesNotMatch(resultsHtml("r", results()), /NCBI: live/);
});

test("a run with a validated record offers the files to submit; one with none says there is nothing to submit", () => {
  const html = resultsHtml("r", results());
  for (const file of ["darwin-core.csv", "genbank.fasta", "genbank-source.tsv", "inaturalist.txt", "export-report.txt"]) {
    assert.match(html, new RegExp(`data-file="${file.replace(".", "\\.")}"`), `a Save button for ${file}`);
  }
  assert.match(html, /For the 1 validated record: /);
  const none = exportsHtml([{ decision: "held" }]);
  assert.doesNotMatch(none, /data-file/);
  assert.match(none, /No record is validated/);
});
