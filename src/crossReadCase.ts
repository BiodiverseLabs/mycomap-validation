/**
 * A CROSS-READ CASE: what the cross-read passes were given for one record,
 * what each of their ports answered, and what they came to. Replaying a case runs the passes
 * (crossReadPasses.ts) again from the case alone, with no network
 * and no database, and must come to the same: the same summary of each read,
 * the same saved analyses, the same flags, the same log lines. It is the check
 * the passes are held to when they move into the validation engine (1.7c) and
 * whenever they change.
 *
 * The passes' ports, by kind:
 *   - questions, answered from the case in the order asked: the saved
 *     analyses (loadSavedResults), a read's hits and a read's primers for the
 *     stray-read pass (strayReadHits, and the function strayReadAmpliconOf
 *     makes);
 *   - writes, done nowhere in a replay but written down and compared: a saved
 *     analysis (saveResult) and a sequence's flags in the record store
 *     (postSequenceFlags, whose answer is kept too: the passes read it);
 *   - the log, written down and compared;
 *   - the job's stop (checkAborted), which a replay never asks: a run that
 *     was stopped is not kept.
 * A case never holds where a read's BLAST files are, only whether it has them.
 *
 * Nothing here knows the server: it moves into the engine with the passes.
 */
import { ANALYSIS_CASE_FORMAT, AnalysisReplayMiss, stableStringify, type AnalysisCase, type AnalysisCaseCalls } from "./analysisCase";
import { runCrossReadPasses, type CrossReadPassesInput, type CrossReadPassesPorts, type CrossReadSequence } from "./crossReadPasses";
import type { AnalysisJobResult } from "./analysisJobResult";

/** A read as a case keeps it: whether it has BLAST files, not where they are. */
export type CaseRead = Omit<CrossReadSequence, "localBlastXml" | "ncbiBlastXml"> & { hasLocalXml: boolean; hasNcbiXml: boolean };

export interface CrossReadCaseArgs {
  jobId: string;
  reads: CaseRead[];
  /** The run's summary of each of the record's reads, as the passes were given it. */
  results: Record<string, AnalysisJobResult>;
  canFlagSequences: boolean;
}

export type CrossReadWritePort = "saveResult" | "postSequenceFlags";

export interface CrossReadCaseResult {
  /** The summary of each of the record's reads once the passes were done. */
  results: Record<string, AnalysisJobResult>;
  /** The writes asked for, in order, each as the port and what it was handed (a stable string). */
  effects: Array<{ port: CrossReadWritePort; asked: string }>;
  log: Array<{ to: "info" | "warn" | "error"; line: string }>;
}

export type CrossReadCase = AnalysisCase<CrossReadCaseArgs, CrossReadCaseResult>;

type KeptAnswer = { value: unknown } | { threw: string };

const plain = <T>(value: T): T => (value === undefined ? (null as T) : (JSON.parse(JSON.stringify(value)) as T));

/** A log line as text: an error by its name and message, anything else as it is or as JSON. */
export function logLine(args: unknown[]): string {
  return args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : typeof arg === "string" ? arg : stableStringify(arg))).join(" ");
}

/** What the passes are handed of a record's reads, in what a port is asked: their ids. */
const readIds = (reads: Array<{ id: string }>) => reads.map((read) => String(read.id));

/** A case's read: the read without where its BLAST files are. */
export function caseRead(read: CrossReadSequence): CaseRead {
  const { localBlastXml, ncbiBlastXml, ...rest } = read;
  return { ...plain(rest), hasLocalXml: !!localBlastXml, hasNcbiXml: !!ncbiBlastXml };
}

/**
 * Ports that pass everything on to `live` unchanged and write down what
 * happened. `recorded()` gives what was written down; `incomplete` names the
 * first thing that could not be (then the case is not kept).
 */
export function recordingCrossReadPorts(live: CrossReadPassesPorts): {
  ports: CrossReadPassesPorts;
  recorded(): { calls: AnalysisCaseCalls; effects: CrossReadCaseResult["effects"]; log: CrossReadCaseResult["log"]; incomplete: string | null };
} {
  const calls: AnalysisCaseCalls = {};
  const effects: CrossReadCaseResult["effects"] = [];
  const log: CrossReadCaseResult["log"] = [];
  let incomplete: string | null = null;
  const fail = (what: string, error: unknown) => { incomplete ??= `${what}: ${String((error as any)?.message ?? error)}`; };
  const stable = (what: string, value: unknown): string => {
    try {
      return stableStringify(value);
    } catch (error) {
      fail(what, error);
      return "";
    }
  };
  const keep = (port: string, asked: string, answer: KeptAnswer) => { (calls[port] ??= []).push({ asked, answer }); };
  const keepValue = (port: string, asked: string, value: unknown) => {
    try {
      keep(port, asked, { value: plain(value) });
    } catch (error) {
      fail(`${port} answer`, error);
      keep(port, asked, { value: null });
    }
  };
  /** Asks `live`, and keeps its answer or that it threw. */
  async function ask<T>(port: string, asked: string, call: () => Promise<T>): Promise<T> {
    let value: T;
    try {
      value = await call();
    } catch (error) {
      keep(port, asked, { threw: String((error as any)?.message ?? error) });
      throw error;
    }
    keepValue(port, asked, value);
    return value;
  }

  const ports: CrossReadPassesPorts = {
    // Passed on; a run that was stopped is not kept.
    checkAborted: () => live.checkAborted(),
    loadSavedResults: (ids) => ask("loadSavedResults", stable("loadSavedResults question", [ids]), () => live.loadSavedResults(ids)),
    strayReadHits: (sequenceId, recordReads) =>
      ask("strayReadHits", stable("strayReadHits question", [sequenceId, readIds(recordReads)]), () => live.strayReadHits(sequenceId, recordReads)),
    strayReadAmpliconOf: (obsId, recordReads) => {
      const inner = live.strayReadAmpliconOf(obsId, recordReads);
      return (sequenceId) => ask("strayReadAmplicon", stable("strayReadAmplicon question", [obsId, sequenceId]), () => inner(sequenceId));
    },
    saveResult: async (sequenceId, result) => {
      // Written down as it was handed, before anything else can change it.
      effects.push({ port: "saveResult", asked: stable("saveResult", [sequenceId, result]) });
      return live.saveResult(sequenceId, result);
    },
    postSequenceFlags: async (sequenceId, body) => {
      const asked = stable("postSequenceFlags", [sequenceId, body]);
      effects.push({ port: "postSequenceFlags", asked });
      let answer: { ok: boolean; status: number; text: string };
      try {
        const response = await live.postSequenceFlags(sequenceId, body);
        // Its text is read now, so the case holds it whether or not the passes ask for it.
        answer = { ok: response.ok, status: response.status, text: await response.text().catch(() => "") };
      } catch (error) {
        keep("postSequenceFlags", asked, { threw: String((error as any)?.message ?? error) });
        throw error;
      }
      keepValue("postSequenceFlags", asked, answer);
      return { ok: answer.ok, status: answer.status, text: async () => answer.text };
    },
    info: (...args) => { log.push({ to: "info", line: logLine(args) }); live.info(...args); },
    warn: (...args) => { log.push({ to: "warn", line: logLine(args) }); live.warn(...args); },
    error: (...args) => { log.push({ to: "error", line: logLine(args) }); live.error(...args); },
  };
  return { ports, recorded: () => ({ calls, effects, log, incomplete }) };
}

/**
 * Ports that answer from a case. A question is answered with the next kept
 * answer of its port; one the case does not hold, or asked differently, stops
 * the run with AnalysisReplayMiss. A write is done nowhere but written down
 * (and the flags' kept answer given back). `unused()` lists the kept answers
 * never asked for.
 */
export function portsFromCrossReadCase(calls: AnalysisCaseCalls): {
  ports: CrossReadPassesPorts;
  effects(): CrossReadCaseResult["effects"];
  log(): CrossReadCaseResult["log"];
  unused(): string[];
} {
  const next = new Map<string, number>();
  const effects: CrossReadCaseResult["effects"] = [];
  const log: CrossReadCaseResult["log"] = [];
  const answer = (port: string, asked: string): unknown => {
    const at = next.get(port) ?? 0;
    next.set(port, at + 1);
    const kept = (calls?.[port] ?? [])[at] as { asked: string; answer: KeptAnswer } | undefined;
    if (!kept || kept.asked !== asked) {
      throw new AnalysisReplayMiss(port, kept ? `${asked} (the case holds an answer to ${kept.asked})` : asked);
    }
    if ("threw" in kept.answer) throw new Error(kept.answer.threw);
    // A copy, so the passes changing an answer can't change the case.
    return plain(kept.answer.value);
  };
  const ports: CrossReadPassesPorts = {
    checkAborted: () => {},
    loadSavedResults: async (ids) => answer("loadSavedResults", stableStringify([ids])) as any,
    strayReadHits: async (sequenceId, recordReads) => answer("strayReadHits", stableStringify([sequenceId, readIds(recordReads)])) as any,
    strayReadAmpliconOf: (obsId) => async (sequenceId) => answer("strayReadAmplicon", stableStringify([obsId, sequenceId])) as any,
    saveResult: async (sequenceId, result) => { effects.push({ port: "saveResult", asked: stableStringify([sequenceId, result]) }); },
    postSequenceFlags: async (sequenceId, body) => {
      const asked = stableStringify([sequenceId, body]);
      effects.push({ port: "postSequenceFlags", asked });
      const kept = answer("postSequenceFlags", asked) as { ok: boolean; status: number; text: string };
      return { ok: kept.ok, status: kept.status, text: async () => kept.text };
    },
    info: (...args) => { log.push({ to: "info", line: logLine(args) }); },
    warn: (...args) => { log.push({ to: "warn", line: logLine(args) }); },
    error: (...args) => { log.push({ to: "error", line: logLine(args) }); },
  };
  return {
    ports,
    effects: () => effects,
    log: () => log,
    unused: () => {
      const out: string[] = [];
      for (const [port, kept] of Object.entries(calls ?? {})) {
        for (let at = next.get(port) ?? 0; at < kept.length; at++) {
          const asked = kept[at].asked;
          out.push(`${port} ${asked.length > 120 ? `${asked.slice(0, 120)}…` : asked}`);
        }
      }
      return out;
    },
  };
}

/** The summaries of these reads, as plain data. */
function resultsOf(results: Record<string, AnalysisJobResult>, reads: Array<{ id: string }>): Record<string, AnalysisJobResult> {
  return Object.fromEntries(readIds(reads).filter((id) => results[id] !== undefined).map((id) => [id, plain(results[id])]));
}

/** What a case keeps of the passes' input for one record: its reads (without their files) and their summaries. */
export function crossReadCaseArgs(input: CrossReadPassesInput): CrossReadCaseArgs {
  return { jobId: input.jobId, reads: input.reads.map(caseRead), results: resultsOf(input.results, input.reads), canFlagSequences: input.canFlagSequences };
}

/** The case for one record's passes, from what the recording ports wrote down. */
export function buildCrossReadCase(input: {
  args: CrossReadCaseArgs;
  /** The run's summaries once the passes were done (only the record's reads are kept). */
  resultsAfter: Record<string, AnalysisJobResult>;
  recorded: ReturnType<ReturnType<typeof recordingCrossReadPorts>["recorded"]>;
  rulesVersion: string;
  capturedAt: string;
}): CrossReadCase {
  return {
    format: ANALYSIS_CASE_FORMAT,
    capturedAt: input.capturedAt,
    rulesVersion: input.rulesVersion,
    args: input.args,
    calls: input.recorded.calls,
    result: { results: resultsOf(input.resultsAfter, input.args.reads), effects: input.recorded.effects, log: input.recorded.log },
  };
}

/**
 * Runs the passes again for one record from a case alone and returns what
 * they came to, as plain data, with the kept answers they never asked for.
 * `run` is the passes to run (the ones in use unless a test hands in others).
 */
export async function replayCrossReadCase(
  recorded: Pick<CrossReadCase, "args" | "calls">,
  run: (input: CrossReadPassesInput, ports: CrossReadPassesPorts) => Promise<void> = runCrossReadPasses,
): Promise<{ result: CrossReadCaseResult; unused: string[] }> {
  const { ports, effects, log, unused } = portsFromCrossReadCase(recorded.calls);
  const args = plain(recorded.args);
  const results = args.results;
  // The read as the passes see it: where its files are is not needed, nothing is read.
  const reads = args.reads.map(({ hasLocalXml: _hasLocal, hasNcbiXml: _hasNcbi, ...read }) => read as CrossReadSequence);
  await run({ jobId: args.jobId, results, reads, canFlagSequences: args.canFlagSequences }, ports);
  return { result: { results: resultsOf(results, reads), effects: effects(), log: log() }, unused: unused() };
}
