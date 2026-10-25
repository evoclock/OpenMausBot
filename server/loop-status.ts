import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runSnapshotSchema, type RunSnapshot } from "./run-contract.ts";

export interface LoopStatusReader {
  list(botId: string): RunSnapshot[];
  recent(id: string): Array<{ iteration: number; state: string; at: number; verdict: string | null }>;
}

export function loopStatus(snapshot: RunSnapshot, entries: ReturnType<LoopStatusReader["recent"]>) {
  const limits = snapshot.contract.limits;
  return {
    id: snapshot.contract.id, state: snapshot.state, iteration: snapshot.iteration,
    budget: {
      iterationsUsed: snapshot.iteration,
      iterationsRemaining: Math.max(0, snapshot.contract.maxIterations - snapshot.iteration),
      spentUsd: snapshot.spentUsd,
      spendRemainingUsd: limits?.maxSpendUsd !== undefined && !snapshot.spendUncertain ? Math.max(0, limits.maxSpendUsd - snapshot.spentUsd) : null,
      spendUncertain: snapshot.spendUncertain,
      elapsedMs: snapshot.elapsedMs,
      wallTimeRemainingMs: limits && snapshot.startedAt
        ? Math.max(0, limits.maxWallTimeMs - Math.max(snapshot.elapsedMs, Date.now() - snapshot.startedAt)) : null,
    },
    modelsUsed: snapshot.modelsUsed ?? [],
    lastVerdict: entries.find((entry) => entry.verdict !== null)?.verdict ?? null,
    entries,
  };
}

export function openLoopStatusReader(dataDir: string): LoopStatusReader & { close(): void } | null {
  const path = join(dataDir, "coding-run", "runtime.db");
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  return {
    list(botId) {
      const rows = db.prepare("SELECT snapshot FROM coding_runs WHERE bot_id = ? ORDER BY rowid DESC LIMIT 20")
        .all(botId) as Array<{ snapshot: string }>;
      return rows.map((row) => runSnapshotSchema.parse(JSON.parse(row.snapshot)));
    },
    recent(id) {
      const rows = db.prepare("SELECT sequence, status, result FROM coding_run_steps WHERE run_id = ? ORDER BY sequence DESC LIMIT 10")
        .all(id) as Array<{ sequence: number; status: string; result: string | null }>;
      return rows.map((row) => {
        const result = row.result ? runSnapshotSchema.parse(JSON.parse(row.result)) : null;
        return { iteration: row.sequence, state: result?.state ?? row.status,
          at: result?.updatedAt ?? 0, verdict: result?.state ?? null };
      });
    },
    close() { db.close(); },
  };
}
