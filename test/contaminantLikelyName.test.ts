// A flagged contaminant gets a likely name and a confidence, from NCBI only
// (contaminantLikelyName.ts). The flag itself is not decided here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTAMINANT_GENUS_IDENTITY,
  contaminantGenusConsensus,
  contaminantLabel,
  contaminantNameBasis,
  contaminantLikelyName,
  contaminantNameStepDetail,
  genusOfHitName,
  likelyContaminantNameFromHits,
  type ContaminantNameVote,
  type TieredConsensusOutcome,
} from "../src/contaminantLikelyName";

const votes = (name: string, n: number, identity = 100): ContaminantNameVote[] =>
  Array.from({ length: n }, () => ({ name, identity }));

test("an NCBI species consensus names the contaminant to species", () => {
  const likely = contaminantLikelyName({
    speciesConsensus: { name: "Cladosporium cladosporioides", count: 18, total: 20, identityThreshold: 99.5 },
    ncbiVotes: votes("Cladosporium cladosporioides", 18),
    listTrigger: { name: "Cladosporium", hits: 9, checked: 10 },
  });
  assert.equal(likely?.name, "Cladosporium cladosporioides");
  assert.equal(likely?.rank, "species");
  assert.equal(likely?.source, "ncbi_species");
  assert.equal(likely?.count, 18);
  assert.equal(likely?.total, 20);
  assert.equal(likely?.identityThreshold, 99.5);
  assert.equal(likely?.onContaminantList, true);
  assert.equal(likely?.summary, "Likely Cladosporium cladosporioides: 18 of 20 NCBI records at >= 99.5% identity");
});

test("a species name is more confident with more agreeing NCBI records, from 60 up to 95", () => {
  const at = (count: number, total: number) => contaminantLikelyName({
    speciesConsensus: { name: "Aspergillus niger", count, total, identityThreshold: 100 },
    ncbiVotes: [],
    listTrigger: null,
  })!.confidence;
  assert.equal(at(2, 2), 71);
  assert.equal(at(29, 29), 95);
  assert.equal(at(500, 500), 95);
  assert.ok(at(7, 10) < at(10, 10), "weaker agreement must score lower");
  assert.ok(at(2, 2) < at(10, 10), "fewer records must score lower");
  for (const [c, t] of [[2, 2], [7, 10], [29, 29], [3, 4]]) {
    const confidence = at(c, t);
    assert.ok(confidence >= 60 && confidence <= 95, `${c}/${t} gave ${confidence}`);
  }
});

test("with no species consensus, the genus most NCBI hits share is the name", () => {
  const ncbiVotes = [
    ...votes("Cladosporium cladosporioides", 4, 99.8),
    ...votes("Cladosporium tenuissimum", 3, 99.8),
    ...votes("Cladosporium sp.", 2, 99.1),
    ...votes("Davidiella tassiana", 1, 98.2),
  ];
  const likely = contaminantLikelyName({ speciesConsensus: null, ncbiVotes, listTrigger: { name: "Cladosporium", hits: 9, checked: 10 } });
  assert.equal(likely?.name, "Cladosporium sp.");
  assert.equal(likely?.rank, "genus");
  assert.equal(likely?.source, "ncbi_genus");
  assert.equal(likely?.count, 9);
  assert.equal(likely?.total, 10);
  assert.equal(likely?.identityThreshold, CONTAMINANT_GENUS_IDENTITY);
  assert.ok(likely!.confidence >= 40 && likely!.confidence <= 75, `genus confidence was ${likely!.confidence}`);
  assert.match(likely!.summary, /^Likely Cladosporium sp\.: 9 of 10 named NCBI records at >= 97% identity are Cladosporium; NCBI has no species consensus$/);
});

test("a genus name never scores as high as the same evidence would for a species", () => {
  const genus = contaminantLikelyName({ speciesConsensus: null, ncbiVotes: votes("Candida albicans", 30), listTrigger: null })!;
  const species = contaminantLikelyName({
    speciesConsensus: { name: "Candida albicans", count: 30, total: 30, identityThreshold: 100 },
    ncbiVotes: [],
    listTrigger: null,
  })!;
  assert.equal(genus.confidence, 75);
  assert.ok(genus.confidence < species.confidence);
});

test("the genus needs hits at 97% or better, at least two of them, and 70% agreement", () => {
  // Below 97%: not counted at all.
  assert.equal(contaminantGenusConsensus(votes("Wallemia sebi", 8, 96.9)), null);
  // One record is not a consensus.
  assert.equal(contaminantGenusConsensus(votes("Wallemia sebi", 1, 99)), null);
  // 6 of 10 is under 70%.
  assert.equal(contaminantGenusConsensus([...votes("Wallemia sebi", 6, 99), ...votes("Aspergillus niger", 4, 99)]), null);
  // 7 of 10 is enough.
  assert.deepEqual(
    contaminantGenusConsensus([...votes("Wallemia sebi", 7, 99), ...votes("Aspergillus niger", 3, 99)]),
    { genus: "Wallemia", count: 7, total: 10 },
  );
  // Exactly 97% counts.
  assert.deepEqual(contaminantGenusConsensus(votes("Wallemia sebi", 2, 97)), { genus: "Wallemia", count: 2, total: 2 });
});

test("a name above genus is not a genus vote", () => {
  assert.equal(genusOfHitName("Saccharomycetales sp."), null);
  assert.equal(genusOfHitName("Mortierellaceae"), null);
  assert.equal(genusOfHitName("Agaricomycetes sp."), null);
  assert.equal(genusOfHitName("fungal sp."), null);
  assert.equal(genusOfHitName("Mortierella alpina"), "Mortierella");
  assert.equal(genusOfHitName("Candida"), "Candida");
  assert.equal(contaminantGenusConsensus(votes("Saccharomycetales sp.", 9, 100)), null);
});

test("with no NCBI consensus at all, the name is the contaminant-list entry that raised the flag", () => {
  const genus = contaminantLikelyName({
    speciesConsensus: null,
    ncbiVotes: [...votes("Candida albicans", 1, 99), ...votes("Pichia kudriavzevii", 1, 99)],
    listTrigger: { name: "Candida", hits: 1, checked: 10 },
  });
  assert.equal(genus?.name, "Candida sp.");
  assert.equal(genus?.rank, "genus");
  assert.equal(genus?.source, "contaminant_list");
  assert.equal(genus?.confidence, 22);
  assert.equal(genus?.identityThreshold, null);
  assert.equal(genus?.summary, "Likely Candida sp.: named in 1 of the top 10 NCBI hits; NCBI has no consensus");

  const order = contaminantLikelyName({ speciesConsensus: null, ncbiVotes: [], listTrigger: { name: "Saccharomycetales", hits: 10, checked: 10 } });
  assert.equal(order?.name, "Saccharomycetales");
  assert.equal(order?.rank, "above_genus");
  assert.equal(order?.confidence, 40);
});

test("the list entry is the least confident name: never above 40", () => {
  for (let hits = 1; hits <= 10; hits++) {
    const likely = contaminantLikelyName({ speciesConsensus: null, ncbiVotes: [], listTrigger: { name: "Aspergillus", hits, checked: 10 } })!;
    assert.ok(likely.confidence >= 20 && likely.confidence <= 40, `${hits}/10 gave ${likely.confidence}`);
  }
});

test("a flag raised by MycoBLAST flags with nothing from NCBI has no name", () => {
  assert.equal(contaminantLikelyName({ speciesConsensus: null, ncbiVotes: [], listTrigger: null }), null);
  assert.equal(contaminantLikelyName({ speciesConsensus: null, ncbiVotes: votes("Mucor hiemalis", 1, 99), listTrigger: null }), null);
});

test("a name that is not on the contaminant list is still given, and marked as off the list", () => {
  // One Candida hit in the top 10 raised the flag, but NCBI agrees on a Russula.
  const likely = contaminantLikelyName({
    speciesConsensus: { name: "Russula emetica", count: 9, total: 9, identityThreshold: 99.5 },
    ncbiVotes: votes("Russula emetica", 9),
    listTrigger: { name: "Candida", hits: 1, checked: 10 },
  });
  assert.equal(likely?.name, "Russula emetica");
  assert.equal(likely?.onContaminantList, false);
});

test("the same hits always give the same genus: a tie goes to the first by name", () => {
  const a = [...votes("Aspergillus niger", 5, 99), ...votes("Zygosaccharomyces rouxii", 5, 99)];
  // 5 of 10 each: no consensus either way round.
  assert.equal(contaminantGenusConsensus(a), null);
  assert.equal(contaminantGenusConsensus([...a].reverse()), null);
  const b = [...votes("Zeta alpha", 2, 99), ...votes("Alpha beta", 2, 99)];
  assert.equal(contaminantGenusConsensus(b), contaminantGenusConsensus([...b].reverse()));
});

test("the label reads 'Contaminant: likely <name> (<n>%)', or the flag alone without a name", () => {
  assert.equal(contaminantLabel({ name: "Cladosporium sp.", confidence: 62 }), "Contaminant: likely Cladosporium sp. (62%)");
  assert.equal(contaminantLabel(null), "Contaminant");
  assert.equal(contaminantLabel(undefined), "Contaminant");
  assert.equal(contaminantNameStepDetail(null), "No likely name: NCBI has no consensus for this sequence");
});

// ---- picking the votes out of an analysis's NCBI hits ----

type Hit = { name: string | null; identity: number | null };
const noTier: TieredConsensusOutcome = { tier: null, topCanonical: null, topCount: 0, total: 0, identityThreshold: 99.35 };

/** A stand-in for the analysis's tiered consensus: passes when every entry at 99.5%+ agrees, 2 or more. */
function strictConsensus(seen: { binomial: string; adjIdentity: number }[][]) {
  return (entries: { binomial: string; adjIdentity: number }[]): TieredConsensusOutcome => {
    seen.push(entries);
    const good = entries.filter((e) => e.adjIdentity >= 99.5);
    const names = new Set(good.map((e) => e.binomial));
    if (good.length >= 2 && names.size === 1) {
      return { tier: "B", topCanonical: good[0].binomial, topCount: good.length, total: good.length, identityThreshold: 99.5 };
    }
    return noTier;
  };
}

const helpers = (seen: { binomial: string; adjIdentity: number }[][] = []) => ({
  nameOf: (hit: Hit) => hit.name,
  identityOf: (hit: Hit) => hit.identity,
  isVoteName: (name: string | null) => !!name && name !== "Fungi",
  speciesConsensus: strictConsensus(seen),
});

test("uncultured records, names that may not vote and hits with no identity are left out", () => {
  const seen: { binomial: string; adjIdentity: number }[][] = [];
  const hits: Hit[] = [
    { name: "Aureobasidium pullulans", identity: 100 },
    { name: "Aureobasidium pullulans", identity: 99.8 },
    { name: "uncultured Aureobasidium", identity: 100 },
    { name: "Fungi", identity: 100 },
    { name: null, identity: 100 },
    { name: "Aureobasidium melanogenum", identity: null },
  ];
  const likely = likelyContaminantNameFromHits(hits, helpers(seen), null);
  assert.deepEqual(seen[0], [
    { binomial: "Aureobasidium pullulans", adjIdentity: 100 },
    { binomial: "Aureobasidium pullulans", adjIdentity: 99.8 },
  ]);
  assert.equal(likely?.name, "Aureobasidium pullulans");
  assert.equal(likely?.source, "ncbi_species");
  assert.equal(likely?.count, 2);
});

test("only binomials go to the species consensus; 'Genus sp.' still counts toward the genus", () => {
  const seen: { binomial: string; adjIdentity: number }[][] = [];
  const hits: Hit[] = [
    { name: "Mortierella sp.", identity: 99.9 },
    { name: "Mortierella sp. 'env001'", identity: 99.9 },
    { name: "Mortierella alpina", identity: 99.9 },
    { name: "Mortierella elongata", identity: 99.9 },
  ];
  const likely = likelyContaminantNameFromHits(hits, helpers(seen), null);
  assert.deepEqual(seen[0].map((e) => e.binomial), ["Mortierella alpina", "Mortierella elongata"]);
  assert.equal(likely?.name, "Mortierella sp.");
  assert.equal(likely?.source, "ncbi_genus");
  assert.equal(likely?.count, 4);
  assert.equal(likely?.total, 4);
});

test("a consensus that reached no tier is not used as a species", () => {
  const likely = likelyContaminantNameFromHits(
    [{ name: "Verticillium dahliae", identity: 96 }, { name: "Verticillium dahliae", identity: 96 }],
    { ...helpers(), speciesConsensus: () => ({ tier: null, topCanonical: "Verticillium dahliae", topCount: 2, total: 2, identityThreshold: 99.35 }) },
    { name: "Verticillium", hits: 2, checked: 10 },
  );
  // No tier, and the hits are under 97%, so only the list entry is left.
  assert.equal(likely?.source, "contaminant_list");
  assert.equal(likely?.name, "Verticillium sp.");
});

test("the basis is the evidence without the name, for a line under the name", () => {
  const likely = contaminantLikelyName({
    speciesConsensus: { name: "Wallemia sebi", count: 6, total: 7, identityThreshold: 99.5 },
    ncbiVotes: [],
    listTrigger: null,
  })!;
  assert.equal(contaminantNameBasis(likely), "6 of 7 NCBI records at >= 99.5% identity");
  assert.equal(contaminantNameBasis({ name: "X", summary: "something else" }), "something else");
});

test("'Uncultured Mortierella' records never become a genus called Uncultured", () => {
  const hits: Hit[] = [
    ...Array.from({ length: 5 }, () => ({ name: "Uncultured Mortierella", identity: 100 })),
    { name: "Mortierella alpina", identity: 99.9 },
    { name: "Mortierella elongata", identity: 99.9 },
  ];
  const likely = likelyContaminantNameFromHits(hits, helpers(), null);
  assert.equal(likely?.name, "Mortierella sp.");
  assert.equal(likely?.count, 2);
  assert.equal(likely?.total, 2);
});
