import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "vitest";
import { RunContractStore, type RunContract } from "./run-contract.ts";
import { startGithubCodingRun, startScheduledCodingRun, type TriggerTemplate } from "./run-triggers.ts";

const template: TriggerTemplate = {
  botId: "fixture", repository: "fixture/agents", ref: "review", successCriteria: ["pstack verifies goal"],
  repositoryClass: "agent-private", allowedEffects: ["edit", "draft-pr"], authorisedExternalWrites: [],
};

function port() {
  const store = new RunContractStore(":memory:");
  const started: RunContract[] = [];
  return {
    started, close: () => store.close(),
    async start(contract: RunContract) { started.push(contract); store.create(contract, Date.now()); },
    get: (id: string) => store.get(id),
  };
}

function github(raw: Buffer, secret = "fixture-secret", event = "check_run") {
  return { raw, secret, event, deliveryId: "11111111-1111-4111-8111-111111111111",
    signature: `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` };
}

test("a persisted scheduled occurrence starts only once", async () => {
  const runner = port();
  const run = { id: "run-1", routineId: "routine-1", botId: template.botId,
    scheduledFor: 100, triggerSource: "schedule", status: "running" };
  assert.equal((await startScheduledCodingRun(runner, run, template)).status, "accepted");
  assert.equal((await startScheduledCodingRun(runner, run, template)).status, "existing");
  assert.equal((await startScheduledCodingRun(runner, { ...run, status: "queued" }, template)).status, "ignored");
  assert.equal(runner.started.length, 1);
  runner.close();
});

test("GitHub event needs authentic bytes, exact repository, action and delivery id", async () => {
  const runner = port();
  const raw = Buffer.from(JSON.stringify({ action: "completed", repository: { full_name: template.repository } }));
  const input = github(raw);
  assert.equal((await startGithubCodingRun(runner, input, template)).status, "accepted");
  assert.equal((await startGithubCodingRun(runner, input, template)).status, "existing");
  assert.equal((await startGithubCodingRun(runner, { ...input, event: "issues" }, template)).status, "ignored");
  assert.throws(() => startGithubCodingRun(runner, { ...input, raw: Buffer.from("changed") }, template), /authentication/);
  const other = github(Buffer.from(JSON.stringify({ action: "completed", repository: { full_name: "other/agents" } })));
  assert.equal((await startGithubCodingRun(runner, other, template)).status, "ignored");
  assert.equal(runner.started.length, 1);
  runner.close();
});

test("unattended triggers reject external repositories and external write grants", async () => {
  const runner = port();
  const run = { id: "run-2", routineId: "routine-1", botId: template.botId,
    scheduledFor: 100, triggerSource: "schedule", status: "running" };
  await assert.rejects(startScheduledCodingRun(runner, run, { ...template, repositoryClass: "external",
    authorisedExternalWrites: [{ repository: template.repository, effects: ["edit"] }] }), /private agent repository/);
  await assert.rejects(startScheduledCodingRun(runner, run, { ...template,
    authorisedExternalWrites: [{ repository: "other/repo", effects: ["edit"] }] }), /private agent repository/);
  runner.close();
});
