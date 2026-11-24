// What the browser app's Contribute section shows (view.js contributionHtml):
// the agreement and the Send button before anything is sent, the state and
// the refusals after, every value escaped.
//   node --import tsx --test tool/ui/contributeView.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: view.js is the page's own plain JavaScript.
import { contributionHtml, newNameHtml, resultsHtml } from "./view.js";

const preview = { sequences: 2, records: 2, contributions: 1, sheet: null, lines: ["This sends 2 sequences of 2 records to https://mycomap.org, with your member key:", "Licence: by sending, you agree … CC BY 4.0"], leftOut: [], alreadySent: [] };
const sent = (status: string) => ({
  tool: "mycomap-validation",
  contributions: [{
    id: "C-000123", page: "https://mycomap.org/contributions/C-000123", site: "https://mycomap.org", sentAt: "2026-11-21T15:20:00.000Z", records: ["inat:2"], sequences: ["A02"], status, checkedAt: null,
    answer: { id: "C-000123", status, records: [{ record: "inat:2", status: "waiting", sequences: [{ id: "A02", status: "waiting", check: { dnaName: "<b>x</b>", confidence: 90 }, name: { kind: "new", value: null, pending: true } }] }] },
  }],
});

test("before anything is sent: what goes, the CC BY 4.0 box, the key field and the Send button; nothing is sent until it is pressed", () => {
  const html = contributionHtml({ keyGiven: false, site: "https://mycomap.org", preview, contribution: null });
  assert.match(html, /Nothing is sent until you press Send\./);
  assert.match(html, /<input type="checkbox" id="contribute-agree"> I agree that these sequences are published under CC BY 4\.0, credited to me by my MycoMap display name\./);
  assert.match(html, /<input type="password" id="member-key"/);
  assert.match(html, /<button type="button" data-contribute="send">Send 2 sequences to mycomap\.org<\/button>/);
  assert.match(html, /This sends 2 sequences of 2 records/);
  assert.doesNotMatch(html, /data-contribute="withdraw"/);
  assert.match(contributionHtml({ keyGiven: true, site: "x", preview, contribution: null }), /optional: the tool was started with one/);
});

test("after sending: the contribution's state read by read, Check again, and Withdraw only while it is not decided; refusals and mycomap.org's words are escaped", () => {
  const open = contributionHtml({ keyGiven: true, site: "https://mycomap.org", preview: { ...preview, sequences: 0, lines: [] }, contribution: sent("in_review") });
  assert.match(open, /<strong>C-000123<\/strong> <span class="badge wait">in review<\/span>/);
  assert.match(open, /A02: waiting; mycomap.org's check: <i>&lt;b&gt;x&lt;\/b&gt;<\/i> \(90%\); waiting for a MycoMap name/);
  assert.match(open, /data-contribute="status">Check again/);
  assert.match(open, /data-contribute="withdraw">Withdraw/);
  assert.doesNotMatch(open, /data-contribute="send"/, "nothing is left to send");
  assert.doesNotMatch(contributionHtml({ keyGiven: true, site: "x", preview: { ...preview, sequences: 0, lines: [] }, contribution: sent("accepted") }), /data-contribute="withdraw"/);
  const refused = contributionHtml({ keyGiven: false, site: "x", preview, contribution: null }, { error: "Only mycomap.org takes contributions: <x>" });
  assert.match(refused, /<div class="notice bad">Only mycomap\.org takes contributions: &lt;x&gt;<\/div>/);
  assert.match(contributionHtml({ keyGiven: false, site: "x", preview: { error: "This run has no sequences.fasta" }, contribution: null }), /This run has no sequences\.fasta/);
});

test("a record's new name shows, marked local only until MycoMap registers it; the results have a place for Contribute", () => {
  assert.equal(newNameHtml(null), "");
  assert.match(newNameHtml("Russula sp. 'local-A02'"), /new name: <i>Russula sp\. &#39;local-A02&#39;<\/i> \(local only: not in MycoMap until it is registered\)/);
  assert.doesNotMatch(newNameHtml("Russula sp. 'IN172'"), /local only/);
  const html = resultsHtml("r", {
    engineVersion: "2.0.0-beta.13", blast: "2.17.0", ranAt: "2026-11-21T15:15:00.000Z", databases: { mycomap: { version: "2026-11-21" }, ncbi: null },
    sequences: [], records: [{ record: "inat:2", decision: "held", species: null, reason: "Held.", newName: "Russula sp. 'local-A02'", vision: { status: "not_asked" } }],
  });
  assert.match(html, /local only/);
  assert.match(html, /<section id="contribute" class="contribute"><\/section>/);
});
