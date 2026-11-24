// What a record still waiting for its BLAST results is told, and the shape of that answer.
// Moved unchanged from mycomap.org's autovalidationNcbiReadiness.ts and
// autovalidationNcbiReadinessCheck.ts, which keep the
// check itself: it asks the record store.
export type NcbiWaitReason =
  | "ncbi_unavailable"
  | "ncbi_queued"
  | "ncbi_searching"
  | "mycoblast_pending"
  | "results_unread"
  | "no_blast_job"
  | "status_unknown";
export type NcbiExemptReason = "excluded" | "local_only" | "ncbi_failed";
export type SequenceReadiness =
  | { id: string; state: "ready" }
  | { id: string; state: "exempt"; why: NcbiExemptReason; detail: string }
  | { id: string; state: "waiting"; why: NcbiWaitReason; detail: string };
export type RecordNcbiReadiness = {
  ready: boolean;
  sequences: SequenceReadiness[];
  waiting: Array<Extract<SequenceReadiness, { state: "waiting" }>>;
  exempt: Array<Extract<SequenceReadiness, { state: "exempt" }>>;
};

/** The skip message a waiting record gets: which sequences, and why each waits. */
export function ncbiWaitMessage(readiness: RecordNcbiReadiness): string {
  const list = readiness.waiting.map((s) => `seq ${s.id}: ${s.detail}`).join("; ");
  return `Waiting for BLAST results on every sequence (${list}). Nothing was validated or rejected; run auto-validate again once they are in.`;
}

export type RecordNcbiReadinessCheck = RecordNcbiReadiness & {
  /** False when the record store's sequence list could not be read; only the run's own sequences were checked. */
  listed: boolean;
};
