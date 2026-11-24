// `pnpm downloads`: builds the tool people download, one .zip for each kind
// of computer. Each holds the tool as one script (every module, the browser
// page and the version, bundled with esbuild), Node.js from nodejs.org to run
// it, and the `mycomap-validation` and `mmv` commands, so nothing else needs
// installing.
//
//   pnpm downloads                                this computer's
//   pnpm downloads --platform all                 all five (the release workflow)
//   pnpm downloads --platform macos-arm64,linux-x64 --out <folder>
//   pnpm downloads --release-base <address/>     where the installers fetch the zips
//
// Writes <out>/mycomap-validation-<version>-<platform>.zip, the one-line
// installers install.ps1 (Windows) and install.sh (macOS, Linux) for the zips
// built (installers.ts), and SHA256SUMS.txt
// (default out: dist/downloads). Node.js is downloaded once, checked against
// its pinned checksum, and kept in <out>/.node-cache.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { unpackTarGz } from "../archive";
import type { Bundled } from "../bundled";
import { downloadFile, type Fetch } from "../download";
import { BUNDLE_FILE, cmdLauncher, COMMAND_NAMES, downloadName, readmeText, shLauncher } from "./launchers";
import { DOWNLOAD_PLATFORMS, downloadPlatform, isWindows, NODE_LICENSE, nodeBuild, PINNED_NODE, type DownloadPlatform } from "./nodeRuntime";
import { installPs1, installSh, releaseBase, type BuiltDownload } from "./installers";
import { zipBytes, type ZipEntry } from "./zip";

/** lib/validation-engine here; the repository itself once exported. */
export const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** What the bundle carries: the version, and the page's files (index.html, app.js, …). */
export function bundledData(engineRoot: string = ENGINE_ROOT): Bundled {
  const version = JSON.parse(fs.readFileSync(path.join(engineRoot, "package.json"), "utf8")).version;
  if (typeof version !== "string" || !version) throw new Error(`${engineRoot}/package.json has no version`);
  const ui = path.join(engineRoot, "tool", "ui");
  const page = Object.fromEntries(fs.readdirSync(ui).filter((f) => /\.(html|js|css)$/.test(f)).sort().map((f) => [f, fs.readFileSync(path.join(ui, f), "utf8")]));
  if (!page["index.html"]) throw new Error(`${ui} has no index.html`);
  return { version, page };
}

/** Puts the data in place of tool/bundled.ts's null. */
function bundledPlugin(data: Bundled): Plugin {
  return {
    name: "mycomap-validation-bundled",
    setup(b) {
      b.onLoad({ filter: /[\\/]tool[\\/]bundled\.ts$/ }, () => ({
        contents: `export const bundled = ${JSON.stringify(data)};\n`,
        loader: "ts",
      }));
    },
  };
}

/** The tool as one script for Node.js: every module, the page and the version. */
export async function bundleTool(engineRoot: string = ENGINE_ROOT): Promise<{ text: string; version: string }> {
  const data = bundledData(engineRoot);
  const result = await build({
    entryPoints: [path.join(engineRoot, "tool", "release", "main.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    logLevel: "silent",
    plugins: [bundledPlugin(data)],
    banner: { js: `// MycoMap Validation ${data.version}, the whole tool in one file (built by tool/release/build.ts).\n// The source, and its licence: https://github.com/BiodiverseLabs/mycomap-validation` },
  });
  const text = result.outputFiles[0].text;
  return { text, version: data.version };
}

/** The repository's LICENSE and THIRD_PARTY_NOTICES.md: at its root once exported, in the template here. */
export function noticeFiles(engineRoot: string = ENGINE_ROOT): { license: string; notices: string } {
  const places = [engineRoot, path.join(engineRoot, "..", "..", "scripts", "validation-repo-template")];
  const folder = places.find((p) => fs.existsSync(path.join(p, "LICENSE")) && fs.existsSync(path.join(p, "THIRD_PARTY_NOTICES.md")));
  if (!folder) throw new Error(`No LICENSE and THIRD_PARTY_NOTICES.md in ${places.join(" or ")}`);
  const read = (f: string) => fs.readFileSync(path.join(folder, f), "utf8").replace(/\r\n/g, "\n");
  return { license: read("LICENSE"), notices: read("THIRD_PARTY_NOTICES.md") };
}

export interface DownloadParts {
  version: string;
  platform: DownloadPlatform;
  bundle: string;
  /** The node (or node.exe) program. */
  node: Buffer;
  nodeLicense: Buffer;
  license: string;
  notices: string;
}

/** What goes in a download's .zip, inside one folder named after it. */
export function downloadEntries(parts: DownloadParts): ZipEntry[] {
  const top = downloadName(parts.version, parts.platform);
  const win = isWindows(parts.platform);
  const text = (s: string) => Buffer.from(win ? s.replace(/\r?\n/g, "\r\n") : s, "utf8");
  const launcher = win ? cmdLauncher(parts.version) : shLauncher(parts.version);
  return [
    ...COMMAND_NAMES.map((name) => ({ name: `${top}/${name}${win ? ".cmd" : ""}`, data: Buffer.from(launcher, "utf8"), mode: 0o755 })),
    { name: `${top}/README.txt`, data: Buffer.from(readmeText(parts.version, parts.platform), "utf8") },
    { name: `${top}/LICENSE.txt`, data: text(parts.license) },
    { name: `${top}/THIRD_PARTY_NOTICES.md`, data: text(parts.notices) },
    { name: `${top}/lib/${win ? "node.exe" : "node"}`, data: parts.node, mode: 0o755 },
    { name: `${top}/lib/${BUNDLE_FILE}`, data: Buffer.from(parts.bundle, "utf8") },
    { name: `${top}/lib/NODE_LICENSE.txt`, data: parts.nodeLicense },
  ];
}

/** Node.js for a platform, from the cache or nodejs.org; checked against its pinned checksum either way. */
export async function nodeProgram(platform: DownloadPlatform, cache: string, opts: { fetch?: Fetch; say?: (line: string) => void } = {}): Promise<Buffer> {
  const b = nodeBuild(platform);
  const program = path.join(cache, `${platform}-${PINNED_NODE}`, b.entry ? "node" : "node.exe");
  const archive = path.join(cache, b.fileName);
  if (!fs.existsSync(program)) {
    opts.say?.(`Downloading Node.js ${PINNED_NODE} for ${platform}…`);
    // downloadFile checks the size and SHA-256; a file already there is checked again.
    await downloadFile(b.url, archive, b, { fetch: opts.fetch, what: `Node.js ${PINNED_NODE} for ${platform}` });
    if (b.entry) {
      const entry = b.entry;
      const files = await unpackTarGz(archive, path.dirname(program), (name) => (name === entry ? "node" : null));
      if (files.length !== 1) throw new Error(`${b.fileName} has no ${entry}`);
      fs.rmSync(archive);
    } else {
      fs.mkdirSync(path.dirname(program), { recursive: true });
      fs.renameSync(archive, program);
    }
  }
  return fs.readFileSync(program);
}

async function nodeLicense(cache: string, fetch?: Fetch): Promise<Buffer> {
  const file = path.join(cache, `NODE_LICENSE-${PINNED_NODE}.txt`);
  if (!fs.existsSync(file)) await downloadFile(NODE_LICENSE.url, file, NODE_LICENSE, { fetch, what: "Node.js's licence" });
  return fs.readFileSync(file);
}

export function parsePlatforms(value: string | null): DownloadPlatform[] {
  if (!value || value === "this") {
    const mine = downloadPlatform();
    if (!mine) throw new Error(`There is no download for this computer (${process.platform} ${process.arch}); name one with --platform`);
    return [mine];
  }
  if (value === "all") return [...DOWNLOAD_PLATFORMS];
  const asked = value.split(",").map((p) => p.trim()).filter(Boolean);
  for (const p of asked) if (!(DOWNLOAD_PLATFORMS as readonly string[]).includes(p)) throw new Error(`--platform takes "all", "this" or some of ${DOWNLOAD_PLATFORMS.join(", ")}, not "${p}"`);
  return asked as DownloadPlatform[];
}

export interface BuildOptions {
  platforms: DownloadPlatform[];
  out: string;
  cache?: string;
  engineRoot?: string;
  fetch?: Fetch;
  say?: (line: string) => void;
  /** The time stamped on the zip's files. */
  modified?: Date;
  /** Where the installers download the zips from (default: the tag's GitHub release). */
  releaseBase?: string;
}

/** Builds the downloads; returns each .zip's path. */
export async function buildDownloads(opts: BuildOptions): Promise<string[]> {
  const say = opts.say ?? (() => undefined);
  const cache = opts.cache ?? path.join(opts.out, ".node-cache");
  const { text: bundle, version } = await bundleTool(opts.engineRoot);
  const { license, notices } = noticeFiles(opts.engineRoot);
  const licenseOfNode = await nodeLicense(cache, opts.fetch);
  fs.mkdirSync(opts.out, { recursive: true });
  const written: string[] = [];
  const built: BuiltDownload[] = [];
  for (const platform of opts.platforms) {
    const node = await nodeProgram(platform, cache, { fetch: opts.fetch, say });
    const zip = path.join(opts.out, `${downloadName(version, platform)}.zip`);
    fs.writeFileSync(zip, zipBytes(downloadEntries({ version, platform, bundle, node, nodeLicense: licenseOfNode, license, notices }), opts.modified));
    say(`Wrote ${zip} (${Math.round(fs.statSync(zip).size / 1e6)} MB)`);
    written.push(zip);
    built.push({ platform, bytes: fs.statSync(zip).size, sha256: crypto.createHash("sha256").update(fs.readFileSync(zip)).digest("hex") });
  }
  const installers = { version, base: opts.releaseBase ?? releaseBase(version), downloads: built };
  for (const [file, text] of [["install.ps1", installPs1(installers)], ["install.sh", installSh(installers)]] as const) {
    if (!text) continue;
    fs.writeFileSync(path.join(opts.out, file), text);
    say(`Wrote ${path.join(opts.out, file)}`);
    written.push(path.join(opts.out, file));
  }
  const sums = written.map((z) => `${crypto.createHash("sha256").update(fs.readFileSync(z)).digest("hex")}  ${path.basename(z)}`);
  fs.writeFileSync(path.join(opts.out, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
  return written;
}

function option(argv: string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith("--") ? argv[at + 1] : null;
}

const invoked = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const argv = process.argv.slice(2);
  const from = (p: string) => path.resolve(process.env.INIT_CWD || process.cwd(), p);
  buildDownloads({
    platforms: parsePlatforms(option(argv, "platform")),
    out: from(option(argv, "out") ?? path.join(ENGINE_ROOT, "dist", "downloads")),
    cache: option(argv, "cache") ? from(option(argv, "cache")!) : undefined,
    releaseBase: option(argv, "release-base") ?? undefined,
    say: console.log,
  }).then(() => undefined, (error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}
