// What the page shows, as plain functions from the results to HTML, so they
// can be tested without a browser (view.test.ts). Every value from a file is
// escaped before it is shown.

/** @param {unknown} value */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const DECISION = {
  validate: { label: "Validated", cls: "ok" },
  reject: { label: "Rejected", cls: "bad" },
  held: { label: "Held for a person", cls: "wait" },
};
const MARK = { pass: "✓", fail: "✗", skip: "–", info: "·", pending: "…", running: "…" };

/** A species name in italics, as names are written. */
function species(name) {
  return name ? `<i>${esc(name)}</i>` : `<span class="none">no DNA name</span>`;
}

/** The databases and BLAST+, or what to do when they are missing. */
export function statusHtml(status) {
  const d = status.data;
  if (!d.ok) return `<div class="notice bad"><strong>Not set up yet.</strong> ${esc(d.problem)}</div>`;
  return `<dl class="facts">
    <div><dt>Engine</dt><dd>${esc(status.engineVersion)}</dd></div>
    <div><dt>MycoMap database</dt><dd>${esc(d.mycomap ?? "date unknown")}</dd></div>
    <div><dt>GenBank fungal ITS</dt><dd>${d.ncbi ? esc(d.ncbi) : "not downloaded"}</dd></div>
    <div><dt>BLAST+</dt><dd>${esc(d.blast)}</dd></div>
  </dl>`;
}

function countsText(records) {
  const parts = [["validate", "validated"], ["held", "held"], ["reject", "rejected"]]
    .filter(([k]) => records[k]).map(([k, w]) => `${records[k]} ${w}`);
  return parts.length ? parts.join(", ") : "no records";
}

/** The past runs, newest first. */
export function runsListHtml(runs, currentId) {
  if (!runs.length) return `<p class="muted">No runs yet. Choose a FASTA file above to start one.</p>`;
  return `<ul class="runs">${runs.map((r) => `<li><button type="button" class="run-link${r.id === currentId ? " current" : ""}" data-run="${esc(r.id)}">
      <span class="run-name">${esc(r.fasta ?? r.id)}</span>
      <span class="run-meta">${esc(r.ranAt ? r.ranAt.slice(0, 16).replace("T", " ") : r.id)} · ${r.sequences} sequence${r.sequences === 1 ? "" : "s"} · ${esc(countsText(r.records))}</span>
    </button></li>`).join("")}</ul>`;
}

/** A run in progress: BLAST's and the rules' progress lines, or why it stopped. */
export function progressHtml(progress) {
  const lines = progress.lines.map((l) => `<li>${esc(l)}</li>`).join("");
  if (progress.state === "failed") return `<div class="notice bad"><strong>The run stopped.</strong> ${esc(progress.error)}</div><ol class="progress">${lines}</ol>`;
  return `<p class="working">Working… BLAST takes about two seconds a sequence.</p><ol class="progress">${lines}</ol>`;
}

function stampLine(r) {
  const db = r.databases;
  const live = db.ncbi?.live?.sequences?.length ? ` · ${esc(db.ncbi.live.label)} ${esc(db.ncbi.live.date)} for ${db.ncbi.live.sequences.length} sequence${db.ncbi.live.sequences.length === 1 ? "" : "s"}` : "";
  return `MycoMap Validation ${esc(r.engineVersion)} · MycoMap database ${esc(db.mycomap.version ?? "of unknown date")} · GenBank ${db.ncbi ? esc(db.ncbi.version ?? "downloaded") : "not searched"}${live} · BLAST+ ${esc(r.blast)} · ${esc((r.ranAt ?? "").slice(0, 16).replace("T", " "))} UTC`;
}

function flagsOf(result) {
  return [
    result.flaggedContaminant && "contaminant",
    result.flaggedNonTarget && "non-target",
    result.barcodeGapNeeded && "barcode gap check",
    result.noBlastHits && "no MycoMap hits",
  ].filter(Boolean);
}

/** What MycoMap Vision made of a record: its top names, or why it has none. */
export function visionCellHtml(v) {
  if (!v) return `<span class="muted">not asked</span>`;
  if (v.status === "answered") return `${v.top ? esc(v.top) : "answered"}<div class="muted">by ${v.by === "photos" ? "photos" : "observation number"}${v.gate && v.gate !== "fungus" ? `; fungus check: ${esc(v.gate)}` : ""}</div>`;
  return `<span class="muted">${esc(v.status === "no_answer" ? "no answer" : "not asked")}</span>`;
}

/** A record's new name: local (until MycoMap registers it), or the one mycomap.org gave. */
export function newNameHtml(name) {
  if (!name) return "";
  const local = /sp\. 'local-/.test(name);
  return `<div class="muted">new name: <i>${esc(name)}</i>${local ? " (local only: not in MycoMap until it is registered)" : ""}</div>`;
}

/** One record's row. */
function recordRow(r) {
  const d = DECISION[r.decision] ?? { label: r.decision, cls: "" };
  return `<tr>
    <td><span class="badge ${d.cls}">${esc(d.label)}</span></td>
    <td>${esc(r.record)}${r.observerName ? `<div class="muted">as <i>${esc(r.observerName)}</i></div>` : ""}</td>
    <td>${r.species ? species(r.species) : ""}${newNameHtml(r.newName)}</td>
    <td>${visionCellHtml(r.vision)}</td>
    <td class="reason">${esc(r.reason)}</td>
  </tr>`;
}

/** The run's MycoMap Vision line: answered how many, the quota, and why it stopped, in words. */
export function visionSummaryHtml(v) {
  if (!v) return `<p class="muted small">As MycoMap's auto-validation would decide them. MycoMap Vision was not asked (no key), so the observer's identification is the only second source.</p>`;
  const u = v.usage;
  const quota = u && u.used != null ? ` Quota: ${esc(u.used)}${u.limit != null ? ` of ${esc(u.limit)} used, ${esc(Math.max(0, u.limit - u.used))} left` : " used"}${u.period ? ` this month (${esc(u.period)})` : ""}.` : "";
  const versions = v.models.length ? ` Model ${esc(v.models.join(", "))}; answers version ${esc(v.answersVersions.join(", "))}.` : "";
  return `<p class="muted small">As MycoMap's auto-validation would decide them, with MycoMap Vision: it answered ${esc(v.answered)} of the ${esc(v.asked)} records it was asked about.${versions}${quota}</p>${v.problem ? `<div class="notice bad">${esc(v.problem)}.</div>` : ""}`;
}

/** One sequence's row; clicking it opens its steps. */
function sequenceRow(s, i) {
  const r = s.result;
  const best = s.mycomapHits[0];
  const flags = flagsOf(r);
  const likely = r.contaminantLikelyName?.name ?? r.genbankLikelyName?.name ?? null;
  return `<tr class="seq" data-seq="${i}" tabindex="0" aria-expanded="false">
    <td>${esc(s.id)}</td>
    <td>${species(r.finalSpecies)}${likely ? `<div class="muted">likely <i>${esc(likely)}</i></div>` : ""}</td>
    <td class="num">${r.finalConfidence == null ? "" : `${esc(r.finalConfidence)}%`}</td>
    <td>${flags.map((f) => `<span class="badge flag">${esc(f)}</span>`).join(" ")}</td>
    <td>${best ? `${best.name ? `<i>${esc(best.name)}</i>` : esc(best.accession)} <span class="muted">${best.adjustedIdentity ?? best.identity}%</span>` : `<span class="muted">none</span>`}</td>
  </tr>`;
}

function hitsTable(title, hits, mycomap) {
  if (hits === null) return `<p class="muted">${esc(title)}: not searched.</p>`;
  if (!hits.length) return `<p class="muted">${esc(title)}: no hits.</p>`;
  return `<table class="hits"><caption>${esc(title)}</caption>
    <thead><tr><th>Hit</th><th>Name</th><th class="num">Identity</th><th class="num">Adjusted</th><th class="num">Coverage</th>${mycomap ? "<th>Validated</th>" : ""}</tr></thead>
    <tbody>${hits.map((h) => `<tr><td>${esc(h.accession)}</td><td>${h.name ? `<i>${esc(h.name)}</i>` : ""}</td><td class="num">${esc(h.identity)}%</td>
      <td class="num">${h.adjustedIdentity == null ? "" : `${esc(h.adjustedIdentity)}%`}</td><td class="num">${esc(h.coverage)}%</td>
      ${mycomap ? `<td>${h.validated ? "yes" : "no"}${h.flags?.length ? ` <span class="muted">(${esc(h.flags.join(", "))})</span>` : ""}</td>` : ""}</tr>`).join("")}</tbody></table>`;
}

/** A sequence's steps and best hits. */
export function sequenceDetailHtml(s) {
  const steps = s.result.steps.map((st) => `<li class="step ${esc(st.status)}"><span class="mark" aria-hidden="true">${MARK[st.status] ?? "?"}</span>
    <span class="step-name">${esc(st.step)}</span> <span class="step-msg">${esc(st.message)}</span></li>`).join("");
  return `<div class="detail">
    <h4>Each step the rules took</h4><ol class="steps">${steps}</ol>
    ${hitsTable(`MycoMap: ${s.mycomapHitCount} hit${s.mycomapHitCount === 1 ? "" : "s"}, the best ten`, s.mycomapHits, true)}
    ${hitsTable(`GenBank${s.ncbiLive ? ` (NCBI: live, ${s.ncbiLive.answeredAt.slice(0, 10)})` : ""}: ${s.ncbiHitCount ?? 0} hits, the best ten`, s.ncbiHits, false)}
  </div>`;
}

/** The files to submit or share, made from the validated records (the server's export). */
export function exportsHtml(records) {
  const validated = records.filter((x) => x.decision === "validate").length;
  if (!validated) return `<p class="downloads muted">No record is validated, so there is nothing to submit to GenBank, Darwin Core or iNaturalist.</p>`;
  const button = (file, label) => `<button type="button" class="link" data-file="${file}">${label}</button>`;
  return `<p class="downloads">For the ${validated} validated record${validated === 1 ? "" : "s"}: ${button("darwin-core.csv", "Darwin Core")} · GenBank ${button("genbank.fasta", "FASTA")} and ${button("genbank-source.tsv", "source table")} · ${button("inaturalist.txt", "iNaturalist fields and comment")} · ${button("export-report.txt", "what was left out")}</p>`;
}

/** A finished run: the records, then the sequences. */
export function resultsHtml(id, r) {
  const records = r.records ?? [];
  return `<header class="run-head">
      <h2>${esc(r.input?.fasta ?? id)}</h2>
      <p class="muted">${stampLine(r)}</p>
      <p class="downloads">Save: <button type="button" class="link" data-file="records.csv">records.csv</button> · <button type="button" class="link" data-file="results.csv">results.csv</button> · <button type="button" class="link" data-file="results.json">results.json</button></p>
      ${exportsHtml(records)}
    </header>
    <section>
      <h3>Records <span class="muted">${esc(countsText(records.reduce((c, x) => ({ ...c, [x.decision]: (c[x.decision] ?? 0) + 1 }), {})))}</span></h3>
      ${visionSummaryHtml(r.vision)}
      <table class="records"><thead><tr><th>Decision</th><th>Record</th><th>Species</th><th>MycoMap Vision</th><th>Why</th></tr></thead>
        <tbody>${records.map(recordRow).join("")}</tbody></table>
    </section>
    <section>
      <h3>Sequences <span class="muted">${r.sequences.length}</span></h3>
      <p class="muted small">Click a sequence for every step the rules took, and its best hits.</p>
      <table class="sequences"><thead><tr><th>Sequence</th><th>DNA name</th><th class="num">Confidence</th><th>Flags</th><th>Best MycoMap hit</th></tr></thead>
        <tbody>${r.sequences.map(sequenceRow).join("")}</tbody></table>
    </section>
    <section id="contribute" class="contribute"></section>`;
}

// ── Contribute: sending a run's sequences to mycomap.org ──

const CONTRIBUTION_STATUS = {
  received: "received", checking: "being checked", in_review: "in review", accepted: "accepted", partly_accepted: "partly accepted",
  refused: "refused", withdrawn: "withdrawn", waiting: "waiting", duplicate: "a duplicate",
};
const DECIDED = new Set(["accepted", "partly_accepted", "refused", "withdrawn"]);
const statusText = (s) => CONTRIBUTION_STATUS[s] ?? s;

/** One sent contribution: its number and state, and mycomap.org's last answer, read by read. */
function sentContributionHtml(c) {
  const a = c.answer;
  const records = (a?.records ?? []).map((r) => `<li>${esc(r.record)}: ${esc(statusText(r.status))}${r.reason ? ` - ${esc(r.reason)}` : ""}
    <ul>${(r.sequences ?? []).map((s) => {
      const bits = [esc(statusText(s.status)) + (s.reason ? ` - ${esc(s.reason)}` : "")];
      if (s.check) bits.push(`mycomap.org's check: ${s.check.dnaName ? `<i>${esc(s.check.dnaName)}</i>` : "no DNA name"}${typeof s.check.confidence === "number" ? ` (${esc(s.check.confidence)}%)` : ""}${s.check.duplicateOf ? `; same bases as MycoMap sequence ${esc(s.check.duplicateOf)}` : ""}`);
      if (s.mycomapSequenceId) bits.push(`MycoMap sequence ${esc(s.mycomapSequenceId)}`);
      if (s.name) bits.push(s.name.pending || !s.name.value ? "waiting for a MycoMap name" : `name: <i>${esc(s.name.value)}</i> (${s.name.kind === "new" ? "new" : "existing"})`);
      return `<li>${esc(s.id)}: ${bits.join("; ")}</li>`;
    }).join("")}</ul></li>`).join("");
  return `<div class="sent">
    <p><strong>${esc(c.id)}</strong> <span class="badge ${c.status === "accepted" ? "ok" : c.status === "refused" || c.status === "withdrawn" ? "bad" : "wait"}">${esc(statusText(c.status))}</span>
      <span class="muted">${c.sequences.length} sequence${c.sequences.length === 1 ? "" : "s"} · sent ${esc(c.sentAt.slice(0, 16).replace("T", " "))} UTC${c.checkedAt ? ` · checked ${esc(c.checkedAt.slice(0, 16).replace("T", " "))} UTC` : ""}</span>
      ${c.page ? `<span class="muted">· ${esc(c.page)}</span>` : ""}</p>
    ${records ? `<ul class="contribution-records">${records}</ul>` : ""}
  </div>`;
}

/**
 * The run's Contribute section: what was sent and where it stands, with Check
 * again and Withdraw; then what would be sent, the CC BY 4.0 agreement and the
 * Send button. Nothing is sent until the button is pressed.
 */
export function contributionHtml(view, said = null) {
  const sent = view.contribution?.contributions ?? [];
  const p = view.preview ?? {};
  const keyField = `<label class="key">Your MycoMap member key${view.keyGiven ? ' <span class="muted">(optional: the tool was started with one)</span>' : ""}
      <input type="password" id="member-key" autocomplete="off" spellcheck="false"></label>`;
  const parts = [`<h3>Contribute to MycoMap</h3>`];
  if (said?.error) parts.push(`<div class="notice bad">${esc(said.error)}</div>`);
  if (said?.lines?.length && !said.error) parts.push(`<ul class="said">${said.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`);
  if (sent.length) {
    parts.push(sent.map(sentContributionHtml).join(""));
    const open = sent.some((c) => !DECIDED.has(c.status));
    parts.push(`<p class="contribute-actions">${keyField}<button type="button" data-contribute="status">Check again</button>${open ? ' <button type="button" data-contribute="withdraw">Withdraw</button>' : ""}</p>`);
  }
  if (p.error) {
    parts.push(`<p class="muted small">${esc(p.error)}</p>`);
  } else if (p.sequences > 0) {
    parts.push(`<div class="contribute-preview">
      <p class="muted small">Send this run's sequences to ${esc(view.site)} for MycoMap's database. A person at MycoMap reviews every contribution, and mycomap.org runs its own analysis: the tool's results go only as notes. Nothing is sent until you press Send.</p>
      <ul class="preview">${p.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
      ${sent.length ? "" : keyField}
      <label class="check"><input type="checkbox" id="contribute-agree"> I agree that these sequences are published under CC BY 4.0, credited to me by my MycoMap display name.</label>
      <button type="button" data-contribute="send">Send ${esc(p.sequences)} sequence${p.sequences === 1 ? "" : "s"} to mycomap.org</button>
    </div>`);
  } else if (!sent.length && p.leftOut?.length) {
    parts.push(`<p class="muted small">Nothing in this run can be sent: ${p.leftOut.slice(0, 5).map((l) => `${esc(l.record)}${l.sequence ? `, read ${esc(l.sequence)}` : ""}: ${esc(l.why)}`).join("; ")}${p.leftOut.length > 5 ? "; …" : ""}.</p>`);
  }
  return parts.join("\n");
}
