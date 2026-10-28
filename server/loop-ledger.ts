import { DatabaseSync } from "node:sqlite";
import { runSnapshotSchema, type RunSnapshot } from "./run-contract.ts";

export interface IterationEntry {
  iteration: number;
  goal: string;
  evidence: string[];
  verdict: RunSnapshot["state"] | "pending";
  startedAt: number;
  finishedAt?: number;
  sessionFile?: string;
}

export interface IterationContextCompactor {
  compact(entries: readonly IterationEntry[]): string;
}

const MAX_ENTRIES = 32;
const MAX_EVIDENCE = 16;
const MAX_ITEM_LENGTH = 1024;

export function openLoopLedger(path: string) {
  const db = new DatabaseSync(path);
  const entries = (runId: string): IterationEntry[] => {
    const rows = db.prepare(`SELECT sequence, status, result FROM coding_run_steps
      WHERE run_id = ? ORDER BY sequence DESC LIMIT ?`).all(runId, MAX_ENTRIES) as
      Array<{ sequence: number; status: string; result: string | null }>;
    const run = db.prepare("SELECT snapshot FROM coding_runs WHERE id = ?").get(runId) as { snapshot: string } | undefined;
    if (!run) return [];
    const current = runSnapshotSchema.parse(JSON.parse(run.snapshot));
    const newestFirst = rows.map((row) => {
      const result = row.result ? runSnapshotSchema.parse(JSON.parse(row.result)) : undefined;
      const predecessor = db.prepare(`SELECT result FROM coding_run_steps WHERE run_id = ? AND sequence = ?`)
        .get(runId, row.sequence - 1) as { result: string | null } | undefined;
      const previous = predecessor?.result ? runSnapshotSchema.parse(JSON.parse(predecessor.result)) : undefined;
      const sessionFile = result?.iterations?.find((entry) => entry.iteration === row.sequence)?.sessionFile;
      return {
        iteration: row.sequence,
        goal: current.contract.successCriteria.join("\n"),
        evidence: (result?.evidence.slice(previous?.evidence.length ?? 0) ?? []).slice(0, MAX_EVIDENCE)
          .map((item) => item.slice(0, MAX_ITEM_LENGTH)),
        verdict: result?.state ?? "pending",
        startedAt: previous?.updatedAt ?? current.startedAt ?? current.updatedAt,
        ...(result ? { finishedAt: result.updatedAt } : {}),
        ...(sessionFile ? { sessionFile } : {}),
      } satisfies IterationEntry;
    });
    return newestFirst.reverse();
  };
  return { entries, previous(runId: string, iteration: number) {
    return entries(runId).find((entry) => entry.iteration === iteration - 1 && entry.verdict !== "pending");
  }, close() { db.close(); } };
}
