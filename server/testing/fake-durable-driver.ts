import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstalledWorkerDriver } from "../driver-run-api.ts";
export const DURABLE_DRIVER_PROTOCOL = "agentic-driver.run.v1" as const;

type Step = { id: string; requestKey: string; state: "pending" | "intent" | "held" | "finished"; intentOwner?: string;
  receipt?: { reference: string } };
type Run = { state: "active" | "held" | "finished" | "cancelled"; steps: Step[] };
type Database = { runs: Record<string, Run> };

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function readDatabase(path: string): Database {
  try { return JSON.parse(readFileSync(path, "utf8")) as Database; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { runs: {} };
    throw error;
  }
}

export async function openDurableDriver(options: { directory: string }): Promise<InstalledWorkerDriver> {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const statePath = join(options.directory, "test-driver.json");
  const owner = randomUUID();
  const database = readDatabase(statePath);
  const inFlight = new Set<string>();
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error("test driver is closed"); };
  const persist = () => {
    const temporary = `${statePath}.${owner}.tmp`;
    writeFileSync(temporary, JSON.stringify(database), { mode: 0o600 });
    renameSync(temporary, statePath);
  };

  return {
    async status(runId) {
      assertOpen();
      const run = database.runs[runId];
      return run ? clone(run) : null;
    },
    async resume(runId) {
      assertOpen();
      const run = database.runs[runId];
      if (!run) throw new Error("unknown test driver run");
      const step = run.steps.find((item) => item.state !== "finished");
      if (step?.state === "intent" && step.intentOwner !== owner) {
        step.state = "held";
        run.state = "held";
        persist();
      } else if (step?.state === "pending") {
        step.state = "intent";
        step.intentOwner = owner;
        persist();
      }
      return clone(run);
    },
    async reconcile(runId, evidence) {
      assertOpen();
      const run = database.runs[runId];
      const step = run?.steps.find((item) => item.id === evidence.stepId);
      if (!run || !step || step.requestKey !== evidence.requestKey) throw new Error("test driver identity mismatch");
      if (!evidence.verified || !evidence.reference) {
        step.state = "held";
        run.state = "held";
      } else {
        step.state = "finished";
        step.receipt = { reference: evidence.reference };
        run.state = run.steps.every((item) => item.state === "finished") ? "finished" : "active";
      }
      persist();
      return clone(run);
    },
    async invokeWorker(input) {
      assertOpen();
      const runId = hash(`worker:${input.requestId}`);
      const stepId = `worker_${hash(JSON.stringify([input.requestId, input.goal]))}`;
      if (inFlight.has(runId)) throw new Error("test driver invocation is already active");
      inFlight.add(runId);
      try {
        let run = database.runs[runId];
        if (!run) {
          const digest = hash(JSON.stringify({ runId, steps: [{ id: stepId, kind: "external" }] }));
          run = { state: "active", steps: [{ id: stepId,
            requestKey: hash(`${runId}:${stepId}:${digest}`), state: "pending" }] };
          database.runs[runId] = run;
          persist();
        }
        const step = run.steps[0];
        if (!step || step.id !== stepId) throw new Error("test driver invocation identity changed");
        if (run.state === "finished") return { runId, state: "finished", step: clone(step) };
        if (run.state === "cancelled") return { runId, state: "cancelled", step: clone(step) };
        if (run.state !== "active" || step.state !== "pending") return { runId, state: "held", step: clone(step) };
        step.state = "intent";
        step.intentOwner = owner;
        persist();
        if (input.signal.aborted) {
          run.state = "cancelled";
          persist();
          return { runId, state: "cancelled", step: clone(step) };
        }
        const outcome = await input.transport.invoke();
        if (input.signal.aborted) {
          run.state = "cancelled";
          persist();
          return { runId, state: "cancelled", step: clone(step) };
        }
        if (outcome.verified !== true || typeof outcome.reference !== "string" || !outcome.reference) {
          throw new Error("test driver transport returned no verified receipt");
        }
        step.state = "finished";
        step.receipt = { reference: outcome.reference };
        run.state = "finished";
        persist();
        return { runId, state: "finished", result: outcome.result };
      } finally { inFlight.delete(runId); }
    },
    async close() {
      if (inFlight.size) throw new Error("test driver has active invocations");
      persist();
      closed = true;
    },
  };
}
