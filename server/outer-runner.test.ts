import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { openOuterRunner } from "./outer-runner.ts";
import type { RunContractInput } from "./run-contract.ts";

const contract: RunContractInput = {
  id: "33333333-3333-4333-8333-333333333333", botId: "fixture", repository: "fixture/agents", ref: "review",
  successCriteria: ["pstack verifies completion"], repositoryClass: "agent-private",
  allowedEffects: ["edit"], authorisedExternalWrites: [],
};

function fixtureDir() {
  const scratch = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(scratch, { recursive: true });
  return mkdtempSync(join(scratch, "outer-runner-"));
}

test("outer loop invokes fresh inner iterations until its verified verdict", async () => {
  const calls: string[] = [];
  const runner = await openOuterRunner(fixtureDir(), {
    async invoke(_contract, iteration, requestId) {
      calls.push(requestId);
      return iteration === 1 ? { kind: "progress", evidence: ["changes persisted"] }
        : { kind: "verified", evidence: ["pstack completion verdict"] };
    },
  });
  try {
    const id = await runner.start(contract);
    const result = await runner.wait(id);
    assert.equal(result.state.outcome.status, "completed");
    assert.deepEqual(calls, [`${contract.id}:1`, `${contract.id}:2`]);
    assert.equal(runner.get(contract.id)?.state, "done");
    assert.equal(runner.get(contract.id)?.iteration, 2);
  } finally { await runner.close(); }
});

test("outer loop parks the run as blocked at the contract iteration ceiling", async () => {
  const calls: string[] = [];
  const runner = await openOuterRunner(fixtureDir(), {
    async invoke(_contract, _iteration, requestId) {
      calls.push(requestId);
      return { kind: "progress", evidence: ["changes persisted"] };
    },
  });
  try {
    const id = await runner.start({ ...contract, maxIterations: 2 });
    const result = await runner.wait(id);
    assert.equal(result.state.outcome.status, "completed");
    assert.equal(result.state.outcome.result, "blocked");
    assert.equal(calls.length, 2);
    const final = runner.get(contract.id);
    assert.equal(final?.state, "blocked");
    assert.equal(final?.iteration, 2);
    assert.ok(final?.evidence.some((item) => item.includes("iteration ceiling reached (2)")));
  } finally { await runner.close(); }
});

test("a queued contract survives a crash before the task commit and starts on retry", async () => {
  const dir = fixtureDir();
  const source = `import { openOuterRunner } from './server/outer-runner.ts';
    import { RunContractStore } from './server/run-contract.ts';
    const original = RunContractStore.prototype.create;
    RunContractStore.prototype.create = function(contract, at) {
      original.call(this, contract, at);
      process.stdout.write('contract stored\\n');
      process.exit(0);
    };
    const runner = await openOuterRunner(${JSON.stringify(dir)}, {
      async invoke() { throw new Error('unexpected invocation'); }
    });
    await runner.start(${JSON.stringify(contract)});`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /contract stored/);
  const calls: string[] = [];
  const reopened = await openOuterRunner(dir, {
    async invoke(_contract, _iteration, requestId) {
      calls.push(requestId);
      return { kind: "verified", evidence: ["verified after retry"] };
    },
  });
  try {
    assert.equal(reopened.get(contract.id)?.state, "queued");
    const taskId = await reopened.start(contract);
    await reopened.wait(taskId);
    assert.equal(reopened.get(contract.id)?.state, "done");
    assert.deepEqual(calls, [`${contract.id}:1`]);
  } finally { await reopened.close(); }
});

test("a persisted result without its task checkpoint parks instead of replaying", async () => {
  const dir = fixtureDir();
  const source = `import { openOuterRunner } from './server/outer-runner.ts';
    import { RunContractStore } from './server/run-contract.ts';
    const original = RunContractStore.prototype.transition;
    RunContractStore.prototype.transition = function(id, state, at, evidence) {
      const result = original.call(this, id, state, at, evidence);
      if (state === 'waiting') { process.stdout.write('result stored\\n'); process.exit(0); }
      return result;
    };
    const runner = await openOuterRunner(${JSON.stringify(dir)}, {
      async invoke() { return { kind: 'progress', evidence: ['external action may have happened'] }; }
    });
    await runner.start(${JSON.stringify(contract)});
    await new Promise(() => {});`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /result stored/);
  let replayed = false;
  const reopened = await openOuterRunner(dir, {
    async invoke() { replayed = true; return { kind: "verified", evidence: ["invalid"] }; },
  });
  try {
    reopened.resume();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(reopened.get(contract.id)?.state, "blocked");
    assert.equal(replayed, false);
  } finally { await reopened.close(); }
});

test("an interrupted outward effect is parked after a process crash", async () => {
  const dir = fixtureDir();
  const source = `import { openOuterRunner } from './server/outer-runner.ts';
    const runner = await openOuterRunner(${JSON.stringify(dir)}, {
      async invoke() { process.stdout.write('effect began\\n'); process.exit(0); }
    });
    await runner.start(${JSON.stringify(contract)});
    await new Promise(() => {});`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /effect began/);
  let replayed = false;
  const reopened = await openOuterRunner(dir, {
    async invoke() { replayed = true; return { kind: "verified", evidence: ["invalid"] }; },
  });
  try {
    reopened.resume();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(reopened.get(contract.id)?.state, "blocked");
    assert.equal(replayed, false);
  } finally { await reopened.close(); }
});
