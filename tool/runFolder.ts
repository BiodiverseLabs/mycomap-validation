// A run folder read back for the exports: results.json (the stamp, every
// sequence's result and every record's decision), and the input files the run
// kept (inputs.ts): the FASTA file for the bases, the records sheet for where
// and when each specimen was collected. A sheet named at export time takes the
// kept one's place, so its columns can be filled in after the run.
import fs from "node:fs";
import path from "node:path";
import { InputError, readFasta, readRecordsSheet, type SampleDetails } from "./fasta";
import { inputFileName, type InputFiles } from "./inputs";
import type { RecordOutcome } from "./records";
import type { RunStamp, SequenceOutcome } from "./run";

export interface ReadInput {
  bases: string;
  readCount: number | null;
  details: SampleDetails;
}

export interface LoadedRun {
  folder: string;
  stamp: RunStamp;
  sequences: Map<string, SequenceOutcome>;
  records: RecordOutcome[];
  /** Each sequence's bases, read count and sheet columns, by its FASTA id. */
  reads: Map<string, ReadInput>;
  /** The files the bases and the sheet came from. */
  sources: { fasta: string; records: string | null };
}

interface ResultsFile extends RunStamp {
  inputFiles?: InputFiles;
  /** Set by the browser app: the names the files were chosen under. */
  input?: { fasta: string | null; records: string | null };
  sequences: SequenceOutcome[];
  records?: RecordOutcome[];
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new InputError(`${file} could not be read: ${(error as Error).message}`);
  }
}

/** Where the run's own copy of an input is, if it kept one. */
function keptInput(folder: string, kept: string | null | undefined, chosenAs: string | null | undefined): string | null {
  for (const name of [kept, chosenAs ? inputFileName(chosenAs) : null]) {
    if (name && fs.existsSync(path.join(folder, name))) return path.join(folder, name);
  }
  return null;
}

export function readRunFolder(folder: string, opts: { fasta?: string | null; records?: string | null } = {}): LoadedRun {
  const resultsFile = path.join(folder, "results.json");
  if (!fs.existsSync(resultsFile)) throw new InputError(`${folder} is not a run folder: it has no results.json. Name the folder "run" wrote its results to.`);
  let results: ResultsFile;
  try {
    results = JSON.parse(readText(resultsFile));
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(`${resultsFile} is not one the tool wrote: ${(error as Error).message}`);
  }
  if (!Array.isArray(results.sequences) || !results.engineVersion) throw new InputError(`${resultsFile} is not one the tool wrote.`);
  if (!Array.isArray(results.records)) throw new InputError(`${resultsFile} has no record decisions: it was made by a version before 2.0.0-beta.11. Run the FASTA file again.`);

  const fasta = opts.fasta ?? keptInput(folder, results.inputFiles?.fasta, results.input?.fasta);
  if (!fasta) throw new InputError(`The run in ${folder} did not keep its FASTA file (runs made by versions without the export command do not). Name it with --fasta <file>.`);
  const sheetFile = opts.records ?? keptInput(folder, results.inputFiles?.records, results.input?.records);

  const fastaSequences = new Map(readFasta(readText(fasta), path.basename(fasta)).map((s) => [s.id, s]));
  const missing = results.sequences.map((s) => s.id).filter((id) => !fastaSequences.has(id));
  if (missing.length) throw new InputError(`${path.basename(fasta)} does not have ${missing.length === 1 ? "the sequence" : `${missing.length} of the sequences`} the run named (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}). Is it the FASTA file the run was made from?`);
  const sheet = sheetFile ? readRecordsSheet(readText(sheetFile), path.basename(sheetFile)) : null;
  const unknown = sheet ? [...sheet.keys()].filter((id) => !fastaSequences.has(id)) : [];
  if (unknown.length) throw new InputError(`${path.basename(sheetFile!)} lists ${unknown.length === 1 ? "a sequence" : `${unknown.length} sequences`} the run does not have: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ", …" : ""}.`);

  const reads = new Map<string, ReadInput>();
  for (const s of results.sequences) {
    const read = fastaSequences.get(s.id)!;
    const row = sheet?.get(s.id);
    reads.set(s.id, { bases: read.bases, readCount: row?.readCount ?? read.readCount, details: row?.details ?? {} });
  }
  const { inputFiles: _kept, input: _chosen, sequences, records, ...stamp } = results;
  return {
    folder,
    stamp: stamp as RunStamp,
    sequences: new Map(sequences.map((s) => [s.id, s])),
    records,
    reads,
    sources: { fasta, records: sheetFile },
  };
}

/**
 * A record's sheet columns: those of the read that stands for it, with any it
 * leaves empty taken from the record's other reads, in order.
 */
export function recordDetails(run: LoadedRun, record: RecordOutcome): SampleDetails {
  const ids = [record.selectedSequenceId, ...record.sequenceIds].filter((id): id is string => !!id);
  const out: SampleDetails = {};
  for (const id of ids) {
    for (const [key, value] of Object.entries(run.reads.get(id)?.details ?? {})) {
      out[key as keyof SampleDetails] ??= value;
    }
  }
  return out;
}

/** Where a record is online, when its name says: "inat:123" (or "iNat 123"), "mo:123". */
export function recordLink(record: string): { platform: "inat" | "mo" | null; number: string | null; url: string | null } {
  const text = record.trim();
  const inat = /^(?:inat|inaturalist)\s*[:#-]?\s*(\d+)$/i.exec(text) ?? /^https?:\/\/(?:www\.)?inaturalist\.org\/observations\/(\d+)\/?$/i.exec(text);
  if (inat) return { platform: "inat", number: inat[1], url: `https://www.inaturalist.org/observations/${inat[1]}` };
  const mo = /^(?:mo|mushroom\s*observer)\s*[:#-]?\s*(\d+)$/i.exec(text) ?? /^https?:\/\/(?:www\.)?mushroomobserver\.org\/(?:obs\/|observations\/)?(\d+)\/?$/i.exec(text);
  if (mo) return { platform: "mo", number: mo[1], url: `https://mushroomobserver.org/obs/${mo[1]}` };
  return { platform: null, number: null, url: null };
}

/** Who named it, as the exports say: the tool and its version. */
export function identifiedByTool(stamp: RunStamp): string {
  return `MycoMap Validation ${stamp.engineVersion}`;
}

/** The databases the run searched, in words. */
export function databasesText(stamp: RunStamp, separator = "; "): string {
  const db = stamp.databases;
  return [
    `MycoMap reference sequences ${db.mycomap.version ?? "of unknown date"}`,
    db.ncbi ? `GenBank fungal ITS ${db.ncbi.version ?? "of unknown date"}` : "GenBank fungal ITS not searched",
  ].join(separator);
}

/** One CSV field: quoted when it holds a comma, a quote or a line break. */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvText(rows: readonly (readonly unknown[])[]): string {
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}
