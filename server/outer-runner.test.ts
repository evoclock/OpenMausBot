import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { openOuterRunner } from "./outer-runner.ts";
import { createIterationContextCompactor } from "./iteration-context-compactor.ts";
import { RunContractStore, type RunContractInput } from "./run-contract.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingEffectReceipts, type EffectReconcileHost } from "./coding-effect-receipts.ts";
import type { CodingEffect } from "./coding-effect-reconciliation.ts";

const contract: RunContractInput = {
  id: "33333333-3333-4333-8333-333333333333", botId: "fixture", repository: "fixture/agents", ref: "review",
  successCriteria: ["pstack verifies completion"], repositoryClass: "agent-private",
  allowedEffects: ["edit"], authorisedExternalWrites: [],
  limits: { maxWallTimeMs: 30_000, maxSpendUsd: 1 },
};

function fixtureDir() {
  const scratch = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(scratch, { recursive: true });
  return mkdtempSync(join(scratch, "outer-runner-"));
}

test("backs up the configured SQLite database before reopening, and refuses a failed backup", async () => {
  const dir = fixtureDir();
  const inner = { async invoke() { return { kind: "verified" as const, evidence: ["complete"], costUsd: 0 }; } };
  const first = await openOuterRunner(dir, inner);
  await first.close();
  const backupPath = join(dir, "coding-runs.sqlite.pre-1.4.0.bak");
  const second = await openOuterRunner(dir, inner);
  try { assert.equal(existsSync(backupPath), true); }
  finally { await second.close(); }
  const blockedDir = fixtureDir();
  const third = await openOuterRunner(blockedDir, inner);
  await third.close();
  mkdirSync(join(blockedDir, "coding-runs.sqlite.pre-1.4.0.bak"));
  await assert.rejects(openOuterRunner(blockedDir, inner));
});

test("outer loop invokes fresh inner iterations until its verified verdict", async () => {
  const calls: string[] = [];
  const runner = await openOuterRunner(fixtureDir(), {
    async invoke(_contract, iteration, requestId) {
      calls.push(requestId);
      return iteration === 1 ? { kind: "progress", evidence: ["changes persisted"], costUsd: 0 }
        : { kind: "verified", evidence: ["pstack completion verdict"], costUsd: 0 };
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

test("ledger persists bounded entries across restart and carries only the preceding verdict", async () => {
  const dir = fixtureDir();
  const contexts: Array<{ iteration: number; previous?: { evidence: string[]; verdict: string } }> = [];
  const inner = { async invoke(_contract: RunContractInput, iteration: number, _requestId: string,
    _signal: AbortSignal, _budget?: number, context?: { iteration: number; previous?: { evidence: string[]; verdict: string } }) {
    contexts.push(context!);
    return iteration < 34 ? { kind: "progress" as const, evidence: [`proof ${iteration}`], costUsd: 0 }
      : { kind: "verified" as const, evidence: ["done"], costUsd: 0 };
  } };
  const first = await openOuterRunner(dir, inner);
  let firstLedger: ReturnType<typeof first.ledger> = [];
  try {
    await first.wait(await first.start({ ...contract, maxIterations: 34 }));
    assert.equal(contexts[0]?.iteration, 1);
    assert.equal(contexts[0]?.previous, undefined);
    assert.equal(contexts[1]?.previous?.verdict, "waiting");
    assert.deepEqual(contexts[1]?.previous?.evidence, ["proof 1"]);
    assert.equal(first.ledger(contract.id).length, 32);
    assert.deepEqual(first.ledger(contract.id).map((entry) => entry.iteration),
      Array.from({ length: 32 }, (_, index) => index + 3));
    firstLedger = first.ledger(contract.id);
  } finally { await first.close(); }
  const reopened = await openOuterRunner(dir, inner);
  try {
    assert.equal(reopened.ledger(contract.id).length, 32);
    assert.equal(createIterationContextCompactor().compact(reopened.ledger(contract.id)),
      createIterationContextCompactor().compact(firstLedger));
    assert.equal(reopened.ledger(contract.id).at(-1)?.verdict, "done");
    await reopened.wait(await reopened.start({ ...contract, maxIterations: 34 }));
    assert.equal(contexts.length, 34);
  } finally { await reopened.close(); }
});

test("restart after a finished mid-run receipt gives the same next carry without replay", async () => {
  const dir = fixtureDir();
  const source = `import { openOuterRunner } from './server/outer-runner.ts';
    import { RunContractStore } from './server/run-contract.ts';
    const original = RunContractStore.prototype.finishIteration;
    RunContractStore.prototype.finishIteration = function(...args) {
      const result = original.apply(this, args);
      if (result.iteration === 6) process.exit(46);
      return result;
    };
    const runner = await openOuterRunner(${JSON.stringify(dir)}, {
      async invoke(_contract, iteration) { return { kind: 'progress', evidence: [
        iteration === 1 ? 'failed approach: skipped checks; criterion still unmet' : 'review failed ' + iteration,
      ], costUsd: 0 }; },
    });
    await runner.start(${JSON.stringify({ ...contract, maxIterations: 12 })});
    await new Promise(() => {});`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source],
    { cwd: process.cwd(), timeout: 30_000, encoding: "utf8" });
  assert.equal(child.status, 46, child.stderr);
  const observed: string[] = [];
  const reopened = await openOuterRunner(dir, {
    async invoke(_contract, iteration, _requestId, _signal, _budget, context) {
      observed.push(context?.compactor?.compact(context.history ?? []) ?? "");
      return iteration < 12 ? { kind: "progress", evidence: [`review failed ${iteration}`], costUsd: 0 }
        : { kind: "verified", evidence: ["complete"], costUsd: 0 };
    },
  });
  try {
    const expected = createIterationContextCompactor().compact(reopened.ledger(contract.id));
    await reopened.wait(await reopened.start({ ...contract, maxIterations: 12 }));
    assert.equal(observed[0], expected);
    assert.match(observed[0]!, /failed approach: skipped checks/);
    assert.equal(reopened.get(contract.id)?.state, "done");
    assert.equal(observed.length, 6);
  } finally { await reopened.close(); }
});

test("missing preceding receipt blocks dispatch even with a compactor", async () => {
  const dir = fixtureDir();
  const source = `import { openOuterRunner } from './server/outer-runner.ts';
    import { RunContractStore } from './server/run-contract.ts';
    const original = RunContractStore.prototype.beginIteration;
    RunContractStore.prototype.beginIteration = function(...args) {
      if (args[1] === 1) process.exit(46);
      return original.apply(this, args);
    };
    const runner = await openOuterRunner(${JSON.stringify(dir)}, {
      async invoke() { return { kind: 'progress', evidence: ['first'], costUsd: 0 }; },
    });
    await runner.start(${JSON.stringify({ ...contract, maxIterations: 3 })});
    await new Promise(() => {});`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source],
    { cwd: process.cwd(), timeout: 30_000, encoding: "utf8" });
  assert.equal(child.status, 46, child.stderr);
  const db = new DatabaseSync(join(dir, "runtime.db"));
  try { db.prepare("DELETE FROM coding_run_steps WHERE run_id = ? AND sequence = 1").run(contract.id); }
  finally { db.close(); }
  let calls = 0;
  const reopened = await openOuterRunner(dir, {
    async invoke() { calls++; return { kind: "verified", evidence: ["must not dispatch"], costUsd: 0 }; },
  });
  try {
    await reopened.wait(await reopened.start({ ...contract, maxIterations: 3 }));
    assert.equal(calls, 0);
    assert.equal(reopened.get(contract.id)?.state, "blocked");
    assert.match(reopened.get(contract.id)?.evidence.join(" ") ?? "", /previous iteration receipt is missing/);
  } finally { await reopened.close(); }
});

test("repeated start returns the same durable task identity", async () => {
  const runner = await openOuterRunner(fixtureDir(), {
    async invoke() { return { kind: "verified", evidence: ["complete"], costUsd: 0 }; },
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
      return { kind: "progress", evidence: ["changes persisted"], costUsd: 0 };
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
  const runner = await openOuterRunner(fixtureDir(), { async invoke() { return { kind: "verified", evidence: ["complete"], costUsd: 0 }; } },
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
  const first = await openOuterRunner(dir, { async invoke() { return { kind: "verified", evidence: ["complete"], costUsd: 0 }; } },
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
      async invoke() { return { kind: 'verified', evidence: ['completed'], costUsd: 0 }; }
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
      return { kind: "verified", evidence: ["verified after retry"], costUsd: 0 };
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

test("a run pointing at a missing durable task is held instead of recreated", async () => {
  const dir = fixtureDir();
  const store = new RunContractStore(join(dir, "runtime.db"));
  store.create(contract, Date.now());
  store.bindTask(contract.id, 999999);
  store.close();
  await assert.rejects(openOuterRunner(dir, { async invoke() { throw new Error("unexpected work"); } }),
    /recorded run task identity requires reconciliation/);
  const reopened = new RunContractStore(join(dir, "runtime.db"));
  try { assert.equal(reopened.get(contract.id)?.state, "queued"); } finally { reopened.close(); }
});

test("a committed task without its run-task link is recovered without another task", async () => {
  const dir = fixtureDir();
  const source = `import { openOuterRunner } from './server/outer-runner.ts';
    import { RunContractStore } from './server/run-contract.ts';
    RunContractStore.prototype.bindTask = function() { process.stdout.write('task committed\\n'); process.exit(0); };
    const runner = await openOuterRunner(${JSON.stringify(dir)}, {
      async invoke() { throw new Error('unexpected work'); }
    });
    await runner.start(${JSON.stringify(contract)});
    setInterval(() => {}, 1000);`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /task committed/);
  const calls: string[] = [];
  const runner = await openOuterRunner(dir, {
    async invoke(_contract, _iteration, requestId) { calls.push(requestId); return { kind: "verified", evidence: ["recovered"] }; },
  });
  try {
    const taskId = await runner.start(contract);
    await runner.wait(taskId);
    assert.deepEqual(calls, [`${contract.id}:1`]);
    const store = new RunContractStore(join(dir, "runtime.db"));
    assert.equal(store.taskId(contract.id), taskId);
    store.close();
  } finally { await runner.close(); }
});

test("a finished effect without its task checkpoint resumes at the next step", async () => {
  const dir = fixtureDir();
  const source = `import { openOuterRunner } from './server/outer-runner.ts';
    import { RunContractStore } from './server/run-contract.ts';
    const original = RunContractStore.prototype.finishIteration;
    RunContractStore.prototype.finishIteration = function(id, sequence, requestId, state, at, evidence, costUsd) {
      const result = original.call(this, id, sequence, requestId, state, at, evidence, costUsd);
      if (state === 'waiting') { process.stdout.write('result stored\\n'); process.exit(0); }
      return result;
    };
    const runner = await openOuterRunner(${JSON.stringify(dir)}, {
      async invoke() { return { kind: 'progress', evidence: ['step one finished'], costUsd: 0 }; }
    });
    await runner.start(${JSON.stringify(contract)});
    await new Promise(() => {});`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /result stored/);
  const calls: number[] = [];
  const reopened = await openOuterRunner(dir, {
    async invoke(_contract, iteration) { calls.push(iteration); return { kind: "verified", evidence: ["verified next step"], costUsd: 0 }; },
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
        if (iteration === 1) return { kind: 'progress', evidence: ['first step completed'], costUsd: 0 };
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

test("configured crash limit parks the run with owner-visible restart_limit evidence", async () => {
  const dir = fixtureDir();
  const first = `import { openOuterRunner } from './server/outer-runner.ts';
    const runner = await openOuterRunner(${JSON.stringify(dir)}, {
      async invoke() { process.stdout.write('effect started\\n'); process.exit(0); }
    }, { restartLimit: 3 });
    await runner.start(${JSON.stringify(contract)});
    await new Promise(() => {});`;
  const initial = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", first],
    { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
  assert.equal(initial.status, 0, initial.stderr);
  assert.match(initial.stdout, /effect started/);
  const crash = `import { openOuterRunner } from './server/outer-runner.ts';
    import { RunContractStore } from './server/run-contract.ts';
    const get = RunContractStore.prototype.get;
    RunContractStore.prototype.get = function(id) {
      if (id === ${JSON.stringify(contract.id)}) { process.stdout.write('phase restarted\\n'); process.exit(0); }
      return get.call(this, id);
    };
    const runner = await openOuterRunner(${JSON.stringify(dir)}, {
      async invoke() { throw new Error('replayed outward effect'); }
    }, { restartLimit: 3 });
    runner.resume();
    await new Promise(() => {});`;
  for (let count = 0; count < 2; count += 1) {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", crash],
      { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /phase restarted/);
  }
  const runner = await openOuterRunner(dir, {
    async invoke() { throw new Error("replayed outward effect"); },
  }, { restartLimit: 3 });
  try {
    runner.resume();
    assert.equal(runner.get(contract.id)?.state, "blocked");
    assert.ok(runner.get(contract.id)?.evidence.some((entry) => entry.includes("restart_limit")));
  } finally { await runner.close(); }
  const store = new RunContractStore(join(dir, "runtime.db"));
  const id = store.taskId(contract.id) as TaskId<string>;
  store.close();
  let retried = 0;
  const Task = defineTask<{ id: string }, { phase: "iterate"; sequence: number }, string>({
    name: "openmausbot.outer-run", version: 1,
    initial: () => ({ phase: "iterate", sequence: 0 }),
    phases: { iterate: async (_task, runtime, context) => {
      retried += 1;
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "blocked" } }), context);
    } },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "openmausbot.outer-run", tasks: [Task] }));
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "coding-runs.sqlite")),
    { models: createModels(), registry, settings: { restartLimit: 3 } }, BACKGROUND_CONTEXT);
  try {
    assert.equal(retried, 0);
    await harness.retryTask(id, BACKGROUND_CONTEXT);
    const settled = await harness.waitForTask(id, BACKGROUND_CONTEXT);
    assert.equal(settled.state.outcome.status, "completed");
    assert.equal(retried, 1);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}, 60_000);

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

test("unconfigured unattended run stops with a terminal owner report before invoking work", async () => {
  let calls = 0;
  const runner = await openOuterRunner(fixtureDir(), { async invoke() { calls += 1; throw new Error("started"); } });
  try {
    await runner.wait(await runner.start({ ...contract, limits: undefined }));
    assert.equal(calls, 0);
    assert.equal(runner.get(contract.id)?.state, "blocked");
    assert.match(runner.report(contract.id)?.snapshot.evidence.join(" ") ?? "", /configure this bot's wall-clock and spend ceilings/);
  } finally { await runner.close(); }
});

test("wall-clock ceiling interrupts an active local run and reports the terminal result", async () => {
  let calls = 0;
  const runner = await openOuterRunner(fixtureDir(), { async invoke(_contract, _iteration, _requestId, signal) {
    calls += 1;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return { kind: "blocked" as const, evidence: ["work interrupted"], costUsd: 0 };
  } });
  try {
    await runner.wait(await runner.start({ ...contract, limits: { maxWallTimeMs: 350, maxSpendUsd: 1 } }));
    const snapshot = runner.get(contract.id)!;
    assert.equal(calls, 1);
    assert.equal(snapshot.state, "blocked");
    assert.ok(snapshot.elapsedMs >= 350);
    assert.ok(snapshot.evidence.some((line) => line.includes("wall-clock ceiling reached")));
    assert.equal(runner.report(contract.id)?.snapshot.state, "blocked");
    if (process.env.OMB_PARITY_PROOF_DIR) {
      mkdirSync(process.env.OMB_PARITY_PROOF_DIR, { recursive: true });
      appendFileSync(join(process.env.OMB_PARITY_PROOF_DIR, "run-limits-local-ceiling.log"),
        `worker interrupted; state=${snapshot.state}; elapsedMs=${snapshot.elapsedMs}; ` +
        `spentUsd=${snapshot.spentUsd}; report=${snapshot.evidence.at(-1)}\n`);
    }
  } finally { await runner.close(); }
});

test("spend ceiling carries through iterations and stops before another invocation", async () => {
  const calls: number[] = [];
  const runner = await openOuterRunner(fixtureDir(), { async invoke(_contract, iteration) {
    calls.push(iteration);
    return { kind: "progress" as const, evidence: ["work"], costUsd: 0.5 };
  } });
  try {
    await runner.wait(await runner.start({ ...contract, limits: { maxWallTimeMs: 30_000, maxSpendUsd: 1 } }));
    assert.deepEqual(calls, [1, 2]);
    assert.equal(runner.get(contract.id)?.spentUsd, 1);
    assert.equal(runner.get(contract.id)?.state, "blocked");
    assert.ok(runner.get(contract.id)?.evidence.some((line) => line.includes("spend ceiling reached")));
  } finally { await runner.close(); }
});

test("unknown spend stops without continuing and survives reopen", async () => {
  const dir = fixtureDir();
  const runner = await openOuterRunner(dir, { async invoke() {
    return { kind: "progress", evidence: ["usage could not be priced"] };
  } });
  try {
    await runner.wait(await runner.start(contract));
    assert.equal(runner.get(contract.id)?.spendUncertain, true);
    assert.equal(runner.get(contract.id)?.state, "blocked");
  } finally { await runner.close(); }
  const reopened = new RunContractStore(join(dir, "runtime.db"));
  try { assert.equal(reopened.get(contract.id)?.spendUncertain, true); }
  finally { reopened.close(); }
});

test("a queued run past its persisted deadline blocks on restart without an invocation", async () => {
  const dir = fixtureDir();
  const store = new RunContractStore(join(dir, "runtime.db"));
  store.create({ ...contract, limits: { maxWallTimeMs: 50, maxSpendUsd: 1 } }, Date.now() - 1_000);
  store.close();
  let calls = 0;
  const runner = await openOuterRunner(dir, { async invoke() { calls += 1; throw new Error("late work"); } });
  try {
    await runner.wait(await runner.start({ ...contract, limits: { maxWallTimeMs: 50, maxSpendUsd: 1 } }));
    assert.equal(calls, 0);
    assert.equal(runner.get(contract.id)?.state, "blocked");
    assert.ok(runner.get(contract.id)?.evidence.some((line) => line.includes("wall-clock ceiling reached")));
    await runner.start({ ...contract, limits: { maxWallTimeMs: 50, maxSpendUsd: 1 } });
    assert.equal(calls, 0);
    assert.equal(runner.get(contract.id)?.state, "blocked");
  } finally { await runner.close(); }
});

const crashEffects: CodingEffect[] = [
  { kind: "branch-push", repository: "owner/repo", ref: "review", expectedSha: "a".repeat(40) },
  { kind: "pr-open", repository: "owner/repo", head: "review", base: "main" },
  { kind: "pr-comment", repository: "owner/repo", pullNumber: 7, key: "effect-1" },
];

function recoveryForge(effect: CodingEffect, present: () => boolean, apply: () => void): EffectReconcileHost {
  return {
    async getBranchRef() { return present() ? { kind: "found" as const, sha: "a".repeat(40) } : { kind: "absent" as const }; },
    async findPullRequests() { return present()
      ? { kind: "found" as const, prs: [{ number: 7, headSha: "a".repeat(40), state: "open" }] }
      : { kind: "absent" as const }; },
    async findCommentsByIdempotencyKey() { return present()
      ? { kind: "found" as const, ids: [15] } : { kind: "absent" as const }; },
    async applyMissing(receipt) { assert.deepEqual(receipt.effect, effect); apply(); },
  };
}

for (const effect of crashEffects) {
  for (const boundary of ["prepared", "applied", "confirmed"]) {
    test(`SIGKILL ${effect.kind} at ${boundary} resumes without repeating an effect or worker turn`, async () => {
      const dir = fixtureDir();
      const receiptPath = join(dir, "effects.sqlite");
      const marker = join(dir, "effect.txt");
      const source = `import { writeFileSync } from 'node:fs';
        import { openOuterRunner } from './server/outer-runner.ts';
        import { CodingEffectReceipts } from './server/coding-effect-receipts.ts';
        const runner = await openOuterRunner(${JSON.stringify(dir)}, {
          async invoke() {
            const receipts = new CodingEffectReceipts(${JSON.stringify(receiptPath)});
            const receipt = receipts.prepare(${JSON.stringify(contract.id)}, 1, 'effect-1', ${JSON.stringify(effect)});
            receipts.saveResult(${JSON.stringify(contract.id)}, 1, ${JSON.stringify(contract.id + ":1")},
              { kind: 'verified', evidence: ['saved verified result'], costUsd: 0 });
            if (${JSON.stringify(boundary)} !== 'prepared') writeFileSync(${JSON.stringify(marker)}, 'one');
            if (${JSON.stringify(boundary)} === 'confirmed') receipts.confirm(receipt);
            receipts.close();
            process.stdout.write('effect boundary\\n');
            return new Promise(() => {});
          }
        });
        await runner.start(${JSON.stringify(contract)});
        setInterval(() => {}, 1000);`;
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`effect boundary timed out: ${stderr}`)), 15_000);
          child.stdout?.on("data", (chunk) => {
            if (String(chunk).includes("effect boundary")) { clearTimeout(timeout); resolve(); }
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
      const receipts = new CodingEffectReceipts(receiptPath);
      let outwardCalls = existsSync(marker) ? 1 : 0;
      let workerCalls = 0;
      const forge = recoveryForge(effect, () => outwardCalls > 0, () => {
        outwardCalls += 1; writeFileSync(marker, "one");
      });
      const runner = await openOuterRunner(dir, {
        async invoke() { workerCalls += 1; throw new Error("worker turn repeated"); },
      }, { effectRecovery: { receipts, host: forge,
        async recoverResult(_contract, iteration, requestId) { return receipts.savedResult(contract.id, iteration, requestId); },
      } });
      try {
        runner.resume();
        for (let i = 0; i < 100 && runner.get(contract.id)?.state !== "done"; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(runner.get(contract.id)?.state, "done", JSON.stringify(runner.get(contract.id)?.evidence));
        assert.equal(outwardCalls, 1);
        assert.equal(workerCalls, 0);
        assert.equal(receipts.list(contract.id, 1)[0]?.status, "confirmed");
        assert.equal(readFileSync(marker, "utf8"), "one");
      } finally { await runner.close(); receipts.close(); }
    }, 30_000);
  }
}

test("inconclusive forge inspection holds a crashed run and reports the reason", async () => {
  const dir = fixtureDir();
  const receiptPath = join(dir, "effects.sqlite");
  const source = `import { openOuterRunner } from './server/outer-runner.ts';
    import { CodingEffectReceipts } from './server/coding-effect-receipts.ts';
    const runner = await openOuterRunner(${JSON.stringify(dir)}, { async invoke() {
      const receipts = new CodingEffectReceipts(${JSON.stringify(receiptPath)});
      receipts.prepare(${JSON.stringify(contract.id)}, 1, 'effect-1', ${JSON.stringify(crashEffects[0])});
      receipts.close();
      process.stdout.write('prepared effect\\n');
      process.exit(0);
    } });
    await runner.start(${JSON.stringify(contract)});
    await new Promise(() => {});`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /prepared effect/);
  const receipts = new CodingEffectReceipts(receiptPath);
  const forge = recoveryForge(crashEffects[0]!, () => false, () => { throw new Error("must not write"); });
  forge.getBranchRef = async () => ({ kind: "inconclusive", reason: "authorization failed" });
  const runner = await openOuterRunner(dir, { async invoke() { throw new Error("must not replay"); } },
    { effectRecovery: { receipts, host: forge,
      async recoverResult() { return { kind: "verified", evidence: ["saved result"], costUsd: 0 }; },
    } });
  try {
    await runner.wait(await runner.start(contract));
    assert.equal(runner.get(contract.id)?.state, "blocked");
    assert.ok(runner.report(contract.id)?.snapshot.evidence.some((line) => line.includes("branch revision could not be verified")));
  } finally { await runner.close(); receipts.close(); }
});
