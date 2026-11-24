/**
 * A stray read on a record its other reads name (2026-11-16).
 *
 * Sequence 892545: an 872 bp read on a record whose six full-length reads are
 * all Cantharellus tenuithrix. Nothing named covers more than a third of it,
 * so the analysis left it at "barcode gap analysis needed". Read by itself
 * that is all one can say. Read beside its record it is plainly not the
 * specimen: a contaminant.
 *
 * The rule, for one record's reads analysed together:
 *   - the record has a name: at least two reads name the same species, no read
 *     names another, and one of them reaches the validation threshold;
 *   - the read has none: finished, no species, barcode gap needed, not flagged;
 *   - and it does not align with the specimen: none of the reads that name the
 *     record is among its MycoBLAST hits over most of its length.
 * Then it is flagged as a contaminant. The last condition is what keeps a
 * poor read of the same specimen out: that one still hits its own record's
 * reads end to end, and stays as it is.
 *
 * One more condition, from the primers (2026-11-16: "can tell by the
 * primer linkages?"): a record may also carry reads of another gene region
 * (LSU, TEF1, RPB2) or of a shorter or longer stretch (ITS2 alone, ITS into
 * LSU). Such a read does not align with the ITS reads either, and it is the
 * specimen. So a read is compared only with reads made with the same primer
 * pair: the reads of that pair must name the record by themselves, and a read
 * whose primers are not known is left as it is.
 *
 * A contaminant also gets what it most likely is (contaminantLikelyName.ts).
 * A stray read usually has no NCBI consensus, so beyond the genus rule there
 * is one more source: the closest NCBI match that covers the read. When that
 * is an uncultured or unnamed fungus the likely name is "Fungi", said plainly
 * as a kingdom and no more.
 */
import { QUERY_COVERAGE_THRESHOLD, type BlastHit } from "./analysisRules";
import { contaminantLikelyName, type ContaminantLikelyName, type ContaminantNameVote } from "./contaminantLikelyName";
import { isPlaceholderOrganismName, isUnculturedName } from "./speciesNames";

/**
 * Where a primer sits, so that two names for the same site compare equal
 * (ITS1F and ITS1Fngs start the same amplicon; so do ITS4 and ITS4ngsUni).
 * Any other primer is its own name; null when there is none.
 */
export function primerSite(name: string | null | undefined): string | null {
  const key = String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return null;
  // The SSU end, before ITS1.
  if (/^(its1|its1f|its1fngs|its1fkyo\d?|its5)$/.test(key)) return "ITS1F";
  // 5.8S, before ITS2.
  if (/^(gits7|gits7ngs|fits7|its3|its3kyo\d?|its86f)$/.test(key)) return "ITS3";
  // The start of the LSU, after ITS2.
  if (/^(its4|its4b|its4ngs|its4ngsuni|its4kyo\d?)$/.test(key)) return "ITS4";
  if (/^(lr0r|lror)$/.test(key)) return "LR0R";
  return key.toUpperCase();
}

/**
 * The amplicon a primer pair makes, as a key two reads can be compared by:
 * "ITS1F/ITS4", "ITS3/ITS4", "LR0R/LR5". Null unless both primers are known:
 * half a pair does not say where the read ends.
 */
export function primerAmplicon(forward: string | null | undefined, reverse: string | null | undefined): string | null {
  const from = primerSite(forward);
  const to = primerSite(reverse);
  return from && to ? `${from}/${to}` : null;
}

/** What the rule reads of a read's analysis. */
export interface RecordReadSummary {
  id: string;
  /** The read's amplicon (primerAmplicon); null or absent when its primers are not known. */
  amplicon?: string | null;
  status?: string | null;
  finalSpecies?: string | null;
  finalConfidence?: number | null;
  flaggedContaminant?: boolean | null;
  flaggedNonTarget?: boolean | null;
  barcodeGapNeeded?: boolean | null;
}

/** How many reads have to name the record before one of its reads can be called stray. */
export const STRAY_READ_MIN_NAMING_READS = 2;
/** One of them has to reach this name confidence (the validation threshold). */
export const STRAY_READ_ANCHOR_CONFIDENCE = 70;

function speciesOf(read: RecordReadSummary): string | null {
  if (read.status !== "complete" || read.flaggedContaminant === true || read.flaggedNonTarget === true) return null;
  const name = typeof read.finalSpecies === "string" ? read.finalSpecies.trim() : "";
  if (!name || /^(contaminant|non-target)\s*:/i.test(name) || name === "Manual Validation Needed" || name === "Singleton Sequence") return null;
  return name;
}

export interface RecordAnchor {
  species: string;
  /** The reads that name it, best confidence first. */
  sequenceIds: string[];
  bestConfidence: number;
}

/** The species the record's reads agree on, or null when they do not give it one. */
export function recordAnchor(reads: RecordReadSummary[]): RecordAnchor | null {
  const naming = reads
    .map((read) => ({ read, species: speciesOf(read) }))
    .filter((entry): entry is { read: RecordReadSummary; species: string } => entry.species !== null);
  if (naming.length < STRAY_READ_MIN_NAMING_READS) return null;
  const key = (name: string) => name.replace(/\s+/g, " ").toLowerCase();
  if (naming.some((entry) => key(entry.species) !== key(naming[0].species))) return null;
  const confidence = (read: RecordReadSummary) => (typeof read.finalConfidence === "number" && Number.isFinite(read.finalConfidence) ? read.finalConfidence : -1);
  const ordered = [...naming].sort((a, b) => confidence(b.read) - confidence(a.read));
  const bestConfidence = confidence(ordered[0].read);
  if (bestConfidence < STRAY_READ_ANCHOR_CONFIDENCE) return null;
  return { species: ordered[0].species, sequenceIds: ordered.map((entry) => entry.read.id), bestConfidence };
}

/** A read the analysis could give no name: finished, no species, barcode gap needed, not flagged. */
export function isUnnamedRead(read: RecordReadSummary): boolean {
  if (read.status !== "complete" || read.flaggedContaminant === true || read.flaggedNonTarget === true) return false;
  const name = typeof read.finalSpecies === "string" ? read.finalSpecies.trim() : "";
  return name === "" && read.barcodeGapNeeded === true;
}

/** Whether any of the record's naming reads is among the read's MycoBLAST hits over most of its length. */
export function alignsWithReads(localHits: BlastHit[], sequenceIds: string[]): boolean {
  const wanted = new Set(sequenceIds.map(String));
  return localHits.some((hit) => wanted.has(String(hit.accession)) && typeof hit.queryCoverage === "number" && hit.queryCoverage >= QUERY_COVERAGE_THRESHOLD);
}

export type StrayReadVerdict =
  | { stray: true; anchor: RecordAnchor; amplicon: string }
  | { stray: false; reason: "read_has_a_name_or_flag" | "record_has_no_name" | "amplicon_unknown" | "another_amplicon" | "aligns_with_the_record" };

/**
 * Whether a read is a stray one on its record. `localHits` are the read's own
 * MycoBLAST hits. The anchor of a stray read is made of the reads it was
 * compared with: those of its own amplicon.
 */
export function strayReadVerdict(input: { read: RecordReadSummary; recordReads: RecordReadSummary[]; localHits: BlastHit[] }): StrayReadVerdict {
  if (!isUnnamedRead(input.read)) return { stray: false, reason: "read_has_a_name_or_flag" };
  const others = input.recordReads.filter((read) => read.id !== input.read.id);
  if (!recordAnchor(others)) return { stray: false, reason: "record_has_no_name" };
  // Without its primers there is no telling a stray read from a read of another region of the same specimen.
  const amplicon = input.read.amplicon ?? null;
  if (!amplicon) return { stray: false, reason: "amplicon_unknown" };
  const anchor = recordAnchor(others.filter((read) => read.amplicon === amplicon));
  if (!anchor) return { stray: false, reason: "another_amplicon" };
  if (alignsWithReads(input.localHits, anchor.sequenceIds)) return { stray: false, reason: "aligns_with_the_record" };
  return { stray: true, anchor, amplicon };
}

/** A covering NCBI hit, for the stray read's likely name. */
export interface CoveringNcbiHit {
  accession: string;
  /** The curated name, else the hit's title. */
  name: string | null;
  title: string;
  /** Adjusted identity in percent. */
  identity: number;
  queryCoverage: number;
}

/**
 * What a stray read most likely is. First the contaminant genus rule (named
 * NCBI records at 97% or more agreeing on a genus); else, when the closest
 * NCBI match covering the read is an uncultured or otherwise unnamed fungus,
 * "Fungi" and nothing finer; else nothing.
 */
export function strayReadLikelyName(ncbiHits: CoveringNcbiHit[]): ContaminantLikelyName | null {
  const covering = ncbiHits.filter((hit) => hit.queryCoverage >= QUERY_COVERAGE_THRESHOLD && Number.isFinite(hit.identity));
  const votes: ContaminantNameVote[] = covering
    .filter((hit) => !!hit.name && !isUnculturedName(hit.name) && !isPlaceholderOrganismName(hit.name))
    .map((hit) => ({ name: hit.name!, identity: hit.identity }));
  const named = contaminantLikelyName({ speciesConsensus: null, ncbiVotes: votes, listTrigger: null });
  if (named) return named;

  const [closest] = [...covering].sort((a, b) => b.identity - a.identity);
  if (!closest) return null;
  const says = `${closest.name ?? ""} ${closest.title}`;
  // A fungus by its words; GenBank's "Vouchered mycorrhizae" is one too.
  if (!/\b(fung(us|i|al)|mycorrhizae?)\b/i.test(says)) return null;
  return {
    name: "Fungi",
    rank: "above_genus",
    // A kingdom, from one match: said with no more weight than that.
    confidence: Math.max(10, Math.min(50, Math.round(closest.identity / 2))),
    source: "closest_ncbi_hit",
    count: 1,
    total: covering.length,
    identityThreshold: null,
    onContaminantList: false,
    summary: `Likely Fungi: the closest NCBI match covering the read is ${closest.accession} at ${closest.identity.toFixed(1)}% identity, an unnamed fungus; no named record covers it`,
  };
}

/** The step a stray read's analysis gets. `amplicon` is the primer pair it shares with the reads it was compared with. */
export function strayReadStep(anchor: RecordAnchor, likely: ContaminantLikelyName | null, amplicon: string): { step: string; status: "fail"; message: string; details: string[] } {
  return {
    step: "Cross-Sequence Stray Read Detection",
    status: "fail",
    message: `Flagged as a contaminant: no species for this read, while ${anchor.sequenceIds.length} other reads of the record are ${anchor.species} and none of them is among its MycoBLAST matches`,
    details: [
      `The record's reads name it ${anchor.species} (best ${anchor.bestConfidence}%): ${anchor.sequenceIds.join(", ")}`,
      `They were made with the same primers as this read (${amplicon}), so it covers the same stretch of DNA`,
      `None of those reads matches this one over ${QUERY_COVERAGE_THRESHOLD}% or more of its length, so it is not a poor read of the same specimen`,
      likely ? likely.summary : "No likely name: nothing in NCBI covers this read",
    ],
  };
}
