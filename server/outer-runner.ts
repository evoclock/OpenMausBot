import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { join } from "node:path";
import { RunContractStore, type RunContractInput, type RunSnapshot } from "./run-contract.ts";
import { openLoopLedger, type IterationEntry, type IterationContextCompactor } from "./loop-ledger.ts";

export type InnerLoopResult =
  | { kind: "progress"; evidence: string[]; costUsd?: number | null }
  | { kind: "verified"; evidence: string[]; costUsd?: number | null }
  | { kind: "blocked"; evidence: string[]; costUsd?: number | null };

export interface InnerLoop {
  invoke(contract: RunContractInput, iteration: number, requestId: string, signal: AbortSignal,
    remainingUsd?: number, context?: { iteration: number; previous?: IterationEntry; compactor?: IterationContextCompactor }): Promise<InnerLoopResult>;
}

const terminalStates = new Set(["done", "failed", "cancelled", "blocked"]);

export async function openOuterRunner(dataDir: string, inner: InnerLoop, options: {
  onTerminal?: (snapshot: RunSnapshot) => boolean | void;
  contextCompactor?: IterationContextCompactor;
} = {}) {
  const store = new RunContractStore(join(dataDir, "runtime.db"));
  const ledger = openLoopLedger(join(dataDir, "runtime.db"));
  const reportPending = () => {
    if (!options.onTerminal) return;
    for (const snapshot of store.pendingReports()) {
      if (options.onTerminal(snapshot) !== false) store.markReported(snapshot.contract.id);
    }
  };
  const transition = (id: string, next: Parameters<RunContractStore["transition"]>[1], at: number, evidence: string[] = []) => {
    const snapshot = store.transition(id, next, at, evidence);
    if (terminalStates.has(snapshot.state)) reportPending();
    return snapshot;
  };
  const Task = defineTask<{ id: string }, { phase: "iterate"; sequence: number }, string>({
    name: "openmausbot.outer-run",
    version: 1,
    initial: () => ({ phase: "iterate", sequence: 0 }),
    phases: {
      iterate: async (task, runtime, context) => {
        const snapshot = store.get(task.input.id);
        if (!snapshot) throw new Error("run contract missing");
        if (snapshot.state === "running") {
          const receipt = store.step(task.input.id, snapshot.iteration);
          transition(task.input.id, "blocked", Math.max(Date.now(), snapshot.updatedAt + 1),
            [receipt?.status === "prepared" ? `unknown outward effect ${receipt.requestId}; owner review required`
              : "interrupted iteration has no effect receipt; owner review required"]);
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "blocked" } }), context);
          return;
        }
        if (snapshot.state === "waiting" && snapshot.iteration === task.state.checkpoint.sequence + 1) {
          const finished = store.step(task.input.id, snapshot.iteration);
          if (finished?.status === "finished" && finished.result?.state === "waiting") {
            await runtime.commit(() => ({ status: "running", checkpoint: {
              phase: "iterate", sequence: snapshot.iteration,
            } }), context);
            return;
          }
        }
        if (snapshot.state !== "queued" && snapshot.state !== "waiting") {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: snapshot.state } }), context);
          return;
        }
        if (snapshot.iteration !== task.state.checkpoint.sequence) {
          transition(task.input.id, "blocked", Math.max(Date.now(), snapshot.updatedAt + 1),
            ["iteration result persisted without matching durable checkpoint; reconcile outward effects"]);
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "blocked" } }), context);
          return;
        }
        const limits = snapshot.contract.limits;
        const elapsed = snapshot.startedAt ? Math.max(snapshot.elapsedMs, Date.now() - snapshot.startedAt) : snapshot.elapsedMs;
        const reason = !limits ? "coding run refused: configure this bot's wall-clock and spend ceilings"
          : !snapshot.startedAt ? "coding run start time is uncertain; owner review required"
            : snapshot.spendUncertain ? "coding run spend is uncertain; owner review required"
            : elapsed >= limits.maxWallTimeMs ? `wall-clock ceiling reached (${limits.maxWallTimeMs} ms)`
              : snapshot.spentUsd >= limits.maxSpendUsd ? `spend ceiling reached (${limits.maxSpendUsd} USD)`
                : snapshot.iteration >= snapshot.contract.maxIterations ? "iteration ceiling reached; owner review required" : null;
        if (reason) {
          transition(task.input.id, "blocked", Math.max(Date.now(), snapshot.updatedAt + 1), [reason]);
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "blocked" } }), context);
          return;
        }
        const previous = ledger.previous(task.input.id, snapshot.iteration + 1);
        if (snapshot.iteration > 0 && !previous) {
          transition(task.input.id, "blocked", Math.max(Date.now(), snapshot.updatedAt + 1),
            ["previous iteration receipt is missing; owner review required"]);
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "blocked" } }), context);
          return;
        }
        const requestId = `${snapshot.contract.id}:${snapshot.iteration + 1}`;
        const current = store.beginIteration(task.input.id, snapshot.iteration, requestId,
          Math.max(Date.now(), snapshot.updatedAt + 1));
        const remaining = current.contract.limits!.maxWallTimeMs - Math.max(current.elapsedMs, Date.now() - current.startedAt!);
        if (remaining <= 0) {
          store.finishIteration(task.input.id, current.iteration, requestId, "blocked",
            Math.max(Date.now(), current.updatedAt + 1),
            [`wall-clock ceiling reached (${current.contract.limits!.maxWallTimeMs} ms)`], 0);
          reportPending();
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "blocked" } }), context);
          return;
        }
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), remaining);
        try {
          const result = await inner.invoke(current.contract, current.iteration, requestId,
            AbortSignal.any([runtime.signal, deadline.signal]), current.contract.limits!.maxSpendUsd - current.spentUsd,
            { iteration: current.iteration, previous, compactor: options.contextCompactor });
          const at = Math.max(Date.now(), current.updatedAt + 1);
          const costUsd = result.costUsd ?? null;
          const reasons = [
            Math.max(current.elapsedMs, at - current.startedAt!) >= current.contract.limits!.maxWallTimeMs
              ? `wall-clock ceiling reached (${current.contract.limits!.maxWallTimeMs} ms)` : null,
            costUsd === null || !Number.isFinite(costUsd) || costUsd < 0
              ? "coding run spend is uncertain; owner review required" : null,
            costUsd !== null && Number.isFinite(costUsd) && costUsd >= 0 &&
              current.spentUsd + costUsd >= current.contract.limits!.maxSpendUsd
              ? `spend ceiling reached (${current.contract.limits!.maxSpendUsd} USD)` : null,
            result.kind === "progress" && current.iteration >= current.contract.maxIterations
              ? `iteration ceiling reached (${current.contract.maxIterations})` : null,
          ].filter((item): item is string => item !== null);
          const state = reasons.length ? "blocked"
            : result.kind === "verified" && result.evidence.some((item) => item.trim()) ? "done"
              : result.kind === "progress" ? "waiting" : "blocked";
          const finished = store.finishIteration(task.input.id, current.iteration, requestId, state, at,
            [...result.evidence, ...reasons], costUsd !== null && Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null);
          if (terminalStates.has(finished.state)) reportPending();
          if (state === "waiting") {
            await runtime.commit(() => ({ status: "running", checkpoint: {
              phase: "iterate", sequence: task.state.checkpoint.sequence + 1,
            } }), context);
          } else {
            await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: state } }), context);
          }
        } catch (error) {
          const latest = store.get(task.input.id);
          if (latest?.state === "running") {
            transition(task.input.id, "blocked", Math.max(Date.now(), latest.updatedAt + 1),
              [deadline.signal.aborted ? `wall-clock ceiling reached (${current.contract.limits!.maxWallTimeMs} ms)`
                : error instanceof Error ? error.message : "inner loop failed"]);
          }
          if (!deadline.signal.aborted) throw error;
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "blocked" } }), context);
        } finally { clearTimeout(timer); }
      },
    },
    abort: async (task, runtime, context) => {
      const snapshot = store.get(task.input.id);
      if (snapshot && !["done", "failed", "cancelled"].includes(snapshot.state)) {
        const receipt = snapshot.state === "running" ? store.step(task.input.id, snapshot.iteration) : undefined;
        transition(task.input.id, snapshot.state === "running" ? "blocked" : "cancelled",
          Math.max(Date.now(), snapshot.updatedAt + 1),
          [receipt?.status === "prepared" ? `unknown outward effect ${receipt.requestId}; owner review required` : "run stopped"]);
      }
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "openmausbot.outer-run", tasks: [Task] }));
  const harness = await Harness.open(await openNodeSqliteStorage(join(dataDir, "coding-runs.sqlite")),
    { models: createModels(), registry }, BACKGROUND_CONTEXT);
  const findTask = async (id: string): Promise<TaskId<string> | undefined> => {
    const matches = (await harness.inspect(BACKGROUND_CONTEXT)).tasks.filter((item) =>
      item.record.kind === "openmausbot.outer-run" && (item.record.input as { id?: string }).id === id);
    if (matches.length > 1) throw new Error("multiple durable tasks share a coding run");
    return matches[0]?.record.id as TaskId<string> | undefined;
  };
  const startOne = async (snapshot: RunSnapshot): Promise<TaskId<string>> => {
    const existing = await findTask(snapshot.contract.id);
    if (existing) {
      store.bindTask(snapshot.contract.id, existing);
      harness.resume();
      return existing;
    }
    const recorded = store.taskId(snapshot.contract.id);
    if (recorded) {
      const task = await harness.getTask(recorded as TaskId<string>, BACKGROUND_CONTEXT);
      if (task?.kind !== "openmausbot.outer-run" || (task.input as { id?: string }).id !== snapshot.contract.id) {
        throw new Error("recorded run task identity requires reconciliation");
      }
      return recorded as TaskId<string>;
    }
    if (snapshot.state !== "queued") throw new Error("run task identity requires reconciliation");
    const root = await harness.root(BACKGROUND_CONTEXT);
    const id = await root.commit((tx) => tx.createTask(Task, { id: snapshot.contract.id },
      { ownership: { kind: "conversation" } }), BACKGROUND_CONTEXT);
    store.bindTask(snapshot.contract.id, id);
    harness.resume();
    return id;
  };
  const starting = new Map<string, Promise<TaskId<string>>>();
  const start = (contract: RunContractInput): Promise<TaskId<string>> => {
    const snapshot = store.create(contract, Date.now());
    const existing = starting.get(snapshot.contract.id);
    if (existing) return existing;
    const attempt = startOne(snapshot).finally(() => starting.delete(snapshot.contract.id));
    starting.set(snapshot.contract.id, attempt);
    return attempt;
  };
  try {
    reportPending();
    for (const contract of store.queued()) await start(contract);
  } catch (error) {
    await harness.close(BACKGROUND_CONTEXT);
    store.close();
    throw error;
  }
  return {
    start,
    resume() { reportPending(); harness.resume(); },
    async wait(taskId: TaskId<string>) { return harness.waitForTask(taskId, BACKGROUND_CONTEXT); },
    get(id: string) { return store.get(id); },
    report(id: string) { return store.report(id); },
    ledger(id: string) { return ledger.entries(id); },
    reportPending,
    async cancel(id: string) {
      const taskId = store.taskId(id);
      if (!taskId) return "not_found";
      return harness.abortTask(taskId as TaskId<string>, BACKGROUND_CONTEXT);
    },
    async close() { await harness.close(BACKGROUND_CONTEXT); ledger.close(); store.close(); },
  };
}
