// The page's wiring: it asks the local server (server.ts) and shows what
// view.js makes of the answers.
import { contributionHtml, esc, progressHtml, resultsHtml, runsListHtml, sequenceDetailHtml, statusHtml } from "/view.js";

const key = document.querySelector('meta[name="mmv-key"]').content;
const main = document.getElementById("main");
let current = null; // { id, results }

async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { ...(init.headers ?? {}), "x-mmv-key": key } });
  const body = res.headers.get("content-type")?.startsWith("application/json") ? await res.json() : await res.blob();
  if (!res.ok) throw new Error(body.error ?? `The tool answered ${res.status}.`);
  return body;
}

async function refreshStatus() {
  const status = await api("/api/status");
  document.getElementById("status").innerHTML = statusHtml(status);
  document.getElementById("runs").innerHTML = runsListHtml(status.runs, current?.id ?? null);
  document.getElementById("start").disabled = !status.data.ok || !!status.running;
  // An NCBI key or email address set where the tool was started need not be typed.
  const env = status.ncbiRefresh ?? {};
  document.getElementById("ncbi-key-note").textContent = env.keyFromEnvironment ? "(or leave empty to use NCBI_API_KEY)" : "";
  document.getElementById("ncbi-email-note").textContent = env.emailFromEnvironment ? "(or leave empty to use NCBI_EMAIL)" : "";
  visionForm(status.vision);
  return status;
}

// MycoMap Vision: off unless the tool was started with a key, or the box is ticked.
let visionSet = false;
function visionForm(vision) {
  const box = document.getElementById("vision");
  if (!visionSet) {
    visionSet = true;
    box.checked = !!vision?.keyGiven;
    if (vision?.keyGiven) document.getElementById("vision-key-note").textContent = "(optional: the tool was started with one)";
  }
  const shown = () => {
    document.getElementById("vision-key-label").hidden = !box.checked;
    document.getElementById("vision-note").hidden = !box.checked;
  };
  box.onchange = shown;
  shown();
}

/** "#run=<id>&seq=<n>": a run, and a sequence opened in it, from the address. */
export function linkTarget(hash) {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const seq = p.get("seq");
  return { run: p.get("run"), seq: seq !== null && /^\d+$/.test(seq) ? Number(seq) : null };
}

async function showRun(id, openSeq = null, said = null) {
  const answer = await api(`/api/runs/${encodeURIComponent(id)}`);
  if (answer.state !== "done") {
    main.innerHTML = progressHtml(answer);
    if (answer.state === "running") setTimeout(() => showRun(id).catch(fail), 1000);
    else await refreshStatus();
    return;
  }
  current = { id, results: answer.results };
  main.innerHTML = resultsHtml(id, answer.results);
  showContribution(id, said).catch((error) => { document.getElementById("contribute").innerHTML = `<div class="notice bad">${esc(error.message)}</div>`; });
  history.replaceState(null, "", `#run=${encodeURIComponent(id)}`);
  const row = openSeq === null ? null : main.querySelector(`tr.seq[data-seq="${openSeq}"]`);
  if (row) {
    toggle(row);
    row.scrollIntoView({ block: "start" });
  }
  await refreshStatus();
}

// Contribute: the section reads what would be sent (nothing is sent); only the buttons send.
// A typed member key is kept in this page only, never stored, so it need not be typed again after each answer.
let typedKey = "";
async function showContribution(id, said = null) {
  const view = said ?? await api(`/api/runs/${encodeURIComponent(id)}/contribution`);
  const section = document.getElementById("contribute");
  if (!section || current?.id !== id) return;
  section.innerHTML = contributionHtml(view, said);
  const field = document.getElementById("member-key");
  if (field) field.value = typedKey;
}

async function contribute(action) {
  const id = current.id;
  if (action === "withdraw" && !confirm("Withdraw what has not been decided? It will not be reviewed.")) return;
  const agree = document.getElementById("contribute-agree");
  typedKey = document.getElementById("member-key")?.value ?? "";
  const body = { key: typedKey, agree: !!agree?.checked, confirm: action === "withdraw" };
  for (const b of document.querySelectorAll("[data-contribute]")) b.disabled = true;
  const res = await fetch(`/api/runs/${encodeURIComponent(id)}/contribution${action === "send" ? "" : `/${action}`}`, {
    method: "POST", headers: { "x-mmv-key": key, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const answer = await res.json();
  // A refusal before anything was asked (no key, not agreed) keeps what the section showed, with the words on top.
  if (!answer.preview) return showContribution(id, { ...(await api(`/api/runs/${encodeURIComponent(id)}/contribution`)), error: answer.error });
  // A rename changes the results shown, so they are read again.
  if (action === "status" && answer.lines?.some((l) => l.startsWith("Renamed "))) return showRun(id, null, answer);
  await showContribution(id, answer);
}

function fail(error) {
  main.innerHTML = `<div class="notice bad">${esc(error.message)}</div>`;
}

const readText = (file) => (file ? file.text() : Promise.resolve(null));

// "Ask NCBI live" is off unless ticked; the key and email fields show only then.
const refreshBox = document.getElementById("refresh-ncbi");
const emailField = document.getElementById("ncbi-email");
refreshBox.addEventListener("change", () => { document.getElementById("ncbi-access").hidden = !refreshBox.checked; });
try { emailField.value = localStorage.getItem("mmv-ncbi-email") ?? ""; } catch { /* no storage: type it */ }

document.getElementById("new-run").addEventListener("submit", async (event) => {
  event.preventDefault();
  const fasta = document.getElementById("fasta").files[0];
  const records = document.getElementById("records").files[0];
  try {
    const { id } = await api("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fastaName: fasta.name, fasta: await readText(fasta),
        recordsName: records?.name ?? null, records: await readText(records),
        ncbi: document.getElementById("ncbi").checked,
        ...(refreshBox.checked ? { refreshNcbi: true, ncbiKey: document.getElementById("ncbi-key").value, ncbiEmail: emailField.value } : {}),
        vision: document.getElementById("vision").checked,
        visionKey: document.getElementById("vision").checked ? document.getElementById("vision-key").value : "",
      }),
    });
    if (refreshBox.checked) try { localStorage.setItem("mmv-ncbi-email", emailField.value); } catch { /* not kept */ }
    main.innerHTML = progressHtml({ state: "running", lines: [] });
    await refreshStatus();
    await showRun(id);
  } catch (error) {
    fail(error);
  }
});

document.addEventListener("click", async (event) => {
  const runButton = event.target.closest("[data-run]");
  if (runButton) return showRun(runButton.dataset.run).catch(fail);
  const file = event.target.closest("[data-file]");
  if (file && current) {
    const blob = await api(`/api/runs/${encodeURIComponent(current.id)}/${file.dataset.file}`).catch(fail);
    if (!blob) return;
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${current.id}_${file.dataset.file}` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return;
  }
  const action = event.target.closest("[data-contribute]");
  if (action && current) return contribute(action.dataset.contribute).catch(fail);
  const row = event.target.closest("tr.seq");
  if (row && current) toggle(row);
});

function setSeqInAddress(index) {
  history.replaceState(null, "", `#run=${encodeURIComponent(current.id)}${index === null ? "" : `&seq=${index}`}`);
}

document.addEventListener("keydown", (event) => {
  const row = event.target.closest?.("tr.seq");
  if (row && current && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    toggle(row);
  }
});

function toggle(row) {
  const next = row.nextElementSibling;
  if (next?.classList.contains("detail-row")) {
    next.remove();
    row.setAttribute("aria-expanded", "false");
    setSeqInAddress(null);
    return;
  }
  const s = current.results.sequences[Number(row.dataset.seq)];
  const detail = document.createElement("tr");
  detail.className = "detail-row";
  detail.innerHTML = `<td colspan="5">${sequenceDetailHtml(s)}</td>`;
  row.after(detail);
  row.setAttribute("aria-expanded", "true");
  setSeqInAddress(Number(row.dataset.seq));
}

const linked = linkTarget(location.hash);
refreshStatus()
  .then((status) => {
    if (status.running) return showRun(status.running);
    const wanted = linked.run && status.runs.some((r) => r.id === linked.run) ? linked.run : status.runs[0]?.id;
    return wanted ? showRun(wanted, wanted === linked.run ? linked.seq : null) : null;
  })
  .catch(fail);
