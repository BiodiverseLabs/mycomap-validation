import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  hasExcludedSequenceFlag,
  hasWrongSpecimenFlag,
  isBlockingSequenceFlag,
  isExcludedSequenceFlag,
  sequenceFlagNames,
} from "../src/sequenceExclusionFlags";

describe("sequence exclusion flags", () => {
  test("a wrong-specimen sequence is excluded like a contaminant one, in every shape mycomap.org reads flags", () => {
    for (const flags of [
      ["wrong-specimen"],
      ["wrong"],
      ['{"wrong":true}'],
      '{"low":0,"wrong":1}',
      { wrong: "1" },
    ]) {
      assert.equal(hasExcludedSequenceFlag(flags), true, JSON.stringify(flags));
      assert.equal(hasWrongSpecimenFlag(flags), true, JSON.stringify(flags));
    }
    for (const flags of [["non-target"], ['{"contaminant":true}'], { contaminant: 1 }]) {
      assert.equal(hasExcludedSequenceFlag(flags), true, JSON.stringify(flags));
      assert.equal(hasWrongSpecimenFlag(flags), false, JSON.stringify(flags));
    }
  });

  test("a flag that is present but unset does not exclude", () => {
    assert.equal(hasExcludedSequenceFlag('{"wrong":0,"contaminant":false}'), false);
    assert.equal(hasExcludedSequenceFlag({ wrong: null }), false);
    assert.deepEqual(sequenceFlagNames('{"low":0,"wrong":1,"contaminant":true}'), ["wrong", "contaminant"]);
  });

  test("other flags and no flags do not exclude", () => {
    assert.equal(hasExcludedSequenceFlag(["low-ric", "wrong-orientation", "needs-review"]), false);
    assert.equal(hasExcludedSequenceFlag(null), false);
    assert.equal(hasExcludedSequenceFlag([]), false);
    assert.equal(isExcludedSequenceFlag("orientation"), false);
  });

  test("auto-validation's blocking set takes wrong specimen as well as non-target, mycotroph and low RiC", () => {
    for (const flag of ["wrong-specimen", "Wrong", "non-target", "contaminant", "mycotroph", "m", "low-ric", "l"]) {
      assert.equal(isBlockingSequenceFlag(flag), true, flag);
    }
    assert.equal(isBlockingSequenceFlag("wrong-orientation"), false);
  });
});
