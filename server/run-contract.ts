import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export const codingRunLimitsSchema = z.object({
  maxWallTimeMs: z.number().int().positive().max(2_147_483_647),
  maxSpendUsd: z.number().finite().positive().optional(),
  modelAccess: z.enum(["subscription", "local", "api"]).optional(),
  allowedFallbackModels: z.array(z.object({ instanceId: z.string().min(1), model: z.string().min(1) }).strict()).default([]),
  allowedFallbackDataRoutes: z.array(z.string().min(1)).default([]),
}).strict();

export const runContractSchema = z.object({
  id: z.string().uuid(),
  botId: z.string().min(1),
  repository: z.string().min(1),
  ref: z.string().min(1),
  successCriteria: z.array(z.string().min(1)).min(1),
  checkCommand: z.array(z.string().min(1)).min(1).optional(),
  repositoryClass: z.enum(["agent-private", "external"]),
  allowedEffects: z.array(z.enum(["edit", "commit", "push", "draft-pr"])),
  maxIterations: z.number().int().positive().default(8),
  limits: codingRunLimitsSchema.optional(),
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
export type RunContractInput = z.input<typeof runContractSchema>;
export const runStateSchema = z.enum(["queued", "running", "waiting", "blocked", "unverified", "done", "failed", "cancelled"]);
export type RunState = z.infer<typeof runStateSchema>;
export type HostCheckRecord = { command: string[]; exitCode: number | null; commitSha: string; startedAt: number; durationMs: number; timedOut: boolean; outputTail: string };
export const runSnapshotSchema = z.object({
  contract: runContractSchema,
  state: runStateSchema,
  iteration: z.number().int().nonnegative(),
  updatedAt: z.number().int().positive(),
  startedAt: z.number().int().positive().optional(),
  elapsedMs: z.number().int().nonnegative().default(0),
  spentUsd: z.number().finite().nonnegative().default(0),
  spendUncertain: z.boolean().default(false),
  modelsUsed: z.array(z.object({ iteration: z.number().int().positive(), instanceId: z.string().min(1), model: z.string().min(1) }).strict()).optional(),
  iterations: z.array(z.object({ iteration: z.number().int().positive(), sessionFile: z.string().min(1) }).strict()).optional(),
  evidence: z.array(z.string()),
  hostCheck: z.object({ command: z.array(z.string()), exitCode: z.number().int().nullable(), commitSha: z.string(), startedAt: z.number().int(), durationMs: z.number().int().nonnegative(), timedOut: z.boolean(), outputTail: z.string() }).strict().optional(),
}).strict();
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

const edges: Record<RunState, readonly RunState[]> = {
  queued: ["running", "blocked", "cancelled"],
  running: ["waiting", "blocked", "unverified", "done", "failed", "cancelled"],
  waiting: ["running", "blocked", "cancelled"],
  blocked: ["running", "failed", "cancelled"],
  unverified: ["running", "failed", "cancelled"],
  done: [], failed: [], cancelled: [],
};

export function advanceRun(current: RunSnapshot, next: RunState, at: number, evidence: string[] = []): RunSnapshot {
  const snapshot = runSnapshotSchema.parse(current);
  if (!edges[snapshot.state].includes(next)) throw new Error("invalid run transition");
  if (!Number.isSafeInteger(at) || at <= snapshot.updatedAt) throw new Error("run time must advance");
  if (next === "done" && (!evidence.some((item) => item.trim()) || !snapshot.contract.checkCommand ||
    snapshot.hostCheck?.exitCode !== 0 || !snapshot.hostCheck.commitSha)) throw new Error("completion requires a passing host check and verification evidence");
  const iteration = snapshot.iteration + (next === "running" ? 1 : 0);
  return runSnapshotSchema.parse({ ...snapshot, state: next, iteration, updatedAt: at,
    elapsedMs: snapshot.startedAt ? Math.max(snapshot.elapsedMs, at - snapshot.startedAt) : snapshot.elapsedMs,
    evidence: [...snapshot.evidence, ...evidence] });
}

export class RunContractStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("CREATE TABLE IF NOT EXISTS coding_runs (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, version INTEGER NOT NULL, snapshot TEXT NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS coding_routine_links (routine_id TEXT PRIMARY KEY, coding_id TEXT NOT NULL UNIQUE, terminal TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed')))");
    this.db.exec(`CREATE TABLE IF NOT EXISTS coding_run_steps (
      run_id TEXT NOT NULL, sequence INTEGER NOT NULL, request_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('prepared', 'finished')),
      result TEXT, PRIMARY KEY (run_id, sequence)
    )`);
    this.db.exec("CREATE TABLE IF NOT EXISTS coding_run_reports (run_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0)");
    this.db.exec("CREATE TABLE IF NOT EXISTS coding_run_tasks (run_id TEXT PRIMARY KEY, task_id INTEGER NOT NULL UNIQUE)");
    this.db.exec("CREATE TABLE IF NOT EXISTS coding_run_merge_reasons (run_id TEXT PRIMARY KEY, repository TEXT NOT NULL, reason TEXT NOT NULL, method TEXT NOT NULL CHECK (method IN ('merge', 'rebase')))");
  }
  close(): void { this.db.close(); }
  /** A claim is not an applied settlement receipt. Once claimed, an uncertain external effect must be held. */
  routineLink(codingId: string): { routineId: string; status: "pending" | "claimed"; terminal?: RunSnapshot } | undefined {
    const row = this.db.prepare("SELECT routine_id, status, terminal FROM coding_routine_links WHERE coding_id = ?")
      .get(codingId) as { routine_id: string; status: "pending" | "claimed"; terminal: string | null } | undefined;
    return row ? { routineId: row.routine_id, status: row.status,
      ...(row.terminal ? { terminal: runSnapshotSchema.parse(JSON.parse(row.terminal)) } : {}) } : undefined;
  }
  linkRoutine(routineId: string, codingId: string): { status: "pending" | "claimed" } {
    if (!routineId || !codingId) throw new Error("empty routine/coding run id");
    this.db.prepare("INSERT OR IGNORE INTO coding_routine_links (routine_id, coding_id) VALUES (?, ?)").run(routineId, codingId);
    const linked = this.db.prepare("SELECT coding_id, status FROM coding_routine_links WHERE routine_id = ?")
      .get(routineId) as { coding_id: string; status: "pending" | "claimed" };
    if (!linked) throw new Error("coding run linked to a different routine");
    if (linked.coding_id !== codingId) throw new Error("routine linked to a different coding run");
    return { status: linked.status };
  }
  claimRoutineTerminal(codingId: string, terminal: RunSnapshot): ReturnType<RunContractStore["routineLink"]> {
    const checked = runSnapshotSchema.parse(terminal);
    if (checked.contract.id !== codingId || !["done", "blocked", "failed", "cancelled"].includes(checked.state)) {
      throw new Error("terminal report does not match coding run");
    }
    this.db.prepare("UPDATE coding_routine_links SET terminal = ?, status = 'claimed' WHERE coding_id = ? AND status = 'pending'")
      .run(JSON.stringify(checked), codingId);
    return this.routineLink(codingId);
  }
  queued(): RunContract[] {
    const rows = this.db.prepare("SELECT snapshot FROM coding_runs").all() as Array<{ snapshot: string }>;
    return rows.map((row) => runSnapshotSchema.parse(JSON.parse(row.snapshot)))
      .filter((snapshot) => snapshot.state === "queued").map((snapshot) => snapshot.contract);
  }
  taskId(id: string): number | undefined {
    const row = this.db.prepare("SELECT task_id FROM coding_run_tasks WHERE run_id = ?").get(id) as { task_id: number } | undefined;
    return row?.task_id;
  }
  bindTask(id: string, taskId: number): void {
    if (!this.get(id) || !Number.isSafeInteger(taskId) || taskId <= 0) throw new Error("invalid run task identity");
    this.db.prepare("INSERT OR IGNORE INTO coding_run_tasks VALUES (?, ?)").run(id, taskId);
    if (this.taskId(id) !== taskId) throw new Error("run task identity changed");
  }
  recordOwnerMerge(id: string, repository: string, reason: string, method: "merge" | "rebase"): void {
    const run = this.get(id);
    if (run?.state !== "done" || run.contract.repository !== repository ||
      reason.trim().length < 16 || !/\bunblock(?:s|ed|ing)?\b/i.test(reason) ||
      (method !== "merge" && method !== "rebase")) throw new Error("owner merge reason does not match a verified run");
    this.db.prepare("INSERT OR IGNORE INTO coding_run_merge_reasons VALUES (?, ?, ?, ?)")
      .run(id, repository, reason, method);
    const recorded = this.ownerMergeReason(id);
    if (recorded?.repository !== repository || recorded.reason !== reason || recorded.method !== method) {
      throw new Error("owner merge reason changed");
    }
  }
  ownerMergeReason(id: string): { repository: string; reason: string; method: "merge" | "rebase" } | undefined {
    const row = this.db.prepare("SELECT repository, reason, method FROM coding_run_merge_reasons WHERE run_id = ?")
      .get(id) as { repository: string; reason: string; method: "merge" | "rebase" } | undefined;
    return row ? { repository: row.repository, reason: row.reason, method: row.method } : undefined;
  }
  get(id: string): RunSnapshot | undefined {
    const row = this.db.prepare("SELECT snapshot FROM coding_runs WHERE id = ?").get(id) as { snapshot: string } | undefined;
    return row ? runSnapshotSchema.parse(JSON.parse(row.snapshot)) : undefined;
  }
  create(contract: RunContractInput, at: number): RunSnapshot {
    const checked = runContractSchema.parse(contract);
    const snapshot = runSnapshotSchema.parse({ contract: checked, state: "queued", iteration: 0,
      updatedAt: at, startedAt: at, evidence: [] });
    const inserted = this.db.prepare("INSERT OR IGNORE INTO coding_runs (id, bot_id, version, snapshot) VALUES (?, ?, 0, ?)")
      .run(checked.id, checked.botId, JSON.stringify(snapshot));
    if (inserted.changes) return snapshot;
    const existing = this.get(checked.id);
    if (existing && JSON.stringify(existing.contract) === JSON.stringify(checked)) return existing;
    throw new Error("run id already exists with a different contract or state");
  }
  report(id: string): { snapshot: RunSnapshot; delivered: boolean } | undefined {
    const row = this.db.prepare("SELECT snapshot, delivered FROM coding_run_reports WHERE run_id = ?")
      .get(id) as { snapshot: string; delivered: number } | undefined;
    return row ? { snapshot: runSnapshotSchema.parse(JSON.parse(row.snapshot)), delivered: row.delivered === 1 } : undefined;
  }
  pendingReports(): RunSnapshot[] {
    const rows = this.db.prepare("SELECT snapshot FROM coding_run_reports WHERE delivered = 0 ORDER BY run_id")
      .all() as Array<{ snapshot: string }>;
    return rows.map((row) => runSnapshotSchema.parse(JSON.parse(row.snapshot)));
  }
  markReported(id: string): void {
    this.db.prepare("UPDATE coding_run_reports SET delivered = 1 WHERE run_id = ? AND delivered = 0").run(id);
  }
  step(id: string, sequence: number): { requestId: string; status: "prepared" | "finished"; result?: RunSnapshot } | undefined {
    const row = this.db.prepare("SELECT request_id, status, result FROM coding_run_steps WHERE run_id = ? AND sequence = ?")
      .get(id, sequence) as { request_id: string; status: "prepared" | "finished"; result: string | null } | undefined;
    return row ? { requestId: row.request_id, status: row.status,
      ...(row.result ? { result: runSnapshotSchema.parse(JSON.parse(row.result)) } : {}) } : undefined;
  }
  beginIteration(id: string, sequence: number, requestId: string, at: number): RunSnapshot {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(id);
      if (!current || current.iteration !== sequence || !["queued", "waiting"].includes(current.state) ||
        this.step(id, sequence + 1)) throw new Error("iteration is not ready to start");
      const next = advanceRun(current, "running", at);
      this.db.prepare("UPDATE coding_runs SET version = version + 1, snapshot = ? WHERE id = ?")
        .run(JSON.stringify(next), id);
      this.db.prepare("INSERT INTO coding_run_steps VALUES (?, ?, ?, 'prepared', NULL)")
        .run(id, sequence + 1, requestId);
      this.db.exec("COMMIT");
      return next;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  finishIteration(id: string, sequence: number, requestId: string, nextState: RunState,
    at: number, evidence: string[], costUsd: number | null = null,
    modelsUsed: Array<{ instanceId: string; model: string }> = [], hostCheck?: RunSnapshot["hostCheck"], sessionFile?: string): RunSnapshot {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(id);
      const step = this.step(id, sequence);
      if (!current || current.state !== "running" || current.iteration !== sequence ||
        step?.status !== "prepared" || step.requestId !== requestId) throw new Error("iteration receipt does not match running attempt");
      if (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0)) throw new Error("invalid run spend");
      const checkedCurrent = hostCheck ? runSnapshotSchema.parse({ ...current, hostCheck }) : current;
      const advanced = advanceRun(checkedCurrent, nextState, at, evidence);
      const next = runSnapshotSchema.parse({ ...advanced, spentUsd: current.spentUsd + (costUsd ?? 0),
        modelsUsed: [...(current.modelsUsed ?? []), ...modelsUsed.map((selection) => ({ ...selection, iteration: sequence }))],
        iterations: [...(current.iterations ?? []), ...(sessionFile ? [{ iteration: sequence, sessionFile }] : [])],
        spendUncertain: current.spendUncertain || (current.contract.limits?.modelAccess !== "local" &&
          current.contract.limits?.modelAccess !== "subscription" && costUsd === null) });
      this.db.prepare("UPDATE coding_runs SET version = version + 1, snapshot = ? WHERE id = ?")
        .run(JSON.stringify(next), id);
      this.db.prepare("UPDATE coding_run_steps SET status = 'finished', result = ? WHERE run_id = ? AND sequence = ?")
        .run(JSON.stringify(next), id, sequence);
      if (["done", "failed", "cancelled", "blocked"].includes(next.state)) {
        this.db.prepare("INSERT OR IGNORE INTO coding_run_reports VALUES (?, ?, 0)").run(id, JSON.stringify(next));
      }
      this.db.exec("COMMIT");
      return next;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  transition(id: string, next: RunState, at: number, evidence: string[] = [], hostCheck?: RunSnapshot["hostCheck"]): RunSnapshot {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT version, snapshot FROM coding_runs WHERE id = ?").get(id) as { version: number; snapshot: string } | undefined;
      if (!row) throw new Error("run not found");
      const current = runSnapshotSchema.parse(JSON.parse(row.snapshot));
      const advanced = advanceRun(hostCheck ? runSnapshotSchema.parse({ ...current, hostCheck }) : current, next, at, evidence);
      const snapshot = next === "blocked" && current.state === "running"
        ? runSnapshotSchema.parse({ ...advanced, spendUncertain: true }) : advanced;
      this.db.prepare("UPDATE coding_runs SET version = ?, snapshot = ? WHERE id = ? AND version = ?")
        .run(row.version + 1, JSON.stringify(snapshot), id, row.version);
      if (["done", "failed", "cancelled", "blocked"].includes(snapshot.state)) {
        this.db.prepare("INSERT OR IGNORE INTO coding_run_reports VALUES (?, ?, 0)").run(id, JSON.stringify(snapshot));
      }
      this.db.exec("COMMIT");
      return snapshot;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
