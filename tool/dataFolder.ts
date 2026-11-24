// Finds the downloaded databases in the data folder. Each file comes from
// https://mycomap.org/data-downloads; unpack them anywhere under the folder
// (`init` will do this for you once it exists):
//
//   mycomap_blastdb_<date>.tar.gz       → mycomap.n*   (MycoMap's sequences)
//   mycomap_sequences_<date>.tsv.gz     → kept as it is (the names table)
//   ncbi-its-blastdb-<date>.tar.gz      → genbank_its.n*, refseq_its.n* (optional)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InputError } from "./fasta";

export const DOWNLOADS_PAGE = "https://mycomap.org/data-downloads";
const LATEST = "https://mycomap.org/api/downloads/latest";

/** Where the tool looks when no --data is given. */
export function defaultDataFolder(env: NodeJS.ProcessEnv = process.env): string {
  return env.MYCOMAP_VALIDATION_DATA?.trim() || path.join(os.homedir(), "mycomap-validation-data");
}

export interface DataFiles {
  folder: string;
  /** The MycoMap BLAST database, as blastn's -db takes it (no extension). */
  mycomapDb: string;
  namesTable: string;
  /** GenBank fungal ITS and RefSeq ITS type material, or null when not downloaded. */
  ncbiDbs: string[] | null;
  /** The NCBI build's date, from its info.txt or its folder name. */
  ncbiVersion: string | null;
}

/** Every file under the folder, three levels down at most. */
function filesUnder(folder: string, depth = 3): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const full = path.join(folder, e.name);
    if (e.isDirectory()) return depth > 0 ? filesUnder(full, depth - 1) : [];
    return [full];
  });
}

/** A BLAST database by name: the path of its index file without the extension (a v4 or v5 nucleotide database). */
function blastDb(files: string[], name: string): string | null {
  const found = files.filter((f) => [".nin", ".nal"].includes(path.extname(f)) && path.basename(f, path.extname(f)) === name).sort();
  return found.length ? found[found.length - 1].slice(0, -4) : null;
}

const DATED = /(\d{4}-\d{2}-\d{2})/;

/** The data files, or an InputError that says which are missing and where to get them. */
export function findDataFiles(folder: string, opts: { ncbi: boolean }): DataFiles {
  if (!fs.existsSync(folder)) {
    throw new InputError(`The data folder ${folder} does not exist. ${howToFill(folder)}`);
  }
  const files = filesUnder(folder);
  const mycomapDb = blastDb(files, "mycomap");
  // The newest names table, if several dates are kept.
  const names = files.filter((f) => /^mycomap_sequences.*\.tsv(\.gz)?$/.test(path.basename(f))).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  const namesTable = names.length ? names[names.length - 1] : null;
  const missing = [
    !mycomapDb && `the MycoMap BLAST database (mycomap.n* files, from ${LATEST}/mycomap-blastdb, unpacked)`,
    !namesTable && `the names table (mycomap_sequences_<date>.tsv.gz, from ${LATEST}/mycomap-sequences)`,
  ].filter(Boolean);
  if (missing.length) throw new InputError(`Missing from ${folder}: ${missing.join("; and ")}. ${howToFill(folder)}`);

  let ncbiDbs: string[] | null = null;
  let ncbiVersion: string | null = null;
  if (opts.ncbi) {
    const genbank = blastDb(files, "genbank_its");
    const refseq = blastDb(files, "refseq_its");
    if (genbank || refseq) {
      ncbiDbs = [genbank, refseq].filter((d): d is string => !!d);
      const dir = path.dirname(ncbiDbs[0]);
      const info = path.join(dir, "info.txt");
      const built = fs.existsSync(info) ? /^Built:\s*(\d{4}-\d{2}-\d{2})/m.exec(fs.readFileSync(info, "utf8"))?.[1] : undefined;
      ncbiVersion = built ?? DATED.exec(path.basename(dir))?.[1] ?? null;
    }
  }
  return { folder, mycomapDb: mycomapDb!, namesTable: namesTable!, ncbiDbs, ncbiVersion };
}

/**
 * The date of the MycoMap release: from the database's own title ("MycoMap
 * reference sequences 2026-11-20", as blastdbcmd -info prints it), else from
 * the names table's file name. A file saved from a "latest" link has no date
 * in its name.
 */
export function mycomapVersionOf(files: DataFiles, databaseInfo: string | null = null): string | null {
  const titled = databaseInfo ? /^Database:.*?(\d{4}-\d{2}-\d{2})/m.exec(databaseInfo)?.[1] : undefined;
  return titled ?? DATED.exec(path.basename(files.namesTable))?.[1] ?? null;
}

function howToFill(folder: string): string {
  return `Download the files from ${DOWNLOADS_PAGE} and unpack the BLAST databases into ${folder} (or name another folder with --data).`;
}
