// Downloads a file to disk with its checksum checked, picking up where a
// broken download stopped: the bytes so far are kept in "<file>.part", and
// the next try asks the server only for the rest (an HTTP Range request).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { InputError } from "./fasta";

export interface Expected {
  bytes: number;
  /** SHA-256 in hex; null when the source gives none (the download is then only size-checked). */
  sha256: string | null;
  /** MD5 in hex, for a source that gives only that. */
  md5?: string | null;
}

export type Fetch = typeof fetch;

/** The SHA-256 (and MD5) of a file on disk, read as a stream. */
export async function fileDigests(file: string): Promise<{ sha256: string; md5: string; bytes: number }> {
  const sha = crypto.createHash("sha256");
  const md5 = crypto.createHash("md5");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file) as AsyncIterable<Buffer>) {
    sha.update(chunk);
    md5.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: sha.digest("hex"), md5: md5.digest("hex"), bytes };
}

/** Whether a file on disk is the one expected; the reason when it is not. */
export async function checkFile(file: string, expected: Expected): Promise<string | null> {
  const got = await fileDigests(file);
  if (got.bytes !== expected.bytes) return `it is ${got.bytes.toLocaleString("en-US")} bytes, not ${expected.bytes.toLocaleString("en-US")}`;
  if (expected.sha256 && got.sha256 !== expected.sha256.toLowerCase()) return "its SHA-256 checksum is not the published one";
  if (expected.md5 && got.md5 !== expected.md5.toLowerCase()) return "its MD5 checksum is not the published one";
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} bytes`;
}

/**
 * Downloads `url` to `dest`, resuming a `.part` file from an earlier try, and
 * checks it. Throws an InputError in plain words when the download fails or
 * the file is not the published one (the bad copy is removed, so the next try
 * starts again).
 */
export async function downloadFile(url: string, dest: string, expected: Expected, opts: { fetch?: Fetch; progress?: (done: number, total: number) => void; what?: string } = {}): Promise<void> {
  const what = opts.what ?? path.basename(dest);
  const doFetch = opts.fetch ?? fetch;
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (have > expected.bytes) { fs.rmSync(part); have = 0; }
  if (have < expected.bytes) {
    let response: Response;
    try {
      response = await doFetch(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, redirect: "follow" });
    } catch (error) {
      throw new InputError(`Could not download ${what}: ${(error as Error).message}. Check the internet connection and run the same command again; it carries on where it stopped.`);
    }
    if (response.status === 200 && have > 0) have = 0; // the server sent the whole file again
    else if (response.status !== 200 && response.status !== 206) {
      throw new InputError(`Could not download ${what}: the server answered ${response.status}${response.statusText ? ` ${response.statusText}` : ""}. Try again later.`);
    }
    if (!response.body) throw new InputError(`Could not download ${what}: the server sent nothing.`);
    const out = fs.createWriteStream(part, { flags: have > 0 ? "a" : "w" });
    let done = have;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
        done += chunk.length;
        opts.progress?.(done, expected.bytes);
      }
    } catch (error) {
      await new Promise((r) => out.end(r));
      throw new InputError(`The download of ${what} stopped part-way (${formatBytes(done)} of ${formatBytes(expected.bytes)}): ${(error as Error).message}. Run the same command again; it carries on where it stopped.`);
    }
    await new Promise((r) => out.end(r));
  }
  const problem = await checkFile(part, expected);
  if (problem) {
    fs.rmSync(part, { force: true });
    throw new InputError(`The downloaded ${what} is not the published file: ${problem}. It has been removed; run the same command again to download it afresh.`);
  }
  fs.renameSync(part, dest);
}
