import { strict as assert } from "node:assert";
import { join } from "node:path";
import { test } from "vitest";
import { LEASE_ITEM_I_DATA_TOKEN, leaseRolesFilePath, prepareCodingSeed } from "./seed-coding-run-data.mjs";

const lease = "/fixture/.treehouse/openmausbot/1/openmausbot";
const agents = "/fixture/pi-agentic-driver-agents";
const sha = "a".repeat(40);
const roles = { schema: "pstack-model-roles.v1", roles: {
  development: "subscription/worker", "independent-review": "local/reviewer",
} };
const config = { codingRuns: {
  repositoryRoot: "/other/dirty/repo", rolesFilePath: "/old/.treehouse/1/pi-roles.json",
  registrations: [{ routineId: "once", workerBotId: "worker", reviewerBotId: "reviewer",
    developmentRole: roles.roles.development, reviewRole: roles.roles["independent-review"],
    ref: "docs/stale-branch", repository: "example/agents" }],
  bots: { worker: { modelAccess: "subscription", maxWallTimeMs: 45 * 60_000, maxIterations: 8,
    allowedFallbackModels: [], allowedFallbackDataRoutes: [] } },
} };
const routines = { version: 1, routines: [{ id: "once", enabled: false, schedule: { type: "once", at: 1 } }],
  runs: [{ id: "old-failed-run" }], codingSettlementReceipts: [{ status: "APPLIED" }] };
const seed = (newConfig = config, newRoutines = routines, main = sha, originMain = sha, newRoles = roles) =>
  prepareCodingSeed(newConfig, newRoutines, lease, agents, main, originMain, newRoles);

test("seed rebases the roles file and agents base to the acquired lease and current main", () => {
  const result = seed();
  assert.equal(result.config.codingRuns.rolesFilePath, join(lease, ".omb-scratch/item-i-data/pi-roles.json"));
  assert.equal(result.config.codingRuns.repositoryRoot, agents);
  assert.equal(result.config.codingRuns.registrations[0].ref, "main");
  assert.equal(result.routines.routines[0].enabled, false);
  assert.deepEqual(result.routines.runs, []);
  assert.deepEqual(result.routines.codingSettlementReceipts, []);
  assert.equal(config.codingRuns.rolesFilePath, "/old/.treehouse/1/pi-roles.json");
  assert.equal(config.codingRuns.registrations[0].ref, "docs/stale-branch");
});

test("seed resolves LEASE_ITEM_I_DATA placeholder to the lease pi-roles.json", () => {
  const placeholder = `${LEASE_ITEM_I_DATA_TOKEN}/pi-roles.json`;
  const result = seed({ codingRuns: { ...config.codingRuns, rolesFilePath: placeholder } });
  assert.equal(result.config.codingRuns.rolesFilePath, leaseRolesFilePath(result.dataDir));
  assert.equal(JSON.stringify(result.config).includes(LEASE_ITEM_I_DATA_TOKEN), false);
  assert.equal(result.config.codingRuns.rolesFilePath.includes(LEASE_ITEM_I_DATA_TOKEN), false);
});

test("seed accepts one model shared by the worker and reviewer roles", () => {
  const model = "openai-codex/gpt-6-sol";
  const shared = { ...roles, roles: { development: model, "independent-review": model } };
  const entry = { ...config.codingRuns.registrations[0], developmentRole: model, reviewRole: model };
  assert.doesNotThrow(() => seed({ codingRuns: { ...config.codingRuns, registrations: [entry] } }, routines, sha, sha, shared));
});

test("seed refuses drifted main, mismatched roles, and any budget or routine that could fire unexpectedly", () => {
  assert.throws(() => seed(config, routines, sha, "b".repeat(40)), /main/);
  assert.throws(() => seed(config, routines, sha, sha, { ...roles, roles: {
    ...roles.roles, "independent-review": "other/reviewer",
  } }), /routes/);
  assert.throws(() => seed(config, { ...routines, routines: [{ ...routines.routines[0], enabled: true }] }), /disabled/);
  assert.throws(() => seed({ codingRuns: { ...config.codingRuns,
    bots: { worker: { ...config.codingRuns.bots.worker, modelAccess: "api", maxSpendUsd: 1 } } } }), /no-spend/);
});
