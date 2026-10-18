import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BotsSaveError } from "./bots-save.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const locked = () => Object.assign(new Error("EPERM: operation not permitted, rename 'bots.json.tmp' -> 'bots.json'"), { code: "EPERM" });

function failNextSave(store: Store, error: Error = locked()) {
  return vi.spyOn(store as unknown as { saveBots(bots?: BotRecord[]): void }, "saveBots")
    .mockImplementationOnce(() => { throw error; });
}

function storeWithTwoThreads() {
  const store = new Store(selection);
  const bot = store.createBot();
  const first = store.activeTask(bot.id)!;
  store.setResumeCursor(bot.id, "claude", "session-one");
  store.patchTask(bot.id, first.threadId, { pinnedMessageId: "pin-one" });
  const second = store.createTask(bot.id)!;
  store.setResumeCursor(bot.id, "claude", "session-two");
  const changes = vi.fn();
  store.onChange(changes);
  return { store, bot, first, second, changes };
}

describe("bots.json save failures", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("keeps the selected thread, its session and its pin when a switch cannot be saved", () => {
    const { store, bot, first, second, changes } = storeWithTwoThreads();
    failNextSave(store);

    expect(() => store.switchTask(bot.id, first.threadId))
      .toThrow("Couldn't save the thread switch: another program is holding OpenMausBot's bots.json, or its folder is read-only.");
    expect(bot).toMatchObject({ threadId: second.threadId, resumeCursors: { claude: "session-two" } });
    expect(bot.pinnedMessageId).toBeUndefined();
    expect(changes).not.toHaveBeenCalled();
    expect(new Store(selection).bot(bot.id)?.threadId).toBe(second.threadId);

    store.switchTask(bot.id, first.threadId);
    expect(bot).toMatchObject({ threadId: first.threadId, resumeCursors: { claude: "session-one" }, pinnedMessageId: "pin-one" });
    expect(changes).toHaveBeenCalledWith({ type: "bot", botId: bot.id });
    expect(new Store(selection).bot(bot.id)?.threadId).toBe(first.threadId);
  });

  it("does not open a new thread that was never saved", () => {
    const { store, bot, second, changes } = storeWithTwoThreads();
    const tasks = bot.tasks;
    failNextSave(store);

    expect(() => store.createTask(bot.id, "Never saved")).toThrow(BotsSaveError);
    expect(bot.tasks).toBe(tasks);
    expect(store.tasks(bot.id).map((task) => task.title)).not.toContain("Never saved");
    expect(bot.threadId).toBe(second.threadId);
    expect(changes).not.toHaveBeenCalled();
  });

  it("restores a thread edit, including the bot's unread mark, when it cannot be saved", () => {
    const { store, bot, first } = storeWithTwoThreads();
    failNextSave(store);

    expect(() => store.patchTask(bot.id, first.threadId, { title: "Renamed", unread: true, archivedAt: 1 })).toThrow(BotsSaveError);
    expect(first).toMatchObject({ unread: false });
    expect(first.title).not.toBe("Renamed");
    expect(first.archivedAt).toBeUndefined();
    expect(bot.unread).toBeFalsy();
  });

  it("keeps a revoked approval live when its save fails, and never applies an unsaved widening", () => {
    const { store, bot, second } = storeWithTwoThreads();
    store.patchTask(bot.id, second.threadId, { approvalMode: "full", autoApprove: false, alwaysAllow: ["tool-a"] });
    failNextSave(store);

    expect(() => store.patchTask(bot.id, second.threadId, { approvalMode: "ask", autoApprove: false, alwaysAllow: [] })).toThrow(BotsSaveError);
    expect(second).toMatchObject({ approvalMode: "ask", alwaysAllow: [] });
    expect(new Store(selection).taskByThread(bot.id, second.threadId)).toMatchObject({ approvalMode: "full" });

    failNextSave(store);
    expect(() => store.patchTask(bot.id, second.threadId, { approvalMode: "full" })).toThrow(BotsSaveError);
    expect(second.approvalMode).toBe("ask");
    failNextSave(store);
    expect(() => store.patchTask(bot.id, second.threadId, { alwaysAllow: ["tool-b"] })).toThrow(BotsSaveError);
    expect(second.alwaysAllow).toEqual([]);
  });

  it("keeps a thread and its conversation when its deletion cannot be saved, and deletes both on retry", () => {
    const { store, bot, first, second, changes } = storeWithTwoThreads();
    store.appendMessage(second.threadId, { role: "user", kind: "text", text: "Keep this conversation" });
    changes.mockClear();
    failNextSave(store);

    expect(() => store.deleteTasks(bot.id, [second.threadId])).toThrow("Couldn't save the thread deletion");
    expect(store.tasks(bot.id).map((task) => task.threadId)).toEqual([second.threadId, first.threadId]);
    expect(new Store(selection).messagesFor(second.threadId).map((message) => message.text)).toEqual(["Keep this conversation"]);
    expect(bot.threadId).toBe(second.threadId);
    expect(changes).not.toHaveBeenCalled();
    expect(new Store(selection).tasks(bot.id)).toHaveLength(2);

    expect(store.deleteTasks(bot.id, [second.threadId])?.deleted).toEqual([second.threadId]);
    expect(bot.threadId).toBe(first.threadId);
    expect(changes).toHaveBeenCalledWith({ type: "thread.deleted", threadId: second.threadId });
    expect(new Store(selection).tasks(bot.id).map((task) => task.threadId)).toEqual([first.threadId]);
    expect(new Store(selection).messagesFor(second.threadId)).toEqual([]);
  });

  it("keeps what already happened in memory and saves it with the next write", () => {
    const { store, bot, first, second } = storeWithTwoThreads();
    failNextSave(store);

    expect(() => store.setResumeCursor(bot.id, "claude", "session-three"))
      .toThrow("Couldn't save the conversation's engine session: another program is holding OpenMausBot's bots.json, or its folder is read-only.");
    expect(second.resumeCursors.claude).toBe("session-three");
    failNextSave(store);
    expect(() => store.setHandedMessages(bot.id, second.threadId, "claude", { session: "session-three", ids: [] }))
      .toThrow("Couldn't save what this conversation handed its engine");
    expect(second.handedMessages?.claude).toEqual({ session: "session-three", ids: [] });
    failNextSave(store);
    expect(() => store.setTaskAskedAt(bot.id, second.threadId, 1_234)).toThrow("Couldn't save when you last wrote in this thread");
    expect(second.askedAt).toBe(1_234);

    store.patchTask(bot.id, first.threadId, { title: "Next write" });
    const reloaded = new Store(selection).taskByThread(bot.id, second.threadId);
    expect(reloaded?.resumeCursors.claude).toBe("session-three");
    expect(reloaded?.handedMessages?.claude).toEqual({ session: "session-three", ids: [] });
    expect(reloaded?.askedAt).toBe(1_234);
  });

  it("names the unsaved action and keeps the raw error as its cause", () => {
    const fullDisk = new BotsSaveError("the thread's usage", Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));

    expect(fullDisk.message).toBe("Couldn't save the thread's usage: OpenMausBot couldn't write bots.json.");
    expect(fullDisk.cause).toMatchObject({ code: "ENOSPC" });
  });
});
