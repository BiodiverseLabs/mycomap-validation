// The command line:
//
//   mycomap-validation init [options]
//   mycomap-validation run my-sequences.fasta [options]
//   mycomap-validation ui [options]
//   mycomap-validation export <run folder> [options]
//   mycomap-validation contribute <run folder> [--status | --withdraw] [options]
//   mycomap-validation help
//
// (`pnpm tool run …` in this repository.)
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BLAST_PLATFORMS, PINNED_BLAST } from "./blastPlus";
import { genbankLikelyNameLabel } from "../src/genbankLikelyName";
import { defaultDataFolder } from "./dataFolder";
import { EXPORT_FORMATS, exportRun, parseFormats, type ExportFormat } from "./export";
import { InputError } from "./fasta";
import { runInit } from "./init";
import { ncbiAccess } from "./ncbiRefresh";
import type { RecordOutcome } from "./records";
import { defaultThreads, engineVersion, flagsOf, runValidation, type SequenceOutcome } from "./run";
import { startUi } from "./ui/server";
import { contributeSettings, sendRun, statusOfRun, withdrawRun } from "./contribute";
import { DEFAULT_VISION_URL, usageText, VisionSettingError, visionSettings, type VisionSettings } from "./vision";
import { bundled } from "./bundled";

/** The port the browser app uses when none is given. */
export const DEFAULT_UI_PORT = 4517;

export const HELP = `MycoMap Validation: names fungal DNA sequences with MycoMap's rules, on your own computer.

Usage:
  mycomap-validation init [options]               set up, or update, the databases and BLAST+
  mycomap-validation run <sequences.fasta> [options]
  mycomap-validation ui [options]                 the same, in your browser
  mycomap-validation export <run folder> [options]  files to submit or share
  mycomap-validation contribute <run folder> [options]  send a run's sequences to MycoMap
  mycomap-validation --version                    which version this is

init downloads from mycomap.org, checks each file and unpacks it into the data folder:
MycoMap's BLAST database and names table (nightly), GenBank's fungal ITS database
(weekly) and BLAST+ ${PINNED_BLAST}. It says what it will download, and how big it is,
before it starts. Run it again to update: only what changed is downloaded, and a
broken download carries on where it stopped.

init options:
  --data <folder>         the data folder (default: ${defaultDataFolder()})
  --no-ncbi               leave out GenBank's fungal ITS database (about 180 MB)
  --no-blast              leave out BLAST+ (use the one you have)
  --yes                   go ahead without asking
  --download-only <folder>  only download the files into a folder, to carry to a
                          computer with no internet (with --platform for its kind:
                          ${BLAST_PLATFORMS.join(", ")})
  --from <folder>         set up from a folder made with --download-only

ui options (the browser app, on this computer only):
  --data <folder>         the data folder; each run is kept in <folder>/runs
  --port <n>              the port (default: ${DEFAULT_UI_PORT})
  --threads <n>           BLAST threads (default: ${defaultThreads()})
  --no-open               start it without opening the browser
  --vision-key, --vision-url, --no-vision   as for run

run options:
  --records <sheet.csv>   each sequence's record name and read count: columns
                          "sequence" (the FASTA id), "name", and optionally "reads",
                          "record" and "photos" (a folder of the record's photos)
  --data <folder>         where the downloaded databases are
                          (default: ${defaultDataFolder()}, or MYCOMAP_VALIDATION_DATA)
  --out <folder>          where the results go
                          (default: a folder next to the FASTA file, named after it)
  --threads <n>           BLAST threads (default: ${defaultThreads()})
  --no-ncbi               search MycoMap's sequences only, even if GenBank's are downloaded
  --blast <folder>        the folder holding blastn, if it is not on your PATH
  --vision-key <key>      ask MycoMap Vision about each record, with your own key
                          (or set MYCOMAP_VISION_KEY): an "inat:" or "mo:" record by
                          its observation number, another by the folder of photos
                          in the sheet's "photos" column. Without a key nothing is
                          sent anywhere.
  --vision-url <address>  Vision's address (default: ${DEFAULT_VISION_URL},
                          or MYCOMAP_VISION_URL)
  --no-vision             do not ask Vision, even with MYCOMAP_VISION_KEY set

  --refresh-ncbi          also ask NCBI, live, about the sequences GenBank's weekly
                          database does not answer (no hit at 97% or better): their
                          bases are sent to NCBI. Off unless you give it.
  --ncbi-key <key>        your NCBI API key, if you have one (or set NCBI_API_KEY)
  --ncbi-email <address>  your email address, which NCBI asks for (or set NCBI_EMAIL)

run uses the BLAST+ init installed, else the one on your PATH (2.12 or newer). The
files can also be downloaded by hand from https://mycomap.org/data-downloads and
unpacked into the data folder.

Writes results.csv (one row per sequence), records.csv (one row per record) and
results.json (every step the rules took), plus BLAST's own tables.

export makes, from a run folder's validated records: darwin-core.csv (Darwin Core
occurrences), genbank.fasta and genbank-source.tsv (for NCBI's Submission Portal),
inaturalist.txt (the observation fields and comment, to paste; nothing is sent)
and export-report.txt (what each holds, and what the sheet must add). GenBank needs
the sheet's optional columns: country (or geo_loc_name), collection_date, and
isolate or specimen_voucher; latitude, longitude, collected_by, fwd_primer,
rev_primer, note and genbank_accession are read too.

export options:
  --format <list>         dwc, genbank, inat or all (default), or several: dwc,genbank
  --records <sheet.csv>   a records sheet to use instead of the run's own (to add
                          collection details after the run)
  --fasta <file>          the run's FASTA file, for a run made before the tool kept it
  --out <folder>          where the files go (default: the run folder)
contribute <run folder> sends a run's sequences to mycomap.org for MycoMap's
database, with your member key. It shows what goes and asks first; you agree
that the sequences are published under CC BY 4.0, credited to you. Nothing is
sent anywhere unless you run it.
  --status                where each contribution stands; renames the local names
                          (Genus sp. 'local-<read>') once mycomap.org names them
  --withdraw              withdraw what has not been decided yet
  --key <key>             your MycoMap member key (or set MYCOMAP_MEMBER_KEY), with
                          the "contribute" grant a MycoMap admin gives
  --records <sheet.csv>   the sheet whose voucher, primers, run, plate, well and
                          method columns go with each read (default: the run's own)
  --fasta <file>          the sequences, for a run that did not keep sequences.fasta
  --yes                   go ahead without asking`;

export interface ParsedArgs {
  command: "run" | "init" | "ui" | "export" | "contribute" | "help" | "version";
  /** export: the run folder, and which files. */
  folder?: string;
  formats?: ExportFormat[];
  /** ui: the port, and whether to open the browser. */
  port?: number;
  open?: boolean;
  fasta?: string;
  records?: string;
  data?: string;
  out?: string;
  threads?: number;
  ncbi: boolean;
  blast?: string;
  /** run: ask NCBI live (opt-in), with the person's own key and email address. */
  refreshNcbi?: boolean;
  ncbiKey?: string;
  ncbiEmail?: string;
  /** init: install BLAST+. */
  installBlast?: boolean;
  yes?: boolean;
  platform?: string;
  downloadOnly?: string;
  from?: string;
  /** contribute: the run folder, what to do, and its options. */
  contribute?: { folder: string; action: "send" | "status" | "withdraw"; key?: string; site?: string; records?: string; fasta?: string };
  /** run and ui: MycoMap Vision's key and address, and --no-vision. */
  visionKey?: string;
  visionUrl?: string;
  noVision?: boolean;
}

const VISION_TAKES_VALUE = new Set(["--vision-key", "--vision-url"]);

/** Reads a Vision option at rest[i]; returns how many arguments it took (0: not one). */
function visionOption(rest: string[], i: number, parsed: ParsedArgs): number {
  const arg = rest[i];
  if (arg === "--no-vision") { parsed.noVision = true; return 1; }
  if (!VISION_TAKES_VALUE.has(arg)) return 0;
  const value = rest[i + 1];
  if (value === undefined || value.startsWith("--")) throw new InputError(`${arg} needs a value after it.`);
  if (arg === "--vision-key") parsed.visionKey = value;
  else parsed.visionUrl = value;
  return 2;
}

/** The Vision settings the arguments and the environment give; null: Vision is not asked. */
export function visionFromArgs(args: ParsedArgs, env: NodeJS.ProcessEnv = process.env): VisionSettings | null {
  if (args.noVision) return null;
  return visionSettings({ key: args.visionKey ?? null, url: args.visionUrl ?? null, env });
}

const TAKES_VALUE = new Set(["--records", "--data", "--out", "--threads", "--blast"]);
const INIT_TAKES_VALUE = new Set(["--data", "--platform", "--download-only", "--from"]);

function parseUi(rest: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: "ui", ncbi: true, open: true };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--no-open") { parsed.open = false; continue; }
    const took = visionOption(rest, i, parsed);
    if (took) { i += took - 1; continue; }
    if (arg === "--data" || arg === "--port" || arg === "--threads") {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) throw new InputError(`${arg} needs a value after it.`);
      if (arg === "--data") parsed.data = value;
      else if (!/^\d+$/.test(value) || Number(value) < (arg === "--port" ? 1024 : 1) || Number(value) > 65535) {
        throw new InputError(arg === "--port" ? `--port takes a number from 1024 to 65535, not "${value}".` : `--threads takes a whole number of 1 or more, not "${value}".`);
      } else if (arg === "--port") parsed.port = Number(value);
      else parsed.threads = Number(value);
      continue;
    }
    throw new InputError(arg.startsWith("--") ? `ui has no ${arg} option. Run "mycomap-validation help" to see the options.` : `ui takes no file name ("${arg}"): choose the files in the browser.`);
  }
  return parsed;
}

/** Opens a web address in the computer's own browser; says nothing if it cannot. */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const [cmd, args] = platform === "win32" ? ["cmd", ["/c", "start", "", url]] : platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => undefined).unref();
  } catch {
    // The address is printed; the person can open it.
  }
}

function parseInit(rest: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: "init", ncbi: true, installBlast: true, yes: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--no-ncbi") { parsed.ncbi = false; continue; }
    if (arg === "--no-blast") { parsed.installBlast = false; continue; }
    if (arg === "--yes" || arg === "-y") { parsed.yes = true; continue; }
    if (INIT_TAKES_VALUE.has(arg)) {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) throw new InputError(`${arg} needs a value after it.`);
      if (arg === "--platform" && !BLAST_PLATFORMS.includes(value)) throw new InputError(`--platform takes one of ${BLAST_PLATFORMS.join(", ")}, not "${value}".`);
      if (arg === "--data") parsed.data = value;
      else if (arg === "--platform") parsed.platform = value;
      else if (arg === "--download-only") parsed.downloadOnly = value;
      else parsed.from = value;
      continue;
    }
    throw new InputError(arg.startsWith("--") ? `init has no ${arg} option. Run "mycomap-validation help" to see the options.` : `init takes no file name ("${arg}"); name the data folder with --data.`);
  }
  if (parsed.downloadOnly && parsed.from) throw new InputError("--download-only and --from go on different computers: use one or the other.");
  if (parsed.platform && !parsed.downloadOnly) throw new InputError("--platform is for --download-only, to fetch BLAST+ for another computer.");
  return parsed;
}

const CONTRIBUTE_TAKES_VALUE = new Set(["--key", "--site", "--records", "--fasta"]);

function parseContribute(rest: string[]): ParsedArgs {
  let folder: string | undefined;
  const c: Omit<NonNullable<ParsedArgs["contribute"]>, "folder"> = { action: "send" };
  let yes = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--yes" || arg === "-y") { yes = true; continue; }
    if (arg === "--status" || arg === "--withdraw") {
      if (c.action !== "send") throw new InputError("--status and --withdraw: use one at a time.");
      c.action = arg === "--status" ? "status" : "withdraw";
      continue;
    }
    if (CONTRIBUTE_TAKES_VALUE.has(arg)) {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) throw new InputError(`${arg} needs a value after it.`);
      c[arg.slice(2) as "key" | "site" | "records" | "fasta"] = value;
      continue;
    }
    if (arg.startsWith("--")) throw new InputError(`contribute has no ${arg} option. Run "mycomap-validation help" to see the options.`);
    if (folder) throw new InputError(`One run folder at a time: "${folder}" and "${arg}" were both given.`);
    folder = arg;
  }
  if (!folder) throw new InputError("Say which run to send: mycomap-validation contribute <run folder> (the folder run wrote its results to).");
  if (c.action !== "send" && (c.records || c.fasta)) throw new InputError(`--records and --fasta are for sending, not for --${c.action}.`);
  return { command: "contribute", ncbi: true, yes, contribute: { folder, ...c } };
}

function parseExport(rest: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: "export", ncbi: true, formats: [...EXPORT_FORMATS] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--format" || arg === "--records" || arg === "--fasta" || arg === "--out") {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) throw new InputError(`${arg} needs a value after it.`);
      if (arg === "--format") parsed.formats = parseFormats(value);
      else parsed[arg.slice(2) as "records" | "fasta" | "out"] = value;
      continue;
    }
    if (arg.startsWith("--")) throw new InputError(`export has no ${arg} option. Run "mycomap-validation help" to see the options.`);
    if (parsed.folder) throw new InputError(`One run folder at a time: "${parsed.folder}" and "${arg}" were both given.`);
    parsed.folder = arg;
  }
  if (!parsed.folder) throw new InputError("Say which run folder to export: mycomap-validation export my-sequences_mycomap-validation");
  return parsed;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") return { command: "help", ncbi: true };
  // `<command> --help` (or -h) anywhere prints the help, as people expect, rather than refusing the option.
  if (rest.includes("--help") || rest.includes("-h")) return { command: "help", ncbi: true };
  if (command === "--version" || command === "version") return { command: "version", ncbi: true };
  if (command === "init") return parseInit(rest);
  if (command === "ui") return parseUi(rest);
  if (command === "export") return parseExport(rest);
  if (command === "contribute") return parseContribute(rest);
  if (command !== "run") throw new InputError(`There is no "${command}" command. Run "mycomap-validation help" to see what there is.`);
  const parsed: ParsedArgs = { command: "run", ncbi: true };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--no-ncbi") { parsed.ncbi = false; continue; }
    // --refresh-ncbi and its key and email address.
    if (arg === "--refresh-ncbi") { parsed.refreshNcbi = true; continue; }
    if (arg === "--ncbi-key" || arg === "--ncbi-email") {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) throw new InputError(`${arg} needs a value after it.`);
      if (arg === "--ncbi-key") parsed.ncbiKey = value;
      else parsed.ncbiEmail = value;
      continue;
    }
    const took = visionOption(rest, i, parsed);
    if (took) { i += took - 1; continue; }
    if (TAKES_VALUE.has(arg)) {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) throw new InputError(`${arg} needs a value after it.`);
      if (arg === "--threads") {
        if (!/^\d+$/.test(value) || Number(value) < 1) throw new InputError(`--threads takes a whole number of 1 or more, not "${value}".`);
        parsed.threads = Number(value);
      } else {
        parsed[arg.slice(2) as "records" | "data" | "out" | "blast"] = value;
      }
      continue;
    }
    if (arg.startsWith("--")) throw new InputError(`There is no ${arg} option. Run "mycomap-validation help" to see the options.`);
    if (parsed.fasta) throw new InputError(`One FASTA file at a time: "${parsed.fasta}" and "${arg}" were both given.`);
    parsed.fasta = arg;
  }
  if (!parsed.fasta) throw new InputError(`Say which FASTA file to check: mycomap-validation run my-sequences.fasta`);
  if ((parsed.ncbiKey || parsed.ncbiEmail) && !parsed.refreshNcbi) throw new InputError(`${parsed.ncbiKey ? "--ncbi-key" : "--ncbi-email"} is for --refresh-ncbi, which was not given: nothing is sent to NCBI without it.`);
  return parsed;
}

/** The results folder when none is given: next to the FASTA file, named after it. */
export function defaultOutFolder(fasta: string): string {
  const parsed = path.parse(path.resolve(fasta));
  return path.join(parsed.dir, `${parsed.name}_mycomap-validation`);
}

/** "; NCBI: live 2026-11-20 for 3 sequences", when --refresh-ncbi answered some. */
export function liveNote(live: { label: string; date: string; sequences: unknown[] } | undefined): string {
  if (!live?.sequences.length) return "";
  return `; ${live.label} ${live.date} for ${live.sequences.length} sequence${live.sequences.length === 1 ? "" : "s"}`;
}

/** One line per record for the terminal. */
export function recordLine(r: RecordOutcome): string {
  const what = r.decision === "validate" ? `VALIDATED as ${r.species}` : r.decision === "reject" ? "REJECTED" : "HELD for a person";
  const reads = r.sequenceIds.length > 1 || r.record !== r.sequenceIds[0] ? ` (${r.sequenceIds.join(", ")})` : "";
  return `  ${r.record}${reads}: ${what}${r.decision === "validate" ? "" : ` - ${r.reason.replace(/^Rejected: /, "")}`}`;
}

/** One line per sequence for the terminal. */
export function summaryLine(o: SequenceOutcome): string {
  const r = o.result;
  const name = r.finalSpecies ? `${r.finalSpecies}${r.finalConfidence === null ? "" : ` (${r.finalConfidence}%)`}` : "no DNA name";
  const notes = [
    ...flagsOf(r),
    r.contaminantLikelyName?.name && `likely ${r.contaminantLikelyName.name}`,
    genbankLikelyNameLabel(r.genbankLikelyName),
  ].filter(Boolean);
  return `  ${o.id}: ${name}${notes.length ? `  [${notes.join("; ")}]` : ""}`;
}

async function askInTerminal(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

export async function main(argv: string[], print: (line: string) => void = console.log, ask?: (question: string) => Promise<boolean>): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof InputError) { print(error.message); return 2; }
    throw error;
  }
  if (args.command === "help") { print(HELP); return 0; }
  if (args.command === "version") { print(`mycomap-validation ${engineVersion()}`); return 0; }
  // `pnpm tool run …` runs in the repository's folder; a path typed by the user is from where they typed it.
  const from = (p: string) => path.resolve(process.env.INIT_CWD || process.cwd(), p);
  let vision: VisionSettings | null = null;
  try {
    if (args.command === "run" || args.command === "ui") vision = visionFromArgs(args);
  } catch (error) {
    if (error instanceof VisionSettingError) { print(error.message); return 2; }
    throw error;
  }
  if (args.command === "contribute") {
    const c = args.contribute!;
    try {
      const settings = contributeSettings({ key: c.key ?? null, url: c.site ?? null });
      const flow = { folder: from(c.folder), settings, say: print, yes: !!args.yes, ask: ask ?? (process.stdin.isTTY ? askInTerminal : undefined) };
      const done = c.action === "status" ? await statusOfRun(flow)
        : c.action === "withdraw" ? await withdrawRun(flow)
        : await sendRun({ ...flow, records: c.records ? from(c.records) : null, fasta: c.fasta ? from(c.fasta) : null });
      return done.code;
    } catch (error) {
      if (error instanceof InputError) { print(error.message); return 1; }
      throw error;
    }
  }
  if (args.command === "ui") {
    try {
      const ui = await startUi({
        data: from(args.data ?? defaultDataFolder()), port: args.port ?? DEFAULT_UI_PORT, threads: args.threads ?? defaultThreads(), vision,
        // Contribute: the member key from MYCOMAP_MEMBER_KEY, or typed on the page.
        memberKey: process.env.MYCOMAP_MEMBER_KEY?.trim() || null, mycomapUrl: process.env.MYCOMAP_SITE_URL?.trim() || null,
      });
      print(`MycoMap Validation is open at ${ui.url}`);
      print("It answers this computer only. Keep this window open while you use it; press Ctrl+C to stop.");
      if (args.open !== false) openInBrowser(ui.url);
      return 0;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "EADDRINUSE") { print(`Port ${args.port ?? DEFAULT_UI_PORT} is in use (is the tool already open?). Choose another with --port.`); return 1; }
      if (error instanceof InputError) { print(error.message); return 1; }
      throw error;
    }
  }
  if (args.command === "export") {
    try {
      const output = exportRun({ folder: from(args.folder!), formats: args.formats, fasta: args.fasta ? from(args.fasta) : null, records: args.records ? from(args.records) : null, out: args.out ? from(args.out) : null });
      for (const line of output.summary) print(line);
      print("");
      print(`Written to ${output.out}; export-report.txt says what was left out and why.`);
      return 0;
    } catch (error) {
      if (error instanceof InputError) { print(error.message); return 1; }
      throw error;
    }
  }
  if (args.command === "init") {
    try {
      await runInit({
        data: from(args.data ?? defaultDataFolder()),
        ncbi: args.ncbi,
        blast: !!args.installBlast,
        platform: args.platform ?? null,
        downloadOnly: args.downloadOnly ? from(args.downloadOnly) : null,
        from: args.from ? from(args.from) : null,
        yes: !!args.yes,
        ask: ask ?? (process.stdin.isTTY ? askInTerminal : undefined),
        say: print,
      });
      return 0;
    } catch (error) {
      if (error instanceof InputError) { print(error.message); return 1; }
      throw error;
    }
  }
  const out = from(args.out ?? defaultOutFolder(from(args.fasta!)));
  try {
    // Nothing goes to NCBI unless --refresh-ncbi was given.
    const refreshNcbi = args.refreshNcbi ? ncbiAccess({ apiKey: args.ncbiKey, email: args.ncbiEmail }) : null;
    const output = await runValidation({
      fasta: from(args.fasta!),
      records: args.records ? from(args.records) : null,
      data: from(args.data ?? defaultDataFolder()),
      out,
      threads: args.threads ?? defaultThreads(),
      ncbi: args.ncbi,
      blastFolder: args.blast ?? null,
      refreshNcbi,
      vision,
      say: print,
    });
    print("");
    print(`Results (MycoMap Validation ${output.stamp.engineVersion}; MycoMap database ${output.stamp.databases.mycomap.version ?? "of unknown date"}; GenBank ${output.stamp.databases.ncbi ? output.stamp.databases.ncbi.version ?? "of unknown date" : "not searched"}${liveNote(output.stamp.databases.ncbi?.live)}):`);
    for (const o of output.sequences) print(summaryLine(o));
    print("");
    const v = output.stamp.vision;
    print(v ? `Records (as auto-validation would decide them; MycoMap Vision answered ${v.answered} of the ${v.asked} it was asked about):` : "Records (as auto-validation would decide them; MycoMap Vision not asked: no key):");
    if (v?.problem) print(`  ${v.problem}.`);
    if (v && usageText(v.usage)) print(`  Vision quota: ${usageText(v.usage)}.`);
    for (const r of output.records) print(recordLine(r));
    print("");
    print(`Written to ${out}:`);
    print(`  results.csv    one row per sequence`);
    print(`  records.csv    one row per record: validated, rejected or held, and why`);
    print(`  results.json   everything, with each step the rules took`);
    if (output.files.ncbiLive) print(`  ncbi-live/     NCBI's own answers (BLAST XML) for the sequences it searched live`);
    print(`  sequences.fasta  the sequences as the tool read them (what contribute sends)`);
    print("");
    print(`For GenBank, Darwin Core or iNaturalist: mycomap-validation export "${out}"`);
    const local = output.sequences.filter((o) => o.localName).length;
    if (local) {
      print("");
      print(`${local === 1 ? "One read has a local name" : `${local} reads have local names`} (Genus sp. 'local-<read>'): nothing in MycoMap names ${local === 1 ? "it" : "them"} yet. A local name stays on this computer until MycoMap registers it: send the run with mycomap-validation contribute ${out}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof InputError) { print(error.message); return 1; }
    throw error;
  }
}

/** Runs a command and sets the exit code: from `pnpm tool`, or the downloadable tool (tool/release/main.ts). */
export function runCommandLine(argv: string[]): void {
  main(argv).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`Something went wrong that the tool did not expect: ${error?.stack ?? error}`);
    console.error("Please report it at https://github.com/BiodiverseLabs/mycomap-validation/issues with the command you ran.");
    process.exitCode = 3;
  });
}

// The downloadable tool starts from tool/release/main.ts instead (its one file is every module's import.meta.url).
const invoked = !bundled && !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) runCommandLine(process.argv.slice(2));
