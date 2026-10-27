import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { ensureDirs } from "./config.ts";
import { PiDriver } from "./drivers/pi.ts";
import { createCodingWorkerHost } from "./coding-worker-host.ts";
import { codingWorkspaceBranch } from "./coding-treehouse-workspace.ts";
import { openCodingRunRuntime } from "./coding-run-runtime.ts";
import type { TriggerTemplate } from "./run-triggers.ts";
import type { RuntimeEvent } from "./contracts.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-pi-cli.ts");
const roleDir = join(process.cwd(), "node_modules", ".cache");
mkdirSync(roleDir, { recursive: true });
const rolesFilePath = join(roleDir, "coding-worker-roles.json");
writeFileSync(rolesFilePath, JSON.stringify({ schema: "pstack-model-roles.v1", roles: {
  development: "fixture/development", "independent-review": "fixture/review",
} }));

test("a Pi turn fails closed when the skill is not loaded", async () => {
  const instance = await PiDriver.create({ instanceId: "missing-skill-fixture", displayName: "fixture",
    environment: { FAKE_PI_MISSING_SKILL: "1" }, enabled: true, config: { cli, fullAuto: false } });
  try {
    await assert.rejects(instance.adapter.sendTurn({ threadId: "missing-skill", text: "check",
      cwd: process.cwd(), approvalMode: "ask" }), /did not load poteto-mode-pi/);
  } finally { await instance.dispose(); }
});

test("missing or invalid role maps block before workspace acquisition", async () => {
  let acquired = false;
  const base = { roles: new Map([["fixture/agents", { development: "fixture/development",
    independentReview: "fixture/review", developmentBotId: "worker", reviewerBotId: "reviewer" }]]),
    workspace: { async acquire() { acquired = true; throw new Error("should not acquire"); }, async release() {} },
    turn: { async run() { throw new Error("should not dispatch"); } },
    async verify() { return null; },
  };
  assert.equal(await createCodingWorkerHost(base).roles("fixture/agents"), null);
  const missing = createCodingWorkerHost({ ...base, rolesFilePath: join(roleDir, "absent-roles.json") });
  assert.equal(await missing.roles("fixture/agents"), null);
  const invalid = join(roleDir, "invalid-coding-roles.json");
  writeFileSync(invalid, JSON.stringify({ schema: "wrong", roles: {} }));
  assert.equal(await createCodingWorkerHost({ ...base, rolesFilePath: invalid }).roles("fixture/agents"), null);
  assert.equal(acquired, false);
});

test("worker route launches the existing fake process with the scoped approval mode and captures its output", async () => {
  ensureDirs();
  chmodSync(cli, 0o755);
  const instance = await PiDriver.create({ instanceId: "coding-fixture", displayName: "fixture",
    environment: {}, enabled: true, config: { cli, fullAuto: false } });
  const workspace = { repository: "fixture/agents", directory: process.cwd(), branch: codingWorkspaceBranch("request"),
    baseBranch: "main", base: "main", leaseId: "fixture-lease" };
  const seen: RuntimeEvent[] = [];
  const unsubscribe = instance.adapter.onEvent((event) => { seen.push(event); });
  const host = createCodingWorkerHost({
    rolesFilePath,
    roles: new Map([[workspace.repository, { development: "fixture/development", independentReview: "fixture/review",
      developmentBotId: "worker", reviewerBotId: "reviewer" }]]),
    workspace: { async acquire(_contract, requestId) { return { ...workspace, branch: codingWorkspaceBranch(requestId) }; }, async release() {} },
    turn: { async run({ botId, prompt, requestId, signal }) {
      assert.ok(["worker", "reviewer"].includes(botId));
      if (botId === "reviewer") assert.match(prompt, /coding_command \{"command":"diff","revision":"fixture-revision"\}/);
      assert.equal(signal.aborted, false);
      const threadId = `${botId}:${requestId}`;
      const done = new Promise<RuntimeEvent>((resolve) => {
        const off = instance.adapter.onEvent((event) => {
          if (event.type === "turn.completed" && event.threadId === threadId) { off(); resolve(event); }
        });
      });
      await instance.adapter.sendTurn({ threadId, text: prompt, cwd: workspace.directory, approvalMode: "ask" });
      await done;
      const text = seen.findLast((event) => event.type === "item.completed" && event.threadId === threadId &&
        event.itemType === "assistant_text");
      if (!text || text.type !== "item.completed" || text.itemType !== "assistant_text") throw new Error("fake process produced no text");
      return { revision: "fixture-revision", evidence: [text.text], accepted: true, costUsd: 0 };
    } },
    async verify() { return ["fixture verification"]; },
  });
  try {
    const contract = { id: "00000000-0000-4000-8000-000000000001", botId: "origin", repository: workspace.repository,
      ref: workspace.baseBranch, repositoryClass: "agent-private" as const, successCriteria: ["respond"], allowedEffects: ["edit" as const] };
    const acquired = await host.acquire(contract, "request");
    const report = await host.runPlaybook(acquired, "fixture/development", "respond", "request", new AbortController().signal);
    assert.deepEqual(report.evidence, ["Hello from pi"]);
    const review = await host.review(acquired, "fixture/review", report.revision, new AbortController().signal);
    assert.deepEqual(review.evidence, ["Hello from pi"]);
    assert.equal(review.accepted, true);
    assert.equal(seen.filter((event) => event.type === "turn.completed").length, 2);
  } finally {
    unsubscribe();
    await instance.dispose();
  }
});

test("a schedule and a webhook delivery reach the real WorkerHost and settle in isolated storage", async () => {
  ensureDirs();
  chmodSync(cli, 0o755);
  const instance = await PiDriver.create({ instanceId: "coding-trigger-fixture", displayName: "fixture",
    environment: {}, enabled: true, config: { cli, fullAuto: false } });
  const workspace = { repository: "fixture/agents", directory: process.cwd(), branch: codingWorkspaceBranch("fixture"),
    baseBranch: "main", base: "main", leaseId: "trigger-lease" };
  const scratch = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(scratch, { recursive: true });
  const dataDir = mkdtempSync(join(scratch, "coding-trigger-live-"));
  const workerTurns: string[] = [];
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const host = createCodingWorkerHost({
    rolesFilePath,
    roles: new Map([[workspace.repository, { development: "fixture/development", independentReview: "fixture/review",
      developmentBotId: "worker", reviewerBotId: "reviewer" }]]),
    workspace: { async acquire(_contract, requestId) { return { ...workspace, branch: codingWorkspaceBranch(requestId) }; }, async release() {} },
    turn: { async run({ botId, prompt, requestId }) {
      const threadId = `${botId}:${requestId}`;
      const events: RuntimeEvent[] = [];
      const done = new Promise<void>((resolve) => {
        const off = instance.adapter.onEvent((event) => {
          if (event.threadId !== threadId) return;
          events.push(event);
          if (event.type === "turn.completed") { off(); resolve(); }
        });
      });
      await instance.adapter.sendTurn({ threadId, text: prompt, cwd: workspace.directory, approvalMode: "ask" });
      await done;
      const answer = events.findLast((event) => event.type === "item.completed" && event.itemType === "assistant_text");
      if (!answer || answer.type !== "item.completed" || answer.itemType !== "assistant_text") {
        throw new Error("fixture worker returned no text");
      }
      workerTurns.push(botId);
      return { revision, evidence: [answer.text], accepted: true, costUsd: 0 };
    } },
    async verify() { return ["fixture verification"]; },
  });
  const template: TriggerTemplate = { botId: "origin", repository: workspace.repository, ref: workspace.baseBranch,
    repositoryClass: "agent-private", successCriteria: ["respond"], checkCommand: ["node", "-e", "process.exit(0)"], allowedEffects: ["edit"], authorisedExternalWrites: [],
    limits: { maxWallTimeMs: 30_000, maxSpendUsd: 1 } };
  const runtime = await openCodingRunRuntime({ dataDir, workerHost: host,
    routines: new Map([["routine", template]]), webhooks: new Map([["hook", template]]), github: new Map() });
  try {
    const schedule = await runtime.scheduled({ id: "occurrence", routineId: "routine", botId: "origin",
      scheduledFor: 100, triggerSource: "schedule", status: "running" });
    if (!("id" in schedule)) throw new Error("missing schedule identity");
    for (let attempt = 0; attempt < 200 && runtime.get(schedule.id)?.state !== "done"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(runtime.get(schedule.id)?.state, "done", JSON.stringify(runtime.get(schedule.id)?.evidence));
    const event = await runtime.webhook({ id: "delivery-run", routineId: "hook", botId: "origin",
      webhookId: "hook", deliveryId: "delivery-1", triggerSource: "webhook", status: "running" });
    if (!("id" in event)) throw new Error("missing event identity");
    for (let attempt = 0; attempt < 200 && runtime.get(event.id)?.state !== "done"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(runtime.get(event.id)?.state, "done", JSON.stringify(runtime.get(event.id)?.evidence));
    assert.equal((await runtime.scheduled({ id: "occurrence", routineId: "routine", botId: "origin",
      scheduledFor: 100, triggerSource: "schedule", status: "running" })).status, "existing");
    assert.equal((await runtime.webhook({ id: "delivery-run", routineId: "hook", botId: "origin",
      webhookId: "hook", deliveryId: "delivery-1", triggerSource: "webhook", status: "running" })).status, "existing");
    assert.deepEqual(workerTurns.sort(), ["reviewer", "reviewer", "worker", "worker"]);
    console.log("isolated WorkerHost: schedule done; webhook done; four fake-engine role turns; replay unchanged");
  } finally {
    await runtime.close();
    await instance.dispose();
  }
});
