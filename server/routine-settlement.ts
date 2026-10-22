import { createHash } from "node:crypto";
import type { GroupGoalRunStatus } from "../shared/group-goal-run.ts";
import { redactSecretsInText } from "./redact.ts";
import { runSnapshotSchema, type RunSnapshot } from "./run-contract.ts";
import type { RoutineRun } from "./routines.ts";

export interface CodingSettlementReceipt {
  status: "APPLIED";
  routineRunId: string;
  codingRunId: string;
  terminalHash: string;
  disposition: "completed" | "held" | "failed" | "cancelled";
  appliedAt: number;
}

export function applyCodingSettlement(options: {
  routineRunId: string;
  terminal: RunSnapshot;
  runs: RoutineRun[];
  receipts: CodingSettlementReceipt[];
  now: () => number;
  commit: (mutate: () => void) => void;
  notify: (run: RoutineRun) => void;
}): { status: "applied" | "existing"; receipt: CodingSettlementReceipt } {
  const { routineRunId, runs, receipts, now, commit, notify } = options;
  const snapshot = runSnapshotSchema.parse(options.terminal);
  const codingRunId = snapshot.contract.id;
  if (!["done", "blocked", "failed", "cancelled"].includes(snapshot.state)) throw new Error("coding run is not terminal");
  const terminalHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  const existing = receipts.find((receipt) => receipt.routineRunId === routineRunId || receipt.codingRunId === codingRunId);
  if (existing) {
    if (existing.routineRunId !== routineRunId || existing.codingRunId !== codingRunId || existing.terminalHash !== terminalHash) {
      throw new Error("conflicting coding settlement");
    }
    return { status: "existing", receipt: { ...existing } };
  }
  const run = runs.find((candidate) => candidate.id === routineRunId);
  if (!run || !["queued", "running", "waiting"].includes(run.status)) throw new Error("routine run is not open");
  const disposition = snapshot.state === "done" ? "completed" : snapshot.state === "blocked" ? "held"
    : snapshot.state === "cancelled" ? "cancelled" : "failed";
  const receipt: CodingSettlementReceipt = { status: "APPLIED", routineRunId, codingRunId, terminalHash, disposition, appliedAt: now() };
  commit(() => {
    run.status = disposition === "held" ? "failed" : disposition;
    run.finishedAt = now();
    run.output = redactSecretsInText(snapshot.evidence.join("; ")).trim().slice(0, 2_000);
    if (disposition === "held") run.error = "Coding run needs reconciliation";
    receipts.push(receipt);
  });
  notify(run);
  return { status: "applied", receipt: { ...receipt } };
}

export function finishGoalRun(port: {
  runs: readonly RoutineRun[];
  now(): number;
  clone(run: RoutineRun): RoutineRun;
  fail(run: RoutineRun, detail: string): void;
  wait(run: RoutineRun, detail: string): void;
  save(): void;
  emit(run: RoutineRun): void;
  tick(): Promise<void>;
}, runId: string, status: GroupGoalRunStatus, detail: string): RoutineRun | null {
  const run = port.runs.find(
    (candidate) => candidate.id === runId &&
      candidate.target === "room-goal" &&
      ["running", "waiting"].includes(candidate.status),
  );
  if (!run || status === "working") return null;
  const safeDetail = redactSecretsInText(detail).trim();
  run.goalStatus = status;
  if (status === "failed" || status === "blocked" || status === "limit-reached") {
    port.fail(
      run,
      safeDetail ||
        (status === "limit-reached" ? "The room goal reached its turn limit" : "The room goal is blocked"),
    );
  } else if (status === "needs-input" || status === "paused") {
    port.wait(run, safeDetail.slice(0, 500) || (status === "paused" ? "The room goal is paused" : "The team needs your input"));
    run.error = undefined;
    port.save();
    port.emit(run);
  } else {
    run.status = status === "stopped" ? "cancelled" : "completed";
    run.attention = undefined;
    run.finishedAt = port.now();
    run.error = undefined;
    if (status !== "stopped") run.output = safeDetail.slice(0, 2_000) || undefined;
    port.save();
    port.emit(run);
  }
  queueMicrotask(() => void port.tick());
  return port.clone(run);
}
