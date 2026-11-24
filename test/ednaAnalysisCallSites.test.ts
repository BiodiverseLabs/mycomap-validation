/**
 * The eDNA path of the validation engine's analysis, run with stand-ins for
 * every eDNA operation: what it asks of the eDNA tables, by name, and with what
 * (MycoMap Validation: the analysis holds no database; the operations
 * themselves run against a real schema in ednaAnalysisOperations.test.ts).
 * Hand-built hits: no database, no network.
 *
 *   node --import tsx --test src/services/ednaAnalysisCallSites.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runDeterministicAnalysis, type EdnaOperations, type EdnaSpeciesIdRow } from "../src/analysis";
import { portsFromCase } from "../src/caseReplay";
import { buildCase, range } from "./support/analysisCaseFixtures";

const SPECIES = "Tomentella sublilacina";
const ACCESSIONS = range(12).map((i) => `MK${1000 + i}`);

interface Setup {
  identity?: number;
  siblings?: number;
  /** What the variant carries now. */
  variantName?: string | null;
  /** Env codes already given out. */
  given?: string[];
  /** Species id rows already kept, by accession. */
  kept?: Record<string, EdnaSpeciesIdRow>;
}

async function analyse(setup: Setup = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const rec = <T>(name: string, answer: (...args: any[]) => T) => async (...args: any[]) => { calls.push([name, args]); return answer(...args); };
  const edna: EdnaOperations = {
    speciesIdsForAccessions: rec("speciesIdsForAccessions", () => []),
    variantEnvBlastFile: rec("variantEnvBlastFile", () => ({ envBlastFile: null })),
    variantSpeciesId: rec("variantSpeciesId", () => ({ ednaSpeciesId: setup.variantName ?? null })),
    speciesIdNamesLike: rec("speciesIdNamesLike", () => (setup.given ?? []).map((scientificName) => ({ scientificName }))),
    speciesIdRowsFor: rec("speciesIdRowsFor", (acc: { accession: string }) => (setup.kept?.[acc.accession] ? [setup.kept[acc.accession]] : [])),
    upsertAnalyzerSpeciesId: rec("upsertAnalyzerSpeciesId", () => undefined),
    mappingFor: rec("mappingFor", () => undefined),
    upsertAutoMapping: rec("upsertAutoMapping", () => undefined),
    classificationCacheRanks: rec("classificationCacheRanks", () => ({ rows: [] })),
    observationClassRows: rec("observationClassRows", () => ({ rows: [] })),
    cacheClassification: rec("cacheClassification", () => undefined),
    classificationCacheFull: rec("classificationCacheFull", () => ({ rows: [] })),
    placeholderSpeciesIdName: rec("placeholderSpeciesIdName", () => undefined),
    upsertPlaceholderSpeciesId: rec("upsertPlaceholderSpeciesId", () => undefined),
    recordPlaceholderSynonym: rec("recordPlaceholderSynonym", () => undefined),
    variantSpeciesIds: rec("variantSpeciesIds", () => []),
    classifyVariantById: rec("classifyVariantById", () => "ITS1" as any),
    countSiblingVariantsByVariantId: rec("countSiblingVariantsByVariantId", () => setup.siblings ?? 3),
    readEdnaBlastXml: () => null,
    parseBlastXml: () => null,
    clearEdnaSpeciesMappingsCache: () => undefined,
    resolveTaxonomy: rec("resolveTaxonomy", () => ({ genus: "Tomentella", family: "Thelephoraceae" })),
    lookupFamily: rec("lookupFamily", () => null),
    lookupOrder: rec("lookupOrder", () => null),
    lookupFullTaxonomyFromNCBI: rec("lookupFullTaxonomyFromNCBI", () => ({ kingdom: null, phylum: null, family: null, class: null, order: null })),
    findEnvBlastSiblingEdnaId: rec("findEnvBlastSiblingEdnaId", () => null),
    ednaSynonyms: async () => ({
      renameEdnaSpeciesId: rec("renameEdnaSpeciesId", () => undefined),
      setVariantEdnaSpeciesId: rec("setVariantEdnaSpeciesId", () => undefined),
    }),
  };
  const built = buildCase({
    sequenceId: "edna-501", source: { name: null, rank: null }, local: [],
    ncbi: ACCESSIONS.map((accession) => ({ accession, name: SPECIES, identity: setup.identity ?? 100 })),
    families: { Tomentella: "Thelephoraceae", [SPECIES]: "Thelephoraceae" },
  });
  const { ports } = portsFromCase(built.calls);
  const result = await runDeterministicAnalysis({ ...ports, edna }, "edna-501", "replay:ncbi", "replay:local", null, null);
  const named = (name: string) => calls.filter(([n]) => n === name).map(([, args]) => args);
  return { result: result as any, calls, named };
}

test("a genus consensus gets the next env code: it reads the variant and the codes given out, then names each qualifying accession", async () => {
  const { result, named } = await analyse({ given: ["Tomentella sp. 'env004'", "Tomentella sp. 'env001'"] });
  assert.equal(result.ednaTempCode, "Tomentella sp. 'env005'");
  assert.equal(result.finalSpecies, "Tomentella sp. 'env005'");
  assert.deepEqual(named("speciesIdsForAccessions"), [[ACCESSIONS]], "the hits' own eDNA names, read once for the batch");
  assert.deepEqual(named("variantEnvBlastFile"), [[501], [501]], "the variant's environmental BLAST file, by its number");
  assert.deepEqual(named("variantSpeciesId"), [[501]]);
  assert.deepEqual(named("speciesIdNamesLike"), [["Tomentella sp. 'env%'"]]);
  assert.deepEqual(named("speciesIdRowsFor"), ACCESSIONS.map((accession) => [{ accession, source: "ncbi" }]));
  assert.deepEqual(named("upsertAnalyzerSpeciesId"), ACCESSIONS.map((accession) => [{
    acc: { accession, source: "ncbi" }, tempCode: "Tomentella sp. 'env005'", sequenceId: "edna-501", taxonomy: { genus: "Tomentella", family: "Thelephoraceae" },
  }]));
  assert.deepEqual(named("setVariantEdnaSpeciesId"), [[{ variantId: 501, newName: "Tomentella sp. 'env005'", changedBy: "server-analysis:edna-501", reason: "analyzer consensus from NCBI genus" }]]);
});

test("a variant already carrying an env code of the genus keeps it, and no new code is counted out", async () => {
  const { result, named } = await analyse({ variantName: "Tomentella sp. 'env002'", given: ["Tomentella sp. 'env004'"] });
  assert.equal(result.ednaTempCode, "Tomentella sp. 'env002'");
  assert.deepEqual(named("speciesIdNamesLike"), []);
  assert.equal(named("upsertAnalyzerSpeciesId").length, ACCESSIONS.length);
});

test("an accession named by a person is left alone; one named by an older run is renamed, not written over", async () => {
  const kept: Record<string, EdnaSpeciesIdRow> = {
    MK1000: { id: 7, accession: "MK1000", source: "ncbi", scientificName: "Tomentella sublilacina", updatedBy: "manual-edit" },
    MK1001: { id: 8, accession: "MK1001", source: "ncbi", scientificName: "Tomentella sp. 'env001'", updatedBy: "server-analysis:edna-9" },
    MK1002: { id: 9, accession: "MK1002", source: "ncbi", scientificName: "Tomentella sp. 'env005'", updatedBy: "server-analysis:edna-9" },
  };
  const { result, named } = await analyse({ given: ["Tomentella sp. 'env004'"], kept });
  assert.equal(result.ednaTempCode, "Tomentella sp. 'env005'");
  const upserted = named("upsertAnalyzerSpeciesId").map(([args]) => (args as any).acc.accession);
  assert.deepEqual(upserted, ACCESSIONS.slice(3), "the three kept rows are not upserted");
  assert.deepEqual(named("renameEdnaSpeciesId"), [[{
    id: 8, accession: "MK1001", source: "ncbi", newName: "Tomentella sp. 'env005'", taxonomy: { genus: "Tomentella", family: "Thelephoraceae" },
    changedBy: "server-analysis:edna-501", reason: "analyzer re-applied consensus from NCBI genus",
  }]]);
});

test("with no hits at the eDNA identity line, a lone variant is a singleton under the genus's next code, and nothing is written", async () => {
  const lone = await analyse({ identity: 99, siblings: 1, given: ["Tomentella sp. 'env004'"] });
  assert.equal(lone.result.finalSpecies, "Singleton Sequence - Tomentella sp. 'env005'");
  assert.deepEqual(lone.named("variantSpeciesId"), [[501]]);
  assert.deepEqual(lone.named("speciesIdNamesLike"), [["Tomentella sp. 'env%'"]]);
  assert.deepEqual(lone.named("upsertAnalyzerSpeciesId"), []);
  assert.deepEqual(lone.named("setVariantEdnaSpeciesId"), []);
  const many = await analyse({ identity: 99, siblings: 3, given: ["Tomentella sp. 'env004'"] });
  assert.equal(many.result.finalSpecies, "Manual Validation Needed", "a variant with siblings is held for a person instead");
});

test("below the eDNA identity line the broadened search asks the classification cache and observations by the species name", async () => {
  const { named } = await analyse({ identity: 99 });
  assert.deepEqual(named("classificationCacheRanks"), [[SPECIES]]);
  assert.deepEqual(named("observationClassRows"), [[SPECIES]]);
  assert.deepEqual(named("upsertAnalyzerSpeciesId"), []);
});
