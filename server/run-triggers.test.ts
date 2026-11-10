import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "vitest";
import { RunContractStore, type RunContract } from "./run-contract.ts";
import { intakeCodingRun, startGithubCodingRun, startOwnerCodingRun, startScheduledCodingRun, type TriggerTemplate } from "./run-triggers.ts";

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

test("casual chat does not create a run and task intake needs a scoped workflow", async () => {
  const runner = port();
  try {
    assert.deepEqual(await intakeCodingRun(runner, { kind: "chat", text: "How does this work?" }),
      { status: "no-workflow" });
    assert.equal(runner.started.length, 0);
    await assert.rejects(intakeCodingRun(runner, { kind: "task", contract: {
      ...template, id: "11111111-1111-4111-8111-111111111111",
    } }), /workflow definition/);
    assert.equal(runner.started.length, 0);
    assert.deepEqual(await intakeCodingRun(runner, { kind: "task", contract: {
      ...template, id: "11111111-1111-4111-8111-111111111111",
      workflow: { id: "fixture-work", policyVersion: 1, taskClass: "delivery", stages: ["draft"],
        roleForStage: { draft: "writer" }, assignments: { writer: "fixture" },
        requiredChecks: ["statechart-pi", "poteto-mode-pi", "identity", "effects"], enabled: false },
    } }), { status: "accepted" });
    assert.equal(runner.started.length, 1);
  } finally { runner.close(); }
});

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

test("owner task entry is authorized, idempotent and binds the goal to its key", async () => {
  const runner = port();
  const input = { repository: template.repository, goal: "Fix the fixture", idempotencyKey: "owner-key-1" };
  await assert.rejects(startOwnerCodingRun(runner, input, template, false), /owner authorization/);
  assert.equal((await startOwnerCodingRun(runner, input, template, true)).status, "accepted");
  assert.equal((await startOwnerCodingRun(runner, input, template, true)).status, "existing");
  await assert.rejects(startOwnerCodingRun(runner, { ...input, goal: "Different goal" }, template, true), /conflict/);
  assert.equal(runner.started.length, 1);
  assert.deepEqual(runner.started[0]?.successCriteria, [input.goal]);
  runner.close();
});

test("GitHub event needs authentic bytes, exact repository, action and delivery id", async () => {
  const runner = port();
  const raw = Buffer.from(JSON.stringify({ action: "completed", repository: { full_name: template.repository } }));
  const input = github(raw);
  assert.equal((await startGithubCodingRun(runner, input, template)).status, "accepted");
  assert.equal((await startGithubCodingRun(runner, input, template)).status, "existing");
  assert.equal((await startGithubCodingRun(runner, { ...input, event: "issues" }, template)).status, "ignored");
  await assert.rejects(startGithubCodingRun(runner, { ...input, raw: Buffer.from("changed") }, template), /authentication/);
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
