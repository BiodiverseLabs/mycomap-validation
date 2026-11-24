// Adjusted identity in the validation engine: adjustedIdentity.ts is a TypeScript port of
// the Python package adjusted-identity 0.2.6, and must give that package's
// answer for every aligned pair. The vectors are made-up pairs with the
// package's own answers (lib/validation-engine/test-vectors/adjusted-identity.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adjustedIdentityByHit, adjustedIdentityPercent, roundHalfEvenTo2, scoreAlignment, scoreAlignmentAnnotated } from "../src/adjustedIdentity";

const here = path.dirname(fileURLToPath(import.meta.url));
const engineDir = path.join(here, "..");

interface Vector { name: string; q: string; h: string; percent?: number; mismatches?: number; scoredPositions?: number; error?: string; scoreAligned?: string }
const file = JSON.parse(fs.readFileSync(path.join(engineDir, "test-vectors/adjusted-identity.json"), "utf8")) as { package: string; vectors: Vector[] };
const byName = new Map(file.vectors.map((v) => [v.name, v]));
const pct = (name: string) => {
  const v = byName.get(name);
  assert.ok(v, `no vector named "${name}"`);
  return adjustedIdentityPercent(v.q, v.h);
};

// ---- the package's answer, for every vector ----

test("the port gives the Python package's identity, mismatches and scored positions for every vector", () => {
  assert.equal(file.package, "adjusted-identity==0.2.6");
  assert.ok(file.vectors.length >= 400, `only ${file.vectors.length} vectors`);
  const wrong: string[] = [];
  for (const v of file.vectors) {
    if (v.error !== undefined) continue;
    const score = scoreAlignment(v.q, v.h);
    const percent = adjustedIdentityPercent(v.q, v.h);
    if (percent !== v.percent || score.mismatches !== v.mismatches || score.scoredPositions !== v.scoredPositions) {
      wrong.push(`${v.name}: package ${v.percent}/${v.mismatches}/${v.scoredPositions}, port ${percent}/${score.mismatches}/${score.scoredPositions}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("the port gives the package's annotated score string, one mark per column, for every vector, and the same score as without it", () => {
  const withString = file.vectors.filter((v) => v.error === undefined);
  assert.ok(withString.every((v) => typeof v.scoreAligned === "string"), "every vector the package scores has its string");
  const wrong: string[] = [];
  for (const v of withString) {
    const annotated = scoreAlignmentAnnotated(v.q, v.h);
    const plain = scoreAlignment(v.q, v.h);
    if (annotated.scoreAligned !== v.scoreAligned) wrong.push(`${v.name}: package [${v.scoreAligned}], port [${annotated.scoreAligned}]`);
    if (annotated.scoreAligned.length !== v.q.length) wrong.push(`${v.name}: ${annotated.scoreAligned.length} marks for ${v.q.length} columns`);
    if (annotated.identity !== plain.identity || annotated.mismatches !== plain.mismatches || annotated.scoredPositions !== plain.scoredPositions) wrong.push(`${v.name}: the annotated score differs`);
  }
  assert.deepEqual(wrong, []);
});

test("what the marks say: a base the same, a repeat length difference set aside, a substitution, a gap counted once, the overhang", () => {
  assert.equal(scoreAlignmentAnnotated("ACGTACGTAC", "ACGTTCGTAC").scoreAligned, "|||| |||||", "a substitution");
  assert.equal(scoreAlignmentAnnotated("ACGAAAATTC", "ACGAAA-TTC").scoreAligned, "||||||=|||", "one A fewer in a run of As costs nothing");
  assert.equal(scoreAlignmentAnnotated("ACGTCCCGATTC", "ACG---GATTC-".slice(0, 12).padEnd(12, "-")).scoreAligned.slice(3, 6), " --", "a gap that is not a repeat: its first column counts, the rest do not");
  assert.equal(scoreAlignmentAnnotated("--GTACGT", "ACGTACGT").scoreAligned, "..||||||", "the overhang is not scored");
  assert.equal(scoreAlignmentAnnotated("ACGTRCGT", "ACGTACGT").scoreAligned, "||||=|||", "an ambiguity code that can be the base");
});

test("the vectors exercise the rules: most are below 100%, and they reach many different values", () => {
  const percents = file.vectors.filter((v) => v.error === undefined).map((v) => v.percent as number);
  assert.ok(percents.filter((p) => p < 100).length > 200);
  assert.ok(new Set(percents).size > 100);
});

test("two sequences of different lengths are refused, as the package refuses them", () => {
  const v = byName.get("different lengths");
  assert.ok(v?.error);
  assert.throws(() => scoreAlignment(v.q, v.h), /Aligned sequences must have same length: seq1=4, seq2=3/);
});

// ---- the rules, in plain cases ----

test("a longer run of one base, or one more unit of a repeated pair, costs nothing", () => {
  assert.equal(pct("homopolymer one longer"), 100);
  assert.equal(pct("homopolymer three longer"), 100);
  assert.equal(pct("dinucleotide repeat one unit longer"), 100);
  assert.equal(pct("extension of the right-hand run"), 100);
});

test("an insertion that is not a repeat costs one, however long it is", () => {
  const short = byName.get("an insertion that is not a repeat")!;
  const long = byName.get("a long gap counts once")!;
  assert.equal(scoreAlignment(short.q, short.h).mismatches, 1);
  assert.equal(scoreAlignment(long.q, long.h).mismatches, 1);
  assert.equal(pct("a long gap counts once"), 87.5);
});

test("a substitution costs one, in either case of letter", () => {
  assert.equal(pct("one substitution"), 90);
  assert.equal(pct("lower case substitution"), 90);
  assert.equal(pct("lower and upper case"), 100);
});

test("the overhang at either end is not scored", () => {
  for (const name of ["overhang left", "overhang right", "overhang both, opposite"]) {
    const v = byName.get(name)!;
    assert.deepEqual(scoreAlignment(v.q, v.h), { identity: 1, mismatches: 0, scoredPositions: 8 }, name);
  }
});

test("ambiguity codes match when they could be the same base, and not otherwise", () => {
  assert.equal(pct("N against a base"), 100);
  assert.equal(pct("R against A"), 100);
  assert.equal(pct("R against M (A in common)"), 100);
  assert.equal(pct("R against C"), 90);
  assert.equal(pct("R against Y (no base in common)"), 90);
});

test("nothing to score is 100%, not an error", () => {
  assert.deepEqual(scoreAlignment("", ""), { identity: 1, mismatches: 0, scoredPositions: 0 });
  assert.deepEqual(scoreAlignment("----", "----"), { identity: 1, mismatches: 0, scoredPositions: 0 });
});

// ---- rounding as Python rounds ----

test("a value exactly halfway between two hundredths goes to the even one, as Python's round does", () => {
  assert.equal(pct("seven substitutions in 800: a halfway value"), 99.12);
  assert.equal(pct("one substitution in 800"), 99.88);
  assert.equal(pct("three substitutions in 800"), 99.62);
  assert.equal(roundHalfEvenTo2(99.125), 99.12);
  assert.equal(roundHalfEvenTo2(99.375), 99.38);
  assert.equal(roundHalfEvenTo2(99.625), 99.62);
  assert.equal(roundHalfEvenTo2(99.875), 99.88);
  assert.equal(roundHalfEvenTo2(0.125), 0.12);
});

test("any other value rounds by its exact value", () => {
  assert.equal(roundHalfEvenTo2(92.85714285714286), 92.86);
  assert.equal(roundHalfEvenTo2(88.88888888888889), 88.89);
  assert.equal(roundHalfEvenTo2(100), 100);
  assert.equal(roundHalfEvenTo2(0), 0);
  // 2.675 and 1.005 are stored a little below what is written, so they round down; 99.995 is
  // stored a little above, so it rounds up. Python's round(x, 2) gives the same three answers.
  assert.equal(roundHalfEvenTo2(2.675), 2.67);
  assert.equal(roundHalfEvenTo2(1.005), 1);
  assert.equal(roundHalfEvenTo2(99.995), 100);
});

// ---- one answer per hit, as an analysis is handed them ----

test("each hit gets its adjusted identity under its own number", () => {
  const sub = byName.get("one substitution")!;
  const run = byName.get("homopolymer one longer")!;
  const gap = byName.get("a long gap counts once")!;
  assert.deepEqual(
    adjustedIdentityByHit([{ num: 7, qseq: sub.q, hseq: sub.h }, { num: 2, qseq: run.q, hseq: run.h }, { num: 31, qseq: gap.q, hseq: gap.h }]),
    { 2: 100, 7: 90, 31: 87.5 },
  );
  assert.deepEqual(adjustedIdentityByHit([]), {});
});

test("a hit with an empty side, or one that cannot be scored, is 0, as the server's Python batch script answered", () => {
  assert.deepEqual(
    adjustedIdentityByHit([
      { num: 1, qseq: "", hseq: "ACGT" },
      { num: 2, qseq: "ACGT", hseq: "" },
      { num: 3, qseq: "ACGT", hseq: "ACG" },
      { num: 4, qseq: "ACGT", hseq: "ACGT" },
      // Scored on its own, two empty sides are 100%: the batch script never scored them.
      { num: 5, qseq: "", hseq: "" },
    ]),
    { 1: 0, 2: 0, 3: 0, 4: 100, 5: 0 },
  );
});

// ---- real alignments, when a file of them is at hand ----

// Not in the repo: alignments from real BLAST results with the package's answers, one JSON object a line
// ({q, h, pct, mm, sp} or {q, h, err}). Set ADJUSTED_IDENTITY_REAL_FILE to check the port against them.
test("the port gives the package's answer for every real alignment in ADJUSTED_IDENTITY_REAL_FILE", { skip: !process.env.ADJUSTED_IDENTITY_REAL_FILE }, () => {
  const lines = fs.readFileSync(process.env.ADJUSTED_IDENTITY_REAL_FILE as string, "utf8").split("\n").filter(Boolean);
  let different = 0;
  for (const line of lines) {
    const r = JSON.parse(line) as { q: string; h: string; pct?: number; mm?: number; sp?: number; err?: string };
    if (r.err !== undefined) { assert.throws(() => scoreAlignment(r.q, r.h)); continue; }
    const score = scoreAlignment(r.q, r.h);
    if (adjustedIdentityPercent(r.q, r.h) !== r.pct || score.mismatches !== r.mm || score.scoredPositions !== r.sp) different++;
  }
  assert.ok(lines.length > 0, "the file is empty");
  assert.equal(different, 0, `${different} of ${lines.length} real alignments differ`);
});
