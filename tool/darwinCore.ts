// The Darwin Core export: an occurrence CSV with one row per validated record,
// for GBIF, a herbarium's database or a project's data paper. The column
// names are Darwin Core terms (https://dwc.tdwg.org/terms/), checked against
// the standard's list of terms of 2026-10-13:
//
//   occurrenceID       the record's iNaturalist or Mushroom Observer address,
//                      else the record as the sheet names it
//   basisOfRecord      PreservedSpecimen when the sheet gives a specimen
//                      voucher, else MaterialSample (the sequenced material)
//   catalogNumber      the specimen voucher
//   recordedBy, eventDate, country, stateProvince, county, locality,
//   decimalLatitude, decimalLongitude
//                      the sheet's collector, collection date and place
//   kingdom            Fungi
//   scientificName     the DNA's species, as the tool validated it
//   previousIdentifications  the observer's identification (the sheet's name)
//   identifiedBy       the tool and its version
//   dateIdentified     the day of the run
//   identificationReferences  the databases and their dates, BLAST+, and
//                      MycoMap Vision's model when it answered for the record
//   identificationRemarks     the decision in a sentence, and the confidence
//   associatedSequences       the reads that name the species: their GenBank
//                      accessions where the sheet gives them, else their names
//
// Only validated records are written: a held or rejected record has no name
// to give.
import type { SampleDetails } from "./fasta";
import { calendarDate, cleanCollector, insdcCountry } from "./genbankRules";
import type { RecordOutcome } from "./records";
import { csvText, identifiedByTool, recordDetails, recordLink, type LoadedRun } from "./runFolder";

export const DWC_COLUMNS = [
  "occurrenceID", "basisOfRecord", "catalogNumber", "recordedBy", "eventDate",
  "country", "stateProvince", "county", "locality", "decimalLatitude", "decimalLongitude",
  "kingdom", "scientificName", "previousIdentifications",
  "identifiedBy", "dateIdentified", "identificationReferences", "identificationRemarks", "associatedSequences",
] as const;

export type DwcRow = Record<(typeof DWC_COLUMNS)[number], string>;

export interface DarwinCoreExport {
  csv: string;
  rows: DwcRow[];
  /** What the rows lack, record by record, in words: for the report. */
  missing: Array<{ record: string; missing: string[] }>;
  /** Other things worth knowing, for the report. */
  notes: string[];
}

/** Darwin Core's list separator. */
const LIST = " | ";

function coordinate(value: string | undefined, limit: number): string | null {
  if (value === undefined || !/^-?\d+(\.\d+)?$/.test(value.trim())) return null;
  return Math.abs(Number(value)) <= limit ? value.trim() : null;
}

/** The country as written, or the one a geo_loc_name starts with. */
function countryOf(d: SampleDetails): string {
  if (d.country) return d.country;
  const head = d.geoLocName?.split(":")[0];
  return (head && insdcCountry(head)) ?? "";
}

export function darwinCoreRow(run: LoadedRun, record: RecordOutcome): { row: DwcRow; missing: string[]; localNames: number } {
  const d = recordDetails(run, record);
  const missing: string[] = [];
  const eventDate = calendarDate(d.collectionDate) ?? "";
  if (!d.collectionDate) missing.push("collection date (column collection_date)");
  else if (!eventDate) missing.push(`a collection date that reads as one ("${d.collectionDate}": write 2026-07-18, 2026-07 or 2026)`);
  const country = countryOf(d);
  if (!country) missing.push("country (column country)");
  const lat = coordinate(d.latitude, 90);
  const lon = coordinate(d.longitude, 180);
  if (d.latitude === undefined && d.longitude === undefined) missing.push("coordinates (columns latitude, longitude)");
  else if (lat === null || lon === null) missing.push(`coordinates in decimal degrees ("${d.latitude ?? ""}", "${d.longitude ?? ""}")`);

  const agreeing = record.agreeingSequenceIds.length ? record.agreeingSequenceIds : [record.selectedSequenceId!];
  const sequences = agreeing.map((id) => run.reads.get(id)?.details.accession ?? id);
  const localNames = agreeing.filter((id) => !run.reads.get(id)?.details.accession).length;
  const selected = record.selectedSequenceId ? run.sequences.get(record.selectedSequenceId) : undefined;
  const confidence = selected?.result.finalConfidence;
  const s = run.stamp;
  const row: DwcRow = {
    occurrenceID: recordLink(record.record).url ?? record.record,
    basisOfRecord: d.specimenVoucher ? "PreservedSpecimen" : "MaterialSample",
    catalogNumber: d.specimenVoucher ?? "",
    // Without iNaturalist's "iNaturalist User:" label, as the GenBank export writes it.
    recordedBy: d.collectedBy ? cleanCollector(d.collectedBy) || d.collectedBy : "",
    eventDate,
    country,
    stateProvince: d.stateProvince ?? "",
    county: d.county ?? "",
    locality: d.locality ?? "",
    decimalLatitude: lat !== null && lon !== null ? lat : "",
    decimalLongitude: lat !== null && lon !== null ? lon : "",
    kingdom: "Fungi",
    scientificName: record.species ?? "",
    previousIdentifications: record.observerName ?? "",
    identifiedBy: identifiedByTool(s),
    dateIdentified: s.ranAt.slice(0, 10),
    identificationReferences: [
      `MycoMap reference sequences ${s.databases.mycomap.version ?? "of unknown date"} (https://mycomap.org/data-downloads)`,
      s.databases.ncbi ? `GenBank fungal ITS ${s.databases.ncbi.version ?? "of unknown date"}` : "GenBank fungal ITS not searched",
      `BLAST+ ${s.blast}`,
      // Only for a record Vision answered for (runs made before the tool asked Vision have no vision).
      ...(record.vision?.status === "answered" ? [`MycoMap Vision ${record.vision.model ?? "(model not given)"}${record.vision.answersVersion ? `, answers ${record.vision.answersVersion}` : ""}`] : []),
      "MycoMap Validation (https://github.com/BiodiverseLabs/mycomap-validation)",
    ].join(LIST),
    identificationRemarks: `${record.reason}${confidence == null ? "" : ` ITS sequence ${record.selectedSequenceId}: ${confidence}% confidence.`}`,
    associatedSequences: sequences.join(LIST),
  };
  return { row, missing, localNames };
}

export function buildDarwinCore(run: LoadedRun): DarwinCoreExport {
  const validated = run.records.filter((r) => r.decision === "validate" && r.species);
  const rows: DwcRow[] = [];
  const missing: DarwinCoreExport["missing"] = [];
  let localNames = 0;
  for (const record of validated) {
    const one = darwinCoreRow(run, record);
    rows.push(one.row);
    localNames += one.localNames;
    if (one.missing.length) missing.push({ record: record.record, missing: one.missing });
  }
  const notes: string[] = [];
  const left = run.records.length - validated.length;
  if (left) notes.push(`${left} record${left === 1 ? " was" : "s were"} not validated (held or rejected), so ${left === 1 ? "it is" : "they are"} not in the file.`);
  if (localNames) notes.push(`associatedSequences names ${localNames} read${localNames === 1 ? "" : "s"} by ${localNames === 1 ? "its" : "their"} FASTA name: add a genbank_accession column to the sheet once GenBank gives the accessions.`);
  return { csv: csvText([DWC_COLUMNS, ...rows.map((r) => DWC_COLUMNS.map((c) => r[c]))]), rows, missing, notes };
}
