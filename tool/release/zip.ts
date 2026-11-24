// Writes a .zip, the one kind of archive every computer opens with a
// double-click. Each file keeps its Unix permissions (stored as a Unix zip
// does), so the programs inside stay runnable when macOS's Archive Utility or
// Linux's unzip unpacks them; Windows ignores them.
import zlib from "node:zlib";

export interface ZipEntry {
  /** The path inside the archive, with forward slashes. */
  name: string;
  data: Buffer;
  /** Unix permissions: 0o755 for a program, 0o644 (the default) for anything else. */
  mode?: number;
}

/** The MS-DOS date and time a zip records (local time, to two seconds). */
function dosTime(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const MADE_BY_UNIX = (3 << 8) | 20;
const UTF8_NAMES = 1 << 11;

/** The archive's bytes. Names must be relative and must not climb out with "..". */
export function zipBytes(entries: ZipEntry[], modified: Date = new Date()): Buffer {
  const { time, day } = dosTime(modified);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.name || e.name.startsWith("/") || e.name.split("/").includes("..") || e.name.includes("\\")) throw new Error(`not a name a zip may hold: "${e.name}"`);
    if (seen.has(e.name)) throw new Error(`"${e.name}" is in the zip twice`);
    seen.add(e.name);
    const name = Buffer.from(e.name, "utf8");
    const packed = zlib.deflateRawSync(e.data, { level: 9 });
    const stored = packed.length >= e.data.length;
    const body = stored ? e.data : packed;
    const crc = zlib.crc32(e.data);
    if (body.length > 0xffffffff || e.data.length > 0xffffffff || offset > 0xffffffff) throw new Error(`${e.name} is too big for a zip without Zip64`);

    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(UTF8_NAMES, 6);
    head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(day, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(e.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(MADE_BY_UNIX, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(UTF8_NAMES, 8);
    dir.writeUInt16LE(stored ? 0 : 8, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(e.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    // Extra field, comment, disk number, internal attributes: none.
    dir.writeUInt32LE((((0o100000 | (e.mode ?? 0o644)) << 16) >>> 0), 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += head.length + name.length + body.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
