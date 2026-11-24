// MycoMap Vision beside the DNA in auto-validation (visionAgreement.ts),
// 2026-10-23. Each rule is a test named after it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  decideVisionAgreement, describeVisionAgreement, validationEvidenceFields, visionAgreementDetail,
  visionAgreementDna, visionAgreementVisionFromRun, visionTopGenus, visionVetoReason,
  visionObserverSpareDetail, visionValidationEvidence,
  VISION_AGREEMENT_EVIDENCE, VISION_AGREEMENT_METHOD_LABEL, VISION_AGREEMENT_MIN_PROBABILITY,
  VISION_OBSERVER_SPARE_EVIDENCE, VISION_OBSERVER_SPARE_LABEL, scoreWithoutFamilyPenalty,
  type VisionAgreementDna, type VisionAgreementObserver, type VisionAgreementVision,
  decideFamilyPenaltyLift,
  decideTopListAgreement,
  noSecondSourceReason, secondSourceFromObserver, secondSourceFromVision,
  VISION_SECOND_SOURCE_EVIDENCE, VISION_SECOND_SOURCE_LABEL, OBSERVER_SECOND_SOURCE_EVIDENCE, OBSERVER_SECOND_SOURCE_LABEL,
  type VisionAgreementDecision,
} from "../src/visionAgreement";

const dna = (over: Partial<VisionAgreementDna> = {}): VisionAgreementDna => ({
  species: "Picipes tubaeformis", nameConfidence: 50, contaminant: false, edna: false, ...over,
});
const vision = (over: Partial<VisionAgreementVision> = {}): VisionAgreementVision => ({
  runId: 7, modelVersion: "m1", answersVersion: "a1", gateVerdict: "fungus",
  species: [{ name: "Picipes tubaeformis", confidence: 0.99 }, { name: "Picipes badius", confidence: 0.005 }],
  genus: [{ name: "Picipes", confidence: 0.995 }],
  ...over,
});
const decide = (d: Partial<VisionAgreementDna> = {}, v: Partial<VisionAgreementVision> | null = {}) =>
  decideVisionAgreement({ dna: dna(d), vision: v === null ? null : vision(v) });

// ── Agreement ───────────────────────────────────────────────────────────────

test("A real record (inat:363247500): DNA Picipes tubaeformis at 50%, Vision 99% → green-checked by species", () => {
  const d = decide();
  assert.equal(d.outcome, "agrees");
  assert.equal(d.outcome === "agrees" && d.branch, "species");
  assert.equal(d.outcome === "agrees" && d.verdictName, "Picipes tubaeformis");
});

test("no score cutoff: a species match green-checks at 20% name confidence", () => {
  const d = decide({ nameConfidence: 20 });
  assert.equal(d.outcome, "agrees");
});

test("no score cutoff: a genus match green-checks at 20% name confidence", () => {
  const d = decide({ nameConfidence: 20 }, { species: [{ name: "Picipes melanopus", confidence: 0.6 }], genus: [{ name: "Picipes", confidence: 0.9 }] });
  assert.equal(d.outcome, "agrees");
  assert.equal(d.outcome === "agrees" && d.branch, "genus");
});

test("no score cutoff: an unknown name confidence still green-checks", () => {
  assert.equal(decide({ nameConfidence: null }).outcome, "agrees");
});

test("genus-only support: Vision's species is another Picipes, its genus is Picipes above 50%", () => {
  const d = decide({}, { species: [{ name: "Picipes badius", confidence: 0.4 }], genus: [{ name: "Picipes", confidence: 0.97 }] });
  assert.equal(d.outcome, "agrees");
  assert.equal(d.outcome === "agrees" && d.branch, "genus");
});

test("the verdict name is always the DNA species, never Vision's", () => {
  const d = decide({ species: "Picipes tubaeformis" }, { species: [{ name: "Picipes badius", confidence: 0.45 }], genus: [{ name: "Picipes", confidence: 0.9 }] });
  assert.equal(d.outcome === "agrees" && d.verdictName, "Picipes tubaeformis");
  const detail = visionAgreementDetail(d as any);
  assert.equal(detail.dnaSpecies, "Picipes tubaeformis");
  assert.equal(detail.visionName, "Picipes", "the genus branch records Vision's genus, not its species");
});

// ── The 0.50 boundary ───────────────────────────────────────────────────────

test("Vision's probability must be above 0.50: exactly 0.50 at species does not count", () => {
  assert.equal(VISION_AGREEMENT_MIN_PROBABILITY, 0.5);
  const d = decide({}, { species: [{ name: "Picipes tubaeformis", confidence: 0.5 }], genus: [{ name: "Picipes", confidence: 0.5 }] });
  assert.equal(d.outcome, "none");
  assert.equal(d.outcome === "none" && d.reason, "not_above_half");
});

test("0.5001 at species counts", () => {
  const d = decide({}, { species: [{ name: "Picipes tubaeformis", confidence: 0.5001 }], genus: [{ name: "Picipes", confidence: 0.5 }] });
  assert.equal(d.outcome, "agrees");
});

test("genus at exactly 0.50 does not count", () => {
  const d = decide({}, { species: [{ name: "Picipes badius", confidence: 0.3 }], genus: [{ name: "Picipes", confidence: 0.5 }] });
  assert.equal(d.outcome, "none");
  assert.equal(d.outcome === "none" && d.reason, "not_above_half");
});

// ── Names ───────────────────────────────────────────────────────────────────

test("a genus-level DNA result has no species to agree with", () => {
  for (const s of ["Picipes", "Picipes sp.", "Manual Validation Needed", null]) {
    const d = decide({ species: s });
    assert.equal(d.outcome === "none" && d.reason, "no_dna_species", String(s));
  }
});

test("a different species in a different genus is a name mismatch below 50% genus", () => {
  const d = decide({}, { species: [{ name: "Trametes versicolor", confidence: 0.4 }], genus: [{ name: "Trametes", confidence: 0.45 }] });
  assert.equal(d.outcome === "none" && d.reason, "names_differ");
});

test("provisional names count when both give the same code, in any of the data's styles", () => {
  for (const [a, b] of [
    ["Cortinarius sp. 'IN01'", "Cortinarius sp. 'IN01'"],
    ["Cortinarius sp. 'IN01'", "Cortinarius \"sp-IN01\""],
    ["Alnicola sp. 'escharioides-PNW01'", "Alnicola 'escharioides PNW01'"],
  ]) {
    const d = decide({ species: a }, { species: [{ name: b, confidence: 0.8 }], genus: [{ name: a.split(" ")[0], confidence: 0.85 }] });
    assert.equal(d.outcome === "agrees" && d.branch, "species", `${a} vs ${b}`);
  }
});

test("a different provisional code is not the same species", () => {
  const d = decide({ species: "Cortinarius sp. 'IN01'" }, { species: [{ name: "Cortinarius sp. 'IN02'", confidence: 0.8 }], genus: [{ name: "Cortinarius", confidence: 0.4 }] });
  assert.equal(d.outcome === "none" && d.reason, "not_above_half", "same genus, but the genus is not above 50% and the code differs");
});

test("a provisional name and a binomial with the same letters are not the same species", () => {
  const d = decide({ species: "Russula sp. 'abc'" }, { species: [{ name: "Russula abc", confidence: 0.9 }], genus: [{ name: "Russula", confidence: 0.4 }] });
  assert.notEqual(d.outcome === "agrees" && d.branch, "species");
});

test("synonyms: the auto-validation species table (Lentinula reticeps = Rhodotus reticeps)", () => {
  const d = decide({ species: "Lentinula reticeps" }, { species: [{ name: "Rhodotus reticeps", confidence: 0.8 }], genus: [{ name: "Rhodotus", confidence: 0.85 }] });
  assert.equal(d.outcome === "agrees" && d.branch, "species");
  assert.equal(d.outcome === "agrees" && d.verdictName, "Lentinula reticeps", "still the DNA's own spelling");
});

test("synonyms: the genus table (Alnicola = Naucoria) for both the agreement and the veto", () => {
  const agree = decide({ species: "Alnicola escharioides" }, { species: [{ name: "Naucoria escharioides", confidence: 0.7 }], genus: [{ name: "Naucoria", confidence: 0.9 }] });
  assert.equal(agree.outcome === "agrees" && agree.branch, "species");
  const genusOnly = decide({ species: "Alnicola escharioides" }, { species: [{ name: "Naucoria other", confidence: 0.3 }], genus: [{ name: "Naucoria", confidence: 0.9 }] });
  assert.equal(genusOnly.outcome === "agrees" && genusOnly.branch, "genus", "a synonym genus is not a veto");
});

test("case and spacing do not matter", () => {
  const d = decide({ species: "Picipes  tubaeformis " }, { species: [{ name: "picipes tubaeformis", confidence: 0.9 }], genus: [] });
  // "picipes" in lower case is not read as a genus by the name parser: no species match then, but no veto either.
  assert.notEqual(d.outcome, "vetoes");
  const d2 = decide({ species: "Picipes  tubaeformis " });
  assert.equal(d2.outcome, "agrees");
});

// ── Guards ──────────────────────────────────────────────────────────────────

test("Vision's not-a-fungus gate must have passed: not_fungus, unsure or unreported blocks", () => {
  for (const gate of ["not_fungus", "unsure", null]) {
    const d = decide({}, { gateVerdict: gate });
    assert.equal(d.outcome === "none" && d.reason, "gate_not_passed", String(gate));
  }
});

test("the analysis' contaminant flag blocks", () => {
  const d = decide({ contaminant: true });
  assert.equal(d.outcome === "none" && d.reason, "contaminant");
});

test("an eDNA sample never takes the rule", () => {
  const d = decide({ edna: true });
  assert.equal(d.outcome === "none" && d.reason, "edna");
});

test("no Vision answer yet: nothing decided", () => {
  const d = decide({}, null);
  assert.equal(d.outcome === "none" && d.reason, "no_vision_answer");
});

// ── The genus veto ──────────────────────────────────────────────────────────

test("veto: Vision's top genus differs above 50% → held, even for a DNA result at 70% or more", () => {
  for (const conf of [70, 95, 100]) {
    const d = decide({ species: "Trametes versicolor", nameConfidence: conf }, {
      species: [{ name: "Picipes tubaeformis", confidence: 0.9 }], genus: [{ name: "Picipes", confidence: 0.92 }],
    });
    assert.equal(d.outcome, "vetoes", String(conf));
  }
});

test("a different genus at exactly 0.50 does not veto", () => {
  const d = decide({ species: "Trametes versicolor", nameConfidence: 90 }, {
    species: [{ name: "Picipes tubaeformis", confidence: 0.5 }], genus: [{ name: "Picipes", confidence: 0.5 }],
  });
  assert.equal(d.outcome, "none");
});

test("a failed gate never vetoes", () => {
  for (const gate of ["not_fungus", "unsure", null]) {
    const d = decide({ species: "Trametes versicolor", nameConfidence: 90 }, {
      gateVerdict: gate, species: [{ name: "Picipes tubaeformis", confidence: 0.9 }], genus: [{ name: "Picipes", confidence: 0.92 }],
    });
    assert.notEqual(d.outcome, "vetoes", String(gate));
  }
});

test("eDNA never vetoes", () => {
  const d = decide({ species: "Trametes versicolor", nameConfidence: 90, edna: true }, {
    species: [{ name: "Picipes tubaeformis", confidence: 0.9 }], genus: [{ name: "Picipes", confidence: 0.92 }],
  });
  assert.equal(d.outcome === "none" && d.reason, "edna");
});

test("if Vision's ranks disagree, the DNA species decides the genus: a confident other genus with S absent is held", () => {
  const d = decide({}, { species: [{ name: "Polyporus squamosus", confidence: 0.25 }], genus: [{ name: "Polyporus", confidence: 0.7 }] });
  assert.equal(d.outcome, "vetoes");
  assert.equal(d.dnaGenus, "Picipes");
});

test("if Vision's ranks disagree but its top species is S above 50%, the DNA stands and the species branch green-checks", () => {
  const d = decide({}, { species: [{ name: "Picipes tubaeformis", confidence: 0.6 }], genus: [{ name: "Polyporus", confidence: 0.7 }] });
  assert.equal(d.outcome === "agrees" && d.branch, "species");
  assert.deepEqual(d.vetoSpared, { rank: "species", name: "Picipes tubaeformis", probability: 0.6 });
});

test("the veto reason names both genera, and that neither DNA name is on Vision's list, for Autovalidation Assist", () => {
  const d = decide({ species: "Trametes versicolor", nameConfidence: 90 }, { species: [], genus: [{ name: "Picipes", confidence: 0.92 }] });
  assert.equal(visionVetoReason(d),
    "MycoMap Vision says genus Picipes (92%), DNA says Trametes, and Vision shows neither Trametes nor Trametes versicolor on its list: held for a person.");
  assert.equal(describeVisionAgreement(d, true),
    "Vision says genus Picipes 92%, DNA says Trametes, and Vision shows neither Trametes nor Trametes versicolor on its list: held for a person (Held by MycoMap Vision)");
});

// ── The veto spares a DNA name Vision also shows (2026-10-23, confirmed 2026-10-25) ──

const RUSSULA_DNA = { species: "Russula emetica", nameConfidence: 90 };
const BOLETUS_TOP = (russulaGenus: number, extraSpecies: Array<{ name: string; confidence: number }> = []) => ({
  species: [{ name: "Boletus edulis", confidence: 0.5 }, ...extraSpecies],
  genus: [{ name: "Boletus", confidence: 0.55 }, { name: "Russula", confidence: russulaGenus }],
});

test("An example: DNA Russula at 90%, Vision Boletus 55% and Russula 35% → the DNA stands, no hold", () => {
  const d = decide(RUSSULA_DNA, BOLETUS_TOP(0.35));
  assert.notEqual(d.outcome, "vetoes");
  assert.equal(d.outcome === "none" && d.reason, "vision_prefers_another_genus", "no Vision green-check either: the DNA alone validates a 90% record");
  assert.deepEqual(d.vetoSpared, { rank: "genus", name: "Russula", probability: 0.35 });
  assert.equal(describeVisionAgreement(d),
    "Vision's top genus is Boletus (55%), but it also shows Russula (35%), so the DNA stands. Below 70%, Vision does not green-check it: Vision's top genus is another, so the DNA must reach 70 on its own.");
});

test("the DNA genus at 10% as displayed spares the record", () => {
  const d = decide(RUSSULA_DNA, BOLETUS_TOP(0.096));
  assert.notEqual(d.outcome, "vetoes");
  assert.equal(d.vetoSpared?.rank, "genus");
});

test("the DNA genus under 10% as displayed does not spare it: held", () => {
  const d = decide(RUSSULA_DNA, BOLETUS_TOP(0.094));
  assert.equal(d.outcome, "vetoes");
  assert.equal(d.vetoSpared, null);
});

test("the DNA's exact species anywhere on the species list spares it, at any percentage (inat:405972885)", () => {
  const d = decide(RUSSULA_DNA, BOLETUS_TOP(0.02, [{ name: "Russula emetica", confidence: 0.03 }]));
  assert.notEqual(d.outcome, "vetoes");
  assert.deepEqual(d.vetoSpared, { rank: "species", name: "Russula emetica", probability: 0.03 });
});

test("the DNA's family on the top list spares it, when the family is known", () => {
  const vision_ = { ...BOLETUS_TOP(0.02), family: [{ name: "Boletaceae", confidence: 0.6 }, { name: "Russulaceae", confidence: 0.2 }] };
  const d = decideVisionAgreement({ dna: dna(RUSSULA_DNA), vision: vision(vision_), dnaFamily: "Russulaceae" });
  assert.notEqual(d.outcome, "vetoes");
  assert.equal(d.vetoSpared?.rank, "family");
  assert.equal(decideVisionAgreement({ dna: dna(RUSSULA_DNA), vision: vision(vision_) }).outcome, "vetoes", "no family, no match");
});

test("Vision's top family being the DNA's backs it, though another genus leads (inat:405599978, inat:351375760)", () => {
  const vision_ = vision({
    species: [{ name: "Hypoxylon perforatum", confidence: 0.4 }],
    genus: [{ name: "Hypoxylon", confidence: 0.72 }, { name: "Jackrogersella", confidence: 0.25 }],
    family: [{ name: "Hypoxylaceae", confidence: 0.97 }],
  });
  const decision = decideVisionAgreement({ dna: dna({ species: "Jackrogersella cohaerens", nameConfidence: 50 }), vision: vision_, dnaFamily: "Hypoxylaceae" });
  assert.equal(decision.outcome === "none" && decision.reason, "names_differ");
  const agreed = decideTopListAgreement({ decision, dnaFamily: "Hypoxylaceae", vision: vision_ });
  assert.equal(agreed?.outcome, "agrees");
  assert.equal(agreed?.outcome === "agrees" && agreed.branch, "top_list");
});

test("sure of another genus but showing the DNA is neutral: under 70 it neither lifts nor applies the floor", () => {
  const vision_ = vision({
    species: [{ name: "Tricholoma fulvum", confidence: 0.6 }],
    genus: [{ name: "Tricholoma", confidence: 0.82 }, { name: "Hypholoma", confidence: 0.13 }],
    family: [{ name: "Tricholomataceae", confidence: 0.84 }, { name: "Strophariaceae", confidence: 0.13 }],
  });
  const decision = decideVisionAgreement({ dna: dna({ species: "Hypholoma lateritium", nameConfidence: 57 }), vision: vision_, dnaFamily: "Strophariaceae" });
  assert.equal(decision.outcome === "none" && decision.reason, "vision_prefers_another_genus");
  assert.equal(decideTopListAgreement({ decision, dnaFamily: "Strophariaceae", vision: vision_ }), null);
  assert.equal(decideFamilyPenaltyLift({ decision, dnaFamily: "Strophariaceae", vision: vision_, sequences: [{ id: "1", analysis: { finalSpecies: "Hypholoma lateritium", finalConfidence: 57, confidenceBreakdown: { familyMismatchPenalty: 50 } } }] }), null);
});

test("inat:405972941: DNA Crepidotus, Vision Panellus, Crepidotus at 2.6% and another Crepidotus species listed: against", () => {
  const d = decideVisionAgreement({
    dna: dna({ species: "Crepidotus sp. 'IN03'", nameConfidence: 88 }),
    dnaFamily: "Crepidotaceae",
    vision: vision({
      species: [{ name: "Panellus stipticus", confidence: 0.78 }, { name: "Crepidotus sp. 'versutus-OH01'", confidence: 0.024 }],
      genus: [{ name: "Panellus", confidence: 0.835 }, { name: "Crepidotus", confidence: 0.026 }],
      family: [{ name: "Mycenaceae", confidence: 0.836 }, { name: "Crepidotaceae", confidence: 0.026 }],
    }),
  });
  assert.equal(d.outcome, "vetoes");
});

test("the floor reads the score with the observer's-family penalty off, when Vision's backing clears it", () => {
  const vision_ = vision({ species: [], genus: [{ name: "Rutstroemia", confidence: 0.4 }], family: [{ name: "Rutstroemiaceae", confidence: 0.4 }] });
  const decision = decideVisionAgreement({ dna: dna({ species: "Rutstroemia sp. 'PA03'", nameConfidence: 10 }), vision: vision_ });
  assert.equal(decideTopListAgreement({ decision, dnaFamily: null, vision: vision_ }), null);
  assert.equal(decideTopListAgreement({ decision, dnaFamily: null, vision: vision_, scoreWithoutPenalty: 60 })?.outcome, "agrees");
  assert.equal(decideTopListAgreement({ decision, dnaFamily: null, vision: vision_, scoreWithoutPenalty: 19 }), null);
});

test("scoreWithoutFamilyPenalty adds the penalty back, for this species only, at most 100", () => {
  const seqs = [
    { analysis: { finalSpecies: "A b", finalConfidence: 40, confidenceBreakdown: { familyMismatchPenalty: 50 } } },
    { analysis: { finalSpecies: "A b", finalConfidence: 95, confidenceBreakdown: { familyMismatchPenalty: 50 } } },
    { analysis: { finalSpecies: "C d", finalConfidence: 99 } },
    { analysis: null },
  ];
  assert.equal(scoreWithoutFamilyPenalty("A b", seqs), 100);
  assert.equal(scoreWithoutFamilyPenalty("A b", seqs.slice(0, 1)), 90);
  assert.equal(scoreWithoutFamilyPenalty("Z z", seqs), null);
  assert.equal(scoreWithoutFamilyPenalty(null, seqs), null);
});

test("another species of G does not count as S", () => {
  const d = decide(RUSSULA_DNA, BOLETUS_TOP(0.05, [{ name: "Russula ochroleuca", confidence: 0.04 }]));
  assert.equal(d.outcome, "vetoes");
});

test("a real veto still holds: top other genus at 0.80, G at 0.05, S absent", () => {
  const d = decide(RUSSULA_DNA, {
    species: [{ name: "Boletus edulis", confidence: 0.7 }],
    genus: [{ name: "Boletus", confidence: 0.8 }, { name: "Russula", confidence: 0.05 }],
  });
  assert.equal(d.outcome, "vetoes");
  assert.equal(d.vetoSpared, null);
});

test("below 70% with G at 0.35 and no agreement: not held, and no Vision green-check (goes to Assist as before)", () => {
  const d = decide({ species: "Russula emetica", nameConfidence: 50 }, BOLETUS_TOP(0.35));
  assert.equal(d.outcome, "none");
  assert.ok(d.vetoSpared);
});

test("without a genus rank, G is summed from Vision's species for the spare too", () => {
  const d = decide(RUSSULA_DNA, {
    species: [{ name: "Boletus edulis", confidence: 0.6 }, { name: "Russula ochroleuca", confidence: 0.2 }, { name: "Russula nobilis", confidence: 0.15 }],
    genus: [],
  });
  assert.notEqual(d.outcome, "vetoes");
  assert.equal(d.vetoSpared?.rank, "genus");
  assert.ok(Math.abs((d.vetoSpared?.probability ?? 0) - 0.35) < 1e-9);
});

test("a spared record whose top species is S above 50% green-checks by species, and the line says why the veto did not fire", () => {
  const d = decide({ species: "Russula emetica", nameConfidence: 50 }, {
    species: [{ name: "Russula emetica", confidence: 0.6 }], genus: [{ name: "Boletus", confidence: 0.55 }, { name: "Russula", confidence: 0.4 }],
  });
  assert.equal(d.outcome === "agrees" && d.branch, "species");
  assert.equal(describeVisionAgreement(d, true),
    "Vision: Russula emetica 60% — agrees → green-checked (DNA + MycoMap Vision). Vision's top genus is Boletus (55%), but it also shows Russula (40%), so the DNA stands.");
});

// ── The observer's identification sets the veto aside (2026-11-01, #364) ──

// inat:393237313, the record #364 is about: DNA Xanthoconium affine var.
// reticulatum, Vision Leccinum 78%, the observer's identification in Xanthoconium.
const XANTHO_DNA = { species: "Xanthoconium affine var. reticulatum", nameConfidence: 92 };
const LECCINUM_TOP = {
  species: [{ name: "Leccinum scabrum", confidence: 0.4 }, { name: "Leccinum versipelle", confidence: 0.2 }],
  genus: [{ name: "Leccinum", confidence: 0.78 }, { name: "Xanthoconium", confidence: 0.05 }],
};
const own = (name: string | null): VisionAgreementObserver => ({ name, source: "observer_identification" });
const decideWith = (observer: VisionAgreementObserver | null, d: Partial<VisionAgreementDna> = XANTHO_DNA, v: Partial<VisionAgreementVision> = LECCINUM_TOP) =>
  decideVisionAgreement({ dna: dna(d), vision: vision(v), observer });

test("#364: Vision says another genus, the observer's identification is in the DNA genus → no veto, the DNA stands", () => {
  const d = decideWith(own("Xanthoconium affine reticulatum"));
  assert.notEqual(d.outcome, "vetoes");
  assert.equal(d.outcome === "none" && d.reason, "vision_prefers_another_genus", "Vision green-checks nothing: the DNA rules decide");
  assert.equal(d.vetoSpared, null, "Vision itself does not show Xanthoconium");
  assert.deepEqual(d.vetoSparedByObserver, { name: "Xanthoconium affine reticulatum", source: "observer_identification", genus: "Xanthoconium" });
  assert.equal(describeVisionAgreement(d),
    "Vision's top genus is Leccinum (78%), but the observer's identification Xanthoconium affine reticulatum is in the DNA genus Xanthoconium, so the DNA stands. Below 70%, Vision does not green-check it: Vision's top genus is another, so the DNA must reach 70 on its own.");
});

test("an observer's identification at genus rank in the DNA genus counts", () => {
  const d = decideWith(own("Xanthoconium"));
  assert.notEqual(d.outcome, "vetoes");
  assert.equal(d.vetoSparedByObserver?.genus, "Xanthoconium");
});

test("another species of the DNA genus counts: the rule is about the genus", () => {
  assert.notEqual(decideWith(own("Xanthoconium purpureum")).outcome, "vetoes");
});

test("the observer disagrees with the DNA (they agree with Vision): held as before, and the reason names the observer", () => {
  const d = decideWith(own("Leccinum scabrum"));
  assert.equal(d.outcome, "vetoes");
  assert.equal(d.vetoSparedByObserver, null);
  assert.equal(visionVetoReason(d),
    "MycoMap Vision says genus Leccinum (78%), DNA says Xanthoconium, and Vision shows neither Xanthoconium nor Xanthoconium affine var. reticulatum on its list, and the observer's identification Leccinum scabrum is not in Xanthoconium: held for a person.");
});

test("the observer names a third genus: held", () => {
  assert.equal(decideWith(own("Boletus edulis")).outcome, "vetoes");
});

test("an observer's identification above genus (a family holding both genera) does not count: held", () => {
  const d = decideWith(own("Boletaceae"));
  assert.equal(d.outcome, "vetoes");
  assert.equal(d.vetoSparedByObserver, null);
});

test("no observer's identification at all: held as before #364", () => {
  assert.equal(decideWith(null).outcome, "vetoes");
  assert.equal(decideWith(own(null)).outcome, "vetoes");
  assert.equal(decideWith(own("  ")).outcome, "vetoes");
  const d = decide(XANTHO_DNA, LECCINUM_TOP);
  assert.equal(d.outcome, "vetoes", "callers that pass no observer get the old rule");
  assert.equal(d.observer, null);
});

test("genus synonyms count: an observer's Collybiopsis is the DNA's Gymnopus, Alnicola is Naucoria", () => {
  const marasmius = { species: [{ name: "Marasmius oreades", confidence: 0.7 }], genus: [{ name: "Marasmius", confidence: 0.8 }] };
  const d = decideWith(own("Collybiopsis dryophila"), { species: "Gymnopus dryophilus", nameConfidence: 90 }, marasmius);
  assert.notEqual(d.outcome, "vetoes");
  assert.equal(d.vetoSparedByObserver?.genus, "Gymnopus");
  assert.equal(decideWith(own("Alnicola"), { species: "Naucoria escharioides", nameConfidence: 90 }, marasmius).vetoSparedByObserver?.genus, "Naucoria");
});

test("species synonyms count: an observer's Lentinula reticeps is in the DNA's Rhodotus", () => {
  const d = decideWith(own("Lentinula reticeps"), { species: "Rhodotus reticeps", nameConfidence: 90 },
    { species: [{ name: "Pleurotus ostreatus", confidence: 0.7 }], genus: [{ name: "Pleurotus", confidence: 0.8 }] });
  assert.notEqual(d.outcome, "vetoes");
  assert.equal(d.vetoSparedByObserver?.genus, "Rhodotus");
});

test("the observation's name stands in for the observer, and the line says which it was", () => {
  const d = decideWith({ name: "Xanthoconium affine", source: "observation_name" });
  assert.notEqual(d.outcome, "vetoes");
  assert.match(describeVisionAgreement(d), /but the observation's name Xanthoconium affine is in the DNA genus Xanthoconium/);
});

test("Vision showing the DNA still comes first: the observer is not needed and not recorded as the reason", () => {
  const d = decideVisionAgreement({ dna: dna(RUSSULA_DNA), vision: vision(BOLETUS_TOP(0.35)), observer: own("Russula emetica") });
  assert.deepEqual(d.vetoSpared, { rank: "genus", name: "Russula", probability: 0.35 });
  assert.equal(d.vetoSparedByObserver, null);
});

test("Vision agreeing with the DNA is unchanged by the observer, even one naming another genus", () => {
  const d = decideVisionAgreement({ dna: dna(), vision: vision(), observer: own("Trametes versicolor") });
  assert.equal(d.outcome === "agrees" && d.branch, "species");
  assert.equal(d.vetoSparedByObserver, null);
});

test("the guards still come first: eDNA, the not-a-fungus gate and a contaminant are not changed by the observer", () => {
  assert.equal(decideWith(own("Xanthoconium"), { ...XANTHO_DNA, edna: true }).outcome, "none");
  assert.equal(decideWith(own("Xanthoconium"), XANTHO_DNA, { ...LECCINUM_TOP, gateVerdict: "unsure" }).outcome, "none");
  const contaminant = decideWith(own("Xanthoconium"), { ...XANTHO_DNA, contaminant: true });
  assert.equal(contaminant.outcome === "none" && contaminant.reason, "contaminant");
});

test("a record the observer spares is recorded as dna_observer, with why, on its validation method", () => {
  const d = decideWith(own("Xanthoconium affine reticulatum"));
  const ev = visionValidationEvidence(null, d);
  assert.equal(ev.evidence, VISION_OBSERVER_SPARE_EVIDENCE);
  assert.equal(VISION_OBSERVER_SPARE_EVIDENCE, "dna_observer");
  assert.deepEqual(ev.visionAgreement, visionObserverSpareDetail(d as any));
  const detail = ev.visionAgreement as ReturnType<typeof visionObserverSpareDetail>;
  assert.equal(detail.spared, "observer");
  assert.equal(detail.observerName, "Xanthoconium affine reticulatum");
  assert.equal(detail.observerSource, "observer_identification");
  assert.equal(detail.dnaGenus, "Xanthoconium");
  assert.equal(detail.visionName, "Leccinum");
  assert.equal(detail.visionProbability, 0.78);
  assert.match(detail.reason!, /observer's identification Xanthoconium affine reticulatum is in the DNA genus Xanthoconium/);
  assert.deepEqual(validationEvidenceFields({ evidence: "dna_observer", visionAgreement: detail }),
    { evidence: "dna_observer", evidenceLabel: VISION_OBSERVER_SPARE_LABEL, visionBranch: null });
  assert.equal(VISION_OBSERVER_SPARE_LABEL, "DNA + observer's ID over MycoMap Vision");
});

test("Vision's agreement wins the evidence tag; with no second source at all a validation has none", () => {
  const agrees = decide();
  assert.equal(visionValidationEvidence(agrees as any, agrees).evidence, "dna_vision");
  assert.deepEqual(visionValidationEvidence(null, decide(RUSSULA_DNA, BOLETUS_TOP(0.35))), {}, "Vision's own spare stays a DNA-only validation");
  assert.deepEqual(visionValidationEvidence(null, null), {});
  assert.deepEqual(visionValidationEvidence(null, null, { vision: null, observer: null, visionAnswer: null }), {}, "eDNA and MyCoPortal: no second source");
});

// Rules v1.4 (2026-11-09) require a second source; until 2026-11-15 a row
// the DNA's own score made kept no trace of which one (932 of 1125 v1.4 rows on
// production). The record of it is what lets a validation be audited later.
describe("every v1.4 validation records the second source it went through with", () => {
  const visionSpecies = { source: "vision_species" as const, name: "Picipes tubaeformis", percent: 99 };
  const visionGenus = { source: "vision_genus" as const, name: "Picipes", percent: 30, top: false };
  const observerGenus = { source: "observer_genus" as const, name: "Picipes badius", genus: "Picipes" };

  test("the DNA's own score with Vision as second source is dna_vision_second_source, with Vision's run and versions", () => {
    const ev = visionValidationEvidence(null, null, { vision: visionSpecies, observer: null, visionAnswer: vision() });
    assert.equal(ev.evidence, VISION_SECOND_SOURCE_EVIDENCE);
    assert.equal(VISION_SECOND_SOURCE_EVIDENCE, "dna_vision_second_source");
    assert.deepEqual(ev.visionAgreement, { secondSources: [visionSpecies], runId: 7, answersVersion: "a1", modelVersion: "m1" });
  });

  test("Vision and the observer both agreeing: tagged as Vision's, both kept", () => {
    const ev = visionValidationEvidence(null, null, { vision: visionGenus, observer: observerGenus, visionAnswer: vision() });
    assert.equal(ev.evidence, VISION_SECOND_SOURCE_EVIDENCE);
    assert.deepEqual(ev.visionAgreement?.secondSources, [visionGenus, observerGenus]);
  });

  test("the observer as the only second source is dna_observer_second_source", () => {
    const ev = visionValidationEvidence(null, null, { vision: null, observer: observerGenus, visionAnswer: null });
    assert.equal(ev.evidence, OBSERVER_SECOND_SOURCE_EVIDENCE);
    assert.equal(OBSERVER_SECOND_SOURCE_EVIDENCE, "dna_observer_second_source");
    assert.deepEqual(ev.visionAgreement, { secondSources: [observerGenus], runId: null, answersVersion: null, modelVersion: null });
  });

  test("Vision's green-check and the observer's spare keep their tags, and add the second sources found", () => {
    const agrees = decide();
    const ev = visionValidationEvidence(agrees as any, agrees, { vision: visionSpecies, observer: null, visionAnswer: vision() });
    assert.equal(ev.evidence, VISION_AGREEMENT_EVIDENCE);
    assert.deepEqual(ev.visionAgreement, { ...visionAgreementDetail(agrees as any), secondSources: [visionSpecies] });
    const spared = decideWith(own("Xanthoconium affine reticulatum"));
    const ev2 = visionValidationEvidence(null, spared, { vision: null, observer: observerGenus, visionAnswer: null });
    assert.equal(ev2.evidence, VISION_OBSERVER_SPARE_EVIDENCE);
    assert.deepEqual(ev2.visionAgreement?.secondSources, [observerGenus]);
  });

  test("the pages read the two new tags as their own labels", () => {
    assert.deepEqual(validationEvidenceFields({ evidence: "dna_vision_second_source", visionAgreement: { secondSources: [visionSpecies] } }),
      { evidence: "dna_vision_second_source", evidenceLabel: VISION_SECOND_SOURCE_LABEL, visionBranch: null });
    assert.deepEqual(validationEvidenceFields({ evidence: "dna_observer_second_source" }),
      { evidence: "dna_observer_second_source", evidenceLabel: OBSERVER_SECOND_SOURCE_LABEL, visionBranch: null });
    assert.equal(VISION_SECOND_SOURCE_LABEL, "DNA, with MycoMap Vision as second source");
    assert.equal(OBSERVER_SECOND_SOURCE_LABEL, "DNA, with the observer's ID as second source");
  });
});

// ── Vision's genus rank ─────────────────────────────────────────────────────

test("Vision's genus rank is used as reported, not summed", () => {
  const g = visionTopGenus({ species: [{ name: "Picipes a", confidence: 0.4 }, { name: "Picipes b", confidence: 0.4 }], genus: [{ name: "Picipes", confidence: 0.45 }] });
  assert.deepEqual(g, { name: "Picipes", probability: 0.45, computed: false });
});

test("only without a genus rank is it summed from the species (marked computed)", () => {
  const g = visionTopGenus({ species: [{ name: "Picipes a", confidence: 0.3 }, { name: "Picipes b", confidence: 0.3 }, { name: "Trametes c", confidence: 0.2 }], genus: [] });
  assert.equal(g?.name, "Picipes");
  assert.ok(Math.abs((g?.probability ?? 0) - 0.6) < 1e-9);
  assert.equal(g?.computed, true);
});

// ── The record's DNA side ───────────────────────────────────────────────────

test("the DNA side: any contaminant-flagged sequence, any eDNA sequence, the best confidence for S", () => {
  const d = visionAgreementDna({
    species: "Picipes tubaeformis",
    sequences: [
      { id: "1", analysis: { finalSpecies: "Picipes tubaeformis", finalConfidence: 40 } },
      { id: "2", analysis: { finalSpecies: "Picipes tubaeformis", finalConfidence: 50 } },
      { id: "3", analysis: null },
    ],
  });
  assert.deepEqual(d, { species: "Picipes tubaeformis", nameConfidence: 50, contaminant: false, edna: false });
  assert.equal(visionAgreementDna({ species: "X y", sequences: [{ id: "4", analysis: { flaggedContaminant: true } }] }).contaminant, true);
  assert.equal(visionAgreementDna({ species: "X y", sequences: [{ id: "5", analysis: { finalSpecies: "Contaminant: Penicillium" } }] }).contaminant, true);
  assert.equal(visionAgreementDna({ species: "X y", sequences: [{ id: "edna-12", analysis: null }] }).edna, true);
  assert.equal(visionAgreementDna({ species: "X y", sequences: [{ id: "6", analysis: { analysisSubject: "edna-9" } }] }).edna, true);
});

test("only a done run is an answer", () => {
  assert.equal(visionAgreementVisionFromRun({ id: 1, status: "pending", result: null }), null);
  assert.equal(visionAgreementVisionFromRun({ id: 1, status: "failed", result: null }), null);
  const v = visionAgreementVisionFromRun({ id: 3, status: "done", answersVersion: "a", result: { gateVerdict: "fungus", combined: { species: [{ name: "A b", confidence: 0.9 }] } } });
  assert.deepEqual(v, { runId: 3, modelVersion: null, answersVersion: "a", gateVerdict: "fungus", species: [{ name: "A b", confidence: 0.9 }], genus: [], family: [] });
});

// Run 740 as saved on production, trimmed: Vision answered inat:363245311 from
// its own reference copy, so the answer carries no gate verdict.
const referenceRun = (over: Record<string, unknown> = {}) => ({
  id: 740, status: "done", modelVersion: "2026-10-13.4", answersVersion: "f61e129632966132",
  result: {
    gateVerdict: null, excludedReference: true, photosUsed: 5, photosTotal: null, photosMatched: false,
    combined: {
      species: [{ name: "Picipes tubaeformis", confidence: 0.9587 }, { name: "Picipes badius", confidence: 0.0176 }],
      genus: [{ name: "Picipes", confidence: 0.973 }],
    },
    ...over,
  },
});

test("one of Vision's own DNA references passes the gate: it reports no verdict, the record was taken in as a fungus", () => {
  assert.equal(visionAgreementVisionFromRun(referenceRun())!.gateVerdict, "fungus");
});

test("A real record (inat:363245311): DNA Picipes tubaeformis at 55%, Vision 96% from its reference copy → green-checked by species", () => {
  const d = decideVisionAgreement({ dna: dna({ nameConfidence: 55 }), vision: visionAgreementVisionFromRun(referenceRun()) });
  assert.equal(d.outcome, "agrees");
  assert.equal(d.outcome === "agrees" && d.branch, "species");
  assert.equal(d.outcome === "agrees" && d.verdictName, "Picipes tubaeformis");
});

test("a reference record can still be vetoed: it passes the gate like any other answer", () => {
  const v = visionAgreementVisionFromRun(referenceRun({
    combined: { species: [{ name: "Trametes versicolor", confidence: 0.9 }], genus: [{ name: "Trametes", confidence: 0.92 }] },
  }));
  assert.equal(decideVisionAgreement({ dna: dna({ nameConfidence: 90 }), vision: v }).outcome, "vetoes");
});

test("a verdict Vision does report on a reference record still decides", () => {
  for (const gate of ["not_fungus", "unsure"]) {
    const v = visionAgreementVisionFromRun(referenceRun({ gateVerdict: gate }));
    assert.equal(v!.gateVerdict, gate);
    const d = decideVisionAgreement({ dna: dna(), vision: v });
    assert.equal(d.outcome === "none" && d.reason, "gate_not_passed", gate);
  }
});

test("no verdict and not a reference record still fails the gate", () => {
  for (const excludedReference of [false, null, undefined]) {
    const v = visionAgreementVisionFromRun(referenceRun({ excludedReference }));
    assert.equal(v!.gateVerdict, null, String(excludedReference));
    const d = decideVisionAgreement({ dna: dna(), vision: v });
    assert.equal(d.outcome === "none" && d.reason, "gate_not_passed", String(excludedReference));
  }
});

// ── The method tag and the panel's line ─────────────────────────────────────

test("the method tag: dna_vision reads DNA + MycoMap Vision, with the branch that fired", () => {
  assert.equal(VISION_AGREEMENT_EVIDENCE, "dna_vision");
  assert.equal(VISION_AGREEMENT_METHOD_LABEL, "DNA + MycoMap Vision");
  assert.deepEqual(validationEvidenceFields({ evidence: "dna_vision", visionAgreement: { branch: "genus" } }),
    { evidence: "dna_vision", evidenceLabel: "DNA + MycoMap Vision", visionBranch: "genus" });
  assert.deepEqual(validationEvidenceFields({ evidence: null }), { evidence: null, evidenceLabel: null, visionBranch: null });
  assert.deepEqual(validationEvidenceFields({}), { evidence: null, evidenceLabel: null, visionBranch: null });
});

test("the panel's line says which branch fired", () => {
  assert.equal(describeVisionAgreement(decide(), true), "Vision: Picipes tubaeformis 99% — agrees → green-checked (DNA + MycoMap Vision)");
  const genus = decide({}, { species: [{ name: "Picipes badius", confidence: 0.3 }], genus: [{ name: "Picipes", confidence: 0.99 }] });
  assert.equal(describeVisionAgreement(genus, true), "Vision: genus Picipes 99% supports the DNA species → green-checked (DNA + MycoMap Vision)");
  assert.equal(describeVisionAgreement(decide({}, { gateVerdict: "not_fungus" })), "Vision: Picipes tubaeformis 99% — rule not applied: Vision's fungus check did not pass");
  assert.equal(describeVisionAgreement(decide({}, null)), "Vision: rule not applied: no Vision answer yet");
});

// The 50 off for the observer's family (2026-11-04; inat:371864697).
describe("Vision's top list takes away the observer's-family penalty", () => {
  const BRESADOLANA = "Infundibulicybe bresadolana";
  const answer = (over: Partial<VisionAgreementVision> = {}): VisionAgreementVision => ({
    runId: 769, modelVersion: "m", answersVersion: "a", gateVerdict: "fungus",
    species: [{ name: "Pseudoarmillariella ectypoides", confidence: 0.36 }, { name: "Infundibulicybe sp. 'gibba-PNW02'", confidence: 0.22 }],
    genus: [{ name: "Pseudoarmillariella", confidence: 0.44 }, { name: "Infundibulicybe", confidence: 0.27 }, { name: "Rhizocybe", confidence: 0.14 }],
    family: [{ name: "Hygrophoraceae", confidence: 0.46 }, { name: "Omphalinaceae", confidence: 0.28 }, { name: "Lyophyllaceae", confidence: 0.15 }],
    ...over,
  });
  const seq = (id: string, conf: number, penalty: unknown = 50, species = BRESADOLANA) =>
    ({ id, analysis: { finalSpecies: species, finalConfidence: conf, confidenceBreakdown: { familyMismatchPenalty: penalty } } });
  const lift = (o: { vision?: VisionAgreementVision | null; dnaFamily?: string | null; sequences?: ReturnType<typeof seq>[]; contaminant?: boolean; edna?: boolean; decision?: VisionAgreementDecision } = {}) => {
    const vision = o.vision === undefined ? answer() : o.vision;
    const decision = o.decision ?? decideVisionAgreement({ dna: { species: BRESADOLANA, nameConfidence: 41, contaminant: !!o.contaminant, edna: !!o.edna }, vision });
    return decideFamilyPenaltyLift({ decision, dnaFamily: o.dnaFamily === undefined ? "Tricholomataceae" : o.dnaFamily, vision, sequences: o.sequences ?? [seq("840230", 41), seq("840231", 28)] });
  };

  test("the DNA's genus in the top list lifts it, and the best sequence is judged without the 50", () => {
    const d = lift();
    assert.equal(d?.outcome, "agrees");
    assert.equal(d?.branch, "family_penalty");
    assert.equal(d?.verdictName, BRESADOLANA);
    assert.deepEqual(d?.familyPenaltyLift, { rank: "genus", name: "Infundibulicybe", percent: 27, penalty: 50, sequenceId: "840230", withoutPenalty: 91 });
  });
  test("the DNA's family in the top list lifts it too", () => {
    const d = lift({ dnaFamily: "Omphalinaceae", vision: answer({ genus: [{ name: "Pseudoarmillariella", confidence: 0.44 }] }) });
    assert.equal(d?.familyPenaltyLift?.rank, "family");
    assert.equal(d?.familyPenaltyLift?.name, "Omphalinaceae");
  });
  test("neither in the top list: no lift", () => {
    assert.equal(lift({ dnaFamily: "Tricholomataceae", vision: answer({ genus: [{ name: "Pseudoarmillariella", confidence: 0.44 }] }) }), null);
  });
  test("under 10% as displayed, or past the third name, is not in the top list", () => {
    const families: VisionAgreementVision["family"] = [];
    assert.equal(lift({ dnaFamily: null, vision: answer({ family: families, genus: [{ name: "Pseudoarmillariella", confidence: 0.44 }, { name: "Infundibulicybe", confidence: 0.094 }] }) }), null);
    assert.equal(lift({ dnaFamily: null, vision: answer({ family: families, genus: [{ name: "A", confidence: 0.3 }, { name: "B", confidence: 0.25 }, { name: "C", confidence: 0.2 }, { name: "Infundibulicybe", confidence: 0.15 }] }) }), null);
    assert.ok(lift({ dnaFamily: null, vision: answer({ family: families, genus: [{ name: "Pseudoarmillariella", confidence: 0.44 }, { name: "Infundibulicybe", confidence: 0.095 }] }) }), "10% as displayed counts");
  });
  test("no penalty on the record, nothing to lift", () => {
    assert.equal(lift({ sequences: [seq("1", 41, 0)] }), null);
    assert.equal(lift({ sequences: [seq("1", 41, null)] }), null);
  });
  test("still under 70 without the 50: not validated, only that penalty goes", () => {
    assert.equal(lift({ sequences: [seq("1", 19)] }), null);
    assert.equal(lift({ sequences: [seq("1", 20)] })?.familyPenaltyLift?.withoutPenalty, 70);
  });
  test("a sequence naming another species doesn't count", () => {
    assert.equal(lift({ sequences: [seq("1", 41, 50, "Infundibulicybe gibba")] }), null);
  });
  test("the guards hold: no answer, the fungus gate, a contaminant, eDNA", () => {
    assert.equal(lift({ vision: null }), null);
    assert.equal(lift({ vision: answer({ gateVerdict: "not_fungus" }) }), null);
    assert.equal(lift({ contaminant: true }), null);
    assert.equal(lift({ edna: true }), null);
  });
  test("a veto is never lifted", () => {
    const vision = answer({ genus: [{ name: "Boletus", confidence: 0.8 }, { name: "Infundibulicybe", confidence: 0.05 }], species: [{ name: "Boletus edulis", confidence: 0.7 }] });
    const decision = decideVisionAgreement({ dna: { species: BRESADOLANA, nameConfidence: 41, contaminant: false, edna: false }, vision });
    assert.equal(decision.outcome, "vetoes");
    assert.equal(lift({ decision, vision }), null);
  });
  test("it says what happened, and the row keeps it", () => {
    const d = lift()!;
    assert.match(describeVisionAgreement(d), /Vision lists genus Infundibulicybe 27%.*50 off for the observer's family.*DNA 91%.*green-checks \(DNA \+ MycoMap Vision\)/);
    const detail = visionAgreementDetail(d);
    assert.equal(detail.branch, "family_penalty");
    assert.equal(detail.visionName, "Infundibulicybe");
    assert.equal(detail.visionProbability, 0.27);
    assert.equal(validationEvidenceFields({ evidence: "dna_vision", visionAgreement: detail }).visionBranch, "family_penalty");
  });
});

// The floor of 20 (2026-11-05; inat:351375760).
describe("a floor of 20 with Vision's top list", () => {
  const MAUB = "Maublancomyces montanus";
  const answer = (over: Partial<VisionAgreementVision> = {}): VisionAgreementVision => ({
    runId: 780, modelVersion: "m", answersVersion: "a", gateVerdict: "fungus",
    species: [{ name: "Gyromitra venenata", confidence: 0.4 }, { name: "Maublancomyces montanus", confidence: 0.13 }],
    genus: [{ name: "Gyromitra", confidence: 0.49 }, { name: "Maublancomyces", confidence: 0.3 }],
    family: [{ name: "Discinaceae", confidence: 0.99 }],
    ...over,
  });
  const decide = (o: { conf?: number | null; vision?: VisionAgreementVision | null; family?: string | null; contaminant?: boolean; edna?: boolean; species?: string } = {}) => {
    const vision = o.vision === undefined ? answer() : o.vision;
    const decision = decideVisionAgreement({ dna: { species: o.species ?? MAUB, nameConfidence: o.conf === undefined ? 50 : o.conf, contaminant: !!o.contaminant, edna: !!o.edna }, vision });
    return decideTopListAgreement({ decision, dnaFamily: o.family === undefined ? "Discinaceae" : o.family, vision });
  };

  test("the DNA's genus in the top list, at 20 or more, validates the DNA's species", () => {
    const d = decide();
    assert.equal(d?.outcome, "agrees");
    assert.equal(d?.branch, "top_list");
    assert.equal(d?.verdictName, MAUB);
    assert.deepEqual(d?.topListMatch, { rank: "genus", name: "Maublancomyces", percent: 30 });
  });
  test("the DNA's family is enough when its genus isn't listed", () => {
    const d = decide({ vision: answer({ genus: [{ name: "Gyromitra", confidence: 0.49 }] }) });
    assert.deepEqual(d?.topListMatch, { rank: "family", name: "Discinaceae", percent: 99 });
  });
  test("exactly 20 passes; under 20, or no score, doesn't", () => {
    assert.ok(decide({ conf: 20 }));
    assert.equal(decide({ conf: 19.9 }), null);
    assert.equal(decide({ conf: null }), null);
  });
  test("neither the family nor the genus in the top list: no agreement", () => {
    assert.equal(decide({ family: "Morchellaceae", vision: answer({ species: [], genus: [{ name: "Gyromitra", confidence: 0.49 }] }) }), null);
    assert.equal(decide({ family: null, vision: answer({ species: [], genus: [{ name: "Gyromitra", confidence: 0.49 }, { name: "Maublancomyces", confidence: 0.094 }] }) }), null);
  });
  test("the guards hold: no answer, the fungus gate, a contaminant, eDNA, a name that isn't a species", () => {
    assert.equal(decide({ vision: null }), null);
    assert.equal(decide({ vision: answer({ gateVerdict: "unsure" }) }), null);
    assert.equal(decide({ contaminant: true }), null);
    assert.equal(decide({ edna: true }), null);
    assert.equal(decide({ species: "Maublancomyces sp." }), null);
  });
  test("a veto is never overturned", () => {
    const vision = answer({ genus: [{ name: "Gyromitra", confidence: 0.75 }, { name: "Maublancomyces", confidence: 0.05 }], species: [{ name: "Gyromitra venenata", confidence: 0.7 }] });
    const decision = decideVisionAgreement({ dna: { species: MAUB, nameConfidence: 50, contaminant: false, edna: false }, vision });
    assert.equal(decision.outcome, "vetoes");
    assert.equal(decideTopListAgreement({ decision, dnaFamily: "Discinaceae", vision }), null);
  });
  test("it says what happened, and the row keeps it", () => {
    const d = decide()!;
    assert.match(describeVisionAgreement(d), /Vision lists genus Maublancomyces 30%.*DNA at 50% \(20% or more\).*green-checks \(DNA \+ MycoMap Vision\)/);
    const detail = visionAgreementDetail(d);
    assert.equal(detail.branch, "top_list");
    assert.equal(detail.visionName, "Maublancomyces");
    assert.equal(detail.visionProbability, 0.3);
    assert.equal(validationEvidenceFields({ evidence: "dna_vision", visionAgreement: detail }).visionBranch, "top_list");
  });
});

// ── A second source besides the DNA (2026-11-09) ───────────────────────

const ownId = (name: string): VisionAgreementObserver => ({ name, source: "observer_identification" });

describe("the second source", () => {
  test("the DNA's exact species on Vision's list counts at 10% as shown, not below", () => {
    const v = vision({ species: [{ name: "Marasmiellus sp. 'candidus-IN01'", confidence: 0.35 }, { name: "Marasmius falcatipes", confidence: 0.1 }], genus: [{ name: "Marasmiellus", confidence: 0.49 }] });
    assert.deepEqual(secondSourceFromVision("Marasmius falcatipes", v), { source: "vision_species", name: "Marasmius falcatipes", percent: 10 });
    const low = vision({ species: [{ name: "Marasmius falcatipes", confidence: 0.094 }], genus: [{ name: "Marasmiellus", confidence: 0.9 }] });
    assert.equal(secondSourceFromVision("Marasmius falcatipes", low), null);
  });

  test("Vision's top genus counts at any percent", () => {
    const v = vision({ species: [], genus: [{ name: "Laccaria", confidence: 0.12 }, { name: "Fuscoporia", confidence: 0.11 }] });
    assert.equal(secondSourceFromVision("Laccaria nobilis", v)?.source, "vision_genus");
  });

  test("a genus below the top counts at 30% as shown, not at 29%", () => {
    const at = (p: number) => vision({ species: [], genus: [{ name: "Trametes", confidence: 0.44 }, { name: "Picipes", confidence: p }] });
    assert.deepEqual(secondSourceFromVision("Picipes tubaeformis", at(0.3)), { source: "vision_genus", name: "Picipes", percent: 30, top: false });
    assert.equal(secondSourceFromVision("Picipes tubaeformis", at(0.29)), null);
  });

  test("with no genus rank, the genus is summed from Vision's species", () => {
    const v = vision({ genus: [], species: [{ name: "Russula emetica", confidence: 0.2 }, { name: "Russula nobilis", confidence: 0.15 }, { name: "Boletus edulis", confidence: 0.4 }] });
    assert.equal(secondSourceFromVision("Russula sp. 'IN7'", v)?.source, "vision_genus");
  });

  test("a shared family is never a second source (inat:391659828)", () => {
    const v = vision({ species: [{ name: "Entoloma strictius", confidence: 0.74 }], genus: [{ name: "Entoloma", confidence: 0.97 }], family: [{ name: "Entolomataceae", confidence: 0.97 }] });
    assert.equal(secondSourceFromVision("Clitopilus sp. 'IN02'", v), null);
  });

  test("an answer that failed Vision's fungus check, or no answer, is no second source", () => {
    assert.equal(secondSourceFromVision("Picipes tubaeformis", vision({ gateVerdict: "unsure" })), null);
    assert.equal(secondSourceFromVision("Picipes tubaeformis", null), null);
  });

  test("the observer's own identification counts when it is in the DNA's genus, after the synonym tables", () => {
    assert.deepEqual(secondSourceFromObserver("Xylaria cornu-damae", ownId("Xylaria")), { source: "observer_genus", name: "Xylaria", genus: "Xylaria" });
    assert.equal(secondSourceFromObserver("Xylaria cornu-damae", ownId("Xylariaceae")), null, "a family is not enough");
    assert.equal(secondSourceFromObserver("Laccaria nobilis", ownId("Lucisporomycetidae")), null);
    assert.equal(secondSourceFromObserver("Xylaria cornu-damae", ownId("Geoglossum")), null);
  });

  test("the observation's name is never a second source: on MycoMap it can be the DNA's own result", () => {
    assert.equal(secondSourceFromObserver("Xylaria cornu-damae", { name: "Xylaria cornu-damae", source: "observation_name" }), null);
    assert.equal(secondSourceFromObserver("Xylaria cornu-damae", null), null);
  });

  test("the reason names what each source said", () => {
    const v = vision({ species: [{ name: "Fuscoporia viticola", confidence: 0.19 }], genus: [{ name: "Fuscoporia", confidence: 0.27 }] });
    assert.equal(
      noSecondSourceReason({ species: "Laccaria nobilis", vision: v, observer: ownId("Lucisporomycetidae") }),
      "No second source for the DNA's Laccaria nobilis: MycoMap Vision's top genus is Fuscoporia (27%), and it shows neither Laccaria at 30% nor the DNA's species at 10%, and the observer's identification (Lucisporomycetidae) is not in Laccaria. Held for a person.",
    );
    assert.match(noSecondSourceReason({ species: "Laccaria nobilis", vision: null, observer: null }), /MycoMap Vision found no usable photos, and there is no identification from the observer/);
  });
});
