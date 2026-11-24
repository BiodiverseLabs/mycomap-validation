/**
 * A RECORD CASE: everything one record's auto-validation decision was given,
 * what each of its ports answered, and what it decided. Replaying a case runs the decision (recordDecision.ts)
 * again from the case alone, with no network and no database, and must give
 * the same decision. It is the check the record rules were held to when they
 * moved into this package and are held to whenever they change.
 *
 * The decision asks through ports (recordDecision.ts RecordDecisionPorts).
 * Three kinds:
 *   - questions: their answers are kept, call by call, in the order asked
 *     (a question may be asked twice and answered differently, so answers are
 *     kept in order per port, not by the question);
 *   - writes (the waiting list, the Vision events, the hold): a replay does
 *     not do them; what the decision asked them to write is kept and compared;
 *   - log lines: kept and compared too. The decision reads no clock, so the
 *     same answers give the same lines.
 * A port that threw is kept as having thrown, and throws the same in a replay.
 *
 * Nothing here knows the server. Capturing cases on mycomap.org is
 * mycomap.org's recordCaseCapture.ts.
 */
import { ANALYSIS_CASE_FORMAT, type AnalysisCase, type AnalysisCaseCalls, AnalysisReplayMiss, stableStringify } from "./analysisCase";
import { type RecordDecision, type RecordDecisionInput, type RecordDecisionPorts, decideRecord } from "./recordDecision";

/** The ports whose answers the decision uses. settleReads also acts (Vision's pick, the trash); a replay only answers. */
export const RECORD_QUESTION_PORTS = [
  "ncbiReadiness", "waitForVision", "settleReads", "visionFoundNoPhotos", "latestVisionAnswer",
  "loadDnaFamily", "loadObserverIdentification", "loadStoredAnalyses", "fetchRic",
] as const;
/** The ports the decision writes through. */
export const RECORD_WRITE_PORTS = ["noteNcbiWait", "clearNcbiWait", "recordVisionEvents", "recordVisionHold"] as const;
const LOG_PORTS = { jobLog: "job", info: "info", warn: "warn" } as const;

export type RecordQuestionPort = (typeof RECORD_QUESTION_PORTS)[number];
export type RecordWritePort = (typeof RECORD_WRITE_PORTS)[number];

/** What a decision came to: its answer, what it wrote, and what it logged. */
export interface RecordCaseResult {
  decision: RecordDecision;
  /** The writes it asked for, in order, each as the port and what it was handed (a stable string). */
  effects: Array<{ port: RecordWritePort; asked: string }>;
  log: Array<{ to: "job" | "info" | "warn"; line: string }>;
}

export type RecordCase = AnalysisCase<RecordDecisionInput, RecordCaseResult>;

/** A kept answer: what the port returned, or that it threw. */
type KeptAnswer = { value: unknown } | { threw: string };

const plain = <T>(value: T): T => (value === undefined ? (null as T) : (JSON.parse(JSON.stringify(value)) as T));

/**
 * Ports that pass everything on to `live` unchanged and write down what
 * happened. `recorded()` gives what was written down; `incomplete` names the
 * first thing that could not be (then the case is not kept).
 */
export function recordingPorts(live: RecordDecisionPorts): {
  ports: RecordDecisionPorts;
  recorded(): { calls: AnalysisCaseCalls; effects: RecordCaseResult["effects"]; log: RecordCaseResult["log"]; incomplete: string | null };
} {
  const calls: AnalysisCaseCalls = {};
  const effects: RecordCaseResult["effects"] = [];
  const log: RecordCaseResult["log"] = [];
  let incomplete: string | null = null;
  const fail = (what: string, error: unknown) => { incomplete ??= `${what}: ${String((error as any)?.message ?? error)}`; };

  const wrap = (port: RecordQuestionPort | RecordWritePort, isWrite: boolean) => async (...args: unknown[]) => {
    // Written down before the call: what it was asked, as it was at that moment.
    let asked = "";
    try {
      asked = stableStringify(args);
    } catch (error) {
      fail(`${port} question`, error);
    }
    if (isWrite) effects.push({ port: port as RecordWritePort, asked });
    const keep = (answer: KeptAnswer) => { (calls[port] ??= []).push({ asked, answer }); };
    let value: unknown;
    try {
      value = await (live[port] as (...a: unknown[]) => Promise<unknown>)(...args);
    } catch (error) {
      keep({ threw: String((error as any)?.message ?? error) });
      throw error;
    }
    // A copy taken now: the decision may go on to change what it was handed.
    try {
      keep({ value: plain(value) });
    } catch (error) {
      fail(`${port} answer`, error);
      keep({ value: null });
    }
    return value;
  };

  const ports = { ...live } as Record<string, unknown>;
  for (const port of RECORD_QUESTION_PORTS) ports[port] = wrap(port, false);
  for (const port of RECORD_WRITE_PORTS) ports[port] = wrap(port, true);
  for (const [port, to] of Object.entries(LOG_PORTS) as Array<[keyof typeof LOG_PORTS, RecordCaseResult["log"][number]["to"]]>) {
    ports[port] = (line: string) => {
      log.push({ to, line: String(line) });
      live[port](line);
    };
  }
  return {
    ports: ports as unknown as RecordDecisionPorts,
    recorded: () => ({ calls, effects, log, incomplete }),
  };
}

/**
 * Ports that answer from a case. A question is answered with the next kept
 * answer of its port; asking one the case does not hold, or asking it
 * differently, stops the run with AnalysisReplayMiss. A write does nothing but
 * is written down, and throws when the kept one threw. `unused()` lists the
 * kept answers never asked for: after a change to the rules, that is where the
 * run went a different way.
 */
export function portsFromRecordCase(calls: AnalysisCaseCalls): {
  ports: RecordDecisionPorts;
  effects(): RecordCaseResult["effects"];
  log(): RecordCaseResult["log"];
  unused(): string[];
} {
  const next = new Map<string, number>();
  const effects: RecordCaseResult["effects"] = [];
  const log: RecordCaseResult["log"] = [];

  const answer = (port: RecordQuestionPort | RecordWritePort, isWrite: boolean) => async (...args: unknown[]) => {
    const asked = stableStringify(args);
    if (isWrite) effects.push({ port: port as RecordWritePort, asked });
    const at = next.get(port) ?? 0;
    next.set(port, at + 1);
    const kept = (calls?.[port] ?? [])[at] as { asked: string; answer: KeptAnswer } | undefined;
    if (!kept || kept.asked !== asked) {
      // A write the case does not hold shows up in the comparison of what was written.
      if (isWrite) return undefined;
      throw new AnalysisReplayMiss(port, kept ? `${asked} (the case holds an answer to ${kept.asked})` : asked);
    }
    if ("threw" in kept.answer) throw new Error(kept.answer.threw);
    if (isWrite) return undefined;
    // A copy, so the decision changing an answer can't change the case.
    return plain(kept.answer.value);
  };

  const ports: Record<string, unknown> = {};
  for (const port of RECORD_QUESTION_PORTS) ports[port] = answer(port, false);
  for (const port of RECORD_WRITE_PORTS) ports[port] = answer(port, true);
  for (const [port, to] of Object.entries(LOG_PORTS) as Array<[keyof typeof LOG_PORTS, RecordCaseResult["log"][number]["to"]]>) {
    ports[port] = (line: string) => { log.push({ to, line: String(line) }); };
  }
  return {
    ports: ports as unknown as RecordDecisionPorts,
    effects: () => effects,
    log: () => log,
    unused: () => {
      const out: string[] = [];
      for (const port of RECORD_QUESTION_PORTS) {
        const kept = calls?.[port] ?? [];
        for (let at = next.get(port) ?? 0; at < kept.length; at++) {
          const asked = kept[at].asked;
          out.push(`${port} ${asked.length > 120 ? `${asked.slice(0, 120)}…` : asked}`);
        }
      }
      return out;
    },
  };
}

/** The case for one decision, from what the recording ports wrote down. */
export function buildRecordCase(input: {
  args: RecordDecisionInput;
  decision: RecordDecision;
  recorded: ReturnType<ReturnType<typeof recordingPorts>["recorded"]>;
  rulesVersion: string;
  capturedAt: string;
}): RecordCase {
  return {
    format: ANALYSIS_CASE_FORMAT,
    capturedAt: input.capturedAt,
    rulesVersion: input.rulesVersion,
    args: input.args,
    calls: input.recorded.calls,
    result: { decision: plain(input.decision), effects: input.recorded.effects, log: input.recorded.log },
  };
}

/**
 * Decides the record again from a case alone and returns what it came to, as
 * plain data, with the kept answers it never asked for. `decide` is the
 * decision to run (the one in use unless a test hands in another).
 */
export async function replayRecordCase(
  recorded: Pick<RecordCase, "args" | "calls">,
  decide: (input: RecordDecisionInput, ports: RecordDecisionPorts) => Promise<RecordDecision> = decideRecord,
): Promise<{ result: RecordCaseResult; unused: string[] }> {
  const { ports, effects, log, unused } = portsFromRecordCase(recorded.calls);
  const decision = await decide(plain(recorded.args), ports);
  return { result: { decision: plain(decision), effects: effects(), log: log() }, unused: unused() };
}
