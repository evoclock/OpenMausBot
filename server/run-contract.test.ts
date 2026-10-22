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

test("run contract carries an iteration ceiling; time and spend budgets remain unenforced", () => {
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
