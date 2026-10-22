import { strict as assert } from "node:assert";
import { test } from "vitest";
import { codingPlaybookPrompt } from "./coding-playbook-prompt.ts";
import type { RunContractInput } from "./run-contract.ts";

const contract: RunContractInput = {
  id: "44444444-4444-4444-8444-444444444444", botId: "fixture", repository: "fixture/agents",
  ref: "review", repositoryClass: "agent-private", successCriteria: ["acceptance passes"],
  allowedEffects: ["edit"], authorisedExternalWrites: [], limits: { maxWallTimeMs: 30_000, maxSpendUsd: 1 },
};

test("autonomous prompt includes goal, check and finite remaining budget", () => {
  const prompt = codingPlaybookPrompt(contract, 0.5);
  assert.match(prompt, /^\/skill:poteto-mode-pi/m);
  assert.match(prompt, /Goal: acceptance passes/);
  assert.match(prompt, /Approved check: acceptance passes/);
  assert.match(prompt, /30000 ms and \$0\.5 remaining/);
  assert.doesNotMatch(prompt, /provider\/model/i);
});

test("missing check or finite budget refuses before dispatch", () => {
  assert.throws(() => codingPlaybookPrompt({ ...contract, successCriteria: [] }, 1));
  assert.throws(() => codingPlaybookPrompt(contract, Infinity));
  assert.throws(() => codingPlaybookPrompt(contract, 0));
});
