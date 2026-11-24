// Reads MycoMap's names table (mycomap_sequences_<date>.tsv.gz on the Data
// Downloads page: one row per sequence in the BLAST database) into the records
// the engine asks for about each MycoMap hit, and the family of each genus.
//
// The table is large (hundreds of thousands of rows), so it is read as a
// stream and only the rows BLAST hit are kept.
import fs from "node:fs";
import readline from "node:readline";
import zlib from "node:zlib";
import type { SequenceRecord } from "../src/analysisRules";
import { InputError } from "./fasta";

/** The columns the tool reads (the table has more). */
const NEEDED = ["mm_id", "name", "family", "genus", "method", "on_validated_record", "flags", "reads_in_consensus", "observation"] as const;
/** Read when the table has it: tables built before 2026-11-21 do not. */
const OPTIONAL = ["validation"] as const;
const VALIDATIONS = new Set(["verified", "rejected", "not_assessed"]);

/** The sequencing method a row gives, as MycoMap's sequence category. */
const CATEGORY: Record<string, { id: number; name: string }> = {
  sanger: { id: 132, name: "Sanger Sequences" },
  mushroom_observer: { id: 165, name: "Mushroom Observer" },
  inaturalist: { id: 167, name: "iNaturalist" },
  ont: { id: 168, name: "ONT Sequences" },
};

export interface NamesTable {
  /** The records of the sequences asked for, by their BLAST id (MM123). */
  records: Map<string, SequenceRecord>;
  /** Each genus's family: the one most rows of that genus carry. */
  families: Map<string, string>;
  rows: number;
}

/** One row of the table as the engine's record of a MycoMap sequence. */
export function sequenceRecordFromRow(row: Record<string, string>): SequenceRecord {
  const name = row.name?.trim() || null;
  // The sequence's own validation, as mycomap.org counts a hit: verified when the sequence or its
  // observation is. An older table has only on_validated_record (the sequence a validated record
  // names), which leaves out the other reads of a validated specimen.
  const given = row.validation?.trim();
  const status = given && VALIDATIONS.has(given) ? given : row.on_validated_record === "yes" ? "verified" : "unverified";
  const validated = status === "verified";
  const observation = row.observation?.trim() || null;
  const platform = observation ? /^(inat|mo):(\d+)$/.exec(observation) : null;
  const category = CATEGORY[row.method?.trim() ?? ""] ?? null;
  const reads = row.reads_in_consensus?.trim();
  return {
    id: row.mm_id,
    scientificName: name,
    validated,
    validationStatus: status,
    // "[]" is the record store's empty list, written as a flag by tables built before 2026-11-21.
    flags: (row.flags ?? "").split(",").map((f) => f.trim()).filter((f) => f && f !== "[]"),
    species: { sequence: name, parent: null },
    // The specimen a hit comes from: two reads of one observation are one specimen's vote.
    observationId: observation,
    categoryId: category?.id ?? null,
    categoryName: category?.name ?? null,
    ric: reads && /^\d+$/.test(reads) ? Number(reads) : null,
    inatObservationId: platform?.[1] === "inat" ? Number(platform[2]) : null,
    moObservationId: platform?.[1] === "mo" ? Number(platform[2]) : null,
  };
}

/** Reads the table's lines (gzipped or not) and keeps the rows for `wanted`. */
export async function readNamesTable(file: string, wanted: ReadonlySet<string>): Promise<NamesTable> {
  const raw = fs.createReadStream(file);
  const input = file.endsWith(".gz") ? raw.pipe(zlib.createGunzip()) : raw;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  return namesTableFromLines(lines, wanted, file);
}

/** The table from its lines, the header first. */
export async function namesTableFromLines(lines: AsyncIterable<string> | Iterable<string>, wanted: ReadonlySet<string>, label = "the names table"): Promise<NamesTable> {
  const records = new Map<string, SequenceRecord>();
  const familyCounts = new Map<string, Map<string, number>>();
  let header: string[] | null = null;
  let at: Record<string, number> = {};
  let rows = 0;
  try {
    for await (const line of lines as AsyncIterable<string>) {
      if (!line) continue;
      const cells = line.split("\t");
      if (!header) {
        header = cells.map((c) => c.trim().replace(/^﻿/, ""));
        const missing = NEEDED.filter((c) => !header!.includes(c));
        if (missing.length) throw new InputError(`${label} is not MycoMap's names table: it has no ${missing.join(", ")} column${missing.length === 1 ? "" : "s"}. Use mycomap_sequences_<date>.tsv.gz from https://mycomap.org/data-downloads.`);
        at = Object.fromEntries(header.map((c, i) => [c, i]));
        continue;
      }
      rows++;
      const genus = cells[at.genus]?.trim();
      const family = cells[at.family]?.trim();
      if (genus && family) {
        const counts = familyCounts.get(genus) ?? new Map<string, number>();
        counts.set(family, (counts.get(family) ?? 0) + 1);
        familyCounts.set(genus, counts);
      }
      const id = cells[at.mm_id]?.trim();
      if (id && wanted.has(id)) {
        records.set(id, sequenceRecordFromRow(Object.fromEntries([...NEEDED, ...OPTIONAL].map((c) => [c, at[c] === undefined ? "" : cells[at[c]] ?? ""]))));
      }
    }
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(`${label} could not be read (${(error as Error).message}). Download it again: the file may be cut short.`);
  }
  if (!header) throw new InputError(`${label} is empty.`);
  const families = new Map<string, string>();
  for (const [genus, counts] of familyCounts) {
    // The most common family; a tie goes to the name first in alphabetical order, so a run is repeatable.
    const best = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    families.set(genus, best[0]);
  }
  return { records, families, rows };
}
