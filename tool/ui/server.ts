// `mycomap-validation ui`: the tool in the browser. A small web server on
// this computer only (127.0.0.1), serving one page and the API it calls:
//
//   GET  /                      the page
//   GET  /api/status            the engine version, the data folder's databases, the past runs
//   POST /api/runs              a new run: the FASTA file and records sheet, as text
//   GET  /api/runs/:id          a run's results (results.json), or its progress while it runs
//   GET  /api/runs/:id/:file    results.csv, records.csv or results.json, to save;
//                               or an export (darwin-core.csv, genbank.fasta,
//                               genbank-source.tsv, inaturalist.txt,
//                               export-report.txt), made from the run's folder
//                               when asked for (../export.ts)
//   GET  /api/runs/:id/contribution            what Contribute would send, and what was sent
//   POST /api/runs/:id/contribution            send it to mycomap.org (the page's Contribute)
//   POST /api/runs/:id/contribution/status     where it stands; renames local names
//   POST /api/runs/:id/contribution/withdraw   withdraw what is not decided
//
// Only the three POSTs under contribution talk to mycomap.org, and only when
// the person presses the button (and, to send, ticks the CC BY 4.0 agreement).
//
// Each run gets a folder of its own under <data>/runs, holding its inputs and
// results, so it can be kept, copied or opened again later.
//
// Only this computer can reach it, and only through a "localhost" address
// (so a web page elsewhere cannot point a name of its own at it). Every API
// call carries the random key the page was served with: another site open in
// the same browser cannot start a run or read the results.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installedBlastFolder } from "../blastPlus";
import { bundled } from "../bundled";
import { findDataFiles, mycomapVersionOf } from "../dataFolder";
import { EXPORT_FILES, exportRun, REPORT_FILE, type ExportFormat } from "../export";
import { InputError } from "../fasta";
import { ncbiAccess, type NcbiAccess } from "../ncbiRefresh";
import { engineVersion, runValidation, type RunOptions, type RunOutput } from "../run";
import { VisionSettingError, visionSettings, type VisionSettings } from "../vision";
import { contributeSettings, DEFAULT_MYCOMAP_URL, loadRun, planContribution, previewLines, readContributionFile, sendRun, statusOfRun, withdrawRun, type ContributeSettings } from "../contribute";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The page's files, served as they are. */
const PAGE_FILES: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/view.js": "view.js",
  "/style.css": "style.css",
};
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
/** What a run folder may hand out to save. */
const RUN_FILES: Record<string, string> = { "results.csv": "text/csv; charset=utf-8", "records.csv": "text/csv; charset=utf-8", "results.json": "application/json; charset=utf-8" };
/** The exports a run folder can make, to save. */
const EXPORT_TYPES: Record<string, string> = {
  "darwin-core.csv": "text/csv; charset=utf-8",
  "genbank.fasta": "text/plain; charset=utf-8",
  "genbank-source.tsv": "text/tab-separated-values; charset=utf-8",
  "inaturalist.txt": "text/plain; charset=utf-8",
  [REPORT_FILE]: "text/plain; charset=utf-8",
};
const EXPORT_FORMAT_OF = new Map((Object.entries(EXPORT_FILES) as Array<[ExportFormat, string[]]>).flatMap(([format, files]) => files.map((f) => [f, format] as const)));
/** The largest request body: a FASTA file of a few thousand sequences and its sheet. */
export const MAX_BODY_BYTES = 50 * 1024 * 1024;
const RUN_ID = /^\d{4}-\d{2}-\d{2}_\d{6}(_[A-Za-z0-9-]{1,40})?$/;

export interface UiOptions {
  data: string;
  /** 0 picks a free port. */
  port: number;
  threads: number;
  /** Test seam: how a run is made. */
  runValidation?: (opts: RunOptions) => Promise<RunOutput>;
  /** Test seam: the clock that names run folders. */
  now?: () => Date;
  /** Test seam: the page's key. */
  key?: string;
  /** Test seam: where NCBI_API_KEY and NCBI_EMAIL are read from. */
  env?: NodeJS.ProcessEnv;
  /** MycoMap Vision's key and address, from the command line or MYCOMAP_VISION_KEY; null: none given. */
  vision?: VisionSettings | null;
  /** Contribute: the member key the tool was started with (MYCOMAP_MEMBER_KEY), and mycomap.org's address. */
  memberKey?: string | null;
  mycomapUrl?: string | null;
}

/** Contribute's settings for one request: the key typed on the page (used for that request only, never written down), else the one the tool was started with. */
export function pageContributeSettings(body: { key?: string }, opts: Pick<UiOptions, "memberKey" | "mycomapUrl">): ContributeSettings {
  const typed = body.key?.trim();
  if (!typed && !opts.memberKey) throw new InputError("Type your MycoMap member key, or start the tool with MYCOMAP_MEMBER_KEY set.");
  return contributeSettings({ key: typed || opts.memberKey, url: opts.mycomapUrl ?? null, env: {} });
}

/** What the page's Contribute shows for a run: what would go (or why nothing can), and what was sent. Nothing is sent. */
export function contributionView(folder: string, opts: Pick<UiOptions, "memberKey" | "mycomapUrl">): Record<string, unknown> {
  const contribution = readContributionFile(folder);
  const site = (opts.mycomapUrl ?? DEFAULT_MYCOMAP_URL).replace(/\/+$/, "");
  let preview: unknown;
  try {
    const run = loadRun(folder);
    const plan = planContribution(run, contribution);
    preview = {
      sequences: plan.parts.reduce((n, p) => n + p.records.reduce((m, r) => m + r.sequences.length, 0), 0),
      records: plan.parts.reduce((n, p) => n + p.records.length, 0),
      contributions: plan.parts.length,
      sheet: run.sheet ? path.basename(run.sheet) : null,
      lines: plan.parts.length ? previewLines(plan, { url: site }) : [],
      leftOut: plan.leftOut,
      alreadySent: plan.alreadySent,
    };
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    preview = { error: error.message };
  }
  return { keyGiven: !!opts.memberKey, site, preview, contribution };
}

/**
 * The Vision settings for one run: none unless the page asks for Vision; the
 * key typed on the page (used for that run only, never written down), else the
 * one the tool was started with.
 */
export function runVision(body: { vision?: boolean; visionKey?: string }, started: VisionSettings | null): VisionSettings | null {
  if (body.vision !== true) return null;
  const typed = body.visionKey?.trim();
  if (typed) return visionSettings({ key: typed, url: started?.url ?? null, env: {} });
  if (!started) throw new VisionSettingError("Type your MycoMap Vision key, or start the tool with --vision-key (or MYCOMAP_VISION_KEY set).");
  return started;
}

export interface UiServer {
  url: string;
  key: string;
  close(): Promise<void>;
}

interface RunState {
  id: string;
  state: "running" | "done" | "failed";
  lines: string[];
  error?: string;
}

/** A run folder's name: its start time, and the FASTA file's name made safe. */
export function runId(at: Date, fastaName: string): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const day = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
  const slug = path.parse(fastaName).name.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${day}_${stamp.slice(9, 15)}${slug ? `_${slug}` : ""}`;
}

/** Whether a request came to a localhost address on this server's port. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase());
}

/** The past runs in the runs folder, newest first, with what each found. */
export function listRuns(runsFolder: string): Array<{ id: string; ranAt: string | null; fasta: string | null; sequences: number; records: Record<string, number> }> {
  let names: string[];
  try {
    names = fs.readdirSync(runsFolder).filter((n) => RUN_ID.test(n));
  } catch {
    return [];
  }
  return names.sort().reverse().map((id) => {
    try {
      const results = JSON.parse(fs.readFileSync(path.join(runsFolder, id, "results.json"), "utf8"));
      const records: Record<string, number> = {};
      for (const r of results.records ?? []) records[r.decision] = (records[r.decision] ?? 0) + 1;
      return { id, ranAt: results.ranAt ?? null, fasta: results.input?.fasta ?? null, sequences: (results.sequences ?? []).length, records };
    } catch {
      return { id, ranAt: null, fasta: null, sequences: 0, records: {} };
    }
  });
}

/** What the data folder holds, or what is missing, in words. */
export function dataStatus(data: string): { ok: boolean; problem?: string; mycomap?: string | null; ncbi?: string | null; blast?: string } {
  try {
    const files = findDataFiles(data, { ncbi: true });
    return {
      ok: true,
      mycomap: mycomapVersionOf(files),
      ncbi: files.ncbiDbs ? files.ncbiVersion ?? "downloaded" : null,
      blast: installedBlastFolder(data) ? "installed by init" : "on the PATH",
    };
  } catch (error) {
    if (error instanceof InputError) return { ok: false, problem: `${error.message} Or run: mycomap-validation init` };
    throw error;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8"): void {
  const text = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    // The page loads nothing from anywhere else.
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new InputError(`The files are larger than ${MAX_BODY_BYTES / 1024 / 1024} MB together. Run them from the command line instead: mycomap-validation run <file>.`));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startUi(opts: UiOptions): Promise<UiServer> {
  const key = opts.key ?? crypto.randomBytes(18).toString("base64url");
  const runsFolder = path.join(opts.data, "runs");
  const run = opts.runValidation ?? runValidation;
  const runs = new Map<string, RunState>();
  let busy: string | null = null;
  let port = opts.port;

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host, port)) return send(res, 403, { error: "This server only answers on localhost." });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const page = PAGE_FILES[url.pathname];
      if (req.method === "GET" && page) {
        // The downloadable tool carries the page inside it.
        let text = bundled?.page[page] ?? fs.readFileSync(path.join(here, page), "utf8");
        if (page === "index.html") text = text.replace("{{KEY}}", key).replace("{{VERSION}}", engineVersion());
        return send(res, 200, text, TYPES[path.extname(page)]);
      }
      if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found." });
      if (req.headers["x-mmv-key"] !== key) return send(res, 403, { error: "Open the tool from the address it printed when it started." });

      if (req.method === "GET" && url.pathname === "/api/status") {
        const env = opts.env ?? process.env;
        return send(res, 200, {
          engineVersion: engineVersion(), data: { folder: opts.data, ...dataStatus(opts.data) }, runs: listRuns(runsFolder), running: busy,
          // Whether --refresh-ncbi's key and email address are set where the tool was started (never the key itself).
          ncbiRefresh: { keyFromEnvironment: !!env.NCBI_API_KEY?.trim(), emailFromEnvironment: !!env.NCBI_EMAIL?.trim() },
          // Whether a key was given when the tool started (never the key itself), and where Vision is.
          vision: { keyGiven: !!opts.vision, url: opts.vision?.url ?? null },
        });
      }

      if (req.method === "POST" && url.pathname === "/api/runs") {
        if (busy) return send(res, 409, { error: `A run is already going (${busy}). Wait for it to finish.` });
        const body = JSON.parse(await readBody(req)) as { fastaName?: string; fasta?: string; recordsName?: string; records?: string; ncbi?: boolean; vision?: boolean; visionKey?: string; refreshNcbi?: boolean; ncbiKey?: string; ncbiEmail?: string };
        if (!body.fasta?.trim()) return send(res, 400, { error: "Choose a FASTA file first." });
        let vision: VisionSettings | null;
        try {
          vision = runVision(body, opts.vision ?? null);
        } catch (error) {
          if (error instanceof VisionSettingError) return send(res, 400, { error: error.message });
          throw error;
        }
        // Asking NCBI live is opt-in: only when the box is ticked. The key is used for this run and never saved.
        let refreshNcbi: NcbiAccess | null = null;
        if (body.refreshNcbi === true) {
          if (body.ncbi === false) return send(res, 400, { error: "Asking NCBI live refreshes what the weekly GenBank database does not answer, so it needs GenBank searched too." });
          try {
            refreshNcbi = ncbiAccess({ apiKey: body.ncbiKey, email: body.ncbiEmail }, opts.env ?? process.env);
          } catch (error) {
            if (error instanceof InputError) return send(res, 400, { error: error.message });
            throw error;
          }
        }
        const id = runId(opts.now?.() ?? new Date(), body.fastaName ?? "sequences.fasta");
        const folder = path.join(runsFolder, id);
        fs.mkdirSync(folder, { recursive: true });
        const fastaFile = path.join(folder, `input_${path.basename(body.fastaName ?? "sequences.fasta").replace(/[^\w.-]+/g, "_")}`);
        fs.writeFileSync(fastaFile, body.fasta);
        let recordsFile: string | null = null;
        if (body.records?.trim()) {
          recordsFile = path.join(folder, `input_${path.basename(body.recordsName ?? "records.csv").replace(/[^\w.-]+/g, "_")}`);
          fs.writeFileSync(recordsFile, body.records);
        }
        const state: RunState = { id, state: "running", lines: [] };
        runs.set(id, state);
        busy = id;
        run({ fasta: fastaFile, records: recordsFile, data: opts.data, out: folder, threads: opts.threads, ncbi: body.ncbi !== false, vision, refreshNcbi, say: (line) => state.lines.push(line) })
          .then(() => {
            // Say in the results which files they came from.
            const file = path.join(folder, "results.json");
            const results = JSON.parse(fs.readFileSync(file, "utf8"));
            results.input = { fasta: body.fastaName ?? null, records: recordsFile ? body.recordsName ?? null : null };
            fs.writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
            state.state = "done";
          })
          .catch((error) => {
            state.state = "failed";
            state.error = error instanceof InputError ? error.message : `Something went wrong that the tool did not expect: ${error?.message ?? error}`;
          })
          .finally(() => { busy = null; });
        return send(res, 202, { id });
      }

      const c = /^\/api\/runs\/([^/]+)\/contribution(?:\/(status|withdraw))?$/.exec(url.pathname);
      if (c) {
        const [, id, action] = c;
        const folder = path.join(runsFolder, id);
        if (!RUN_ID.test(id) || !fs.existsSync(path.join(folder, "results.json"))) return send(res, 404, { error: "No such run, or it has no results yet." });
        if (req.method === "GET" && !action) return send(res, 200, contributionView(folder, opts));
        if (req.method !== "POST") return send(res, 404, { error: "Not found." });
        const body = JSON.parse((await readBody(req)) || "{}") as { key?: string; agree?: boolean; confirm?: boolean };
        if (!action && body.agree !== true) return send(res, 400, { error: "Tick that you agree to CC BY 4.0 for these sequences: nothing is sent without it." });
        if (action === "withdraw" && body.confirm !== true) return send(res, 400, { error: "Confirm the withdrawal first." });
        let settings: ContributeSettings;
        try {
          settings = pageContributeSettings(body, opts);
        } catch (error) {
          if (error instanceof InputError) return send(res, 400, { error: error.message });
          throw error;
        }
        const lines: string[] = [];
        const flow = { folder, settings, say: (line: string) => lines.push(line), yes: true };
        let done;
        try {
          done = action === "status" ? await statusOfRun(flow) : action === "withdraw" ? await withdrawRun(flow) : await sendRun(flow);
        } catch (error) {
          if (error instanceof InputError) return send(res, 400, { error: error.message });
          throw error;
        }
        // The page shows the contribution itself; of the command line's lines it keeps only what happened.
        const keep = action === "status" ? /^Renamed |still ha(s|ve) (its|their) local name/ : action === "withdraw" ? /^C-\S+: / : /^Sent /;
        const answer = { lines: lines.filter((l) => keep.test(l)).map((l) => l.replace(/ Its records can be sent again with contribute\.$/, " Its records can be sent again.")), problem: done.problem ?? null, ...contributionView(folder, opts) };
        return send(res, done.problem ? 502 : 200, done.problem ? { error: done.problem, ...answer } : answer);
      }

      const m = /^\/api\/runs\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        const [, id, file] = m;
        if (!RUN_ID.test(id)) return send(res, 404, { error: "No such run." });
        const live = runs.get(id);
        if (!file && live && live.state !== "done") return send(res, 200, { id, state: live.state, lines: live.lines, error: live.error ?? null });
        if (file && !RUN_FILES[file] && !EXPORT_TYPES[file]) return send(res, 404, { error: "No such file." });
        const target = path.join(runsFolder, id, file && EXPORT_TYPES[file] ? "results.json" : file ?? "results.json");
        if (!fs.existsSync(target)) return send(res, 404, { error: live ? "The run has no results yet." : "No such run." });
        if (file && EXPORT_TYPES[file]) {
          // Made afresh each time, from the run's kept inputs (export.ts).
          // The report covers every format; each other file, its own.
          const format = EXPORT_FORMAT_OF.get(file);
          let made;
          try {
            made = exportRun({ folder: path.join(runsFolder, id), formats: format ? [format] : undefined });
          } catch (error) {
            if (error instanceof InputError) return send(res, 422, { error: error.message });
            throw error;
          }
          res.setHeader("Content-Disposition", `attachment; filename="${id}_${file}"`);
          return send(res, 200, fs.readFileSync(path.join(made.out, file)), EXPORT_TYPES[file]);
        }
        if (file) {
          res.setHeader("Content-Disposition", `attachment; filename="${id}_${file}"`);
          return send(res, 200, fs.readFileSync(target), RUN_FILES[file]);
        }
        return send(res, 200, { id, state: "done", results: JSON.parse(fs.readFileSync(target, "utf8")) });
      }
      return send(res, 404, { error: "Not found." });
    } catch (error) {
      if (error instanceof SyntaxError) return send(res, 400, { error: "The page sent something the server could not read." });
      if (error instanceof InputError) return send(res, 413, { error: error.message });
      return send(res, 500, { error: `Something went wrong that the tool did not expect: ${(error as Error).message}` });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve());
  });
  port = (server.address() as { port: number }).port;
  return {
    url: `http://localhost:${port}/`,
    key,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
