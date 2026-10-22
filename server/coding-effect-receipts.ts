import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { codingEffectSchema, observeCodingEffect, type CodingEffect, type ForgeEffectInspector } from "./coding-effect-reconciliation.ts";

export interface EffectReceipt {
  runId: string;
  sequence: number;
  key: string;
  effect: CodingEffect;
  status: "prepared" | "confirmed";
}

/** The host writes an intent before its first outward action. An uncertain result stays prepared. */
export class CodingEffectReceipts {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS coding_effect_receipts (
      run_id TEXT NOT NULL, sequence INTEGER NOT NULL, effect_key TEXT NOT NULL,
      intent TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('prepared', 'confirmed')),
      PRIMARY KEY (run_id, sequence, effect_key)
    )`);
  }
  close(): void { this.db.close(); }
  prepare(runId: string, sequence: number, key: string, input: CodingEffect): EffectReceipt {
    if (!runId || !Number.isSafeInteger(sequence) || sequence <= 0 || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) {
      throw new Error("invalid effect receipt identity");
    }
    const effect = codingEffectSchema.parse(input);
    if (effect.kind === "pr-comment" && effect.key !== key) throw new Error("comment key differs from effect receipt key");
    const intent = JSON.stringify(effect);
    this.db.prepare("INSERT OR IGNORE INTO coding_effect_receipts VALUES (?, ?, ?, ?, 'prepared')")
      .run(runId, sequence, key, intent);
    const row = this.db.prepare(`SELECT intent, status FROM coding_effect_receipts
      WHERE run_id = ? AND sequence = ? AND effect_key = ?`)
      .get(runId, sequence, key) as { intent: string; status: EffectReceipt["status"] };
    if (row.intent !== intent) throw new Error("effect receipt identity conflicts with earlier intent");
    return { runId, sequence, key, effect, status: row.status };
  }
  list(runId: string, sequence: number): EffectReceipt[] {
    const rows = this.db.prepare(`SELECT effect_key, intent, status FROM coding_effect_receipts
      WHERE run_id = ? AND sequence = ? ORDER BY rowid`)
      .all(runId, sequence) as Array<{ effect_key: string; intent: string; status: EffectReceipt["status"] }>;
    return rows.map((row) => ({ runId, sequence, key: row.effect_key,
      effect: codingEffectSchema.parse(JSON.parse(row.intent)), status: row.status }));
  }
  confirm(receipt: EffectReceipt): void {
    const row = this.prepare(receipt.runId, receipt.sequence, receipt.key, receipt.effect);
    if (row.status === "confirmed") return;
    this.db.prepare(`UPDATE coding_effect_receipts SET status = 'confirmed'
      WHERE run_id = ? AND sequence = ? AND effect_key = ? AND status = 'prepared'`)
      .run(receipt.runId, receipt.sequence, receipt.key);
  }
}

export interface EffectReconcileHost extends ForgeEffectInspector {
  /** The checked host port performs only the recorded effect using its original stable key. */
  applyMissing(receipt: EffectReceipt): Promise<void>;
}

export async function reconcilePreparedEffects(receipts: CodingEffectReceipts, host: EffectReconcileHost,
  runId: string, sequence: number): Promise<{ status: "reconciled" | "blocked"; evidence: string[] }> {
  const pending = receipts.list(runId, sequence);
  if (!pending.length) return { status: "blocked", evidence: ["interrupted iteration has no outward effect receipts"] };
  const observed = [];
  for (const receipt of pending) {
    const observation = await observeCodingEffect(host, receipt.effect);
    if (observation.status === "inconclusive") {
      return { status: "blocked", evidence: [`${receipt.key}: ${observation.evidence}`] };
    }
    observed.push({ receipt, observation });
  }
  const evidence: string[] = [];
  for (const item of observed) {
    const { receipt } = item;
    let { observation } = item;
    if (observation.status === "missing") {
      try { await host.applyMissing(receipt); }
      catch { return { status: "blocked", evidence: [...evidence, `${receipt.key}: outward effect could not be confirmed`] }; }
      observation = await observeCodingEffect(host, receipt.effect);
      if (observation.status !== "present") {
        return { status: "blocked", evidence: [...evidence, `${receipt.key}: outward effect remains unconfirmed`] };
      }
    }
    receipts.confirm(receipt);
    evidence.push(`${receipt.key}: ${observation.evidence}`);
  }
  return { status: "reconciled", evidence };
}
