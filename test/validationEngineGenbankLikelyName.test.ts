// A likely name from GenBank for a specimen MycoMap's own sequences could not
// name (validation engine genbankLikelyName.ts; 2026-11-19): who gets
// one, what it says, and that it never becomes the DNA name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replayCase } from "../src/caseReplay";
import { genbankFamilyCheck, genbankFamilyWarning, genbankLikelyNameApplies, genbankLikelyNameLabel } from "../src/genbankLikelyName";
import { iterativeBinomialConsensus, mostAgreeingPassingTier, REGULAR_CONSENSUS_TIERS, type AnalysisResult } from "../src/analysisRules";
import { buildCase, cleanSpecies, contaminant, range } from "./support/analysisCaseFixtures";

const families = { Cantharellus: "Hydnaceae", "Cantharellus cibarius": "Hydnaceae", Amanita: "Amanitaceae", "Amanita muscaria": "Amanitaceae", "Amanita persicina": "Amanitaceae" };
const ncbi = (n: number, name: string, identity = 100, from = 0) => range(n).map((i) => ({ accession: `OQ90${from + i}`, name, identity }));
const genbankOnly = (hits: Array<{ accession: string; name: string; identity?: number }>, source = "Cantharellus cibarius") =>
  buildCase({ sequenceId: "900101", source: { name: source, rank: "species" }, local: [], ncbi: hits, families });

test("a specimen with only GenBank hits that agree gets GenBank's species as a likely name, and still no DNA name", async () => {
  const { result } = await replayCase(genbankOnly(ncbi(8, "Cantharellus cibarius")));
  assert.equal(result.finalSpecies, null, "GenBank alone does not name a specimen");
  assert.equal(result.finalConfidence, null);
  assert.equal(result.genbankLikelyName?.name, "Cantharellus cibarius");
  assert.equal(result.genbankLikelyName?.rank, "species");
  assert.equal(result.genbankLikelyName?.source, "ncbi_species");
  assert.match(result.genbankLikelyName?.summary ?? "", /8 of 8 NCBI records/);
  assert.equal(genbankLikelyNameLabel(result.genbankLikelyName), `GenBank suggests Cantharellus cibarius (${result.genbankLikelyName?.confidence}%)`);
});

test("with no species GenBank agrees on, the likely name is the genus most GenBank hits at 97% or more share", async () => {
  const split = await replayCase(genbankOnly([...ncbi(3, "Amanita muscaria", 99.8), ...ncbi(3, "Amanita persicina", 99.8, 3)], "Amanita muscaria"));
  assert.equal(split.result.genbankLikelyName?.name, "Amanita sp.");
  assert.equal(split.result.genbankLikelyName?.rank, "genus");
  const distant = await replayCase(genbankOnly(ncbi(8, "Cantharellus cibarius", 98.6)));
  assert.equal(distant.result.genbankLikelyName?.name, "Cantharellus sp.", "below every species tier, the genus still holds");
  const tooFar = await replayCase(genbankOnly(ncbi(2, "Cantharellus cibarius", 95)));
  assert.equal(tooFar.result.genbankLikelyName ?? null, null, "below 97% GenBank suggests nothing");
});

test("no GenBank likely name when MycoMap named the specimen, when MycoMap had hits of its own, or for a contaminant", async () => {
  // MycoMap's validated sequences named it.
  const named = await replayCase(cleanSpecies());
  assert.equal(named.result.finalSpecies, "Russula emetica");
  assert.equal(named.result.genbankLikelyName ?? null, null);
  // MycoMap had hits enough to weigh in, and split: GenBank does not step in.
  const split = await replayCase(buildCase({
    sequenceId: "900102", source: { name: "Amanita muscaria", rank: "species" },
    local: [...range(3).map((i) => ({ accession: String(301 + i), name: "Amanita muscaria", identity: 99.8 })), ...range(3).map((i) => ({ accession: String(311 + i), name: "Amanita persicina", identity: 99.8 }))],
    ncbi: [...ncbi(3, "Amanita muscaria", 99.8), ...ncbi(3, "Amanita persicina", 99.8, 3)], families,
  }));
  assert.equal(split.result.finalSpecies, null);
  assert.equal(split.result.genbankLikelyName ?? null, null);
  // A contaminant keeps its own likely name.
  const mould = await replayCase(contaminant());
  assert.equal(mould.result.flaggedContaminant, true);
  assert.equal(mould.result.contaminantLikelyName?.name, "Cladosporium cladosporioides");
  assert.equal(mould.result.genbankLikelyName ?? null, null);
});

test("who gets a GenBank likely name: no DNA name, only GenBank to go on, and not eDNA, a contaminant, a non-target read, a chimera or an error", () => {
  const base = { status: "complete", finalSpecies: null, flaggedContaminant: false, flaggedNonTarget: false, skipped: true } as unknown as AnalysisResult;
  const only = { isEdna: false, mycomapQualified: 0 };
  assert.equal(genbankLikelyNameApplies(base, only), true, "ended with no name ('skipped' is set then)");
  assert.equal(genbankLikelyNameApplies(base, { ...only, mycomapQualified: 1 }), true, "one MycoMap hit is not enough to name it");
  assert.equal(genbankLikelyNameApplies(base, { ...only, mycomapQualified: 2 }), false, "MycoMap had hits enough to weigh in");
  assert.equal(genbankLikelyNameApplies({ ...base, finalSpecies: "Manual Validation Needed" }, only), true);
  assert.equal(genbankLikelyNameApplies({ ...base, finalSpecies: "Russula emetica" }, only), false);
  assert.equal(genbankLikelyNameApplies({ ...base, finalSpecies: "Likely Chimera" }, only), false);
  assert.equal(genbankLikelyNameApplies({ ...base, flaggedContaminant: true }, only), false);
  assert.equal(genbankLikelyNameApplies({ ...base, flaggedNonTarget: true }, only), false);
  assert.equal(genbankLikelyNameApplies({ ...base, status: "error" }, only), false);
  assert.equal(genbankLikelyNameApplies(base, { ...only, isEdna: true }), false);
  assert.equal(genbankLikelyNameLabel(null), null);
});

// ── what a likely name rests on: the passing tier with the most agreeing records (2.0.0-beta.3) ──

test("a likely name reports the passing consensus tier that counts the most agreeing records; naming a specimen still takes the strictest", () => {
  const votes = (n: number, binomial: string, adjIdentity: number) => Array.from({ length: n }, () => ({ binomial, adjIdentity }));
  // Two at 100% and six at 99.6%: tier A (100%) passes on 2, tier B (99.5%) on all 8.
  const mixed = [...votes(2, "Cantharellus cibarius", 100), ...votes(6, "Cantharellus cibarius", 99.6)];
  const likely = mostAgreeingPassingTier(mixed, REGULAR_CONSENSUS_TIERS);
  assert.deepEqual({ tier: likely.tier, count: likely.topCount, total: likely.total, at: likely.identityThreshold }, { tier: "B", count: 8, total: 8, at: 99.5 });
  const naming = iterativeBinomialConsensus(mixed, REGULAR_CONSENSUS_TIERS);
  assert.deepEqual({ tier: naming.tier, count: naming.topCount }, { tier: "A", count: 2 }, "the strictest passing tier names a specimen, as before");
  // A tie goes to the stricter tier.
  assert.equal(mostAgreeingPassingTier(votes(3, "Cantharellus cibarius", 100), REGULAR_CONSENSUS_TIERS).tier, "A");
  // No tier passing: no tier.
  assert.equal(mostAgreeingPassingTier(votes(1, "Cantharellus cibarius", 100), REGULAR_CONSENSUS_TIERS).tier, null);
});

test("GenBank's and a contaminant's likely names rest on every agreeing record, not only the ones at 100%", async () => {
  const mixedNcbi = (name: string) => [...ncbi(2, name, 100), ...ncbi(6, name, 99.6, 2)];
  const genbank = (await replayCase(genbankOnly(mixedNcbi("Cantharellus cibarius")))).result;
  assert.match(genbank.genbankLikelyName?.summary ?? "", /: 8 of 8 NCBI records at >= 99\.5% identity$/);
  assert.equal(genbank.genbankLikelyName?.confidence, 83);
  const mould = (await replayCase(buildCase({
    sequenceId: "900103", source: { name: "Russula emetica", rank: "species" }, local: [],
    ncbi: mixedNcbi("Cladosporium cladosporioides"), families: { ...families, Russula: "Russulaceae", "Russula emetica": "Russulaceae", Cladosporium: "Cladosporiaceae" },
  }))).result;
  assert.equal(mould.flaggedContaminant, true);
  assert.match(mould.contaminantLikelyName?.summary ?? "", /: 8 of 8 NCBI records at >= 99\.5% identity$/);
});

// ── GenBank's family against the record's (2.0.0-beta.4; sequence 900328, a Laricifomes record whose read is Hyphodiscus) ──

test("a GenBank likely name in another family from the record carries a warning; the same family, or a family not known, carries none", async () => {
  const families: Record<string, string> = { Hyphodiscus: "Hyaloscyphaceae", Laricifomes: "Fomitopsidaceae" };
  const familyOf = async (genus: string) => ({ family: families[genus] ?? null });
  const differs = await genbankFamilyCheck({ name: "Hyphodiscus hymeniophilus" }, "Fomitopsidaceae", familyOf);
  assert.deepEqual(differs, { likelyFamily: "Hyaloscyphaceae", recordFamily: "Fomitopsidaceae", familyDiffers: true });
  assert.equal(genbankFamilyWarning(differs), "GenBank points to Hyaloscyphaceae; the record is Fomitopsidaceae: possibly a specimen switch or an off-target read.");
  const same = await genbankFamilyCheck({ name: "Laricifomes sp." }, "fomitopsidaceae", familyOf);
  assert.equal(same.familyDiffers, false, "families compared without regard to case");
  assert.equal(genbankFamilyWarning(same), null);
  assert.deepEqual(await genbankFamilyCheck({ name: "Hyphodiscus hymeniophilus" }, null, familyOf), {}, "no record family: no check");
  assert.deepEqual(await genbankFamilyCheck({ name: "Unknownia sp." }, "Fomitopsidaceae", familyOf), {}, "the genus has no family: no check");
  assert.deepEqual(await genbankFamilyCheck({ name: "Hyphodiscus hymeniophilus" }, "Fomitopsidaceae", async () => { throw new Error("lookup failed"); }), {},
    "a failed lookup leaves the name without a check, and the analysis goes on");
  assert.equal(genbankFamilyWarning(null), null);
});

test("the analysis warns when GenBank points to another family than the record's, and not when the family is the same", async () => {
  const switchFamilies = { Laricifomes: "Fomitopsidaceae", "Laricifomes officinalis": "Fomitopsidaceae", Hyphodiscus: "Hyaloscyphaceae", "Hyphodiscus hymeniophilus": "Hyaloscyphaceae" };
  const switched = (await replayCase(buildCase({
    sequenceId: "900104", source: { name: "Laricifomes officinalis", rank: "species" }, local: [],
    ncbi: ncbi(5, "Hyphodiscus hymeniophilus", 99.8), families: switchFamilies,
  }))).result;
  assert.equal(switched.finalSpecies, null);
  assert.equal(switched.genbankLikelyName?.name, "Hyphodiscus hymeniophilus");
  assert.equal(switched.genbankLikelyName?.familyDiffers, true);
  assert.match(genbankFamilyWarning(switched.genbankLikelyName) ?? "", /GenBank points to Hyaloscyphaceae; the record is Fomitopsidaceae/);
  const chanterelle = (await replayCase(genbankOnly(ncbi(8, "Cantharellus cibarius")))).result;
  assert.equal(chanterelle.genbankLikelyName?.familyDiffers, false);
  assert.equal(genbankFamilyWarning(chanterelle.genbankLikelyName), null);
});

test("a case recorded before the family check, with no answer for the likely name's genus, replays without the check rather than failing", async () => {
  // The record's family is in the case; Hyphodiscus's is not (the run of that day never asked for it).
  const recorded = buildCase({
    sequenceId: "900105", source: { name: "Laricifomes officinalis", rank: "species" }, local: [],
    ncbi: ncbi(5, "Hyphodiscus hymeniophilus", 99.8), families: { Laricifomes: "Fomitopsidaceae", "Laricifomes officinalis": "Fomitopsidaceae" },
  });
  const { result } = await replayCase(recorded);
  assert.equal(result.genbankLikelyName?.name, "Hyphodiscus hymeniophilus");
  assert.equal(result.genbankLikelyName?.familyDiffers, undefined);
});
