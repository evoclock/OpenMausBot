import { strict as assert } from "node:assert";
import { test } from "vitest";
import { publishVerifiedCodingRun } from "./coding-git-publisher.ts";
import { CodingEffectReceipts, type EffectReconcileHost } from "./coding-effect-receipts.ts";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { removeTempDir } from "./testing/cleanup.ts";
import type { RunSnapshot } from "./run-contract.ts";

const snapshot: RunSnapshot = { contract: { id: "11111111-1111-4111-8111-111111111111", botId: "owner",
  repository: "evoclock/docs", ref: "main", successCriteria: ["docs updated"],
  repositoryClass: "agent-private", allowedEffects: ["edit", "commit", "push", "draft-pr"],
  maxIterations: 8, authorisedExternalWrites: [] }, state: "done", iteration: 1, updatedAt: 3,
  spentUsd: 0, elapsedMs: 1, spendUncertain: false, evidence: ["documentation verified"] };
const workspace = { repository: "evoclock/docs", directory: "/fixture/worktree", branch: "omb/coding-fixture",
  baseBranch: "main", base: "a".repeat(40), leaseId: "lease" };

test("verified terminal coding runs publish one checked push then a draft PR", async () => {
  const actions: unknown[] = [];
  const receipts = new CodingEffectReceipts(":memory:");
  let push = false;
  let pr = false;
  const branch = await publishVerifiedCodingRun({ snapshot, workspace, hasDestination: true, receipts,
    head: async () => "b".repeat(40),
    async createBranch(directory, name, base) { actions.push(["branch", directory, name, base]); },
    effectHost: {
      async getBranchRef() { return push ? { kind: "found", sha: "b".repeat(40) } : { kind: "absent" }; },
      async findPullRequests() { return pr ? { kind: "found", prs: [{ number: 1, headSha: "b".repeat(40), state: "open" }] } : { kind: "absent" }; },
      async findCommentsByIdempotencyKey() { return { kind: "absent" }; },
      async applyMissing(receipt) { actions.push(receipt.key); if (receipt.key === "push") push = true; else pr = true; },
    },
  });
  assert.equal(branch, "bot/coding-11111111-111");
  assert.deepEqual(actions.map((action) => Array.isArray(action) ? action[0] : action),
    ["branch", "push", "pr-open"]);
  receipts.close();
});

test("restart after push reconciles the branch and creates only one draft PR", async () => {
  const cache = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(join(cache, "coding-publish-"));
  const path = join(directory, "effects.sqlite");
  let branchPresent = false;
  let prPresent = false;
  let prLookupFails = true;
  const writes: string[] = [];
  const effectHost: EffectReconcileHost = {
    async getBranchRef() { return branchPresent ? { kind: "found", sha: "b".repeat(40) } : { kind: "absent" }; },
    async findPullRequests() {
      if (prLookupFails) return { kind: "inconclusive", reason: "connection lost" };
      return prPresent ? { kind: "found", prs: [{ number: 12, headSha: "b".repeat(40), state: "open" }] } : { kind: "absent" };
    },
    async findCommentsByIdempotencyKey() { return { kind: "inconclusive", reason: "unsupported" }; },
    async applyMissing(receipt) {
      writes.push(receipt.key);
      if (receipt.key === "push") branchPresent = true;
      else prPresent = true;
    },
  };
  const input = { snapshot, workspace, hasDestination: true, effectHost,
    head: async () => "b".repeat(40),
    async createBranch() {} };
  let receipts = new CodingEffectReceipts(path);
  await assert.rejects(publishVerifiedCodingRun({ ...input, receipts }), /pull request|pr-open/i);
  assert.deepEqual(writes, ["push"]);
  receipts.close();
  receipts = new CodingEffectReceipts(path);
  prLookupFails = false;
  assert.equal(await publishVerifiedCodingRun({ ...input, receipts }), "bot/coding-11111111-111");
  assert.deepEqual(writes, ["push", "pr-open"]);
  assert.deepEqual(receipts.list(snapshot.contract.id, snapshot.iteration + 1).map((row) => row.status),
    ["confirmed", "confirmed"]);
  receipts.savePublicationResult(snapshot.contract.id, "Published draft branch bot/coding-11111111-111");
  receipts.close();
  receipts = new CodingEffectReceipts(path);
  assert.equal(receipts.publicationResult(snapshot.contract.id), "Published draft branch bot/coding-11111111-111");
  assert.deepEqual(writes, ["push", "pr-open"]);
  receipts.close();
  await removeTempDir(directory);
});

test("a verified base revision never creates a branch or PR", async () => {
  let calls = 0;
  const receipts = new CodingEffectReceipts(":memory:");
  const result = await publishVerifiedCodingRun({ snapshot: { ...snapshot,
    hostCheck: { command: ["true"], exitCode: 0, commitSha: workspace.base, startedAt: 1,
      durationMs: 1, timedOut: false, outputTail: "" } }, workspace, hasDestination: true,
    receipts, effectHost: {} as EffectReconcileHost, head: async () => { calls++; return "b".repeat(40); },
    async createBranch() { calls++; },
  });
  assert.equal(result, null);
  assert.equal(calls, 0);
  receipts.close();
});

test("blocked runs and missing outward-write grants are never published", async () => {
  let calls = 0;
  const receipts = new CodingEffectReceipts(":memory:");
  const input = { workspace, hasDestination: true, receipts, effectHost: {} as EffectReconcileHost,
    head: async () => { calls++; return "b".repeat(40); }, async createBranch() { calls++; } };
  assert.equal(await publishVerifiedCodingRun({ ...input, snapshot: { ...snapshot, state: "blocked" } }), null);
  assert.equal(await publishVerifiedCodingRun({ ...input, snapshot: { ...snapshot,
    contract: { ...snapshot.contract, allowedEffects: ["edit", "commit"] } } }), null);
  assert.equal(calls, 0);
});
