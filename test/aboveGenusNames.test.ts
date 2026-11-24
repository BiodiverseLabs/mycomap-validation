// Names above genus (aboveGenusNames.ts): one rule for the server's analysis, auto-validation's
// name reading and the web page's own analysis.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAboveGenusName, provisionalCode } from "../src/aboveGenusNames";

test("kingdom words and rank endings are above genus, with or without a qualifier", () => {
  for (const name of ["Fungi", "fungi", "FUngi", "Fungi sp.", "Eukaryota", "Basidiomycota", "Agaricomycotina", "Agaricomycetes",
    "Agaricales", "Agaricineae", "Cortinariaceae", "Leccinoideae", "Agaricales sp.", "Helotiales sp", "Helotiales sp. ''"]) {
    assert.equal(isAboveGenusName(name), true, name);
  }
});

test("genera, species and empty names are not", () => {
  for (const name of ["Suillus", "Suillus luteus", "Cortinarius sp. 'IN01'", "uncultured Basidiomycota", "", null, undefined]) {
    assert.equal(isAboveGenusName(name), false, String(name));
  }
});

// Seq 865264: 8 hits named Helotiales sp. 'PA05' were read as an order and dropped from the vote.
test("a provisional name is a species whatever its first word, in every provisional style", () => {
  for (const name of ["Helotiales sp. 'PA05'", "Helotiales sp-PA05", "Helotiales \"sp-PA05\"", "Helotiales PA05",
    "Agaricales sp. 'NY01'", "Agaricomycetes sp. 'env008'", "Fungi sp. 'env001'", "Helotiaceae ‘IN01’"]) {
    assert.equal(isAboveGenusName(name), false, name);
  }
});

test("the provisional code is read the same way in each style, and a bare sp. has none", () => {
  assert.equal(provisionalCode("sp. 'PA05'"), "PA05");
  assert.equal(provisionalCode("sp-PA05"), "PA05");
  assert.equal(provisionalCode("\"sp-PA05\""), "sp-PA05");
  assert.equal(provisionalCode("'escharioides PNW01'"), "escharioides PNW01");
  assert.equal(provisionalCode("PNW01"), "PNW01");
  for (const rest of ["sp.", "sp", "spp.", "sp. ''", "", null, "luteus"]) {
    assert.equal(provisionalCode(rest), null, String(rest));
  }
});
