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
  onTerminal?: (snapshot: RunSnapshot) => void;
} = {}) {
  const store = new RunContractStore(join(dataDir, "runtime.db"));
  const transition = (id: string, next: Parameters<RunContractStore["transition"]>[1], at: number, evidence: string[] = []) => {
    const snapshot = store.transition(id, next, at, evidence);
    if (terminalStates.has(snapshot.state)) options.onTerminal?.(snapshot);
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
          transition(task.input.id, "blocked", Math.max(Date.now(), snapshot.updatedAt + 1),
            ["interrupted iteration needs effect reconciliation"]);
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "blocked" } }), context);
          return;
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
        const current = transition(task.input.id, "running", Math.max(Date.now(), snapshot.updatedAt + 1));
        try {
          const result = await inner.invoke(current.contract, current.iteration,
            `${current.contract.id}:${current.iteration}`, runtime.signal);
          const state = result.kind === "verified" && result.evidence.some((item) => item.trim()) ? "done"
            : result.kind === "progress" ? "waiting" : "blocked";
          if (state === "waiting" && current.iteration >= current.contract.maxIterations) {
            transition(task.input.id, "blocked", Math.max(Date.now(), current.updatedAt + 1),
              [...result.evidence, `iteration ceiling reached (${current.contract.maxIterations})`]);
            await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "blocked" } }), context);
            return;
          }
          transition(task.input.id, state, Math.max(Date.now(), current.updatedAt + 1), result.evidence);
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
        transition(task.input.id, snapshot.state === "running" ? "blocked" : "cancelled",
          Math.max(Date.now(), snapshot.updatedAt + 1), ["run stopped"]);
      }
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "openmausbot.outer-run", tasks: [Task] }));
  const harness = await Harness.open(await openNodeSqliteStorage(join(dataDir, "coding-runs.sqlite")),
    { models: createModels(), registry }, BACKGROUND_CONTEXT);
  return {
    async start(contract: RunContractInput) {
      const snapshot = store.create(contract, Date.now());
      const root = await harness.root(BACKGROUND_CONTEXT);
      const id = await root.commit((tx) => tx.createTask(Task, { id: snapshot.contract.id },
        { ownership: { kind: "conversation" } }), BACKGROUND_CONTEXT);
      harness.resume();
      return id;
    },
    resume() { harness.resume(); },
    async wait(taskId: TaskId<string>) { return harness.waitForTask(taskId, BACKGROUND_CONTEXT); },
    get(id: string) { return store.get(id); },
    async close() { await harness.close(BACKGROUND_CONTEXT); store.close(); },
  };
}
