// `mycomap-validation run`: names each sequence in a FASTA file the way
// mycomap.org's analysis does, on the user's own computer.
//
//   1. reads the FASTA file (and the records sheet, if given);
//   2. searches MycoMap's BLAST database, and GenBank's fungal ITS when it has
//      been downloaded, with the user's own BLAST+;
//   3. looks each MycoMap hit up in the names table;
//      With --refresh-ncbi (opt-in), the sequences GenBank's weekly database
//      does not answer are searched live at NCBI instead (ncbiRefresh.ts);
//   4. runs the engine's analysis on each sequence;
//   5. decides each record as auto-validation would (records.ts): validate,
//      reject or hold for a person, with the reason;
//   6. writes results.csv (one row per sequence), records.csv (one row per
//      record) and results.json (everything, with the steps), stamped with the
//      engine version and database dates, and keeps sequences.fasta: the
//      sequences as the tool read and cleaned them (contribute sends them).
//
// A read the analysis leaves for a new name, on a record nothing validated,
// gets a local name ("Russula sp. 'local-A02'": localNames.ts) until
// mycomap.org registers one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDeterministicAnalysis } from "../src/analysis";
import { extractSpeciesName, type AnalysisResult, type SequenceRecord } from "../src/analysisRules";
import { genbankFamilyWarning } from "../src/genbankLikelyName";
import { blastnArgs, databaseSearch, findBlastn, HITS_PER_SEQUENCE, readBlastTable, runProgram, searchWithBlastn, type ParsedBlastResult } from "./blast";
import { installedBlastFolder } from "./blastPlus";
import { bundled } from "./bundled";
import { findDataFiles, mycomapVersionOf, type DataFiles } from "./dataFolder";
import { InputError, readFasta, readRecordsSheet, withRecords, type QuerySequence } from "./fasta";
import { keepInputs, type InputFiles } from "./inputs";
import { readNamesTable } from "./namesTable";
import { answeredByWeekly, NCBI_SEARCH, REFRESH_BELOW, refreshFromNcbi, type NcbiAccess, type NcbiService } from "./ncbiRefresh";
import { adjustedIdentities, localPorts } from "./ports";
import { decideRecords, type RecordOutcome } from "./records";
import { localNameBase, localNameFor, needsNewName } from "./localNames";
import { createVisionClient, usageText, type VisionClientOptions, type VisionSettings, type VisionUsage } from "./vision";

/** What MycoMap Vision did in a run, stamped on its results. */
export interface RunVisionStamp {
  /** The address asked. */
  url: string;
  /** Records asked about, and answered. */
  asked: number;
  answered: number;
  /** The model releases and answers versions that answered. */
  models: string[];
  answersVersions: string[];
  /** The key's quota after the run, as Vision last gave it. */
  usage: VisionUsage | null;
  /** Why Vision stopped being asked (a refused key, a used-up quota), in words. */
  problem: string | null;
}

/** Asks Vision about the records (records.ts), when there are settings; the stamp says what it did. */
async function decideWithVision(
  sequences: QuerySequence[],
  results: Record<string, AnalysisResult>,
  families: ReadonlyMap<string, string>,
  opts: Pick<RunOptions, "vision" | "visionSeams" | "records" | "say">,
): Promise<{ records: RecordOutcome[]; vision: RunVisionStamp | null }> {
  if (!opts.vision) return { records: await decideRecords(sequences, results, families), vision: null };
  const say = opts.say ?? (() => undefined);
  const client = createVisionClient({ ...opts.vision, ...opts.visionSeams });
  await client.usage();
  say(client.stopped ? `${client.stopped.words}: no record is sent to it.` : `Asking MycoMap Vision (${client.url})${usageText(client.lastUsage) ? `; quota ${usageText(client.lastUsage)}` : ""}…`);
  const photosFrom = opts.records ? path.dirname(opts.records) : null;
  const records = await decideRecords(sequences, results, families, { vision: client, photosFrom });
  const answered = records.filter((r) => r.vision.status === "answered");
  const uniq = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => !!x))];
  return {
    records,
    vision: {
      url: client.url,
      asked: records.filter((r) => r.vision.status !== "not_asked").length,
      answered: answered.length,
      models: uniq(answered.map((r) => r.vision.model)),
      answersVersions: uniq(answered.map((r) => r.vision.answersVersion)),
      usage: client.lastUsage,
      problem: client.stopped?.words ?? null,
    },
  };
}

export interface RunOptions {
  fasta: string;
  records?: string | null;
  data: string;
  /** The folder the results go in. */
  out: string;
  threads: number;
  /** Search GenBank's fungal ITS too, when it has been downloaded. */
  ncbi: boolean;
  blastFolder?: string | null;
  /** Progress lines for the terminal. */
  say?: (line: string) => void;
  /** Test seam: how blastn is started. */
  run?: typeof runProgram;
  /** Test seam: the time stamped on the results. */
  now?: () => Date;
  /**
   * Opt-in: search NCBI live, with the person's own key and email address, for
   * the sequences the weekly GenBank database does not answer. Nothing is sent
   * without it.
   */
  refreshNcbi?: NcbiAccess | null;
  /** Test seam: where NCBI is, and its clock. */
  ncbiService?: NcbiService;
  /** Ask MycoMap Vision with the user's own key; null or left out: nothing is sent. */
  vision?: VisionSettings | null;
  /** Test seams for the Vision client. */
  visionSeams?: Pick<VisionClientOptions, "fetch" | "sleep" | "retryDelaysS" | "retryBudgetMs">;
}

export interface HitSummary {
  accession: string;
  name: string | null;
  identity: number;
  adjustedIdentity: number | null;
  coverage: number;
  /** MycoMap only: whether the hit's own record is validated (only those count towards a name). */
  validated?: boolean;
  flags?: string[];
}

export interface SequenceOutcome {
  id: string;
  recordName: string | null;
  readCount: number | null;
  length: number;
  result: AnalysisResult;
  /** The best hits from each source, best first (ten at most). */
  mycomapHits: HitSummary[];
  ncbiHits: HitSummary[] | null;
  mycomapHitCount: number;
  ncbiHitCount: number | null;
  /** Set when the GenBank hits came from NCBI live (--refresh-ncbi), not the weekly database. */
  ncbiLive?: { rid: string; answeredAt: string };
  /** The read's local name (localNames.ts), when it needs a new name; null otherwise. Absent before 2.0.0-beta.13. */
  localName?: string | null;
  /** The name mycomap.org gave a read that had a local name (contribute --status). */
  mycomapName?: { kind: "existing" | "new"; value: string; contribution: string } | null;
}

/** A record of a run: its decision, and the new name of its reads that need one (a local name until registered). */
export type RunRecord = RecordOutcome & { newName?: string | null };

/** A read's new name as the results show it: mycomap.org's, else its local name. */
export function newNameOf(o: Pick<SequenceOutcome, "localName" | "mycomapName">): string | null {
  return o.mycomapName?.value ?? o.localName ?? null;
}

/** What --refresh-ncbi did, in the stamp. */
export interface NcbiLiveStamp {
  label: "NCBI: live";
  /** The day NCBI answered (UTC). */
  date: string;
  search: { program: string; megablast: boolean; database: string; alignments: number };
  /** Below this best weekly identity, a sequence was sent. */
  sentBelow: number;
  /** The sequences whose GenBank hits are NCBI's live answer. */
  sequences: Array<{ id: string; rid: string; answeredAt: string }>;
  /** Sent but not answered: they keep the weekly hits. */
  keptWeekly: Array<{ id: string; reason: string }>;
  stopped: string | null;
}

export interface RunStamp {
  tool: "mycomap-validation";
  engineVersion: string;
  ranAt: string;
  blast: string;
  /** Which BLAST+ ran: the one init installed, one named with --blast, or the one on the PATH. */
  blastSource: "installed by init" | "named with --blast" | "on the PATH";
  databases: {
    mycomap: { version: string | null; namesTable: string; rows: number };
    ncbi: { version: string | null; databases: string[]; live?: NcbiLiveStamp } | null;
  };
  settings: { hitsPerSequence: number; threads: number };
  /** Null: MycoMap Vision was not asked (no key). */
  vision?: RunVisionStamp | null;
}

export interface RunOutput {
  stamp: RunStamp;
  /** The input files, kept in the results folder for the exports (inputs.ts). */
  inputFiles: InputFiles;
  sequences: SequenceOutcome[];
  records: RunRecord[];
  files: { csv: string; json: string; recordsCsv: string; mycomapBlast: string; ncbiBlast: string | null; fasta: string; ncbiLive?: string };
}

/** The engine's version: its package.json's (built into the downloadable tool). */
export function engineVersion(): string {
  if (bundled) return bundled.version;
  return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

function summarize(result: ParsedBlastResult, adjusted: Record<number, number>, records: ReadonlyMap<string, SequenceRecord> | null): HitSummary[] {
  return result.hits.slice(0, 10).map((h) => {
    const record = records?.get(h.accession);
    return {
      accession: h.accession,
      // A GenBank hit is named from its title, as the rules name it.
      name: records ? record?.scientificName ?? null : extractSpeciesName(h.def) ?? (h.def || null),
      identity: Math.round(h.identity * 100) / 100,
      adjustedIdentity: adjusted[h.num] ?? null,
      coverage: Math.round(h.queryCoverage * 10) / 10,
      ...(records ? { validated: record?.validationStatus === "verified", flags: record?.flags ?? [] } : {}),
    };
  });
}

export async function runValidation(opts: RunOptions): Promise<RunOutput> {
  const say = opts.say ?? (() => undefined);
  if (!fs.existsSync(opts.fasta)) throw new InputError(`There is no file ${opts.fasta}.`);
  if (path.resolve(opts.out, SEQUENCES_FILE) === path.resolve(opts.fasta)) throw new InputError(`The run keeps its sequences as ${SEQUENCES_FILE} in the results folder, and that is the FASTA file being read. Choose another results folder with --out, or rename the file.`);
  const sheet = opts.records ? readRecordsSheet(readText(opts.records), path.basename(opts.records)) : null;
  const sequences = withRecords(readFasta(readText(opts.fasta), path.basename(opts.fasta)), sheet, opts.records ? path.basename(opts.records) : undefined);
  const data: DataFiles = findDataFiles(opts.data, { ncbi: opts.ncbi });
  // The BLAST+ init installed, unless another is named; else the one on the PATH.
  const installedBlast = installedBlastFolder(data.folder);
  const blastSource: RunStamp["blastSource"] = opts.blastFolder ? "named with --blast" : installedBlast ? "installed by init" : "on the PATH";
  const blast = await findBlastn(opts.blastFolder ?? installedBlast, opts.run);
  say(`${sequences.length} sequence${sequences.length === 1 ? "" : "s"} from ${path.basename(opts.fasta)}; BLAST+ ${blast.version} (${blastSource}).`);
  if (opts.refreshNcbi && !data.ncbiDbs) {
    throw new InputError(opts.ncbi
      ? `--refresh-ncbi asks NCBI about the sequences GenBank's weekly fungal ITS database does not answer, and that database is not in ${data.folder}. Download it first: mycomap-validation init`
      : "--refresh-ncbi asks NCBI about the sequences GenBank's weekly fungal ITS database does not answer, so it cannot go with --no-ncbi.");
  }
  if (opts.ncbi && !data.ncbiDbs) say(`GenBank's fungal ITS database is not in ${data.folder}, so only MycoMap's sequences are searched. Download it from the Data Downloads page to add GenBank.`);

  fs.mkdirSync(opts.out, { recursive: true });
  // blastn runs inside the results folder with these short names (blast.ts databaseSearch says why).
  // The query is kept as sequences.fasta, the run's cleaned sequences, for contribute.
  const QUERY = SEQUENCES_FILE;
  const query = path.join(opts.out, QUERY);
  fs.writeFileSync(query, sequences.map((s) => `>${s.id}
${s.bases}
`).join(""));
  const lengths = new Map(sequences.map((s) => [s.id, s.bases.length]));
  const search = async (databases: string[], table: string, what: string) => {
    const { names, searchPath } = databaseSearch(databases);
    await searchWithBlastn(blast.blastn, blastnArgs({ query: QUERY, databases: names, out: table, threads: opts.threads }), what, opts.run, { cwd: opts.out, env: { BLASTDB: searchPath } });
    return readBlastTable(readText(path.join(opts.out, table)), lengths);
  };

  say("Searching MycoMap's sequences…");
  const mycomap = await search([data.mycomapDb], "blast-mycomap.tsv", "MycoMap's database");
  const mycomapTable = path.join(opts.out, "blast-mycomap.tsv");
  let ncbi: Map<string, ParsedBlastResult> | null = null;
  let ncbiTable: string | null = null;
  if (data.ncbiDbs) {
    say("Searching GenBank's fungal ITS…");
    ncbi = await search(data.ncbiDbs, "blast-ncbi.tsv", "GenBank's fungal ITS database");
    ncbiTable = path.join(opts.out, "blast-ncbi.tsv");
  }

  // --refresh-ncbi: only now, and only for what the weekly database does not answer.
  let live: NcbiLiveStamp | undefined;
  let liveFolder: string | undefined;
  const liveBySequence = new Map<string, { rid: string; answeredAt: string }>();
  if (opts.refreshNcbi && ncbi) {
    const toSend = sequences.filter((s) => !answeredByWeekly(ncbi!.get(s.id)));
    say(toSend.length ? `${toSend.length} of ${sequences.length} sequences have no weekly GenBank hit at ${REFRESH_BELOW}% or better.` : `Every sequence has a weekly GenBank hit at ${REFRESH_BELOW}% or better, so nothing is sent to NCBI.`);
    const refreshed = await refreshFromNcbi(toSend.map((s) => ({ id: s.id, bases: s.bases })), opts.refreshNcbi, say, opts.ncbiService);
    if (refreshed.searched.length) {
      liveFolder = path.join(opts.out, "ncbi-live");
      fs.mkdirSync(liveFolder, { recursive: true });
    }
    for (const found of refreshed.searched) {
      ncbi.set(found.id, found.result);
      liveBySequence.set(found.id, { rid: found.rid, answeredAt: found.answeredAt });
      // NCBI's own answer, kept as BLAST's tables are.
      fs.writeFileSync(path.join(liveFolder!, `${sequences.findIndex((s) => s.id === found.id) + 1}_${found.id.replace(/[^\w.-]+/g, "_").slice(0, 60)}.xml`), found.xml);
    }
    const answered = refreshed.searched.map((f) => f.answeredAt).sort();
    live = {
      label: "NCBI: live",
      date: (answered[answered.length - 1] ?? (opts.now?.() ?? new Date()).toISOString()).slice(0, 10),
      search: { ...NCBI_SEARCH },
      sentBelow: REFRESH_BELOW,
      sequences: refreshed.searched.map((f) => ({ id: f.id, rid: f.rid, answeredAt: f.answeredAt })),
      keptWeekly: refreshed.keptWeekly,
      stopped: refreshed.stopped,
    };
  }

  const info = await (opts.run ?? runProgram)(blast.blastdbcmd, ["-db", databaseSearch([data.mycomapDb]).names[0], "-info"], { cwd: opts.out, env: { BLASTDB: databaseSearch([data.mycomapDb]).searchPath } });
  const mycomapVersion = mycomapVersionOf(data, info.code === 0 ? info.stdout : null);
  const wanted = new Set([...mycomap.values()].flatMap((r) => r.hits.map((h) => h.accession)));
  say("Reading the names table…");
  const names = await readNamesTable(data.namesTable, wanted);

  const outcomes: SequenceOutcome[] = [];
  for (const [i, s] of sequences.entries()) {
    say(`Analysing ${i + 1} of ${sequences.length}: ${s.id}`);
    const outcome = await analyseOne(s, mycomap.get(s.id)!, ncbi?.get(s.id) ?? null, names.records, names.families, isOnlySequence(s, sequences));
    const fromNcbi = liveBySequence.get(s.id);
    outcomes.push(fromNcbi ? { ...outcome, ncbiLive: fromNcbi } : outcome);
  }

  say("Deciding the records…");
  const decided = await decideWithVision(sequences, Object.fromEntries(outcomes.map((o) => [o.id, o.result])), names.families, opts);
  const { vision } = decided;
  const records = giveLocalNames(sequences, outcomes, decided.records, { mycomap, ncbi, records: names.records, families: names.families });

  const stamp: RunStamp = {
    tool: "mycomap-validation",
    engineVersion: engineVersion(),
    ranAt: (opts.now?.() ?? new Date()).toISOString(),
    blast: blast.version,
    blastSource,
    databases: {
      mycomap: { version: mycomapVersion, namesTable: path.basename(data.namesTable), rows: names.rows },
      ncbi: data.ncbiDbs ? { version: data.ncbiVersion, databases: data.ncbiDbs.map((d) => path.basename(d)), ...(live ? { live } : {}) } : null,
    },
    settings: { hitsPerSequence: HITS_PER_SEQUENCE, threads: opts.threads },
    vision,
  };
  const csv = path.join(opts.out, "results.csv");
  const json = path.join(opts.out, "results.json");
  const recordsCsvFile = path.join(opts.out, "records.csv");
  fs.writeFileSync(csv, resultsCsv(outcomes, stamp));
  fs.writeFileSync(recordsCsvFile, recordsCsv(records, stamp));
  const inputFiles = keepInputs(opts.fasta, opts.records, opts.out);
  fs.writeFileSync(json, `${JSON.stringify({ ...stamp, inputFiles, sequences: outcomes, records }, null, 2)}\n`);
  return { stamp, inputFiles, sequences: outcomes, records, files: { csv, json, recordsCsv: recordsCsvFile, mycomapBlast: mycomapTable, ncbiBlast: ncbiTable, fasta: query, ...(liveFolder ? { ncbiLive: liveFolder } : {}) } };
}

/** The run folder's copy of the sequences: as the tool read and cleaned them, one line of bases each. */
export const SEQUENCES_FILE = "sequences.fasta";

/**
 * Gives a local name to each read the analysis left for a new name, on a
 * record nothing validated (a validated record has its name; a stray read on it
 * is no new species), and gives each record its reads' new names.
 */
export function giveLocalNames(
  sequences: readonly QuerySequence[],
  outcomes: SequenceOutcome[],
  records: readonly RecordOutcome[],
  evidence: { mycomap: ReadonlyMap<string, ParsedBlastResult>; ncbi: ReadonlyMap<string, ParsedBlastResult> | null; records: ReadonlyMap<string, SequenceRecord>; families: ReadonlyMap<string, string> },
): RunRecord[] {
  const byId = new Map(outcomes.map((o) => [o.id, o]));
  const sequenceById = new Map(sequences.map((s) => [s.id, s]));
  for (const o of outcomes) o.localName = null;
  return records.map((r) => {
    if (r.decision === "validate") return { ...r, newName: null };
    const names: string[] = [];
    for (const id of r.sequenceIds) {
      const o = byId.get(id);
      if (!o || !needsNewName(o.result)) continue;
      const mycomap = evidence.mycomap.get(id) ?? { queryLen: o.length, hits: [] };
      const ncbi = evidence.ncbi?.get(id) ?? null;
      // A read nothing resembles in either database has nothing to be named from.
      if (!mycomap.hits.length && !ncbi?.hits.length) continue;
      const base = localNameBase({
        engineId: engineSequenceId(id, evidence.records), record: sequenceById.get(id)?.record ?? null,
        mycomap, ncbi, mycomapAdjusted: adjustedIdentities(mycomap), ncbiAdjusted: ncbi ? adjustedIdentities(ncbi) : {},
        records: evidence.records, families: evidence.families,
      });
      o.localName = localNameFor(base, id);
      names.push(o.localName);
    }
    return { ...r, newName: names.length ? names.join("; ") : null };
  });
}

/**
 * The id the rules know a sequence by. A sequence that is one of MycoMap's own
 * (its FASTA id is MM123, or 123 when MM123 is among its hits) goes in by its
 * MycoMap id, so the rules leave out its own read and its specimen's other
 * reads, as mycomap.org does, instead of counting them as support for itself.
 * Any other gets a prefix ("edna-" is kept for the server's eDNA uploads).
 */
export function engineSequenceId(id: string, records: ReadonlyMap<string, SequenceRecord>): string {
  if (records.has(id)) return id;
  if (/^\d+$/.test(id) && records.has(`MM${id}`)) return `MM${id}`;
  return `query:${id}`;
}

/** Whether the sequence is its record's only one in this run: the rules then waive the low read count penalty when the genus matches. */
export function isOnlySequence(s: QuerySequence, all: readonly QuerySequence[]): boolean {
  return s.record === null || all.filter((o) => o.record === s.record).length === 1;
}

export async function analyseOne(
  s: QuerySequence,
  mycomap: ParsedBlastResult,
  ncbi: ParsedBlastResult | null,
  records: ReadonlyMap<string, SequenceRecord>,
  families: ReadonlyMap<string, string>,
  onlySequenceForRecord = true,
): Promise<SequenceOutcome> {
  const ports = localPorts({ mycomap, ncbi, records, families });
  const result = await runDeterministicAnalysis(ports, engineSequenceId(s.id, records), "local:ncbi", "local:mycomap", s.recordName, s.readCount, null, onlySequenceForRecord);
  return {
    id: s.id,
    recordName: s.recordName,
    readCount: s.readCount,
    length: s.bases.length,
    result,
    mycomapHits: summarize(mycomap, adjustedIdentities(mycomap), records),
    ncbiHits: ncbi ? summarize(ncbi, adjustedIdentities(ncbi), null) : null,
    mycomapHitCount: mycomap.hits.length,
    ncbiHitCount: ncbi ? ncbi.hits.length : null,
  };
}

// ── results.csv ──

export const RESULT_COLUMNS = [
  "sequence", "record_name", "reads", "length", "dna_name", "confidence", "flags", "likely_name", "genbank_likely_name", "warning",
  "new_name",
  "mycomap_hits", "best_mycomap_hit", "best_mycomap_adjusted_identity", "ncbi_hits", "best_ncbi_hit", "best_ncbi_identity",
  "validation_version", "mycomap_database", "ncbi_database",
] as const;

export function flagsOf(result: AnalysisResult): string[] {
  return [
    result.flaggedContaminant && "contaminant",
    result.flaggedNonTarget && "non-target",
    result.barcodeGapNeeded && "barcode gap check needed",
    result.noBlastHits && "no MycoMap hits",
    result.status === "error" && "error",
  ].filter((f): f is string => !!f);
}

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function resultsCsvRow(o: SequenceOutcome, stamp: RunStamp): unknown[] {
  const r = o.result;
  const best = o.mycomapHits[0];
  const bestNcbi = o.ncbiHits?.[0];
  const genbank = r.genbankLikelyName;
  const warning = genbankFamilyWarning(genbank);
  return [
    o.id, o.recordName, o.readCount, o.length, r.finalSpecies, r.finalConfidence, flagsOf(r).join("; "),
    r.contaminantLikelyName?.name ?? null, genbank?.name ?? null, warning ?? r.errorMessage ?? null,
    newNameOf(o),
    o.mycomapHitCount, best?.name ?? null, best?.adjustedIdentity ?? null,
    o.ncbiHitCount, bestNcbi?.name ?? null, bestNcbi?.identity ?? null,
    stamp.engineVersion, stamp.databases.mycomap.version, ncbiDatabaseLabel(stamp, [o.id]),
  ];
}

/** The ncbi_database column: the weekly database's date, or "NCBI: live <date>" for sequences NCBI answered live. */
export function ncbiDatabaseLabel(stamp: RunStamp, sequenceIds: readonly string[]): string {
  const ncbi = stamp.databases.ncbi;
  if (!ncbi) return "not searched";
  const weekly = ncbi.version ?? "yes";
  const liveIds = new Set(ncbi.live?.sequences.map((s) => s.id) ?? []);
  const liveHere = sequenceIds.filter((id) => liveIds.has(id));
  if (!liveHere.length) return weekly;
  const label = `${ncbi.live!.label} ${ncbi.live!.date}`;
  return liveHere.length === sequenceIds.length ? label : `${weekly}; ${label} for ${liveHere.join(", ")}`;
}

export function resultsCsv(outcomes: SequenceOutcome[], stamp: RunStamp): string {
  return [RESULT_COLUMNS, ...outcomes.map((o) => resultsCsvRow(o, stamp))].map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

// ── records.csv ──

export const RECORD_COLUMNS = [
  "record", "sequences", "record_name", "decision", "species", "selected_sequence", "agreeing_sequences", "second_source", "reason",
  "new_name",
  "set_aside", "vision", "vision_top", "vision_model", "vision_answers_version",
  "validation_version", "mycomap_database", "ncbi_database",
] as const;

/** What Vision made of a record, for records.csv: "answered (by observation number)", or why not. */
export function visionCell(r: RecordOutcome): string {
  const v = r.vision;
  if (v.status === "answered") return `answered (by ${v.by === "photos" ? "photos" : "observation number"}${v.kept ? ", an answer Vision held" : ""}${v.gate && v.gate !== "fungus" ? `; fungus check: ${v.gate}` : ""})`;
  return `${v.status === "no_answer" ? "no answer" : "not asked"}: ${(v.words ?? "").replace(/^MycoMap Vision (was not asked )?/, "").replace(/^\((.*)\)$/, "$1")}`;
}

export function recordsCsv(records: RunRecord[], stamp: RunStamp): string {
  const rows = records.map((r) => [
    r.record, r.sequenceIds.join("; "), r.observerName, r.decision, r.species, r.selectedSequenceId, r.agreeingSequenceIds.join("; "), r.secondSource, r.reason,
    r.newName ?? null,
    r.setAsideSequenceIds.join("; "), visionCell(r), r.vision.top, r.vision.model, r.vision.answersVersion,
    stamp.engineVersion, stamp.databases.mycomap.version, ncbiDatabaseLabel(stamp, r.sequenceIds),
  ]);
  return [RECORD_COLUMNS, ...rows].map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new InputError(`${file} could not be read: ${(error as Error).message}`);
  }
}

/** Threads for BLAST: four, or fewer on a smaller computer. */
export function defaultThreads(): number {
  return Math.max(1, Math.min(4, os.cpus().length));
}
