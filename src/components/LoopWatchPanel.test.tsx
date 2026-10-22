// @vitest-environment happy-dom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";
import { LoopWatchPanel } from "./LoopWatchPanel";

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

it("displays run state and budgets without control actions", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ runs: [{
    id: "run", state: "waiting", iteration: 2, lastVerdict: "waiting",
    budget: { iterationsUsed: 2, iterationsRemaining: 6, spentUsd: 1, spendRemainingUsd: 3,
      spendUncertain: false, elapsedMs: 2000, wallTimeRemainingMs: 8000 },
    entries: [{ iteration: 2, state: "waiting", at: 3, verdict: "waiting" }],
  }] }))));
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  flushSync(() => root.render(createElement(LoopWatchPanel, { botId: "one" })));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(document.body.textContent).toContain("6 remaining");
  expect(document.body.textContent).toContain("#2: waiting");
  expect(document.querySelectorAll("button")).toHaveLength(0);
  expect(fetch).toHaveBeenCalledWith("/api/bots/one/loop-status", expect.anything());
  flushSync(() => root.unmount());
});
