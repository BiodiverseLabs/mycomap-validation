// Unpacks a .tar.gz as a stream, so a 1 GB database never sits in memory.
// Written here rather than calling the system's tar, which differs between
// Windows, macOS and Linux (and BLAST's own archives are plain tar).
//
// Reads ustar and GNU tar: regular files, folders, GNU long names and pax
// path records. Links and devices are skipped. A path that would land outside
// the target folder (an absolute path, or one that climbs out with "..") is
// refused, and nothing more is unpacked.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { once } from "node:events";

export interface UnpackedFile {
  /** The path inside the archive, with forward slashes. */
  name: string;
  /** Where it was written. */
  path: string;
  bytes: number;
}

export class ArchiveError extends Error {}

/**
 * Chooses what to unpack and where: return the path to write the entry to
 * (relative to the target folder, with forward slashes), or null to skip it.
 * By default every file keeps its own path.
 */
export type EntryChoice = (name: string) => string | null;

function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString("utf8");
}

function octal(block: Buffer, start: number, length: number): number {
  const raw = block.subarray(start, start + length);
  // GNU base-256 for sizes over 8 GB.
  if (raw[0] & 0x80) {
    let n = 0;
    for (let i = 1; i < raw.length; i++) n = n * 256 + raw[i];
    return n;
  }
  const text = field(block, start, length).trim();
  return text ? parseInt(text, 8) : 0;
}

function isZeroBlock(block: Buffer): boolean {
  for (const b of block) if (b !== 0) return false;
  return true;
}

/** The pax record's path, if it has one ("27 path=some/long/name\n"). */
function paxPath(body: Buffer): string | null {
  let at = 0;
  const text = body.toString("utf8");
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    if (space < 0) break;
    const length = Number(text.slice(at, space));
    if (!length) break;
    const record = text.slice(space + 1, at + length - 1);
    const eq = record.indexOf("=");
    if (record.slice(0, eq) === "path") return record.slice(eq + 1);
    at += length;
  }
  return null;
}

/** Where an entry would be written, or an ArchiveError when it would land outside the folder. */
export function safeTarget(folder: string, relative: string): string {
  const clean = relative.replace(/\\/g, "/");
  if (clean.startsWith("/") || /^[A-Za-z]:/.test(clean) || clean.split("/").includes("..")) {
    throw new ArchiveError(`The archive holds "${relative}", a path outside the folder it is unpacked into. It was not unpacked: download it again from the Data Downloads page.`);
  }
  const target = path.resolve(folder, clean);
  const root = path.resolve(folder);
  if (target !== root && !target.startsWith(root + path.sep)) throw new ArchiveError(`The archive holds "${relative}", a path outside the folder it is unpacked into.`);
  return target;
}

interface Entry {
  name: string;
  type: string;
  left: number;
  padding: number;
  out: fs.WriteStream | null;
  collect: Buffer[] | null;
  record: UnpackedFile | null;
}

/** Unpacks a .tar.gz (or a plain .tar) into the folder. */
export async function unpackTarGz(archive: string, folder: string, choose: EntryChoice = (name) => name): Promise<UnpackedFile[]> {
  fs.mkdirSync(folder, { recursive: true });
  const source = fs.createReadStream(archive);
  const stream = /\.t?gz$/i.test(archive) ? source.pipe(zlib.createGunzip()) : source;
  const written: UnpackedFile[] = [];
  let pending: Buffer = Buffer.alloc(0);
  // The entry being read: its header is done, `left` bytes of its body are still to come.
  // (Cast, so the compiler does not take it as always null: the helpers below set it.)
  let entry = null as Entry | null;
  let nextName: string | null = null;
  let ended = false;

  const finishEntry = async () => {
    if (!entry) return;
    if (entry.out) {
      // "close", not "finish": Windows will not rename a folder while a file in it is still open.
      entry.out.end();
      if (!entry.out.closed) await once(entry.out, "close");
    }
    if (entry.collect) {
      const body = Buffer.concat(entry.collect);
      if (entry.type === "L") nextName = field(body, 0, body.length);
      else if (entry.type === "x") nextName = paxPath(body) ?? nextName;
    }
    if (entry.record) written.push(entry.record);
    entry = null;
  };

  const startEntry = (header: Buffer) => {
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = header.subarray(257, 263).toString("latin1").startsWith("ustar") ? field(header, 345, 155) : "";
    let name = nextName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    if (type !== "L" && type !== "x" && type !== "g") nextName = null;
    name = name.replace(/^\.\//, "");
    const base: Entry = { name, type, left: size, padding: (512 - (size % 512)) % 512, out: null, collect: null, record: null };
    if (type === "L" || type === "x") base.collect = [];
    else if ((type === "0" || type === "7") && name && !name.endsWith("/")) {
      const chosen = choose(name);
      if (chosen !== null) {
        const target = safeTarget(folder, chosen);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        base.out = fs.createWriteStream(target);
        base.record = { name, path: target, bytes: size };
      }
    } else if (type === "5") {
      // Folders are made as their files need them.
    }
    entry = base;
  };

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let at = 0;
      while (!ended) {
        if (entry) {
          if (entry.left > 0) {
            const take = Math.min(entry.left, pending.length - at);
            if (take === 0) break;
            const piece = pending.subarray(at, at + take);
            if (entry.out && !entry.out.write(piece)) await once(entry.out, "drain");
            if (entry.collect) entry.collect.push(Buffer.from(piece));
            entry.left -= take;
            at += take;
            if (entry.left > 0) break;
          }
          if (entry.padding > 0) {
            const skip = Math.min(entry.padding, pending.length - at);
            entry.padding -= skip;
            at += skip;
            if (entry.padding > 0) break;
          }
          await finishEntry();
          continue;
        }
        if (pending.length - at < 512) break;
        const header = pending.subarray(at, at + 512);
        at += 512;
        if (isZeroBlock(header)) { ended = true; break; }
        startEntry(Buffer.from(header));
      }
      pending = pending.subarray(at);
      if (ended) break;
    }
  } catch (error) {
    await abandon(entry);
    source.destroy();
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError(`${path.basename(archive)} could not be unpacked (${(error as Error).message}). The file may be cut short: download it again.`);
  }
  if (entry && (entry.left > 0 || entry.out)) {
    await abandon(entry);
    throw new ArchiveError(`${path.basename(archive)} ends in the middle of a file. It may be cut short: download it again.`);
  }
  source.destroy();
  return written;
}

/**
 * Gives up on the file being written: lets its queued writes finish, then
 * removes the part written. Destroying the stream at once would make a write
 * still queued fail later as an uncaught error.
 */
async function abandon(entry: Entry | null): Promise<void> {
  const out = entry?.out;
  if (!out) return;
  if (!out.closed) {
    await new Promise<void>((resolve) => {
      out.once("close", () => resolve());
      out.once("error", () => resolve());
      out.end();
    });
  }
  if (entry.record) fs.rmSync(entry.record.path, { force: true });
}
