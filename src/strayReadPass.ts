/**
 * The stray-read pass of an analysis run (2026-11-16; sequence 892545).
 *
 * The rule is the validation engine's (strayRead.ts): a
 * read the analysis could not name, on a record at least two of whose other
 * reads name the same species, made with the same primers as those reads and
 * not aligning with them, is not the specimen. This is the part that acts on
 * it for one record's reads: it finds which primers made each read, reads
 * each unnamed read's own hits, asks the rule, and for a stray read
 * saves the flag, the likely name and the step, then flags the sequence where
 * sequences are kept.
 *
 * It never fails a run: a read whose hits cannot be read, or whose flag cannot
 * be saved, stays as the analysis left it.
 *
 * Everything outside is behind `deps`; the live ones are in
 * batchAnalysisService.ts, next to the other cross-read passes.
 */
import type { BlastHit } from "./analysisRules";
import type { ContaminantLikelyName } from "./contaminantLikelyName";
import {
  isUnnamedRead, recordAnchor, strayReadLikelyName, strayReadStep, strayReadVerdict,
  STRAY_READ_MIN_NAMING_READS, type CoveringNcbiHit, type RecordReadSummary,
} from "./strayRead";

/** A record needs this many reads in the run before one can be stray: the ones that name it, and the stray one. */
export const STRAY_READ_MIN_RECORD_READS = STRAY_READ_MIN_NAMING_READS + 1;

export interface StrayReadFlag {
  sequenceId: string;
  likely: ContaminantLikelyName | null;
  step: ReturnType<typeof strayReadStep>;
}

export interface StrayReadPassDeps {
  /** The read's amplicon (its primer pair); null when its primers are not known. */
  ampliconOf(sequenceId: string): Promise<string | null>;
  /** The read's own MycoBLAST hits and its NCBI hits; null when they cannot be read. */
  loadHits(sequenceId: string): Promise<{ localHits: BlastHit[]; ncbiHits: CoveringNcbiHit[] } | null>;
  /** Writes the flag, the likely name and the step into the read's saved analysis. */
  saveFlag(flag: StrayReadFlag): Promise<void>;
  /** Flags the sequence as a contaminant where sequences are kept. Failing leaves the saved analysis flagged. */
  flagSequence(sequenceId: string): Promise<void>;
  log?(message: string): void;
  logError?(message: string, error: unknown): void;
}

/** The stray reads among one record's reads, each already saved as flagged. */
export async function flagStrayReads(recordReads: RecordReadSummary[], deps: StrayReadPassDeps): Promise<StrayReadFlag[]> {
  const flags: StrayReadFlag[] = [];
  if (recordReads.length < STRAY_READ_MIN_RECORD_READS) return flags;
  // No name for the record, no stray read: nothing is read for it.
  if (!recordAnchor(recordReads) || !recordReads.some(isUnnamedRead)) return flags;

  // Which primers made each read. One that cannot be found out is unknown, and the rule then leaves the read alone.
  const reads: RecordReadSummary[] = [];
  for (const read of recordReads) {
    let amplicon: string | null = null;
    try {
      amplicon = await deps.ampliconOf(read.id);
    } catch (error) {
      deps.logError?.(`the primers of read ${read.id} could not be read`, error);
    }
    reads.push({ ...read, amplicon });
  }

  for (const read of reads) {
    if (!isUnnamedRead(read) || !read.amplicon) continue;
    try {
      const hits = await deps.loadHits(read.id);
      // Its own hits could not be read: nothing is concluded about it.
      if (!hits) continue;
      const verdict = strayReadVerdict({ read, recordReads: reads, localHits: hits.localHits });
      if (!verdict.stray) continue;
      const likely = strayReadLikelyName(hits.ncbiHits);
      const flag: StrayReadFlag = { sequenceId: read.id, likely, step: strayReadStep(verdict.anchor, likely, verdict.amplicon) };
      await deps.saveFlag(flag);
      flags.push(flag);
      deps.log?.(`stray read ${read.id}: ${flag.step.message}${likely ? ` (${likely.summary})` : ""}`);
      try {
        await deps.flagSequence(read.id);
      } catch (flagError) {
        deps.logError?.(`stray read ${read.id} could not be flagged on its sequence`, flagError);
      }
    } catch (error) {
      deps.logError?.(`stray-read detection failed for ${read.id}`, error);
    }
  }
  return flags;
}
