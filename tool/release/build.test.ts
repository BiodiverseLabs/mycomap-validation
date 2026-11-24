// The downloadable build: the tool as one script needs nothing beside it
// (the version and the browser page are inside), and each .zip holds the
// commands, Node.js and the notices, with the programs runnable.
//   node --import tsx --test tool/release/build.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { bundleTool, downloadEntries, ENGINE_ROOT, nodeProgram, noticeFiles, parsePlatforms } from "./build";
import { DOWNLOAD_PLATFORMS, downloadPlatform, nodeBuild, PINNED_NODE } from "./nodeRuntime";

const version = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, "package.json"), "utf8")).version;

let bundled: Promise<string> | null = null;
/** The bundle, written alone in a folder of its own: no package.json, no page files beside it. */
function bundleAlone(): Promise<string> {
  bundled ??= bundleTool().then(({ text }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmv-bundle-"));
    fs.mkdirSync(path.join(dir, "lib"));
    const file = path.join(dir, "lib", "mycomap-validation.mjs");
    fs.writeFileSync(file, text);
    process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
    return file;
  });
  return bundled;
}

test("the bundled tool knows its version with no package.json beside it, and runs a command once", async () => {
  const file = await bundleAlone();
  const r = spawnSync(process.execPath, [file, "--version"], { encoding: "utf8", cwd: path.dirname(file) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `mycomap-validation ${version}\n`, "printed once: the source's own start-up does not run as well");
  const help = spawnSync(process.execPath, [file, "help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^MycoMap Validation: names fungal DNA sequences/);
  assert.equal(spawnSync(process.execPath, [file, "nonsense"], { encoding: "utf8" }).status, 2, "the exit code comes through");
});

test("the bundled tool's browser app serves its page from inside the one file", async () => {
  const file = await bundleAlone();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "mmv-ui-data-"));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [file, "ui", "--no-open", "--port", String(port), "--data", data]);
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let said = "";
      const timer = setTimeout(() => reject(new Error(`ui did not start: ${said}`)), 20000);
      child.stdout.on("data", (d) => { said += d; const m = /is open at (\S+)/.exec(said); if (m) { clearTimeout(timer); resolve(m[1]); } });
      child.stderr.on("data", (d) => { said += d; });
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`ui stopped (${code}): ${said}`)); });
    });
    const page = await (await fetch(url)).text();
    assert.match(page, new RegExp(version.replace(/\./g, "\\.")), "the page shows the version");
    assert.doesNotMatch(page, /\{\{(KEY|VERSION)\}\}/, "the page is filled in");
    for (const f of ["app.js", "view.js", "style.css"]) {
      const res = await fetch(new URL(`/${f}`, url));
      assert.equal(res.status, 200, f);
      assert.equal(await res.text(), fs.readFileSync(path.join(ENGINE_ROOT, "tool", "ui", f), "utf8"), `${f} is the page's own`);
    }
  } finally {
    child.kill();
    fs.rmSync(data, { recursive: true, force: true });
  }
});

const parts = (platform: (typeof DOWNLOAD_PLATFORMS)[number]) => ({
  version: "2.0.0", platform, bundle: "// the tool", node: Buffer.from("NODE"), nodeLicense: Buffer.from("Node's licence"),
  license: "MIT License\n\nline two\n", notices: "# Third-party notices\n",
});

test("a download holds both commands, README, the notices, Node.js and the tool, in one folder named after it", () => {
  const mac = downloadEntries(parts("macos-arm64"));
  assert.deepEqual(mac.map((e) => [e.name, (e.mode ?? 0o644).toString(8)]), [
    ["mycomap-validation-2.0.0-macos-arm64/mycomap-validation", "755"],
    ["mycomap-validation-2.0.0-macos-arm64/mmv", "755"],
    ["mycomap-validation-2.0.0-macos-arm64/README.txt", "644"],
    ["mycomap-validation-2.0.0-macos-arm64/LICENSE.txt", "644"],
    ["mycomap-validation-2.0.0-macos-arm64/THIRD_PARTY_NOTICES.md", "644"],
    ["mycomap-validation-2.0.0-macos-arm64/lib/node", "755"],
    ["mycomap-validation-2.0.0-macos-arm64/lib/mycomap-validation.mjs", "644"],
    ["mycomap-validation-2.0.0-macos-arm64/lib/NODE_LICENSE.txt", "644"],
  ]);
  assert.match(mac[0].data.toString(), /^#!\/bin\/sh/);
  const win = downloadEntries(parts("windows-x64"));
  assert.deepEqual(win.map((e) => e.name.split("/").slice(1).join("/")), ["mycomap-validation.cmd", "mmv.cmd", "README.txt", "LICENSE.txt", "THIRD_PARTY_NOTICES.md", "lib/node.exe", "lib/mycomap-validation.mjs", "lib/NODE_LICENSE.txt"]);
  assert.match(win[0].data.toString(), /^@echo off\r\n/);
  assert.equal(win[3].data.toString(), "MIT License\r\n\r\nline two\r\n", "Notepad-friendly line ends on Windows");
});

test("the notices are the repository's own (the template's, here)", () => {
  const { license, notices } = noticeFiles();
  assert.match(license, /^MIT License/);
  assert.match(notices, /BLAST\+/);
});

test("Node.js is pinned for each download, from nodejs.org", () => {
  for (const p of DOWNLOAD_PLATFORMS) {
    const b = nodeBuild(p);
    assert.match(b.url, new RegExp(`^https://nodejs\\.org/dist/v${PINNED_NODE.replace(/\./g, "\\.")}/`), p);
    assert.match(b.sha256, /^[0-9a-f]{64}$/, p);
    assert.ok(b.bytes > 30e6, p);
  }
  assert.equal(nodeBuild("windows-x64").entry, null, "Windows: node.exe itself");
  assert.equal(nodeBuild("linux-arm64").entry, `node-v${PINNED_NODE}-linux-arm64/bin/node`);
  assert.equal(downloadPlatform("win32", "arm64"), "windows-x64", "Windows on ARM runs the x64 download");
  assert.equal(downloadPlatform("darwin", "arm64"), "macos-arm64");
  assert.equal(downloadPlatform("freebsd", "x64"), null);
  assert.deepEqual(parsePlatforms("all"), [...DOWNLOAD_PLATFORMS]);
  assert.deepEqual(parsePlatforms("linux-x64,macos-x64"), ["linux-x64", "macos-x64"]);
  assert.throws(() => parsePlatforms("linux-x86"), /--platform takes/);
});

test("a Node.js download that is not the pinned file is refused and not kept", async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "mmv-node-cache-"));
  try {
    const fake = (async () => new Response("not node at all", { status: 200 })) as typeof fetch;
    await assert.rejects(nodeProgram("linux-x64", cache, { fetch: fake }), /is not the published file/);
    assert.deepEqual(fs.readdirSync(cache), [], "nothing is kept");
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});
