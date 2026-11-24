// Pure primer-title rules for eDNA amplicons. Kept free of database imports so
// they can be unit-tested; ednaPrimerClassifier re-exports them alongside the
// DB-backed lookups.

export type AmpliconFamily = "fungal_its" | "bacterial_16s" | "other";

const FUNGAL_ITS_TITLE_RE = /\b(its[0-9]?[a-z]?|gits7?|fits|lrbar|lr0r|lr3|lr5|lr7|nlb4|nlc2|nlr)\b/i;
const BACTERIAL_16S_TITLE_RE = /\b(16s|27f|1492r?|341f|515f|805r?|806r?|v3|v4|bacteria[0-9]*)\b/i;
// Primers that sit in the large subunit (LSU/28S). An amplicon that reaches
// into the LSU carries hundreds of bases beyond the ITS, so ITS length rules
// do not apply to it.
const LSU_TITLE_RE = /\b(lr\d+r?|nl\d+|nlb4|nlc2|nlr)\b/i;

// Analysis-time "suspiciously long" threshold. The analysis only calls a read
// chimeric when it is at least this long AND no BLAST hit covers enough of it,
// so this can sit low.
export const CHIMERA_BP_THRESHOLD_FUNGAL_ITS = 600;
export const CHIMERA_BP_THRESHOLD_BACTERIAL_16S = 1700;

// Upload-time hard ceiling: a variant at least this long is trashed as a
// likely chimera before it is ever BLASTed, with no coverage evidence. It must
// therefore sit above the range real amplicons reach. ITS1F/ITS4 full-ITS reads
// run 550-900 bp and longer in some genera; in MycoMap's own analysed reads the
// coverage-based chimera check passed 99% of 600-749 bp reads, 74% of 750-899,
// about half of 900-1,099 and 3% of 1,100+ (local snapshot, June 2026).
export const UPLOAD_AUTO_TRASH_BP_FUNGAL_ITS = 1100;
export const UPLOAD_AUTO_TRASH_BP_BACTERIAL_16S = CHIMERA_BP_THRESHOLD_BACTERIAL_16S;

export function classifyPrimerTitles(fwdTitle?: string | null, revTitle?: string | null): AmpliconFamily {
  const titles = [fwdTitle, revTitle].filter(Boolean).join(" ");
  if (FUNGAL_ITS_TITLE_RE.test(titles)) return "fungal_its";
  if (BACTERIAL_16S_TITLE_RE.test(titles)) return "bacterial_16s";
  return "other";
}

export function chimeraLengthCeilingBp(family: AmpliconFamily): number | null {
  if (family === "fungal_its") return CHIMERA_BP_THRESHOLD_FUNGAL_ITS;
  if (family === "bacterial_16s") return CHIMERA_BP_THRESHOLD_BACTERIAL_16S;
  return null;
}

/**
 * Length at or above which an upload trashes a variant as "Likely Chimera"
 * without BLASTing it, or null when length alone must never trash it (unknown
 * primers, or an amplicon that extends into the LSU).
 */
export function uploadAutoTrashLengthBp(fwdTitle?: string | null, revTitle?: string | null): number | null {
  const titles = [fwdTitle, revTitle].filter(Boolean).join(" ");
  if (LSU_TITLE_RE.test(titles)) return null;
  const family = classifyPrimerTitles(fwdTitle, revTitle);
  if (family === "fungal_its") return UPLOAD_AUTO_TRASH_BP_FUNGAL_ITS;
  if (family === "bacterial_16s") return UPLOAD_AUTO_TRASH_BP_BACTERIAL_16S;
  return null;
}
