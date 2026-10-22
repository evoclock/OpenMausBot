import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { CodingEffectReceipts, reconcilePreparedEffects, type EffectReconcileHost } from "./coding-effect-receipts.ts";
import type { CodingEffect } from "./coding-effect-reconciliation.ts";

const sha = "a".repeat(40);
const effects: CodingEffect[] = [
  { kind: "branch-push", repository: "owner/repo", ref: "review", expectedSha: sha },
  { kind: "pr-open", repository: "owner/repo", head: "review", base: "main" },
  { kind: "pr-comment", repository: "owner/repo", pullNumber: 7, key: "effect-1" },
];

function scratch() {
  const dir = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(dir, { recursive: true });
  return mkdtempSync(join(dir, "effect-reconcile-"));
}

function host(effect: CodingEffect, present: () => boolean, apply: () => void): EffectReconcileHost {
  return {
    async getBranchRef() { return present() ? { kind: "found" as const, sha } : { kind: "absent" as const }; },
    async findPullRequests() { return present()
      ? { kind: "found" as const, prs: [{ number: 7, headSha: sha, state: "open" }] }
      : { kind: "absent" as const }; },
    async findCommentsByIdempotencyKey() { return present()
      ? { kind: "found" as const, ids: [15] } : { kind: "absent" as const }; },
    async applyMissing(receipt) { assert.deepEqual(receipt.effect, effect); apply(); },
  };
}

test.each(effects)("$kind: present, missing and inconclusive receipts", async (effect) => {
  const db = new CodingEffectReceipts(":memory:");
  const receipt = db.prepare("run-1", 1, "effect-1", effect);
  assert.deepEqual(db.prepare("run-1", 1, "effect-1", effect), receipt);
  assert.throws(() => db.prepare("run-1", 1, "effect-1", { ...effect, repository: "other/repo" }), /conflicts/);
  let remotePresent = true;
  let applied = 0;
  const forge = host(effect, () => remotePresent, () => { remotePresent = true; applied += 1; });
  assert.equal((await reconcilePreparedEffects(db, forge, "run-1", 1)).status, "reconciled");
  assert.equal(applied, 0);
  assert.equal(db.list("run-1", 1)[0]?.status, "confirmed");
  remotePresent = false;
  assert.equal((await reconcilePreparedEffects(db, forge, "run-1", 1)).status, "reconciled");
  assert.equal(applied, 1);
  db.close();

  const missing = new CodingEffectReceipts(":memory:");
  missing.prepare("run-1", 1, "effect-1", effect);
  remotePresent = false;
  assert.equal((await reconcilePreparedEffects(missing, forge, "run-1", 1)).status, "reconciled");
  assert.equal(applied, 2);
  missing.close();

  const inconclusive = new CodingEffectReceipts(":memory:");
  inconclusive.prepare("run-1", 1, "effect-1", effect);
  const failed = host(effect, () => { throw new Error("unauthorized"); }, () => { applied += 1; });
  assert.equal((await reconcilePreparedEffects(inconclusive, failed, "run-1", 1)).status, "blocked");
  assert.equal(inconclusive.list("run-1", 1)[0]?.status, "prepared");
  assert.equal(applied, 2);
  inconclusive.close();
});

test("an inconclusive later receipt prevents all missing writes", async () => {
  const db = new CodingEffectReceipts(":memory:");
  db.prepare("run-1", 1, "branch", effects[0]!);
  db.prepare("run-1", 1, "pr", effects[1]!);
  let applied = 0;
  const forge = host(effects[0]!, () => false, () => { applied += 1; });
  forge.findPullRequests = async () => ({ kind: "inconclusive", reason: "partial response" });
  assert.equal((await reconcilePreparedEffects(db, forge, "run-1", 1)).status, "blocked");
  assert.equal(applied, 0);
  db.close();
});

async function killAfterBoundary(dbPath: string, marker: string, effect: CodingEffect, boundary: string): Promise<void> {
  const source = `import { writeFileSync } from 'node:fs';
    import { CodingEffectReceipts } from './server/coding-effect-receipts.ts';
    const receipts = new CodingEffectReceipts(${JSON.stringify(dbPath)});
    const receipt = receipts.prepare('run-1', 1, 'effect-1', ${JSON.stringify(effect)});
    if (${JSON.stringify(boundary)} !== 'prepared') {
      writeFileSync(${JSON.stringify(marker)}, 'one outward action');
    }
    if (${JSON.stringify(boundary)} === 'confirmed') receipts.confirm(receipt);
    process.stdout.write('boundary ready\\n');
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`effect boundary timed out: ${stderr}`)), 10_000);
      child.stdout?.on("data", (chunk) => {
        if (String(chunk).includes("boundary ready")) { clearTimeout(timeout); resolve(); }
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`effect child exited ${code}: ${stderr}`)));
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }
}

for (const effect of effects) {
  for (const boundary of ["prepared", "applied", "confirmed"]) {
    test(`SIGKILL ${effect.kind} ${boundary}: replay never duplicates an outward action`, async () => {
      const dir = scratch();
      const dbPath = join(dir, "receipts.sqlite");
      const marker = join(dir, "outward.txt");
      await killAfterBoundary(dbPath, marker, effect, boundary);
      const db = new CodingEffectReceipts(dbPath);
      let count = boundary === "prepared" ? 0 : 1;
      const forge = host(effect, () => count > 0, () => { count += 1; writeFileSync(marker, "one outward action"); });
      try {
        assert.equal((await reconcilePreparedEffects(db, forge, "run-1", 1)).status, "reconciled");
        assert.equal(count, 1);
        assert.equal(readFileSync(marker, "utf8"), "one outward action");
        assert.equal(db.list("run-1", 1)[0]?.status, "confirmed");
        assert.equal((await reconcilePreparedEffects(db, forge, "run-1", 1)).status, "reconciled");
        assert.equal(count, 1);
      } finally { db.close(); }
    }, 20_000);
  }
}
