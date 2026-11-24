// Reads the sequences to check: a FASTA file, and optionally a sheet that gives
// each sequence its record's name (the observer's identification) and read
// count. Every problem is said in plain words, with the line it is on.

export interface QuerySequence {
  /** The id: the header up to the first space. BLAST names its results by it. */
  id: string;
  /** The rest of the header line. */
  description: string;
  bases: string;
  /** The record's name: from the sheet, or null. */
  recordName: string | null;
  /**
   * Reads in the consensus (RiC) for a nanopore read: from the sheet, or a
   * `ric=40` / `reads=40` word on the header line (Specimux writes ric=); null
   * for a Sanger read.
   */
  readCount: number | null;
  /**
   * The record (specimen or observation) the sequence belongs to, from the
   * sheet's record column: sequences that share one are one record's reads.
   * Null: the sequence is a record of its own.
   */
  record: string | null;
  /** A folder of the record's photos for MycoMap Vision, from the sheet's photos column; null when none. */
  photos?: string | null;
  /** What the sheet says about where and when it was collected, for the exports (export.ts). */
  details?: SampleDetails;
}

/**
 * The sheet's optional columns for the files people submit (GenBank, Darwin
 * Core): each is the text as written, or absent.
 */
export interface SampleDetails {
  isolate?: string;
  specimenVoucher?: string;
  country?: string;
  stateProvince?: string;
  county?: string;
  locality?: string;
  geoLocName?: string;
  latitude?: string;
  longitude?: string;
  collectionDate?: string;
  collectedBy?: string;
  identifiedBy?: string;
  fwdPrimer?: string;
  revPrimer?: string;
  note?: string;
  accession?: string;
}

/**
 * The column names each detail is read from (lower case, spaces as "_"). The
 * first is the one the README gives; the others are what people often call it
 * (Darwin Core's and GenBank's own names among them).
 */
export const DETAIL_COLUMNS: Record<keyof SampleDetails, string[]> = {
  isolate: ["isolate"],
  specimenVoucher: ["specimen_voucher", "catalog_number", "catalognumber"],
  country: ["country"],
  stateProvince: ["state_province", "stateprovince", "state", "province", "region"],
  county: ["county"],
  locality: ["locality", "place"],
  geoLocName: ["geo_loc_name"],
  latitude: ["latitude", "decimal_latitude", "decimallatitude", "lat"],
  longitude: ["longitude", "decimal_longitude", "decimallongitude", "lon", "lng", "long"],
  collectionDate: ["collection_date", "date", "event_date", "eventdate", "observed_on"],
  collectedBy: ["collected_by", "collector", "recorded_by", "recordedby"],
  identifiedBy: ["identified_by", "identifiedby"],
  fwdPrimer: ["fwd_primer", "fwd_primer_name", "forward_primer"],
  revPrimer: ["rev_primer", "rev_primer_name", "reverse_primer"],
  note: ["note", "notes"],
  accession: ["genbank_accession", "accession"],
};

/** A file the tool cannot read as given: the message says what to change. */
export class InputError extends Error {}

const BASES = /^[ACGTURYSWKMBDHVN.-]+$/i;
const READ_COUNT_WORD = /(?:^|\s)(?:ric|reads)=(\d+)(?=\s|$)/i;

/** The sequences in a FASTA file, in order. */
export function readFasta(text: string, fileLabel = "the FASTA file"): QuerySequence[] {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const sequences: QuerySequence[] = [];
  let current: { id: string; description: string; parts: string[]; line: number } | null = null;
  const finish = () => {
    if (!current) return;
    const bases = current.parts.join("").replace(/\s+/g, "");
    if (!bases) throw new InputError(`${fileLabel}, line ${current.line}: "${current.id}" has no bases under its header.`);
    if (!BASES.test(bases)) {
      const bad = [...new Set(bases.replace(/[ACGTURYSWKMBDHVN.-]/gi, ""))].slice(0, 5).join(" ");
      throw new InputError(`${fileLabel}: "${current.id}" has characters that are not DNA bases (${bad}). Only A C G T, IUPAC ambiguity codes and gaps are read.`);
    }
    const count = READ_COUNT_WORD.exec(current.description)?.[1];
    sequences.push({ id: current.id, description: current.description, bases: bases.toUpperCase().replace(/[.-]/g, "").replace(/U/g, "T"), recordName: null, readCount: count ? Number(count) : null, record: null });
    current = null;
  };
  lines.forEach((line, at) => {
    if (line.startsWith(">")) {
      finish();
      const header = line.slice(1).trim();
      const id = header.split(/\s+/)[0] ?? "";
      if (!id) throw new InputError(`${fileLabel}, line ${at + 1}: a header with no name. Write one after the ">", for example ">my-specimen-1".`);
      current = { id, description: header.slice(id.length).trim(), parts: [], line: at + 1 };
    } else if (line.trim()) {
      if (!current) throw new InputError(`${fileLabel}, line ${at + 1}: bases before the first header. A FASTA file starts with a line like ">my-specimen-1".`);
      current.parts.push(line.trim());
    }
  });
  finish();
  if (sequences.length === 0) throw new InputError(`${fileLabel} has no sequences. Each one is a header line starting with ">" and the bases under it.`);
  const seen = new Set<string>();
  for (const s of sequences) {
    if (seen.has(s.id)) throw new InputError(`${fileLabel}: two sequences are called "${s.id}". BLAST names its results by the first word of the header, so each must be different.`);
    seen.add(s.id);
  }
  return sequences;
}

export interface RecordRow {
  name: string | null;
  readCount: number | null;
  record?: string | null;
  photos?: string | null;
  details?: SampleDetails;
}

/** Splits one line of a CSV (quotes allowed) or a TSV. */
export function splitLine(line: string, separator: "," | "\t"): string[] {
  if (separator === "\t") return line.split("\t").map((v) => v.trim());
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(field.trim()); field = ""; }
    else field += c;
  }
  out.push(field.trim());
  return out;
}

const ID_COLUMNS = ["sequence", "sequence_id", "id", "fasta_id", "header"];
const NAME_COLUMNS = ["name", "record_name", "identification", "scientific_name", "taxon"];
const READ_COLUMNS = ["reads", "ric", "read_count", "reads_in_consensus"];
const RECORD_COLUMNS = ["record", "record_id", "specimen", "observation", "voucher"];
const PHOTOS_COLUMNS = ["photos", "photos_folder", "photo_folder"];

/**
 * A sheet of records (CSV, or TSV when the header has tabs): one row per
 * sequence, with a column for the FASTA id (sequence, id), the record's name
 * (name, identification, scientific_name) and optionally the read count
 * (reads, ric) and the record it belongs to (record, specimen, observation:
 * sequences that share one are one record's reads), and a folder of the
 * record's photos for MycoMap Vision (photos). Column names are read
 * without regard to case. The optional columns in DETAIL_COLUMNS (country,
 * collection_date, specimen_voucher…) are kept for the exports.
 */
export function readRecordsSheet(text: string, fileLabel = "the records sheet"): Map<string, RecordRow> {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  if (lines.length === 0) throw new InputError(`${fileLabel} is empty.`);
  const separator = lines[0].includes("\t") ? "\t" : ",";
  const header = splitLine(lines[0], separator).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  const find = (names: string[]) => header.findIndex((h) => names.includes(h));
  const idAt = find(ID_COLUMNS);
  const nameAt = find(NAME_COLUMNS);
  const readsAt = find(READ_COLUMNS);
  // The first of the record names the header has ("voucher" counts only when no other record column is there).
  const recordAt = RECORD_COLUMNS.map((n) => header.indexOf(n)).find((at) => at >= 0) ?? -1;
  const photosAt = find(PHOTOS_COLUMNS);
  const detailAt = Object.entries(DETAIL_COLUMNS).map(([key, names]) => [key, find(names)] as const).filter(([, at]) => at >= 0);
  if (idAt < 0) throw new InputError(`${fileLabel}: no column for the sequence. Name one "sequence" (the FASTA id, the header up to the first space).`);
  if (nameAt < 0 && readsAt < 0 && recordAt < 0 && photosAt < 0 && detailAt.length === 0) throw new InputError(`${fileLabel}: no "name" column (the record's identification), no "reads" column and no "record" column, so there is nothing to add.`);
  const rows = new Map<string, RecordRow>();
  lines.slice(1).forEach((line, at) => {
    const values = splitLine(line, separator);
    const id = values[idAt]?.trim();
    if (!id) return;
    if (rows.has(id)) throw new InputError(`${fileLabel}, line ${at + 2}: "${id}" is listed twice.`);
    const readsText = readsAt >= 0 ? values[readsAt]?.trim() : "";
    if (readsText && !/^\d+$/.test(readsText)) throw new InputError(`${fileLabel}, line ${at + 2}: the read count "${readsText}" is not a whole number.`);
    const details: SampleDetails = {};
    for (const [key, at] of detailAt) {
      const value = values[at]?.trim();
      if (value) details[key as keyof SampleDetails] = value;
    }
    rows.set(id, {
      name: nameAt >= 0 ? values[nameAt]?.trim() || null : null,
      readCount: readsText ? Number(readsText) : null,
      record: recordAt >= 0 ? values[recordAt]?.trim() || null : null,
      ...(photosAt >= 0 ? { photos: values[photosAt]?.trim() || null } : {}),
      ...(Object.keys(details).length ? { details } : {}),
    });
  });
  return rows;
}

/** The sequences with the sheet's names and read counts on them; a sheet row with no sequence is an error. */
export function withRecords(sequences: QuerySequence[], sheet: Map<string, RecordRow> | null, fileLabel = "the records sheet"): QuerySequence[] {
  if (!sheet) return sequences;
  const ids = new Set(sequences.map((s) => s.id));
  const unknown = [...sheet.keys()].filter((id) => !ids.has(id));
  if (unknown.length) throw new InputError(`${fileLabel} lists ${unknown.length === 1 ? "a sequence" : `${unknown.length} sequences`} the FASTA file does not have: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ", …" : ""}. The ids must match the FASTA headers up to the first space.`);
  return sequences.map((s) => {
    const row = sheet.get(s.id);
    return row ? { ...s, recordName: row.name ?? s.recordName, readCount: row.readCount ?? s.readCount, record: row.record ?? s.record, ...(row.photos ? { photos: row.photos } : {}), ...(row.details ? { details: row.details } : {}) } : s;
  });
}
