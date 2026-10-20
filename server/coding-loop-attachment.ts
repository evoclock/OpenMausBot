import type { RunSnapshot, RunContractStore } from "./run-contract.ts";

/**
 * Event-driven seam between the live routine scheduler and the coding run runtime.
 *
 * The scheduler already emits a run when it marks it running, and the outer runner
 * already reports terminal/blocked transitions via `onTerminal`; this module only
 * correlates the two by the stable run id derived in `run-triggers.ts`. It owns no
 * timer, no poll and no second scheduler: an accepted coding assignment starts the
 * existing outer/driver route, and the first correlated terminal report settles the
 * routine run exactly once. A terminal report with no live correlation is parked
 * evidence, never a reason to start or replay a run.
 *
 * New module (inventory `pipeline_output/codebase_inventory.jsonl` is absent in this
 * lease): no existing module correlates scheduler run-started events to coding-run
 * terminal reports; `run-triggers.ts` covers start dedupe and `outer-runner.ts`
 * covers execution, neither covers this correlation.
 */

export interface CodingRunStart {
  id: string;
  routineId: string;
  botId: string;
  scheduledFor: number;
  triggerSource?: string;
  status: string;
}

export interface CodingRunPort {
  scheduled(run: CodingRunStart): Promise<{ status: "accepted" | "existing" | "ignored"; id?: string }>;
}

export interface CodingLoopHandlers {
  /** The correlated run reached a verified terminal state; settle the routine run as completed. */
  complete(routineRunId: string, evidence: string[]): void;
  /** The correlated run parked on a hold (blocked); surface evidence, never replay. */
  hold(routineRunId: string, evidence: string[]): void;
  /** The correlated run failed or was cancelled, or the start itself was refused. */
  fail(routineRunId: string, message: string): void;
}

// Durable, deliberately non-dispatching boundary. The scheduler has no idempotent
// settlement receipt; invoking its handlers here would turn a crash into a duplicate.
export function attachCodingLoopClaim(port: CodingRunPort & { get(id: string): RunSnapshot | undefined },
  store: RunContractStore) {
  function onTerminal(snapshot: RunSnapshot) {
    return store.claimRoutineTerminal(snapshot.contract.id, snapshot);
  }
  async function runStarted(run: CodingRunStart) {
    const result = await port.scheduled(run);
    if (result.status === "ignored" || !result.id) return result;
    store.linkRoutine(run.id, result.id);
    // Covers a terminal report before the start promise returned, and restart after
    // a coding run became terminal but before its association was recorded.
    const current = port.get(result.id);
    if (current && ["done", "blocked", "failed", "cancelled"].includes(current.state)) onTerminal(current);
    return result;
  }
  return { runStarted, onTerminal };
}

export function attachCodingLoop(port: CodingRunPort, handlers: CodingLoopHandlers) {
  const correlation = new Map<string, string>();
  const parked: RunSnapshot[] = [];

  function onTerminal(snapshot: RunSnapshot) {
    const routineRunId = correlation.get(snapshot.contract.id);
    if (routineRunId === undefined) {
      // Missing or already-consumed correlation: park the report, never start or replay.
      parked.push(snapshot);
      return;
    }
    correlation.delete(snapshot.contract.id);
    if (snapshot.state === "done") {
      handlers.complete(routineRunId, snapshot.evidence);
    } else if (snapshot.state === "blocked") {
      handlers.hold(routineRunId, snapshot.evidence);
    } else {
      handlers.fail(routineRunId, snapshot.evidence.join("; ") || `coding run ${snapshot.state}`);
    }
  }

  async function runStarted(run: CodingRunStart) {
    let result: { status: "accepted" | "existing" | "ignored"; id?: string };
    try {
      result = await port.scheduled(run);
    } catch (error) {
      // Refusal (for example a non-private or externally-authorised template): nothing
      // was started; surface the reason on the routine run instead of retrying.
      handlers.fail(run.id, error instanceof Error ? error.message : String(error));
      return { status: "refused" as const };
    }
    if (result.status === "ignored" || result.id === undefined) return result;
    // A duplicate event returns the same stable id, so the correlation stays single.
    correlation.set(result.id, run.id);
    return result;
  }

  return {
    runStarted,
    onTerminal,
    /** Terminal reports that arrived without a live correlation; evidence only. */
    get parked(): readonly RunSnapshot[] { return parked; },
    get pending(): number { return correlation.size; },
  };
}
