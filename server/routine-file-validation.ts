// Copyright 2026 OpenMausBot contributors. Licensed under Apache-2.0.
// Reject malformed persisted state before the scheduler can rewrite it.
export function assertRoutineFileShape(disk: {
  version?: unknown;
  routines?: unknown;
  runs?: unknown;
  routineRequestReceipts?: unknown;
  webhookRunReceipts?: unknown;
} | null): void {
  if (disk === null || typeof disk !== "object" || Array.isArray(disk)) throw new Error("Invalid routines file");
  if (disk.version !== 1 || !Array.isArray(disk.routines) || !Array.isArray(disk.runs)) {
    throw new Error("Invalid routines file: expected version 1 with routines and runs");
  }
  for (const key of ["routineRequestReceipts", "webhookRunReceipts"] as const) {
    if (key in disk && !Array.isArray(disk[key])) throw new Error(`Invalid routines file: ${key} is not a list`);
  }
}
