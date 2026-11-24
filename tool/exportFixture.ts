// For the export tests: a run folder as `run` leaves it (results.json and the
// kept input files), built by hand with made-up records, so the exports can
// be tried without BLAST. Five records:
//
//   inat:1001  plate1-A01 + plate1-A02, nanopore: validated as Russula emetica,
//              MycoMap Vision the second source; the sheet gives everything,
//              A02 a GenBank accession
//   OMDL-7     plate1-B01, Sanger: validated as a provisional name; the sheet
//              gives only a geo_loc_name (with a non-ASCII letter) and a month
//   mo:2002    plate1-C01: validated as Amanita muscaria; the sheet gives nothing
//   inat:1003  plate1-D01: held for a person
//   plate1-E01 (no record): rejected
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RecordOutcome } from "./records";
import type { RunStamp, SequenceOutcome } from "./run";

/** A made-up ITS-length sequence, the same every run. */
export function fixtureBases(seed: number, length = 560): string {
  let x = seed;
  let out = "";
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += "ACGT"[(x >> 16) & 3];
  }
  return out;
}

export const FIXTURE_STAMP: RunStamp = {
  tool: "mycomap-validation",
  engineVersion: "2.0.0-test",
  ranAt: "2026-11-20T16:25:00.000Z",
  blast: "2.17.0",
  blastSource: "installed by init",
  databases: {
    mycomap: { version: "2026-11-20", namesTable: "mycomap_sequences_2026-11-20.tsv.gz", rows: 5 },
    ncbi: { version: "2026-11-16", databases: ["genbank_its", "refseq_its"] },
  },
  settings: { hitsPerSequence: 500, threads: 1 },
};

function outcome(id: string, species: string | null, confidence: number | null, readCount: number | null): SequenceOutcome {
  return {
    id, recordName: null, readCount, length: 560, mycomapHits: [], ncbiHits: [], mycomapHitCount: 3, ncbiHitCount: 4,
    result: {
      status: "complete", steps: [], finalSpecies: species, finalConfidence: confidence, confidenceBreakdown: null,
      flaggedContaminant: species === null, flaggedNonTarget: false, skipped: false, barcodeGapNeeded: false,
      localConsensusSpecies: species, localConsensusCount: species ? 3 : 0, localConsensusTotalWithSpecies: species ? 3 : 0, localConsensusThreshold: species ? 99.5 : null,
      ncbiConsensusSpecies: species, ncbiConsensusCount: species ? 4 : 0, ncbiConsensusTotalWithSpecies: species ? 5 : 0, ncbiConsensusThreshold: species ? 99 : null,
    } as SequenceOutcome["result"],
  };
}

const VISION_NOT_ASKED: RecordOutcome["vision"] = {
  status: "not_asked", by: null, words: "MycoMap Vision was not asked (no Vision key was given)", top: null, gate: null, model: null, answersVersion: null, kept: false,
};

/** MycoMap Vision's answer for inat:1001's photos. */
export const FIXTURE_VISION_ANSWER: RecordOutcome["vision"] = {
  status: "answered", by: "observation", words: null, top: "Russula emetica 62%; genus Russula 91%; family Russulaceae 97%",
  gate: "fungus", model: "vision-test-1", answersVersion: "answers-test-1", kept: false,
};

function record(r: Partial<RecordOutcome> & Pick<RecordOutcome, "record" | "sequenceIds" | "decision">): RecordOutcome {
  return { observerName: null, species: null, selectedSequenceId: null, agreeingSequenceIds: [], secondSource: null, reason: "", setAsideSequenceIds: [], vision: VISION_NOT_ASKED, log: [], ...r };
}

export const FIXTURE_SEQUENCES: SequenceOutcome[] = [
  outcome("plate1-A01", "Russula emetica", 92, 40),
  outcome("plate1-A02", "Russula emetica", 88, 12),
  outcome("plate1-B01", 'Cortinarius "sp-IN02"', 85, null),
  outcome("plate1-C01", "Amanita muscaria", 95, 30),
  outcome("plate1-D01", "Lactarius deliciosus", 64, 25),
  outcome("plate1-E01", null, null, 30),
];

export const FIXTURE_RECORDS: RecordOutcome[] = [
  record({
    record: "inat:1001", sequenceIds: ["plate1-A01", "plate1-A02"], observerName: "Russula emetica", decision: "validate", species: "Russula emetica",
    selectedSequenceId: "plate1-A01", agreeingSequenceIds: ["plate1-A01", "plate1-A02"], secondSource: "MycoMap Vision shows Russula emetica at 62%",
    reason: "Validated as Russula emetica, carried by plate1-A01; second source: MycoMap Vision shows Russula emetica at 62%.",
    vision: FIXTURE_VISION_ANSWER,
  }),
  record({
    record: "OMDL-7", sequenceIds: ["plate1-B01"], observerName: "Cortinarius", decision: "validate", species: 'Cortinarius "sp-IN02"',
    selectedSequenceId: "plate1-B01", agreeingSequenceIds: ["plate1-B01"], reason: 'Validated as Cortinarius "sp-IN02", carried by plate1-B01.',
  }),
  record({
    record: "mo:2002", sequenceIds: ["plate1-C01"], observerName: "Amanita", decision: "validate", species: "Amanita muscaria",
    selectedSequenceId: "plate1-C01", agreeingSequenceIds: ["plate1-C01"], reason: "Validated as Amanita muscaria, carried by plate1-C01.",
  }),
  record({ record: "inat:1003", sequenceIds: ["plate1-D01"], observerName: "Lactarius", decision: "held", reason: "Held: below 70% confidence." }),
  record({ record: "plate1-E01", sequenceIds: ["plate1-E01"], decision: "reject", reason: "Rejected: every read of the record is a contaminant or another organism than the specimen." }),
];

export const FIXTURE_FASTA = FIXTURE_SEQUENCES.map((s, i) => `>${s.id}${s.readCount === null ? "" : ` ric=${s.readCount}`}\n${fixtureBases(i + 1)}\n`).join("");

export const FIXTURE_SHEET = [
  "sequence,record,name,country,state_province,county,locality,latitude,longitude,collection_date,collected_by,specimen_voucher,fwd_primer,rev_primer,genbank_accession,geo_loc_name",
  "plate1-A01,inat:1001,Russula emetica,USA,Michigan,Marquette County,Marquette,46.5436,-87.3954,2026-07-18,iNaturalist User: a-collector,MICH 12345,ITS1F,ITS4,,",
  "plate1-A02,inat:1001,Russula emetica,,,,,,,,,,ITS1F,ITS4,PQ000002,",
  "plate1-B01,OMDL-7,Cortinarius,,,,,,,2025-09,,,,,,Czech Republic: Šumava",
  "plate1-C01,mo:2002,Amanita,,,,,,,,,,,,,",
  "plate1-D01,inat:1003,Lactarius,,,,,,,,,,,,,",
  "plate1-E01,,,,,,,,,,,,,,,",
].join("\n") + "\n";

export interface FixtureOptions {
  /** How the run kept its inputs: as `run` does (default), as an older version's browser app did, or not at all. */
  inputs?: "kept" | "browser" | "none";
  /** Whether GenBank's fungal ITS was searched. */
  ncbi?: boolean;
  sheet?: string;
}

/** Writes the run folder into `dir` and returns its path. */
export function makeRunFolder(dir: string, opts: FixtureOptions = {}): string {
  const folder = path.join(dir, "plate1_mycomap-validation");
  fs.mkdirSync(folder, { recursive: true });
  const inputs = opts.inputs ?? "kept";
  const stamp = opts.ncbi === false ? { ...FIXTURE_STAMP, databases: { ...FIXTURE_STAMP.databases, ncbi: null } } : FIXTURE_STAMP;
  const results: Record<string, unknown> = { ...stamp, sequences: FIXTURE_SEQUENCES, records: FIXTURE_RECORDS };
  if (inputs === "kept") {
    fs.writeFileSync(path.join(folder, "input_plate1.fasta"), FIXTURE_FASTA);
    fs.writeFileSync(path.join(folder, "input_plate1_sheet.csv"), opts.sheet ?? FIXTURE_SHEET);
    results.inputFiles = { fasta: "input_plate1.fasta", records: "input_plate1_sheet.csv" };
  } else if (inputs === "browser") {
    fs.writeFileSync(path.join(folder, "input_plate_1.fasta"), FIXTURE_FASTA);
    fs.writeFileSync(path.join(folder, "input_sheet.csv"), opts.sheet ?? FIXTURE_SHEET);
    results.input = { fasta: "plate 1.fasta", records: "sheet.csv" };
  }
  fs.writeFileSync(path.join(folder, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  return folder;
}

export function inTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmv export "));
  return Promise.resolve().then(() => fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}
