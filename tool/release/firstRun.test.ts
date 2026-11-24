// The release's first-run check judges a run rightly, and blocks the network
// with each system's own means. (The check itself runs in the release
// workflow, on a built download; see firstRun.ts.)
//   node --import tsx --test tool/release/firstRun.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blastPlatform } from "../blastPlus";
import { blockedCommand, cmdQuote, MACOS_NO_NETWORK, MYCOMAP_VERSION, NCBI_VERSION, resultProblems, versionOfDownload } from "./firstRun";
import { DOWNLOAD_PLATFORMS } from "./nodeRuntime";

/** results.json as a right first run writes it (the parts the check reads). */
function goodRun() {
  return {
    tool: "mycomap-validation", engineVersion: "2.0.0", blast: "blastn: 2.17.0+", blastSource: "installed by init",
    databases: { mycomap: { version: MYCOMAP_VERSION }, ncbi: { version: NCBI_VERSION } },
    sequences: [
      { id: "spec-1", ncbiHitCount: 1, result: { finalSpecies: "Russula emetica" } },
      { id: "spec-2", ncbiHitCount: 0, result: { finalSpecies: null } },
    ],
    records: [{ record: "spec-1", decision: "validate", species: "Russula emetica" }, { record: "spec-2", decision: "held", species: null }],
  };
}

test("a right first run has no problems", () => {
  assert.deepEqual(resultProblems(goodRun(), "2.0.0"), []);
});

test("each way a first run can go wrong is named", () => {
  const cases: Array<[string, (r: any) => void, RegExp]> = [
    ["another version", (r) => { r.engineVersion = "1.9.0"; }, /engine version is 1\.9\.0, not the download's 2\.0\.0/],
    ["BLAST+ from the PATH", (r) => { r.blastSource = "on the PATH"; }, /not the one init installed/],
    ["another BLAST+", (r) => { r.blast = "blastn: 2.12.0+"; }, /not 2\.17\.0/],
    ["GenBank not searched", (r) => { r.databases.ncbi = null; }, /GenBank's database is not searched/],
    ["GenBank with no hits", (r) => { r.sequences[0].ncbiHitCount = 0; }, /no GenBank hits/],
    ["the wrong name", (r) => { r.sequences[0].result.finalSpecies = "Russula nobilis"; }, /spec-1 was named Russula nobilis/],
    ["a name for nothing", (r) => { r.sequences[1].result.finalSpecies = "Hypomyces chrysospermus"; }, /spec-2 \(matching nothing\) was named/],
    ["a held record", (r) => { r.records[0].decision = "held"; }, /spec-1's record was held/],
    ["no records", (r) => { r.records = []; }, /spec-1's record was missing/],
  ];
  for (const [what, spoil, problem] of cases) {
    const run = goodRun();
    spoil(run);
    const problems = resultProblems(run, "2.0.0");
    assert.equal(problems.length, 1, `${what}: ${problems.join("; ")}`);
    assert.match(problems[0], problem, what);
  }
  assert.ok(resultProblems({}, "2.0.0").length >= 5, "an empty results.json fails");
});

test("the network is blocked by the system: no network at all on Linux, the sandbox on macOS", () => {
  assert.deepEqual(blockedCommand("linux", ["/dl/mycomap-validation", "run", "a b.fasta"], "runner"),
    ["sudo", "-n", "unshare", "--net", "--", "sudo", "-n", "-u", "runner", "--", "/dl/mycomap-validation", "run", "a b.fasta"]);
  assert.deepEqual(blockedCommand("darwin", ["/dl/mmv", "run"], "runner"), ["sandbox-exec", "-p", MACOS_NO_NETWORK, "/dl/mmv", "run"]);
  assert.match(MACOS_NO_NETWORK, /\(deny network\*\)/);
  assert.throws(() => blockedCommand("win32", ["x"], "runner"), /firewall|Linux and macOS/);
});

test("arguments for cmd.exe are quoted when they hold a space or a sign cmd.exe would read", () => {
  assert.equal(cmdQuote("C:\\dl\\mycomap-validation.cmd"), "C:\\dl\\mycomap-validation.cmd");
  assert.equal(cmdQuote("my sequences.fasta"), '"my sequences.fasta"');
  assert.equal(cmdQuote("a&b"), '"a&b"');
  assert.equal(cmdQuote('say "hi"'), '"say ""hi"""');
});

test("the version is read from the unzipped download's folder name", () => {
  assert.equal(versionOfDownload("/tmp/x/mycomap-validation-2.0.0-beta.12-macos-arm64"), "2.0.0-beta.12");
  assert.equal(versionOfDownload("C:\\dl\\mycomap-validation-2.0.0-windows-x64"), "2.0.0");
  assert.throws(() => versionOfDownload("/tmp/somewhere-else"), /not an unzipped download/);
});

/** The release workflow: at the repository's root once published, in mycomap.org's template before. */
function releaseWorkflow(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, "../../.github/workflows/release.yml"), path.join(here, "../../../../scripts/validation-repo-template/.github/workflows/release.yml")]) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  }
  throw new Error("release.yml not found");
}

test("every download the release builds is tried on its own kind of computer, with NCBI's BLAST+ for that computer", () => {
  const runs = [...releaseWorkflow().matchAll(/\{\s*os:\s*([\w.-]+),\s*download:\s*([\w-]+),\s*blast:\s*([\w-]+)\s*\}/g)].map((m) => ({ os: m[1], download: m[2], blast: m[3] }));
  assert.deepEqual(runs.map((r) => r.download).sort(), [...DOWNLOAD_PLATFORMS].sort(), "one first run for each download, and none for a download not built");
  const computer: Record<string, [NodeJS.Platform, string]> = {
    "windows-x64": ["win32", "x64"], "macos-arm64": ["darwin", "arm64"], "macos-x64": ["darwin", "x64"], "linux-x64": ["linux", "x64"], "linux-arm64": ["linux", "arm64"],
  };
  for (const r of runs) {
    const [platform, arch] = computer[r.download];
    assert.equal(r.blast, blastPlatform(platform, arch), `${r.download} gets the BLAST+ init would install there`);
    const runner = /^windows-/.test(r.os) ? "win32" : /^macos-/.test(r.os) ? "darwin" : /^ubuntu-/.test(r.os) ? "linux" : null;
    assert.equal(runner, platform, `${r.download} runs on ${r.os}`);
    // GitHub's runner labels: an Intel Mac says -intel, a Linux ARM machine says -arm; the plain labels are Apple silicon and x64.
    const runnerArch = /-intel$/.test(r.os) ? "x64" : /-arm$/.test(r.os) ? "arm64" : runner === "darwin" ? "arm64" : "x64";
    assert.equal(runnerArch, arch, `${r.download} runs on a ${arch} machine (${r.os})`);
  }
});
