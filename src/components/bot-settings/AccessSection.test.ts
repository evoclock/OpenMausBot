import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot, type ConfigStatus } from "@/state/store";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  mcpError: false,
  servers: null as null | Array<{ name: string; enabled: boolean }>,
  config: null as unknown,
  apps: { phase: "loading", apps: [], connectedSlugs: [] } as import("./useBotApps").BotApps,
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fixture.config ?? original.initialState.config }, dispatch: fixture.dispatch }) };
});
// The connected-apps list (Composio accounts plus the native HighLevel connection) is seeded per test.
vi.mock("./useBotApps", async (importOriginal) => ({
  ...await importOriginal<typeof import("./useBotApps")>(),
  useBotApps: () => fixture.apps,
}));
vi.mock("@/lib/mcp-servers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/mcp-servers")>(),
  useMcpServers: () => ({ servers: fixture.servers, error: fixture.mcpError, refresh: vi.fn() }),
}));

// DesktopCapabilities reads window.ogb at module scope, and this suite runs in the node environment.
vi.mock("../DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { homeDir: undefined } } }),
}));

const { AccessSection } = await import("./AccessSection");

// WorkingFolder reads window.ogb?.pickFolder at render time, so window is stubbed per test.
beforeEach(() => {
  vi.stubGlobal("window", {});
  fixture.dispatch.mockReset();
  fixture.mcpError = false;
  fixture.servers = null;
  fixture.config = null;
  fixture.apps = { phase: "loading", apps: [], connectedSlugs: [] };
});
afterEach(() => vi.unstubAllGlobals());

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    threadId: "thread-1",
    name: "Scout",
    title: "Scout",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "local", model: "test-model" },
    messages: [],
    ...overrides,
  };
}

function makeDerived(overrides: Partial<ReturnType<typeof useBotSettingsDerived>> = {}): ReturnType<typeof useBotSettingsDerived> {
  return {
    patch: vi.fn(),
    engine: undefined,
    canCoordinate: false,
    canUseConnectedApps: true,
    connectedAppsConfigured: true,
    connectedAppsEnabled: true,
    canUseBrowser: false,
    desktopBrowser: false,
    browserBlockedOnWindows: false,
    browserFeature: true,
    browserAllowed: true,
    browserEnabled: false,
    browserSelectable: false,
    browserDisabledReason: "The built-in browser needs the OpenMausBot desktop app",
    sectionName: "General",
    currentChief: undefined,
    botRoutines: [],
    activeBotRoutines: 0,
    localSelectable: false,
    localDisabledReason: null,
    activeState: "idle",
    mascotMotion: null,
    ...overrides,
  } as ReturnType<typeof useBotSettingsDerived>;
}

function render(bot: Bot, derived = makeDerived()) {
  return renderToStaticMarkup(
    createElement(StoreProvider, null, createElement(AccessSection, { bot, derived })),
  );
}

describe("owner tool selection status", () => {
  it("distinguishes the legacy catalog from an explicit no-tools selection", () => {
    expect(render(makeBot())).toContain("All current tools");
    const empty = render(makeBot({ toolScope: { allow: [] } } as Partial<Bot>));
    expect(empty).toContain("No tools selected");
    expect(empty).not.toContain("All current tools</p>");
    expect(empty).toContain("Existing approvals still apply");
  });

  it("shows corrupt saved restrictions as a blocked setup, never all tools", () => {
    const corrupt = render(makeBot({ toolScope: { allow: "native:*" } } as unknown as Partial<Bot>));
    expect(corrupt).toContain("Invalid saved selection. This bot cannot start until it is repaired.");
    expect(corrupt).toContain('role="alert"');
  });

  it("explains native restrictions that the selected engine cannot enforce", () => {
    const engine = { driverKind: "claudeAgent" } as NonNullable<ReturnType<typeof useBotSettingsDerived>["engine"]>;
    const markup = render(makeBot({ toolScope: { allow: ["native:read"] } } as Partial<Bot>), makeDerived({ engine }));
    expect(markup).toContain("This engine cannot limit native tools");
    expect(markup).toContain("native:*");
    expect(markup).toContain("will stop before sending a prompt");
  });

  it("keeps the selection editor disabled while a task is active", () => {
    const markup = render(makeBot({ busy: true }));
    expect(markup).toContain('aria-label="Tool selection" disabled=""');
    expect(markup).toContain("Wait until this bot finishes all active tasks before changing its tool selection.");
  });
});

describe("AccessSection always-allowed list", () => {
  it("keeps per-bot MCP changes disabled while any task is active", () => {
    fixture.servers = [{ name: "notes", enabled: true }, { name: "offline", enabled: false }];
    const markup = render(makeBot({ busy: true, mcpServers: ["notes"] }));
    expect(markup).toContain('disabled="" aria-label="Let this bot use notes"');
    expect(markup).toContain('disabled="" aria-label="Let this bot use offline"');
    expect(markup).toMatch(/<button type="button" disabled=""[^>]*>Use every enabled server<\/button>/);
    expect(markup).toContain("finishes all active tasks");
    expect(markup).toContain("Individual tool approvals depend on the model provider and approval mode.");
    const idle = render(makeBot({ mcpServers: ["notes"] }));
    expect(idle).not.toContain('disabled="" aria-label="Let this bot use notes"');
    expect(idle).toContain('disabled="" aria-label="Let this bot use offline"');
    expect(idle).not.toContain("finishes all active tasks");
  });

  it("opens the established app connection flow without authorizing a second way", () => {
    let tree!: ReturnType<typeof AccessSection>;
    function Capture() { tree = AccessSection({ bot: makeBot(), derived: makeDerived() }); return tree; }
    renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
    type Node = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
    const nodes = (value: ReactNode): Node[] => {
      if (!isValidElement(value)) return [];
      const node = value as Node;
      return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
    };
    const connect = nodes(tree).find((node) => node.type === "button" && renderToStaticMarkup(node).includes("Connect an app"))!;
    connect.props.onClick!();
    expect(fixture.dispatch.mock.calls).toEqual([
      [{ type: "toggleSettings", open: false }],
      [{ type: "togglePlugins", open: true, surface: "apps" }],
    ]);
  });

  it("offers a retry instead of a permanent MCP loading state after a read failure", () => {
    fixture.mcpError = true;
    fixture.servers = [{ name: "notes", enabled: true }];
    const markup = render(makeBot());
    expect(markup).toContain("Could not refresh MCP servers.");
    expect(markup).toContain("Retry");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('disabled="" aria-label="Let this bot use notes"');
  });

  it("shows a placeholder when nothing is standing yet", () => {
    const markup = render(makeBot());
    expect(markup).toContain("Nothing standing yet.");
  });

  it("lists each always-allowed entry with a Remove button", () => {
    const markup = render(makeBot({ alwaysAllow: ["shell.run", "fs.write"] }));
    expect(markup).toContain("shell.run");
    expect(markup).toContain("fs.write");
    expect(markup).toContain('aria-label="Remove shell.run from always allowed"');
    expect(markup).toContain('aria-label="Remove fs.write from always allowed"');
    expect(markup).not.toContain("Nothing standing yet.");
  });
});

describe("AccessSection Works on", () => {
  type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; [key: string]: unknown }>;
  const nodes = (value: ReactNode): Node[] => {
    if (!isValidElement(value)) return [];
    const node = value as Node;
    return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
  };

  it("is one line and the way to the Computer panel, where the place is chosen", () => {
    const markup = render(makeBot());
    expect(markup).toContain("Where Scout works: Chooses for you");
    expect(markup).toContain("Open Computer panel");
    expect([...markup.matchAll(/>(Auto|Cloud|Local VM|This computer|Browser|Off)<\/button>/g)]).toEqual([]);
    expect(render(makeBot({ computer: "off" }))).toContain("Where Scout works: No screen");

    let tree!: ReturnType<typeof AccessSection>;
    function Capture() { tree = AccessSection({ bot: makeBot(), derived: makeDerived() }); return tree; }
    renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
    const open = nodes(tree).find((node) => node.type === "button" && renderToStaticMarkup(node).includes("Open Computer panel"))!;
    open.props.onClick!();
    expect(fixture.dispatch.mock.calls).toEqual([
      [{ type: "toggleSettings", open: false }],
      [{ type: "toggleComputer", open: true }],
    ]);
  });

  it("hides the Boat or VPS choice on My Cloud, whose cloud computers are the plan's", () => {
    expect(render(makeBot())).toContain("Cloud backend");
    fixture.config = { cloudHome: true } as Partial<ConfigStatus>;
    expect(render(makeBot())).not.toContain("Cloud backend");
    expect(render(makeBot({ computer: "cloud" }))).not.toContain("Boat");
  });
});

describe("AccessSection Record browser steps", () => {
  type Node = ReactElement<{ children?: ReactNode; [key: string]: unknown }>;
  const nodes = (value: ReactNode): Node[] => {
    if (!isValidElement(value)) return [];
    const node = value as Node;
    return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
  };
  const browserOn = () => makeDerived({ browserEnabled: true, desktopBrowser: true, canUseBrowser: true });

  it("asks for the browser first, then says what it saves and for how long, with no prompt", () => {
    expect(render(makeBot())).toContain("Turn on the browser first.");
    expect(render(makeBot(), browserOn())).toContain("Browser steps are not saved.");
    const on = render(makeBot({ recordBrowserSteps: true }), browserOn());
    expect(on).toContain("Saves a screenshot and a short note of each click, typing and page change");
    expect(on).toContain("Kept with this conversation for 30 days.");
    expect(on).toContain('aria-label="Record browser steps"');
  });

  it("turns it on with one bot patch", () => {
    const derived = browserOn();
    let tree!: ReturnType<typeof AccessSection>;
    function Capture() { tree = AccessSection({ bot: makeBot(), derived }); return tree; }
    renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
    const row = nodes(tree).find((node) => typeof node.props.onChange === "function" && "browserOn" in node.props)!;
    (row.props.onChange as (on: boolean) => void)(true);
    expect(derived.patch).toHaveBeenCalledWith({ recordBrowserSteps: true });
  });

  it("says the screenshots show the person's own Chrome when the bot uses it", () => {
    fixture.config = { browserEngine: { myChrome: true }, browserProfiles: [{ id: "mine", browser: "chrome" }] } as unknown as Partial<ConfigStatus>;
    expect(render(makeBot({ recordBrowserSteps: true, browserProfile: "mine" }), browserOn())).toContain("This bot uses your own Chrome, so the screenshots show your Chrome.");
    expect(render(makeBot({ recordBrowserSteps: true }), browserOn())).not.toContain("your own Chrome");
  });
});

describe("AccessSection per-app scopes", () => {
  const app = (slug: string, label: string) => ({ slug, label, blurb: "", card: { logo: null, domain: null, label }, scope: "write" as const });

  it("lists HighLevel by name next to the Composio apps once the server reports it connected", () => {
    fixture.apps = { phase: "ready", connectedSlugs: ["gmail", "highlevel"], apps: [app("gmail", "Gmail"), app("highlevel", "HighLevel")] };
    const html = render(makeBot({ connectorScopes: { apps: { gmail: "write" } } }));
    expect(html).toContain('aria-label="highlevel access"');
    expect(html).toMatch(/<span class="min-w-0 text-\[13px\] text-ink">HighLevel</);
    expect(html).not.toContain("not connected");
    // Tool-by-tool grants are Composio's list; HighLevel is scoped by read/write only.
    expect([...html.matchAll(/truncate font-mono text-\[12\.5px\] text-ink">([^<]*)</g)].map((match) => match[1])).toEqual(["gmail"]);
  });

  it("leaves HighLevel out while it is not connected", () => {
    fixture.apps = { phase: "ready", connectedSlugs: ["gmail"], apps: [app("gmail", "Gmail")] };
    const html = render(makeBot({ connectorScopes: { apps: { gmail: "write" } } }));
    expect(html).not.toContain("HighLevel");
    expect(html).not.toContain("highlevel");
  });

  it("shows no scope rows until the account list is known", () => {
    const html = render(makeBot({ connectorScopes: { apps: { gmail: "write" } } }));
    expect(html).not.toContain("Limit this bot to specific apps");
  });
});

describe("AccessSection parts", () => {
  it("renders only the cards a page asks for, and every card without parts", () => {
    fixture.servers = [{ name: "notes", enabled: true }];
    const full = render(makeBot());
    for (const text of ["Where Scout works", "Working folder", "Connected apps", "Let this bot use notes", "Browser", "Webhooks", "Always allowed"]) {
      expect(full).toContain(text);
    }
    const mcp = renderToStaticMarkup(createElement(StoreProvider, null, createElement(AccessSection, { bot: makeBot(), derived: makeDerived(), parts: ["mcp"] })));
    expect(mcp).toContain("Let this bot use notes");
    for (const text of ["Where Scout works", "Working folder", "Connected apps", "Webhooks", "Always allowed"]) expect(mcp).not.toContain(text);
    const folder = renderToStaticMarkup(createElement(StoreProvider, null, createElement(AccessSection, { bot: makeBot(), derived: makeDerived(), parts: ["folder"] })));
    expect(folder).toContain("Working folder");
    expect(folder).not.toContain("Let this bot use notes");
  });
});
