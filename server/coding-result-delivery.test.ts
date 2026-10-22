import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { CodingResultDelivery, type CodingResult } from "./coding-result-delivery.ts";

const result: CodingResult = { runId: "run-1", botId: "bot-1", threadId: "thread-1", text: "Verified result" };
function fixture() {
  const root = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(root, { recursive: true });
  return join(mkdtempSync(join(root, "coding-delivery-")), "receipts.sqlite");
}

test("restart between transcript post and receipt update does not duplicate delivery", () => {
  const path = fixture();
  const transcript = new Map<string, Set<string>>();
  let posts = 0;
  let crash = true;
  const sink = {
    contains(threadId: string, runId: string) { return transcript.get(threadId)?.has(runId) ?? false; },
    post(input: CodingResult) {
      posts++;
      const messages = transcript.get(input.threadId) ?? new Set<string>();
      messages.add(input.runId);
      transcript.set(input.threadId, messages);
      if (crash) throw new Error("crashed after transcript commit");
    },
  };
  let ledger = new CodingResultDelivery(path, sink);
  assert.throws(() => ledger.deliver(result), /crashed/);
  ledger.close();
  crash = false;
  ledger = new CodingResultDelivery(path, sink);
  try {
    assert.equal(ledger.replay(), 1);
    assert.equal(ledger.deliver(result), "delivered");
    assert.equal(posts, 1);
    assert.equal(transcript.get("thread-1")?.size, 1);
    assert.throws(() => ledger.deliver({ ...result, threadId: "other-thread" }), /conflicts/);
  } finally { ledger.close(); }
});

test("restart before post retries pending receipt at the original thread", () => {
  const path = fixture();
  const messages: string[] = [];
  let fail = true;
  const sink = {
    contains(threadId: string, runId: string) { return messages.includes(`${threadId}:${runId}`); },
    post(input: CodingResult) { if (fail) throw new Error("offline"); messages.push(`${input.threadId}:${input.runId}`); },
  };
  let ledger = new CodingResultDelivery(path, sink);
  assert.throws(() => ledger.deliver(result), /offline/);
  ledger.close();
  fail = false;
  ledger = new CodingResultDelivery(path, sink);
  try {
    assert.equal(ledger.replay(), 1);
    assert.deepEqual(messages, ["thread-1:run-1"]);
    assert.equal(ledger.replay(), 0);
  } finally { ledger.close(); }
});
