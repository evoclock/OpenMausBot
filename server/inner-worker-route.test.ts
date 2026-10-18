import { strict as assert } from "node:assert";
import { test } from "vitest";
import { createWorkerRoute, type WorkerHost } from "./inner-worker-route.ts";
import type { RunContract } from "./run-contract.ts";

const contract: RunContract = {
  id: "44444444-4444-4444-8444-444444444444", botId: "fixture", repository: "fixture/agents", ref: "review",
  repositoryClass: "agent-private", successCriteria: ["pstack acceptance passes"],
  allowedEffects: ["edit", "commit", "push", "draft-pr"], authorisedExternalWrites: [],
};

function host(): WorkerHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async roles() { return { development: "worker", independentReview: "reviewer" }; },
    async acquire() { calls.push("acquire"); return { repository: contract.repository,
      directory: "isolated", branch: "review", base: "base", leaseId: "lease" }; },
    async runPlaybook(_workspace, role) { calls.push(role); return { revision: "revision", evidence: ["worker artifact"], progress: true }; },
    async review(_workspace, role, revision) { calls.push(role); return { revision, accepted: true, evidence: ["separate review"] }; },
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

test("a favorable reviewer alone never completes an unverified run", async () => {
  const route = host();
  route.verifyWithPstack = async () => null;
  const result = await createWorkerRoute(route).invoke(contract, 1, "run:1", signal);
  assert.equal(result.kind, "progress");
  assert.deepEqual(route.calls, ["acquire", "worker", "reviewer"]);
});

test("external destinations never enter the default worker route", async () => {
  const route = host();
  const result = await createWorkerRoute(route).invoke({ ...contract, repositoryClass: "external" }, 1, "run:1", signal);
  assert.equal(result.kind, "blocked");
  assert.deepEqual(route.calls, []);
});
