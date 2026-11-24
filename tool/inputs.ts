// A run keeps its input files (the FASTA file and the records sheet) in its
// results folder, so the exports (export.ts) can be made later from the folder
// alone: the GenBank files need the bases, and the sheet's columns say where
// and when each specimen was collected.
import fs from "node:fs";
import path from "node:path";

/** The input files' names inside a run folder, as results.json records them. */
export interface InputFiles {
  fasta: string;
  records: string | null;
}

/** The name an input file is kept under: "input_" and its own name, made safe. */
export function inputFileName(name: string): string {
  return `input_${path.basename(name).replace(/[^\w.-]+/g, "_")}`;
}

/** Copies an input into the run folder, unless it is already there; returns its name there. */
function keep(file: string, folder: string): string {
  if (path.resolve(path.dirname(file)) === path.resolve(folder)) return path.basename(file);
  const name = inputFileName(file);
  fs.copyFileSync(file, path.join(folder, name));
  return name;
}

/** Keeps the run's FASTA file and records sheet in its folder. */
export function keepInputs(fasta: string, records: string | null | undefined, folder: string): InputFiles {
  return { fasta: keep(fasta, folder), records: records ? keep(records, folder) : null };
}
