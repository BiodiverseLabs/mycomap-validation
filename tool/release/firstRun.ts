// The first run, as a person does it, from an unzipped download alone:
//
//   mycomap-validation init        (from a stand-in for mycomap.org on this computer)
//   mycomap-validation run my-sequences.fasta   (with the network blocked)
//
// then checks what came out, and that the browser app's page is inside the
// download. Given the .zip too (--zip), it also tries the one-line install
// (install.ps1 or install.sh, as the build writes them) from a server on this
// computer, into the work folder, and runs the installed mmv. The release workflow runs it on Windows, macOS and Linux; it can
// be run by hand too:
//
//   node --import tsx tool/release/firstRun.ts --download <unzipped download folder>
//     --blast-archive <NCBI's BLAST+ 2.17.0 .tar.gz for this computer> --work <empty folder>
//     [--zip <the download's .zip>] [--no-block]
//
// The stand-in serves small databases made here with makeblastdb (taken from
// the BLAST+ archive) and that BLAST+ archive itself, which init checks
// against its pinned checksum as it would NCBI's. Nothing reaches mycomap.org.
//
// The network block is the system's own: a network namespace with no network
// on Linux (sudo unshare --net), the sandbox on macOS (sandbox-exec), and
// firewall rules for the download's node.exe and BLAST+ on Windows (needs an
// administrator). --no-block leaves it out, and says so.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { unpackTarGz } from "../archive";
import { serve, tarGz } from "../testSupport";
import { installPs1, installSh } from "./installers";
import { COMMAND_NAMES, downloadName } from "./launchers";
import { downloadPlatform } from "./nodeRuntime";
import { startStandIn } from "./standIn";

export const MYCOMAP_VERSION = "2026-11-21";
export const NCBI_VERSION = "2026-11-16";

/** A made-up ITS-length sequence, the same every run. */
export function bases(seed: number, length = 560): string {
  let x = seed;
  let out = "";
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += "ACGT"[(x >> 16) & 3];
  }
  return out;
}

/** The sequence with a base changed every `every` positions. */
export function changed(seq: string, every: number): string {
  return [...seq].map((c, i) => (i % every === every - 1 ? ({ A: "C", C: "G", G: "T", T: "A" } as Record<string, string>)[c] : c)).join("");
}

const NAMES_COLUMNS = ["mm_id", "sequence_id", "name", "mycobank_number", "kingdom", "phylum", "class", "order", "family", "genus", "method", "on_validated_record", "in_reference_set", "reference_exclusion", "flags", "reads_in_consensus", "length", "genbank_accession", "observation", "observation_url", "updated_at"];

/** MycoMap's references: three validated Russula emetica specimens, a Russula nobilis 10% away, and a mould. */
export function references() {
  const emetica = bases(1);
  return [
    { id: 11, name: "Russula emetica", seq: emetica, genus: "Russula", family: "Russulaceae", obs: "inat:101" },
    { id: 12, name: "Russula emetica", seq: emetica, genus: "Russula", family: "Russulaceae", obs: "inat:102" },
    { id: 13, name: "Russula emetica", seq: emetica, genus: "Russula", family: "Russulaceae", obs: "mo:103" },
    { id: 14, name: "Russula nobilis", seq: changed(emetica, 10), genus: "Russula", family: "Russulaceae", obs: "inat:104" },
    { id: 15, name: "Hypomyces chrysospermus", seq: bases(7), genus: "Hypomyces", family: "Hypocreaceae", obs: "inat:105" },
  ];
}

/** The sequences a person checks: one of Russula emetica, and one that matches nothing. */
export function querySequences(): string {
  return `>spec-1 ric=40\n${changed(bases(1), 600).slice(5)}\n>spec-2\n${bases(99, 300)}\n`;
}

/** What the run must have written: the problems found, none when it is right. */
export function resultProblems(json: any, version: string): string[] {
  const problems: string[] = [];
  const expect = (ok: boolean, what: string) => { if (!ok) problems.push(what); };
  expect(json?.tool === "mycomap-validation", `results.json is not the tool's (tool: ${json?.tool})`);
  expect(json?.engineVersion === version, `the engine version is ${json?.engineVersion}, not the download's ${version}`);
  expect(json?.blastSource === "installed by init", `BLAST+ was ${json?.blastSource}, not the one init installed`);
  expect(/2\.17\.0/.test(String(json?.blast)), `BLAST+ is ${json?.blast}, not 2.17.0`);
  expect(json?.databases?.mycomap?.version === MYCOMAP_VERSION, `MycoMap's database is ${json?.databases?.mycomap?.version}, not ${MYCOMAP_VERSION}`);
  expect(json?.databases?.ncbi?.version === NCBI_VERSION, `GenBank's database is ${json?.databases?.ncbi?.version ?? "not searched"}, not ${NCBI_VERSION}`);
  const seq = (id: string) => (json?.sequences ?? []).find((s: any) => s.id === id);
  expect(seq("spec-1")?.result?.finalSpecies === "Russula emetica", `spec-1 was named ${seq("spec-1")?.result?.finalSpecies ?? "nothing"}, not Russula emetica`);
  expect((seq("spec-1")?.ncbiHitCount ?? 0) > 0, "spec-1 has no GenBank hits: GenBank was not searched");
  expect(seq("spec-2") !== undefined && seq("spec-2").result?.finalSpecies === null, `spec-2 (matching nothing) was named ${seq("spec-2")?.result?.finalSpecies}`);
  const rec = (json?.records ?? []).find((r: any) => r.record === "spec-1");
  expect(rec?.decision === "validate" && rec?.species === "Russula emetica", `spec-1's record was ${rec?.decision ?? "missing"} (${rec?.species ?? "no species"}), not validated as Russula emetica`);
  return problems;
}

/** One argument for a cmd.exe command line. */
export function cmdQuote(arg: string): string {
  return /^[A-Za-z0-9_\-.:\\/=]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/** The macOS sandbox for the blocked run: no IP traffic at all (the system's own local sockets stay). */
export const MACOS_NO_NETWORK = "(version 1)(allow default)(deny network*)(allow network* (remote unix-socket))";

/** How a command is run with the network blocked, on Linux and macOS (Windows uses firewall rules instead). */
export function blockedCommand(platform: NodeJS.Platform, command: string[], user: string): string[] {
  if (platform === "linux") return ["sudo", "-n", "unshare", "--net", "--", "sudo", "-n", "-u", user, "--", ...command];
  if (platform === "darwin") return ["sandbox-exec", "-p", MACOS_NO_NETWORK, ...command];
  throw new Error(`blockedCommand is for Linux and macOS, not ${platform}`);
}

/** Tries to reach the internet; prints BLOCKED or REACHED. */
export const PROBE = `fetch("https://github.com", { signal: AbortSignal.timeout(15000) }).then(() => console.log("REACHED"), (e) => console.log("BLOCKED", e?.cause?.code ?? e?.name ?? e?.message))`;

/** The download's version, from its folder's name (mycomap-validation-<version>-<platform>). */
export function versionOfDownload(folder: string): string {
  // The last part of the path, split at either separator: a Windows path reads the same on any system.
  const last = folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const m = /^mycomap-validation-(.+)-(windows|macos|linux)-(x64|arm64)$/.exec(last);
  if (!m) throw new Error(`${folder} is not an unzipped download (mycomap-validation-<version>-<platform>)`);
  return m[1];
}

interface Ran { status: number | null; stdout: string; stderr: string }

function option(argv: string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith("--") ? argv[at + 1] : null;
}

function windowsFirewall(rule: string, programs: string[], on: boolean): void {
  const script = on
    ? ["Set-NetFirewallProfile -All -Enabled True", ...programs.map((p) => `New-NetFirewallRule -DisplayName '${rule}' -Direction Outbound -Action Block -Program '${p.replace(/'/g, "''")}' | Out-Null`)].join("; ")
    : `Remove-NetFirewallRule -DisplayName '${rule}' -ErrorAction SilentlyContinue`;
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  if (on && r.status !== 0) throw new Error(`Could not add the firewall rules that block the network (run as an administrator, or pass --no-block): ${r.stderr || r.stdout}`);
}

async function main(argv: string[]): Promise<number> {
  const say = (line: string) => console.log(line);
  const download = path.resolve(option(argv, "download") ?? "");
  const blastArchive = path.resolve(option(argv, "blast-archive") ?? "");
  const work = path.resolve(option(argv, "work") ?? "");
  const block = !argv.includes("--no-block");
  if (!option(argv, "download") || !option(argv, "blast-archive") || !option(argv, "work")) {
    say("Usage: firstRun.ts --download <unzipped download> --blast-archive <ncbi-blast-2.17.0+-….tar.gz> --work <empty folder> [--zip <the .zip>] [--no-block]");
    return 2;
  }
  const version = versionOfDownload(download);
  const win = process.platform === "win32";
  if (fs.existsSync(work) && fs.readdirSync(work).length) throw new Error(`${work} is not empty`);
  fs.mkdirSync(work, { recursive: true });
  const problems: string[] = [];

  /**
   * Runs one of the download's commands (on Windows a .cmd needs cmd.exe). Not
   * spawnSync: the stand-in answers from this same process, so it must keep running.
   */
  const tool = (name: string, args: string[], opts: { env?: Record<string, string>; wrap?: (cmd: string[]) => string[] } = {}): Promise<Ran> => {
    const file = path.join(download, win ? `${name}.cmd` : name);
    const env = { ...process.env, ...opts.env };
    say(`$ ${name} ${args.join(" ")}`);
    const cmd = (opts.wrap ?? ((c) => c))([file, ...args]);
    const child = win
      ? spawn(cmd.map(cmdQuote).join(" "), { shell: true, env, cwd: work, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(cmd[0], cmd.slice(1), { env, cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => { stdout += d; process.stdout.write(d); });
    child.stderr!.on("data", (d) => { stderr += d; process.stderr.write(d); });
    return new Promise((resolve) => {
      child.on("error", (error) => resolve({ status: null, stdout, stderr: `${stderr}${error.message}` }));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  };

  // 1. The databases a stand-in will serve, made with the archive's own makeblastdb.
  say("Making small databases with makeblastdb…");
  const tools = path.join(work, "makeblastdb");
  await unpackTarGz(blastArchive, tools, (name) => {
    const m = /^[^/]+\/bin\/([^/]+)$/.exec(name);
    return m && (/^makeblastdb(\.exe)?$/.test(m[1]) || /\.(dll|manifest)$/i.test(m[1])) ? m[1] : null;
  });
  const makeblastdb = path.join(tools, win ? "makeblastdb.exe" : "makeblastdb");
  if (!win) fs.chmodSync(makeblastdb, 0o755);
  const build = path.join(work, "build");
  fs.mkdirSync(build);
  const db = (fasta: string, out: string, title: string): Record<string, Buffer> => {
    fs.writeFileSync(path.join(build, `${out}.fasta`), fasta);
    const r = spawnSync(makeblastdb, ["-in", `${out}.fasta`, "-dbtype", "nucl", "-parse_seqids", "-blastdb_version", "5", "-title", title, "-out", out], { cwd: build, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`makeblastdb failed: ${r.stderr || r.stdout || r.error}`);
    return Object.fromEntries(fs.readdirSync(build).filter((f) => f.startsWith(`${out}.n`)).map((f) => [f, fs.readFileSync(path.join(build, f))]));
  };
  const refs = references();
  const mycomapFiles = db(refs.map((r) => `>MM${r.id} ${r.name}\n${r.seq}\n`).join(""), "mycomap", `MycoMap reference sequences ${MYCOMAP_VERSION}`);
  const genbankFiles = db(`>MN000001.1 Russula emetica voucher X1 internal transcribed spacer 1, partial sequence\n${bases(1)}\n`, "genbank_its", `GenBank fungal ITS ${NCBI_VERSION}`);
  const served = path.join(work, "served");
  fs.mkdirSync(served);
  const mycomapDb = path.join(served, `mycomap_blastdb_${MYCOMAP_VERSION}.tar.gz`);
  fs.writeFileSync(mycomapDb, tarGz(Object.entries(mycomapFiles).map(([name, body]) => ({ name, body }))));
  const names = path.join(served, `mycomap_sequences_${MYCOMAP_VERSION}.tsv.gz`);
  const rows = refs.map((r) => NAMES_COLUMNS.map((c) => ({
    mm_id: `MM${r.id}`, sequence_id: String(r.id), name: r.name, family: r.family, genus: r.genus, method: "ont",
    on_validated_record: "yes", reads_in_consensus: "40", length: String(r.seq.length), observation: r.obs,
  } as Record<string, string>)[c] ?? "").join("\t"));
  fs.writeFileSync(names, zlib.gzipSync(`${NAMES_COLUMNS.join("\t")}\n${rows.join("\n")}\n`));
  const ncbi = path.join(served, `ncbi-its-blastdb-${NCBI_VERSION}.tar.gz`);
  const ncbiFolder = `ncbi-its-blastdb-${NCBI_VERSION}`;
  fs.writeFileSync(ncbi, tarGz([
    { name: `${ncbiFolder}/` },
    ...Object.entries(genbankFiles).map(([name, body]) => ({ name: `${ncbiFolder}/${name}`, body })),
    { name: `${ncbiFolder}/info.txt`, body: `Built:    ${NCBI_VERSION} 04:00:00 EST\n` },
  ]));

  // 2. init, from the stand-in.
  const standIn = await startStandIn({ mycomapVersion: MYCOMAP_VERSION, mycomapDb, names, ncbi: { version: NCBI_VERSION, file: ncbi }, blast: [blastArchive] });
  const data = path.join(work, "data");
  try {
    const version1 = await tool(COMMAND_NAMES[0], ["--version"]);
    if (version1.stdout.trim() !== `mycomap-validation ${version}`) problems.push(`--version printed "${version1.stdout.trim()}"`);
    const short = await tool(COMMAND_NAMES[1], ["--version"]);
    if (short.stdout.trim() !== `mycomap-validation ${version}`) problems.push(`mmv --version printed "${short.stdout.trim()}"`);

    const init = await tool(COMMAND_NAMES[0], ["init", "--yes", "--data", data], { env: standIn.env });
    if (init.status !== 0 || !/^Done\./m.test(init.stdout)) problems.push(`init did not finish (exit ${init.status})`);
    const fetched = standIn.requests.filter((r) => r !== "/api/downloads").map((r) => path.posix.basename(r)).sort();
    const wanted = [mycomapDb, names, ncbi, blastArchive].map((f) => path.basename(f)).sort();
    if (JSON.stringify(fetched) !== JSON.stringify(wanted)) problems.push(`init downloaded ${fetched.join(", ") || "nothing"}, not ${wanted.join(", ")}`);
    const again = await tool(COMMAND_NAMES[1], ["init", "--yes", "--data", data], { env: standIn.env });
    if (again.status !== 0 || !/is up to date/.test(again.stdout)) problems.push("init run again did not say everything is up to date");
  } finally {
    await standIn.close();
  }
  if (problems.length) return report(problems);

  // 3. run, with the network blocked.
  const fasta = path.join(work, "my sequences.fasta");
  fs.writeFileSync(fasta, querySequences());
  const records = path.join(work, "records.csv");
  fs.writeFileSync(records, "sequence,name\nspec-1,Russula emetica\n");
  const out = path.join(work, "results");
  const node = path.join(download, "lib", win ? "node.exe" : "node");
  const rule = "mycomap-validation first run: no network";
  let wrap: ((cmd: string[]) => string[]) | undefined;
  if (block) {
    if (win) {
      const blast = fs.readdirSync(path.join(data, "blast")).map((v) => path.join(data, "blast", v));
      windowsFirewall(rule, [node, ...blast.flatMap((b) => ["blastn.exe", "blastdbcmd.exe"].map((p) => path.join(b, p)))], true);
    } else {
      wrap = (cmd) => blockedCommand(process.platform, cmd, os.userInfo().username);
    }
    const probeCmd = (wrap ?? ((c) => c))([node, "-e", PROBE]);
    const probe = spawnSync(probeCmd[0], probeCmd.slice(1), { encoding: "utf8" });
    say(`Network block: ${(probe.stdout || probe.stderr || String(probe.error)).trim()}`);
    if (!/^BLOCKED/m.test(probe.stdout ?? "")) {
      if (win) windowsFirewall(rule, [], false);
      return report([`the network block does not hold (the probe said: ${(probe.stdout || probe.stderr || String(probe.error)).trim()})`]);
    }
  } else {
    say("The network is NOT blocked for this run (--no-block).");
  }
  try {
    const run = await tool(COMMAND_NAMES[0], ["run", fasta, "--records", records, "--data", data, "--out", out, "--threads", "2"], { wrap });
    if (run.status !== 0) problems.push(`run failed (exit ${run.status})`);
  } finally {
    if (block && win) windowsFirewall(rule, [], false);
  }
  const resultsFile = path.join(out, "results.json");
  if (!fs.existsSync(resultsFile)) return report([...problems, "run wrote no results.json"]);
  problems.push(...resultProblems(JSON.parse(fs.readFileSync(resultsFile, "utf8")), version));
  for (const f of ["results.csv", "records.csv"]) if (!fs.existsSync(path.join(out, f))) problems.push(`run wrote no ${f}`);

  // 4. The browser app: its page comes from inside the download.
  problems.push(...(await uiProblems(download, data, version)));

  // 5. The one-line install, when the .zip is given.
  const zip = option(argv, "zip");
  if (zip) problems.push(...(await installProblems(path.resolve(zip), work, version)));
  else say("The one-line install was not tried (no --zip).");
  return report(problems, block);
}

/**
 * Serves the .zip and its installer from this computer, runs the person's one
 * line (irm … | iex, or curl … | sh) with the install going into the work
 * folder, and runs the installed mmv. On Windows the Path it writes is a test
 * variable, removed afterwards.
 */
async function installProblems(zipFile: string, work: string, version: string): Promise<string[]> {
  const win = process.platform === "win32";
  const platform = downloadPlatform();
  if (!platform) return [`no download for ${process.platform} ${process.arch}`];
  const zip = fs.readFileSync(zipFile);
  if (path.basename(zipFile) !== `${downloadName(version, platform)}.zip`) return [`${zipFile} is not this computer's download (${downloadName(version, platform)}.zip)`];
  const server = await serve({});
  const base = `${server.base}/v${version}/`;
  const opts = { version, base, downloads: [{ platform, bytes: zip.length, sha256: crypto.createHash("sha256").update(zip).digest("hex") }] };
  server.files.set(`/v${version}/${path.basename(zipFile)}`, zip);
  server.files.set(`/v${version}/install.ps1`, installPs1(opts) ?? "");
  server.files.set(`/v${version}/install.sh`, installSh(opts) ?? "");
  const home = path.join(work, "home");
  fs.mkdirSync(home, { recursive: true });
  const pathVariable = "MYCOMAP_VALIDATION_FIRST_RUN_PATH";
  const env = win
    ? { ...process.env, MYCOMAP_VALIDATION_INSTALL_DIR: path.join(home, "MycoMap Validation"), MYCOMAP_VALIDATION_TEST_PATH_VARIABLE: pathVariable, MYCOMAP_VALIDATION_NO_INIT: "1" }
    : { ...process.env, HOME: home, SHELL: "/bin/bash", MYCOMAP_VALIDATION_NO_INIT: "1" };
  const line = win ? `irm ${base}install.ps1 | iex` : `curl -fsSL ${base}install.sh | sh`;
  console.log(`$ ${line}`);
  const problems: string[] = [];
  try {
    const child = win ? spawn("powershell", ["-NoProfile", "-Command", line], { env }) : spawn("sh", ["-c", line], { env });
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => process.stderr.write(d));
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    if (status !== 0) return [`the one-line install failed (exit ${status})`];
    const mmv = win ? path.join(home, "MycoMap Validation", "bin", "mmv.cmd") : path.join(home, ".local", "bin", "mmv");
    const ran = win ? spawnSync(`"${mmv}" --version`, { shell: true, encoding: "utf8" }) : spawnSync(mmv, ["--version"], { encoding: "utf8" });
    if (ran.stdout.trim() !== `mycomap-validation ${version}`) problems.push(`the installed mmv printed "${ran.stdout.trim()}" ${ran.stderr ?? ""}`);
    else console.log(`Installed mmv runs: ${ran.stdout.trim()}`);
  } finally {
    if (win) spawnSync("powershell", ["-NoProfile", "-Command", `[Environment]::SetEnvironmentVariable('${pathVariable}', $null, 'User')`]);
    await server.close();
  }
  return problems;
}

/** Starts `ui`, reads its page and script, and stops it. */
async function uiProblems(download: string, data: string, version: string): Promise<string[]> {
  const win = process.platform === "win32";
  const port = 20000 + Math.floor(Math.random() * 20000);
  const file = path.join(download, win ? "mycomap-validation.cmd" : "mycomap-validation");
  const child = win
    ? spawn([file, "ui", "--no-open", "--port", String(port), "--data", data].map(cmdQuote).join(" "), { shell: true })
    : spawn(file, ["ui", "--no-open", "--port", String(port), "--data", data]);
  const problems: string[] = [];
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let said = "";
      const timer = setTimeout(() => reject(new Error(`ui did not start in 30 s: ${said}`)), 30000);
      child.stdout!.on("data", (d) => {
        said += d;
        const m = /is open at (\S+)/.exec(said);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      child.stderr!.on("data", (d) => { said += d; });
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`ui stopped (exit ${code}): ${said}`)); });
    });
    console.log(`ui is open at ${url}`);
    const page = await (await fetch(url)).text();
    if (!page.includes(version)) problems.push("the ui page does not show the version");
    if (page.includes("{{KEY}}") || page.includes("{{VERSION}}")) problems.push("the ui page was not filled in");
    const script = await fetch(new URL("/app.js", url));
    if (script.status !== 200 || !(await script.text()).length) problems.push(`the ui's app.js answered ${script.status}`);
  } catch (error) {
    problems.push((error as Error).message);
  } finally {
    if (win && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    else child.kill();
  }
  return problems;
}

function report(problems: string[], blocked = true): number {
  if (problems.length === 0) {
    console.log(`First run OK: init from the stand-in, run ${blocked ? "with the network blocked" : "WITHOUT the network blocked (--no-block)"}, the results right, the page inside the download (and the one-line install, if --zip was given).`);
    return 0;
  }
  console.error(`First run FAILED:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  return 1;
}

const invoked = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
