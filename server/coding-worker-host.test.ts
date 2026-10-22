import { strict as assert } from "node:assert";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { ensureDirs } from "./config.ts";
import { PiDriver } from "./drivers/pi.ts";
import { createCodingWorkerHost } from "./coding-worker-host.ts";
import type { RuntimeEvent } from "./contracts.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-pi-cli.ts");

test("worker route launches the existing fake process with the scoped approval mode and captures its output", async () => {
  ensureDirs();
  chmodSync(cli, 0o755);
  const instance = await PiDriver.create({ instanceId: "coding-fixture", displayName: "fixture",
    environment: {}, enabled: true, config: { cli, fullAuto: false } });
  const workspace = { repository: "fixture/agents", directory: process.cwd(), branch: "main", base: "main", leaseId: "fixture-lease" };
  const seen: RuntimeEvent[] = [];
  const unsubscribe = instance.adapter.onEvent((event) => { seen.push(event); });
  const host = createCodingWorkerHost({
    roles: new Map([[workspace.repository, { development: "development", independentReview: "review",
      developmentBotId: "worker", reviewerBotId: "reviewer" }]]),
    workspace: { async acquire() { return workspace; }, async release() {} },
    turn: { async run({ botId, prompt, requestId, signal }) {
      assert.ok(["worker", "reviewer"].includes(botId));
      assert.equal(signal.aborted, false);
      const threadId = `${botId}:${requestId}`;
      const done = new Promise<RuntimeEvent>((resolve) => {
        const off = instance.adapter.onEvent((event) => {
          if (event.type === "turn.completed" && event.threadId === threadId) { off(); resolve(event); }
        });
      });
      await instance.adapter.sendTurn({ threadId, text: prompt, cwd: workspace.directory, approvalMode: "ask" });
      await done;
      const text = seen.findLast((event) => event.type === "item.completed" && event.threadId === threadId &&
        event.itemType === "assistant_text");
      if (!text || text.type !== "item.completed" || text.itemType !== "assistant_text") throw new Error("fake process produced no text");
      return { revision: "fixture-revision", evidence: [text.text], accepted: true };
    } },
    async verify() { return ["fixture verification"]; },
  });
  try {
    const contract = { id: "00000000-0000-4000-8000-000000000001", botId: "origin", repository: workspace.repository,
      ref: workspace.branch, repositoryClass: "agent-private" as const, successCriteria: ["respond"], allowedEffects: ["edit" as const] };
    const acquired = await host.acquire(contract, "request");
    const report = await host.runPlaybook(acquired, "development", "respond", "request", new AbortController().signal);
    assert.deepEqual(report.evidence, ["Hello from pi"]);
    const review = await host.review(acquired, "review", report.revision, new AbortController().signal);
    assert.deepEqual(review.evidence, ["Hello from pi"]);
    assert.equal(review.accepted, true);
    assert.equal(seen.filter((event) => event.type === "turn.completed").length, 2);
  } finally {
    unsubscribe();
    await instance.dispose();
  }
});
