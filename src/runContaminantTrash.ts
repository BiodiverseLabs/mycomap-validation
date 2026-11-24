/**
 * Which read is the record's, and what happens to the others (2026-11-06,
 * replacing the read-count, other-well and observer's-name guards).
 *
 * When a record's reads name different species, Vision picks, whatever the read
 * counts: off-target reads commonly have as many reads as the record's own. It keeps
 * the name whose genus (else family) is on Vision's top list when the others' aren't.
 * If Vision shows all of them or none, or hasn't answered, nobody is picked and the
 * record goes to a person.
 *
 * The others are set aside. Those outside the kept read's family go to the recoverable
 * trash if they are macrofungi and the kept read is too; moulds, yeasts and fungi that
 * live on other fruitbodies are real biology on the specimen and are only set aside. A
 * person's put-back still stands (mycomap.org's runContaminantTrashStore.ts).
 *
 * Pure: mycomap.org's runContaminantTrashStore.ts reads the rows and makes the moves.
 */
import { parseSpeciesName, speciesKey } from "./autovalidationNames";
import { type Placement, type TaxonLookup, canonicalGenus, canonicalSpeciesName, placeName } from "./autovalidationTaxonomy";
import { type V2Vision, visionBacks, visionNamesShown, visionSupportSet } from "./autovalidationVisionSupport";
import { RECOVERABLE_TRASH_CATEGORY_ID } from "./sequenceCategory";
import { hasExcludedSequenceFlag, hasWrongSpecimenFlag, isContaminantFlagName, sequenceFlagNames } from "./sequenceExclusionFlags";

export const RUN_CONTAMINANT_TRASH_POLICY_VERSION = "run-contaminant-trash/2";
export const RUN_CONTAMINANT_TRASH_REASON = "macrofungal_run_contaminant";

/** The read Vision picks must reach this RiC before another read in its well is trashed. */
export const KEPT_READ_MIN_RIC = 3;

/**
 * Orders whose members fruit as macrofungi: the Agaricomycetes orders less
 * Sebacinales (mostly root and orchid endophytes), Pezizales and Dacrymycetales.
 * Yeast classes (Saccharomycetes, Tremellomycetes, Microbotryomycetes,
 * Cystobasidiomycetes, Ustilaginomycetes, Exobasidiomycetes) have no order here,
 * so a yeast is never trashed.
 */
export const MACRO_ORDERS: ReadonlySet<string> = new Set([
  "Agaricales", "Amylocorticiales", "Atheliales", "Auriculariales", "Boletales", "Cantharellales",
  "Corticiales", "Geastrales", "Gloeophyllales", "Gomphales", "Hymenochaetales", "Hysterangiales",
  "Jaapiales", "Lepidostromatales", "Phallales", "Polyporales", "Russulales", "Stereopsidales",
  "Thelephorales", "Trechisporales", "Tremellodendropsidales",
  "Pezizales",
  "Dacrymycetales",
].map((o) => o.toLowerCase()));

/** Macrofungal genera outside those orders (Xylariales, Hypocreales, Leotiales, Helotiales, Geoglossales, Rhytismatales). */
export const MACRO_GENERA_ELSEWHERE: ReadonlySet<string> = new Set([
  "Xylaria", "Daldinia", "Hypoxylon", "Kretzschmaria", "Annulohypoxylon", "Camarops", "Poronia",
  "Cordyceps", "Ophiocordyceps", "Elaphocordyceps", "Tolypocladium",
  "Leotia", "Chlorociboria", "Bulgaria", "Neobulgaria", "Ascocoryne", "Bisporella", "Cudonia",
  "Spathularia", "Mitrula", "Vibrissea", "Holwaya", "Geoglossum", "Trichoglossum", "Microglossum",
  "Rhytisma", "Elaphomyces",
].map((g) => g.toLowerCase()));

/** Microfungi inside the macro orders: orchid and root endophytes, never trashed. */
export const MICRO_GENERA_IN_MACRO_ORDERS: ReadonlySet<string> = new Set([
  "Tulasnella", "Ceratobasidium", "Rhizoctonia", "Thanatephorus", "Serendipita", "Sebacina", "Piriformospora",
].map((g) => g.toLowerCase()));

/**
 * Fungi that live on other fruitbodies. As a read their DNA is real biology on
 * the specimen; as the record, a different read in the well is likely the host.
 * Either way the read is kept.
 */
export const MYCOPARASITE_GENERA: ReadonlySet<string> = new Set([
  "Hypomyces", "Sepedonium", "Mycogone", "Spinellus", "Syzygites", "Cladobotryum", "Nectriopsis",
  "Asterophora", "Squamanita", "Pseudoboletus", "Dendrocollybia", "Tremella", "Phaeotremella", "Naematelia",
  "Hyaloscypha", "Phaeocalicium",
].map((g) => g.toLowerCase()));

/** Species of otherwise free-living genera that grow on other fungi. */
export const MYCOPARASITE_SPECIES: ReadonlySet<string> = new Set([
  "entoloma abortivum", "entoloma pseudoparasiticum", "claudopus parasiticus", "psathyrella epimyces",
  "volvariella surrealis", "xerocomus parasiticus", "collybia tuberosa", "collybia cirrhata", "collybia cookei",
]);

export type GrowthForm = "macro" | "micro" | "mycoparasite" | "unknown";

/** Strips v1.1's "Non-Target: " prefix so the read's own name can be placed. */
export function readNameOf(finalSpecies: string | null | undefined): string | null {
  const name = String(finalSpecies ?? "").replace(/^\s*non[- ]target:\s*/i, "").trim();
  return name || null;
}

function binomialKey(name: string): string {
  return canonicalSpeciesName(name).toLowerCase().split(" ").slice(0, 2).join(" ");
}

/** Macro, micro or mycoparasite, from the placement's genus and order; unknown when mycomap.org can't place it. */
export function growthFormOf(p: Placement | null): GrowthForm {
  if (!p || p.rank === "none") return "unknown";
  if (p.kingdom && p.kingdom !== "Fungi") return "micro";
  const genus = p.genus?.toLowerCase() ?? null;
  if (genus && MYCOPARASITE_GENERA.has(genus)) return "mycoparasite";
  if (MYCOPARASITE_SPECIES.has(binomialKey(p.name))) return "mycoparasite";
  if (genus && MACRO_GENERA_ELSEWHERE.has(genus)) return "macro";
  if (genus && MICRO_GENERA_IN_MACRO_ORDERS.has(genus)) return "micro";
  if (!p.order) return "unknown";
  return MACRO_ORDERS.has(p.order.toLowerCase()) ? "macro" : "micro";
}

/** One key per taxon whatever the quoting style ("sp. 'IN10'" = "\"sp-IN10\""). */
export function runMateNameKey(name: string | null | undefined): string | null {
  const parsed = parseSpeciesName(canonicalSpeciesName(readNameOf(name)));
  if (!parsed.genus || parsed.kind === "verdict" || parsed.kind === "above_genus" || parsed.kind === "empty") return null;
  return speciesKey(parsed, canonicalGenus(parsed.genus));
}

/**
 * The sequencing run a read came from, as "run157" or "rerun13". The record store keeps
 * one summary file name per demultiplexing pass, so one run can carry two
 * names: Run157_ITSnew_Summary and Run157_5710_ITSnew_Summary are run 157.
 * The store finds a run's reads by the same key in SQL (@workspace/db
 * sequenceRunKeySql), through an index.
 */
export function runKeyOf(runName: string | null | undefined): string | null {
  const m = String(runName ?? "").trim().toLowerCase().match(/^(re)?run0*(\d+)/);
  return m ? `${m[1] ?? ""}run${m[2]}` : null;
}

export interface RunTrashSequence {
  id: string;
  categoryId: number | null;
  /** The mirror's flags (the record store's field_718 JSON). */
  flags: unknown;
  ric: number | null;
  isChild: boolean;
  hasChildren: boolean;
  /** The analysis row is this sequence's own (not an eDNA analysis under a colliding id). */
  analysisOwn: boolean;
  finalSpecies: string | null;
  flaggedNonTarget: boolean;
  runName: string | null;
  plate: string | null;
  cell: string | null;
}

/** The main read of another well on the run. */
export interface RunMateWell {
  observation: string;
  sequenceId: string;
  plate: string | null;
  cell: string | null;
  ric: number | null;
  name: string;
}

export interface RunTrashInput {
  platform: string;
  observationId: string;
  recordName: string | null;
  sequences: RunTrashSequence[];
  vision: V2Vision;
  lookup: TaxonLookup;
  /** Per run key: the main read of every well on that run, by runMateNameKey. */
  runMates: ReadonlyMap<string, ReadonlyMap<string, RunMateWell[]>>;
}

export type RunTrashKeepReason =
  | "already_trash"
  | "analysis_not_own"
  | "read_unplaced"
  | "read_not_macro"
  | "read_is_mycoparasite"
  | "record_is_mycoparasite"
  | "kept_read_not_macro"
  | "kept_read_flagged"
  | "same_family_as_kept_read"
  | "kept_read_ric_low"
  | "linked_sequence"
  | "vision_no_answer"
  | "vision_no_pick";

export interface RunTrashEvidence {
  /** "flagged": v1.1 flagged it non-target. "vision_pick": no flag. "wrong_flag": a person's "wrong" flag. "outread" on older rows. None: flagged. */
  trigger?: "flagged" | "vision_pick" | "outread" | "wrong_flag";
  readName: string;
  readPlacement: { genus: string | null; family: string | null; order: string | null };
  recordName: string;
  recordPlacement: { genus: string | null; family: string | null; order: string | null };
  ric: number | null;
  onTarget: { sequenceId: string; name: string; ric: number | null };
  run: { key: string; runName: string | null; plate: string | null; cell: string | null };
  /** Where the source wells are, for the audit (not a condition): same plate, the same well position on another plate (barcode bleed), another plate only, or none found. */
  geometry: "same_plate" | "same_cell_other_plate" | "other_plate" | "no_run_mate";
  runMates: RunMateWell[];
  vision: { runId: number | null; modelVersion: string | null; answersVersion: string | null; families: string[]; genera: string[] };
}

export type RunTrashDecision =
  | { sequenceId: string; action: "trash"; reason: typeof RUN_CONTAMINANT_TRASH_REASON; evidence: RunTrashEvidence }
  | { sequenceId: string; action: "keep"; reason: RunTrashKeepReason; detail?: string };

const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const sameText = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && lc(a) === lc(b);

/** A read v1.1 flagged non-target: its stored analysis says so (the record store's contaminant flag alone is a person's or older code's). */
export function isV11NonTarget(s: Pick<RunTrashSequence, "flaggedNonTarget" | "finalSpecies">): boolean {
  return s.flaggedNonTarget || /^\s*non[- ]target:/i.test(s.finalSpecies ?? "");
}

const placementSummary = (p: Placement) => ({ genus: p.genus, family: p.family, order: p.order });

/** The genus as written and after the synonym table: Vision may use either (Collybiopsis / Gymnopus). */
function generaOf(p: Placement): string[] {
  return [...new Set([p.genus, p.parsed.genus].filter((g): g is string => !!g))];
}

const hasContaminantFlag = (flags: unknown) => sequenceFlagNames(flags).some(isContaminantFlagName);

/** Whether a record's reads, leaving out the non-target ones, name more than one thing: one of them may be another well's DNA. */
export function readsDisagree(sequences: Array<Pick<RunTrashSequence, "flaggedNonTarget" | "finalSpecies" | "flags">>): boolean {
  const names = sequences.filter((s) => !isV11NonTarget(s) && !hasContaminantFlag(s.flags)).map((s) => readNameOf(s.finalSpecies)).filter(Boolean);
  return new Set(names).size > 1;
}

/** What Vision made of the record's reads. */
export type ReadPick =
  | { state: "one_name" }
  | { state: "no_answer" }
  | { state: "no_pick" }
  | { state: "picked"; name: string; placement: Placement; sequences: RunTrashSequence[] };

/** A read that takes part: live, its own analysis, a name, and no flag of a contaminant other than v1.1's non-target. */
function liveRead(s: RunTrashSequence): boolean {
  if (s.categoryId === RECOVERABLE_TRASH_CATEGORY_ID || !s.analysisOwn || s.isChild) return false;
  const name = readNameOf(s.finalSpecies);
  if (!name || /^\s*(contaminant|manual validation|singleton):?/i.test(name)) return false;
  return isV11NonTarget(s) || !hasContaminantFlag(s.flags);
}

/**
 * Vision picks between the names on a record's reads: the name whose genus, else
 * family, is on its top list when the others' aren't. Read counts play no part.
 */
export function pickReadByVision(input: Pick<RunTrashInput, "sequences" | "vision" | "lookup">): ReadPick {
  const byName = new Map<string, { name: string; placement: Placement; sequences: RunTrashSequence[] }>();
  for (const s of input.sequences.filter(liveRead)) {
    const name = readNameOf(s.finalSpecies)!;
    const key = runMateNameKey(name) ?? name.toLowerCase();
    const at = byName.get(key) ?? { name, placement: placeName(name, input.lookup), sequences: [] };
    at.sequences.push(s);
    byName.set(key, at);
  }
  if (byName.size <= 1) return { state: "one_name" };
  const vision = input.vision;
  if (vision.state !== "ok" || vision.families.length === 0) return { state: "no_answer" };
  const support = visionSupportSet(vision);
  const shownByGenus = (n: { placement: Placement }) => visionBacks({ ...support, families: [] }, null, generaOf(n.placement));
  const shownByFamily = (n: { placement: Placement }) => visionBacks({ ...support, genera: [] }, n.placement.family, []);
  let live = [...byName.values()];
  for (const shown of [shownByGenus, shownByFamily]) {
    const subset = live.filter(shown);
    if (subset.length > 0 && subset.length < live.length) live = subset;
    if (live.length === 1) break;
  }
  if (live.length !== 1 || !(shownByGenus(live[0]) || shownByFamily(live[0]))) return { state: "no_pick" };
  return { state: "picked", ...live[0] };
}

/**
 * The read Vision picked is one the analysis marked Non-Target, usually because
 * its family is not the observer's (2026-11-07). The observer's name may
 * be the wrong one, so a person decides the record.
 */
export function visionPickedFlaggedRead(pick: ReadPick): boolean {
  return pick.state === "picked" && pick.sequences.every(isV11NonTarget);
}

/**
 * Whether any of the reads the page posted for a record was marked Non-Target, by
 * its analysis or by the flag on .com. Then Vision's pick runs even when the other
 * reads agree, so a flagged read Vision backs is not dropped unseen.
 */
export function recordHasFlaggedRead(reads: Array<{ flaggedNonTarget?: boolean | null; finalSpecies?: string | null; metaNonTarget?: boolean | null }>): boolean {
  return reads.some((r) => r.metaNonTarget === true || isV11NonTarget({ flaggedNonTarget: r.flaggedNonTarget === true, finalSpecies: r.finalSpecies ?? null }));
}

/** Why a record whose flagged read Vision picked goes to a person, as the job reports it. */
export function visionPickedFlaggedReadReason(picked: { name: string; sequenceIds: string[] }): string {
  const seqs = picked.sequenceIds.map((id) => `seq ${id}`).join(", ");
  return `MycoMap Vision picked ${picked.name} (${seqs}), a read the analysis marked Non-Target. The observer's name may be the wrong one, so a person decides this record.`;
}

/** What happens to each read outside the one Vision picked; other reads are not listed. */
export function decideRunContaminantTrash(input: RunTrashInput): RunTrashDecision[] {
  const out: RunTrashDecision[] = [];
  const pick = pickReadByVision(input);
  if (pick.state === "one_name") return out;
  const readsOf = input.sequences.filter(liveRead);
  if (pick.state !== "picked") {
    for (const s of readsOf) out.push({ sequenceId: s.id, action: "keep", reason: pick.state === "no_answer" ? "vision_no_answer" : "vision_no_pick", detail: input.vision.state });
    return out;
  }
  const kept = new Set(pick.sequences.map((s) => s.id));
  const keptRead = pick.sequences.reduce((best, s) => ((s.ric ?? -1) > (best.ric ?? -1) ? s : best));
  const record = input.recordName ? placeName(input.recordName, input.lookup) : null;
  const vision = input.vision;
  // v1.1 flagged the read Vision picked, usually against the observer's name. A person sorts that out.
  const keptFlagged = visionPickedFlaggedRead(pick);
  for (const s of readsOf) {
    if (kept.has(s.id)) continue;
    const keep = (reason: RunTrashKeepReason, detail?: string) => out.push({ sequenceId: s.id, action: "keep", reason, ...(detail ? { detail } : {}) });
    const readName = readNameOf(s.finalSpecies);
    const read = readName ? placeName(readName, input.lookup) : null;
    if (!read || !read.genus) { keep("read_unplaced", readName ?? undefined); continue; }
    const readForm = growthFormOf(read);
    if (readForm === "mycoparasite") { keep("read_is_mycoparasite", read.name); continue; }
    if (readForm !== "macro") { keep("read_not_macro", `${read.name} (${readForm})`); continue; }
    if (growthFormOf(record) === "mycoparasite") { keep("record_is_mycoparasite", record!.name); continue; }
    const keptForm = growthFormOf(pick.placement);
    if (keptForm !== "macro") { keep("kept_read_not_macro", `${pick.placement.name} (${keptForm})`); continue; }
    if (sameText(read.genus, pick.placement.genus) || (read.family && sameText(read.family, pick.placement.family))) { keep("same_family_as_kept_read", `${read.name} beside ${pick.placement.name}`); continue; }
    if (keptFlagged) { keep("kept_read_flagged", pick.name); continue; }
    if (s.isChild || s.hasChildren) { keep("linked_sequence"); continue; }
    if ((keptRead.ric ?? 0) < KEPT_READ_MIN_RIC) { keep("kept_read_ric_low", `kept ${keptRead.id} RiC ${keptRead.ric ?? "?"}`); continue; }
    const runKey = runKeyOf(s.runName);
    const key = runMateNameKey(readName);
    const mates = (runKey && key ? input.runMates.get(runKey)?.get(key) ?? [] : [])
      .filter((w) => w.observation !== `${input.platform}:${input.observationId}`);
    const samePlate = mates.some((w) => w.plate != null && w.plate === s.plate);
    const sameCell = mates.some((w) => w.cell != null && w.cell === s.cell && w.plate !== s.plate);
    const recordPlacement = record ?? pick.placement;
    out.push({
      sequenceId: s.id,
      action: "trash",
      reason: RUN_CONTAMINANT_TRASH_REASON,
      evidence: {
        trigger: isV11NonTarget(s) ? "flagged" : hasWrongSpecimenFlag(s.flags) ? "wrong_flag" : "vision_pick",
        readName: read.name,
        readPlacement: placementSummary(read),
        recordName: input.recordName ?? pick.placement.name,
        recordPlacement: placementSummary(recordPlacement),
        ric: s.ric,
        onTarget: { sequenceId: keptRead.id, name: pick.name, ric: keptRead.ric },
        run: { key: runKey ?? "", runName: s.runName, plate: s.plate, cell: s.cell },
        geometry: mates.length === 0 ? "no_run_mate" : samePlate ? "same_plate" : sameCell ? "same_cell_other_plate" : "other_plate",
        runMates: [...mates].sort((a, b) => (b.ric ?? 0) - (a.ric ?? 0)).slice(0, 5),
        vision: {
          runId: vision.runId,
          modelVersion: vision.modelVersion,
          answersVersion: vision.answersVersion,
          families: visionNamesShown(vision.families).map((n) => `${n.name} ${n.percent}%`),
          genera: visionNamesShown(vision.genera).map((n) => `${n.name} ${n.percent}%`),
        },
      },
    });
  }
  return out;
}

/** A read of another well on the run, as the store reads it. */
export interface RunReadRow {
  id: string;
  observation: string;
  runName: string | null;
  plate: string | null;
  cell: string | null;
  ric: number | null;
  categoryId: number | null;
  flags: unknown;
  finalSpecies: string | null;
  flaggedNonTarget: boolean;
  analysisOwn: boolean;
}

/**
 * The main read of each well on each run: the highest-RiC read that is live,
 * its own analysis, unflagged, and named. Keyed by run, then by the read's
 * name key, so a contaminant can look up the wells its name came from.
 */
export function mainReadsByRun(rows: RunReadRow[]): Map<string, Map<string, RunMateWell[]>> {
  const best = new Map<string, RunReadRow>();
  for (const r of rows) {
    const runKey = runKeyOf(r.runName);
    if (!runKey) continue;
    if (r.categoryId === RECOVERABLE_TRASH_CATEGORY_ID || !r.analysisOwn || hasExcludedSequenceFlag(r.flags)) continue;
    if (isV11NonTarget(r) || /^\s*contaminant/i.test(r.finalSpecies ?? "")) continue;
    if (!runMateNameKey(r.finalSpecies)) continue;
    const well = `${runKey}|${r.observation}`;
    const current = best.get(well);
    if (!current || (r.ric ?? -1) > (current.ric ?? -1)) best.set(well, r);
  }
  const out = new Map<string, Map<string, RunMateWell[]>>();
  for (const r of best.values()) {
    const runKey = runKeyOf(r.runName)!;
    const key = runMateNameKey(r.finalSpecies)!;
    const byName = out.get(runKey) ?? new Map<string, RunMateWell[]>();
    out.set(runKey, byName);
    const list = byName.get(key) ?? [];
    list.push({ observation: r.observation, sequenceId: r.id, plate: r.plate, cell: r.cell, ric: r.ric, name: readNameOf(r.finalSpecies)! });
    byName.set(key, list);
  }
  return out;
}

/** What a dry run reports per kept reason and per trash, for the summary line. */
export function summarizeDecisions(decisions: RunTrashDecision[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of decisions) {
    const k = d.action === "trash" ? "trash" : `keep:${d.reason}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** What Vision made of a record's reads (runContaminantTrash.ts ReadPick). */
export type ReadPickState = ReturnType<typeof pickReadByVision>["state"];

/** Vision picked a read the analysis marked Non-Target: the record goes to a person. */
export interface PickedFlaggedRead {
  name: string;
  sequenceIds: string[];
}
