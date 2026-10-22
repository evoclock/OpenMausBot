import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Store } from "./store.ts";

export interface CodingResult {
  runId: string;
  botId: string;
  threadId: string;
  text: string;
}

export interface CodingResultSink {
  /** Must read the persisted transcript, not an in-memory event queue. */
  contains(threadId: string, runId: string): boolean;
  /** Must persist a message carrying runId before returning. */
  post(result: CodingResult): void;
}

export function codingResultStoreSink(store: Pick<Store, "taskByThread" | "messagesFor" | "appendMessage">): CodingResultSink {
  const marker = (runId: string) => `coding-result:${runId}`;
  return {
    contains(threadId, runId) {
      return store.messagesFor(threadId).some((message) => message.role === "bot" && message.turnId === marker(runId));
    },
    post(result) {
      if (!store.taskByThread(result.botId, result.threadId)) throw new Error("coding result thread does not belong to bot");
      store.appendMessage(result.threadId, { role: "bot", kind: "text", text: result.text,
        turnId: marker(result.runId), turnTerminal: true });
    },
  };
}

export class CodingResultDelivery {
  private readonly db: DatabaseSync;
  private readonly sink: CodingResultSink;
  constructor(path: string, sink: CodingResultSink) {
    this.sink = sink;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS coding_result_delivery (
      run_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      text TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'delivered'))
    )`);
  }
  close(): void { this.db.close(); }

  deliver(result: CodingResult): "delivered" | "pending" {
    if (!result.runId || !result.botId || !result.threadId || !result.text.trim()) throw new Error("invalid coding result");
    this.db.prepare("INSERT OR IGNORE INTO coding_result_delivery VALUES (?, ?, ?, ?, 'pending')")
      .run(result.runId, result.botId, result.threadId, result.text);
    const row = this.db.prepare("SELECT bot_id, thread_id, text, status FROM coding_result_delivery WHERE run_id = ?")
      .get(result.runId) as { bot_id: string; thread_id: string; text: string; status: string };
    if (row.bot_id !== result.botId || row.thread_id !== result.threadId || row.text !== result.text) {
      throw new Error("coding result conflicts with recorded delivery");
    }
    if (row.status === "delivered") return "delivered";
    if (!this.sink.contains(result.threadId, result.runId)) this.sink.post(result);
    if (!this.sink.contains(result.threadId, result.runId)) return "pending";
    this.db.prepare("UPDATE coding_result_delivery SET status = 'delivered' WHERE run_id = ? AND status = 'pending'")
      .run(result.runId);
    return "delivered";
  }

  replay(): number {
    const rows = this.db.prepare("SELECT run_id, bot_id, thread_id, text FROM coding_result_delivery WHERE status = 'pending'")
      .all() as Array<{ run_id: string; bot_id: string; thread_id: string; text: string }>;
    for (const row of rows) this.deliver({ runId: row.run_id, botId: row.bot_id, threadId: row.thread_id, text: row.text });
    return rows.length;
  }
}
