// Local names: what the tool calls a read it can name only on this computer.
//
// On mycomap.org a record that nothing validated names gets a new provisional
// name from MycoMap's register (the next free code, such as
// "Russula sp. 'IN172'"). The tool cannot reach that register, so it gives
// such a read a local name instead, spelled so it can never be taken for a
// registered one:
//
//   Russula sp. 'local-plate7-A02'      (the base, and the read's own id)
//
// The base is voted on as mycomap.org votes on a new name's base
// (src/newNameSuggestion.ts closestTaxonConsensus): the genus, family or order
// most of the closest hits agree on, else Fungi.
//
// A local name is local only (plan decision of 16 November 2026): it cannot be
// posted to iNaturalist or Mushroom Observer, uploaded to GenBank, or exported
// for use elsewhere until MycoMap has registered it. `contribute` sends it to
// mycomap.org, which answers with an existing name or a new code, and the tool
// then renames the read (contribute.ts). Anything that shares a name calls
// stopOnLocalNames first.
import type { AnalysisResult, SequenceRecord } from "../src/analysisRules";
import type { TaxonLookup } from "../src/autovalidationTaxonomy";
import { closestTaxonConsensus } from "../src/newNameSuggestion";
import { isRealBinomial } from "../src/speciesNames";
import type { ParsedBlastResult } from "./blast";
import { InputError } from "./fasta";

/** The base when no genus, family or order holds most of the vote. */
export const LOCAL_NAME_FALLBACK_BASE = "Fungi";

const LOCAL_NAME = /^\S+ sp\. 'local-[^']+'$/;
/** A local name anywhere in a text. */
const LOCAL_NAME_IN_TEXT = /\b[A-Z][a-zë]+ sp\. 'local-[^']+'/;

/** The read's id as a local name carries it: anything but letters, digits, ".", "_" and "-" becomes "-". */
export function localNameId(readId: string): string {
  return readId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "read";
}

/** "Russula sp. 'local-plate7-A02'". */
export function localNameFor(base: string, readId: string): string {
  return `${base} sp. 'local-${localNameId(readId)}'`;
}

/** Whether a name is one of the tool's local names (the whole name). */
export function isLocalName(name: string | null | undefined): boolean {
  return LOCAL_NAME.test(String(name ?? "").trim());
}

/** Whether a text holds a local name anywhere. */
export function hasLocalName(text: string | null | undefined): boolean {
  return LOCAL_NAME_IN_TEXT.test(String(text ?? ""));
}

/**
 * Whether the analysis left a read for a new name: nothing named it (no
 * MycoBLAST match, no NCBI consensus: "barcode gap check needed"), and it is
 * not a contaminant, another organism or an error.
 */
export function needsNewName(result: AnalysisResult): boolean {
  if (!result.barcodeGapNeeded || result.flaggedContaminant || result.flaggedNonTarget || result.status === "error") return false;
  return !isRealBinomial(result.finalSpecies);
}

/** The genus → family lookup the vote needs, from the names table's families. */
export function lookupFromFamilies(families: ReadonlyMap<string, string>): TaxonLookup {
  return new Map([...families].map(([genus, family]) => [genus.toLowerCase(), { kingdom: null, order: null, family }]));
}

/** The base of a read's local name: the vote's genus, family or order, else Fungi. */
export function localNameBase(input: {
  /** The engine's id for the read (run.ts engineSequenceId): its own hits do not vote. */
  engineId: string;
  /** The sheet's record, when the read has one: the record's other reads do not vote. */
  record: string | null;
  mycomap: ParsedBlastResult;
  ncbi: ParsedBlastResult | null;
  mycomapAdjusted: Record<number, number>;
  ncbiAdjusted: Record<number, number>;
  records: ReadonlyMap<string, SequenceRecord>;
  families: ReadonlyMap<string, string>;
}): string {
  const wanted = new Set(input.mycomap.hits.map((h) => h.accession));
  const sequenceMap = Object.fromEntries([...input.records].filter(([acc]) => wanted.has(acc)));
  const consensus = closestTaxonConsensus({
    localHits: input.mycomap.hits,
    ncbiHits: input.ncbi?.hits ?? [],
    localAdjusted: input.mycomapAdjusted,
    ncbiAdjusted: input.ncbiAdjusted,
    sequenceMap,
    genbankMap: {},
    ownSequenceIds: [input.engineId],
    ownRecord: input.record,
    lookup: lookupFromFamilies(input.families),
  });
  return consensus.genus ?? LOCAL_NAME_FALLBACK_BASE;
}

/** Something a share or an export would carry, and where it is. */
export interface NamedThing {
  /** The record or read, as the user knows it. */
  where: string;
  name: string | null | undefined;
}

/**
 * Stops a share or an export that would carry a local name: throws, naming
 * each, and says how to get a registered name. `what` says what was stopped
 * ("the GenBank files").
 */
export function stopOnLocalNames(things: readonly NamedThing[], what: string): void {
  const local = things.filter((t) => hasLocalName(t.name));
  if (!local.length) return;
  const list = local.slice(0, 5).map((t) => `${t.where} (${t.name})`).join(", ");
  throw new InputError(
    `${what} would carry ${local.length === 1 ? "a local name" : `${local.length} local names`}: ${list}${local.length > 5 ? ", …" : ""}. ` +
    "A local name is the tool's own and is not in MycoMap's index, so it is not posted, uploaded or exported. " +
    "Send the run to MycoMap (mycomap-validation contribute <run folder>); once mycomap.org names the read, " +
    "contribute --status renames it and this works.",
  );
}
