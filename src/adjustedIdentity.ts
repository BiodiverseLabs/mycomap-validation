// Adjusted identity: how alike two aligned DNA sequences are once differences
// that sequencing makes on its own are set aside. A run of one base (or a
// repeated pair) that is longer in one sequence costs nothing, a gap costs one
// however long it is, two ambiguity codes that could be the same base match,
// and the overhang at either end is not scored.
//
// This is a port to TypeScript of `score_alignment` from the Python package
// adjusted-identity, version 0.2.6, by Josh Walker
// (https://github.com/joshuaowalker/adjusted-identity), with its default
// settings: homopolymer and repeat normalisation on, repeat motifs up to two
// bases, IUPAC overlap on, indel normalisation on, no end skipping, local
// scoring. It returns the same identity, mismatch count and scored positions
// as the package for the same aligned pair, and (scoreAlignmentAnnotated) the
// same annotated score string the BLAST page colours alignments by, checked
// against the package's own strings (version 0.2.11, which scores as 0.2.6
// does with these defaults). The method is the MycoBLAST algorithm
// developed by Stephen Russell and Mycota Lab.
//
// The package's licence, which covers this file:
//
// BSD 2-Clause License
//
// Copyright (c) 2025, Josh Walker
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice, this
//    list of conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
// FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
// DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
// SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
// CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
// OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

/** The package's defaults; the port is written for these and no others. */
const MAX_REPEAT_MOTIF_LENGTH = 2;

const IUPAC_CODES: Record<string, string> = {
  "-": "-",
  A: "A",
  T: "T",
  C: "C",
  G: "G",
  R: "AG",
  Y: "CT",
  S: "GC",
  W: "AT",
  K: "GT",
  M: "AC",
  B: "CGT",
  D: "AGT",
  H: "ACT",
  V: "ACG",
  N: "ACGT",
};

const STANDARD_NUCS = new Set(["A", "T", "C", "G", "a", "t", "c", "g"]);

/** Whether two bases can be the same base: the same letter in either case, or two IUPAC codes with a base in common. */
function nucleotidesEquivalent(nuc1: string, nuc2: string): boolean {
  if (nuc1 === nuc2) return true;
  if (STANDARD_NUCS.has(nuc1) && STANDARD_NUCS.has(nuc2)) return nuc1.toUpperCase() === nuc2.toUpperCase();
  const upper1 = nuc1.toUpperCase();
  const upper2 = nuc2.toUpperCase();
  if (upper1 === upper2) return true;
  const possible1 = IUPAC_CODES[upper1] ?? upper1;
  const possible2 = IUPAC_CODES[upper2] ?? upper2;
  for (const base of possible1) if (possible2.includes(base)) return true;
  return false;
}

/** The first and last columns where both sequences have a base. */
function findScoringRegion(seq1: string, seq2: string): [number, number] {
  const length = seq1.length;
  let scoringStart = 0;
  for (let pos = 0; pos < length; pos++) {
    if (seq1[pos] !== "-" && seq2[pos] !== "-") { scoringStart = pos; break; }
  }
  let scoringEnd = length - 1;
  for (let pos = length - 1; pos >= 0; pos--) {
    if (seq1[pos] !== "-" && seq2[pos] !== "-") { scoringEnd = pos; break; }
  }
  return [scoringStart, scoringEnd];
}

/** The `length` matching bases just left of `position`, or null when a differing column comes first. */
function extractLeftContext(seq1: string, seq2: string, position: number, length: number): string | null {
  const chars: string[] = [];
  let pos = position - 1;
  let collected = 0;
  while (collected < length && pos >= 0) {
    const char1 = seq1[pos];
    const char2 = seq2[pos];
    if (char1 === "-" && char2 === "-") { pos -= 1; continue; }
    if (char1 !== "-" && char2 !== "-" && (char1 === char2 || char1.toUpperCase() === char2.toUpperCase())) {
      chars.push(char1);
      collected += 1;
      pos -= 1;
      continue;
    }
    return null;
  }
  if (collected < length) return null;
  return chars.reverse().join("");
}

/** The `length` matching bases just right of `position`, or null when a differing column comes first. */
function extractRightContext(seq1: string, seq2: string, position: number, length: number): string | null {
  const chars: string[] = [];
  let pos = position + 1;
  const maxPos = seq1.length;
  let collected = 0;
  while (collected < length && pos < maxPos) {
    const char1 = seq1[pos];
    const char2 = seq2[pos];
    if (char1 === "-" && char2 === "-") { pos += 1; continue; }
    if (char1 !== "-" && char2 !== "-" && (char1 === char2 || char1.toUpperCase() === char2.toUpperCase())) {
      chars.push(char1);
      collected += 1;
      pos += 1;
      continue;
    }
    return null;
  }
  if (collected < length) return null;
  return chars.join("");
}

/** The bases of one sequence across a range of columns, gaps left out. */
function extractAllele(seq: string, start: number, end: number): string {
  let out = "";
  for (let i = start; i <= end; i++) if (seq[i] !== "-") out += seq[i];
  return out;
}

function motifMatches(chunk: string, motif: string): boolean {
  if (chunk.length !== motif.length) return false;
  for (let i = 0; i < chunk.length; i++) if (!nucleotidesEquivalent(chunk[i], motif[i])) return false;
  return true;
}

/** A motif of one repeated base is that one base. */
function collapseMotif(motif: string): string {
  if (motif.length > 1 && motif[0].toUpperCase() === motif[motif.length - 1].toUpperCase()) {
    const first = motif[0].toUpperCase();
    let all = true;
    for (const c of motif) if (c.toUpperCase() !== first) { all = false; break; }
    if (all) return motif[0];
  }
  return motif;
}

interface AlleleAnalysis {
  coreContent: string;
  isPureExtension: boolean;
  /** How many of the allele's bases extend the repeat on its left, and on its right. */
  leftExtension: number;
  rightExtension: number;
}

/** Splits an allele into what only extends the repeat on its left or right, and the core that is left. */
function analyzeAllele(allele: string, leftContext: string | null, rightContext: string | null): AlleleAnalysis {
  if (!allele) return { coreContent: "", isPureExtension: true, leftExtension: 0, rightExtension: 0 };
  const n = allele.length;
  let leftConsumed = 0;
  let rightConsumed = 0;

  if (leftContext) {
    for (let len = Math.min(MAX_REPEAT_MOTIF_LENGTH, leftContext.length); len > 0; len--) {
      const motif = collapseMotif(leftContext.slice(leftContext.length - len));
      const motifLen = motif.length;
      let consumed = 0;
      let pos = 0;
      while (pos + motifLen <= n) {
        if (motifMatches(allele.slice(pos, pos + motifLen), motif)) {
          consumed += motifLen;
          pos += motifLen;
        } else {
          break;
        }
      }
      if (consumed > 0) { leftConsumed = consumed; break; }
    }
  }

  if (rightContext) {
    const remainingStart = leftConsumed;
    const remainingLen = n - remainingStart;
    for (let len = Math.min(MAX_REPEAT_MOTIF_LENGTH, rightContext.length); len > 0; len--) {
      const motif = collapseMotif(rightContext.slice(0, len));
      const motifLen = motif.length;
      let consumed = 0;
      let pos = remainingLen;
      while (pos >= motifLen) {
        if (motifMatches(allele.slice(remainingStart + pos - motifLen, remainingStart + pos), motif)) {
          consumed += motifLen;
          pos -= motifLen;
        } else {
          break;
        }
      }
      if (consumed > 0) { rightConsumed = consumed; break; }
    }
  }

  const coreStart = leftConsumed;
  const coreEnd = n - rightConsumed;
  const coreContent = coreEnd > coreStart ? allele.slice(coreStart, coreEnd) : "";
  return { coreContent, isPureExtension: coreContent.length === 0, leftExtension: leftConsumed, rightExtension: rightConsumed };
}

/** Each stretch of columns that differ, with the matching column on either side (-1 when it has none in the scoring region). */
function findVariantRanges(seq1: string, seq2: string, scoringStart: number, scoringEnd: number): Array<[number, number, number, number]> {
  const ranges: Array<[number, number, number, number]> = [];
  let i = scoringStart;
  while (i <= scoringEnd) {
    let c1 = seq1[i];
    let c2 = seq2[i];
    if (c1 === c2 && c1 !== "-") { i += 1; continue; }
    if (c1 !== "-" && c2 !== "-" && nucleotidesEquivalent(c1, c2)) { i += 1; continue; }

    const variantStart = i;
    const leftBound = i > scoringStart ? i - 1 : -1;
    i += 1;
    while (i <= scoringEnd) {
      c1 = seq1[i];
      c2 = seq2[i];
      if (c1 === c2 && c1 !== "-") break;
      if (c1 === "-" || c2 === "-") { i += 1; continue; }
      if (nucleotidesEquivalent(c1, c2)) break;
      i += 1;
    }
    const variantEnd = i - 1;
    const rightBound = i <= scoringEnd ? i : -1;
    ranges.push([variantStart, variantEnd, leftBound, rightBound]);
  }
  return ranges;
}

/** What one stretch of differing columns costs: its edits, and how many positions it counts as. */
function scoreVariantRange(analysis1: AlleleAnalysis, analysis2: AlleleAnalysis): { edits: number; scoredPositions: number } {
  if (analysis1.isPureExtension && analysis2.isPureExtension) return { edits: 0, scoredPositions: 0 };
  if (analysis1.isPureExtension) {
    const core = analysis2.coreContent;
    return { edits: core ? 1 : 0, scoredPositions: core ? 1 : 0 };
  }
  if (analysis2.isPureExtension) {
    const core = analysis1.coreContent;
    return { edits: core ? 1 : 0, scoredPositions: core ? 1 : 0 };
  }
  const core1 = analysis1.coreContent;
  const core2 = analysis2.coreContent;
  if (core1 === core2) return { edits: 0, scoredPositions: core1.length };
  const minLen = Math.min(core1.length, core2.length);
  const maxLen = Math.max(core1.length, core2.length);
  let substitutions = 0;
  for (let i = 0; i < minLen; i++) if (!nucleotidesEquivalent(core1[i], core2[i])) substitutions += 1;
  const indel = maxLen > minLen ? 1 : 0;
  return { edits: substitutions + indel, scoredPositions: minLen + indel };
}

export interface AdjustedIdentityScore {
  /** 0 to 1: one minus mismatches over scored positions; 1 when nothing is scored. */
  identity: number;
  mismatches: number;
  scoredPositions: number;
}

/**
 * Scores two aligned sequences of the same length (gaps as "-"), as the
 * package's `score_alignment` does with its defaults. Throws when the two are
 * not the same length, as the package does.
 */
export function scoreAlignment(seq1Aligned: string, seq2Aligned: string): AdjustedIdentityScore {
  const { identity, mismatches, scoredPositions } = scoreAlignmentWith(seq1Aligned, seq2Aligned, false);
  return { identity, mismatches, scoredPositions };
}

/**
 * The score and the package's annotated score string, one mark per column of
 * the alignment: "|" the same base, "=" an ambiguous match or a repeat length
 * difference set aside, " " a substitution or the first column of a gap that
 * counts, "-" a gap column that does not count again, "." outside the scored
 * region or a gap in both. The BLAST page colours alignments by it.
 */
export function scoreAlignmentAnnotated(seq1Aligned: string, seq2Aligned: string): AdjustedIdentityScore & { scoreAligned: string } {
  const { identity, mismatches, scoredPositions, marks } = scoreAlignmentWith(seq1Aligned, seq2Aligned, true);
  return { identity, mismatches, scoredPositions, scoreAligned: marks.join("") };
}

const STANDARD_BASES = new Set(["A", "C", "G", "T"]);

/** The mark of a column between variant ranges: both hold a base, and the bases are equivalent. */
function matchMark(c1: string, c2: string): string {
  return STANDARD_BASES.has(c1.toUpperCase()) && c1.toUpperCase() === c2.toUpperCase() ? "|" : "=";
}

/**
 * The marks of one variant range's columns, as the package's _build_variant_codes
 * gives them with its defaults (repeat and indel normalisation on): extension
 * columns "=", core columns "|" when the cores are the same and " " when not,
 * a gap's first counted column " " and the rest "-", gaps in both ".".
 */
function variantMarks(seq1: string, seq2: string, start: number, end: number, a1: AlleleAnalysis, a2: AlleleAnalysis): string[] {
  const cls: string[] = [];
  for (let i = start; i <= end; i++) {
    const g1 = seq1[i] === "-";
    const g2 = seq2[i] === "-";
    cls.push(g1 && g2 ? "D" : g1 ? "I" : g2 ? "J" : "X");
  }
  const allele1: number[] = [];
  const allele2: number[] = [];
  cls.forEach((c, pos) => {
    if (c === "X" || c === "J") allele1.push(pos);
    if (c === "X" || c === "I") allele2.push(pos);
  });
  const ext1 = new Set([...allele1.slice(0, a1.leftExtension), ...(a1.rightExtension > 0 ? allele1.slice(-a1.rightExtension) : [])]);
  const ext2 = new Set([...allele2.slice(0, a2.leftExtension), ...(a2.rightExtension > 0 ? allele2.slice(-a2.rightExtension) : [])]);
  const coresMatch = a1.coreContent === a2.coreContent;
  const marks: string[] = [];
  let seenCoreStart = false;
  cls.forEach((c, pos) => {
    if (c === "D") { marks.push("."); return; }
    if (c === "X") {
      const isExt1 = ext1.has(pos);
      const isExt2 = ext2.has(pos);
      if (isExt1 && isExt2) marks.push("=");
      else if (!isExt1 && !isExt2) marks.push(coresMatch ? "|" : " ");
      else if (coresMatch) marks.push(isExt1 ? "=" : "|");
      else marks.push(" ");
      return;
    }
    if (c === "I") {
      if (ext2.has(pos) || coresMatch) { marks.push("="); return; }
    } else if (ext1.has(pos)) {
      marks.push("=");
      return;
    } else if (coresMatch) {
      marks.push("|");
      return;
    }
    if (seenCoreStart) marks.push("-");
    else { marks.push(" "); seenCoreStart = true; }
  });
  return marks;
}

function scoreAlignmentWith(seq1Aligned: string, seq2Aligned: string, annotate: boolean): AdjustedIdentityScore & { marks: string[] } {
  if (seq1Aligned.length !== seq2Aligned.length) {
    throw new Error(`Aligned sequences must have same length: seq1=${seq1Aligned.length}, seq2=${seq2Aligned.length}`);
  }
  let edits = 0;
  let scoredPositions = 0;
  const [scoringStart, scoringEnd] = findScoringRegion(seq1Aligned, seq2Aligned);
  const ranges = findVariantRanges(seq1Aligned, seq2Aligned, scoringStart, scoringEnd);
  const variantMarksByStart = new Map<number, string[]>();

  for (const [start, end, leftBound, rightBound] of ranges) {
    const allele1 = extractAllele(seq1Aligned, start, end);
    const allele2 = extractAllele(seq2Aligned, start, end);
    let leftContext: string | null = null;
    let rightContext: string | null = null;
    if (leftBound >= 0) {
      for (let len = MAX_REPEAT_MOTIF_LENGTH; len > 0; len--) {
        leftContext = extractLeftContext(seq1Aligned, seq2Aligned, start, len);
        if (leftContext !== null) break;
      }
    }
    if (rightBound >= 0) {
      for (let len = MAX_REPEAT_MOTIF_LENGTH; len > 0; len--) {
        rightContext = extractRightContext(seq1Aligned, seq2Aligned, end, len);
        if (rightContext !== null) break;
      }
    }
    const analysis1 = analyzeAllele(allele1, leftContext, rightContext);
    const analysis2 = analyzeAllele(allele2, leftContext, rightContext);
    const score = scoreVariantRange(analysis1, analysis2);
    edits += score.edits;
    scoredPositions += score.scoredPositions;
    if (annotate) variantMarksByStart.set(start, variantMarks(seq1Aligned, seq2Aligned, start, end, analysis1, analysis2));
  }

  // Every column outside a variant range is a scored position, unless both sequences have a gap there.
  let pos = scoringStart;
  let rangeIndex = 0;
  while (pos <= scoringEnd) {
    if (rangeIndex < ranges.length && pos === ranges[rangeIndex][0]) {
      pos = ranges[rangeIndex][1] + 1;
      rangeIndex += 1;
    } else {
      if (!(seq1Aligned[pos] === "-" && seq2Aligned[pos] === "-")) scoredPositions += 1;
      pos += 1;
    }
  }

  const identity = scoredPositions > 0 ? 1.0 - edits / scoredPositions : 1.0;
  const marks: string[] = [];
  if (annotate) {
    for (let p = 0; p < scoringStart; p++) marks.push(".");
    let p = scoringStart;
    while (p <= scoringEnd) {
      const variant = variantMarksByStart.get(p);
      if (variant) {
        marks.push(...variant);
        p += variant.length;
      } else {
        marks.push(matchMark(seq1Aligned[p], seq2Aligned[p]));
        p += 1;
      }
    }
    for (let q = scoringEnd + 1; q < seq1Aligned.length; q++) marks.push(".");
  }
  return { identity, mismatches: edits, scoredPositions, marks };
}

/**
 * A number rounded to two decimals the way Python's round(x, 2) does it: by
 * the number's exact value, and to the even digit when it sits exactly
 * halfway. The Python scripts report identity this way, so the port must.
 */
export function roundHalfEvenTo2(value: number): number {
  if (!Number.isFinite(value)) return value;
  // Exactly halfway between two hundredths only when the value is an odd number of eighths.
  if (Number.isInteger(value * 8) && !Number.isInteger(value * 4)) {
    const lower = Math.floor(value * 100);
    return (lower % 2 === 0 ? lower : lower + 1) / 100;
  }
  return Number(value.toFixed(2));
}

/** Adjusted identity in percent, to two decimals: what the analysis compares with its thresholds. */
export function adjustedIdentityPercent(seq1Aligned: string, seq2Aligned: string): number {
  return roundHalfEvenTo2(scoreAlignment(seq1Aligned, seq2Aligned).identity * 100);
}

/**
 * Adjusted identity in percent for each hit's alignment, by hit number: what
 * an analysis is handed with its BLAST results. A pair with an empty side, or
 * one that cannot be scored (the two sides differ in length), is 0, as the
 * server's Python batch script answered for them.
 */
export function adjustedIdentityByHit(hits: ReadonlyArray<{ num: number; qseq: string; hseq: string }>): Record<number, number> {
  const byHit: Record<number, number> = {};
  for (const hit of hits) {
    if (!hit.qseq || !hit.hseq) {
      byHit[hit.num] = 0;
      continue;
    }
    try {
      byHit[hit.num] = adjustedIdentityPercent(hit.qseq, hit.hseq);
    } catch {
      byHit[hit.num] = 0;
    }
  }
  return byHit;
}
