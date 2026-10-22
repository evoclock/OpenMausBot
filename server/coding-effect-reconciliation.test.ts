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
    async branch() { return { sha: revision }; },
    async pullRequests() { return { complete: true, items: [{ headRepository: "owner/repo", head: "feature", base: "main", number: 7 }] }; },
    async comments() { return { complete: true, bodies: ["Reviewed <!-- omb-effect:run-1 -->"] }; },
    ...overrides,
  };
}

test.each(effects)("$kind: exact presence is recorded", async (effect) => {
  assert.equal((await observeCodingEffect(inspector(), effect)).status, "present");
});

test("each missing effect is distinguished from an inspection failure", async () => {
  const absent = inspector({
    async branch() { return null; },
    async pullRequests() { return { complete: true, items: [] }; },
    async comments() { return { complete: true, bodies: [] }; },
  });
  for (const effect of effects) assert.equal((await observeCodingEffect(absent, effect)).status, "missing");
});

test("each API failure holds the effect without exposing its error text", async () => {
  const failed = inspector({
    async branch() { throw new Error("private bearer"); },
    async pullRequests() { throw new Error("private bearer"); },
    async comments() { throw new Error("private bearer"); },
  });
  for (const effect of effects) {
    const result = await observeCodingEffect(failed, effect);
    assert.equal(result.status, "inconclusive");
    assert.doesNotMatch(result.evidence, /bearer/);
  }
});

test("different branch revision and partial or duplicate PR matches are inconclusive", async () => {
  assert.equal((await observeCodingEffect(inspector({ async branch() { return { sha: "b".repeat(40) }; } }), effects[0]!)).status,
    "inconclusive");
  for (const items of [
    [{ headRepository: "owner/repo", head: "feature", base: "elsewhere", number: 7 }],
    [{ headRepository: "fork/repo", head: "feature", base: "main", number: 7 }],
    [{ headRepository: "owner/repo", head: "feature", base: "main", number: 7 },
      { headRepository: "owner/repo", head: "feature", base: "main", number: 8 }],
  ]) {
    const result = await observeCodingEffect(inspector({ async pullRequests() { return { complete: true, items }; } }), effects[1]!);
    assert.equal(result.status, "inconclusive");
  }
  assert.equal((await observeCodingEffect(inspector({ async pullRequests() {
    return { complete: false, items: [] };
  } }), effects[1]!)).status, "inconclusive");
});

test("duplicate or incomplete comment listings cannot authorize replay", async () => {
  const body = "<!-- omb-effect:run-1 -->";
  for (const result of [{ complete: true, bodies: [body, body] }, { complete: false, bodies: [] }]) {
    assert.equal((await observeCodingEffect(inspector({ async comments() { return result; } }), effects[2]!)).status,
      "inconclusive");
  }
});
