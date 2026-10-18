// @vitest-environment happy-dom
// The Simple bot panel in a real DOM, where effects run and focus moves: named links, Escape and focus.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, BotSettingsSection } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: original.initialState, dispatch: fixture.dispatch, flushBotPatches: () => Promise.resolve(null) }),
  };
});
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, readAdvancedMode: () => false, setAdvancedMode: vi.fn() }));
vi.mock("../DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("../DesktopCapabilities")>(),
  useCaptionChrome: () => ({ dragProps: {}, padClass: "" }),
}));
vi.mock("../Avatar", () => ({ BotAvatar: () => null, MausAvatar: () => null }));
vi.mock("../AvatarImageGenerator", () => ({ AvatarImageGenerator: () => null }));
vi.mock("@/lib/use-organization-branding", () => ({ useOrganizationBranding: () => null }));
vi.mock("../bot-settings/MemorySection", () => ({ MemorySection: () => null }));
vi.mock("../bot-settings/useBotOverview", () => ({
  useBotOverview: () => ({ overview: null, overviewError: false, prompt: null, promptError: false }),
  useBotHistory: () => ({ rows: null, error: false, revision: null, rollingBack: false }),
  HistoryRollbackDialog: () => null,
}));
const stub = (name: string) => () => createElement("div", { [`data-stub-${name}`]: true });
vi.mock("./DetailsTab", () => ({ DetailsTab: stub("details") }));
vi.mock("./LibraryTab", () => ({ LibraryTab: stub("library") }));
vi.mock("./ComputerTab", () => ({ ComputerTab: stub("computer") }));
vi.mock("./SettingsTab", () => ({ SettingsTab: stub("settings") }));
vi.mock("./pages", () => ({ PageBody: ({ page }: { page: string }) => createElement("div", { "data-stub-page": page }), pageSurfaceCls: "" }));

const { BotPanel } = await import("./PanelShell");
const { openBotSettings } = await import("./panel-link");

const bot: Bot = {
  id: "scout", threadId: "thread-scout", name: "Scout", title: "Researcher", description: "", soul: "",
  notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
};
const onClose = vi.fn();
const derived = { activeState: "idle", patch: vi.fn() } as never;

let host: HTMLDivElement;
let root: Root;
// The panel sits inside BotSettingsDialog's <aside role="dialog">, as it does in the app.
const render = (linkedSection: BotSettingsSection | null) =>
  flushSync(() => root.render(createElement("aside", { role: "dialog" }, createElement(BotPanel, { bot, derived, linkedSection, onClose }))));
// Passive effects and the renders they schedule.
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const tab = () => host.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("data-panel-tab") ?? null;
const page = () => host.querySelector("[data-panel-page-view]")?.getAttribute("data-panel-page-view") ?? null;
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
};
const press = (element: Element | null, key: string) => {
  if (!element) throw new Error("nothing to press");
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  flushSync(() => element.dispatchEvent(event));
  return event;
};
const menu = () => document.querySelector("[data-sidebar-popover-menu]");
const moreButton = () => host.querySelector('[data-testid="chat-more"]')?.closest("button") ?? null;
// What BotSettingsDialog's window listener would do with the key: close the whole panel.
const dialogCloses = vi.fn();
const onWindowKey = (event: KeyboardEvent) => {
  if (event.key === "Escape" && !event.defaultPrevented) dialogCloses();
};

beforeEach(() => {
  fixture.dispatch.mockReset();
  onClose.mockReset();
  dialogCloses.mockReset();
  window.addEventListener("keydown", onWindowKey);
  // Menus close at once instead of animating out.
  document.documentElement.dataset.reducedMotion = "true";
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  window.removeEventListener("keydown", onWindowKey);
  flushSync(() => root.unmount());
  host.remove();
  // A link without a page lands where its section does, so no test sees another's page.
  openBotSettings(vi.fn(), "overview");
});

describe("named links into the bot panel", () => {
  it("opens on the page a link names, and moves there when a link arrives while it is open", async () => {
    openBotSettings(fixture.dispatch, "access", { page: "apps" });
    render("access");
    await settle();
    expect(page()).toBe("apps");

    flushSync(() => openBotSettings(fixture.dispatch, "access", { page: "mcp" }));
    await settle();
    expect(page()).toBe("mcp");

    flushSync(() => openBotSettings(fixture.dispatch, "access"));
    await settle();
    expect([tab(), page()]).toEqual(["computer", null]);
  });

  it("follows the same link again after the panel has moved on", async () => {
    openBotSettings(fixture.dispatch, "usage");
    render("usage");
    await settle();
    expect(tab()).toBe("settings");

    click(host.querySelector('[data-panel-tab="details"]'));
    expect(tab()).toBe("details");

    flushSync(() => openBotSettings(fixture.dispatch, "usage"));
    render("usage");
    await settle();
    expect(tab()).toBe("settings");
  });
});

describe("Escape in the bot panel", () => {
  const onPage = async () => {
    openBotSettings(fixture.dispatch, "model");
    render("model");
    await settle();
    expect(page()).toBe("model");
  };

  it("goes back from a drill-in page instead of closing the panel, though the panel sits in a dialog", async () => {
    await onPage();
    const back = host.querySelector<HTMLElement>("[data-panel-back]");
    back?.focus();
    const event = press(back, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect([tab(), page()]).toEqual(["details", null]);
    expect(dialogCloses).not.toHaveBeenCalled();
    // On a tab, Escape is the dialog's: it closes the panel.
    press(host.querySelector('[data-panel-tab="details"]'), "Escape");
    expect(dialogCloses).toHaveBeenCalledTimes(1);
  });

  it("closes the ⋯ menu first, on a tab and on a page, and only the next Escape reaches the panel", async () => {
    render(null);
    await settle();
    moreButton()?.focus();
    click(moreButton());
    expect(menu()).not.toBeNull();
    press(moreButton(), "Escape");
    expect(menu()).toBeNull();
    expect(dialogCloses).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(moreButton());

    flushSync(() => root.unmount());
    root = createRoot(host);
    await onPage();
    moreButton()?.focus();
    click(moreButton());
    expect(menu()).not.toBeNull();
    press(moreButton(), "Escape");
    expect(menu()).toBeNull();
    expect(page()).toBe("model");
    press(moreButton(), "Escape");
    expect([tab(), page()]).toEqual(["details", null]);
    expect(dialogCloses).not.toHaveBeenCalled();
  });
});

describe("focus around the hero", () => {
  const avatar = () => host.querySelector<HTMLElement>("[data-panel-avatar]");
  const card = () => host.querySelector("[data-panel-avatar-editor]");

  it("moves focus into the avatar editor, and back to the avatar however it closes", async () => {
    render(null);
    await settle();
    avatar()!.focus();
    click(avatar());
    await settle();
    expect(card()).not.toBeNull();
    expect(document.activeElement?.getAttribute("data-avatar-tab")).toBe("bot");

    const event = press(document.activeElement, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(avatar());
    expect(dialogCloses).not.toHaveBeenCalled();

    click(avatar());
    await settle();
    click(host.querySelector("[data-panel-scrim]"));
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(avatar());
    // Focus is back where Escape is heard: the next one is the dialog's.
    press(document.activeElement, "Escape");
    expect(dialogCloses).toHaveBeenCalledTimes(1);
  });

  it.each([["data-panel-rename", "Enter"], ["data-panel-rename", "Escape"], ["data-panel-label", "Enter"], ["data-panel-label", "Escape"]])(
    "gives focus back to the %s button after %s, so the next Escape still works",
    async (attr, key) => {
      render(null);
      await settle();
      click(host.querySelector(`[${attr}]`));
      const input = host.querySelector<HTMLInputElement>(`[${attr}-input]`);
      expect(document.activeElement).toBe(input);
      press(input, key);
      await settle();
      expect(host.querySelector(`[${attr}-input]`)).toBeNull();
      expect(document.activeElement).toBe(host.querySelector(`[${attr}]`));
      expect(dialogCloses).not.toHaveBeenCalled();
      press(document.activeElement, "Escape");
      expect(dialogCloses).toHaveBeenCalledTimes(1);
    },
  );
});
