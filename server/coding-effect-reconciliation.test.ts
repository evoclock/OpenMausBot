import { strict as assert } from "node:assert";
import { test } from "vitest";
import { observeCodingEffect, type CodingEffect, type ForgeEffectInspector } from "./coding-effect-reconciliation.ts";

const revision = "a".repeat(40);
const effects: CodingEffect[] = [
  { kind: "branch-push", repository: "owner/repo", ref: "feature", expectedSha: revision },
  { kind: "pr-open", repository: "owner/repo", head: "feature", base: "main" },
  { kind: "pr-comment", repository: "owner/repo", pullNumber: 7, key: "run-1" },
];

function inspector(overrides: Partial<ForgeEffectInspector> = {}): ForgeEffectInspector {
  return {
    async getBranchRef() { return { kind: "found", sha: revision }; },
    async findPullRequests() { return { kind: "found", prs: [{ number: 7, headSha: revision, state: "open" }] }; },
    async findCommentsByIdempotencyKey() { return { kind: "found", ids: [15] }; },
    ...overrides,
  };
}

test.each(effects)("$kind: exact presence is recorded", async (effect) => {
  assert.equal((await observeCodingEffect(inspector(), effect)).status, "present");
});

test("each absent effect is distinguished from an inspection failure", async () => {
  const absent = inspector({
    async getBranchRef() { return { kind: "absent" }; },
    async findPullRequests() { return { kind: "absent" }; },
    async findCommentsByIdempotencyKey() { return { kind: "absent" }; },
  });
  for (const effect of effects) assert.equal((await observeCodingEffect(absent, effect)).status, "missing");
});

test("each API failure or inconclusive result holds without exposing error text", async () => {
  const failed = inspector({
    async getBranchRef() { throw new Error("private bearer"); },
    async findPullRequests() { return { kind: "inconclusive", reason: "private bearer" }; },
    async findCommentsByIdempotencyKey() { return { kind: "inconclusive", reason: "private bearer" }; },
  });
  for (const effect of effects) {
    const result = await observeCodingEffect(failed, effect);
    assert.equal(result.status, "inconclusive");
    assert.doesNotMatch(result.evidence, /bearer/);
  }
});

test("different branch revision and ambiguous PR matches remain blocked", async () => {
  assert.equal((await observeCodingEffect(inspector({ async getBranchRef() {
    return { kind: "found", sha: "b".repeat(40) };
  } }), effects[0]!)).status, "inconclusive");
  for (const prs of [[], [{ number: 7, headSha: revision, state: "open" },
    { number: 8, headSha: revision, state: "open" }]]) {
    assert.equal((await observeCodingEffect(inspector({ async findPullRequests() {
      return { kind: "found", prs };
    } }), effects[1]!)).status, "inconclusive");
  }
  assert.equal((await observeCodingEffect(inspector({ async findPullRequests() {
    return { kind: "inconclusive", reason: "partial base match" };
  } }), effects[1]!)).status, "inconclusive");
});

test("duplicate or partial comment listings cannot authorize replay", async () => {
  assert.equal((await observeCodingEffect(inspector({ async findCommentsByIdempotencyKey() {
    return { kind: "found", ids: [14, 15] };
  } }), effects[2]!)).status, "inconclusive");
  assert.equal((await observeCodingEffect(inspector({ async findCommentsByIdempotencyKey() {
    return { kind: "inconclusive", reason: "pagination cutoff" };
  } }), effects[2]!)).status, "inconclusive");
});
