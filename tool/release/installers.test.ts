// The one-line installs, run as a person runs them (Windows PowerShell 5.1:
// `irm …/install.ps1 | iex`; macOS and Linux: `curl -fsSL …/install.sh | sh`)
// against a server on this computer that serves a download made by the
// build's own downloadEntries, with this computer's Node.js and a stand-in
// for the tool that prints what it was asked. Each install goes into a
// temporary folder; on Windows the Path it writes is a test variable of its
// own, removed afterwards, never the real Path.
//   node --import tsx --test tool/release/installers.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { serve, type Served } from "../testSupport";
import { downloadEntries } from "./build";
import { installPs1, installSh, releaseBase, type InstallerOptions } from "./installers";
import { downloadName } from "./launchers";
import { downloadPlatform, type DownloadPlatform } from "./nodeRuntime";
import { zipBytes } from "./zip";

const win = process.platform === "win32";
const here = downloadPlatform();
const hasCurl = spawnSync("curl", ["--version"]).status === 0;
const canInstall = win
  ? spawnSync("powershell", ["-NoProfile", "-Command", "exit 0"]).status === 0 ? false : "Windows PowerShell is not here"
  : !here ? "no download for this computer" : !hasCurl ? "curl is not installed" : process.platform === "linux" && spawnSync("unzip", ["-v"]).status !== 0 ? "unzip is not installed" : false;

/** A download as the build makes it, whose "tool" prints its arguments. */
function fakeZip(version: string, platform: DownloadPlatform): Buffer {
  return zipBytes(downloadEntries({
    version, platform,
    bundle: `console.log(process.argv.slice(2)[0] === "--version" ? "mycomap-validation ${version}" : "TOOL RAN: " + process.argv.slice(2).join(" "));\n`,
    node: fs.readFileSync(process.execPath), nodeLicense: Buffer.from("licence"), license: "MIT\n", notices: "notices\n",
  }));
}

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/** Serves one or more versions' zips, with their installers, from 127.0.0.1. */
async function release(versions: string[], opts: { wrongChecksum?: boolean } = {}): Promise<{ server: Served; base: (v: string) => string }> {
  const platform = here!;
  const server = await serve({});
  const base = (v: string) => `${server.base}/v${v}/`;
  for (const v of versions) {
    const zip = fakeZip(v, platform);
    const o: InstallerOptions = { version: v, base: base(v), downloads: [{ platform, bytes: zip.length, sha256: opts.wrongChecksum ? sha(Buffer.from("other")) : sha(zip) }] };
    server.files.set(`/v${v}/${downloadName(v, platform)}.zip`, zip);
    server.files.set(`/v${v}/install.ps1`, installPs1(o) ?? "");
    server.files.set(`/v${v}/install.sh`, installSh(o) ?? "");
  }
  return { server, base };
}

function inTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmv install "));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/** The person's one line, in their shell. Not spawnSync: the server answers from this same process. */
function oneLine(base: string, env: Record<string, string>): Promise<{ status: number | null; out: string }> {
  const child = win
    ? spawn("powershell", ["-NoProfile", "-Command", `irm ${base}install.ps1 | iex`], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
    : spawn("sh", ["-c", `curl -fsSL ${base}install.sh | sh`], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => { out += d; });
  child.stderr!.on("data", (d) => { out += d; });
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, out })));
}

const testPathVariable = `MMV_TEST_PATH_${process.pid}`;
function userVariable(name: string): string | null {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Item -LiteralPath 'HKCU:\\Environment').GetValue('${name}', $null, 'DoNotExpandEnvironmentNames')`], { encoding: "utf8" });
  return r.stdout.trim() || null;
}
function removeUserVariable(name: string): void {
  spawnSync("powershell", ["-NoProfile", "-Command", `[Environment]::SetEnvironmentVariable('${name}', $null, 'User')`]);
}

function installEnv(dir: string): Record<string, string> {
  return win
    ? { MYCOMAP_VALIDATION_INSTALL_DIR: path.join(dir, "MycoMap Validation"), MYCOMAP_VALIDATION_TEST_PATH_VARIABLE: testPathVariable }
    : { HOME: dir, SHELL: "/bin/bash", PATH: (process.env.PATH ?? "").split(":").filter((p) => !p.includes(".local/bin")).join(":") };
}
const installRoot = (dir: string) => (win ? path.join(dir, "MycoMap Validation") : path.join(dir, ".local", "share", "mycomap-validation"));
const command = (dir: string, name: string) => (win ? path.join(installRoot(dir), "bin", `${name}.cmd`) : path.join(dir, ".local", "bin", name));
const runCommand = (file: string, args: string[]) => (win
  ? spawnSync(`"${file}" ${args.join(" ")}`, { shell: true, encoding: "utf8" })
  : spawnSync(file, args, { encoding: "utf8" }));

test("the one line installs the download for this computer, puts both commands on the person's own path, and runs init", { skip: canInstall }, () => inTemp(async (dir) => {
  const { server, base } = await release(["9.9.9"]);
  try {
    const r = await oneLine(base("9.9.9"), installEnv(dir));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Installing MycoMap Validation 9\.9\.9 into/);
    assert.match(r.out, /no administrator needed/);
    assert.match(r.out, /Checking that it is the published file \(SHA-256\)/);
    assert.match(r.out, /mycomap-validation 9\.9\.9/, "the installed tool started");
    if (win) assert.match(r.out, /TOOL RAN: init/, "init runs (and asks for itself)");
    else assert.match(r.out, /Next, set up the databases and BLAST\+:  mycomap-validation init/, "with no terminal to ask in, it says to run init");
    assert.ok(fs.existsSync(path.join(installRoot(dir), downloadName("9.9.9", here!))));
    assert.ok(!fs.readdirSync(installRoot(dir)).some((f) => f.endsWith(".zip") || f === ".unpacking"), "nothing left over");
    for (const name of ["mycomap-validation", "mmv"]) {
      const ran = runCommand(command(dir, name), ["--version"]);
      assert.equal(ran.stdout.trim(), "mycomap-validation 9.9.9", `${name} on the path runs the tool: ${ran.stderr}`);
    }
    if (win) {
      assert.deepEqual(userVariable(testPathVariable)?.split(";"), [path.join(installRoot(dir), "bin")], "the bin folder is on the person's own Path");
    } else {
      const profile = fs.readFileSync(path.join(dir, ".bashrc"), "utf8");
      assert.match(profile, new RegExp(`export PATH="${path.join(dir, ".local", "bin").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\$PATH"`), "the profile puts ~/.local/bin on the PATH");
    }
    // Run again (an update to the same version): the path is not added twice.
    const again = await oneLine(base("9.9.9"), installEnv(dir));
    assert.equal(again.status, 0, again.out);
    if (win) assert.match(again.out, /is already on your Path/);
    if (win) assert.equal(userVariable(testPathVariable)?.split(";").length, 1);
    else assert.equal(fs.readFileSync(path.join(dir, ".bashrc"), "utf8").match(/MycoMap Validation/g)?.length, 1, "the profile line is added once");
  } finally {
    if (win) removeUserVariable(testPathVariable);
    await server.close();
  }
}));

test("a newer version's line replaces the older version", { skip: canInstall }, () => inTemp(async (dir) => {
  const { server, base } = await release(["9.9.8", "9.9.9"]);
  try {
    assert.equal((await oneLine(base("9.9.8"), installEnv(dir))).status, 0);
    const r = await oneLine(base("9.9.9"), installEnv(dir));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, new RegExp(`Removed the older ${downloadName("9.9.8", here!)}`));
    assert.deepEqual(fs.readdirSync(installRoot(dir)).filter((f) => f.startsWith("mycomap-validation-")), [downloadName("9.9.9", here!)]);
    assert.equal(runCommand(command(dir, "mmv"), ["--version"]).stdout.trim(), "mycomap-validation 9.9.9");
  } finally {
    if (win) removeUserVariable(testPathVariable);
    await server.close();
  }
}));

test("a download that is not the published file is refused, and nothing is installed", { skip: canInstall }, () => inTemp(async (dir) => {
  const { server, base } = await release(["9.9.9"], { wrongChecksum: true });
  try {
    const r = await oneLine(base("9.9.9"), installEnv(dir));
    assert.notEqual(r.status, 0);
    assert.match(r.out, /not the published file/);
    assert.ok(!fs.existsSync(path.join(installRoot(dir), downloadName("9.9.9", here!))), "nothing unpacked");
    assert.ok(!fs.existsSync(command(dir, "mmv")), "no command put on the path");
    if (win) assert.equal(userVariable(testPathVariable), null, "the Path is not touched");
  } finally {
    if (win) removeUserVariable(testPathVariable);
    await server.close();
  }
}));

test("install.ps1 is plain ASCII with Windows line ends, asks for no administrator, and uses nothing newer than PowerShell 5.1", () => {
  const ps = installPs1({ version: "2.0.0", base: releaseBase("2.0.0"), downloads: [{ platform: "windows-x64", bytes: 36e6, sha256: "ab".repeat(32) }] })!;
  assert.match(ps, /^[\x00-\x7f]*$/, "ASCII only");
  assert.doesNotMatch(ps, /[^\r]\n/, "CRLF line ends");
  assert.match(ps, /irm https:\/\/github\.com\/BiodiverseLabs\/mycomap-validation\/releases\/download\/v2\.0\.0\/install\.ps1 \| iex/);
  assert.match(ps, /\$url = 'https:\/\/github\.com\/BiodiverseLabs\/mycomap-validation\/releases\/download\/v2\.0\.0\/mycomap-validation-2\.0\.0-windows-x64\.zip'/);
  assert.match(ps, new RegExp(`\\$sha256 = '${"ab".repeat(32)}'`));
  assert.doesNotMatch(ps, /RunAs|HKLM:|'Machine'|Set-ExecutionPolicy/, "no administrator, no machine-wide change");
  assert.doesNotMatch(ps, /\?\?|&&|\|\||\?\./, "no PowerShell 7 operators");
  assert.doesNotMatch(ps, /^\s*exit\b/m, "never exit: that would close the person's window");
  assert.equal(installPs1({ version: "2.0.0", base: "x/", downloads: [{ platform: "linux-x64", bytes: 1, sha256: "a" }] }), null, "no Windows build, no install.ps1");
});

test("install.sh knows each macOS and Linux build it was made with, and no other", () => {
  const sh = installSh({ version: "2.0.0", base: releaseBase("2.0.0"), downloads: [
    { platform: "macos-arm64", bytes: 40e6, sha256: "a".repeat(64) }, { platform: "linux-x64", bytes: 46e6, sha256: "b".repeat(64) }, { platform: "windows-x64", bytes: 1, sha256: "c".repeat(64) },
  ] })!;
  assert.match(sh, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(sh, /\r/);
  assert.match(sh, /Darwin-arm64\) name=mycomap-validation-2\.0\.0-macos-arm64; sha256=a{64};/);
  assert.match(sh, /Linux-x86_64\) name=mycomap-validation-2\.0\.0-linux-x64; sha256=b{64};/);
  assert.doesNotMatch(sh, /windows|Linux-aarch64|Darwin-x86_64/);
  assert.doesNotMatch(sh, /\bsudo (?!apt)/, "no administrator (sudo appears only in the advice to install unzip)");
  assert.equal(installSh({ version: "2.0.0", base: "x/", downloads: [{ platform: "windows-x64", bytes: 1, sha256: "a" }] }), null);
});
