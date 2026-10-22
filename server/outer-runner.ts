import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { join } from "node:path";
import { RunContractStore, type RunContractInput, type RunSnapshot } from "./run-contract.ts";

export type InnerLoopResult =
  | { kind: "progress"; evidence: string[] }
  | { kind: "verified"; evidence: string[] }
  | { kind: "blocked"; evidence: string[] };

export interface InnerLoop {
  invoke(contract: RunContractInput, iteration: number, requestId: string, signal: AbortSignal): Promise<InnerLoopResult>;
}

const terminalStates = new Set(["done", "failed", "cancelled", "blocked"]);

export async function openOuterRunner(dataDir: string, inner: InnerLoop, options: {
  onTerminal?: (snapshot: RunSnapshot) => boolean | void;
} = {}) {
  const store = new RunContractStore(join(dataDir, "runtime.db"));
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
        const requestId = `${snapshot.contract.id}:${snapshot.iteration + 1}`;
        const current = store.beginIteration(task.input.id, snapshot.iteration, requestId,
          Math.max(Date.now(), snapshot.updatedAt + 1));
        try {
          const result = await inner.invoke(current.contract, current.iteration, requestId, runtime.signal);
          const state = result.kind === "verified" && result.evidence.some((item) => item.trim()) ? "done"
            : result.kind === "progress" ? "waiting" : "blocked";
          if (state === "waiting" && current.iteration >= current.contract.maxIterations) {
            store.finishIteration(task.input.id, current.iteration, requestId, "blocked",
              Math.max(Date.now(), current.updatedAt + 1),
              [...result.evidence, `iteration ceiling reached (${current.contract.maxIterations})`]);
            reportPending();
            await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "blocked" } }), context);
            return;
          }
          const finished = store.finishIteration(task.input.id, current.iteration, requestId, state,
            Math.max(Date.now(), current.updatedAt + 1), result.evidence);
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
              [error instanceof Error ? error.message : "inner loop failed"]);
          }
          throw error;
        }
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
  reportPending();
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
    if (recorded) return recorded as TaskId<string>;
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
  for (const contract of store.queued()) await start(contract);
  return {
    start,
    resume() { reportPending(); harness.resume(); },
    async wait(taskId: TaskId<string>) { return harness.waitForTask(taskId, BACKGROUND_CONTEXT); },
    get(id: string) { return store.get(id); },
    report(id: string) { return store.report(id); },
    reportPending,
    async cancel(id: string) {
      const taskId = store.taskId(id);
      if (!taskId) return "not_found";
      return harness.abortTask(taskId as TaskId<string>, BACKGROUND_CONTEXT);
    },
    async close() { await harness.close(BACKGROUND_CONTEXT); store.close(); },
  };
}
