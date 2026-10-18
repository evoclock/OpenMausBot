// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  api: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  api: (...args: unknown[]) => fixture.api(...args),
}));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => false }));

const { NewAutomation, defaultBot } = await import("./NewAutomation");
const { AutomationPanel } = await import("./AutomationPanel");
const { automationsFrom } = await import("@/lib/automations");

const now = Date.now();
const botA = { id: "bot-a", name: "Scout", threadId: "thread-a", hidden: false, messages: [{ id: "m1", at: now - 5_000 }] } as unknown as Bot;
const botB = { id: "bot-b", name: "Ledger", threadId: "thread-b", hidden: false, messages: [{ id: "m2", at: now - 50_000 }] } as unknown as Bot;
const webhook = { id: "hook-1", endpointId: "wh_abc", name: "Sales form leads", prompt: "Draft a follow-up for the lead.", botId: "bot-a", runOn: "maus", enabled: true, createdAt: now, updatedAt: now, deliveryCount: 1 };

let root: Root | null = null;
function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(element));
  return container;
}
const button = (container: HTMLElement, label: string) => {
  const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`no ${label} button in ${container.innerHTML}`);
  return found;
};
beforeEach(() => {
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.api.mockResolvedValue({});
  fixture.state = { bots: [botA, botB], selectedId: "", routines: [], webhooks: [webhook], routineRuns: [], webhookIngress: { available: true, baseUrl: "http://127.0.0.1:8800" } };
});
afterEach(() => { root?.unmount(); root = null; document.body.innerHTML = ""; });

describe("+ New", () => {
  it("talks to the bot open now, else the one most recently talked to", () => {
    expect(defaultBot([botA, botB], "bot-b")?.id).toBe("bot-b");
    expect(defaultBot([botB, botA], "")?.id).toBe("bot-a");
  });

  it("sends what should happen to that bot as a normal chat message and opens the conversation", () => {
    const onClose = vi.fn();
    const container = mount(createElement(NewAutomation, { initialText: "every morning at 9, send me a summary of my inbox", onClose, onSetUpYourself: vi.fn() }));
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("e.g. every morning at 9, send me a summary of my inbox");
    expect(container.querySelector('select[aria-label="Who should do it?"]')).not.toBeNull();
    flushSync(() => button(container, "Set it up").click());
    expect(fixture.dispatch).toHaveBeenNthCalledWith(1, { type: "select", id: "bot-a" });
    expect(fixture.dispatch).toHaveBeenNthCalledWith(2, { type: "send", botId: "bot-a", text: "every morning at 9, send me a summary of my inbox", threadId: "thread-a" });
    expect(onClose).toHaveBeenCalled();
  });

  it("asks no bot question with one bot, and does nothing until something is written", () => {
    fixture.state.bots = [botA];
    const container = mount(createElement(NewAutomation, { onClose: vi.fn(), onSetUpYourself: vi.fn() }));
    expect(container.querySelector("select")).toBeNull();
    expect(button(container, "Set it up").hasAttribute("disabled")).toBe(true);
  });

  it("lets a person set it up themselves: a schedule, or when another app sends something", () => {
    const onSetUpYourself = vi.fn();
    const container = mount(createElement(NewAutomation, { onClose: vi.fn(), onSetUpYourself }));
    flushSync(() => button(container, "Set it up yourself").click());
    flushSync(() => button(container, "When another app sends something").click());
    flushSync(() => button(container, "Continue").click());
    expect(onSetUpYourself).toHaveBeenCalledWith("webhook");
  });
});

describe("the automation panel", () => {
  it("shows the sentence, the status, an address to paste with Copy address, the recent runs and the four actions, in plain words", () => {
    fixture.state.routineRuns = [{ id: "run-1", routineId: "hook-1", botId: "bot-a", status: "completed", scheduledFor: now - 60_000, startedAt: now - 60_000, createdAt: now - 60_000, output: "Drafted a follow-up for Ada.", threadId: "exec-1" }];
    const [automation] = automationsFrom({ routines: [], webhooks: [webhook] as never, runs: fixture.state.routineRuns as never });
    const container = mount(createElement(AutomationPanel, { automation: automation!, sentence: "When your sales form sends something, Scout drafts a follow-up for the lead", onClose: vi.fn(), onEdit: vi.fn(), onDeleted: vi.fn() }));
    const text = container.textContent ?? "";
    expect(text).toContain("When your sales form sends something, Scout drafts a follow-up for the lead");
    expect(text).toContain("Working");
    expect(text).toContain("Paste this address into the other app");
    expect(text).toContain("Recent runs");
    expect(text).toMatch(/Today [^✓]*✓Drafted a follow-up for Ada\./);
    for (const label of ["Copy address", "Run now", "Pause", "Edit", "Delete"]) expect(button(container, label)).toBeTruthy();
    expect(container.querySelector("details summary")!.textContent).toBe("More");
    expect(container.querySelector("details")!.textContent).toContain("Show secret / settings");
    const visible = text.replace(container.querySelector("details")!.textContent ?? "", "");
    expect(visible).not.toMatch(/webhook|endpoint|payload|fired|trigger/i);
  });

  it("runs now through the test route, and pauses through its own API", async () => {
    const [automation] = automationsFrom({ routines: [], webhooks: [webhook] as never, runs: [] });
    const container = mount(createElement(AutomationPanel, { automation: automation!, sentence: "s", onClose: vi.fn(), onEdit: vi.fn(), onDeleted: vi.fn() }));
    flushSync(() => button(container, "Run now").click());
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledWith("/api/webhooks/hook-1/test", expect.objectContaining({ method: "POST" })));
    expect(container.textContent).toContain("It hasn't run yet.");
  });
});
