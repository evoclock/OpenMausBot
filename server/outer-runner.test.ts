import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { openOuterRunner } from "./outer-runner.ts";
import type { RunContract } from "./run-contract.ts";

const contract: RunContract = {
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
