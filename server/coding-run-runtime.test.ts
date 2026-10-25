import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openCodingRunRuntime } from "./coding-run-runtime.ts";
import { CodingEffectReceipts } from "./coding-effect-receipts.ts";
import type { WorkerHost } from "./inner-worker-route.ts";
import { webhookCodingRunId, type TriggerTemplate } from "./run-triggers.ts";

const template: TriggerTemplate = {
  botId: "fixture", repository: "fixture/agents", ref: "review", repositoryClass: "agent-private",
  successCriteria: ["pstack verifies the goal"], checkCommand: ["node", "-e", "process.exit(0)"], allowedEffects: ["edit"], authorisedExternalWrites: [],
  limits: { maxWallTimeMs: 30_000, maxSpendUsd: 1 },
};

function fixtureDir() {
  const scratch = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(scratch, { recursive: true });
  return mkdtempSync(join(scratch, "coding-runtime-"));
}

function host(calls: string[]): WorkerHost {
  return {
    async roles() { return { development: "development-role", independentReview: "review-role" }; },
    async acquire(contract) { return { repository: contract.repository, directory: "isolated",
      branch: "review", base: "base", leaseId: "lease" }; },
    async release() { calls.push("release"); },
    async runPlaybook(_workspace, role) { calls.push(role); return { revision: "revision", evidence: ["work"], progress: true, costUsd: 0 }; },
    async review(_workspace, role, revision) { calls.push(role); return { revision, accepted: true, evidence: ["review"], costUsd: 0 }; },
    async verifyWithPstack() { calls.push("pstack-check"); return ["verified"]; },
    async runHostCheck(_workspace, command, revision) { calls.push("host-check"); return { command, exitCode: 0, commitSha: revision, startedAt: Date.now(), durationMs: 1, timedOut: false, outputTail: "" }; },
  };
}

async function settled(runtime: Awaited<ReturnType<typeof openCodingRunRuntime>>, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = runtime.get(id)?.state;
    if (state === "done" || state === "blocked") return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("fixture run did not settle");
}

test("a scheduled occurrence and signed event drive the same outer/inner route", async () => {
  const calls: string[] = [];
  const dataDir = fixtureDir();
  const runtime = await openCodingRunRuntime({ dataDir, workerHost: host(calls),
    routines: new Map([["routine", template]]), github: new Map([["registration", { secret: "fixture-secret", template }]]) });
  try {
    const run = { id: "occurrence", routineId: "routine", botId: "fixture", scheduledFor: 100,
      triggerSource: "schedule", status: "running" };
    const scheduled = await runtime.scheduled(run);
    assert.equal(scheduled.status, "accepted");
    if (!("id" in scheduled)) throw new Error("missing scheduled id");
    assert.equal(await settled(runtime, scheduled.id), "done");
    const receipts = new CodingEffectReceipts(join(dataDir, "effect-receipts.sqlite"));
    try {
      expect(receipts.savedResult(scheduled.id, 1, `${scheduled.id}:1`)).toMatchObject({
        kind: "verified", evidence: ["work", "review", "verified"], costUsd: 0, hostCheck: { exitCode: 0 },
      });
    } finally { receipts.close(); }
    assert.equal((await runtime.scheduled(run)).status, "existing");
    const nextOccurrence = await runtime.scheduled({ ...run, id: "next-occurrence", scheduledFor: 200 });
    assert.equal(nextOccurrence.status, "accepted");
    if (!("id" in nextOccurrence)) throw new Error("missing next occurrence id");
    assert.equal(await settled(runtime, nextOccurrence.id), "done");

    const raw = Buffer.from(JSON.stringify({ action: "completed", repository: { full_name: template.repository } }));
    const input = { raw, event: "workflow_run", deliveryId: "11111111-1111-4111-8111-111111111111",
      signature: `sha256=${createHmac("sha256", "fixture-secret").update(raw).digest("hex")}` };
    const received = await runtime.github("registration", input);
    assert.equal(received.status, "accepted");
    if (!("id" in received)) throw new Error("missing webhook id");
    assert.equal(await settled(runtime, received.id), "done");
    assert.equal((await runtime.github("registration", input)).status, "existing");
    assert.deepEqual(calls, ["development-role", "review-role", "pstack-check", "host-check",
      "development-role", "review-role", "pstack-check", "host-check",
      "development-role", "review-role", "pstack-check", "host-check"]);
    await assert.rejects(runtime.github("registration", { ...input, raw: Buffer.from("changed") }), /authentication/);
  } finally { await runtime.close(); }
});

test("failed host check blocks completion and persists its record", async () => {
  const calls: string[] = [];
  const workerHost = host(calls);
  workerHost.runHostCheck = async (_workspace, _command, revision) => ({ command: ["node", "-e", "process.exit(1)"], exitCode: 1,
    commitSha: revision, startedAt: Date.now(), durationMs: 1, timedOut: false, outputTail: "failed" });
  const runtime = await openCodingRunRuntime({ dataDir: fixtureDir(), workerHost,
    routines: new Map([["routine", template]]), github: new Map() });
  try {
    const accepted = await runtime.scheduled({ id: "failed-check", routineId: "routine", botId: "fixture",
      scheduledFor: 100, triggerSource: "schedule", status: "running" });
    if (!("id" in accepted)) throw new Error("missing run id");
    expect(await settled(runtime, accepted.id)).toBe("blocked");
    expect(runtime.get(accepted.id)).toMatchObject({ state: "blocked", hostCheck: { exitCode: 1, outputTail: "failed" } });
  } finally { await runtime.close(); }
});

test("concurrent re-fire does not start two workers for one occurrence", async () => {
  const calls: string[] = [];
  const runtime = await openCodingRunRuntime({ dataDir: fixtureDir(), workerHost: host(calls),
    routines: new Map([["routine", template]]), github: new Map() });
  try {
    const run = { id: "occurrence", routineId: "routine", botId: "fixture", scheduledFor: 100,
      triggerSource: "schedule", status: "running" };
    const results = await Promise.all([runtime.scheduled(run), runtime.scheduled(run)]);
    const ids = results.map((result) => "id" in result ? result.id : undefined);
    assert.deepEqual(results.map((result) => result.status).sort(), ["accepted", "existing"]);
    assert.ok(ids[0]);
    assert.equal(ids[0], ids[1]);
    assert.equal(await settled(runtime, ids[0]), "done");
    assert.deepEqual(calls, ["development-role", "review-role", "pstack-check", "host-check"]);
  } finally { await runtime.close(); }
});

test("verified webhook delivery runs once and survives restart replay", async () => {
  const calls: string[] = [];
  const options = { dataDir: fixtureDir(), workerHost: host(calls), routines: new Map<string, TriggerTemplate>(),
    github: new Map(), webhooks: new Map([["hook", template]]) };
  const run = { id: "webhook-run", routineId: "hook", botId: "fixture", webhookId: "hook",
    deliveryId: "delivery-1", triggerSource: "webhook", status: "running" };
  const first = await openCodingRunRuntime(options);
  try {
    assert.equal((await first.webhook({ ...run, webhookId: "other" })).status, "ignored");
    assert.equal((await first.webhook({ ...run, routineId: "other" })).status, "ignored");
    assert.equal((await first.webhook({ ...run, deliveryId: undefined })).status, "ignored");
    const accepted = await first.webhook(run);
    assert.equal(accepted.status, "accepted");
    if (!("id" in accepted)) throw new Error("missing webhook id");
    assert.equal(accepted.id, webhookCodingRunId("hook", "delivery-1"));
    assert.equal(await settled(first, accepted.id), "done");
    assert.equal((await first.webhook(run)).status, "existing");
  } finally { await first.close(); }
  const replay = await openCodingRunRuntime(options);
  try {
    assert.equal((await replay.webhook(run)).status, "existing");
    assert.deepEqual(calls, ["development-role", "review-role", "pstack-check", "host-check"]);
  } finally { await replay.close(); }
});

test("restart replay retains both trigger identities without starting another worker", async () => {
  const calls: string[] = [];
  const dataDir = fixtureDir();
  const options = { dataDir, workerHost: host(calls), routines: new Map([["routine", template]]),
    github: new Map([["registration", { secret: "fixture-secret", template }]]) };
  const occurrence = { id: "occurrence", routineId: "routine", botId: "fixture", scheduledFor: 100,
    triggerSource: "schedule", status: "running" };
  const raw = Buffer.from(JSON.stringify({ action: "completed", repository: { full_name: template.repository } }));
  const event = { raw, event: "workflow_run", deliveryId: "11111111-1111-4111-8111-111111111111",
    signature: `sha256=${createHmac("sha256", "fixture-secret").update(raw).digest("hex")}` };
  const first = await openCodingRunRuntime(options);
  try {
    const schedule = await first.scheduled(occurrence);
    const webhook = await first.github("registration", event);
    if (!("id" in schedule) || !("id" in webhook)) throw new Error("missing trigger id");
    assert.equal(await settled(first, schedule.id), "done");
    assert.equal(await settled(first, webhook.id), "done");
  } finally { await first.close(); }
  const replay = await openCodingRunRuntime(options);
  try {
    assert.equal((await replay.scheduled(occurrence)).status, "existing");
    assert.equal((await replay.github("registration", event)).status, "existing");
    assert.deepEqual(calls, ["development-role", "review-role", "pstack-check", "host-check",
      "development-role", "review-role", "pstack-check", "host-check"]);
  } finally { await replay.close(); }
});
