// The record decisions: for each record (a specimen or observation, and the
// reads of it the run named), what mycomap.org's auto-validation would decide:
// validate it as one species, reject it, or hold it for a person, and why.
//
// The engine's decideRecord makes the decision (src/recordDecision.ts). The
// tool answers its questions offline:
//   - the BLAST results are in: the tool has just searched;
//   - MycoMap Vision: only when the user gives a key (vision.ts). A record
//     that is an iNaturalist or Mushroom Observer observation ("inat:123") is
//     asked about by its number, another by the photos folder the sheet gives
//     it. It is asked once, when the rules first want Vision, and never waited
//     on afterwards: Vision answers, or the record is decided as mycomap.org
//     decides one whose photos Vision could not use (the observer's
//     identification the only second source, reads that disagree to a
//     person), and the reason says why Vision is not in it;
//   - Vision picks between reads that disagree with the engine's own
//     pickReadByVision. The reads it sets aside are reported, never moved:
//     on mycomap.org some would also go to the recoverable trash;
//   - the observer's identification is the sheet's name for the record;
//   - each read's read count is the sheet's or the FASTA header's; a read
//     with none is taken as a Sanger read, which no read count holds back;
//   - the DNA name's family is the names table's.
// Nothing is written anywhere: the questions that are writes on mycomap.org
// (the Vision events, the waiting list, the trash) do nothing here.
import path from "node:path";
import type { AnalysisResult } from "../src/analysisRules";
import { namesAgree } from "../src/autovalidationNames";
import type { TaxonLookup } from "../src/autovalidationTaxonomy";
import type { V2Vision } from "../src/autovalidationVisionSupport";
import { decideRecord, type RecordDecision, type RecordDecisionPorts } from "../src/recordDecision";
import { pickReadByVision, readNameOf, visionPickedFlaggedRead, type RunTrashSequence } from "../src/runContaminantTrash";
import type { VisionAgreementVision } from "../src/visionAgreement";
import type { QuerySequence } from "./fasta";
import { familyAnswer } from "./ports";
import { observationTarget, type VisionAnswer, type VisionClient, type VisionReply, type VisionTarget } from "./vision";

export interface RecordGroup {
  /** The record as the sheet names it, or the sequence's own id when it has none. */
  record: string;
  /** Its sequences' ids, in the FASTA file's order. */
  sequenceIds: string[];
  /** The observer's identification: the sheet's name for the record. */
  observerName: string | null;
  /** A folder of the record's photos for MycoMap Vision, from the sheet: the first its sequences give. */
  photos?: string | null;
}

/** What MycoMap Vision made of the record. */
export interface RecordVisionOutcome {
  /** answered; not_asked (no key, nothing to ask by, or the rules did not need it); no_answer (asked, and refused or busy). */
  status: "answered" | "not_asked" | "no_answer";
  /** How it was (or would be) asked: by observation number or by photos. */
  by: VisionTarget["kind"] | null;
  /** Why there is no answer, in words. */
  words: string | null;
  /** Vision's top names, e.g. "Russula emetica 62%; genus Russula 91%; family Russulaceae 97%". */
  top: string | null;
  /** The not-a-fungus gate's verdict. */
  gate: string | null;
  model: string | null;
  answersVersion: string | null;
  /** Vision gave an answer it already held. */
  kept: boolean;
}

export interface RecordOutcome {
  record: string;
  sequenceIds: string[];
  observerName: string | null;
  decision: "validate" | "reject" | "held";
  /** The species it validates as (the DNA's), when it does. */
  species: string | null;
  /** The read that stands for the record: on mycomap.org, the one pushed and cited. */
  selectedSequenceId: string | null;
  /** The record's reads that name the species. */
  agreeingSequenceIds: string[];
  /** What besides the DNA backs the name. */
  secondSource: string | null;
  /** In a sentence. */
  reason: string;
  /** Reads Vision set aside as another organism than the record's: reported, never moved. */
  setAsideSequenceIds: string[];
  vision: RecordVisionOutcome;
  /** The decision's own working notes. */
  log: string[];
}

/** mycomap.org's words for a record Vision could not look at, as the engine says them. */
const VISION_NO_PHOTOS = "MycoMap Vision found no usable photos";
export const VISION_NO_KEY = "MycoMap Vision was not asked (no Vision key was given)";
export const VISION_NOTHING_TO_ASK = "MycoMap Vision was not asked (the record is not an iNaturalist or Mushroom Observer observation, and the sheet gives it no photos folder)";
const VISION_NOT_NEEDED = "MycoMap Vision was not asked (the rules did not need it for this record)";

/**
 * The run's sequences grouped into records: those that share the sheet's
 * record are one record, in the order first met; a sequence with none is a
 * record of its own. A record's name is the first its sequences give.
 */
export function groupRecords(sequences: readonly QuerySequence[]): RecordGroup[] {
  const groups = new Map<string, RecordGroup>();
  for (const s of sequences) {
    const key = s.record ?? s.id;
    const group: RecordGroup = groups.get(key) ?? { record: key, sequenceIds: [], observerName: null };
    group.sequenceIds.push(s.id);
    group.observerName ??= s.recordName;
    if (s.photos) group.photos ??= s.photos;
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The platform the rules decide the record as: Mushroom Observer for an "mo:" record, else iNaturalist (both take a second source). */
export function recordPlatform(record: string): "inat" | "mo" {
  return /^mo:/i.test(record.trim()) ? "mo" : "inat";
}

/** What Vision is asked about the record: its observation number, else its photos folder, else nothing. */
export function visionTargetOf(group: RecordGroup, photosFrom: string | null = null): VisionTarget | null {
  const observation = observationTarget(group.record);
  if (observation) return observation;
  return group.photos ? { kind: "photos", folder: path.resolve(photosFrom ?? process.cwd(), group.photos) } : null;
}

/**
 * Vision's answer as the read pick reads it, as mycomap.org reads a saved run
 * (mycomap.org's autovalidationEvidence.ts visionFromRuns).
 */
export function readPickVision(answer: VisionAgreementVision | null): V2Vision {
  const none: V2Vision = { state: "no_answer", runId: null, modelVersion: null, answersVersion: null, answeredAt: null, families: [], genera: [], species: [] };
  if (!answer) return none;
  const v: V2Vision = { ...none, state: "ok", modelVersion: answer.modelVersion, answersVersion: answer.answersVersion, families: answer.family ?? [], genera: answer.genus, species: answer.species };
  if (answer.gateVerdict === "not_fungus") return { ...v, state: "not_fungus" };
  if (answer.gateVerdict === "unsure") return { ...v, state: "unsure" };
  if (v.families.length === 0) return { ...v, state: "error" };
  return v;
}

/** The names table's families as the read pick looks a genus up. */
export function taxonLookup(families: ReadonlyMap<string, string>): TaxonLookup {
  return new Map([...families].map(([genus, family]) => [genus.toLowerCase(), { family, order: null, kingdom: null }]));
}

/** Vision's top name at each rank, in words. */
function topNames(v: VisionAgreementVision): string | null {
  const pct = (c: number | null) => (c === null ? "" : ` ${Math.round(c * 100)}%`);
  const parts = [
    v.species[0] && `${v.species[0].name}${pct(v.species[0].confidence)}`,
    v.genus[0] && `genus ${v.genus[0].name}${pct(v.genus[0].confidence)}`,
    v.family?.[0] && `family ${v.family[0].name}${pct(v.family[0].confidence)}`,
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}

/** The record's Vision question: asked at most once, and only when the rules want it. */
export function recordVisionAsk(group: RecordGroup, client: VisionClient | null, photosFrom: string | null = null) {
  const target = client ? visionTargetOf(group, photosFrom) : null;
  let reply: Promise<VisionReply | null> | null = null;
  const ask = () => (reply ??= target && client ? client.ask(target) : Promise.resolve(null));
  return {
    answer: async (): Promise<VisionAnswer | null> => {
      const r = await ask();
      return r?.ok ? r.answer : null;
    },
    outcome: async (): Promise<RecordVisionOutcome> => {
      const base = { by: client ? visionTargetOf(group, photosFrom)?.kind ?? null : null, top: null, gate: null, model: null, answersVersion: null, kept: false };
      if (!client) return { ...base, status: "not_asked", words: VISION_NO_KEY };
      if (!target) return { ...base, status: "not_asked", words: VISION_NOTHING_TO_ASK };
      if (!reply) return { ...base, status: "not_asked", words: VISION_NOT_NEEDED };
      const r = await reply;
      if (!r || !r.ok) return { ...base, status: "no_answer", words: r?.words ?? null };
      const a = r.answer;
      return { ...base, status: "answered", words: null, top: topNames(a.vision), gate: a.vision.gateVerdict, model: a.model, answersVersion: a.answersVersion, kept: a.kept };
    },
  };
}

/** The engine's questions about one record, answered offline, and by Vision when it is asked (see the top of this file). */
export function offlineRecordPorts(input: {
  group: RecordGroup;
  results: Readonly<Record<string, AnalysisResult>>;
  readCounts: ReadonlyMap<string, number | null>;
  families: ReadonlyMap<string, string>;
  log: string[];
  vision?: ReturnType<typeof recordVisionAsk>;
}): RecordDecisionPorts {
  const { group, results, readCounts, families, log } = input;
  const vision = input.vision ?? recordVisionAsk(group, null);
  return {
    ncbiReadiness: async () => ({ ready: true, sequences: [], waiting: [], exempt: [], listed: true }),
    noteNcbiWait: async () => undefined,
    clearNcbiWait: async () => undefined,
    // Asked here, and answered or refused before the rules go on.
    waitForVision: async () => ({ vision: (await vision.answer())?.vision ?? null, waitedMs: 0, timedOut: false }),
    settleReads: async () => {
      const answer = await vision.answer();
      if (!answer) return { trashed: [], visionMissing: false, kept: [...group.sequenceIds], pickedFlagged: null, pickState: null };
      const sequences: RunTrashSequence[] = group.sequenceIds.map((id) => ({
        id, categoryId: null, flags: null, ric: readCounts.get(id) ?? null, isChild: false, hasChildren: false,
        analysisOwn: !!results[id], finalSpecies: results[id]?.finalSpecies ?? null, flaggedNonTarget: results[id]?.flaggedNonTarget === true,
        runName: null, plate: null, cell: null,
      }));
      const pick = pickReadByVision({ sequences, vision: readPickVision(answer.vision), lookup: taxonLookup(families) });
      const kept = pick.state === "picked" ? pick.sequences.map((s) => s.id) : [];
      const pickedFlagged = pick.state === "picked" && visionPickedFlaggedRead(pick) ? { name: readNameOf(pick.name) ?? pick.name, sequenceIds: kept } : null;
      // Nothing is moved: trashed stays empty, and the engine sets the other reads aside.
      return { trashed: [], visionMissing: false, kept, pickedFlagged, pickState: pick.state };
    },
    // Never "waiting": by now Vision has answered, or it will not.
    visionFoundNoPhotos: async () => true,
    latestVisionAnswer: async () => (await vision.answer())?.vision ?? null,
    recordVisionEvents: async () => undefined,
    recordVisionHold: async () => undefined,
    loadDnaFamily: async (species) => (species ? familyAnswer(species, families).family : null),
    loadObserverIdentification: async () => (group.observerName ? { name: group.observerName, source: "observer_identification" } : null),
    loadStoredAnalyses: async (ids) => Object.fromEntries(ids.filter((id) => results[id]).map((id) => [id, results[id] as unknown as Record<string, any>])),
    fetchRic: async (ids) => ({
      ok: true,
      status: 200,
      rics: ids.map((id) => {
        const ric = readCounts.get(id) ?? null;
        return { id, ric, possiblySanger: ric === null };
      }),
    }),
    jobLog: (line) => { log.push(line); },
    info: (line) => { log.push(line); },
    warn: (line) => { log.push(line); },
  };
}

function secondSourceText(decision: Extract<RecordDecision, { kind: "validate" }>): string | null {
  const s = decision.secondSourceVision ?? decision.secondSourceByObserver;
  if (!s) return null;
  if (s.source === "observer_genus") return `the observer's identification (${s.name}) is in ${s.genus}`;
  if (s.source === "vision_species") return `MycoMap Vision shows ${s.name} at ${s.percent}%`;
  return s.top ? `MycoMap Vision's top genus is ${s.name}` : `MycoMap Vision shows ${s.name} at ${s.percent}%`;
}

/** The reads Vision set aside, in words. */
function setAsideText(ids: string[]): string {
  if (!ids.length) return "";
  return ` MycoMap Vision picked the record's read, so ${ids.join(", ")} ${ids.length === 1 ? "is" : "are"} set aside as another organism (reported only: nothing is moved).`;
}

const NOT_ASKED_NO_KEY: RecordVisionOutcome = { status: "not_asked", by: null, words: VISION_NO_KEY, top: null, gate: null, model: null, answersVersion: null, kept: false };

/** One record's decision, in the tool's words. */
export function outcomeOf(
  group: RecordGroup,
  decision: RecordDecision,
  log: string[],
  results: Readonly<Record<string, AnalysisResult>> = {},
  vision: RecordVisionOutcome = NOT_ASKED_NO_KEY,
): RecordOutcome {
  const setAside = decision.markedNonTarget;
  const base = { record: group.record, sequenceIds: group.sequenceIds, observerName: group.observerName, setAsideSequenceIds: setAside, vision, log };
  if (decision.kind === "validate") {
    // The engine gives these as numbers (mycomap.org's ids); a user's own read names are not numbers.
    const agreeing = group.sequenceIds.filter((id) => !decision.markedNonTarget.includes(id) && namesAgree(results[id]?.finalSpecies, decision.species));
    const second = secondSourceText(decision);
    return {
      ...base, decision: "validate", species: decision.species, selectedSequenceId: decision.selectedSequenceId,
      agreeingSequenceIds: agreeing, secondSource: second,
      reason: `Validated as ${decision.species}, carried by ${decision.selectedSequenceId}${second ? `; second source: ${second}` : ""}.`
        + (decision.visionMakesIt && decision.vision ? ` Below 70% on the DNA alone: ${decision.vision.line}.` : "")
        + setAsideText(setAside),
    };
  }
  if (decision.kind === "reject") {
    return {
      ...base, decision: "reject", species: null, selectedSequenceId: null, agreeingSequenceIds: [], secondSource: null,
      reason: decision.why === "no_sequences" ? "Rejected: the record has no sequences." : "Rejected: every read of the record is a contaminant or another organism than the specimen.",
    };
  }
  const said = decision.result.error ?? "Held for a person.";
  // The engine says "found no usable photos" for any record without an answer: say why there is none.
  const why = vision.status === "answered" || vision.words === VISION_NO_PHOTOS ? said : said.replace(VISION_NO_PHOTOS, vision.words ?? VISION_NO_KEY);
  return {
    ...base, decision: "held", species: null, selectedSequenceId: null, agreeingSequenceIds: [], secondSource: null,
    reason: why + setAsideText(setAside),
  };
}

/** Decides every record of a run. MycoMap Vision is asked only with a client (a key). */
export async function decideRecords(
  sequences: readonly QuerySequence[],
  results: Readonly<Record<string, AnalysisResult>>,
  families: ReadonlyMap<string, string>,
  opts: { vision?: VisionClient | null; photosFrom?: string | null } = {},
): Promise<RecordOutcome[]> {
  const readCounts = new Map(sequences.map((s) => [s.id, s.readCount]));
  const out: RecordOutcome[] = [];
  for (const group of groupRecords(sequences)) {
    const log: string[] = [];
    const vision = recordVisionAsk(group, opts.vision ?? null, opts.photosFrom ?? null);
    const ports = offlineRecordPorts({ group, results, readCounts, families, log, vision });
    const decision = await decideRecord({
      platform: recordPlatform(group.record),
      observationId: group.record,
      sequenceIds: group.sequenceIds,
      analysisResults: Object.fromEntries(group.sequenceIds.filter((id) => results[id]).map((id) => [id, results[id]])),
      sequenceMetadata: Object.fromEntries(group.sequenceIds.map((id) => [id, { ricScore: readCounts.get(id) ?? null }])),
    }, ports);
    out.push(outcomeOf(group, decision, log, results, await vision.outcome()));
  }
  return out;
}
