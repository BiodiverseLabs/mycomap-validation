// The GenBank submission files for NCBI's Submission Portal: a FASTA file and
// a source-modifier table, one line per validated record, in the shape
// mycomap.org's GenBank export writes them (same columns, same text rules:
// genbankRules.ts). The line is the read that stands for the record, the one
// mycomap.org would submit.
//
//   Sequence_ID       the read's FASTA name (it links NCBI's accession report
//                     back to the run)
//   organism          the validated species; a provisional name
//                     `Genus "sp-XX01"` goes as `Genus sp. 'XX01'`
//   isolate           the sheet's isolate, else the record (when the sheet
//                     gives one)
//   specimen_voucher  the sheet's specimen voucher
//   geo_loc_name      the sheet's geo_loc_name, else its country, state or
//                     province, county and locality ("USA: Michigan, Marquette
//                     County, Marquette")
//   lat_lon           the sheet's latitude and longitude ("46.5436 N 87.3954 W")
//   collection_date   the sheet's collection date (18-Jul-2026, Jul-2026, 2026)
//   collected_by      the sheet's collector
//   fwd_primer_name, rev_primer_name  the sheet's primers
//   note              the sheet's note, "Identified by" (the sheet's
//                     identified_by, else the tool and its version) and the
//                     read's RiC when it has a read count
//
// NCBI needs an organism, a location, a collection date and an isolate or
// voucher. A record without them is left out, and the report says what to
// add to the sheet.
import { createHash } from "node:crypto";
import {
  cleanCollector, composeNote, formatCollectionDate, formatLatLon, formatOrganism, geoLocNameFromParts,
  normalizeGeoLocName, toAscii, trimAmbiguousEnds,
} from "./genbankRules";
import type { RecordOutcome } from "./records";
import { identifiedByTool, recordDetails, type LoadedRun } from "./runFolder";

export const SOURCE_MODIFIER_HEADER = [
  "Sequence_ID", "organism", "isolate", "specimen_voucher", "geo_loc_name", "lat_lon",
  "collection_date", "collected_by", "fwd_primer_name", "rev_primer_name", "note",
] as const;

export type SourceColumns = Record<(typeof SOURCE_MODIFIER_HEADER)[number], string>;

export interface GenbankLine {
  record: string;
  columns: SourceColumns;
  sequence: string;
  sequenceMd5: string;
}

export interface GenbankExport {
  fasta: string;
  tsv: string;
  lines: GenbankLine[];
  /** Validated records left out, with everything they lack. */
  leftOut: Array<{ record: string; sequence: string | null; missing: string[] }>;
  /** Lines that go, with something worth checking. */
  warnings: Array<{ record: string; sequence: string; message: string }>;
  notes: string[];
}

/** NCBI's rule for a Sequence_ID: under 50 characters, letters, digits and - _ . : * # only. */
export const SEQUENCE_ID = /^[A-Za-z0-9_.:*#-]{1,49}$/;
const IUPAC = /^[ACGTRYSWKMBDHVN]+$/;

interface Draft {
  record: RecordOutcome;
  /** Before isolate and voucher repeats are numbered. */
  columns: SourceColumns;
  sequence: string;
  warnings: string[];
}

/** One validated record's line, or what it lacks. */
export function genbankDraft(run: LoadedRun, record: RecordOutcome): Draft | { missing: string[] } {
  const missing: string[] = [];
  const warnings: string[] = [];
  const id = record.selectedSequenceId;
  const read = id ? run.reads.get(id) : undefined;
  if (!id || !read) return { missing: ["a read that stands for the record"] };
  const d = recordDetails(run, record);

  if (!SEQUENCE_ID.test(id)) missing.push(`a Sequence_ID NCBI takes: rename the read "${id}" in the FASTA file and the sheet (under 50 characters: letters, digits and - _ . : * # only)`);
  const organism = formatOrganism(toAscii(record.species).text);
  if (!organism) missing.push("an organism name");

  const isolate = toAscii(d.isolate ?? (record.record !== id ? record.record : "")).text;
  const voucher = toAscii(d.specimenVoucher).text;
  if (!isolate && !voucher) missing.push("an isolate or specimen voucher (column isolate or specimen_voucher; or a record column, whose name is then the isolate)");

  let geo: { value: string; problem: string | null };
  if (d.geoLocName) geo = normalizeGeoLocName(d.geoLocName, d.country ?? null);
  else if (d.country || d.stateProvince) geo = normalizeGeoLocName(geoLocNameFromParts({ country: d.country ?? null, region: d.stateProvince ?? null, county: d.county ?? null, city: d.locality ?? null }), d.country ?? null);
  else geo = { value: "", problem: null };
  if (!geo.value) missing.push("a location (column country, with state_province, county and locality; or geo_loc_name)");
  else if (geo.problem) missing.push(`a location NCBI takes: ${geo.problem}`);

  const date = formatCollectionDate(d.collectionDate);
  if (!d.collectionDate) missing.push("a collection date (column collection_date: 2026-07-18, 2026-07 or 2026)");
  else if (!date) missing.push(`a collection date NCBI takes ("${d.collectionDate}" is not one: write 2026-07-18, 2026-07 or 2026)`);

  const latLon = formatLatLon(d.latitude, d.longitude);
  if ((d.latitude || d.longitude) && !latLon) warnings.push(`lat_lon left empty: "${d.latitude ?? ""}", "${d.longitude ?? ""}" are not coordinates in decimal degrees`);

  const trim = trimAmbiguousEnds(read.bases);
  if (!trim.sequence) missing.push("bases (nothing is left once the ambiguous ends are trimmed)");
  else if (!IUPAC.test(trim.sequence)) missing.push("bases NCBI takes (only A C G T and IUPAC codes)");
  else if (trim.sequence.length < 200) warnings.push(`${trim.sequence.length} bases: NCBI asks for at least 200`);
  if (trim.trimmedStart || trim.trimmedEnd) {
    const parts = [trim.trimmedStart && `${trim.trimmedStart.length} from the start (${trim.trimmedStart})`, trim.trimmedEnd && `${trim.trimmedEnd.length} from the end (${trim.trimmedEnd})`].filter(Boolean);
    warnings.push(`trimmed ${parts.join(" and ")}: ambiguous bases at the ends`);
  }
  if (trim.problem) warnings.push(trim.problem);
  if (missing.length) return { missing };

  for (const [column, text] of Object.entries({ isolate: d.isolate, specimen_voucher: d.specimenVoucher, collected_by: d.collectedBy, note: d.note })) {
    const ascii = toAscii(text);
    if (text && ascii.changed) warnings.push(`${column} sent as plain ASCII: "${ascii.text}"`);
  }
  // A typed geo_loc_name NCBI gets differently (its country name, ASCII), or a place with letters ASCII drops.
  const places = [d.country, d.stateProvince, d.county, d.locality].filter(Boolean).join(", ");
  if (d.geoLocName ? geo.value !== d.geoLocName.replace(/\s*:\s*/, ": ").trim() : toAscii(places).changed) {
    warnings.push(`geo_loc_name sent as "${geo.value}" (NCBI's name for the country, plain ASCII)`);
  }
  const collector = cleanCollector(d.collectedBy);
  if (d.collectedBy && collector !== toAscii(d.collectedBy).text) warnings.push(collector ? `collected_by sent without "iNaturalist User": "${collector}"` : `collected_by "${d.collectedBy}" names no one, so it is left empty`);

  return {
    record,
    sequence: trim.sequence,
    warnings,
    columns: {
      Sequence_ID: id,
      organism,
      isolate,
      specimen_voucher: voucher,
      geo_loc_name: geo.value,
      lat_lon: latLon,
      collection_date: date,
      collected_by: collector,
      fwd_primer_name: toAscii(d.fwdPrimer).text.toUpperCase(),
      rev_primer_name: toAscii(d.revPrimer).text.toUpperCase(),
      note: toAscii(composeNote({ note: toAscii(d.note).text, identifiedBy: toAscii(d.identifiedBy ?? identifiedByTool(run.stamp)).text, ric: read.readCount })).text,
    },
  };
}

/**
 * The two files from a run's validated records: isolate and voucher repeats
 * numbered (2), (3)… as mycomap.org's export numbers them, so NCBI does not
 * refuse a second read of one specimen as a duplicate source.
 */
export function buildGenbank(run: LoadedRun): GenbankExport {
  const validated = run.records.filter((r) => r.decision === "validate" && r.species);
  const lines: GenbankLine[] = [];
  const leftOut: GenbankExport["leftOut"] = [];
  const warnings: GenbankExport["warnings"] = [];
  const isolates = new Map<string, number>();
  const vouchers = new Map<string, number>();
  const numbered = (seen: Map<string, number>, value: string) => {
    if (!value) return value;
    const n = (seen.get(value) ?? 0) + 1;
    seen.set(value, n);
    return n === 1 ? value : `${value}(${n})`;
  };
  const sameAs = new Map<string, string>();
  for (const record of validated) {
    const draft = genbankDraft(run, record);
    if ("missing" in draft) { leftOut.push({ record: record.record, sequence: record.selectedSequenceId, missing: draft.missing }); continue; }
    const columns: SourceColumns = { ...draft.columns, isolate: numbered(isolates, draft.columns.isolate), specimen_voucher: numbered(vouchers, draft.columns.specimen_voucher) };
    const earlier = sameAs.get(draft.sequence);
    if (earlier) draft.warnings.push(`the same bases as ${earlier} (a duplicate sequence)`);
    else sameAs.set(draft.sequence, columns.Sequence_ID);
    for (const message of draft.warnings) warnings.push({ record: record.record, sequence: columns.Sequence_ID, message });
    lines.push({ record: record.record, columns, sequence: draft.sequence, sequenceMd5: createHash("md5").update(draft.sequence).digest("hex") });
  }
  const notes: string[] = [];
  const left = run.records.length - validated.length;
  if (left) notes.push(`${left} record${left === 1 ? " was" : "s were"} not validated (held or rejected), so ${left === 1 ? "it is" : "they are"} not in the files.`);
  const tsv = [SOURCE_MODIFIER_HEADER.join("\t"), ...lines.map((l) => SOURCE_MODIFIER_HEADER.map((h) => l.columns[h]).join("\t"))].join("\n") + "\n";
  const fasta = lines.map((l) => `>${l.columns.Sequence_ID}\n${l.sequence}`).join("\n") + (lines.length ? "\n" : "");
  return { fasta, tsv, lines, leftOut, warnings, notes };
}
