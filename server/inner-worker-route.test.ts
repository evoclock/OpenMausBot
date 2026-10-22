import { strict as assert } from "node:assert";
import { test } from "vitest";
import { createWorkerRoute, type WorkerHost } from "./inner-worker-route.ts";
import type { RunContractInput } from "./run-contract.ts";

const contract: RunContractInput = {
  id: "44444444-4444-4444-8444-444444444444", botId: "fixture", repository: "fixture/agents", ref: "review",
  repositoryClass: "agent-private", successCriteria: ["pstack acceptance passes"],
  allowedEffects: ["edit", "commit", "push", "draft-pr"], authorisedExternalWrites: [],
  limits: { maxWallTimeMs: 30_000, maxSpendUsd: 1 },
};

function host(): WorkerHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async roles() { return { development: "worker", independentReview: "reviewer" }; },
    async acquire() { calls.push("acquire"); return { repository: contract.repository,
      directory: "isolated", branch: "review", base: "base", leaseId: "lease" }; },
    async release(leaseId, reason) { calls.push(`release:${leaseId}:${reason}`); },
    async runPlaybook(_workspace, role) { calls.push(role); return { revision: "revision", evidence: ["worker artifact"], progress: true, costUsd: 0 }; },
    async review(_workspace, role, revision) { calls.push(role); return { revision, accepted: true, evidence: ["separate review"], costUsd: 0 }; },
    async verifyWithPstack() { calls.push("pstack"); return ["acceptance result"]; },
  };
}

const signal = new AbortController().signal;

test("independent review and inner acceptance evidence precede completion", async () => {
  const route = host();
  const result = await createWorkerRoute(route).invoke(contract, 1, "run:1", signal);
  assert.equal(result.kind, "verified");
  assert.deepEqual(route.calls, ["acquire", "worker", "reviewer", "pstack"]);
});

test("missing or same role blocks work before workspace allocation", async () => {
  const route = host();
  route.roles = async () => ({ development: "same", independentReview: "same" });
  assert.equal((await createWorkerRoute(route).invoke(contract, 1, "run:1", signal)).kind, "blocked");
  assert.deepEqual(route.calls, []);
});

test("a workspace on another branch blocks before dispatch", async () => {
  const route = host();
  route.acquire = async () => { route.calls.push("acquire"); return {
    repository: contract.repository, directory: "isolated", branch: "unapproved", base: "base", leaseId: "lease",
  }; };
  assert.equal((await createWorkerRoute(route).invoke(contract, 1, "run:1", signal)).kind, "blocked");
  assert.deepEqual(route.calls, ["acquire", "release:lease:isolated workspace does not match the run contract"]);
});

test("a workspace in another repository blocks and releases before dispatch", async () => {
  const route = host();
  route.acquire = async () => { route.calls.push("acquire"); return {
    repository: "other/agents", directory: "isolated", branch: contract.ref, base: "base", leaseId: "lease",
  }; };
  assert.equal((await createWorkerRoute(route).invoke(contract, 1, "run:1", signal)).kind, "blocked");
  assert.deepEqual(route.calls, ["acquire", "release:lease:isolated workspace does not match the run contract"]);
});

test.each(["runPlaybook", "review"] as const)("%s failure releases the lease", async (step) => {
  const route = host();
  route[step] = async () => { route.calls.push(step); throw new Error("host failure"); };
  const result = await createWorkerRoute(route).invoke(contract, 1, "run:1", signal);
  assert.equal(result.kind, "blocked");
  assert.equal(route.calls.at(-1), "release:lease:worker route failed; reconcile outward effects");
  assert.deepEqual(result.evidence, ["worker route failed; reconcile outward effects", "host failure"]);
});

test("a rejecting release preserves the blocked cause", async () => {
  const route = host();
  route.runPlaybook = async () => { throw new Error("worker failed"); };
  route.release = async () => { throw new Error("release failed"); };
  const result = await createWorkerRoute(route).invoke(contract, 1, "run:1", signal);
  assert.deepEqual(result, { kind: "blocked", evidence: [
    "worker route failed; reconcile outward effects", "worker failed", "lease release failed: release failed",
  ], costUsd: 0 });
});

test.each([
  ["worker", "worker interrupted; reconcile outward effects"],
  ["reviewer", "review interrupted; reconcile outward effects"],
  ["pstack", "verification interrupted; reconcile outward effects"],
] as const)("abort after %s releases the lease", async (step, reason) => {
  const route = host();
  const controller = new AbortController();
  if (step === "worker") route.runPlaybook = async () => {
    controller.abort(); return { revision: "revision", evidence: [], progress: true, costUsd: 0 };
  };
  if (step === "reviewer") route.review = async (_workspace, _role, revision) => {
    controller.abort(); return { revision, accepted: true, evidence: ["review"], costUsd: 0 };
  };
  if (step === "pstack") route.verifyWithPstack = async () => { controller.abort(); return ["verified"]; };
  const result = await createWorkerRoute(route).invoke(contract, 1, "run:1", controller.signal);
  assert.deepEqual(result, { kind: "blocked", evidence: [reason], costUsd: 0 });
  assert.equal(route.calls.at(-1), `release:lease:${reason}`);
});

test("verification failure blocks and releases after review", async () => {
  const route = host();
  route.verifyWithPstack = async () => { throw new Error("verification failed"); };
  const result = await createWorkerRoute(route).invoke(contract, 1, "run:1", signal);
  assert.deepEqual(result.evidence, ["worker route failed; reconcile outward effects", "verification failed"]);
  assert.equal(route.calls.at(-1), "release:lease:worker route failed; reconcile outward effects");
});

test("a worker without progress blocks and releases the lease", async () => {
  const route = host();
  route.runPlaybook = async () => { route.calls.push("worker"); return { revision: "", evidence: [], progress: false, costUsd: 0 }; };
  assert.equal((await createWorkerRoute(route).invoke(contract, 1, "run:1", signal)).kind, "blocked");
  assert.deepEqual(route.calls, ["acquire", "worker", "release:lease:worker made no verified progress"]);
});

test("a favorable reviewer alone never completes an unverified run", async () => {
  const route = host();
  route.verifyWithPstack = async () => null;
  const result = await createWorkerRoute(route).invoke(contract, 1, "run:1", signal);
  assert.equal(result.kind, "progress");
  assert.deepEqual(route.calls, ["acquire", "worker", "reviewer"]);
});

test("unknown worker spend stops before reviewer dispatch", async () => {
  const route = host();
  route.runPlaybook = async () => { route.calls.push("worker"); return {
    revision: "revision", evidence: ["work"], progress: true, costUsd: null,
  }; };
  const result = await createWorkerRoute(route).invoke(contract, 1, "run:1", signal, 1);
  assert.equal(result.kind, "blocked");
  assert.equal(result.costUsd, null);
  assert.deepEqual(route.calls, ["acquire", "worker",
    "release:lease:coding run spend is uncertain; owner review required"]);
});

test("spent worker ceiling stops before reviewer dispatch", async () => {
  const route = host();
  route.runPlaybook = async () => { route.calls.push("worker"); return {
    revision: "revision", evidence: ["work"], progress: true, costUsd: 0.5,
  }; };
  const result = await createWorkerRoute(route).invoke(contract, 1, "run:1", signal, 0.5);
  assert.equal(result.kind, "blocked");
  assert.equal(result.costUsd, 0.5);
  assert.deepEqual(route.calls, ["acquire", "worker", "release:lease:spend ceiling reached before review"]);
});

test("external destinations never enter the default worker route", async () => {
  const route = host();
  const result = await createWorkerRoute(route).invoke({ ...contract, repositoryClass: "external" }, 1, "run:1", signal);
  assert.equal(result.kind, "blocked");
  assert.deepEqual(route.calls, []);
});
