import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { attachCodingLoop, attachCodingLoopClaim, type CodingRunPort, type CodingRunStart } from "./coding-loop-attachment.ts";
import { openCodingRunRuntime } from "./coding-run-runtime.ts";
import type { WorkerHost } from "./inner-worker-route.ts";
import { RunContractStore, type RunSnapshot } from "./run-contract.ts";
import type { TriggerTemplate } from "./run-triggers.ts";

const template: TriggerTemplate = {
  botId: "fixture", repository: "fixture/agents", ref: "review", repositoryClass: "agent-private",
  successCriteria: ["pstack verifies the goal"], allowedEffects: ["edit"], authorisedExternalWrites: [],
};

const occurrence: CodingRunStart = {
  id: "occurrence", routineId: "routine", botId: "fixture", scheduledFor: 100,
  triggerSource: "schedule", status: "running",
};

function fixtureDir() {
  const scratch = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(scratch, { recursive: true });
  return mkdtempSync(join(scratch, "coding-loop-"));
}

function host(calls: string[]): WorkerHost {
  return {
    async roles() { return { development: "development-role", independentReview: "review-role" }; },
    async acquire(contract) { return { repository: contract.repository, directory: "isolated",
      branch: "review", base: "base", leaseId: "lease" }; },
    async release() { calls.push("release"); },
    async runPlaybook(_workspace, role) { calls.push(role); return { revision: "revision", evidence: ["work"], progress: true }; },
    async review(_workspace, role, revision) { calls.push(role); return { revision, accepted: true, evidence: ["review"] }; },
    async verifyWithPstack() { calls.push("pstack-check"); return ["verified"]; },
  };
}

function recorder() {
  const events: string[] = [];
  return {
    events,
    handlers: {
      complete(runId: string, evidence: string[]) { events.push(`complete:${runId}:${evidence.join("+")}`); },
      hold(runId: string, evidence: string[]) { events.push(`hold:${runId}:${evidence.join("+")}`); },
      fail(runId: string, message: string) { events.push(`fail:${runId}:${message}`); },
    },
  };
}

function snapshot(id: string, state: RunSnapshot["state"], evidence: string[] = ["evidence"]): RunSnapshot {
  return { contract: { ...template, id }, state, iteration: 1, updatedAt: 1000, evidence };
}

async function settled(runtime: Awaited<ReturnType<typeof openCodingRunRuntime>>, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = runtime.get(id)?.state;
    if (state === "done" || state === "blocked") return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("fixture run did not settle");
}

test("durable claim survives reopen and never replays an uncertain handler effect", () => {
  const path = join(fixtureDir(), "claims.sqlite");
  let store = new RunContractStore(path);
  store.linkRoutine("occurrence", "00000000-0000-5000-8000-000000000001");
  assert.equal(store.claimRoutineTerminal("00000000-0000-5000-8000-000000000001", snapshot("00000000-0000-5000-8000-000000000001", "done"))?.status, "claimed");
  store.close();
  store = new RunContractStore(path);
  try {
    assert.equal(store.linkRoutine("occurrence", "00000000-0000-5000-8000-000000000001").status, "claimed");
    assert.equal(store.claimRoutineTerminal("00000000-0000-5000-8000-000000000001", snapshot("00000000-0000-5000-8000-000000000001", "done"))?.status, "claimed");
    assert.throws(() => store.linkRoutine("occurrence", "other-id"), /different coding run/);
    assert.throws(() => store.linkRoutine("other-occurrence", "00000000-0000-5000-8000-000000000001"), /different routine/);
  } finally { store.close(); }
});

test("durable link and terminal evidence survive restart before claim", () => {
  const path = join(fixtureDir(), "claims.sqlite");
  let store = new RunContractStore(path);
  store.linkRoutine("occurrence", "00000000-0000-5000-8000-000000000001");
  store.close();
  store = new RunContractStore(path);
  try {
    assert.equal(store.claimRoutineTerminal("00000000-0000-5000-8000-000000000001", snapshot("00000000-0000-5000-8000-000000000001", "blocked"))?.status, "claimed");
    assert.equal(store.routineLink("00000000-0000-5000-8000-000000000001")?.terminal?.state, "blocked");
  } finally { store.close(); }
});

test("terminal before start resolution is claimed on lookup, duplicates cannot dispatch handlers", async () => {
  const store = new RunContractStore(join(fixtureDir(), "claims.sqlite"));
  let resolve!: (value: { status: "accepted"; id: string }) => void;
  const waiting = new Promise<{ status: "accepted"; id: string }>((done) => { resolve = done; });
  const terminal = snapshot("00000000-0000-5000-8000-000000000001", "done");
  const live = attachCodingLoopClaim({ scheduled: () => waiting, get: () => terminal }, store);
  try {
    const started = live.runStarted(occurrence);
    assert.equal(live.onTerminal(terminal), undefined);
    resolve({ status: "accepted", id: "00000000-0000-5000-8000-000000000001" });
    await started;
    assert.equal(store.routineLink("00000000-0000-5000-8000-000000000001")?.status, "claimed");
    await live.runStarted(occurrence);
    assert.equal(live.onTerminal(snapshot("00000000-0000-5000-8000-000000000001", "failed"))?.terminal?.state, "done");
  } finally { store.close(); }
});

test("failed association write leaves no claim; replay recovers terminal without effects", async () => {
  const store = new RunContractStore(join(fixtureDir(), "claims.sqlite"));
  const terminal = snapshot("00000000-0000-5000-8000-000000000001", "done");
  const live = attachCodingLoopClaim({ scheduled: async () => ({ status: "accepted", id: "00000000-0000-5000-8000-000000000001" }), get: () => terminal }, store);
  try {
    await assert.rejects(live.runStarted({ ...occurrence, id: "" }), /empty routine/);
    assert.equal(store.routineLink("00000000-0000-5000-8000-000000000001"), undefined);
    await live.runStarted(occurrence);
    assert.equal(store.routineLink("00000000-0000-5000-8000-000000000001")?.status, "claimed");
  } finally { store.close(); }
});

test("refusal and mismatched terminal cannot create an applied effect", async () => {
  const store = new RunContractStore(join(fixtureDir(), "claims.sqlite"));
  const codingId = "00000000-0000-5000-8000-000000000001";
  const live = attachCodingLoopClaim({
    scheduled: async () => { throw new Error("refused"); }, get: () => undefined,
  }, store);
  try {
    await assert.rejects(live.runStarted(occurrence), /refused/);
    assert.equal(store.routineLink(codingId), undefined);
    store.linkRoutine(occurrence.id, codingId);
    assert.throws(() => store.claimRoutineTerminal(codingId, snapshot("00000000-0000-5000-8000-000000000002", "done")),
      /terminal report does not match/);
    assert.equal(store.routineLink(codingId)?.status, "pending");
  } finally { store.close(); }
});

test("duplicate events start one run and one correlated terminal report settles it", async () => {
  const calls: string[] = [];
  const seen = recorder();
  let forward: (snapshot: RunSnapshot) => void = () => {};
  const runtime = await openCodingRunRuntime({ dataDir: fixtureDir(), workerHost: host(calls),
    routines: new Map([["routine", template]]), github: new Map(), onTerminal: (snapshot) => forward(snapshot) });
  try {
    const live = attachCodingLoop(runtime, seen.handlers);
    forward = live.onTerminal;
    const first = await live.runStarted(occurrence);
    assert.equal(first.status, "accepted");
    if (!("id" in first) || !first.id) throw new Error("missing run id");
    assert.equal(live.pending, 1);

    const duplicate = await live.runStarted(occurrence);
    assert.equal(duplicate.status, "existing");
    assert.equal("id" in duplicate && duplicate.id, first.id);
    assert.equal(live.pending, 1);

    assert.equal(await settled(runtime, first.id), "done");
    for (let attempt = 0; attempt < 100 && seen.events.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(seen.events.length, 1);
    assert.equal(live.pending, 0);

    // A repeated terminal report for the consumed correlation parks instead of settling twice.
    live.onTerminal(snapshot(first.id, "done"));
    assert.equal(seen.events.length, 1);
    assert.equal(live.parked.length, 1);
    assert.equal(calls.filter((name) => name === "development-role").length, 1);
  } finally { await runtime.close(); }
});

test("a blocked terminal report holds the routine run with its evidence, never replays", () => {
  const seen = recorder();
  const port: CodingRunPort = { scheduled: () => Promise.resolve({ status: "accepted", id: "run-1" }) };
  const live = attachCodingLoop(port, seen.handlers);
  return live.runStarted(occurrence).then(() => {
    live.onTerminal(snapshot("run-1", "blocked", ["interrupted iteration needs effect reconciliation"]));
    assert.deepEqual(seen.events, ["hold:occurrence:interrupted iteration needs effect reconciliation"]);
    live.onTerminal(snapshot("run-1", "blocked", ["interrupted iteration needs effect reconciliation"]));
    assert.equal(seen.events.length, 1);
    assert.equal(live.parked.length, 1);
  });
});

test("a terminal report without a live correlation parks and calls no handler", () => {
  const seen = recorder();
  const live = attachCodingLoop({ scheduled: () => Promise.resolve({ status: "ignored" as const }) }, seen.handlers);
  live.onTerminal(snapshot("unknown-run", "done"));
  live.onTerminal(snapshot("unknown-run", "cancelled", []));
  assert.deepEqual(seen.events, []);
  assert.equal(live.parked.length, 2);
  assert.equal(live.pending, 0);
});

test("a non-private or externally-authorised template is refused and starts nothing", async () => {
  const calls: string[] = [];
  const seen = recorder();
  const external: TriggerTemplate = { ...template, repositoryClass: "external",
    authorisedExternalWrites: [{ repository: template.repository, effects: ["edit"] }] };
  const runtime = await openCodingRunRuntime({ dataDir: fixtureDir(), workerHost: host(calls),
    routines: new Map([["routine", external]]), github: new Map() });
  try {
    const live = attachCodingLoop(runtime, seen.handlers);
    const result = await live.runStarted(occurrence);
    assert.equal(result.status, "refused");
    assert.equal(seen.events.length, 1);
    assert.match(seen.events[0]!, /^fail:occurrence:unattended trigger requires a private agent repository/);
    assert.equal(live.pending, 0);
    assert.deepEqual(calls, []);
  } finally { await runtime.close(); }
});

test("an unscheduled or non-running occurrence is ignored without correlation", async () => {
  const seen = recorder();
  const live = attachCodingLoop({ scheduled: () => Promise.resolve({ status: "ignored" as const }) }, seen.handlers);
  const result = await live.runStarted({ ...occurrence, status: "queued" });
  assert.equal(result.status, "ignored");
  assert.equal(live.pending, 0);
  assert.deepEqual(seen.events, []);
});
