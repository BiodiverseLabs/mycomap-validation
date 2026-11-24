// Example: how alike are two aligned sequences, as the rules count it?
//
//   pnpm example adjusted-identity
//   pnpm example adjusted-identity path/to/your-alignment.txt
//
// The file holds two aligned sequences of the same length, gaps as "-" (lines
// starting with # or > are skipped). Prints plain percent identity beside
// adjusted identity, which leaves out what sequencing errors and ragged ends
// cause: the overhang where one read starts or stops before the other, and a
// difference in the length of a run of one base (a homopolymer). The marks line
// says how each column was counted: | the same base, = a run-length difference
// or ambiguity code set aside, a space for a real difference, - a gap column
// already counted, . not compared (the overhang).
import { scoreAlignmentAnnotated } from "../src/adjustedIdentity";

export function adjustedIdentityExample(text: string): string {
  const seqs = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith(">"));
  if (seqs.length !== 2) throw new Error(`Expected two aligned sequences, found ${seqs.length}`);
  const [a, b] = seqs.map((s) => s.toUpperCase());
  const score = scoreAlignmentAnnotated(a, b);
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i] && a[i] !== "-") same++;
  const plain = (100 * same) / a.length;
  return [
    `Sequence 1:         ${a}`,
    `Sequence 2:         ${b}`,
    `Marks:              ${score.scoreAligned}`,
    "",
    `Plain identity:     ${plain.toFixed(2)}%  (${same} of ${a.length} aligned positions the same)`,
    `Adjusted identity:  ${(score.identity * 100).toFixed(2)}%  (${score.mismatches} real difference${score.mismatches === 1 ? "" : "s"} in ${score.scoredPositions} positions compared)`,
  ].join("\n");
}
