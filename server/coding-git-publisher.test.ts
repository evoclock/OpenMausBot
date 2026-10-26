import { strict as assert } from "node:assert";
import { test } from "vitest";
import { publishVerifiedCodingRun } from "./coding-git-publisher.ts";
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
  const branch = await publishVerifiedCodingRun({ snapshot, workspace, hasDestination: true,
    async createBranch(directory, name, base) { actions.push(["branch", directory, name, base]); },
    async gitAction(request) { actions.push(request); return "applied"; },
  });
  assert.equal(branch, "bot/coding-11111111-111");
  assert.deepEqual(actions.map((action) => Array.isArray(action) ? action[0] : (action as { action: string }).action),
    ["branch", "push", "pr-open"]);
  assert.deepEqual(actions[2], { botId: "owner", repository: "evoclock/docs", workspace: workspace.directory,
    branch, base: "main", action: "pr-open", draft: true });
});

test("blocked runs and missing outward-write grants are never published", async () => {
  let calls = 0;
  const input = { workspace, hasDestination: true, async createBranch() { calls++; }, async gitAction() { calls++; return "applied" as const; } };
  assert.equal(await publishVerifiedCodingRun({ ...input, snapshot: { ...snapshot, state: "blocked" } }), null);
  assert.equal(await publishVerifiedCodingRun({ ...input, snapshot: { ...snapshot,
    contract: { ...snapshot.contract, allowedEffects: ["edit", "commit"] } } }), null);
  assert.equal(calls, 0);
});
