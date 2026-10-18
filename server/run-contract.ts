import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export const runContractSchema = z.object({
  id: z.string().uuid(),
  botId: z.string().min(1),
  repository: z.string().min(1),
  ref: z.string().min(1),
  successCriteria: z.array(z.string().min(1)).min(1),
  repositoryClass: z.enum(["agent-private", "external"]),
  allowedEffects: z.array(z.enum(["edit", "commit", "push", "draft-pr"])),
  authorisedExternalWrites: z.array(z.object({
    repository: z.string().min(1),
    effects: z.array(z.enum(["edit", "commit", "push", "draft-pr"])).min(1),
  }).strict()).default([]),
}).strict().superRefine((contract, ctx) => {
  if (contract.repositoryClass !== "external") return;
  const granted = new Set(contract.authorisedExternalWrites
    .filter((entry) => entry.repository === contract.repository)
    .flatMap((entry) => entry.effects));
  for (const effect of contract.allowedEffects) {
    if (!granted.has(effect)) ctx.addIssue({ code: "custom", message: `external write requires explicit authorisation: ${effect}` });
  }
});
export type RunContract = z.infer<typeof runContractSchema>;
export const runStateSchema = z.enum(["queued", "running", "blocked", "unverified", "done", "failed", "cancelled"]);
export type RunState = z.infer<typeof runStateSchema>;
export const runSnapshotSchema = z.object({
  contract: runContractSchema,
  state: runStateSchema,
  iteration: z.number().int().nonnegative(),
  updatedAt: z.number().int().positive(),
  evidence: z.array(z.string()),
}).strict();
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

const edges: Record<RunState, readonly RunState[]> = {
  queued: ["running", "blocked", "cancelled"],
  running: ["blocked", "unverified", "done", "failed", "cancelled"],
  blocked: ["running", "failed", "cancelled"],
  unverified: ["running", "failed", "cancelled"],
  done: [], failed: [], cancelled: [],
};

export function advanceRun(current: RunSnapshot, next: RunState, at: number, evidence: string[] = []): RunSnapshot {
  const snapshot = runSnapshotSchema.parse(current);
  if (!edges[snapshot.state].includes(next)) throw new Error("invalid run transition");
  if (!Number.isSafeInteger(at) || at <= snapshot.updatedAt) throw new Error("run time must advance");
  if (next === "done" && !evidence.some((item) => item.trim())) throw new Error("completion requires verification evidence");
  const iteration = snapshot.iteration + (next === "running" ? 1 : 0);
  return runSnapshotSchema.parse({ ...snapshot, state: next, iteration, updatedAt: at, evidence: [...snapshot.evidence, ...evidence] });
}

export class RunContractStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("CREATE TABLE IF NOT EXISTS coding_runs (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, version INTEGER NOT NULL, snapshot TEXT NOT NULL)");
  }
  close(): void { this.db.close(); }
  get(id: string): RunSnapshot | undefined {
    const row = this.db.prepare("SELECT snapshot FROM coding_runs WHERE id = ?").get(id) as { snapshot: string } | undefined;
    return row ? runSnapshotSchema.parse(JSON.parse(row.snapshot)) : undefined;
  }
  create(contract: RunContract, at: number): RunSnapshot {
    const checked = runContractSchema.parse(contract);
    const snapshot = runSnapshotSchema.parse({ contract: checked, state: "queued", iteration: 0, updatedAt: at, evidence: [] });
    this.db.prepare("INSERT INTO coding_runs (id, bot_id, version, snapshot) VALUES (?, ?, 0, ?)").run(checked.id, checked.botId, JSON.stringify(snapshot));
    return snapshot;
  }
  transition(id: string, next: RunState, at: number, evidence: string[] = []): RunSnapshot {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT version, snapshot FROM coding_runs WHERE id = ?").get(id) as { version: number; snapshot: string } | undefined;
      if (!row) throw new Error("run not found");
      const snapshot = advanceRun(runSnapshotSchema.parse(JSON.parse(row.snapshot)), next, at, evidence);
      this.db.prepare("UPDATE coding_runs SET version = ?, snapshot = ? WHERE id = ? AND version = ?")
        .run(row.version + 1, JSON.stringify(snapshot), id, row.version);
      this.db.exec("COMMIT");
      return snapshot;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
