/**
 * What auto-validation decides about one record that is not yet verified:
 * wait, leave it for a person, reject it, or validate it as one species.
 *
 * This is the deciding half of mycomap.org's auto-validate job
 * (mycomap.org's observations.ts, processRecordSteps),
 * moved out line for line and then
 * into this package with the rules it applies. It writes nothing to iNaturalist, Mushroom Observer or
 * the record store and reads nothing by itself: everything it needs from outside
 * (the BLAST readiness check, MycoMap Vision's answer, the observer's
 * identification, a missing RiC score) it asks for through `ports`, and the
 * job acts on its answer. That makes a record's decision something that can be
 * captured and run again from the same answers.
 *
 * Three ports are not questions. They are done at the moment of deciding
 * because the rules say so, and each one's answer is all the decision uses:
 *   - settleReads: Vision picks between reads that disagree; off-target reads
 *     may go to the recoverable trash (runContaminantTrash.ts);
 *   - recordVisionEvents / recordVisionHold: the Vision decision events and the
 *     hold, written at the decision so a later failure never takes them back;
 *   - noteNcbiWait / clearNcbiWait: the record's place on the waiting list.
 *
 * Not here: a record that is already verified (the job only pushes it), the
 * MyCoPortal name check, the ownership and flag preflight, and every write
 * that follows a "validate" answer.
 */
import { contaminantOnlyOutcome } from "./analysisVerdictGuards";
import { namesAgree } from "./autovalidationNames";
import { type RecordNcbiReadinessCheck, ncbiWaitMessage } from "./autovalidationNcbiReadiness";
import { AUTOVALIDATION_MIN_RIC, evaluateAutovalidationEligibility } from "./autovalidationPushSafety";
import { MYCOPORTAL_PLATFORM } from "./recordPlatforms";
import { type PickedFlaggedRead, type ReadPickState, recordHasFlaggedRead, visionPickedFlaggedReadReason } from "./runContaminantTrash";
import {
  type SecondSource,
  type VisionAgreementDecision,
  type VisionAgreementObserver,
  type VisionAgreementVision,
  WAITING_FOR_VISION_TEXT,
  decideFamilyPenaltyLift,
  decideTopListAgreement,
  decideVisionAgreement,
  describeVisionAgreement,
  noSecondSourceReason,
  scoreWithoutFamilyPenalty,
  secondSourceFromObserver,
  secondSourceFromVision,
  visionAgreementDna,
  visionVetoReason,
  visionVetoSparedText,
} from "./visionAgreement";
import { type VisionDecisionEventInput, visionRefOf } from "./visionDecisionEvents";

/** What the job knows about one of the record's sequences besides its analysis. */
export type RecordSequenceMetadata = { isNonTarget?: boolean; isChildSequence?: boolean; ricScore?: number | null; possiblySanger?: boolean; platformCopy?: boolean };

export interface RecordDecisionInput {
  /** "inat", "mo" or "mycoport". */
  platform: string;
  observationId: string;
  /** The record's sequences, in the order the job was given them. */
  sequenceIds: string[];
  /** Each sequence's analysis, by sequence id. A sequence with none has not been analysed. */
  analysisResults: Record<string, any>;
  /** Not changed here: the reads set aside come back in `markedNonTarget`. */
  sequenceMetadata: Record<string, RecordSequenceMetadata>;
}

/** A MycoMap Vision decision event, without the parts that say which record and run it belongs to. */
export type RecordVisionEvent = Omit<VisionDecisionEventInput, "platform" | "observationId" | "source" | "jobId" | "projectId" | "actorUserId">;

export interface RecordDecisionPorts {
  /** Are the BLAST results in for every sequence that counts? */
  ncbiReadiness(): Promise<RecordNcbiReadinessCheck>;
  noteNcbiWait(sequences: Array<{ id: string; why: string; detail: string }>): Promise<void>;
  clearNcbiWait(): Promise<void>;
  /** MycoMap Vision's answer for the record, waiting for it while the queue still has the record. */
  waitForVision(): Promise<{ vision: VisionAgreementVision | null; waitedMs: number; timedOut: boolean }>;
  /** Vision picks between the record's reads; the reads it sets aside may be trashed. */
  settleReads(): Promise<{ trashed: string[]; visionMissing: boolean; kept: string[]; pickedFlagged: PickedFlaggedRead | null; pickState: ReadPickState | null }>;
  /** Vision looked and found no photo it could use. */
  visionFoundNoPhotos(): Promise<boolean>;
  /** The record's latest Vision answer, or null; never throws. */
  latestVisionAnswer(): Promise<VisionAgreementVision | null>;
  recordVisionEvents(events: RecordVisionEvent[]): Promise<void>;
  /** The hold and its event together. May throw; the decision goes on either way. */
  recordVisionHold(decision: VisionAgreementDecision, event: RecordVisionEvent): Promise<void>;
  loadDnaFamily(species: string | null | undefined): Promise<string | null>;
  /** May throw when it can't be read. */
  loadObserverIdentification(): Promise<VisionAgreementObserver | null>;
  /** The stored analyses, by sequence id, for the ones that have one. */
  loadStoredAnalyses(sequenceIds: string[]): Promise<Record<string, Record<string, any>>>;
  /**
   * Each sequence's RiC as the rules judge it (null when possibly Sanger) and
   * whether it is possibly Sanger, read from the record store and its mirror
   * (deterministicTrashQc comSequencesRicForRules). A sequence left out was not
   * found. May throw; then nothing is learnt.
   */
  fetchRic(sequenceIds: string[]): Promise<{ ok: boolean; status: number; rics: Array<{ id: string; ric: number | null; possiblySanger: boolean; platformCopy?: boolean }> }>;
  /** A line for the run's own log file. */
  jobLog(line: string): void;
  info(line: string): void;
  warn(line: string): void;
}

/** What Vision's rule decided, for the run's results. */
export type RecordVisionSummary = { outcome: VisionAgreementDecision["outcome"]; branch?: string; reason?: string; line: string; waitedMs?: number } | undefined;

/** The record's result when nothing more is done with it in this run. */
export interface RecordStop {
  observationId: string;
  platform: string;
  action: string;
  success: boolean;
  error?: string;
  waitingForBlast?: Array<{ id: string; why: string; detail: string }>;
  vision?: RecordVisionSummary;
  visionPending?: boolean;
  waitingForVision?: boolean;
}

/** Every check passed: the species to validate the record as, and how it got there. */
export interface RecordValidate {
  species: string;
  /** The sequence the job pushes and cites. */
  selectedSequenceId: string;
  eligibleSequenceIds: string[];
  /** The record's sequences that name this species. */
  agreeingSequenceIds: number[];
  visionDecision: VisionAgreementDecision | null;
  visionAnswer: VisionAgreementVision | null;
  /** Set when the DNA alone was below the threshold and Vision's agreement made the validation. */
  visionMakesIt: (VisionAgreementDecision & { outcome: "agrees" }) | null;
  vision: RecordVisionSummary;
  secondSourceVision: SecondSource | null;
  secondSourceByObserver: SecondSource | null;
}

export type RecordDecision = (
  | { kind: "stop"; result: RecordStop }
  | { kind: "reject"; why: "no_sequences" | "only_contaminants" }
  | ({ kind: "validate" } & RecordValidate)
) & {
  /** Reads Vision set aside while deciding: the job treats them as non-target from here on. */
  markedNonTarget: string[];
};

/** The sequences behind the decision that named this species: ids as numbers, once each. */
export function sequencesNamingSpecies(
  results: Array<{ id: string | number; result?: { finalSpecies?: string | null } | null }>,
  species: string,
): number[] {
  const ids = results
    .filter((r) => namesAgree(r.result?.finalSpecies, species))
    .map((r) => Number(r.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  return [...new Set(ids)];
}

export async function decideRecord(input: RecordDecisionInput, ports: RecordDecisionPorts): Promise<RecordDecision> {
  const { platform, analysisResults } = input;
  const obsId = input.observationId;
  const key = `${platform}:${obsId}`;
  const seqMeta: Record<string, RecordSequenceMetadata> = { ...input.sequenceMetadata };
  const markedNonTarget: string[] = [];
  const setAside = (id: string) => {
    seqMeta[id] = { ...seqMeta[id], isNonTarget: true };
    markedNonTarget.push(id);
  };
  // An eDNA sample never takes MycoMap Vision (visionAgreement.ts).
  const recordIsEdna = visionAgreementDna({
    species: null,
    sequences: input.sequenceIds.map((id: string) => ({ id: String(id), analysis: analysisResults[String(id)] })),
  }).edna;
  const latestVisionRef = async () => visionRefOf(await ports.latestVisionAnswer());

  const steps = async (): Promise<RecordStop | { reject: "no_sequences" | "only_contaminants" } | { proceed: RecordValidate }> => {
    const seqIds: string[] = input.sequenceIds;
    ports.jobLog(`--- ${key} --- seqIds=[${seqIds.join(', ')}] (${seqIds.length} total)`);

    // No decision, validate or reject, until every sequence that counts has
    // its NCBI and MycoBLAST results (2026-10-21). The exemptions
    // (trashed, excluded, local-only, dead NCBI half) are in
    // autovalidationNcbiReadiness.ts.
    const readiness = await ports.ncbiReadiness();
    if (!readiness.listed) {
      ports.jobLog(`${key}: could not read the record's sequence list from mycomap.com; checked only the run's own sequences`);
    }
    for (const s of readiness.exempt) ports.jobLog(`${key}: seq ${s.id} does not hold the record (${s.why}: ${s.detail})`);
    if (!readiness.ready) {
      const waitingForBlast = readiness.waiting.map(({ id, why, detail }) => ({ id, why, detail }));
      ports.jobLog(`${key}: WAITING — ${waitingForBlast.map(s => `seq ${s.id} ${s.why}`).join(', ')}`);
      await ports.noteNcbiWait(waitingForBlast);
      return { observationId: obsId, platform, action: 'skipped', success: true, error: ncbiWaitMessage(readiness), waitingForBlast };
    }
    await ports.clearNcbiWait();

    if (seqIds.length === 0) {
      ports.info(`[AutoValidate] ${key}: No sequences → rejecting`);
      ports.jobLog(`${key}: REJECTED — no sequence IDs in recordSequenceMap`);
      return { reject: 'no_sequences' as const };
    }

    if (seqIds.length > 0) {
      ports.info(`[AutoValidate] ${key}: Looking up ${seqIds.length} sequence(s): [${seqIds.join(', ')}]`);
      const _availableResultKeys = seqIds.filter(id => analysisResults[String(id)]);
      const missingResultKeys = seqIds.filter(id => !analysisResults[String(id)]);
      if (missingResultKeys.length > 0) {
        ports.info(`[AutoValidate] ${key}: ${missingResultKeys.length} seq(s) have NO analysis results: [${missingResultKeys.join(', ')}]`);
        ports.jobLog(`${key}: ${missingResultKeys.length} seq(s) MISSING from analysisResults: [${missingResultKeys.join(', ')}]`);
      }
      for (const id of seqIds) {
        const r = analysisResults[String(id)];
        if (r) {
          ports.jobLog(`${key}: seq ${id} → status=${r.status} species="${r.finalSpecies || 'null'}" confidence=${r.finalConfidence ?? 'null'} contaminant=${r.flaggedContaminant || false} nonTarget=${r.flaggedNonTarget || false}`);
        } else {
          ports.jobLog(`${key}: seq ${id} → NO RESULT IN analysisResults`);
        }
      }
    }

    const seqResults = seqIds.map(id => ({
      id,
      result: analysisResults[String(id)] || null
    }));

    const nonContaminantResults = seqResults.filter(sr => {
      if (!sr.result) return false;
      if (sr.result.flaggedContaminant) return false;
      if (sr.result.finalSpecies && sr.result.finalSpecies.toLowerCase().startsWith('contaminant:')) return false;
      if (seqMeta[String(sr.id)]?.isNonTarget) {
        ports.info(`[AutoValidate] ${key}: Excluding seq ${sr.id} — flagged as non-target (from metadata)`);
        return false;
      }
      if (sr.result.flaggedNonTarget) {
        ports.info(`[AutoValidate] ${key}: Excluding seq ${sr.id} — flagged as non-target (from analysis result)`);
        return false;
      }
      if (sr.result.finalSpecies && sr.result.finalSpecies.toLowerCase().startsWith('non-target:')) {
        ports.info(`[AutoValidate] ${key}: Excluding seq ${sr.id} — species starts with "Non-Target:" (${sr.result.finalSpecies})`);
        return false;
      }
      return true;
    });

    ports.jobLog(`${key}: nonContaminantResults=${nonContaminantResults.length} (of ${seqResults.length} total)`);

    // A sequence with no analysis result yet (e.g. still waiting for NCBI)
    // is not a contaminant: wait for it instead of rejecting the record.
    const contaminantOutcome = contaminantOnlyOutcome(seqResults, nonContaminantResults.length);
    if (contaminantOutcome === 'wait') {
      const waiting = seqResults.filter(sr => !sr.result).map(sr => `seq ${sr.id}`).join(', ');
      ports.jobLog(`${key}: SKIPPED — no usable sequence yet; ${waiting} not analysed`);
      return { observationId: obsId, platform, action: 'skipped', success: true, error: `Not every sequence has been analysed yet (${waiting}); nothing was rejected.` };
    }

    if (contaminantOutcome === 'reject') {
      ports.info(`[AutoValidate] ${key}: Only contaminants (${seqResults.length} seqs, results: ${seqResults.map(sr => `seq${sr.id}:${sr.result ? `species=${sr.result.finalSpecies || 'null'},contam=${sr.result.flaggedContaminant || false}` : 'NO_RESULT'}`).join(', ')}) → rejecting`);
      ports.jobLog(`${key}: REJECTED — only contaminants/no results. Details: ${seqResults.map(sr => `seq${sr.id}:${sr.result ? `species=${sr.result.finalSpecies || 'null'},status=${sr.result.status},contam=${sr.result.flaggedContaminant || false}` : 'NO_RESULT'}`).join(', ')}`);
      return { reject: 'only_contaminants' as const };
    }

    let withSpecies = nonContaminantResults.filter(sr =>
      sr.result && sr.result.finalSpecies && sr.result.finalSpecies !== 'Manual Validation Needed' && (sr.result.status === 'complete' || sr.result.finalConfidence !== null && sr.result.finalConfidence !== undefined)
    );
    ports.jobLog(`${key}: withSpecies=${withSpecies.length} (filter: finalSpecies AND (status=complete OR finalConfidence!=null)). Details: ${nonContaminantResults.map(sr => `seq${sr.id}:species="${sr.result?.finalSpecies || 'null'}":status=${sr.result?.status}:conf=${sr.result?.finalConfidence ?? 'null'}:passed=${sr.result?.finalSpecies && (sr.result?.status === 'complete' || sr.result?.finalConfidence !== null && sr.result?.finalConfidence !== undefined)}`).join(', ')}`);
    if (withSpecies.length === 0) {
      // Build a per-sequence breakdown so the user knows *why* nothing usable came out.
      const breakdown = nonContaminantResults.map(sr => {
        const r = sr.result;
        if (!r) return `seq ${sr.id}: no analysis result`;
        if (r.status && r.status !== 'complete' && r.finalConfidence == null) return `seq ${sr.id}: still ${r.status}`;
        if (!r.finalSpecies) return `seq ${sr.id}: ${r.status || 'complete'} but no species determination (likely below barcode-gap threshold)`;
        return `seq ${sr.id}: ${r.status} / "${r.finalSpecies}" / conf ${r.finalConfidence ?? 'n/a'}`;
      });
      const detail = breakdown.length ? ` Per-sequence: ${breakdown.join('; ')}.` : '';
      ports.info(`[AutoValidate] ${key}: No sequences complete with species (${nonContaminantResults.map(sr => `seq${sr.id}:species=${sr.result?.finalSpecies || 'null'}:status=${sr.result?.status}:conf=${sr.result?.finalConfidence ?? 'null'}`).join(', ')}) → skipping`);
      ports.jobLog(`${key}: SKIPPED — no sequences complete with species`);
      return { observationId: obsId, platform, action: 'skipped', success: true, error: `No sequences finished with a usable species name.${detail}` };
    }

    let speciesNames = new Set(withSpecies.map(sr => sr.result!.finalSpecies!));
    const waitForVision = () => ports.waitForVision();
    // 2026-11-06: when the reads disagree, Vision picks, whatever the read
    // counts. The other reads are set aside, and off-target macrofungi go to the
    // recoverable trash (runContaminantTrash.ts). That needs Vision's
    // answer, so wait for it here as the rule below does.
    // 2026-11-07: Vision also picks when the analysis marked a read
    // Non-Target, even if the other reads agree. That mark mostly follows the
    // observer's family, and the observer can be wrong; if Vision picks the
    // marked read, a person decides the record.
    const flaggedRead = recordHasFlaggedRead(seqResults.map(sr => ({
      flaggedNonTarget: sr.result?.flaggedNonTarget,
      finalSpecies: sr.result?.finalSpecies,
      metaNonTarget: seqMeta[String(sr.id)]?.isNonTarget,
    })));
    let disagreementWaitsOnVision = false;
    // What Vision made of disagreeing reads (null: not asked, or nothing decided).
    let readPickState: ReadPickState | null = null;
    if ((speciesNames.size !== 1 || flaggedRead) && (platform === 'inat' || platform === 'mo') && !recordIsEdna) {
      await waitForVision();
      // The runner records read_pick / read_set_aside / read_trashed itself.
      const settled = await ports.settleReads();
      readPickState = settled.pickState;
      if (settled.pickedFlagged) {
        const reason = visionPickedFlaggedReadReason(settled.pickedFlagged);
        await ports.recordVisionEvents([{ kind: 'flagged_read_to_person', sequenceIds: settled.pickedFlagged.sequenceIds, vision: await latestVisionRef() }]);
        ports.jobLog(`${key}: SKIPPED — ${reason}`);
        return { observationId: obsId, platform, action: 'skipped', success: true, error: reason };
      }
      disagreementWaitsOnVision = settled.visionMissing;
      if (settled.trashed.length > 0) {
        ports.jobLog(`${key}: moved to the recoverable trash as run contaminants: ${settled.trashed.join(', ')}`);
        const gone = new Set(settled.trashed);
        for (const id of gone) setAside(id);
        withSpecies = withSpecies.filter(sr => !gone.has(String(sr.id)));
        speciesNames = new Set(withSpecies.map(sr => sr.result!.finalSpecies!));
      }
      // Not every read Vision set aside can be trashed (a mould, a read in the same family).
      const kept = new Set(settled.kept);
      const left = withSpecies.filter(sr => kept.has(String(sr.id)));
      if (left.length > 0 && left.length < withSpecies.length) {
        const aside = withSpecies.filter(sr => !kept.has(String(sr.id)));
        ports.jobLog(`${key}: Vision picked ${left[0].result!.finalSpecies}; set aside: ${aside.map(sr => `seq ${sr.id} ${sr.result!.finalSpecies}`).join(', ')}`);
        for (const sr of aside) setAside(String(sr.id));
        withSpecies = left;
        speciesNames = new Set(withSpecies.map(sr => sr.result!.finalSpecies!));
      }
    }
    // MyCoPortal (mycomap.org's mycoportalAutovalidation.ts): Vision can't look at the
    // record, so a read marked as another organism goes to a person.
    if (platform === MYCOPORTAL_PLATFORM && flaggedRead && speciesNames.size === 1) {
      const reason = `A read on this record is marked as another organism, and MycoMap Vision does not check MyCoPortal records. Held for a person.`;
      ports.jobLog(`${key}: SKIPPED — ${reason}`);
      return { observationId: obsId, platform, action: 'skipped', success: true, error: reason };
    }
    if (speciesNames.size !== 1) {
      // Group confidences by species so the user can see the disagreement at a glance.
      const bySpecies = new Map<string, string[]>();
      for (const sr of withSpecies) {
        const sp = sr.result!.finalSpecies!;
        const conf = sr.result!.finalConfidence;
        const list = bySpecies.get(sp) || [];
        list.push(`seq ${sr.id} ${conf != null ? `${conf}%` : 'n/a'}`);
        bySpecies.set(sp, list);
      }
      const summary = [...bySpecies.entries()].map(([sp, hits]) => `"${sp}" (${hits.join(', ')})`).join(' vs ');
      ports.info(`[AutoValidate] ${key}: Multiple species (${[...speciesNames].join(', ')}) → skipping`);
      ports.jobLog(`${key}: SKIPPED — multiple species: ${[...speciesNames].join(', ')}`);
      // Rules v1.4: before Vision has answered, reads that disagree wait too; nothing goes to a person yet.
      const disagreementWaits = disagreementWaitsOnVision && !(await ports.visionFoundNoPhotos());
      if (disagreementWaitsOnVision) {
        await ports.recordVisionEvents([{ kind: 'vision_no_answer', reason: disagreementWaits ? 'waiting' : 'no_usable_photos' }]);
      }
      // Vision was asked to pick between the reads and could not: a person decides.
      if (!disagreementWaits && (readPickState === 'no_pick' || readPickState === 'no_answer')) {
        await ports.recordVisionEvents([{ kind: 'skipped_for_person', reason: 'no_read_pick', sequenceIds: withSpecies.map(sr => String(sr.id)), vision: await latestVisionRef() }]);
      }
      return {
        observationId: obsId, platform, action: 'skipped', success: true,
        error: disagreementWaits ? `${WAITING_FOR_VISION_TEXT} Sequences disagree on species: ${summary}.` : `Sequences disagree on species: ${summary}. Manual review needed.`,
        visionPending: disagreementWaitsOnVision,
        ...(disagreementWaits ? { waitingForVision: true } : {}),
      };
    }

    const withoutSpecies = nonContaminantResults.filter(sr =>
      sr.result && (sr.result.status === 'complete' || sr.result.finalConfidence !== null) && !sr.result.finalSpecies
    );
    if (withoutSpecies.length > 0) {
      ports.info(`[AutoValidate] ${key}: ${withoutSpecies.length} seq(s) without species (${withoutSpecies.map(sr => `seq${sr.id}`).join(', ')}) — consensus from ${withSpecies.length} seq(s) still agrees`);
    }

    const hasAtLeastOneGreen = withSpecies.some(sr =>
      sr.result && sr.result.finalConfidence !== null && sr.result.finalConfidence >= 70
    );

    // MycoMap Vision beside the DNA (visionAgreement.ts,
    // 2026-10-23): it green-checks the DNA species below the threshold when
    // it agrees at species or genus, and holds the record for a person when
    // it is confident of another genus, whatever the name confidence, unless
    // it also shows the DNA genus or species at 30% or more. Never
    // for an eDNA sample. When the Vision queue has the record, wait for
    // its answer (at most 60 s, mycomap.org's visionAgreementWait.ts) so the
    // veto can apply before anything is written.
    const visionDna = visionAgreementDna({
      species: [...speciesNames][0],
      sequences: seqResults.map(sr => ({ id: String(sr.id), analysis: sr.result })),
    });
    let visionDecision: VisionAgreementDecision | null = null;
    let visionAnswer: VisionAgreementVision | null = null;
    let visionWaitedMs = 0;
    if (!visionDna.edna && (platform === 'inat' || platform === 'mo')) {
      const wait = await waitForVision();
      visionWaitedMs = wait.waitedMs;
      visionAnswer = wait.vision;
      const visionDnaFamily = wait.vision ? await ports.loadDnaFamily(visionDna.species) : null;
      visionDecision = decideVisionAgreement({ dna: visionDna, vision: wait.vision, dnaFamily: visionDnaFamily });
      // 2026-11-01 (#364): the veto does not fire when the
      // observer's identification is in the DNA genus. Read only when it
      // matters; if it can't be read, the veto stands as before.
      if (visionDecision.outcome === 'vetoes') {
        try {
          const observer = await ports.loadObserverIdentification();
          visionDecision = decideVisionAgreement({ dna: visionDna, vision: wait.vision, observer, dnaFamily: visionDnaFamily });
        } catch (observerErr: any) {
          ports.warn(`[AutoValidate] ${key}: could not read the observer's identification: ${observerErr?.message ?? observerErr}`);
        }
      }
      // 2026-11-04: Vision backing the DNA takes away the 50 off for the
      // observer's family. The penalty is read from the stored analyses: the
      // pages post a summary without it.
      if (!hasAtLeastOneGreen && visionDecision.outcome === 'none') {
        const stored = await ports.loadStoredAnalyses(seqResults.map(sr => String(sr.id)));
        const storedSequences = seqResults.map(sr => ({ id: String(sr.id), analysis: stored[String(sr.id)] ?? null }));
        const lift = decideFamilyPenaltyLift({
          decision: visionDecision,
          dnaFamily: visionDnaFamily,
          vision: wait.vision,
          sequences: storedSequences,
        });
        // 2026-11-05: otherwise a score of 20 or more is enough with that same backing.
        visionDecision = lift ?? decideTopListAgreement({
          decision: visionDecision,
          dnaFamily: visionDnaFamily,
          vision: wait.vision,
          scoreWithoutPenalty: scoreWithoutFamilyPenalty(visionDna.species, storedSequences),
        }) ?? visionDecision;
      }
      ports.jobLog(`${key}: ${describeVisionAgreement(visionDecision!)}${wait.waitedMs > 0 ? ` (waited ${Math.round(wait.waitedMs / 1000)} s for Vision${wait.timedOut ? ', no answer in time' : ''})` : ''}`);
      // 2026-11-09 (rules v1.4): until Vision has answered, nothing is decided and
      // nothing is written, not even to Autovalidation Assist. Vision's second pass runs the
      // record again when the answer arrives. Only "no usable photos" lets it go on without
      // Vision; then only the observer can be its second source.
      const noUsablePhotos = !wait.vision && await ports.visionFoundNoPhotos();
      if (!wait.vision) await ports.recordVisionEvents([{ kind: 'vision_no_answer', reason: noUsablePhotos ? 'no_usable_photos' : 'waiting' }]);
      if (!wait.vision && !noUsablePhotos) {
        ports.jobLog(`${key}: WAITING FOR VISION — nothing decided or written; it runs again when Vision answers`);
        return { observationId: obsId, platform, action: 'skipped', success: true, error: WAITING_FOR_VISION_TEXT, visionPending: true, waitingForVision: true };
      }
    }
    const visionSummary = (applied: boolean): RecordVisionSummary => visionDecision ? {
      outcome: visionDecision.outcome,
      ...(visionDecision.outcome === 'agrees' ? { branch: visionDecision.branch } : {}),
      ...(visionDecision.outcome === 'none' ? { reason: visionDecision.reason } : {}),
      line: describeVisionAgreement(visionDecision, applied),
      ...(visionWaitedMs > 0 ? { waitedMs: visionWaitedMs } : {}),
    } : undefined;

    if (visionDecision?.outcome === 'vetoes') {
      const reason = visionVetoReason(visionDecision);
      ports.info(`[AutoValidate] ${key}: ${reason}`);
      ports.jobLog(`${key}: HELD BY MYCOMAP VISION — ${reason}`);
      try {
        // The hold and its event in one transaction.
        await ports.recordVisionHold(visionDecision, { kind: 'hold', reason: 'genus_veto', sequenceIds: withSpecies.map(sr => String(sr.id)), vision: visionRefOf(visionAnswer) });
      } catch (holdErr: any) {
        ports.warn(`[AutoValidate] ${key}: could not save the Vision hold: ${holdErr?.message ?? holdErr}`);
      }
      return { observationId: obsId, platform, action: 'skipped', success: true, error: reason, vision: visionSummary(true) };
    }
    // Vision's agreement makes this validation only where the DNA alone would not.
    const visionMakesIt = !hasAtLeastOneGreen && visionDecision?.outcome === 'agrees'
      ? visionDecision as VisionAgreementDecision & { outcome: 'agrees' }
      : null;

    if (!hasAtLeastOneGreen && !visionMakesIt) {
      const sp = [...speciesNames][0];
      const confList = withSpecies.map(sr => `seq ${sr.id}: ${sr.result?.finalConfidence ?? 'n/a'}%`).join(', ');
      const top = Math.max(...withSpecies.map(sr => sr.result?.finalConfidence ?? 0));
      ports.info(`[AutoValidate] ${key}: Same species "${sp}" but no sequence ≥70% (${withSpecies.map(sr => `seq${sr.id}:${sr.result?.finalConfidence}`).join(', ')}) → skipping`);
      ports.jobLog(`${key}: SKIPPED — no sequence ≥70% confidence. Species="${sp}", confidences: ${confList}`);
      // Vision was the record's one way past the threshold and did not take it there.
      if (visionDecision) {
        await ports.recordVisionEvents([{ kind: 'skipped_for_person', reason: 'below_threshold_not_lifted', sequenceIds: withSpecies.map(sr => String(sr.id)), vision: visionRefOf(visionAnswer) }]);
      }
      return {
        observationId: obsId,
        platform,
        action: 'skipped',
        success: true,
        error: `All sequences agree on "${sp}" but none reach the 70% confidence threshold (best: ${top}%; ${confList}). Manual review needed.`,
        vision: visionSummary(false),
        visionPending: visionDecision?.outcome === 'none' && visionDecision.reason === 'no_vision_answer',
      };
    }
    // 2026-11-09: the DNA alone can't see that it came from another specimen,
    // so every validation also needs a source that isn't the DNA (visionAgreement.ts).
    // Never for an eDNA sample, and only where Vision and an observer exist.
    // Both second sources are checked and recorded independently (rules v1.4; the
    // Vision v2 paper). Either one lets the record go on, as before.
    let secondSourceVision: ReturnType<typeof secondSourceFromVision> = null;
    let secondSourceByObserver: ReturnType<typeof secondSourceFromObserver> = null;
    if (!visionDna.edna && (platform === 'inat' || platform === 'mo')) {
      secondSourceVision = secondSourceFromVision(visionDna.species, visionAnswer);
      let secondSourceObserver = visionDecision?.observer ?? null;
      try {
        if (!secondSourceObserver) secondSourceObserver = await ports.loadObserverIdentification();
        secondSourceByObserver = secondSourceFromObserver(visionDna.species, secondSourceObserver);
      } catch (observerErr: any) {
        ports.warn(`[AutoValidate] ${key}: could not read the observer's identification: ${observerErr?.message ?? observerErr}`);
      }
      const secondSource = secondSourceVision ?? secondSourceByObserver;
      if (!secondSource) {
        const reason = noSecondSourceReason({ species: visionDna.species, vision: visionAnswer, observer: secondSourceObserver });
        ports.info(`[AutoValidate] ${key}: ${reason}`);
        ports.jobLog(`${key}: HELD, NO SECOND SOURCE — ${reason}`);
        const holdEvent: RecordVisionEvent = { kind: 'hold', reason: 'no_second_source', sequenceIds: withSpecies.map(sr => String(sr.id)), vision: visionRefOf(visionAnswer) };
        if (visionAnswer && visionDecision) {
          try {
            await ports.recordVisionHold(visionDecision, holdEvent);
          } catch (holdErr: any) {
            ports.warn(`[AutoValidate] ${key}: could not save the hold: ${holdErr?.message ?? holdErr}`);
          }
        } else {
          await ports.recordVisionEvents([holdEvent]);
        }
        return {
          observationId: obsId,
          platform,
          action: 'skipped',
          success: true,
          error: reason,
          vision: visionDecision ? { ...visionSummary(false)!, line: reason } : undefined,
          visionPending: !visionAnswer,
        };
      }
    }
    // How Vision gated the record, recorded now: whatever the steps below do, Vision's part is decided.
    if (visionDecision && !visionDna.edna && (platform === 'inat' || platform === 'mo')) {
      const visionRef = visionRefOf(visionAnswer);
      const sequenceIds = withSpecies.map(sr => String(sr.id));
      const gated: RecordVisionEvent[] = [];
      if (visionMakesIt) gated.push({ kind: visionMakesIt.branch === 'family_penalty' ? 'penalty_lift' : 'agreement_validated', sequenceIds, vision: visionRef });
      if (visionDecision.vetoSparedByObserver) gated.push({ kind: 'observer_over_vision', sequenceIds, vision: visionRef });
      if (secondSourceVision) gated.push({ kind: 'second_source_vision', sequenceIds, vision: visionRef });
      if (secondSourceByObserver) gated.push({ kind: 'second_source_observer', sequenceIds, vision: visionRef });
      // Vision answered, but neither lifted, gated, nor was overruled for this record.
      if (visionAnswer && gated.every(e => e.kind === 'second_source_observer')) gated.push({ kind: 'vision_checked_no_effect', sequenceIds, vision: visionRef });
      await ports.recordVisionEvents(gated);
    }
    if (visionMakesIt) {
      ports.jobLog(`${key}: below the 70% threshold, but ${describeVisionAgreement(visionMakesIt)}`);
    } else if (visionDecision?.vetoSparedByObserver) {
      ports.jobLog(`${key}: SPARED BY OBSERVER — ${visionVetoSparedText(visionDecision)} Going on with the DNA rules.`);
    }
    const RIC_PUSH_THRESHOLD = AUTOVALIDATION_MIN_RIC;
    // Build per-sequence RiC from the client-posted metadata first, then fall back
    // to the MycoMap API for any sequences whose RiC the client didn't supply.
    // This prevents stale/missing client metadata from skipping records as "RiC n/a".
    const ricBySeqId = new Map<string, number | null>();
    for (const sr of withSpecies) {
      const v = seqMeta[String(sr.id)]?.ricScore;
      ricBySeqId.set(String(sr.id), v === null || v === undefined ? null : v);
    }
    // Possibly Sanger (not an ONT consensus with a recorded RiC): RiC does not hold it
    // back (2026-11-16). Only the server's own reading says so, never the page's
    // word alone: every sequence that would pass only that way, or not at all, is read
    // again. A sequence the read does not answer for is judged by its RiC.
    const possiblySanger = new Set<string>();
    // iNaturalist and Mushroom Observer copies: they can stand for the record, pushed last (never pushed back).
    const platformCopies = new Set<string>();
    const clearsOnRic = (id: string) => {
      const ric = ricBySeqId.get(id);
      return ric !== null && ric !== undefined && ric >= RIC_PUSH_THRESHOLD;
    };
    const missingRicIds = withSpecies
      .map(sr => String(sr.id))
      .filter(id => !clearsOnRic(id) || seqMeta[id]?.possiblySanger === true);
    if (missingRicIds.length > 0) {
      try {
        const ricResp = await ports.fetchRic(missingRicIds);
        if (ricResp.ok) {
          for (const seq of ricResp.rics) {
            if (seq.platformCopy) platformCopies.add(seq.id);
            if (seq.possiblySanger) possiblySanger.add(seq.id);
            else if (ricBySeqId.get(seq.id) === null) ricBySeqId.set(seq.id, seq.ric);
          }
          ports.jobLog(`${key}: RiC fallback fetched for [${missingRicIds.join(', ')}] → ${missingRicIds.map(id => `seq ${id}: ${possiblySanger.has(id) ? 'possibly Sanger' : ricBySeqId.get(id) ?? 'n/a'}`).join(', ')}`);
        } else {
          ports.jobLog(`${key}: RiC fallback fetch failed (HTTP ${ricResp.status}) for [${missingRicIds.join(', ')}]`);
        }
      } catch (err: any) {
        ports.warn(`[AutoValidate] ${key}: RiC fallback fetch error: ${err.message}`);
        ports.jobLog(`${key}: RiC fallback fetch error: ${err.message}`);
      }
    }
    const ricForSeq = (id: string): number | null => {
      const v = ricBySeqId.get(String(id));
      return v === null || v === undefined ? null : v;
    };
    const hasRicAtThreshold = withSpecies.some(sr => {
      if (possiblySanger.has(String(sr.id))) return true;
      const ric = ricForSeq(sr.id);
      return ric !== null && ric >= RIC_PUSH_THRESHOLD;
    });
    if (!hasRicAtThreshold) {
      const sp = [...speciesNames][0];
      const ricList = withSpecies.map(sr => {
        const ric = ricForSeq(sr.id);
        return `seq ${sr.id}: RiC ${ric ?? 'n/a'}`;
      }).join(', ');
      const topRic = Math.max(...withSpecies.map(sr => ricForSeq(sr.id) ?? -Infinity));
      const topRicStr = Number.isFinite(topRic) ? String(topRic) : 'n/a';
      ports.info(`[AutoValidate] ${key}: Same species "${sp}" but no sequence with RiC ≥ ${RIC_PUSH_THRESHOLD} (${ricList}) → skipping`);
      ports.jobLog(`${key}: SKIPPED — no sequence with RiC ≥ ${RIC_PUSH_THRESHOLD}. Species="${sp}", RiC scores: ${ricList}`);
      return {
        observationId: obsId,
        platform,
        action: 'skipped',
        success: true,
        error: `All sequences agree on "${sp}" but none reach the RiC ≥ ${RIC_PUSH_THRESHOLD} threshold (best: ${topRicStr}; ${ricList}). Manual review needed.`,
      };
    }

    // The page's own possiblySanger never reaches the gate; only the reading above does.
    const evaluatedMetadata: Record<string, RecordSequenceMetadata> = Object.fromEntries(
      Object.entries(seqMeta).map(([id, meta]) => [id, { ...meta, possiblySanger: false, platformCopy: false }]),
    );
    for (const sr of withSpecies) {
      evaluatedMetadata[String(sr.id)] = {
        ...evaluatedMetadata[String(sr.id)],
        ricScore: possiblySanger.has(String(sr.id)) ? null : ricForSeq(sr.id),
        possiblySanger: possiblySanger.has(String(sr.id)),
        platformCopy: platformCopies.has(String(sr.id)),
      };
    }
    const eligibility = evaluateAutovalidationEligibility({
      sequenceIds: seqIds,
      analysisResults,
      sequenceMetadata: evaluatedMetadata,
      waiveConfidenceThreshold: !!visionMakesIt,
    });
    if (!eligibility.eligible) {
      ports.jobLog(`${key}: SKIPPED BY SHARED ELIGIBILITY — ${eligibility.reason}`);
      return {
        observationId: obsId,
        platform,
        action: "skipped",
        success: true,
        error: `${eligibility.message} Manual review needed.`,
        vision: visionSummary(false),
      };
    }
    // The verdict name is always the DNA's species, never Vision's.
    if (visionMakesIt && eligibility.species.trim() !== visionMakesIt.verdictName) {
      ports.jobLog(`${key}: SKIPPED — the eligible species "${eligibility.species}" is not the one Vision agreed with ("${visionMakesIt.verdictName}")`);
      return {
        observationId: obsId, platform, action: "skipped", success: true,
        error: `Vision agreed with "${visionMakesIt.verdictName}", but the eligible DNA species is "${eligibility.species}". Manual review needed.`,
        vision: visionSummary(false),
      };
    }

    ports.jobLog(`${key}: PASSED all checks — species="${eligibility.species}", green=${hasAtLeastOneGreen}`);
    return {
      proceed: {
        species: eligibility.species,
        selectedSequenceId: eligibility.selectedSequenceId,
        eligibleSequenceIds: eligibility.eligibleSequenceIds,
        agreeingSequenceIds: sequencesNamingSpecies(withSpecies, eligibility.species),
        visionDecision,
        visionAnswer,
        visionMakesIt,
        vision: visionSummary(!!visionMakesIt),
        secondSourceVision,
        secondSourceByObserver,
      },
    };
  };

  const outcome = await steps();
  if ("reject" in outcome) return { kind: "reject", why: outcome.reject, markedNonTarget };
  if ("proceed" in outcome) return { kind: "validate", ...outcome.proceed, markedNonTarget };
  return { kind: "stop", result: outcome, markedNonTarget };
}
