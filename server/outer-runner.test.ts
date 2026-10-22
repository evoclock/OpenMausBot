import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { openOuterRunner } from "./outer-runner.ts";
import { RunContractStore, type RunContractInput } from "./run-contract.ts";

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

test("repeated start returns the same durable task identity", async () => {
  const runner = await openOuterRunner(fixtureDir(), {
    async invoke() { return { kind: "verified", evidence: ["complete"] }; },
  });
  try {
    const [first, concurrent] = await Promise.all([runner.start(contract), runner.start(contract)]);
    assert.equal(concurrent, first);
    assert.equal(await runner.start(contract), first);
    await runner.wait(first);
    assert.equal(await runner.start(contract), first);
  } finally { await runner.close(); }
});

test("cancel correlates by run ID and persists its terminal status", async () => {
  const dir = fixtureDir();
  const runner = await openOuterRunner(dir, {
    async invoke(_contract, _iteration, _requestId, signal) {
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
    },
  });
  try {
    const taskId = await runner.start(contract);
    assert.equal(await runner.cancel(contract.id), "marked");
    const settled = await runner.wait(taskId);
    assert.equal(settled.state.outcome.status, "aborted");
    assert.equal(runner.get(contract.id)?.state === "cancelled" || runner.get(contract.id)?.state === "blocked", true);
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

test("report delivery retries after the originating link becomes available", async () => {
  let linked = false;
  const seen: string[] = [];
  const runner = await openOuterRunner(fixtureDir(), { async invoke() { return { kind: "verified", evidence: ["complete"] }; } },
    { onTerminal: (snapshot) => { if (!linked) return false; seen.push(snapshot.contract.id); return true; } });
  try {
    await runner.wait(await runner.start(contract));
    assert.equal(runner.report(contract.id)?.delivered, false);
    linked = true;
    runner.reportPending();
    assert.deepEqual(seen, [contract.id]);
    assert.equal(runner.report(contract.id)?.delivered, true);
  } finally { await runner.close(); }
});

test("unacknowledged terminal report remains pending until a later restart", async () => {
  const dir = fixtureDir();
  const first = await openOuterRunner(dir, { async invoke() { return { kind: "verified", evidence: ["complete"] }; } },
    { onTerminal: () => false });
  try {
    await first.wait(await first.start(contract));
    assert.equal(first.report(contract.id)?.delivered, false);
  } finally { await first.close(); }
  const seen: string[] = [];
  const second = await openOuterRunner(dir, { async invoke() { throw new Error("duplicate work"); } },
    { onTerminal: (snapshot) => { seen.push(snapshot.contract.id); return true; } });
  try {
    assert.deepEqual(seen, [contract.id]);
    assert.equal(second.report(contract.id)?.delivered, true);
  } finally { await second.close(); }
});

test("terminal report receipt replays after a crash before delivery", async () => {
  const dir = fixtureDir();
  const source = `import { openOuterRunner } from './server/outer-runner.ts';
    import { RunContractStore } from './server/run-contract.ts';
    const finish = RunContractStore.prototype.finishIteration;
    RunContractStore.prototype.finishIteration = function(...args) {
      const result = finish.apply(this, args);
      process.stdout.write('terminal stored\\n');
      process.exit(0);
    };
    const runner = await openOuterRunner(${JSON.stringify(dir)}, {
      async invoke() { return { kind: 'verified', evidence: ['completed'] }; }
    });
    await runner.start(${JSON.stringify(contract)});
    setInterval(() => {}, 1000);`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /terminal stored/);
  const seen: string[] = [];
  const reopened = await openOuterRunner(dir, { async invoke() { throw new Error("duplicate work"); } },
    { onTerminal: (snapshot) => { seen.push(snapshot.contract.id); return true; } });
  try {
    reopened.resume();
    assert.deepEqual(seen, [contract.id]);
    assert.equal(reopened.get(contract.id)?.state, "done");
  } finally { await reopened.close(); }
  const again = await openOuterRunner(dir, { async invoke() { throw new Error("duplicate work"); } },
    { onTerminal: (snapshot) => { seen.push(snapshot.contract.id); return true; } });
  try { assert.deepEqual(seen, [contract.id]); } finally { await again.close(); }
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
    for (let attempt = 0; attempt < 100 && reopened.get(contract.id)?.state !== "done"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(reopened.get(contract.id)?.state, "done");
    await reopened.wait(await reopened.start(contract));
    assert.deepEqual(calls, [`${contract.id}:1`]);
  } finally { await reopened.close(); }
});

test("a finished effect without its task checkpoint resumes at the next step", async () => {
  const dir = fixtureDir();
  const source = `import { openOuterRunner } from './server/outer-runner.ts';
    import { RunContractStore } from './server/run-contract.ts';
    const original = RunContractStore.prototype.finishIteration;
    RunContractStore.prototype.finishIteration = function(id, sequence, requestId, state, at, evidence) {
      const result = original.call(this, id, sequence, requestId, state, at, evidence);
      if (state === 'waiting') { process.stdout.write('result stored\\n'); process.exit(0); }
      return result;
    };
    const runner = await openOuterRunner(${JSON.stringify(dir)}, {
      async invoke() { return { kind: 'progress', evidence: ['step one finished'] }; }
    });
    await runner.start(${JSON.stringify(contract)});
    await new Promise(() => {});`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /result stored/);
  const calls: number[] = [];
  const reopened = await openOuterRunner(dir, {
    async invoke(_contract, iteration) { calls.push(iteration); return { kind: "verified", evidence: ["verified next step"] }; },
  });
  try {
    reopened.resume();
    for (let attempt = 0; attempt < 100 && reopened.get(contract.id)?.state !== "done"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(reopened.get(contract.id)?.state, "done");
    assert.deepEqual(calls, [2]);
  } finally { await reopened.close(); }
});

test("SIGKILL after a finished step holds an unknown effect without repeating work", async () => {
  const dir = fixtureDir();
  const transcript = join(dir, "steps.log");
  const source = `import { appendFileSync } from 'node:fs';
    import { openOuterRunner } from './server/outer-runner.ts';
    const runner = await openOuterRunner(${JSON.stringify(dir)}, {
      async invoke(_contract, iteration, requestId) {
        appendFileSync(${JSON.stringify(transcript)}, requestId + '\\n');
        if (iteration === 1) return { kind: 'progress', evidence: ['first step completed'] };
        process.stdout.write('second effect started\\n');
        return new Promise(() => {});
      }
    });
    await runner.start(${JSON.stringify(contract)});
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stderr?.on("data", (chunk) => { errors += String(chunk); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`second effect did not start: ${errors}`)), 15_000);
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("second effect started")) { clearTimeout(timer); resolve(); }
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`worker exited before kill: ${code} ${errors}`)));
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }
  const calls = readFileSync(transcript, "utf8").trim().split("\n");
  assert.deepEqual(calls, [`${contract.id}:1`, `${contract.id}:2`]);
  const receipts = new RunContractStore(join(dir, "runtime.db"));
  assert.equal(receipts.step(contract.id, 1)?.status, "finished");
  assert.equal(receipts.step(contract.id, 2)?.status, "prepared");
  receipts.close();
  const reopened = await openOuterRunner(dir, {
    async invoke() { appendFileSync(transcript, "DUPLICATE\n"); throw new Error("replayed unknown work"); },
  });
  try {
    reopened.resume();
    for (let attempt = 0; attempt < 100 && reopened.get(contract.id)?.state !== "blocked"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(reopened.get(contract.id)?.state, "blocked");
    assert.ok(reopened.get(contract.id)?.evidence.some((item) => item.includes(`unknown outward effect ${contract.id}:2`)));
    assert.deepEqual(readFileSync(transcript, "utf8").trim().split("\n"), calls);
    if (process.env.OMB_PARITY_PROOF_DIR) {
      mkdirSync(process.env.OMB_PARITY_PROOF_DIR, { recursive: true });
      appendFileSync(join(process.env.OMB_PARITY_PROOF_DIR, "outer-kill-restart-transcript.log"),
        `child: ${output.trim()}\nsignal: SIGKILL\nsteps: ${calls.join(", ")}\n` +
        `receipts: step 1 finished, step 2 prepared\nrestart: ${reopened.get(contract.id)?.state}; ` +
        `${reopened.get(contract.id)?.evidence.at(-1)}\n`);
    }
  } finally { await reopened.close(); }
}, 30_000);

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
