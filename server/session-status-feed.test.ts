import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

import { DEFAULT_STALL_MS, SessionStatusFeed, type SessionStatusReport } from "./session-status-feed.ts";

const start = 1_000_000;
const report = (over: Partial<SessionStatusReport> = {}): SessionStatusReport => ({
  sessionId: "lease-1", reportId: "lease-1:1", sequence: 1, state: "running",
  progressAt: start, reportedAt: start, ...over,
});

function feedAt(clock = { at: start }, options: { stallMs?: number } = {}) {
  const feed = new SessionStatusFeed(":memory:", { now: () => clock.at, ...options });
  return { feed, clock };
}

test("a repeated report is a no-op and an older sequence is refused", () => {
  const { feed } = feedAt();
  assert.equal(feed.record(report()).accepted, true);
  const replay = feed.record(report({ reportedAt: start + 1 }));
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.changes, []);
  const stale = feed.record(report({ reportId: "lease-1:0", sequence: 0 }));
  assert.equal(stale.stale, true);
  assert.equal(feed.latest().length, 1);
  assert.equal(feed.latest()[0]!.reportedAt, start);
  feed.close();
});

test("quiet heartbeats update the record without a wake", () => {
  const { feed, clock } = feedAt();
  feed.record(report());
  clock.at = start + 60_000;
  const beat = feed.record(report({ reportId: "lease-1:2", sequence: 2, progressAt: start + 60_000, reportedAt: clock.at }));
  assert.equal(beat.changed, false);
  assert.deepEqual(beat.wakes, []);
  assert.deepEqual(feed.pendingWakes(), []);
  assert.equal(feed.latest()[0]!.sequence, 2);
  feed.close();
});

test("first sight of a session is context, not a wake", () => {
  const { feed } = feedAt();
  const first = feed.record(report({ state: "done", needsDecision: true, prReady: true }));
  assert.equal(first.changed, false);
  assert.deepEqual(feed.pendingWakes(), []);
  feed.close();
});

test("a decision wakes once, stays pending, and only a new decision wakes again", () => {
  const { feed, clock } = feedAt();
  feed.record(report());
  clock.at = start + 60_000;
  const asked = feed.record(report({ reportId: "lease-1:2", sequence: 2, needsDecision: true, decision: "push to review?" }));
  assert.deepEqual(asked.changes, ["decision"]);
  assert.equal(asked.wakes.length, 1);
  assert.match(asked.wakes[0]!.detail, /push to review\?/);

  clock.at = start + 120_000;
  const again = feed.record(report({ reportId: "lease-1:3", sequence: 3, needsDecision: true, decision: "push to review?" }));
  assert.deepEqual(again.wakes, []);

  const pending = feed.pendingWakes();
  assert.equal(pending.length, 1);
  assert.equal(feed.acknowledge([pending[0]!.id]), 1);
  assert.equal(feed.acknowledge([pending[0]!.id]), 0);
  assert.deepEqual(feed.pendingWakes(), []);

  clock.at = start + 180_000;
  const changed = feed.record(report({ reportId: "lease-1:4", sequence: 4, needsDecision: true, decision: "which branch?" }));
  assert.deepEqual(changed.changes, ["decision"]);
  assert.equal(changed.wakes.length, 1);
  feed.close();
});

test("acknowledging an earlier decision does not erase a changed pending decision", () => {
  const { feed } = feedAt();
  feed.record(report());
  const first = feed.record(report({ reportId: "lease-1:2", sequence: 2,
    needsDecision: true, decision: "use branch A?" }));
  const second = feed.record(report({ reportId: "lease-1:3", sequence: 3,
    needsDecision: true, decision: "use branch B?" }));
  assert.deepEqual(second.changes, ["decision"]);
  assert.equal(second.wakes.length, 1);
  assert.notEqual(second.wakes[0]!.id, first.wakes[0]!.id);
  assert.equal(feed.acknowledge([first.wakes[0]!.id]), 1);
  assert.deepEqual(feed.pendingWakes().map((wake) => wake.id), [second.wakes[0]!.id]);
  assert.match(feed.pendingWakes()[0]!.detail, /branch B/);
  feed.close();
});

test("a terminal state wakes once and a pull request wakes once", () => {
  const { feed, clock } = feedAt();
  feed.record(report());
  clock.at = start + 60_000;
  const pr = feed.record(report({ reportId: "lease-1:2", sequence: 2, prReady: true, prUrl: "https://example.test/pr/1" }));
  assert.deepEqual(pr.changes, ["pr-ready"]);
  assert.match(pr.wakes[0]!.detail, /example\.test\/pr\/1/);
  clock.at = start + 120_000;
  const done = feed.record(report({ reportId: "lease-1:3", sequence: 3, state: "done", evidence: ["tests pass"] }));
  assert.deepEqual(done.changes, ["completion"]);
  assert.match(done.wakes[0]!.detail, /tests pass/);
  clock.at = start + 180_000;
  const after = feed.record(report({ reportId: "lease-1:4", sequence: 4, state: "done", evidence: ["tests pass"] }));
  assert.deepEqual(after.changes, []);
  feed.close();
});

test("a stall wakes once per episode and again after progress resumes", () => {
  const { feed, clock } = feedAt();
  feed.record(report());
  clock.at = start + DEFAULT_STALL_MS - 60_000;
  assert.deepEqual(feed.record(report({ reportId: "lease-1:2", sequence: 2, reportedAt: clock.at })).changes, []);
  clock.at = start + DEFAULT_STALL_MS + 60_000;
  const stalled = feed.record(report({ reportId: "lease-1:3", sequence: 3, reportedAt: clock.at }));
  assert.deepEqual(stalled.changes, ["stall"]);
  clock.at = start + DEFAULT_STALL_MS + 120_000;
  assert.deepEqual(feed.record(report({ reportId: "lease-1:4", sequence: 4, reportedAt: clock.at })).changes, []);
  for (const wake of feed.pendingWakes()) feed.acknowledge([wake.id]);
  clock.at = start + DEFAULT_STALL_MS + 180_000;
  const progress = feed.record(report({ reportId: "lease-1:5", sequence: 5, progressAt: clock.at, reportedAt: clock.at }));
  assert.deepEqual(progress.changes, []);
  clock.at = start + 2 * DEFAULT_STALL_MS + 240_000;
  const stalledAgain = feed.record(report({ reportId: "lease-1:6", sequence: 6, progressAt: start + DEFAULT_STALL_MS + 180_000, reportedAt: clock.at }));
  assert.deepEqual(stalledAgain.changes, ["stall"]);
  feed.close();
});

test("a session first seen already stalled wakes on its next push", () => {
  const { feed, clock } = feedAt();
  const late = start - DEFAULT_STALL_MS - 60_000;
  feed.record(report({ progressAt: late }));
  clock.at = start;
  const stalled = feed.record(report({ reportId: "lease-1:2", sequence: 2, progressAt: late }));
  assert.deepEqual(stalled.changes, ["stall"]);
  assert.equal(feed.pendingWakes().filter((wake) => wake.kind === "stall").length, 1);
  feed.close();
});

test("a stalled session that is waiting is not a stall", () => {
  const { feed, clock } = feedAt();
  feed.record(report());
  clock.at = start + 10 * DEFAULT_STALL_MS;
  const waiting = feed.record(report({ reportId: "lease-1:2", sequence: 2, state: "waiting", reportedAt: clock.at }));
  assert.deepEqual(waiting.changes, []);
  feed.close();
});

test("records survive reopening and each session keeps its own latest row", () => {
  const scratch = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(scratch, { recursive: true });
  const path = join(mkdtempSync(join(scratch, "session-status-")), "status.sqlite");
  const first = new SessionStatusFeed(path, { now: () => start });
  first.record(report());
  first.record(report({ sessionId: "lease-2", reportId: "lease-2:1", progressAt: start + 1 }));
  first.close();
  const second = new SessionStatusFeed(path);
  assert.deepEqual(second.latest().map((record) => record.sessionId).sort(), ["lease-1", "lease-2"]);
  assert.equal(second.latest()[0]!.state, "running");
  second.close();
});

test("rejects a report that is not a whole session snapshot", () => {
  const { feed } = feedAt();
  assert.throws(() => feed.record(report({ sessionId: "../escape" })), /sessionId/);
  assert.throws(() => feed.record(report({ sequence: -1 })), /sequence/);
  assert.throws(() => feed.record({ ...report(), extra: true }), /Unrecognized key|unrecognized/i);
  assert.throws(() => feed.record(report({ prUrl: "not a url with spaces" })), /prUrl/);
  feed.close();
});
