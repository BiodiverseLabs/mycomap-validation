import { test } from "node:test";
import assert from "node:assert/strict";
import {
  uploadAutoTrashLengthBp,
  classifyPrimerTitles,
  chimeraLengthCeilingBp,
  UPLOAD_AUTO_TRASH_BP_FUNGAL_ITS,
} from "../src/ednaAmplicon";

test("a full-ITS read of 600-1,099 bp is not trashed at upload; 1,100 bp and up still is", () => {
  const ceiling = uploadAutoTrashLengthBp("ITS1F", "ITS4");
  assert.equal(ceiling, 1100);
  assert.equal(UPLOAD_AUTO_TRASH_BP_FUNGAL_ITS, 1100);
  for (const len of [600, 684, 750, 899, 1099]) assert.ok(len < ceiling!, `${len} bp must survive the upload`);
  assert.ok(1100 >= ceiling!);
});

test("ITS2-only primer pairs use the same ITS ceiling", () => {
  assert.equal(uploadAutoTrashLengthBp("gITS7", "ITS4"), 1100);
  assert.equal(uploadAutoTrashLengthBp("fITS7", "ITS4"), 1100);
});

test("an amplicon that reaches into the LSU is never trashed on length alone", () => {
  for (const [fwd, rev] of [["ITS1F", "LR3"], ["ITS1F", "LR5"], ["LR0R", "LR5"], ["ITS1F", "NLB4"], ["NL1", "NL4"]]) {
    assert.equal(uploadAutoTrashLengthBp(fwd, rev), null, `${fwd}/${rev}`);
  }
});

test("bacterial 16S keeps its 1,700 bp ceiling, and unknown primers are never trashed on length", () => {
  assert.equal(uploadAutoTrashLengthBp("27F", "1492R"), 1700);
  assert.equal(uploadAutoTrashLengthBp("SlimeTemp1", "SlimeTemp1"), null);
  assert.equal(uploadAutoTrashLengthBp(null, null), null);
});

test("the analysis-time threshold is unchanged (it also requires missing BLAST coverage)", () => {
  assert.equal(classifyPrimerTitles("ITS1F", "ITS4"), "fungal_its");
  assert.equal(chimeraLengthCeilingBp("fungal_its"), 600);
  assert.equal(chimeraLengthCeilingBp("bacterial_16s"), 1700);
  assert.equal(chimeraLengthCeilingBp("other"), null);
});
