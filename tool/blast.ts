// Runs BLAST+ (blastn) on the user's computer and reads its results into the
// hits the engine takes, the same hits mycomap.org reads from its BLAST XML:
// hits in BLAST's order, each hit's identity and coverage from its first HSP,
// and the aligned strands kept so adjusted identity can be worked out.
import { spawn } from "node:child_process";
import path from "node:path";
import type { BlastHit } from "../src/analysisRules";
import { InputError } from "./fasta";

/** Hits per sequence and database, as MycoBLAST asks for. */
export const HITS_PER_SEQUENCE = 50;

/** The oldest BLAST+ the tool runs with: it must read v4 databases (the weekly NCBI one) and v5 (MycoMap's). */
export const OLDEST_BLAST = [2, 12, 0] as const;

/** The table columns asked of blastn, in order. */
export const BLAST_COLUMNS = ["qseqid", "sseqid", "saccver", "qlen", "slen", "length", "nident", "qstart", "qend", "sstart", "send", "qseq", "sseq", "stitle"] as const;

export interface ParsedBlastResult {
  queryLen: number;
  hits: BlastHit[];
}

/** The blastn arguments for one search of the whole FASTA file (short names: see databaseSearch). */
export function blastnArgs(opts: { query: string; databases: string[]; out: string; threads: number; hits?: number }): string[] {
  return [
    "-query", opts.query,
    "-db", opts.databases.join(" "),
    "-max_target_seqs", String(opts.hits ?? HITS_PER_SEQUENCE),
    "-num_threads", String(opts.threads),
    "-outfmt", `6 ${BLAST_COLUMNS.join(" ")}`,
    "-out", opts.out,
  ];
}

/**
 * Each query's hits from blastn's table output. A query with no hits is not
 * in the output: it gets an empty result with its own length, from `queryLengths`.
 */
export function readBlastTable(text: string, queryLengths: ReadonlyMap<string, number>): Map<string, ParsedBlastResult> {
  const results = new Map<string, ParsedBlastResult>();
  for (const [id, length] of queryLengths) results.set(id, { queryLen: length, hits: [] });
  const bySubject = new Map<string, Map<string, BlastHit>>();
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) continue;
    const cells = line.split("\t");
    if (cells.length < BLAST_COLUMNS.length) throw new Error(`blastn wrote a line with ${cells.length} columns, not ${BLAST_COLUMNS.length}: ${line.slice(0, 120)}`);
    const [qseqid, sseqid, saccver, qlen, slen, length, nident, qstart, qend, sstart, send, qseq, sseq] = cells;
    // The title is last and may itself hold tabs.
    const stitle = cells.slice(BLAST_COLUMNS.length - 1).join("\t");
    const result = results.get(qseqid) ?? { queryLen: Number(qlen), hits: [] };
    results.set(qseqid, result);
    result.queryLen = Number(qlen);
    const subjects = bySubject.get(qseqid) ?? new Map<string, BlastHit>();
    bySubject.set(qseqid, subjects);
    const hsp = {
      identity: Number(nident), alignLen: Number(length),
      queryFrom: Number(qstart), queryTo: Number(qend), hitFrom: Number(sstart), hitTo: Number(send),
      qseq, hseq: sseq, midline: "",
    };
    const known = subjects.get(sseqid);
    if (known) {
      known.hsps.push(hsp);
      continue;
    }
    const hit: BlastHit = {
      num: result.hits.length + 1,
      def: titleWithoutId(stitle, saccver),
      accession: saccver,
      id: sseqid,
      len: Number(slen),
      identity: hsp.alignLen > 0 ? (hsp.identity / hsp.alignLen) * 100 : 0,
      alignLen: hsp.alignLen,
      queryLen: Number(qlen),
      queryCoverage: Number(qlen) > 0 ? ((Math.abs(hsp.queryTo - hsp.queryFrom) + 1) / Number(qlen)) * 100 : 0,
      hsps: [hsp],
    };
    subjects.set(sseqid, hit);
    result.hits.push(hit);
  }
  return results;
}

/** BLAST XML's Hit_def is the title without the id; a table's stitle may start with it. */
function titleWithoutId(title: string, accession: string): string {
  const t = title.trim();
  return t.startsWith(`${accession} `) ? t.slice(accession.length + 1) : t;
}

/** "blastn: 2.17.0+" → [2, 17, 0]. */
export function blastVersion(versionText: string): [number, number, number] | null {
  const m = /blastn:\s*(\d+)\.(\d+)\.(\d+)/.exec(versionText);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isBlastNewEnough(version: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== OLDEST_BLAST[i]) return version[i] > OLDEST_BLAST[i];
  }
  return true;
}

export interface ProgramRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not be started at all (not installed). */
  startError?: string;
}

export interface RunPlace {
  cwd?: string;
  /** Added to the environment the program sees. */
  env?: Record<string, string>;
}

/**
 * BLAST+ reports its use to NCBI unless told not to ("Phone home enabled" in
 * its trace log; see BLAST_PRIVACY in NCBI's archive). The tool promises that
 * nothing is sent anywhere, so every program it starts is told not to.
 */
export const NO_USAGE_REPORT = { BLAST_USAGE_REPORT: "false", NCBI_USAGE_REPORT_ENABLED: "false" } as const;

/** Runs a program and collects what it prints. Never throws. */
export function runProgram(program: string, args: string[], place: RunPlace = {}): Promise<ProgramRun> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(program, args, { cwd: place.cwd, env: { ...process.env, ...place.env, ...NO_USAGE_REPORT }, windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout, stderr, startError: String((error as Error)?.message ?? error) });
      return;
    }
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (error) => resolve({ code: null, stdout, stderr, startError: error.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const BLAST_INSTALL = "Install BLAST+ (version 2.12 or newer) from https://ftp.ncbi.nlm.nih.gov/blast/executables/blast+/LATEST/ (or with conda: conda install -c bioconda blast), then open a new terminal so it is on your PATH. Or say where it is with --blast <folder holding blastn>.";

/** The blastn to run and its version, or an InputError saying how to get one. */
export async function findBlastn(blastFolder: string | null, run = runProgram): Promise<{ blastn: string; blastdbcmd: string; version: string }> {
  const join = (name: string) => (blastFolder ? `${blastFolder.replace(/[\\/]+$/, "")}/${name}` : name);
  const blastn = join("blastn");
  const answer = await run(blastn, ["-version"]);
  if (answer.startError || answer.code !== 0) {
    throw new InputError(`BLAST+ was not found${blastFolder ? ` in ${blastFolder}` : " (blastn is not on your PATH)"}. ${BLAST_INSTALL}`);
  }
  const version = blastVersion(answer.stdout);
  if (!version) throw new InputError(`"${blastn} -version" did not say which BLAST+ it is. ${BLAST_INSTALL}`);
  if (!isBlastNewEnough(version)) {
    throw new InputError(`BLAST+ ${version.join(".")} is too old to read MycoMap's database. ${BLAST_INSTALL}`);
  }
  return { blastn, blastdbcmd: join("blastdbcmd"), version: version.join(".") };
}

/**
 * Where blastn finds the databases: their names for -db, and the folders for
 * BLASTDB. BLAST+ splits a file name at its spaces (on Windows even inside one
 * argument), so no path goes on its command line: it runs inside the results
 * folder with short file names, and finds each database by name on BLASTDB.
 */
export function databaseSearch(databases: string[]): { names: string[]; searchPath: string } {
  const folders = [...new Set(databases.map((db) => path.dirname(db)))];
  return { names: databases.map((db) => path.basename(db)), searchPath: folders.join(path.delimiter) };
}

/** Runs one blastn search; an InputError with BLAST's own words when it fails. */
export async function searchWithBlastn(blastn: string, args: string[], what: string, run = runProgram, place: RunPlace = {}): Promise<void> {
  const answer = await run(blastn, args, place);
  if (answer.startError || answer.code !== 0) {
    const said = (answer.startError ?? answer.stderr).trim().split("\n").filter((l) => !/^Warning:/.test(l)).slice(0, 4).join(" ");
    throw new InputError(`BLAST could not search ${what}: ${said || `blastn stopped with code ${answer.code}`}`);
  }
}
