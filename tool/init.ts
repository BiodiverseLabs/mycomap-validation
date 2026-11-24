// `mycomap-validation init`: sets up the data folder in one step. It reads
// the list of downloads from mycomap.org, says what it will download and how
// big it is, and once you say yes downloads, checks and unpacks:
//
//   MycoMap's BLAST database and names table   (rebuilt every night)
//   GenBank's fungal ITS database               (every week; --no-ncbi leaves it out)
//   BLAST+ 2.17.0 for this computer             (--no-blast leaves it out)
//
// Run it again to update: only what changed is downloaded. A broken download
// carries on where it stopped. For a computer with no internet, run
// `init --download-only <folder>` on one that has it, carry the folder over
// (a USB stick), and run `init --from <folder>` there.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unpackTarGz } from "./archive";
import { BLAST_PLATFORMS, blastBuild, blastEntry, blastPlatform, PINNED_BLAST } from "./blastPlus";
import { downloadFile, formatBytes, type Fetch } from "./download";
import { InputError } from "./fasta";

export const DOWNLOADS_LIST = "https://mycomap.org/api/downloads";

/**
 * Where the list of downloads is read: mycomap.org's, or one named in
 * MYCOMAP_VALIDATION_DOWNLOADS (a mirror, or the stand-in server of the
 * release's first-run check).
 */
export function downloadsListUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.MYCOMAP_VALIDATION_DOWNLOADS?.trim() || DOWNLOADS_LIST;
}
/** What `init --download-only` saves beside the files, and `init --from` reads. */
export const SAVED_LIST = "mycomap-validation-downloads.json";
const INSTALLED = "installed.json";

export type Part = "mycomap-db" | "names" | "ncbi" | "blast";

export interface Download {
  part: Part;
  what: string;
  version: string;
  fileName: string;
  url: string;
  bytes: number;
  sha256: string;
}

export interface InstalledPart {
  version: string;
  fileName: string;
  sha256: string;
}

export type Installed = Partial<Record<Part, InstalledPart>> & { at?: string; blastPlatform?: string };

/** The parts of /api/downloads the tool reads. */
interface DownloadsList {
  latest: null | { version: string; files: Array<{ id: string; fileName: string; url: string; bytes: number; sha256: string }> };
  ncbiIts?: null | { version: string; fileName: string; url: string; bytes: number; sha256: string };
}

/** What to download, from mycomap.org's list of downloads. */
export function downloadsFrom(list: DownloadsList, opts: { ncbi: boolean; blast: string | null; blastBuildFor?: typeof blastBuild }): Download[] {
  const latest = list.latest;
  if (!latest) throw new InputError("mycomap.org has not published a MycoMap database yet. Try again tomorrow, or see https://mycomap.org/data-downloads.");
  const file = (id: string) => {
    const f = latest.files.find((x) => x.id === id);
    if (!f) throw new InputError(`mycomap.org's list of downloads has no "${id}" file. Try again later.`);
    return f;
  };
  const db = file("mycomap-blastdb");
  const names = file("mycomap-sequences");
  const out: Download[] = [
    { part: "mycomap-db", what: "MycoMap BLAST database", version: latest.version, fileName: db.fileName, url: db.url, bytes: db.bytes, sha256: db.sha256 },
    { part: "names", what: "MycoMap names table", version: latest.version, fileName: names.fileName, url: names.url, bytes: names.bytes, sha256: names.sha256 },
  ];
  if (opts.ncbi && list.ncbiIts) {
    const n = list.ncbiIts;
    out.push({ part: "ncbi", what: "GenBank fungal ITS database", version: n.version, fileName: n.fileName, url: n.url, bytes: n.bytes, sha256: n.sha256 });
  }
  if (opts.blast) {
    const build = (opts.blastBuildFor ?? blastBuild)(opts.blast);
    if (!build) throw new InputError(`There is no BLAST+ for "${opts.blast}". Choose one of: ${BLAST_PLATFORMS.join(", ")}.`);
    out.push({ part: "blast", what: `BLAST+ (${build.platform})`, version: PINNED_BLAST, fileName: build.fileName, url: build.url, bytes: build.bytes, sha256: build.sha256 });
  }
  return out;
}

export function readInstalled(dataFolder: string): Installed {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataFolder, INSTALLED), "utf8"));
  } catch {
    return {};
  }
}

/** The downloads not already installed (the same file, by its checksum). */
export function stillNeeded(downloads: Download[], installed: Installed, blastPlatformName: string | null): Download[] {
  return downloads.filter((d) => {
    const have = installed[d.part];
    if (!have || have.sha256 !== d.sha256) return true;
    if (d.part === "blast" && installed.blastPlatform !== blastPlatformName) return true;
    return false;
  });
}

/** What init says before it starts. */
export function planText(needed: Download[], all: Download[], dataFolder: string): string {
  if (needed.length === 0) {
    return `Everything in ${dataFolder} is up to date: ${all.map((d) => `${d.what} ${d.version}`).join("; ")}.`;
  }
  const total = needed.reduce((sum, d) => sum + d.bytes, 0);
  const lines = needed.map((d) => `  ${d.what.padEnd(34)} ${d.version.padEnd(11)} ${formatBytes(d.bytes).padStart(8)}`);
  return [`To download into ${dataFolder}:`, ...lines, `  ${"".padEnd(34)} ${"".padEnd(11)} ${formatBytes(total).padStart(8)} in all`].join("\n");
}

/** Unpacked, the databases take about five times their download; refuse early when the disk cannot hold them. */
export function spaceProblem(needed: Download[], freeBytes: number | null): string | null {
  if (freeBytes === null) return null;
  const want = needed.reduce((sum, d) => sum + d.bytes * (d.part === "names" ? 1 : 6), 0);
  if (freeBytes >= want) return null;
  return `There is not enough room: this needs about ${formatBytes(want)} free, and the disk has ${formatBytes(freeBytes)}. Free some space, or name a folder on another disk with --data.`;
}

function freeSpace(folder: string): number | null {
  try {
    let at = path.resolve(folder);
    while (!fs.existsSync(at)) at = path.dirname(at);
    const s = fs.statfsSync(at);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export interface InitOptions {
  data: string;
  ncbi: boolean;
  /** Install BLAST+ (for this computer, or the platform named). */
  blast: boolean;
  platform?: string | null;
  /** Fetch the files into this folder only, for a computer with no internet. */
  downloadOnly?: string | null;
  /** Take the files from this folder (made with --download-only) instead of the internet. */
  from?: string | null;
  /** Go ahead without asking. */
  yes: boolean;
  ask?: (question: string) => Promise<boolean>;
  say?: (line: string) => void;
  fetch?: Fetch;
  listUrl?: string;
  now?: () => Date;
  /** Test seam: where BLAST+ is downloaded from (NCBI's pinned archives). */
  blastBuildFor?: typeof blastBuild;
}

async function readList(opts: InitOptions): Promise<DownloadsList> {
  if (opts.from) {
    const saved = path.join(opts.from, SAVED_LIST);
    if (!fs.existsSync(saved)) throw new InputError(`${opts.from} has no ${SAVED_LIST}. Make the folder with "mycomap-validation init --download-only <folder>" on a computer with internet.`);
    return JSON.parse(fs.readFileSync(saved, "utf8"));
  }
  const url = opts.listUrl ?? downloadsListUrl();
  let response: Response;
  try {
    response = await (opts.fetch ?? fetch)(url, { headers: { Accept: "application/json" } });
  } catch (error) {
    throw new InputError(`Could not reach ${url === DOWNLOADS_LIST ? "mycomap.org" : url} (${(error as Error).message}). Check the internet connection, or set up from a folder copied from another computer with --from.`);
  }
  if (!response.ok) throw new InputError(`mycomap.org's list of downloads answered ${response.status}. Try again later.`);
  return (await response.json()) as DownloadsList;
}

export interface InitResult {
  downloaded: Download[];
  upToDate: boolean;
  installed: Installed;
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const say = opts.say ?? (() => undefined);
  const platform = opts.blast ? opts.platform ?? blastPlatform() : null;
  if (opts.blast && !platform) throw new InputError(`There is no BLAST+ download for this computer (${process.platform} ${process.arch}). Install BLAST+ yourself and run init with --no-blast.`);
  const list = await readList(opts);
  const all = downloadsFrom(list, { ncbi: opts.ncbi, blast: platform, blastBuildFor: opts.blastBuildFor });

  if (opts.downloadOnly) {
    const folder = opts.downloadOnly;
    say(planText(all, all, folder));
    if (!(await confirmed(opts, "Download these files?"))) throw new InputError("Nothing was downloaded.");
    for (const d of all) {
      say(`Downloading ${d.what}…`);
      await downloadFile(d.url, path.join(folder, d.fileName), d, { fetch: opts.fetch, what: d.what, progress: progressSayer(say, d) });
    }
    fs.writeFileSync(path.join(folder, SAVED_LIST), `${JSON.stringify(list, null, 2)}\n`);
    say(`Done. Copy ${folder} to the other computer and run: mycomap-validation init --from <that folder>`);
    return { downloaded: all, upToDate: false, installed: {} };
  }

  const data = opts.data;
  const installed = readInstalled(data);
  const needed = stillNeeded(all, installed, platform);
  say(planText(needed, all, data));
  if (needed.length === 0) return { downloaded: [], upToDate: true, installed };
  if (!opts.from) {
    const problem = spaceProblem(needed, freeSpace(data));
    if (problem) throw new InputError(problem);
  }
  if (!(await confirmed(opts, opts.from ? "Install these files?" : "Download and install these files?"))) throw new InputError("Nothing was downloaded.");

  const staging = path.join(data, ".downloads");
  fs.mkdirSync(staging, { recursive: true });
  for (const d of needed) {
    const archive = path.join(staging, d.fileName);
    if (opts.from) {
      const copy = path.join(opts.from, d.fileName);
      if (!fs.existsSync(copy)) throw new InputError(`${opts.from} has no ${d.fileName}. Make the folder again with --download-only.`);
      say(`Checking ${d.what}…`);
      await downloadFile(pathToFileURL(copy).href, archive, d, { fetch: copyFetch, what: d.what });
    } else {
      say(`Downloading ${d.what}…`);
      await downloadFile(d.url, archive, d, { fetch: opts.fetch, what: d.what, progress: progressSayer(say, d) });
    }
    say(`Installing ${d.what}…`);
    await install(d, archive, data);
    fs.rmSync(archive, { force: true });
    installed[d.part] = { version: d.version, fileName: d.fileName, sha256: d.sha256 };
    if (d.part === "blast") installed.blastPlatform = platform ?? undefined;
    installed.at = (opts.now?.() ?? new Date()).toISOString();
    fs.writeFileSync(path.join(data, INSTALLED), `${JSON.stringify(installed, null, 2)}\n`);
  }
  fs.rmSync(staging, { recursive: true, force: true });
  say(`Done. ${data} holds ${all.map((d) => `${d.what} ${d.version}`).join("; ")}.`);
  return { downloaded: needed, upToDate: false, installed };
}

/** Errors Windows gives a rename for a moment, while a virus scanner or indexer has a file open. */
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Renames, trying again when Windows says the file or folder is busy: every
 * 0.25, 0.5, 1, 2 and 4 seconds, then an InputError in words.
 */
export async function renameWhenFree(from: string, to: string, deps: { rename?: (a: string, b: string) => void; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const rename = deps.rename ?? fs.renameSync;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waits = [250, 500, 1000, 2000, 4000];
  for (let i = 0; ; i++) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? "";
      if (!BUSY.has(code)) throw error;
      if (i >= waits.length) {
        throw new InputError(`${path.basename(to)} could not be put in place: Windows kept it busy (${code}), most likely a virus scanner checking the new files. Run the same command again in a minute; what is already downloaded is kept.`);
      }
      await sleep(waits[i]);
    }
  }
}

/** Where each part goes in the data folder. */
export function installFolder(part: Part, version: string, data: string): string {
  switch (part) {
    case "mycomap-db": return path.join(data, "mycomap", version);
    case "ncbi": return path.join(data, "ncbi_its", version);
    case "blast": return path.join(data, "blast", version);
    case "names": return data;
  }
}

/**
 * Unpacks a part into a fresh folder beside its place, then puts it there and
 * removes the version it replaces, so a run never sees half a database.
 */
async function install(d: Download, archive: string, data: string): Promise<void> {
  if (d.part === "names") {
    for (const old of fs.readdirSync(data).filter((f) => /^mycomap_sequences.*\.tsv(\.gz)?$/.test(f) && f !== d.fileName)) fs.rmSync(path.join(data, old));
    await renameWhenFree(archive, path.join(data, d.fileName));
    return;
  }
  const target = installFolder(d.part, d.version, data);
  const fresh = `${target}.unpacking`;
  fs.rmSync(fresh, { recursive: true, force: true });
  // MycoMap's archive is flat; GenBank's has a dated folder; BLAST+'s keeps only two programs.
  const choose = d.part === "blast" ? blastEntry : (name: string) => (name.endsWith("/") ? null : path.posix.basename(name));
  const files = await unpackTarGz(archive, fresh, choose);
  if (files.length === 0) throw new InputError(`${d.fileName} held nothing to install. Download it again.`);
  if (d.part === "blast") for (const f of files) if (!f.name.endsWith(".dll")) fs.chmodSync(f.path, 0o755);
  const parent = path.dirname(target);
  for (const old of fs.existsSync(parent) ? fs.readdirSync(parent) : []) {
    if (!old.endsWith(".unpacking")) fs.rmSync(path.join(parent, old), { recursive: true, force: true });
  }
  await renameWhenFree(fresh, target);
}

/** Reads a local file as if downloading it, so a copied file is checked the same way. */
const copyFetch: Fetch = async (input) => {
  const body = fs.createReadStream(fileURLToPath(String(input)));
  return new Response(body as unknown as ReadableStream, { status: 200 });
};

async function confirmed(opts: InitOptions, question: string): Promise<boolean> {
  if (opts.yes) return true;
  if (!opts.ask) throw new InputError(`${question} Run the command again with --yes to go ahead.`);
  return opts.ask(`${question} [y/N] `);
}

function progressSayer(say: (line: string) => void, d: Download) {
  let lastTenth = -1;
  return (done: number, total: number) => {
    const tenth = Math.floor((done / total) * 10);
    if (tenth !== lastTenth && tenth < 10) {
      lastTenth = tenth;
      if (tenth > 0) say(`  ${d.what}: ${tenth * 10}% (${formatBytes(done)} of ${formatBytes(total)})`);
    }
  };
}
