// The iNaturalist-ready text: for each validated record, the observation
// fields and the comment mycomap.org's auto-validation posts, in a file to
// paste from. Nothing is sent to iNaturalist: the person pastes what they
// choose, signed in as themselves.
//
// The fields, as mycomap.org fills them:
//   - the species: "Provisional Species Name" (field 10675) for a name with a
//     number or a quote in it (a provisional name), else "Species Name
//     Override" (field 20259);
//   - "DNA Barcode ITS" (field 2330): the bases of the read that stands for
//     the record;
//   - "Reads in Consensus" (field 16718): its read count, when it has one.
//
// The comment is mycomap.org's: the introduction, then the top-line summary of
// the read's results ("Sequence #…: name (ID Confidence: …%)", then the
// MycoBLAST and NCBI lines), with three changes for a run of the tool: the
// introduction names the tool, its version and the databases' dates; the NCBI
// line says when GenBank was not searched (mycomap.org always searches it);
// and mycomap.org's closing paragraph is left out, since it asks the observer
// to flag the record for MycoMap's sequence validators, who do not see a
// run made on someone's own computer. When MycoMap Vision answered for the
// record (the run was given a Vision key), its part follows the summary, as
// on mycomap.org, with Vision's top name at each rank; else it is left out.
import type { AnalysisResult } from "../src/analysisRules";
import type { RecordOutcome } from "./records";
import { databasesText, recordLink, type LoadedRun } from "./runFolder";

export const INAT_FIELDS = {
  provisional: { id: 10675, name: "Provisional Species Name" },
  override: { id: 20259, name: "Species Name Override" },
  dnaBarcodeIts: { id: 2330, name: "DNA Barcode ITS" },
  readsInConsensus: { id: 16718, name: "Reads in Consensus" },
} as const;

/** A provisional name ("Russula sp. 'IN01'", `Cortinarius "sp-IN02"`): mycomap.org's test. */
export const isProvisionalSpeciesName = (name: string): boolean => /\d/.test(name) || name.includes("'") || name.includes('"');

type Line = { kind: "matches" | "none"; line: string };

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isThreshold = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100;

/** One provider's line, as mycomap.org writes it; null for evidence that does not add up. */
export function providerLine(o: { label: string; species: string | null | undefined; count: number | null | undefined; total: number | null | undefined; threshold: number | null | undefined; noun: string; source?: string | null }): Line | null {
  const species = (o.species ?? "").trim();
  const source = (o.source ?? "").trim();
  const threshold = o.threshold ?? null;
  if ((o.count == null || o.count === 0) && (o.total == null || o.total === 0) && threshold === null) {
    if (species) return { kind: "none", line: `${o.label}: ${species} (no usable ${o.noun} were available${source ? `; via ${source}` : ""}.)` };
    return { kind: "none", line: `${o.label}: No usable ${o.noun} were available.` };
  }
  if (!species && isCount(o.count) && isCount(o.total) && o.total > 0 && o.count <= o.total && (threshold === null || isThreshold(threshold))) {
    const at = isThreshold(threshold) ? ` at ≥ ${threshold}% sequence similarity` : "";
    return { kind: "none", line: `${o.label}: No species consensus among ${o.total} ${o.noun}${at}${source ? `; via ${source}` : ""}.` };
  }
  if (!species || !isCount(o.count) || !isCount(o.total) || o.total === 0 || o.count > o.total || (threshold !== null && !isThreshold(threshold))) return null;
  const parts = [`${o.count}/${o.total} ${o.noun}`];
  if (source) parts.push(`via ${source}`);
  else if (isThreshold(threshold)) parts.push(`at ≥ ${threshold}% sequence similarity`);
  return { kind: "matches", line: `${o.label}: ${species} (${parts.join(" ")})` };
}

/** The read's top-line summary, as mycomap.org's comment gives it; null when its result is not complete. */
export function sequenceSummary(sequenceId: string, r: AnalysisResult, ncbiSearched: boolean): string | null {
  if (r.status !== "complete" || !r.finalSpecies?.trim() || typeof r.finalConfidence !== "number") return null;
  const local = providerLine({ label: "MycoBLAST", species: r.localConsensusSpecies, count: r.localConsensusCount, total: r.localConsensusTotalWithSpecies, threshold: r.localConsensusThreshold, noun: "validated matches" });
  const ncbi = ncbiSearched
    ? providerLine({ label: "NCBI", species: r.ncbiConsensusSpecies, count: r.ncbiConsensusCount, total: r.ncbiConsensusTotalWithSpecies, threshold: r.ncbiConsensusThreshold, noun: "matches", source: r.broadenedSource })
    : { kind: "none" as const, line: "NCBI: not searched (GenBank's fungal ITS was not part of this run)." };
  if (!local || !ncbi) return null;
  return [`Sequence #${sequenceId}: ${r.finalSpecies.trim()} (ID Confidence: ${r.finalConfidence}%)`, local.line, ncbi.line].join("\n");
}

export function commentIntroduction(run: LoadedRun): string {
  return `The ID in the observation field was made from this observation's DNA sequence with MycoMap Validation ${run.stamp.engineVersion} (${databasesText(run.stamp)}), which applies MycoMap's automated identification rules. Please review your results and place your identification on the observation.\nMore information: www.MycoMap.org/automated-ids`;
}

/** MycoMap Vision's part of the comment, when it answered for the record; null otherwise (and for runs made before the tool asked Vision). */
export function visionPart(record: RecordOutcome): string | null {
  const v = record.vision;
  if (v?.status !== "answered" || !v.top) return null;
  return `MycoMap Vision (photos): ${v.top}`;
}

export interface InatEntry {
  record: string;
  url: string | null;
  speciesField: { id: number; name: string; value: string };
  dnaBarcodeIts: { id: number; name: string; value: string; sequence: string };
  readsInConsensus: { id: number; name: string; value: string } | null;
  comment: string | null;
}

export interface InatExport {
  text: string;
  entries: InatEntry[];
  notes: string[];
}

export function inatEntry(run: LoadedRun, record: RecordOutcome): InatEntry | null {
  const id = record.selectedSequenceId;
  const read = id ? run.reads.get(id) : undefined;
  const outcome = id ? run.sequences.get(id) : undefined;
  if (!id || !read || !outcome || !record.species) return null;
  const field = isProvisionalSpeciesName(record.species) ? INAT_FIELDS.provisional : INAT_FIELDS.override;
  const summary = sequenceSummary(id, outcome.result, !!run.stamp.databases.ncbi);
  return {
    record: record.record,
    url: recordLink(record.record).url,
    speciesField: { ...field, value: record.species },
    dnaBarcodeIts: { ...INAT_FIELDS.dnaBarcodeIts, value: read.bases, sequence: id },
    readsInConsensus: read.readCount === null ? null : { ...INAT_FIELDS.readsInConsensus, value: String(read.readCount) },
    // iNaturalist shows comments as Markdown; the header is bold, as mycomap.org's is.
    comment: summary
      ? [commentIntroduction(run), `**Here is a top-line summary of your sequence results from MycoBLAST:**\n\n${summary}`, visionPart(record)].filter(Boolean).join("\n\n")
      : null,
  };
}

const RULE = "=".repeat(72);

function entryText(e: InatEntry, record: RecordOutcome): string {
  const reads = record.sequenceIds.length > 1 || record.record !== record.sequenceIds[0] ? ` (${record.sequenceIds.join(", ")})` : "";
  return [
    RULE,
    `${e.record}${reads}`,
    e.url ? `Observation: ${e.url}` : "Observation: not known (write the record as inat:<number> in the sheet to have its address here)",
    "",
    `${e.speciesField.name} (observation field ${e.speciesField.id}):`,
    e.speciesField.value,
    "",
    `${e.dnaBarcodeIts.name} (observation field ${e.dnaBarcodeIts.id}), read ${e.dnaBarcodeIts.sequence}, ${e.dnaBarcodeIts.value.length} bases:`,
    e.dnaBarcodeIts.value,
    ...(e.readsInConsensus ? ["", `${e.readsInConsensus.name} (observation field ${e.readsInConsensus.id}):`, e.readsInConsensus.value] : []),
    "",
    "Comment:",
    e.comment ?? `(none: the result for ${e.dnaBarcodeIts.sequence} does not have the complete MycoBLAST summary a comment needs)`,
  ].join("\n");
}

export function buildInaturalist(run: LoadedRun): InatExport {
  const entries: InatEntry[] = [];
  const blocks: string[] = [];
  const notes: string[] = [];
  const validated = run.records.filter((r) => r.decision === "validate" && r.species);
  let mo = 0;
  for (const record of validated) {
    if (recordLink(record.record).platform === "mo") { mo++; continue; }
    const entry = inatEntry(run, record);
    if (!entry) continue;
    entries.push(entry);
    blocks.push(entryText(entry, record));
  }
  if (mo) notes.push(`${mo} validated record${mo === 1 ? " is" : "s are"} on Mushroom Observer, so ${mo === 1 ? "it is" : "they are"} left out: these are iNaturalist's fields.`);
  const left = run.records.length - validated.length;
  if (left) notes.push(`${left} record${left === 1 ? " was" : "s were"} not validated (held or rejected), so ${left === 1 ? "it is" : "they are"} not in the file.`);
  const unknown = entries.filter((e) => !e.url).length;
  if (unknown) notes.push(`${unknown} record${unknown === 1 ? " has" : "s have"} no iNaturalist address: write the record as inat:<number> in the sheet to have it.`);
  const head = [
    `iNaturalist fields and comments for ${entries.length} validated record${entries.length === 1 ? "" : "s"}`,
    `MycoMap Validation ${run.stamp.engineVersion}; ${databasesText(run.stamp)}; run ${run.stamp.ranAt.slice(0, 16).replace("T", " ")} UTC`,
    "",
    "Paste each into its observation on iNaturalist, signed in as yourself: the",
    "fields under Observation Fields, the comment as a comment. Nothing here has",
    "been sent to iNaturalist.",
  ].join("\n");
  return { text: [head, ...blocks].join("\n\n") + "\n", entries, notes };
}
