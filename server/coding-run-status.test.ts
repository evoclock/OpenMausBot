import { strict as assert } from "node:assert";
import { test } from "vitest";
import { createCodingRunStatusReporter } from "./coding-run-status.ts";
import { RunContractStore } from "./run-contract.ts";
import { SessionStatusFeed } from "./session-status-feed.ts";

// Why: a silent coding run must wake the owner once after 15 minutes, not on each heartbeat.
test("coding status reports progress and wakes once per stalled episode", () => {
  let now = 1_000_000;
  const feed = new SessionStatusFeed(":memory:", { now: () => now });
  const runs = new RunContractStore(":memory:");
  const id = "11111111-1111-4111-8111-111111111111";
  runs.create({ id, botId: "bot", repository: "repo", ref: "main", repositoryClass: "agent-private",
    successCriteria: ["pass"], allowedEffects: [] }, now);
  const wakes: string[] = [];
  const reporter = createCodingRunStatusReporter({ feed, list: () => runs.list(), now: () => now,
    wake: (events) => wakes.push(...events.map((event) => event.kind)) });
  try {
    reporter.tick();
    runs.beginIteration(id, 0, `${id}:1`, now + 1);
    reporter.tick();
    now += 15 * 60_000 + 1;
    reporter.tick();
    reporter.tick();
    assert.deepEqual(wakes, ["stall"]);
    assert.equal(feed.pendingWakes().length, 1);
    feed.acknowledge(feed.pendingWakes().map((wake) => wake.id));
    reporter.tick();
    assert.deepEqual(wakes, ["stall"]);
    assert.equal(feed.latest()[0]?.state, "running");
    const denied = feed.record({ sessionId: id, reportId: `${id}:denied`, sequence: 5,
      state: "failed", progressAt: now, reportedAt: now, evidence: ["permission denied"] });
    assert.equal(denied.accepted, true);
    reporter.tick();
    assert.equal(feed.latest()[0]?.reportId, `${id}:denied`);
  } finally { runs.close(); feed.close(); }
});
