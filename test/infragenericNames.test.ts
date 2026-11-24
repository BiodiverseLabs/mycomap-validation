// Groups inside a genus, as iNat names them with one word (infragenericNames.ts).
import assert from "node:assert/strict";
import test from "node:test";
import {
  INFRAGENERIC_RANKS, isBetweenFamilyAndGenusRank, isInfragenericRank, parseInfragenericName,
  qualifiedInfragenericName, qualifyBareGroupName,
} from "../src/infragenericNames";

test("the groups inside a genus are subgenus, section, subsection, series, subseries and complex", () => {
  assert.deepEqual([...INFRAGENERIC_RANKS], ["subgenus", "section", "subsection", "series", "subseries", "complex"]);
  for (const rank of INFRAGENERIC_RANKS) assert.equal(isInfragenericRank(rank), true, rank);
  for (const rank of ["genus", "species", "family", "subfamily", "variety", "", null]) assert.equal(isInfragenericRank(rank), false, String(rank));
  assert.equal(isInfragenericRank("Section"), true);
});

test("subfamily and tribe sit between family and genus", () => {
  for (const rank of ["subfamily", "supertribe", "tribe", "subtribe"]) assert.equal(isBetweenFamilyAndGenusRank(rank), true, rank);
  for (const rank of ["family", "genus", "section", null]) assert.equal(isBetweenFamilyAndGenusRank(rank), false, String(rank));
});

test("a group's full name puts its genus first, with the rank written short", () => {
  assert.equal(qualifiedInfragenericName("Cortinarius", "section", "Verni"), "Cortinarius sect. Verni");
  assert.equal(qualifiedInfragenericName("Cortinarius", "subgenus", "Telamonia"), "Cortinarius subg. Telamonia");
  assert.equal(qualifiedInfragenericName("Entoloma", "subsection", "Cyanula"), "Entoloma subsect. Cyanula");
  assert.equal(qualifiedInfragenericName("Russula", "series", "Xerampelinae"), "Russula ser. Xerampelinae");
  assert.equal(qualifiedInfragenericName("Russula", "subseries", "Xerampelinae"), "Russula subser. Xerampelinae");
  assert.equal(qualifiedInfragenericName("Amanita", "complex", "Mappae"), "Amanita Mappae complex");
});

test("every full name reads back as its genus, rank and group", () => {
  for (const rank of INFRAGENERIC_RANKS) {
    assert.deepEqual(parseInfragenericName(qualifiedInfragenericName("Cortinarius", rank, "Verni")), { genus: "Cortinarius", rank, name: "Verni" }, rank);
  }
});

test("the spellings in the data all read: sect., section, subsect., subgenus, subgen., subg., ser.", () => {
  const cases: Array<[string, string, string]> = [
    ["Cortinarius section Verni", "Cortinarius", "section"],
    ["Cortinarius sect Verni", "Cortinarius", "section"],
    ["Russula subsect. Lilaceinae", "Russula", "subsection"],
    ["Russula subsection Lilaceinae", "Russula", "subsection"],
    ["Cortinarius subgenus Telamonia", "Cortinarius", "subgenus"],
    ["Cortinarius subgen. Telamonia", "Cortinarius", "subgenus"],
    ["Amanita series Mappae", "Amanita", "series"],
  ];
  for (const [name, genus, rank] of cases) {
    const parsed = parseInfragenericName(name);
    assert.equal(parsed?.genus, genus, name);
    assert.equal(parsed?.rank, rank, name);
  }
});

test("a subsection is not read as a section, nor a subseries as a series", () => {
  assert.equal(parseInfragenericName("Russula subsect. Lilaceinae")?.rank, "subsection");
  assert.equal(parseInfragenericName("Russula subser. Lilaceinae")?.rank, "subseries");
});

test("species, genera and complexes named after a species are not groups inside a genus", () => {
  for (const name of ["Cortinarius pacificovernus", "Cortinarius", "Verni", "Amanita muscaria complex",
    "Cortinarius sp. 'Harrower134d'", "Agaricales", "", null, "cortinarius sect. Verni", "Cortinarius sect. verni"]) {
    assert.equal(parseInfragenericName(name), null, String(name));
  }
});

// The index's answers for real names (inat_fungal_names, iNat 2026-11-03).
const verni = { rank: "section", genus: "Cortinarius", family: "Cortinariaceae", matchedName: "Verni" };
const telamonia = { rank: "subgenus", genus: "Cortinarius", family: "Cortinariaceae", matchedName: "Telamonia" };
const mappae = { rank: "complex", genus: "Amanita", family: "Amanitaceae", matchedName: "Mappae" };

test("A real record (inat:357361493): iNat's one word 'Verni' is Cortinarius sect. Verni", () => {
  assert.deepEqual(qualifyBareGroupName("Verni", verni), { genus: "Cortinarius", rank: "section", name: "Verni", qualified: "Cortinarius sect. Verni" });
});

test("a subgenus and a complex named with one word get their genus back too", () => {
  assert.equal(qualifyBareGroupName("Telamonia", telamonia)?.qualified, "Cortinarius subg. Telamonia");
  assert.equal(qualifyBareGroupName("Mappae", mappae)?.qualified, "Amanita Mappae complex");
});

test("a name is qualified only when the index places it inside a genus", () => {
  assert.equal(qualifyBareGroupName("Verni", null), null, "nothing indexed");
  assert.equal(qualifyBareGroupName("Russula", { rank: "genus", genus: "Russula", family: "Russulaceae" }), null, "a genus");
  assert.equal(qualifyBareGroupName("Leccinoideae", { rank: "subfamily", genus: null, family: "Boletaceae" }), null, "above genus");
  assert.equal(qualifyBareGroupName("Verni", { ...verni, genus: null }), null, "no genus to put back");
});

test("only iNat's one-word form is qualified: a species or a full name is left as it is", () => {
  assert.equal(qualifyBareGroupName("Cortinarius pacificovernus", verni), null);
  assert.equal(qualifyBareGroupName("Cortinarius sect. Verni", verni), null);
  assert.equal(qualifyBareGroupName("verni", verni), null, "not written as a Latin name");
});

test("the index's answer must be for this name: another name's row is never applied", () => {
  assert.equal(qualifyBareGroupName("Vernae", verni), null);
});
