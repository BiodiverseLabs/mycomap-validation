// The commands a download gives people: they run the tool with the Node.js
// beside them, hand over every argument as typed, keep the folder the person
// is in, and pass the tool's exit code back. Tried with this computer's own
// launcher (the .cmd on Windows, the shell script elsewhere) in front of a
// stand-in for the tool.
//   node --import tsx --test tool/release/launchers.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cmdQuote } from "./firstRun";
import { BUNDLE_FILE, cmdLauncher, readmeText, shLauncher } from "./launchers";

const win = process.platform === "win32";

/** A download folder whose "tool" prints what it was given, and exits 7 when asked to fail. */
function fakeDownload(dir: string): string {
  const top = path.join(dir, "mycomap-validation-9.9.9-test");
  fs.mkdirSync(path.join(top, "lib"), { recursive: true });
  const node = path.join(top, "lib", win ? "node.exe" : "node");
  try { fs.linkSync(process.execPath, node); } catch { fs.copyFileSync(process.execPath, node); }
  fs.writeFileSync(path.join(top, "lib", BUNDLE_FILE), `console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), initCwd: process.env.INIT_CWD ?? null, script: process.argv[1] }));
if (process.argv.includes("fail")) process.exitCode = 7;\n`);
  for (const name of ["mycomap-validation", "mmv"]) {
    const file = path.join(top, win ? `${name}.cmd` : name);
    fs.writeFileSync(file, win ? cmdLauncher("9.9.9") : shLauncher("9.9.9"));
    fs.chmodSync(file, 0o755);
  }
  return top;
}

function launch(file: string, args: string[], cwd: string) {
  const env = { ...process.env, INIT_CWD: "/somewhere/pnpm/was" };
  const r = win
    ? spawnSync([file, ...args].map(cmdQuote).join(" "), { shell: true, cwd, env, encoding: "utf8" })
    : spawnSync(file, args, { cwd, env, encoding: "utf8" });
  return { status: r.status, said: r.stdout.trim() ? JSON.parse(r.stdout.trim().split(/\r?\n/).pop()!) : null, stderr: r.stderr };
}

function inTemp(fn: (dir: string) => void) {
  // A space in the folder name, as in a home folder named "Jane Doe".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmv launch "));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("both commands run the tool with the Node.js beside them, with every argument as typed, from the folder the person is in", () => inTemp((dir) => {
  const top = fakeDownload(dir);
  const here = path.join(dir, "my work");
  fs.mkdirSync(here);
  const args = ["run", "my sequences.fasta", "--out", "results & more", "ünïcode.fasta"];
  for (const name of ["mycomap-validation", "mmv"]) {
    const r = launch(path.join(top, win ? `${name}.cmd` : name), args, here);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.said.args, args, `${name}: the arguments`);
    assert.equal(fs.realpathSync(r.said.cwd), fs.realpathSync(here), `${name}: the folder the person is in`);
    assert.equal(r.said.initCwd, null, `${name}: pnpm's INIT_CWD is not passed on`);
    assert.equal(fs.realpathSync(r.said.script), fs.realpathSync(path.join(top, "lib", BUNDLE_FILE)), `${name}: the tool beside it`);
  }
}));

test("the tool's exit code comes back from the command", () => inTemp((dir) => {
  const top = fakeDownload(dir);
  assert.equal(launch(path.join(top, win ? "mycomap-validation.cmd" : "mycomap-validation"), ["fail"], dir).status, 7);
}));

test("on macOS and Linux the command works through a link from another folder, as from one on the PATH", { skip: win ? "Windows has no shell launcher" : false }, () => inTemp((dir) => {
  const top = fakeDownload(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(top, "mmv"), path.join(bin, "mmv"));
  // A link to a link, relative this time.
  fs.symlinkSync("mmv", path.join(bin, "mmv2"));
  for (const link of ["mmv", "mmv2"]) {
    const r = launch(path.join(bin, link), ["--version"], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.realpathSync(r.said.script), fs.realpathSync(path.join(top, "lib", BUNDLE_FILE)), link);
  }
}));

test("the Windows command has the line ends cmd.exe needs, and the shell script has none of those", () => {
  assert.match(cmdLauncher("1.0.0"), /^@echo off\r\n(?:[^\n]*\r\n)+$/);
  assert.doesNotMatch(shLauncher("1.0.0"), /\r/);
  assert.match(shLauncher("1.0.0"), /^#!\/bin\/sh\n/);
});

test("README.txt gives the first run in the words of each system", () => {
  const w = readmeText("2.0.0", "windows-x64");
  assert.match(w, /\.\\mycomap-validation init\r\n/);
  assert.match(w, /\.\\mycomap-validation run my-sequences\.fasta/);
  assert.match(w, /Open in Terminal/);
  assert.doesNotMatch(w, /[^\r]\n/, "Windows line ends throughout");
  const m = readmeText("2.0.0", "macos-arm64");
  assert.match(m, /\.\/mycomap-validation init\n/);
  assert.match(m, /Open Anyway/, "macOS: how to open it when the system warns");
  assert.match(m, /xattr -dr com\.apple\.quarantine \./);
  assert.doesNotMatch(readmeText("2.0.0", "linux-x64"), /Open Anyway|xattr/);
  for (const r of [w, m]) assert.match(r, /mmv is a short name/);
});
