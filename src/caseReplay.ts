// Running the analysis from a recorded case alone: every question it asks is
// answered from the case, by ports made here. No server, no network, no
// database, no key. This is how a captured case is replayed, and how anyone
// can check the rules against the published test cases.
//
// Only specimen sequences. An eDNA analysis needs the server's operations and
// is refused.
import { runDeterministicAnalysis, type AnalysisPorts } from "./analysis";
import { AnalysisReplayMiss, stableStringify, type AnalysisCase, type AnalysisCaseCalls } from "./analysisCase";
import { type AnalysisResult } from "./analysisRules";

/** What one analysis was asked, as a case keeps it: no key, and whether each BLAST result existed, not where. */
export interface AnalysisCaseArgs {
  sequenceId: string;
  hasNcbiXml: boolean;
  hasLocalXml: boolean;
  sourceSpeciesName: string | null;
  sourceRic: number | null;
  sourceRank: string | null;
  isOnlySequenceForRecord: boolean | null;
  /** How often the sequence turned up in eDNA samples, when the caller passed it; null otherwise. */
  envBlastReplication: { replicatingSamples: number; replicatingVariants: number; totalSampleRic: number; totalVariantRic: number } | null;
}

export type DeterministicAnalysisCase = AnalysisCase<AnalysisCaseArgs, AnalysisResult>;

/** Where a replay's log lines go; by default nowhere. */
export interface ReplayLogger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const silent: ReplayLogger = { log: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * Ports that answer from a case. Each question is looked up under the door's
 * name and the question as the recording wrote it down; one the case does not
 * hold stops the run with AnalysisReplayMiss. `unused()` lists the recorded
 * answers never asked for: after a change to the rules, that is where the run
 * went a different way.
 */
export function portsFromCase(calls: AnalysisCaseCalls, logger: ReplayLogger = silent): { ports: AnalysisPorts; unused: () => string[] } {
  const answers = new Map<string, Map<string, unknown>>();
  for (const [door, kept] of Object.entries(calls ?? {})) answers.set(door, new Map(kept.map((a) => [a.asked, a.answer])));
  const used = new Set<string>();
  const answer = <T>(door: string, question: unknown): T => {
    const asked = stableStringify(question);
    const kept = answers.get(door);
    if (!kept || !kept.has(asked)) throw new AnalysisReplayMiss(door, asked);
    used.add(`${door}\u0000${asked}`);
    const value = kept.get(asked);
    // A copy, so the analysis changing an answer can't change the case.
    return (value === undefined ? value : JSON.parse(JSON.stringify(value))) as T;
  };
  const ports: AnalysisPorts = {
    recordName: async (name) => answer("recordName", [name]),
    blastEvidence: async (sequenceId) => answer("blastEvidence", [sequenceId]),
    sequenceMetadata: async (accessions) => answer("sequenceMetadata", accessions),
    observationSpecies: async (refs) => answer("observationSpecies", refs),
    genbankMetadata: async (accessions) => answer("genbankMetadata", accessions),
    sourceRank: async (sourceSpeciesName, providedRank) => answer("sourceRank", [sourceSpeciesName, providedRank ?? null]),
    family: async (name, expectedRank) => answer("family", [name, expectedRank ?? null]),
    // A replay keeps nothing.
    saveInterimResult: async () => undefined,
    logger,
    edna: null,
  };
  return {
    ports,
    unused: () => {
      const out: string[] = [];
      for (const [door, kept] of answers) {
        for (const asked of kept.keys()) {
          if (!used.has(`${door}\u0000${asked}`)) out.push(`${door} ${asked.length > 120 ? `${asked.slice(0, 120)}…` : asked}`);
        }
      }
      return out;
    },
  };
}

/**
 * Runs the analysis again from a case alone and returns its result as plain
 * data, with the recorded answers it never asked for.
 */
export async function replayCase(
  recorded: Pick<DeterministicAnalysisCase, "args" | "calls">,
  logger: ReplayLogger = silent,
): Promise<{ result: AnalysisResult; unused: string[] }> {
  const { args } = recorded;
  if (args.sequenceId.startsWith("edna-")) {
    throw new Error(`An eDNA analysis (${args.sequenceId}) cannot be recorded or replayed: its path writes to the database as it goes`);
  }
  const { ports, unused } = portsFromCase(recorded.calls, logger);
  const result = await runDeterministicAnalysis(
    ports,
    args.sequenceId,
    // The analysis only checks that each BLAST result exists; a case never holds where it was.
    args.hasNcbiXml ? "replay:ncbi" : undefined,
    args.hasLocalXml ? "replay:local" : undefined,
    args.sourceSpeciesName,
    args.sourceRic,
    args.sourceRank,
    args.isOnlySequenceForRecord ?? undefined,
    args.envBlastReplication ?? undefined,
  );
  return { result: JSON.parse(JSON.stringify(result)) as AnalysisResult, unused: unused() };
}
