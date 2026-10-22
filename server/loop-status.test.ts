import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { RunContractStore } from "./run-contract.ts";
import { loopStatus, openLoopStatusReader } from "./loop-status.ts";

const scratch = join(process.cwd(), ".omb-scratch", "proof", "loop-status");
mkdirSync(scratch, { recursive: true });

it("reads scoped durable runs and recent committed iterations without changing the store", () => {
  const dir = mkdtempSync(join(scratch, "fixture-"));
  mkdirSync(join(dir, "coding-run"));
  const store = new RunContractStore(join(dir, "coding-run", "runtime.db"));
  const contract = { id: "7898b674-9669-43c1-84d5-f0955fd4e1cd", botId: "one", repository: "repo",
    ref: "main", successCriteria: ["verified"], repositoryClass: "agent-private" as const,
    allowedEffects: [] as Array<"edit">, limits: { maxWallTimeMs: 10000, maxSpendUsd: 4 } };
  store.create(contract, 100);
  store.beginIteration(contract.id, 0, `${contract.id}:1`, 101);
  store.finishIteration(contract.id, 1, `${contract.id}:1`, "waiting", 102, ["progress"], 1);
  const reader = openLoopStatusReader(dir)!;
  expect(reader.list("other")).toEqual([]);
  const snapshot = reader.list("one")[0]!;
  expect(loopStatus(snapshot, reader.recent(contract.id))).toMatchObject({
    state: "waiting", iteration: 1, lastVerdict: "waiting",
    budget: { spentUsd: 1, spendRemainingUsd: 3, iterationsRemaining: 7 },
    entries: [{ iteration: 1, state: "waiting" }],
  });
  reader.close();
  expect(store.get(contract.id)?.state).toBe("waiting");
  store.close();
});

it("does not create storage when no coding runtime exists", () => {
  const dir = mkdtempSync(join(scratch, "fixture-"));
  expect(openLoopStatusReader(dir)).toBeNull();
});
