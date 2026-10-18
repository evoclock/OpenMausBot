import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { advanceRun, RunContractStore, type RunContract } from "./run-contract.ts";

const contract: RunContract = {
  id: "11111111-1111-4111-8111-111111111111", botId: "fixture", repository: "fixture/repo", ref: "review",
  successChecks: ["isolated fixture passes"], allowedEffects: ["edit"], deadline: 1000, maxIterations: 2,
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

test("run contract rejects replay, expiry and excess iterations", () => {
  const store = new RunContractStore(":memory:");
  const queued = store.create(contract, 1);
  assert.throws(() => store.create(contract, 2));
  assert.throws(() => advanceRun(queued, "running", 1000), /deadline/);
  assert.throws(() => advanceRun(queued, "running", 1), /time/);
  store.transition(contract.id, "running", 2);
  store.transition(contract.id, "blocked", 3);
  store.transition(contract.id, "running", 4);
  store.transition(contract.id, "blocked", 5);
  assert.throws(() => store.transition(contract.id, "running", 6), /iteration/);
  assert.equal(store.get(contract.id)?.state, "blocked");
  store.close();
});
