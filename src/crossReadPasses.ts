/**
 * The cross-read passes: the rules
 * the batch analysis applies across one record's reads once each read has
 * been analysed on its own. They change what the record's reads came to:
 *
 *   - cross-sequence non-target detection (reads of another family than the
 *     record, with a low RiC, beside one that matches);
 *   - cross-sequence confidence dominance (a species held at a high
 *     confidence on one read against other names below a low one);
 *   - the kingdom / phylum / class override;
 *   - no BLAST hits: a read with nothing to compare beside reads with results;
 *   - the stray read (strayReadPass.ts and the engine's strayRead.ts).
 *
 * Moved line for line out of mycomap.org's batchAnalysisService.ts. They read and
 * write nothing by themselves: the saved analyses, the sequence flags in
 * The record store (where MycoMap keeps sequences and their flags), the job's stop, a read's hits and primers, and the log all go
 * through `ports`, so the passes can be recorded and run again from the same
 * answers, and later move into the validation engine (lib/validation-engine).
 *
 * `results` is the run's own summary of each read, changed here as the job
 * changed it before.
 */
import type { AnalysisResult } from "./analysisRules";
import type { RecordReadSummary } from "./strayRead";
import type { AnalysisJobResult } from "./analysisJobResult";
import { flagStrayReads, type StrayReadPassDeps } from "./strayReadPass";

/** A read of the run, as the passes see it. */
export interface CrossReadSequence {
  id: string;
  observationId: string;
  ric?: number | null;
  scientificName: string | null;
  platform?: string | null;
  title?: string | null;
  primers?: { forward?: string | null; reverse?: string | null } | null;
  localBlastXml?: string;
  ncbiBlastXml?: string;
}

export interface CrossReadPassesInput {
  jobId: string;
  /** The run's summary of each read, by sequence id; the passes change it. */
  results: Record<string, AnalysisJobResult>;
  /** The reads of the run, in the order the run took them. */
  reads: CrossReadSequence[];
  /** Whether a sequence's flags may be set in the record store (the run has the key). */
  canFlagSequences: boolean;
}

export interface CrossReadPassesPorts {
  /** Stops the run when it is being shut down or cancelled (throws). */
  checkAborted(): void;
  /** The saved analyses of these reads that are theirs. */
  loadSavedResults(sequenceIds: string[]): Promise<Array<{ sampleId: string; resultData: unknown }>>;
  saveResult(sequenceId: string, result: AnalysisResult): Promise<unknown>;
  /** Sets or clears a sequence's flags in the record store ("flags[contaminant]=1"). */
  postSequenceFlags(sequenceId: string, body: string): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  /** The stray-read pass's reading of each read's primers, for one record. */
  strayReadAmpliconOf(obsId: string, recordReads: CrossReadSequence[]): StrayReadPassDeps["ampliconOf"];
  /** The stray-read pass's reading of one read's hits. */
  strayReadHits(sequenceId: string, recordReads: CrossReadSequence[]): ReturnType<StrayReadPassDeps["loadHits"]>;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export async function runCrossReadPasses(input: CrossReadPassesInput, ports: CrossReadPassesPorts): Promise<void> {
  // The names the passes were written with in the job.
  const job = { results: input.results };
  const jobId = input.jobId;
  const sequencesToAnalyze = input.reads;
  const apiKey = input.canFlagSequences;

  // ===== CROSS-SEQUENCE NON-TARGET DETECTION =====
  // Group sequences by observation and detect non-target sequences:
  // If multiple sequences have different species names, and one matches
  // the source family with no Low RiC while others have Low RiC and don't
  // match family, flag the Low RiC/family-mismatch ones as non-target.
  const obsByObs = new Map<string, Array<{ seqId: string; ric: number | null; sourceName: string | null }>>();
  for (const seq of sequencesToAnalyze) {
    if (!seq.observationId) continue;
    const arr = obsByObs.get(seq.observationId) || [];
    arr.push({ seqId: seq.id, ric: seq.ric ?? null, sourceName: seq.scientificName ?? null });
    obsByObs.set(seq.observationId, arr);
  }

  for (const [obsId, obsSeqs] of obsByObs) {
    ports.checkAborted();
    if (obsSeqs.length < 2) continue;

    const completedSeqs = obsSeqs.filter(s => {
      const r = job.results[s.seqId];
      return r && r.status === "complete" && !r.flaggedContaminant && !r.flaggedNonTarget && r.finalSpecies;
    });

    if (completedSeqs.length < 2) continue;

    const speciesNames = new Set(completedSeqs.map(s => job.results[s.seqId].finalSpecies!.toLowerCase()));
    if (speciesNames.size < 2) continue;

    const seqIds = completedSeqs.map(s => s.seqId);
    const fullResults = (await ports.loadSavedResults(seqIds));
    const fullResultMap = new Map(fullResults.map(r => [r.sampleId, r.resultData as AnalysisResult]));

    const LOW_RIC_THRESHOLD = 10;
    const HIGH_CONFIDENCE_THRESHOLD = 70;
    const LOW_CONFIDENCE_THRESHOLD = 30;

    const candidates: Array<{
      seqId: string;
      species: string;
      hasLowRic: boolean;
      familyMatchStatus: "match" | "mismatch" | "unknown";
      ricValue: number | null;
      confidence: number | null;
    }> = [];

    for (const s of completedSeqs) {
      const jobResult = job.results[s.seqId];
      const fullResult = fullResultMap.get(s.seqId);
      const breakdown = fullResult?.confidenceBreakdown;

      const hasLowRic = (s.ric !== null && s.ric < LOW_RIC_THRESHOLD) ||
        (breakdown?.ricPenalty != null && breakdown.ricPenalty > 0 && !breakdown.ricPenaltyWaived);

      let familyMatchStatus: "match" | "mismatch" | "unknown" = "unknown";
      if (fullResult?.steps) {
        const srcStep = fullResult.steps.find(st => st.step === "Source Record Comparison");
        if (srcStep?.status === "pass") familyMatchStatus = "match";
        else if (srcStep?.status === "fail") familyMatchStatus = "mismatch";
      }

      const confidence = fullResult?.finalConfidence ?? null;

      candidates.push({
        seqId: s.seqId,
        species: jobResult.finalSpecies!,
        hasLowRic,
        familyMatchStatus,
        ricValue: s.ric,
        confidence,
      });
    }

    // Source-record family uniqueness is determined by Source Record Comparison = pass count.
    const familyMatchSeqs = candidates.filter(c => c.familyMatchStatus === "match");
    const strongAnchors = familyMatchSeqs.filter(c => !c.hasLowRic);
    // Strict predicate for the new sole-anchor paths: require a known numeric RiC > 10.
    // (`!hasLowRic` alone would accept ric === null or ric === 10, which is unsafe here.)
    // A possibly-Sanger sequence (ric null: not ONT, or no RiC recorded; 2026-11-16)
    // is never "low RiC", so it is never set aside as a low-RiC non-target read and it
    // counts as a strong family-matching peer below. It cannot be a sole anchor, though:
    // a sole anchor marks every family-mismatch read non-target whatever its own RiC,
    // and that stays on the evidence of an ONT consensus with more than 10 reads.
    const hasStrictHighRic = (c: typeof candidates[number]) =>
      c.ricValue != null && c.ricValue > LOW_RIC_THRESHOLD && !c.hasLowRic;
    const strictAnchors = familyMatchSeqs.filter(hasStrictHighRic);

    // Detect a "sole anchor" — either the only family-matching sequence in the batch
    // with RiC > 10, or, when multiple family matches exist, a confidence-dominant one
    // (>= 70 green) with all other family matches in low-confidence (< 30) territory.
    let soleAnchor: typeof candidates[number] | null = null;
    let soleAnchorReason: "unique-family" | "confidence-dominant" | null = null;

    if (familyMatchSeqs.length === 1 && strictAnchors.length === 1) {
      soleAnchor = strictAnchors[0];
      soleAnchorReason = "unique-family";
    } else if (familyMatchSeqs.length >= 2) {
      const highConf = familyMatchSeqs.filter(c => c.confidence != null && c.confidence >= HIGH_CONFIDENCE_THRESHOLD);
      const lowConfPeers = familyMatchSeqs.filter(c => c.confidence != null && c.confidence < LOW_CONFIDENCE_THRESHOLD);
      if (
        highConf.length === 1 &&
        hasStrictHighRic(highConf[0]) &&
        lowConfPeers.length === familyMatchSeqs.length - 1
      ) {
        soleAnchor = highConf[0];
        soleAnchorReason = "confidence-dominant";
      }
    }

    let goodSeqs: typeof candidates;
    let nonTargetCandidates: typeof candidates;
    let detectionReason: string;

    if (soleAnchor) {
      goodSeqs = [soleAnchor];
      // With a sole anchor, every family-mismatch sequence in the batch is non-target,
      // regardless of its own RiC.
      nonTargetCandidates = candidates.filter(c =>
        c.seqId !== soleAnchor!.seqId && c.familyMatchStatus === "mismatch"
      );
      detectionReason = soleAnchorReason === "unique-family"
        ? `Sole family-matching anchor (RiC > ${LOW_RIC_THRESHOLD})`
        : `Confidence-dominant family anchor (>= ${HIGH_CONFIDENCE_THRESHOLD}%, peers < ${LOW_CONFIDENCE_THRESHOLD}%)`;
    } else {
      // Legacy fallback: low-RiC + family-mismatch sequences when a strong family-match peer exists.
      goodSeqs = strongAnchors;
      nonTargetCandidates = candidates.filter(c => c.hasLowRic && c.familyMatchStatus === "mismatch");
      detectionReason = `Low RiC (< ${LOW_RIC_THRESHOLD}) + family mismatch with strong family-matching peer`;
    }

    if (goodSeqs.length === 0 || nonTargetCandidates.length === 0) continue;

    ports.info(`[BatchAnalysis] Job ${jobId}: Obs ${obsId} - Non-target detection (${detectionReason}): ${goodSeqs.length} good seq(s) [${goodSeqs.map(s => `${s.seqId}:${s.species}(RiC=${s.ricValue},conf=${s.confidence})`).join(', ')}], ${nonTargetCandidates.length} non-target candidate(s) [${nonTargetCandidates.map(s => `${s.seqId}:${s.species}(RiC=${s.ricValue},conf=${s.confidence})`).join(', ')}]`);

    for (const nt of nonTargetCandidates) {
      job.results[nt.seqId].flaggedNonTarget = true;
      job.results[nt.seqId].finalSpecies = nt.species.startsWith("Non-Target:") ? nt.species : `Non-Target: ${nt.species}`;

      const fullResult = fullResultMap.get(nt.seqId);
      if (fullResult) {
        fullResult.flaggedNonTarget = true;
        fullResult.finalSpecies = nt.species.startsWith("Non-Target:") ? nt.species : `Non-Target: ${nt.species}`;
        const ntDetails: string[] = [];
        if (soleAnchor && soleAnchorReason === "unique-family") {
          ntDetails.push(
            `This sequence identified as "${nt.species}" with family mismatch (RiC=${nt.ricValue ?? 'unknown'}, confidence=${nt.confidence ?? 'unknown'}%)`,
            `Sole family-matching anchor for the source record: ${soleAnchor.seqId} (${soleAnchor.species}, RiC=${soleAnchor.ricValue ?? 'unknown'})`,
            `Flagged as non-target - excluded from final determination`,
          );
        } else if (soleAnchor && soleAnchorReason === "confidence-dominant") {
          ntDetails.push(
            `This sequence identified as "${nt.species}" with family mismatch (RiC=${nt.ricValue ?? 'unknown'}, confidence=${nt.confidence ?? 'unknown'}%)`,
            `Confidence-dominant family anchor: ${soleAnchor.seqId} (${soleAnchor.species}, confidence=${soleAnchor.confidence ?? 'unknown'}%)`,
            `Other family-matching sequences had confidence < ${LOW_CONFIDENCE_THRESHOLD}%, so the high-confidence anchor wins`,
            `Flagged as non-target - excluded from final determination`,
          );
        } else {
          ntDetails.push(
            `This sequence identified as "${nt.species}" with Low RiC and family mismatch`,
            `Other sequence(s) with matching family and RiC >= ${LOW_RIC_THRESHOLD}: ${goodSeqs.map(g => `${g.seqId} (${g.species})`).join(', ')}`,
            `Flagged as non-target - excluded from final determination`,
          );
        }
        const ntMessage = soleAnchor
          ? (soleAnchorReason === "unique-family"
              ? `Flagged as non-target: family mismatch while a sole family-matching anchor (RiC > ${LOW_RIC_THRESHOLD}) exists for this observation`
              : `Flagged as non-target: family mismatch while a confidence-dominant family anchor (>= ${HIGH_CONFIDENCE_THRESHOLD}%) exists for this observation`)
          : `Flagged as non-target: Low RiC (${nt.ricValue ?? 'unknown'}) with family mismatch, while other sequence(s) for this observation have matching family and higher RiC`;
        fullResult.steps.push({
          step: "Cross-Sequence Non-Target Detection",
          status: "fail",
          message: ntMessage,
          details: ntDetails,
        });
        await ports.saveResult(nt.seqId, fullResult);
      }

      try {
        if (apiKey) {
          const body = `flags[contaminant]=1`;
          const flagResponse = await ports.postSequenceFlags(nt.seqId, body);
          if (flagResponse.ok) {
            ports.info(`[BatchAnalysis] Job ${jobId}: Auto-flagged sequence ${nt.seqId} as non-target (obs ${obsId})`);
          } else {
            ports.error(`[BatchAnalysis] Job ${jobId}: Failed to auto-flag non-target ${nt.seqId}:`, await flagResponse.text());
          }
        }
      } catch (flagError) {
        ports.error(`[BatchAnalysis] Job ${jobId}: Error auto-flagging non-target ${nt.seqId}:`, flagError);
      }
    }

    // After flagging non-targets, check if a remaining good sequence now qualifies
    // for RiC penalty waiver (effectively the only valid sequence for the record)
    const remainingSeqs = candidates.filter(c => {
      const r = job.results[c.seqId];
      return !r?.flaggedNonTarget && !r?.flaggedContaminant;
    });

    if (remainingSeqs.length === 1) {
      const sole = remainingSeqs[0];
      const soleFullResult = fullResultMap.get(sole.seqId);
      const soleBreakdown = soleFullResult?.confidenceBreakdown;

      if (soleFullResult && soleBreakdown && soleBreakdown.ricPenalty > 0 && !soleBreakdown.ricPenaltyWaived && soleBreakdown.genusMatchBonus > 0) {
        const newScore = Math.min(100, soleBreakdown.finalScore + soleBreakdown.ricPenalty);
        ports.info(`[BatchAnalysis] Job ${jobId}: Obs ${obsId} - Seq ${sole.seqId} is now only valid sequence after non-target removal. Waiving RiC penalty: ${soleBreakdown.finalScore} -> ${newScore}`);

        soleFullResult.confidenceBreakdown = {
          ...soleBreakdown,
          ricPenalty: 0,
          ricReason: "RiC penalty waived - only valid sequence remaining after non-target removal",
          ricPenaltyWaived: true,
          finalScore: newScore,
        };
        soleFullResult.finalConfidence = newScore;
        soleFullResult.steps.push({
          step: "Cross-Sequence Non-Target Detection",
          status: "pass",
          message: `RiC penalty waived — this is now the only valid sequence for this observation after non-target removal`,
          details: [
            `Previous confidence: ${soleBreakdown.finalScore}% (RiC penalty: -${soleBreakdown.ricPenalty}%)`,
            `Updated confidence: ${newScore}% (RiC penalty waived)`,
            `${nonTargetCandidates.length} other sequence(s) flagged as non-target`,
          ],
        });
        await ports.saveResult(sole.seqId, soleFullResult);

        job.results[sole.seqId].finalConfidence = newScore;

        try {
          if (apiKey) {
            const body = `flags[low]=0`;
            const flagResponse = await ports.postSequenceFlags(sole.seqId, body);
            if (flagResponse.ok) {
              ports.info(`[BatchAnalysis] Job ${jobId}: Cleared low RiC flag for sequence ${sole.seqId} (now only valid sequence)`);
            }
          }
        } catch (e) {
          ports.error(`[BatchAnalysis] Job ${jobId}: Error clearing RiC flag for ${sole.seqId}:`, e);
        }
      }
    }
  }

  // ===== CROSS-SEQUENCE CONFIDENCE DOMINANCE — NON-TARGET =====
  // If, across an observation's sequences, exactly one species name has
  // any sequence with confidence >= 70, AND every sequence whose species
  // name differs from that anchor has confidence < 30, flag those
  // low-confidence off-name sequences as non-target. Sequences matching
  // the anchor name are left untouched regardless of their own confidence.
  const CD_HIGH = 70;
  const CD_LOW = 30;

  for (const [obsId, obsSeqs] of obsByObs) {
    ports.checkAborted();
    const eligible = obsSeqs
      .map(s => {
        const r = job.results[s.seqId];
        if (!r || r.status !== "complete") return null;
        if (r.flaggedContaminant || r.flaggedNonTarget) return null;
        if (!r.finalSpecies || r.finalSpecies === "Manual Validation Needed") return null;
        const name = r.finalSpecies.toLowerCase().trim();
        return { seqId: s.seqId, species: r.finalSpecies, nameKey: name, confidence: r.finalConfidence ?? null };
      })
      .filter((x): x is { seqId: string; species: string; nameKey: string; confidence: number | null } => !!x);

    if (eligible.length < 2) continue;

    // Find names that have at least one sequence with confidence >= 70.
    const namesWithHighConf = new Set(
      eligible.filter(e => e.confidence != null && e.confidence >= CD_HIGH).map(e => e.nameKey)
    );
    if (namesWithHighConf.size !== 1) continue;

    const anchorNameKey = [...namesWithHighConf][0];
    const anchorDisplay = eligible.find(e => e.nameKey === anchorNameKey)!.species;
    const offName = eligible.filter(e => e.nameKey !== anchorNameKey);
    if (offName.length === 0) continue;

    // Every off-name sequence must have a known confidence < 30.
    const allOffNameLow = offName.every(e => e.confidence != null && e.confidence < CD_LOW);
    if (!allOffNameLow) continue;

    const offIds = offName.map(e => e.seqId);
    const offFullResults = (await ports.loadSavedResults(offIds));
    const offFullMap = new Map(offFullResults.map(r => [r.sampleId, r.resultData as AnalysisResult]));

    ports.info(`[BatchAnalysis] Job ${jobId}: Obs ${obsId} - Confidence dominance non-target: anchor="${anchorDisplay}" (>= ${CD_HIGH}%), flagging ${offName.length} off-name seq(s) below ${CD_LOW}% [${offName.map(e => `${e.seqId}:${e.species}(conf=${e.confidence})`).join(', ')}]`);

    for (const nt of offName) {
      job.results[nt.seqId].flaggedNonTarget = true;
      job.results[nt.seqId].finalSpecies = nt.species.startsWith("Non-Target:") ? nt.species : `Non-Target: ${nt.species}`;

      const fullResult = offFullMap.get(nt.seqId);
      if (fullResult) {
        fullResult.flaggedNonTarget = true;
        fullResult.finalSpecies = nt.species.startsWith("Non-Target:") ? nt.species : `Non-Target: ${nt.species}`;
        fullResult.steps.push({
          step: "Cross-Sequence Confidence Dominance",
          status: "fail",
          message: `Flagged as non-target: confidence ${nt.confidence}% (< ${CD_LOW}%) while a different species "${anchorDisplay}" reached >= ${CD_HIGH}% on another sequence for this observation`,
          details: [
            `This sequence identified as "${nt.species}" (confidence ${nt.confidence}%)`,
            `Anchor species across the observation: "${anchorDisplay}" (>= ${CD_HIGH}% on at least one sequence)`,
            `All other-named sequences on this observation are below ${CD_LOW}% confidence`,
            `Flagged as non-target - excluded from final determination`,
          ],
        });
        await ports.saveResult(nt.seqId, fullResult);
      }

      try {
        if (apiKey) {
          const body = `flags[contaminant]=1`;
          const flagResponse = await ports.postSequenceFlags(nt.seqId, body);
          if (flagResponse.ok) {
            ports.info(`[BatchAnalysis] Job ${jobId}: Auto-flagged sequence ${nt.seqId} as non-target via confidence dominance (obs ${obsId})`);
          } else {
            ports.error(`[BatchAnalysis] Job ${jobId}: Failed to auto-flag non-target ${nt.seqId}:`, await flagResponse.text());
          }
        }
      } catch (flagError) {
        ports.error(`[BatchAnalysis] Job ${jobId}: Error auto-flagging non-target ${nt.seqId}:`, flagError);
      }
    }
  }

  // ===== KINGDOM / PHYLUM / CLASS OVERRIDE =====
  // When the iNat source record is identified only as Fungi, Basidiomycota,
  // Ascomycota, Agaricomycotina, or Agaricomycetes, the per-sequence flow
  // forces "Manual Validation Needed" because no family could be resolved.
  // If, across the batch for that observation, every completed sequence
  // resolves to the same single species name (using its provisional
  // pre-manual-validation name where present) and at least one sequence
  // reached >= 70% confidence, accept that name and lift the
  // manual-validation block.
  const OVERRIDEABLE_SOURCES = new Set(["basidiomycota", "ascomycota", "fungi", "agaricomycotina", "agaricomycetes"]);
  const HIGH_CONF_THRESHOLD = 70;

  for (const [obsId, obsSeqs] of obsByObs) {
    ports.checkAborted();
    const sourceName = obsSeqs.find(s => s.sourceName)?.sourceName?.toLowerCase().trim() || null;
    if (!sourceName || !OVERRIDEABLE_SOURCES.has(sourceName)) continue;

    // Collect completed, non-flagged sequences for this observation.
    const eligibleSeqIds: string[] = [];
    for (const s of obsSeqs) {
      const r = job.results[s.seqId];
      if (!r || r.status !== "complete") continue;
      if (r.flaggedContaminant || r.flaggedNonTarget) continue;
      eligibleSeqIds.push(s.seqId);
    }
    if (eligibleSeqIds.length === 0) continue;

    // Load full results from DB — job.results only has the reduced summary
    // and does not carry provisionalFinalSpecies/provisionalFinalConfidence.
    const eligibleFullResults = (await ports.loadSavedResults(eligibleSeqIds));
    const eligibleFullMap = new Map(eligibleFullResults.map(r => [r.sampleId, r.resultData as AnalysisResult]));

    type Candidate = {
      seqId: string;
      effectiveSpecies: string | null;
      effectiveConfidence: number | null;
      isManualValidation: boolean;
    };

    const candidates: Candidate[] = [];
    for (const seqId of eligibleSeqIds) {
      const fr = eligibleFullMap.get(seqId);
      if (!fr) continue;
      const isManual = fr.finalSpecies === "Manual Validation Needed";
      candidates.push({
        seqId,
        effectiveSpecies: isManual ? (fr.provisionalFinalSpecies ?? null) : fr.finalSpecies,
        effectiveConfidence: isManual ? (fr.provisionalFinalConfidence ?? null) : fr.finalConfidence,
        isManualValidation: isManual,
      });
    }

    // Skip if any eligible sequence is missing a full DB result or any
    // candidate does not resolve to a species name — the override requires
    // every completed non-flagged sequence in the batch to resolve.
    if (candidates.length !== eligibleSeqIds.length) continue;
    if (!candidates.every(c => c.effectiveSpecies && c.effectiveSpecies.toLowerCase().trim() !== "manual validation needed")) continue;

    const distinctNames = new Set(candidates.map(c => c.effectiveSpecies!.toLowerCase().trim()));
    if (distinctNames.size !== 1) continue;

    const consensusName = candidates[0].effectiveSpecies!;
    const hasHighConf = candidates.some(c => c.effectiveConfidence != null && c.effectiveConfidence >= HIGH_CONF_THRESHOLD);
    if (!hasHighConf) continue;

    const toRestore = candidates.filter(c => c.isManualValidation);
    if (toRestore.length === 0) continue;

    ports.info(`[BatchAnalysis] Job ${jobId}: Obs ${obsId} - Kingdom/Phylum Override (source="${sourceName}"): consensus="${consensusName}", restoring ${toRestore.length} sequence(s) from Manual Validation Needed`);

    for (const c of toRestore) {
      const restoredSpecies = c.effectiveSpecies!;
      const restoredConfidence = c.effectiveConfidence;

      job.results[c.seqId].finalSpecies = restoredSpecies;
      job.results[c.seqId].finalConfidence = restoredConfidence;

      const fullResult = eligibleFullMap.get(c.seqId);
      if (fullResult) {
        fullResult.finalSpecies = restoredSpecies;
        fullResult.finalConfidence = restoredConfidence;
        fullResult.steps.push({
          step: "Kingdom/Phylum Override",
          status: "pass",
          message: `Source is "${sourceName}" and batch consensus "${consensusName}" reached >= ${HIGH_CONF_THRESHOLD}% confidence on at least one sequence — manual validation skipped`,
          details: [
            `Source rank: kingdom/phylum/class (${sourceName})`,
            `Batch consensus across ${candidates.length} sequence(s): "${consensusName}"`,
            `At least one sequence in the batch reached >= ${HIGH_CONF_THRESHOLD}% confidence`,
            `Restored species: ${restoredSpecies}${restoredConfidence != null ? ` (${restoredConfidence}% confidence)` : ""}`,
          ],
        });
        await ports.saveResult(c.seqId, fullResult);
      }
    }
  }

  // ===== NO-BLAST-HITS NON-TARGET DETECTION =====
  // If a sequence had BLAST files but zero hits (or only self-hits),
  // and other sequences for the same observation have good results,
  // flag the empty-BLAST sequence as non-target.
  for (const [obsId, obsSeqs] of obsByObs) {
    ports.checkAborted();
    if (obsSeqs.length < 2) continue;

    const emptyBlastSeqs: Array<{ seqId: string; ricValue: number | null }> = [];
    const goodResultSeqs: Array<{ seqId: string; species: string }> = [];

    for (const s of obsSeqs) {
      const r = job.results[s.seqId];
      if (!r || r.flaggedContaminant || r.flaggedNonTarget) continue;

      const fullResult = (await ports.loadSavedResults([s.seqId]));
      const fullData = fullResult[0]?.resultData as AnalysisResult | undefined;

      if (fullData?.noBlastHits && !r.finalSpecies) {
        emptyBlastSeqs.push({ seqId: s.seqId, ricValue: s.ric });
      } else if (r.status === "complete" && r.finalSpecies && !r.flaggedContaminant && !r.flaggedNonTarget) {
        goodResultSeqs.push({ seqId: s.seqId, species: r.finalSpecies });
      }
    }

    if (emptyBlastSeqs.length === 0 || goodResultSeqs.length === 0) continue;

    ports.info(`[BatchAnalysis] Job ${jobId}: Obs ${obsId} - Empty BLAST non-target detection: ${goodResultSeqs.length} good seq(s) [${goodResultSeqs.map(s => `${s.seqId}:${s.species}`).join(', ')}], ${emptyBlastSeqs.length} empty-BLAST seq(s) [${emptyBlastSeqs.map(s => `${s.seqId}(RiC=${s.ricValue})`).join(', ')}]`);

    for (const eb of emptyBlastSeqs) {
      job.results[eb.seqId].flaggedNonTarget = true;
      job.results[eb.seqId].finalSpecies = "Non-Target: No BLAST hits";
      job.results[eb.seqId].status = "complete";

      const fullResult = (await ports.loadSavedResults([eb.seqId]));
      const fullData = fullResult[0]?.resultData as AnalysisResult | undefined;
      if (fullData) {
        fullData.flaggedNonTarget = true;
        fullData.finalSpecies = "Non-Target: No BLAST hits";
        fullData.steps.push({
          step: "Cross-Sequence Non-Target Detection",
          status: "fail",
          message: `Flagged as non-target: BLAST completed but returned no usable hits, while other sequence(s) for this observation have valid results`,
          details: [
            `This sequence had BLAST results with no hits (or only self-hits)`,
            `Other sequence(s) with valid results: ${goodResultSeqs.map(g => `${g.seqId} (${g.species})`).join(', ')}`,
            `Flagged as non-target - excluded from final determination`,
          ],
        });
        await ports.saveResult(eb.seqId, fullData);
      }

      try {
        if (apiKey) {
          const body = `flags[contaminant]=1`;
          const flagResponse = await ports.postSequenceFlags(eb.seqId, body);
          if (flagResponse.ok) {
            ports.info(`[BatchAnalysis] Job ${jobId}: Auto-flagged sequence ${eb.seqId} as non-target (empty BLAST, obs ${obsId})`);
          }
        }
      } catch (flagError) {
        ports.error(`[BatchAnalysis] Job ${jobId}: Error auto-flagging empty-BLAST non-target ${eb.seqId}:`, flagError);
      }
    }
  }

  // ===== CROSS-SEQUENCE STRAY READ DETECTION =====
  // A read the analysis could not name, on a record at least two of whose other reads name the same
  // species, made with the same primers as those reads and not aligning with them: not the specimen, a
  // contaminant (2026-11-16; sequence 892545). The rule is the validation engine's
  // (strayRead.ts) and the pass is strayReadPass.ts. It runs last, on
  // what the passes above left, and like them only over the reads analysed in this run.
  for (const [obsId, obsSeqs] of obsByObs) {
    ports.checkAborted();
    const reads: RecordReadSummary[] = obsSeqs
      .filter(s => job.results[s.seqId])
      .map(s => ({ id: s.seqId, ...job.results[s.seqId] }));
    const ofRecord = sequencesToAnalyze.filter(candidate => candidate.observationId === obsId);
    const flags = await flagStrayReads(reads, {
      // Each read's primers: its own, else those of its lab well (read once per record, and only when asked).
      ampliconOf: ports.strayReadAmpliconOf(obsId, ofRecord),
      loadHits: (sequenceId) => ports.strayReadHits(sequenceId, ofRecord),
      saveFlag: async (flag) => {
        const [row] = (await ports.loadSavedResults([flag.sequenceId]));
        const fullResult = row?.resultData as AnalysisResult | undefined;
        if (!fullResult) throw new Error("the saved analysis could not be read");
        fullResult.flaggedContaminant = true;
        fullResult.barcodeGapNeeded = false;
        fullResult.contaminantLikelyName = flag.likely;
        fullResult.steps.push(flag.step);
        await ports.saveResult(flag.sequenceId, fullResult);
      },
      flagSequence: async (sequenceId) => {
        if (!apiKey) return;
        const flagResponse = await ports.postSequenceFlags(sequenceId, `flags[contaminant]=1`);
        if (!flagResponse.ok) throw new Error(`the sequence's flag was refused (${flagResponse.status})`);
      },
      log: (message) => ports.info(`[BatchAnalysis] Job ${jobId}: Obs ${obsId} - ${message}`),
      logError: (message, error) => ports.error(`[BatchAnalysis] Job ${jobId}: Obs ${obsId} - ${message}:`, error),
    });
    for (const flag of flags) {
      job.results[flag.sequenceId].flaggedContaminant = true;
      job.results[flag.sequenceId].barcodeGapNeeded = false;
      job.results[flag.sequenceId].contaminantLikelyName = flag.likely;
    }
  }
}
