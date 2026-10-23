import { strict as assert } from "node:assert";
import { test } from "vitest";
import { createIterationContextCompactor } from "./iteration-context-compactor.ts";
import type { IterationEntry } from "./loop-ledger.ts";

const history: IterationEntry[] = Array.from({ length: 14 }, (_, index) => ({
  iteration: index + 1, goal: "Ship only after checks pass", verdict: "waiting", startedAt: index,
  finishedAt: index + 1,
  evidence: index === 0 ? ["failed approach: skip the flaky check; criterion still unmet: checks pass"]
    : [`attempt ${index + 1}: reviewer rejected; criterion still unmet: checks pass`, "🔍".repeat(300)],
}));

test("bounded carry retains earlier failed approaches, unmet criteria, and latest detail", () => {
  const carry = createIterationContextCompactor(8192).compact(history);
  assert.ok(Buffer.byteLength(carry, "utf8") <= 8192);
  assert.match(carry, /failed approach: skip the flaky check/);
  assert.match(carry, /criterion still unmet: checks pass/);
  assert.match(carry, /Previous iteration 14 verdict: waiting/);
  assert.match(carry, /attempt 14: reviewer rejected/);
  assert.equal(carry.includes("\ufffd"), false);
  assert.equal(carry, createIterationContextCompactor(8192).compact(structuredClone(history)));
});

test("redacts secret evidence before truncating and does not mutate receipts", () => {
  const original = structuredClone(history);
  const entries = structuredClone(history);
  entries[0]!.evidence = ["token=supersecret123 failed approach"];
  entries[13]!.evidence = ["authorization: Bearer supersecret456", "password=veryprivate123"];
  const carry = createIterationContextCompactor(512).compact(entries);
  assert.ok(Buffer.byteLength(carry) <= 512);
  assert.doesNotMatch(carry, /supersecret|veryprivate/);
  assert.deepEqual(history, original);
  assert.equal(entries[0]!.evidence[0], "token=supersecret123 failed approach");
});

test("rejects caps too small to hold meaningful carry", () => {
  assert.throws(() => createIterationContextCompactor(1));
});
