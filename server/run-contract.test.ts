import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { advanceRun, runContractSchema, RunContractStore, type RunContractInput } from "./run-contract.ts";

const contract: RunContractInput = {
  id: "11111111-1111-4111-8111-111111111111", botId: "fixture", repository: "fixture/repo", ref: "review",
  successCriteria: ["inner loop confirms the goal"], repositoryClass: "agent-private", allowedEffects: ["edit"],
  authorisedExternalWrites: [],
};

test("run contract survives reopening and terminal states cannot restart", () => {
  const scratch = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(scratch, { recursive: true });
  const path = join(mkdtempSync(join(scratch, "run-contract-")), "runtime.db");
  const first = new RunContractStore(path);
  first.create(contract, 1);
  assert.equal(first.transition(contract.id, "running", 2).iteration, 1);
  first.close();
  const second = new RunContractStore(path);
  assert.equal(second.get(contract.id)?.state, "running");
  assert.throws(() => second.transition(contract.id, "done", 3), /evidence/);
  assert.equal(second.get(contract.id)?.state, "running");
  assert.equal(second.transition(contract.id, "done", 4, ["fixture verdict"]).state, "done");
  assert.throws(() => second.transition(contract.id, "running", 5), /transition/);
  second.close();
});

test("terminal routine link survives restart and can be reconciled by coding identity", () => {
  const scratch = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(scratch, { recursive: true });
  const path = join(mkdtempSync(join(scratch, "coding-link-")), "runtime.db");
  const first = new RunContractStore(path);
  first.create(contract, 1);
  first.transition(contract.id, "running", 2);
  const terminal = first.transition(contract.id, "done", 3, ["verified"]);
  assert.deepEqual(first.linkRoutine("routine-run", contract.id), { status: "pending" });
  assert.equal(first.claimRoutineTerminal(contract.id, terminal)?.status, "claimed");
  first.close();
  const replay = new RunContractStore(path);
  assert.deepEqual(replay.routineLink(contract.id), { routineId: "routine-run", status: "claimed", terminal });
  assert.deepEqual(replay.linkRoutine("routine-run", contract.id), { status: "claimed" });
  assert.throws(() => replay.linkRoutine("another-run", contract.id), /different routine/);
  replay.close();
});

test("owner private-merge reason is attached to a verified run and survives restart", () => {
  const scratch = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(scratch, { recursive: true });
  const path = join(mkdtempSync(join(scratch, "merge-reason-")), "runtime.db");
  let store = new RunContractStore(path);
  store.create(contract, 1);
  assert.throws(() => store.recordOwnerMerge(contract.id, contract.repository,
    "This unblocks further development", "merge"), /verified run/);
  store.transition(contract.id, "running", 2);
  store.transition(contract.id, "done", 3, ["verified"]);
  assert.throws(() => store.recordOwnerMerge(contract.id, "wrong/repo",
    "This unblocks further development", "merge"), /verified run/);
  store.recordOwnerMerge(contract.id, contract.repository, "This unblocks further development", "merge");
  store.close();
  store = new RunContractStore(path);
  try {
    assert.deepEqual(store.ownerMergeReason(contract.id), {
      repository: contract.repository, reason: "This unblocks further development", method: "merge",
    });
    assert.throws(() => store.recordOwnerMerge(contract.id, contract.repository,
      "A different reason unblocks development", "rebase"), /reason changed/);
  } finally { store.close(); }
});

test("run contract preserves the iteration ceiling and parses legacy records for fail-closed recovery", () => {
  const store = new RunContractStore(":memory:");
  const queued = store.create(contract, 1);
  assert.equal(queued.contract.maxIterations, 8);
  assert.throws(() => runContractSchema.parse({ ...contract, maxIterations: 0 }), /maxIterations/);
  assert.deepEqual(store.create(contract, 2), queued);
  assert.throws(() => store.create({ ...contract, ref: "other" }, 2), /different contract/);
  assert.throws(() => advanceRun(queued, "running", 1), /time/);
  for (let iteration = 0; iteration < 10; iteration += 1) {
    store.transition(contract.id, "running", iteration * 2 + 2);
    store.transition(contract.id, "blocked", iteration * 2 + 3);
  }
  assert.equal(store.get(contract.id)?.iteration, 10);
  store.close();
});

test("prepared effects and finished results survive reopen with stable request identity", () => {
  const scratch = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(scratch, { recursive: true });
  const path = join(mkdtempSync(join(scratch, "run-receipt-")), "runtime.db");
  let store = new RunContractStore(path);
  store.create(contract, 1);
  store.bindTask(contract.id, 42);
  assert.equal(store.beginIteration(contract.id, 0, `${contract.id}:1`, 2).iteration, 1);
  assert.throws(() => store.beginIteration(contract.id, 0, `${contract.id}:1`, 3), /not ready/);
  store.close();
  store = new RunContractStore(path);
  try {
    assert.equal(store.taskId(contract.id), 42);
    assert.equal(store.step(contract.id, 1)?.status, "prepared");
    assert.throws(() => store.finishIteration(contract.id, 1, "wrong", "waiting", 3, ["work"]), /does not match/);
    assert.equal(store.step(contract.id, 1)?.status, "prepared");
    const finished = store.finishIteration(contract.id, 1, `${contract.id}:1`, "waiting", 4, ["work"]);
    assert.equal(store.step(contract.id, 1)?.result?.updatedAt, finished.updatedAt);
    assert.equal(store.step(contract.id, 1)?.status, "finished");
    assert.throws(() => store.bindTask(contract.id, 43), /identity changed/);
    assert.equal(store.taskId(contract.id), 42);
  } finally { store.close(); }
});

test("wall-clock and spend counters survive restart before the next iteration", () => {
  const scratch = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(scratch, { recursive: true });
  const path = join(mkdtempSync(join(scratch, "run-counters-")), "runtime.db");
  const limits = { maxWallTimeMs: 100, maxSpendUsd: 1 };
  const first = new RunContractStore(path);
  first.create({ ...contract, limits }, 10);
  first.beginIteration(contract.id, 0, `${contract.id}:1`, 20);
  first.finishIteration(contract.id, 1, `${contract.id}:1`, "waiting", 40, ["step one"], 0.4);
  first.close();
  const resumed = new RunContractStore(path);
  try {
    const persisted = resumed.get(contract.id)!;
    assert.equal(persisted.startedAt, 10);
    assert.equal(persisted.elapsedMs, 30);
    assert.equal(persisted.spentUsd, 0.4);
    assert.equal(persisted.spendUncertain, false);
    assert.deepEqual(persisted.contract.limits, { ...limits, allowedFallbackModels: [], allowedFallbackDataRoutes: [] });
    resumed.beginIteration(contract.id, 1, `${contract.id}:2`, 50);
    const terminal = resumed.finishIteration(contract.id, 2, `${contract.id}:2`, "blocked", 60,
      ["spend ceiling reached"], 0.6);
    assert.equal(terminal.spentUsd, 1);
    assert.equal(terminal.elapsedMs, 50);
    assert.equal(resumed.report(contract.id)?.snapshot.spentUsd, 1);
  } finally { resumed.close(); }
  assert.throws(() => runContractSchema.parse({ ...contract, limits: { maxWallTimeMs: 0, maxSpendUsd: 1 } }), /maxWallTimeMs/);
  assert.throws(() => runContractSchema.parse({ ...contract, limits: { maxWallTimeMs: 10, maxSpendUsd: -1 } }), /maxSpendUsd/);
});

test("external writes need exact per-run authorisation; critical effects cannot enter the contract", () => {
  const store = new RunContractStore(":memory:");
  assert.throws(() => store.create({ ...contract, repositoryClass: "external" }, 1), /external write/);
  const authorised = { ...contract, repositoryClass: "external" as const, maxIterations: 8,
    authorisedExternalWrites: [{ repository: contract.repository, effects: ["edit" as const] }] };
  assert.equal(store.create(authorised, 1).contract.repositoryClass, "external");
  assert.throws(() => store.create({ ...contract, id: "22222222-2222-4222-8222-222222222222",
    allowedEffects: ["merge" as "edit"] }, 2));
  store.close();
});
