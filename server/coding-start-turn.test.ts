import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { test } from "vitest";
import { createCodingStartTurnPort } from "./coding-start-turn.ts";
import type { Store } from "./store.ts";
import type { IsolatedWorkspace } from "./inner-worker-route.ts";

const cwd = process.cwd();
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const workspace: IsolatedWorkspace = { repository: "fixture/agents", directory: cwd, branch: "main", base: "main", leaseId: "lease" };

test("normal turn callback gets the originating approval mode and persisted output, then refuses replay", async () => {
  const tasks: Array<{ title: string; threadId: string; cwd?: string }> = [];
  const messages: Array<{ id: string; role: "bot"; kind: "text"; text: string; turnTerminal: boolean }> = [];
  let pinned: unknown;
  const store = {
    bot: () => ({ id: "worker" }),
    tasks: () => tasks,
    createTask(_botId: string, title: string) {
      const task = { title, threadId: "thread-1", cwd, createdAt: 1 };
      tasks.push(task);
      return task;
    },
    patchTask(_botId: string, _threadId: string, patch: unknown) { pinned = patch; return tasks[0]; },
    messagesFor: () => messages,
  } as unknown as Pick<Store, "bot" | "tasks" | "createTask" | "patchTask" | "messagesFor">;
  const port = createCodingStartTurnPort({ store, approvalMode: () => "ask", driverKind: () => "piAgent",
    costForThread: async () => 0,
    async startTurn(_botId, _text, { requestId, onTurnSettled }) {
      assert.equal(requestId, "review:1");
      assert.deepEqual(pinned, { cwd, approvalMode: "ask" });
      messages.push({ id: "answer", role: "bot", kind: "text", text: `ACCEPT ${revision}`, turnTerminal: true });
      onTurnSettled();
    },
    async interrupt() {},
  });
  const signal = new AbortController().signal;
  const result = await port.run({ botId: "worker", workspace, role: "review", prompt: "Review", requestId: "review:1", signal });
  assert.deepEqual(result, { revision, evidence: [`ACCEPT ${revision}`], accepted: true, costUsd: 0 });
  await assert.rejects(port.run({ botId: "worker", workspace, role: "review", prompt: "Review", requestId: "review:1", signal }),
    /already completed/);
});
