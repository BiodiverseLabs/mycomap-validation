// MycoMap Vision's decision events as the record rules write them: the kinds, the reasons, and
// which Vision answer an event points at. Moved unchanged from
// mycomap.org's visionDecisionEvents.ts, which keeps the table and the writing.

/** Every kind (spec §3). None excludes a record now (§2). */
export const VISION_DECISION_KINDS = [
  // Vision decided the name: these define the sensitivity row.
  "read_pick",
  "read_set_aside",
  "read_trashed",
  // Vision gated.
  "agreement_validated",
  "penalty_lift",
  "second_source_vision",
  "second_source_observer",
  // Sent to a person: these feed the person-queue rule (§2).
  "hold",
  "flagged_read_to_person",
  "skipped_for_person",
  // Other.
  "observer_over_vision",
  "vision_no_answer",
  "vision_checked_no_effect",
  // Model-guided review (PLAN E19d).
  "model_guided_review",
  "model_guided_change",
  // People validating with Vision's answer on screen (lower bound) or available (upper bound).
  "vision_shown_at_manual_validation",
  "vision_available_at_manual_validation",
] as const;

export type VisionDecisionKind = typeof VISION_DECISION_KINDS[number];

/**
 * The closed list of reasons, by kind. A reason says why the event happened,
 * never what Vision said. Kinds missing here take no reason.
 */
export const VISION_DECISION_REASONS = {
  hold: ["genus_veto", "no_second_source"],
  vision_no_answer: ["waiting", "no_usable_photos"],
  skipped_for_person: ["no_read_pick", "below_threshold_not_lifted"],
  model_guided_review: ["in_test_window"],
  model_guided_change: ["sequence_moved", "sequence_trashed", "sequence_restored", "label_change", "validation_change"],
  vision_shown_at_manual_validation: ["on_screen", "opened"],
} as const satisfies Partial<Record<VisionDecisionKind, readonly string[]>>;

export type VisionDecisionReason = typeof VISION_DECISION_REASONS[keyof typeof VISION_DECISION_REASONS][number];

/** Every code path that writes events. */
export const VISION_DECISION_SOURCES = [
  "auto_validate",
  "trash_runner",
  "trash_backfill",
  "error_scan",
  "swap_analyze",
  "manual_validation",
  "fungai_method2",
] as const;

export type VisionDecisionSource = typeof VISION_DECISION_SOURCES[number];

/** The Vision answer an event read: ids and versions only. */
export interface VisionRef {
  runId: number | null;
  modelVersion: string | null;
  answersVersion: string | null;
}

export interface VisionDecisionEventInput {
  platform: string;
  observationId: string;
  kind: VisionDecisionKind;
  reason?: VisionDecisionReason | null;
  source: VisionDecisionSource;
  jobId?: string | null;
  projectId?: number | null;
  sequenceIds?: Array<string | number>;
  vision?: VisionRef | null;
  actorUserId?: string | null;
  occurredAt?: Date;
  /**
   * What makes two writes the same event. Defaults to the job id; without a
   * job (a person's click), every write is its own event.
   */
  dedupeScope?: string | null;
}

/** A version string as Vision reports it; anything long or multi-line is not a version. */
function versionOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && s.length <= 120 && !/\s/.test(s) ? s : null;
}

function runIdOf(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Vision's run id and versions from any answer shape mycomap.org passes around. */
export function visionRefOf(v: { runId?: unknown; modelVersion?: unknown; answersVersion?: unknown } | null | undefined): VisionRef | null {
  if (!v) return null;
  const ref = { runId: runIdOf(v.runId), modelVersion: versionOf(v.modelVersion), answersVersion: versionOf(v.answersVersion) };
  return ref.runId == null && ref.modelVersion == null && ref.answersVersion == null ? null : ref;
}
