import { strict as assert } from "node:assert";
import { test } from "vitest";
import { CodingDenialBoundary } from "./coding-denial.ts";
import { SessionStatusFeed } from "./session-status-feed.ts";
import type { RuntimeEvent } from "./contracts.ts";

test("a denied coding action stops its thread and posts one terminal feed notice, even on replay", () => {
  const feed = new SessionStatusFeed(":memory:");
  let interrupts = 0;
  let wakes = 0;
  const boundary = new CodingDenialBoundary(feed, () => { wakes += 1; }, () => { interrupts += 1; });
  boundary.register("coding-thread", { id: "run-1", branch: "feat/closed", directory: "/fixture" });
  const event = { threadId: "coding-thread", type: "request.opened", tool: "push", requestId: "r-1" } as RuntimeEvent;
  try {
    assert.equal(boundary.handle(event), true);
    assert.equal(boundary.handle(event), true);
    assert.equal(boundary.handle({ ...event, type: "runtime.error", message: "Coding run run-1 denied push: outside envelope" } as RuntimeEvent), true);
    assert.equal(boundary.handle({ ...event, threadId: "chat-thread" }), false);
    assert.equal(feed.pendingWakes().length, 1);
    assert.equal(feed.pendingWakes()[0]?.kind, "completion");
    assert.match(feed.pendingWakes()[0]!.detail, /run-1.*push.*interactive request/);
    assert.equal(feed.latest()[0]?.state, "failed");
    assert.equal(wakes, 1);
    assert.equal(interrupts, 2);
  } finally { feed.close(); }
});
