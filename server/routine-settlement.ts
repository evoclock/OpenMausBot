import { createHash } from "node:crypto";
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
