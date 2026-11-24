// One vote per specimen in the species vote (specimenVotes.ts), the rule the server and
// the web page's own analysis share. The case: seq 865264, where four variant reads of one well
// outvoted eight other records (2026-11-10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { countSpecimens, oneVotePerSpecimen, specimenVoteNote, validatedHitPhrase } from "../src/specimenVotes";

const e = (binomial: string, specimenKey: string | null, adjIdentity = 100) => ({ binomial, specimenKey, adjIdentity });

test("variant reads of one specimen under one name are one vote", () => {
  const votes = oneVotePerSpecimen([
    e("Strobilomyces strobilaceus", "inat:397552553"), e("Strobilomyces strobilaceus", "inat:397552553"),
    e("Strobilomyces strobilaceus", "inat:397552553"), e("Strobilomyces strobilaceus", "inat:397552553"),
  ]);
  assert.equal(votes.length, 1);
});

test("different specimens under one name each vote", () => {
  assert.equal(oneVotePerSpecimen([e("Suillus luteus", "inat:1"), e("Suillus luteus", "inat:2"), e("Suillus luteus", "mo:3")]).length, 3);
});

test("a specimen whose reads carry two names votes once for each", () => {
  const votes = oneVotePerSpecimen([e("Suillus luteus", "inat:1"), e("Suillus luteus", "inat:1"), e("Russula emetica", "inat:1")]);
  assert.deepEqual(votes.map(v => v.binomial).sort(), ["Russula emetica", "Suillus luteus"]);
});

test("one provisional taxon written two ways is still one vote for the specimen", () => {
  assert.equal(oneVotePerSpecimen([e("Cortinarius sp. 'IN48'", "inat:1"), e("Cortinarius \"sp-IN48\"", "inat:1")]).length, 1);
});

test("the specimen keeps its best read's identity, so it counts at the tier that read reaches", () => {
  const [vote] = oneVotePerSpecimen([e("Suillus luteus", "inat:1", 99.4), e("Suillus luteus", "inat:1", 100), e("Suillus luteus", "inat:1", 99.6)]);
  assert.equal(vote.adjIdentity, 100);
});

test("a hit that can't be tied to a specimen votes on its own", () => {
  assert.equal(oneVotePerSpecimen([e("Suillus luteus", null), e("Suillus luteus", null), e("Suillus luteus", "")]).length, 3);
});

test("the specimen key ignores case, so INAT:1 and inat:1 are one specimen", () => {
  assert.equal(oneVotePerSpecimen([e("Suillus luteus", "INAT:1"), e("Suillus luteus", "inat:1")]).length, 1);
});

test("the note appears only when reads were collapsed", () => {
  assert.equal(specimenVoteNote(5, 5), null);
  assert.match(specimenVoteNote(12, 6) ?? "", /12 hits came from 6 specimen votes/);
});

test("Base's specimen count: reads sharing a specimen count once, whatever the key's case or spacing", () => {
  assert.equal(countSpecimens([{ specimenKey: "inat:1" }, { specimenKey: " INAT:1 " }, { specimenKey: "obs:2" }]), 2);
});

test("Base's specimen count: a hit with no specimen counts alone", () => {
  assert.equal(countSpecimens([{ specimenKey: null }, { specimenKey: "" }, {}, { specimenKey: "mo:3" }]), 4);
});

test("Base's reason names specimens only when reads were collapsed", () => {
  assert.equal(validatedHitPhrase(1, 3), "1 validated MycoBLAST specimen (3 hits; reads of one specimen count once)");
  assert.equal(validatedHitPhrase(3, 3), "3 validated MycoBLAST hits");
  assert.equal(validatedHitPhrase(1, 1), "1 validated MycoBLAST hit");
});
