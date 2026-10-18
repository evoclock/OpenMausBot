import { afterEach, describe, expect, it } from "vitest";

import { BUILT_IN_BROWSER_SYSTEM_PROMPT } from "../browser-engine.ts";
import { CHROME_BROWSER_SYSTEM_PROMPT } from "../browser/prompt.ts";
import { TOOL_LIST } from "../browser/tools.ts";
import type { AppConfig } from "../config.ts";
import type { Store } from "../store.ts";
import { createBrowserHost } from "./browser.ts";

type Host = ReturnType<typeof createBrowserHost>;
const hosts: Host[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.browserRuntime.closeAll())); });

const turn = { threadId: "thread-1", generation: "gen-1" };

function setup(engine: "chrome" | "agent-browser" | undefined) {
  const cfg = {
    features: { browser: true },
    ...(engine ? { browserEngine: { engine } } : {}),
    browserProfiles: [
      { id: "work", name: "Work", partitionId: "p-work" },
      { id: "mine", name: "Mine", browser: "chrome", partitionId: "p-mine" },
    ],
  } as unknown as AppConfig;
  const bots = [{ id: "scout", name: "Scout", browser: true }];
  const minted: unknown[] = [];
  const host = createBrowserHost({
    cfg,
    store: () => ({ bots, bot: (id: string) => bots.find((bot) => bot.id === id) }) as unknown as Pick<Store, "bots" | "bot">,
    turnResources: { free: () => true },
    activeInternalGenerationByThread: new Map([[turn.threadId, turn.generation]]),
    mintInternalCapability: (capability) => { minted.push(capability); return "capability-token"; },
    DESKTOP_MANAGED: true,
    CLOUD_HOME: null,
    PORT: 4100,
  });
  hosts.push(host);
  return { cfg, host, minted };
}

describe("the bots' browser host with browserEngine.engine set to chrome", () => {
  it("gives a bot's turn the browser MCP server over its own profile on the new engine", async () => {
    const { host, minted } = setup("chrome");
    const browser = await host.browserIntegration("scout", undefined, turn);
    expect(browser?.spec).toEqual({ command: "omb-cdp", args: ["bot:scout"], env: {} });
    expect(browser?.integration).toMatchObject({ command: process.execPath, env: { OMB_HARNESS_URL: "http://127.0.0.1:4100" } });
    expect(minted).toEqual([expect.objectContaining({ botId: "scout", browserSession: browser?.session, kind: "browser", ...turn })]);
    expect(host.usedBrowserSessions.get(browser!.session)).toEqual(browser?.spec);
  });

  it("puts a shared profile's bots on one profile and a temporary browser on its own", async () => {
    const { host } = setup("chrome");
    expect((await host.browserIntegration("scout", "work"))?.spec.args).toEqual(["shared:p-work"]);
    const guest = await host.browserIntegration("scout", "guest");
    expect(guest?.spec.args).toEqual([`temp:${guest?.session}`]);
  });

  it("lists the new browser's tools without starting Chrome", async () => {
    const { host } = setup("chrome");
    const browser = await host.browserIntegration("scout", undefined, turn);
    const listed = await host.browserRuntime.agentRpc(browser!.session, browser!.spec as never, "tools/list", {}) as { tools: Array<{ name: string }> };
    expect(listed.tools.map((tool) => tool.name)).toEqual(TOOL_LIST.map((tool) => tool.name));
  });

  it("keeps a profile on the person's own Chrome on agent-browser: its prompt, and no sites list from either", () => {
    const { host } = setup("chrome");
    expect(host.browserSystemPrompt(undefined)).toBe(CHROME_BROWSER_SYSTEM_PROMPT);
    expect(host.browserSystemPrompt("work")).toBe(CHROME_BROWSER_SYSTEM_PROMPT);
    expect(host.browserSystemPrompt("mine")).toBe(BUILT_IN_BROWSER_SYSTEM_PROMPT);
    expect(host.signedInSitesRefusal("mine")).toContain("your own Chrome");
    expect(host.signedInSitesRefusal("work")).toContain("does not list signed-in sites yet");
  });

  it("says in the status which engine runs the bots' browsers", () => {
    const { cfg, host } = setup("chrome");
    expect(host.engineSummary({ kind: "unavailable", reason: "agent-browser is not installed", myChrome: true })).toMatchObject({ engine: "chrome", myChrome: true });
    cfg.browserEngine = { engine: "agent-browser" };
    expect(host.engineSummary({ kind: "unavailable", reason: "agent-browser is not installed", myChrome: true })).toEqual({ kind: "unavailable", reason: "agent-browser is not installed", myChrome: true, engine: "agent-browser" });
  });

  it("forgets the new engine's sessions when the engine is switched back", async () => {
    const { cfg, host } = setup("chrome");
    const browser = await host.browserIntegration("scout", undefined, turn);
    cfg.browserEngine = { engine: "agent-browser" };
    host.browserEngineSwitched();
    expect(host.usedBrowserSessions.has(browser!.session)).toBe(false);
    expect(host.browserSystemPrompt(undefined)).toBe(BUILT_IN_BROWSER_SYSTEM_PROMPT);
  });
});

describe("the bots' browser host by default", () => {
  it("keeps agent-browser's prompt and status", () => {
    const { host } = setup(undefined);
    expect(host.browserSystemPrompt(undefined)).toBe(BUILT_IN_BROWSER_SYSTEM_PROMPT);
    expect(host.signedInSitesRefusal("work")).toBeNull();
    expect(host.engineSummary({ kind: "engine", version: "0.37.0", myChrome: true })).toEqual({ kind: "engine", version: "0.37.0", myChrome: true, engine: "agent-browser" });
  });
});
