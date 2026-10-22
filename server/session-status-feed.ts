import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { redactSecretsInText } from "../shared/redact.ts";
import { runStateSchema, type RunState } from "./run-contract.ts";

/** The four changes worth an extra coordinator turn. Everything else is a quiet heartbeat. */
export const sessionChangeKindSchema = z.enum(["stall", "decision", "completion", "pr-ready"]);
export type SessionChangeKind = z.infer<typeof sessionChangeKindSchema>;

const sessionIdSchema = z.string().trim().min(1).max(128).regex(/^[\w-]+$/,
  "sessionId must be letters, digits, dash or underscore");
const shortText = z.string().trim().min(1).max(200);
const detailText = z.string().trim().min(1).max(500);
const prUrlSchema = z.string().trim().min(1).max(2048).refine(
  (value) => !/[\s\0]/.test(value), "prUrl must be one URL without whitespace or control characters");

/** One per-minute push from a local reporter; the durable status/report path for a live session. */
export const sessionStatusReportSchema = z.object({
  sessionId: sessionIdSchema,
  /** Stable per push: `${sessionId}:${sequence}`. A replay returns the stored outcome. */
  reportId: z.string().trim().min(1).max(200),
  sequence: z.number().int().nonnegative(),
  state: runStateSchema,
  phase: shortText.optional(),
  stepId: shortText.optional(),
  /** When the session last made real progress, not when the reporter ran. */
  progressAt: z.number().int().positive(),
  reportedAt: z.number().int().positive(),
  needsDecision: z.boolean().optional(),
  decision: detailText.optional(),
  prReady: z.boolean().optional(),
  prUrl: prUrlSchema.optional(),
  evidence: z.array(detailText).max(50).optional(),
}).strict();
export type SessionStatusReport = z.infer<typeof sessionStatusReportSchema>;

export interface SessionStatusRecord extends Omit<SessionStatusReport, "state"> {
  state: RunState;
  receivedAt: number;
  changes: SessionChangeKind[];
  /** The progressAt of the stall already woken for, so one episode wakes once. */
  stallNotedFor?: number;
}

export interface SessionWake {
  id: number;
  sessionId: string;
  kind: SessionChangeKind;
  detail: string;
  createdAt: number;
}

export interface RecordOutcome {
  accepted: boolean;
  duplicate: boolean;
  stale: boolean;
  changed: boolean;
  changes: SessionChangeKind[];
  wakes: SessionWake[];
}

export interface StatusFeedOptions {
  now?: () => number;
  /** A running session that has not reported progress for this long has stalled. */
  stallMs?: number;
}

export const DEFAULT_STALL_MS = 15 * 60_000;
const MAX_SESSIONS = 500;
const MAX_WAKES = 1_000;
const WAKE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const TERMINAL_STATES: ReadonlySet<RunState> = new Set(["done", "failed", "cancelled"]);

const emptyOutcome = (over: Partial<RecordOutcome>): RecordOutcome =>
  ({ accepted: false, duplicate: false, stale: false, changed: false, changes: [], wakes: [], ...over });

function folded(text: string, max = 300): string {
  const line = redactSecretsInText(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function stalled(record: Pick<SessionStatusReport, "state" | "progressAt">, at: number, stallMs: number): boolean {
  return record.state === "running" && at - record.progressAt >= stallMs;
}

function wakeDetail(report: SessionStatusReport, kind: SessionChangeKind): string {
  switch (kind) {
    case "stall":
      return `${report.sessionId} has not made progress since ${new Date(report.progressAt).toISOString()}`;
    case "decision":
      return report.decision ? `needs a decision: ${folded(report.decision)}` : `${report.sessionId} needs a decision`;
    case "completion":
      return report.evidence?.length
        ? `finished ${report.state}: ${folded(report.evidence.at(-1) ?? "")}`
        : `finished ${report.state}`;
    case "pr-ready":
      return report.prUrl ? `draft pull request ready: ${report.prUrl}` : `${report.sessionId} has a pull request ready`;
  }
}

export class SessionStatusFeed {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly stallMs: number;

  constructor(path: string, options: StatusFeedOptions = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_status (
      session_id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      record TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_wakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      acknowledged_at INTEGER
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS session_wakes_pending ON session_wakes (acknowledged_at, id)");
    this.now = options.now ?? Date.now;
    this.stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  }

  close(): void { this.db.close(); }

  /** Record one push. A repeat of a stored reportId is a no-op; an older sequence is refused. */
  record(input: unknown): RecordOutcome {
    const report = sessionStatusReportSchema.parse(input);
    const at = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.latestFor(report.sessionId);
      if (previous?.reportId === report.reportId) {
        this.db.exec("COMMIT");
        return emptyOutcome({ accepted: true, duplicate: true });
      }
      if (previous && report.sequence <= previous.sequence) {
        this.db.exec("COMMIT");
        return emptyOutcome({ stale: true });
      }

      const changes = this.classify(report, previous, at);
      const record: SessionStatusRecord = {
        ...report, receivedAt: at, changes,
        ...(changes.includes("stall") ? { stallNotedFor: report.progressAt }
          : previous?.stallNotedFor === undefined ? {} : { stallNotedFor: previous.stallNotedFor }),
      };
      this.db.prepare(`INSERT INTO session_status (session_id, report_id, sequence, record, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (session_id) DO UPDATE SET report_id = excluded.report_id, sequence = excluded.sequence,
          record = excluded.record, updated_at = excluded.updated_at`)
        .run(report.sessionId, report.reportId, report.sequence, JSON.stringify(record), at);

      const wakes: SessionWake[] = [];
      for (const kind of changes) {
        const inserted = this.db.prepare(`INSERT INTO session_wakes (session_id, kind, detail, created_at)
          SELECT ?, ?, ?, ? WHERE NOT EXISTS (
            SELECT 1 FROM session_wakes WHERE session_id = ? AND kind = ? AND acknowledged_at IS NULL)`)
          .run(report.sessionId, kind, wakeDetail(report, kind), at, report.sessionId, kind);
        if (inserted.changes) {
          const id = Number(inserted.lastInsertRowid);
          wakes.push({ id, sessionId: report.sessionId, kind, detail: wakeDetail(report, kind), createdAt: at });
        }
      }
      this.prune(at);
      this.db.exec("COMMIT");
      return { accepted: true, duplicate: false, stale: false, changed: changes.length > 0, changes, wakes };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Latest record per session, newest first. The coordinator's checkpoint reads this instead of a per-minute turn. */
  latest(limit = MAX_SESSIONS): SessionStatusRecord[] {
    const rows = this.db.prepare("SELECT record FROM session_status ORDER BY updated_at DESC LIMIT ?")
      .all(Math.min(Math.max(1, limit), MAX_SESSIONS)) as Array<{ record: string }>;
    return rows.map((row) => JSON.parse(row.record) as SessionStatusRecord);
  }

  /** Unacknowledged changes, oldest first: one turn's worth of work for the coordinator. */
  pendingWakes(): SessionWake[] {
    const rows = this.db.prepare(`SELECT id, session_id, kind, detail, created_at FROM session_wakes
      WHERE acknowledged_at IS NULL ORDER BY id`).all() as Array<{
        id: number; session_id: string; kind: SessionChangeKind; detail: string; created_at: number }>;
    return rows.map((row) => ({
      id: row.id, sessionId: row.session_id, kind: row.kind, detail: row.detail, createdAt: row.created_at,
    }));
  }

  /** Mark changes as seen. Repeating an id is safe and never reopens a wake. */
  acknowledge(ids: readonly number[]): number {
    const at = this.now();
    let acknowledged = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const mark = this.db.prepare("UPDATE session_wakes SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL");
      for (const id of ids) acknowledged += Number(mark.run(at, id).changes);
      this.db.exec("COMMIT");
      return acknowledged;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private latestFor(sessionId: string): SessionStatusRecord | undefined {
    const row = this.db.prepare("SELECT record FROM session_status WHERE session_id = ?").get(sessionId) as
      { record: string } | undefined;
    return row ? JSON.parse(row.record) as SessionStatusRecord : undefined;
  }

  private classify(report: SessionStatusReport, previous: SessionStatusRecord | undefined, at: number): SessionChangeKind[] {
    // First sight of a session is context, not news: the checkpoint already reads the record.
    if (!previous) return [];
    const changes: SessionChangeKind[] = [];
    if (TERMINAL_STATES.has(report.state) && !TERMINAL_STATES.has(previous.state)) changes.push("completion");
    if (report.needsDecision === true &&
      (previous.needsDecision !== true || (report.decision ?? "") !== (previous.decision ?? ""))) changes.push("decision");
    if (report.prReady === true && previous.prReady !== true) changes.push("pr-ready");
    if (stalled(report, at, this.stallMs) && previous.stallNotedFor !== report.progressAt) changes.push("stall");
    return changes;
  }

  private prune(at: number): void {
    this.db.prepare(`DELETE FROM session_status WHERE session_id NOT IN (
      SELECT session_id FROM session_status ORDER BY updated_at DESC LIMIT ?)`).run(MAX_SESSIONS);
    this.db.prepare(`DELETE FROM session_wakes WHERE acknowledged_at IS NOT NULL AND acknowledged_at < ?`)
      .run(at - WAKE_RETENTION_MS);
    this.db.prepare(`DELETE FROM session_wakes WHERE id NOT IN (
      SELECT id FROM session_wakes ORDER BY id DESC LIMIT ?)`).run(MAX_WAKES);
  }
}
