import type { GroupGoalRunStatus } from "../shared/group-goal-run.ts";
import type { RoutineRun } from "./routines.ts";
import { redactSecretsInText } from "./redact.ts";

interface SettlementPort {
  runs: readonly RoutineRun[];
  now(): number;
  emit(run: RoutineRun): void;
  clone(run: RoutineRun): RoutineRun;
  tick(): Promise<void>;
}

interface CodingSettlementPort extends SettlementPort {
  assertWritable(): void;
  commit(mutate: () => void): void;
  failed(run: RoutineRun): void;
}

interface GoalSettlementPort extends SettlementPort {
  fail(run: RoutineRun, detail: string): void;
  wait(run: RoutineRun, detail: string): void;
  save(): void;
}

export function settleCodingRun(port: CodingSettlementPort, runId: string,
  status: "done" | "blocked" | "failed" | "cancelled", detail: string): RoutineRun | null {
  const run = port.runs.find((candidate) => candidate.id === runId &&
    candidate.target === "bot" && ["schedule", "webhook"].includes(candidate.triggerSource ?? "") &&
    ["queued", "running", "waiting"].includes(candidate.status));
  if (!run) return null;
  port.assertWritable();
  const safeDetail = redactSecretsInText(detail).trim();
  port.commit(() => {
    run.status = status === "done" ? "completed" : status === "cancelled" ? "cancelled" : "failed";
    run.attention = undefined;
    run.finishedAt = port.now();
    if (status === "done") {
      run.output = safeDetail.slice(0, 2_000) || undefined;
      run.error = undefined;
    } else {
      run.error = safeDetail.slice(0, 500) || "Coding run did not complete";
    }
  });
  port.emit(run);
  if (run.status === "failed") port.failed(port.clone(run));
  queueMicrotask(() => void port.tick());
  return port.clone(run);
}

export function finishGoalRun(port: GoalSettlementPort, runId: string,
  status: GroupGoalRunStatus, detail: string): RoutineRun | null {
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
