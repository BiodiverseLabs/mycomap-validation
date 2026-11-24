// Example: does MycoMap Vision (identification from the photos) back the DNA's name?
//
//   pnpm example vision-and-dna vision-agrees
//   pnpm example vision-and-dna vision-says-another-genus
//
// The engine does not look at photos: Vision's answer is an input, like the
// BLAST hits. This applies the rule MycoMap uses to weigh that answer against
// the DNA, and prints what it decided and why.
import { decideVisionAgreement, describeVisionAgreement, type VisionAgreementVision } from "../src/visionAgreement";

export interface VisionInput {
  about?: string;
  /** What the DNA analysis named the record, and how sure it was (percent). */
  dna: { species: string; confidence: number; contaminant?: boolean };
  /** The family of the DNA's species, when known. */
  dnaFamily?: string;
  /** Vision's answer, best first, in percent. */
  vision: {
    species: Array<{ name: string; percent: number }>;
    genus: Array<{ name: string; percent: number }>;
    family?: Array<{ name: string; percent: number }>;
  };
}

const OUTCOME: Record<string, string> = {
  agrees: "Vision backs the DNA",
  vetoes: "Vision is against the DNA: the record is held for a person",
  none: "Vision neither backs nor blocks the DNA",
};

export function visionExample(input: VisionInput): string {
  const candidates = (list: Array<{ name: string; percent: number }> = []) => list.map((c) => ({ name: c.name, confidence: c.percent / 100 }));
  const vision: VisionAgreementVision = {
    runId: null, modelVersion: null, answersVersion: null, gateVerdict: "fungus",
    species: candidates(input.vision.species), genus: candidates(input.vision.genus), family: candidates(input.vision.family),
  };
  const decision = decideVisionAgreement({
    dna: { species: input.dna.species, nameConfidence: input.dna.confidence, contaminant: input.dna.contaminant ?? false, edna: false },
    vision,
    dnaFamily: input.dnaFamily ?? null,
  });
  const list = (l: Array<{ name: string; percent: number }> = []) => l.map((c) => `${c.name} ${c.percent}%`).join(", ") || "(none)";
  return [
    ...(input.about ? [input.about, ""] : []),
    `DNA:            ${input.dna.species} at ${input.dna.confidence}%`,
    `Vision species: ${list(input.vision.species)}`,
    `Vision genus:   ${list(input.vision.genus)}`,
    "",
    `Outcome:        ${OUTCOME[decision.outcome]}`,
    `Why:            ${describeVisionAgreement(decision)}`,
  ].join("\n");
}
