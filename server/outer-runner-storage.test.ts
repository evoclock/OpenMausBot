import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test, vi } from "vitest";
import { StorageRequestError } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openOuterRunner } from "./outer-runner.ts";
import type { RunContractInput } from "./run-contract.ts";

const fault = vi.hoisted(() => ({ commit: false }));
vi.mock("@earendil-works/pi-durable/storage/sqlite/node", async (importOriginal) => {
  const real = await importOriginal<typeof import("@earendil-works/pi-durable/storage/sqlite/node")>();
  return { ...real, async openNodeSqliteStorage(path: string) {
    const storage = await real.openNodeSqliteStorage(path);
    return new Proxy(storage, {
      get(target, key) {
        if (key === "commit" && fault.commit) return async () => { throw new Error("fixture storage write failed"); };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  } };
});

const contract: RunContractInput = {
  id: "33333333-3333-4333-8333-333333333333", botId: "fixture", repository: "fixture/agents", ref: "review",
  successCriteria: ["verify"], repositoryClass: "agent-private", allowedEffects: ["edit"], authorisedExternalWrites: [],
  limits: { maxWallTimeMs: 30_000, maxSpendUsd: 1 },
};
const inner = { async invoke() { return { kind: "verified" as const, evidence: ["complete"], costUsd: 0 }; } };
function fixtureDir() {
  const scratch = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(scratch, { recursive: true });
  return mkdtempSync(join(scratch, "outer-storage-"));
}
beforeEach(() => { fault.commit = false; });

test("an invalid storage read reports StorageRequestError without failing subsequent reads", async () => {
  const real = await vi.importActual<typeof import("@earendil-works/pi-durable/storage/sqlite/node")>(
    "@earendil-works/pi-durable/storage/sqlite/node");
  const storage = await real.openNodeSqliteStorage(join(fixtureDir(), "read.sqlite"));
  try {
    await assert.rejects(storage.scanTasks({}, 10, { after: "invalid" } as never, BACKGROUND_CONTEXT), StorageRequestError);
    const page = await storage.scanTasks({}, 10, undefined, BACKGROUND_CONTEXT);
    assert.deepEqual(page.items, []);
  } finally { await storage.close(BACKGROUND_CONTEXT); }
});

test("a failed storage commit closes the session and refuses further run work", async () => {
  const runner = await openOuterRunner(fixtureDir(), inner);
  try {
    fault.commit = true;
    await assert.rejects(runner.start(contract));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.throws(() => runner.get(contract.id), /durable session failed/);
    assert.throws(() => runner.start(contract), /durable session failed/);
  } finally { fault.commit = false; await runner.close(); }
});
