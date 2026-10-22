// Copyright 2026 OpenMausBot contributors. Licensed under Apache-2.0.
// Reject malformed persisted state before the scheduler can rewrite it.
export function assertRoutineFileShape(disk: {
  version?: unknown;
  routines?: unknown;
  runs?: unknown;
  routineRequestReceipts?: unknown;
  webhookRunReceipts?: unknown;
  codingSettlementReceipts?: unknown;
} | null): void {
  if (disk === null || typeof disk !== "object" || Array.isArray(disk)) throw new Error("Invalid routines file");
  if (disk.version !== 1 || !Array.isArray(disk.routines) || !Array.isArray(disk.runs)) {
    throw new Error("Invalid routines file: expected version 1 with routines and runs");
  }
  for (const key of ["routineRequestReceipts", "webhookRunReceipts", "codingSettlementReceipts"] as const) {
    if (key in disk && !Array.isArray(disk[key])) throw new Error(`Invalid routines file: ${key} is not a list`);
  }
  if (Array.isArray(disk.codingSettlementReceipts)) {
    const routineIds = new Set<string>(), codingIds = new Set<string>();
    for (const entry of disk.codingSettlementReceipts) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid coding settlement receipt");
      const receipt = entry as Record<string, unknown>;
      if (receipt.status !== "APPLIED" || typeof receipt.routineRunId !== "string" || !receipt.routineRunId ||
        typeof receipt.codingRunId !== "string" || !receipt.codingRunId ||
        typeof receipt.terminalHash !== "string" || !/^[a-f0-9]{64}$/.test(receipt.terminalHash) ||
        !["completed", "held", "failed", "cancelled"].includes(String(receipt.disposition)) ||
        typeof receipt.appliedAt !== "number" || !Number.isFinite(receipt.appliedAt) ||
        routineIds.has(receipt.routineRunId) || codingIds.has(receipt.codingRunId)) {
        throw new Error("Invalid coding settlement receipt");
      }
      routineIds.add(receipt.routineRunId);
      codingIds.add(receipt.codingRunId);
    }
  }
}
