// `mycomap-validation export <run folder>`: the files people submit or share,
// made from a run's validated records:
//
//   darwin-core.csv                   Darwin Core occurrences (darwinCore.ts)
//   genbank.fasta, genbank-source.tsv the two files NCBI's Submission Portal
//                                     takes (genbank.ts)
//   inaturalist.txt                   the observation fields and the comment,
//                                     to paste (inaturalist.ts)
//   export-report.txt                 what each file holds, and what the sheet
//                                     must add for what was left out
//
// The facts GenBank and Darwin Core need (where and when each specimen was
// collected, the voucher) come from the records sheet's optional columns. A
// sheet named with --records takes the run's own sheet's place, so they can
// be filled in after the run.
import fs from "node:fs";
import path from "node:path";
import { buildDarwinCore } from "./darwinCore";
import { InputError } from "./fasta";
import { buildGenbank } from "./genbank";
import { buildInaturalist } from "./inaturalist";
import { stopOnLocalNames } from "./localNames";
import { databasesText, readRunFolder, type LoadedRun } from "./runFolder";

export const EXPORT_FORMATS = ["dwc", "genbank", "inat"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_FILES: Record<ExportFormat, string[]> = {
  dwc: ["darwin-core.csv"],
  genbank: ["genbank.fasta", "genbank-source.tsv"],
  inat: ["inaturalist.txt"],
};
export const REPORT_FILE = "export-report.txt";

const FORMAT_WORDS: Record<string, ExportFormat> = {
  dwc: "dwc", "darwin-core": "dwc", darwincore: "dwc",
  genbank: "genbank", ncbi: "genbank",
  inat: "inat", inaturalist: "inat",
};

/** "dwc,genbank" (or one word, or "all") as formats. */
export function parseFormats(text: string): ExportFormat[] {
  const words = text.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (words.includes("all")) return [...EXPORT_FORMATS];
  const out: ExportFormat[] = [];
  for (const w of words) {
    const f = FORMAT_WORDS[w];
    if (!f) throw new InputError(`--format takes dwc, genbank, inat or all (or several, as dwc,genbank), not "${w}".`);
    if (!out.includes(f)) out.push(f);
  }
  if (!out.length) throw new InputError("--format needs a value: dwc, genbank, inat or all.");
  return out;
}

export interface ExportOptions {
  /** The run folder: the one "run" wrote, or one of the browser app's. */
  folder: string;
  formats?: readonly ExportFormat[];
  /** The FASTA file, for a run that did not keep its own. */
  fasta?: string | null;
  /** A records sheet to use instead of the run's own. */
  records?: string | null;
  /** Where the files go (the run folder by default). */
  out?: string | null;
}

export interface ExportOutput {
  out: string;
  /** The files written, by name. */
  files: string[];
  report: string;
  /** One line per format, for the terminal. */
  summary: string[];
}

const indent = (lines: string[]) => lines.map((l) => `  ${l}`);

/** Everything the export writes, as text, keyed by file name. */
export function buildExports(run: LoadedRun, formats: readonly ExportFormat[]): { files: Record<string, string>; report: string; summary: string[] } {
  const files: Record<string, string> = {};
  const sections: string[][] = [];
  const summary: string[] = [];
  const validated = run.records.filter((r) => r.decision === "validate" && r.species).length;
  // A local name (localNames.ts) is not in MycoMap's index: nothing is exported with one.
  stopOnLocalNames(run.records.filter((r) => r.decision === "validate").map((r) => ({ where: r.record, name: r.species })), "The exports");

  if (formats.includes("dwc")) {
    const dwc = buildDarwinCore(run);
    files["darwin-core.csv"] = dwc.csv;
    const line = `darwin-core.csv: ${dwc.rows.length} occurrence${dwc.rows.length === 1 ? "" : "s"}${dwc.missing.length ? `; ${dwc.missing.length} lack facts the sheet could add` : ""}.`;
    summary.push(line);
    sections.push([
      "DARWIN CORE", line,
      ...(dwc.missing.length ? ["", "The sheet could add (the rows are written without them):", ...indent(dwc.missing.map((m) => `${m.record}: ${m.missing.join("; ")}`))] : []),
      ...(dwc.notes.length ? ["", ...dwc.notes] : []),
    ]);
  }
  if (formats.includes("genbank")) {
    const gb = buildGenbank(run);
    files["genbank.fasta"] = gb.fasta;
    files["genbank-source.tsv"] = gb.tsv;
    const line = `genbank.fasta, genbank-source.tsv: ${gb.lines.length} of ${validated} validated record${validated === 1 ? "" : "s"}${gb.leftOut.length ? `; ${gb.leftOut.length} left out until the sheet gives what NCBI requires` : ""}.`;
    summary.push(line);
    sections.push([
      "GENBANK", line,
      ...(gb.leftOut.length ? ["", "Left out: add these to the records sheet, then export again with --records <sheet>:", ...indent(gb.leftOut.map((l) => `${l.record}${l.sequence && l.sequence !== l.record ? ` (${l.sequence})` : ""}: ${l.missing.join("; ")}`))] : []),
      ...(gb.warnings.length ? ["", "Worth checking before you submit:", ...indent(gb.warnings.map((w) => `${w.sequence}: ${w.message}`))] : []),
      ...(gb.notes.length ? ["", ...gb.notes] : []),
      ...(gb.lines.length ? ["", "Submit both files at NCBI's Submission Portal (https://submit.ncbi.nlm.nih.gov/subs/genbank/), as an ITS submission: the FASTA file as the sequences, genbank-source.tsv as the source modifiers. The authors and the submitter are entered in the Portal."] : []),
    ]);
  }
  if (formats.includes("inat")) {
    const inat = buildInaturalist(run);
    files["inaturalist.txt"] = inat.text;
    const line = `inaturalist.txt: fields and a comment for ${inat.entries.length} record${inat.entries.length === 1 ? "" : "s"}, to paste. Nothing is sent.`;
    summary.push(line);
    sections.push(["INATURALIST", line, ...(inat.notes.length ? ["", ...inat.notes] : [])]);
  }

  const head = [
    `Exports from the run in ${run.folder}`,
    `MycoMap Validation ${run.stamp.engineVersion}; ${databasesText(run.stamp)}; run ${run.stamp.ranAt.slice(0, 16).replace("T", " ")} UTC`,
    `${run.records.length} record${run.records.length === 1 ? "" : "s"}, ${validated} validated. Sequences from ${path.basename(run.sources.fasta)}; ${run.sources.records ? `records sheet ${path.basename(run.sources.records)}` : "no records sheet"}.`,
  ];
  const report = [head, ...sections].map((s) => s.join("\n")).join("\n\n") + "\n";
  files[REPORT_FILE] = report;
  return { files, report, summary };
}

export function exportRun(opts: ExportOptions): ExportOutput {
  const folder = path.resolve(opts.folder);
  const run = readRunFolder(folder, { fasta: opts.fasta, records: opts.records });
  const out = path.resolve(opts.out ?? folder);
  const built = buildExports(run, opts.formats ?? EXPORT_FORMATS);
  fs.mkdirSync(out, { recursive: true });
  for (const [name, text] of Object.entries(built.files)) fs.writeFileSync(path.join(out, name), text);
  return { out, files: Object.keys(built.files), report: built.report, summary: built.summary };
}
