// Rules v2 validate only names that reach species (7.5): every
// provisional style in the data counts, a bare "Genus sp." does not, and a
// verdict an analysis writes in the name's place is never a name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isVerdictText, parseSpeciesName, reachesSpecies, speciesKey } from "../src/autovalidationNames";

const kind = (name: string) => parseSpeciesName(name).kind;

test("binomials and infraspecific names reach species", () => {
  for (const name of ["Abortiporus biennis", "Agaricus sylvaticus occidentalis", "Agaricus porphyrocephalus var. pallidus", "Boletus ameri-subtropicalis", "Amanita muscaria subsp. flavivolvata"]) {
    assert.equal(kind(name), "binomial", name);
    assert.ok(reachesSpecies(parseSpeciesName(name)), name);
  }
});

test("every provisional style in the data reaches species", () => {
  const styles: Array<[string, string]> = [
    ["Adelphella sp. 'babingtonii-CA01'", "babingtonii-CA01"],
    ["Calocera sp. 'NY01'", "NY01"],
    ["Adelphella \"babingtonii-CA01\"", "babingtonii-CA01"],
    ["Alnicola 'escharioides PNW01'", "escharioides PNW01"],
    ["Cortinarius sp-IN67", "IN67"],
    ["Cortinarius \"sp-IN48\"", "sp-IN48"],
    ["Amylocystis PNW01", "PNW01"],
    ["Abies sp. 'env001'", "env001"],
    ["Agaricus sp. 'butyreburneus'", "butyreburneus"],
  ];
  for (const [name, code] of styles) {
    const parsed = parseSpeciesName(name);
    assert.equal(parsed.kind, "provisional", name);
    assert.equal(parsed.rest, code, name);
    assert.ok(reachesSpecies(parsed), name);
  }
});

test("a bare 'Genus sp.' and a genus alone don't reach species", () => {
  for (const name of ["Cortinarius sp.", "Cortinarius sp", "Cortinarius spp.", "Cortinarius sp. ''"]) {
    assert.equal(kind(name), "bare_sp", name);
    assert.ok(!reachesSpecies(parseSpeciesName(name)), name);
  }
  assert.equal(kind("Cortinarius"), "genus_only");
  assert.ok(!reachesSpecies(parseSpeciesName("Cortinarius")));
});

test("names above genus don't reach species", () => {
  for (const name of ["Agaricales", "Cortinariaceae", "Agaricomycetes", "Ascomycota", "Fungi", "Fungi sp.", "Agaricales sp.", "Helotiales sp. ''"]) {
    assert.equal(kind(name), "above_genus", name);
    assert.ok(!reachesSpecies(parseSpeciesName(name)), name);
  }
});

// A provisional name is made at species rank whatever its first word (2026-11-10;
// seq 865264, Helotiales sp. 'PA05'). This reverses the earlier reading of these as above genus.
test("a provisional name under an order, class or kingdom reaches species", () => {
  const cases: Array<[string, string, string]> = [
    ["Helotiales sp. 'PA05'", "Helotiales", "PA05"],
    ["Helotiales sp-PA05", "Helotiales", "PA05"],
    ["Agaricales sp. 'NY01'", "Agaricales", "NY01"],
    ["Agaricomycetes sp. 'env008'", "Agaricomycetes", "env008"],
    ["Fungi sp. 'env001'", "Fungi", "env001"],
  ];
  for (const [name, first, code] of cases) {
    const parsed = parseSpeciesName(name);
    assert.equal(parsed.kind, "provisional", name);
    assert.equal(parsed.genus, first, name);
    assert.equal(parsed.rest, code, name);
    assert.ok(reachesSpecies(parsed), name);
  }
  assert.equal(speciesKey(parseSpeciesName("Helotiales sp. 'PA05'")), speciesKey(parseSpeciesName("Helotiales sp-PA05")));
});

test("verdict texts are not names", () => {
  for (const name of ["Manual Validation Needed", "Singleton Sequence", "Likely Chimera - Singleton Sequence", "Non-Target: Botryobasidium sp. 'CA01'", "Non-Target: No BLAST hits", "Contaminant: Penicillium", "Chimera"]) {
    assert.ok(isVerdictText(name), name);
    assert.equal(kind(name), "verdict", name);
  }
  assert.ok(!isVerdictText("Calocera sp. 'NY01'"));
  assert.equal(kind(""), "empty");
});

test("one provisional taxon written in two styles has one key", () => {
  const a = parseSpeciesName("Alnicola sp. 'escharioides-PNW01'");
  const b = parseSpeciesName("Alnicola 'escharioides PNW01'");
  assert.equal(speciesKey(a), speciesKey(b));
  assert.equal(speciesKey(parseSpeciesName("Cortinarius sp. 'IN48'")), speciesKey(parseSpeciesName("Cortinarius \"sp-IN48\"")));
  assert.notEqual(speciesKey(parseSpeciesName("Russula xerampelina")), speciesKey(parseSpeciesName("Russula olivacea")));
});
