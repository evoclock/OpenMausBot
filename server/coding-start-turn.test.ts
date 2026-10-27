import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { test } from "vitest";
import { createCodingStartTurnPort } from "./coding-start-turn.ts";
import type { Store } from "./store.ts";
import type { IsolatedWorkspace } from "./inner-worker-route.ts";

const cwd = process.cwd();
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const workspace: IsolatedWorkspace = { repository: "fixture/agents", directory: cwd, branch: "omb/coding-fixture",
  baseBranch: "main", base: "main", leaseId: "lease" };

test("coding turn pins an allowed model and reports the model that completed the turn", async () => {
  let selected = { instanceId: "pi", model: "openai-codex/gpt-6-sol" };
  const messages = [{ role: "bot" as const, kind: "text" as const, text: `ACCEPT ${revision}`, turnTerminal: true }];
  const store = {
    bot: () => ({ id: "worker" }), tasks: () => [],
    createTask: () => ({ threadId: "thread", createdAt: 1 }),
    patchTask: () => ({}), messagesFor: () => messages,
    switchTaskModel(_botId: string, _threadId: string, model: typeof selected) { selected = model; return {}; },
    projectBotForTask: () => ({ modelSelection: selected }),
  } as unknown as Store;
  const port = createCodingStartTurnPort({ store, assertActiveRun: () => {}, driverKind: () => "piAgent",
    modelChain: () => [{ instanceId: "pi", model: "dsf41/deepseek-v4.1-flash-tf" }],
    costForThread: async () => null,
    async startTurn(_botId, _text, { onTurnSettled }) {
      assert.equal(selected.model, "dsf41/deepseek-v4.1-flash-tf");
      onTurnSettled();
    }, async interrupt() {},
  });
  const result = await port.run({ botId: "worker", workspace, role: "review", prompt: "Review",
    requestId: "review:local", signal: new AbortController().signal });
  assert.deepEqual(result.modelUsed, { instanceId: "pi", model: "dsf41/deepseek-v4.1-flash-tf" });
});

test("coding turn pins closed mode before dispatch and refuses replay", async () => {
  const tasks: Array<{ title: string; threadId: string; cwd?: string }> = [];
  const messages: Array<{ id: string; role: "bot"; kind: "text"; text: string; turnTerminal: boolean }> = [];
  let pinned: unknown;
  let initialMode: unknown;
  const store = {
    bot: () => ({ id: "worker" }),
    tasks: () => tasks,
    createTask(_botId: string, title: string, _persistent: boolean, _unused1: unknown, _unused2: unknown, approvalMode: unknown) {
      initialMode = approvalMode;
      const task = { title, threadId: "thread-1", cwd, createdAt: 1 };
      tasks.push(task);
      return task;
    },
    patchTask(_botId: string, _threadId: string, patch: unknown) { pinned = patch; return tasks[0]; },
    messagesFor: () => messages,
  } as unknown as Pick<Store, "bot" | "tasks" | "createTask" | "patchTask" | "messagesFor">;
  const port = createCodingStartTurnPort({ store, assertActiveRun: () => {}, driverKind: () => "piAgent",
    costForThread: async () => 0,
    async startTurn(_botId, _text, { requestId, onTurnSettled }) {
      assert.equal(requestId, "review:1");
      assert.equal(initialMode, "full");
      assert.deepEqual(pinned, { cwd, approvalMode: "full" });
      messages.push({ id: "answer", role: "bot", kind: "text", text: `ACCEPT ${revision}`, turnTerminal: true });
      onTurnSettled();
    },
    async interrupt() {},
  });
  const signal = new AbortController().signal;
  const result = await port.run({ botId: "worker", workspace, role: "review", prompt: "Review", requestId: "review:1", signal });
  assert.deepEqual(result, { revision, evidence: [`ACCEPT ${revision}`], accepted: true, costUsd: 0 });
  await assert.rejects(port.run({ botId: "worker", workspace, role: "review", prompt: "Review", requestId: "review:1", signal }),
    /already completed/);
});

test("coding turn chases a stalled turn once after the server releases its thread", async () => {
  const tasks: Array<{ title: string; threadId: string; cwd: string; createdAt: number }> = [];
  const messages = new Map<string, Array<{ role: "bot"; kind: "text"; text: string; turnTerminal: boolean; turnSucceeded?: boolean }>>();
  const calls: Array<{ text: string; threadId: string }> = [];
  let releaseStall!: () => void;
  let signalStall!: () => void;
  const stallObserved = new Promise<void>((resolve) => { signalStall = resolve; });
  let activeAssertions = 0;
  const store = {
    bot: () => ({ id: "worker" }),
    tasks: () => tasks,
    createTask(_botId: string, title: string) {
      const task = { title, threadId: `thread-${tasks.length + 1}`, cwd, createdAt: tasks.length + 1 };
      tasks.push(task);
      return task;
    },
    patchTask: () => ({}),
    messagesFor: (threadId: string) => messages.get(threadId) ?? [],
    switchTaskModel: () => ({}),
    projectBotForTask: (_botId: string, threadId: string) => ({ modelSelection: {
      instanceId: "pi", model: threadId === "thread-1" ? "first-model" : "chase-model",
    } }),
  } as unknown as Store;
  const port = createCodingStartTurnPort({ store, assertActiveRun: () => { activeAssertions++; }, driverKind: () => "piAgent",
    modelChain: () => [{ instanceId: "pi", model: "first-model" }], costForThread: async () => 2,
    async startTurn(_botId, text, options: { threadId: string; onTurnSettled: () => void;
      onTurnStalled?: (released: Promise<void>) => void }) {
      calls.push({ text, threadId: options.threadId });
      if (calls.length === 1) {
        assert.ok(options.onTurnStalled);
        const released = new Promise<void>((resolve) => { releaseStall = resolve; });
        options.onTurnStalled(released);
        signalStall();
      } else {
        messages.set(options.threadId, [{ role: "bot", kind: "text", text: `ACCEPT ${revision}`, turnTerminal: true }]);
      }
      options.onTurnSettled();
    },
    async interrupt() {},
  });
  const running = port.run({ botId: "worker", workspace, role: "review", prompt: "Review this revision", requestId: "review:stalled", signal: new AbortController().signal });
  await stallObserved;
  assert.equal(calls.length, 1);
  releaseStall();
  const result = await running;
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.text, /one bounded chase/i);
  assert.match(calls[1]!.text, /Review this revision/);
  assert.deepEqual(result.modelsUsed, [
    { instanceId: "pi", model: "first-model" },
    { instanceId: "pi", model: "chase-model" },
  ]);
  assert.equal(result.modelUsed?.model, "chase-model");
  assert.equal(result.costUsd, 4);
  assert.equal(activeAssertions, 2);
  assert.equal(new Set(tasks.map((task) => task.title)).size, 2);
});

test("coding turn chases a repeated in-turn tool failure once", async () => {
  type CodingMessage = { role: "bot"; kind: "text" | "activity"; text?: string; turnTerminal?: boolean;
    turnSucceeded?: boolean; turnId?: string; at: number; tool?: { name: string; ok?: boolean; output?: string } };
  const tasks: Array<{ title: string; threadId: string; cwd: string; createdAt: number }> = [];
  const messages = new Map<string, CodingMessage[]>();
  const calls: string[] = [];
  const store = {
    bot: () => ({ id: "worker" }),
    tasks: () => tasks,
    createTask(_botId: string, title: string) {
      const task = { title, threadId: `thread-${tasks.length + 1}`, cwd, createdAt: tasks.length + 1 };
      tasks.push(task);
      return task;
    },
    patchTask: () => ({}),
    messagesFor: (threadId: string) => messages.get(threadId) ?? [],
    switchTaskModel: () => ({}),
  } as unknown as Store;
  const port = createCodingStartTurnPort({ store, assertActiveRun: () => {}, driverKind: () => "piAgent",
    costForThread: async () => 1,
    async startTurn(_botId, text, options: { threadId: string; onTurnSettled: () => void }) {
      calls.push(text);
      messages.set(options.threadId, calls.length === 1 ? [
        ...[1, 2, 3].map((at) => ({ role: "bot" as const, kind: "activity" as const, at, turnId: "turn-1",
          tool: { name: "mcp__agents__send", ok: false, output: "no layer" } })),
        { role: "bot", kind: "text", at: 4, turnId: "turn-1", text: "The tool failed three times.", turnTerminal: true },
      ] : [{ role: "bot", kind: "text", at: 5, turnId: "turn-2", text: `ACCEPT ${revision}`, turnTerminal: true }]);
      options.onTurnSettled();
    }, async interrupt() {},
  });
  const result = await port.run({ botId: "worker", workspace, role: "review", prompt: "Review this revision",
    requestId: "review:loop", signal: new AbortController().signal });
  assert.equal(calls.length, 2);
  assert.match(calls[1]!, /one bounded chase/i);
  assert.equal(result.revision, revision);
  assert.equal(result.costUsd, 2);
});

test("coding turn does not chase a completed turn with no answer", async () => {
  const tasks: Array<{ title: string; threadId: string; cwd: string; createdAt: number }> = [];
  let calls = 0;
  const store = {
    bot: () => ({ id: "worker" }),
    tasks: () => tasks,
    createTask(_botId: string, title: string) {
      const task = { title, threadId: `thread-${tasks.length + 1}`, cwd, createdAt: tasks.length + 1 };
      tasks.push(task);
      return task;
    },
    patchTask: () => ({}),
    messagesFor: () => [],
    switchTaskModel: () => ({}),
  } as unknown as Store;
  const port = createCodingStartTurnPort({ store, assertActiveRun: () => {}, driverKind: () => "piAgent",
    costForThread: async () => 1,
    async startTurn(_botId, _text, options: { onTurnSettled: () => void }) {
      calls++;
      options.onTurnSettled();
    }, async interrupt() {},
  });
  await assert.rejects(port.run({ botId: "worker", workspace, role: "development", prompt: "Implement fixture change",
    requestId: "run:empty", signal: new AbortController().signal }), /no completed answer/);
  assert.equal(calls, 1);
  assert.equal(tasks.length, 1);
});

test("a failed turn with no answer reports the Pi error instead of a missing answer", async () => {
  const tasks: Array<{ title: string; threadId: string; cwd: string; createdAt: number }> = [];
  const messages = [
    { role: "bot" as const, kind: "activity" as const, tool: { name: "error: pi process exited before replying: Coding run denied: closed profile is invalid", ok: false } },
    { role: "bot" as const, kind: "digest" as const, text: "[digest]", turnId: "turn", turnSucceeded: false },
  ];
  const store = {
    bot: () => ({ id: "reviewer" }), tasks: () => tasks,
    createTask(_botId: string, title: string) {
      const task = { title, threadId: "thread-1", cwd, createdAt: 1 };
      tasks.push(task);
      return task;
    },
    patchTask: () => ({}), messagesFor: () => messages, switchTaskModel: () => ({}),
  } as unknown as Store;
  const port = createCodingStartTurnPort({ store, assertActiveRun: () => {}, driverKind: () => "piAgent",
    costForThread: async () => 0,
    async startTurn(_botId, _text, options: { onTurnSettled: () => void }) { options.onTurnSettled(); },
    async interrupt() {},
  });
  await assert.rejects(port.run({ botId: "reviewer", workspace, role: "review", prompt: "Review",
    requestId: "review:failed", signal: new AbortController().signal }),
  /did not complete successfully: pi process exited before replying: Coding run denied: closed profile is invalid/);
});

test("coding turn surfaces BLOCKED after exactly one blocked chase", async () => {
  const tasks: Array<{ title: string; threadId: string; cwd: string; createdAt: number }> = [];
  const messages = new Map<string, Array<{ role: "bot"; kind: "text"; text: string; turnTerminal: boolean; turnSucceeded?: boolean }>>();
  let calls = 0;
  const store = {
    bot: () => ({ id: "worker" }),
    tasks: () => tasks,
    createTask(_botId: string, title: string) {
      const task = { title, threadId: `thread-${tasks.length + 1}`, cwd, createdAt: tasks.length + 1 };
      tasks.push(task);
      return task;
    },
    patchTask: () => ({}),
    messagesFor: (threadId: string) => messages.get(threadId) ?? [],
    switchTaskModel: () => ({}),
    projectBotForTask: () => ({ modelSelection: { instanceId: "pi", model: "fixture-model" } }),
  } as unknown as Store;
  const port = createCodingStartTurnPort({ store, assertActiveRun: () => {}, driverKind: () => "piAgent",
    costForThread: async () => 1,
    async startTurn(_botId, _text, options: { threadId: string; onTurnSettled: () => void }) {
      calls++;
      messages.set(options.threadId, [{ role: "bot", kind: "text", text: "BLOCKED: fixture obstruction",
        turnTerminal: true, turnSucceeded: false }]);
      options.onTurnSettled();
    }, async interrupt() {},
  });
  const result = await port.run({ botId: "worker", workspace, role: "development", prompt: "Implement fixture change",
    requestId: "run:blocked", signal: new AbortController().signal });
  assert.equal(calls, 2);
  assert.equal(tasks.length, 2);
  assert.equal(result.blocked, true);
  assert.equal(result.costUsd, 2);
  assert.match(result.evidence.join("\n"), /BLOCKED/);
});
