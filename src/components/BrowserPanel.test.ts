// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";
import { BROWSER_HELD_ELSEWHERE } from "../../shared/browser-held";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  state: { config: { browserProfiles: [], browserEngine: { kind: "engine", engine: "chrome" } }, computerControl: {} } as Record<string, any>,
}));
vi.mock("@/state/store", async (importOriginal) => ({ ...await importOriginal<typeof import("@/state/store")>(), api: fixture.api, useStore: () => ({ state: fixture.state }) }));
vi.mock("./BrowserProfilesManager", () => ({ BrowserProfilesManager: () => null }));
const { LiveBrowser } = await import("./BrowserPanel");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = "";
  readonly sent: Array<Record<string, unknown>> = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.instances.push(this);
  }
  send(value: string) {
    const message = JSON.parse(value) as Record<string, unknown>;
    if (message.type !== "ack") this.sent.push(message);
  }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  message(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: typeof data === "string" || data instanceof ArrayBuffer ? data : JSON.stringify(data) })); }
  control(controller: string, more: Record<string, unknown> = {}) { this.message({ type: "control", canOperate: true, controller, generation: 1, dialog: null, ...more }); }
  refuse() { this.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "" })); }
}

class FixtureEventSource {
  static instances: FixtureEventSource[] = [];
  listeners = new Map<string, Array<(event: Event) => void>>();
  close = vi.fn();
  constructor(readonly url: string) { FixtureEventSource.instances.push(this); }
  addEventListener(name: string, listener: (event: Event) => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); }
  emit(name: string, data: unknown) { for (const listener of this.listeners.get(name) ?? []) listener(new MessageEvent(name, { data: JSON.stringify(data) })); }
}

let observers: Array<() => void> = [];
class FakeResizeObserver {
  constructor(readonly callback: () => void) { observers.push(callback); }
  observe() { queueMicrotask(this.callback); }
  disconnect() { observers = observers.filter((callback) => callback !== this.callback); }
}

const bot = { id: "pepper", name: "Pepper" } as Bot;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  observers = [];
  FakeSocket.instances = [];
  FixtureEventSource.instances = [];
  fixture.api.mockReset().mockResolvedValue({ ok: true });
  fixture.state = { config: { browserProfiles: [], browserEngine: { kind: "engine", engine: "chrome" } }, computerControl: {} };
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("createImageBitmap", async () => ({ width: 3200, height: 2000, close() {} }));
  vi.stubGlobal("devicePixelRatio", 2);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {} } as never);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, x: 0, y: 0, right: 1600, bottom: 1000, width: 1600, height: 1000, toJSON() {} } as DOMRect);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const flush = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
async function render(props: Partial<Parameters<typeof LiveBrowser>[0]> = {}) {
  await act(async () => root.render(createElement(LiveBrowser, { bot, ...props })));
  await flush();
}
async function streaming(controller = "agent") {
  await render();
  const socket = FakeSocket.instances.at(-1)!;
  await act(async () => {
    socket.open();
    socket.message({ type: "viewport", width: 1600, height: 1000, zoom: 1, setting: { mode: "fill" } });
    socket.message({ type: "tabs", tabs: [{ tabId: "t1", title: "Example", url: "https://example.com/", active: true }] });
    socket.control(controller);
    socket.message(new ArrayBuffer(8));
  });
  await flush();
  return socket;
}
const pill = () => host.querySelector<HTMLButtonElement>("[data-pill]")!;
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === label)!;

describe("the browser panel's connection", () => {
  it("streams the new engine's browser over the v2 socket, sized to the panel", async () => {
    await render();
    expect(FakeSocket.instances).toHaveLength(1);
    const url = new URL(FakeSocket.instances[0]!.url);
    expect(url.pathname).toBe("/api/bots/pepper/browser/stream");
    expect(Object.fromEntries(url.searchParams)).toEqual({ maxWidth: "3200", maxHeight: "2000", width: "1600", height: "1000" });
    expect(FixtureEventSource.instances).toHaveLength(0);
    expect(host.querySelector("[data-browser-transport]")!.getAttribute("data-browser-transport")).toBe("stream");
  });

  it("uses the v1 live view on agent-browser, and when the stream is refused before it opens", async () => {
    fixture.state.config.browserEngine = { kind: "engine", engine: "agent-browser" };
    await render();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(FixtureEventSource.instances[0]!.url).toBe("/api/bots/pepper/browser/live");
    act(() => root.unmount());
    root = createRoot(host);
    fixture.state.config.browserEngine = { kind: "engine", engine: "chrome" };
    await render();
    await act(async () => FakeSocket.instances.at(-1)!.refuse());
    await flush();
    expect(FixtureEventSource.instances).toHaveLength(2);
    expect(host.querySelector("[data-browser-transport]")!.getAttribute("data-browser-transport")).toBe("live");
  });

  it("says the browser is starting until its first frame arrives", async () => {
    await render();
    const socket = FakeSocket.instances.at(-1)!;
    await act(async () => {
      socket.open();
      socket.message({ type: "starting" });
      socket.control("unclaimed");
    });
    await flush();
    expect(host.textContent).toContain("Starting the browser…");
    await act(async () => socket.message(new ArrayBuffer(8)));
    await flush();
    expect(host.textContent).not.toContain("Starting the browser…");
  });

  it("shows the tab's address and enables history from what the stream says", async () => {
    const socket = await streaming();
    expect((host.querySelector<HTMLInputElement>('input[aria-label="Browser address"]')!).value).toBe("https://example.com/");
    expect(button("Back").disabled).toBe(true);
    await act(async () => socket.message({ type: "nav", tabId: "t1", url: "https://example.com/two", loading: true, canGoBack: true, canGoForward: false }));
    expect((host.querySelector<HTMLInputElement>('input[aria-label="Browser address"]')!).value).toBe("https://example.com/two");
    expect(button("Back").disabled).toBe(false);
    expect(button("Forward").disabled).toBe(true);
  });
});

describe("a v1 live view whose stream dropped", () => {
  const live = () => FixtureEventSource.instances.at(-1)!;
  const emit = (name: string, data: unknown) => act(async () => live().emit(name, data));

  it("asks for the hold its last view had when the person reconnects", async () => {
    fixture.state.config.browserEngine = { kind: "engine", engine: "agent-browser" };
    await render();
    await emit("ready", { viewerId: "old-viewer" });
    await emit("error", { message: "Browser connection ended." });
    expect(host.textContent).toContain("Browser disconnected");
    await act(async () => button("Reconnect").click());
    await flush();
    expect(live().url).toBe("/api/bots/pepper/browser/live?resume=old-viewer");
    await emit("ready", { viewerId: "new-viewer" });
    expect(host.textContent).not.toContain("Browser disconnected");
  });

  it("comes back when the window is focused after its retries ran out", async () => {
    fixture.state.config.browserEngine = { kind: "engine", engine: "agent-browser" };
    await render();
    vi.useFakeTimers();
    await emit("ready", { viewerId: "old-viewer" });
    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      await emit("error", { retryable: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
    }
    await emit("error", { retryable: true });
    expect(FixtureEventSource.instances).toHaveLength(6);
    expect(host.textContent).toContain("Browser disconnected");
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(FixtureEventSource.instances).toHaveLength(7);
    expect(live().url).toBe("/api/bots/pepper/browser/live?resume=old-viewer");
    await emit("ready", { viewerId: "back-viewer" });
    expect(host.textContent).not.toContain("Browser disconnected");
  });
});

describe("who holds the browser", () => {
  it("says the bot has it, takes it on Take control, and hands it back", async () => {
    const socket = await streaming("agent");
    expect(pill().textContent).toContain("Pepper has control");
    await act(async () => pill().click());
    await flush();
    expect(socket.sent).toContainEqual({ type: "takeControl" });
    expect(pill().dataset.pill).toBe("taking");
    await act(async () => socket.control("you"));
    await flush();
    expect(pill().textContent).toContain("You have control");
    await act(async () => pill().click());
    await flush();
    expect(socket.sent.at(-1)).toEqual({ type: "releaseControl" });
  });

  it("takes the browser on the first click and then sends that click, once", async () => {
    const socket = await streaming("unclaimed");
    const canvas = host.querySelector("canvas")!;
    await act(async () => {
      canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: 400, clientY: 250, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", bubbles: true }));
      canvas.dispatchEvent(new PointerEvent("pointerup", { clientX: 400, clientY: 250, button: 0, buttons: 0, pointerId: 1, pointerType: "mouse", bubbles: true }));
    });
    await flush();
    expect(socket.sent).toEqual([{ type: "takeControl" }]);
    await act(async () => socket.control("you"));
    await flush();
    const mouse = socket.sent.filter((message) => message.type === "mouse");
    expect(mouse.map((message) => [message.action, message.x, message.y])).toEqual([["down", 400, 250], ["up", 400, 250]]);
  });

  it("keeps the browser for the person holding it when the panel grows past its frame cap, as full screen does", async () => {
    const socket = await streaming("unclaimed");
    await act(async () => pill().click());
    await act(async () => socket.control("you"));
    await flush();
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ left: 0, top: 0, x: 0, y: 0, right: 1800, bottom: 1100, width: 1800, height: 1100, toJSON() {} } as DOMRect);
    await act(async () => { for (const observer of observers) observer(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(FakeSocket.instances).toEqual([socket]);
    expect(socket.sent).toContainEqual({ type: "frameCap", maxWidth: 3600, maxHeight: 2200 });
    expect(pill().dataset.pill).toBe("yours");
  });

  it("says another device holds the browser, and sends nothing from this one", async () => {
    const socket = await streaming("another-viewer");
    expect(host.textContent).toContain(BROWSER_HELD_ELSEWHERE);
    expect(pill().disabled).toBe(true);
    const canvas = host.querySelector("canvas")!;
    await act(async () => { canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: 10, clientY: 10, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", bubbles: true })); });
    expect(socket.sent).toEqual([]);
  });

  it("returns focus from the page to the address bar on Shift+Escape", async () => {
    await streaming("you");
    const page = host.querySelector("textarea")!;
    page.focus();
    await act(async () => { page.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", shiftKey: true, bubbles: true })); });
    expect(document.activeElement).toBe(host.querySelector('input[aria-label="Browser address"]'));
  });
});

describe("what the person does in the panel", () => {
  it("navigates from the address bar, taking the browser first", async () => {
    const socket = await streaming("agent");
    const address = host.querySelector<HTMLInputElement>('input[aria-label="Browser address"]')!;
    await act(async () => { address.focus(); });
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(address, "example.org/docs");
      address.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { address.form!.requestSubmit(); });
    await flush();
    expect(socket.sent).toEqual([{ type: "takeControl" }]);
    await act(async () => socket.control("you"));
    await flush();
    expect(socket.sent.at(-1)).toEqual({ type: "navigate", url: "https://example.org/docs" });
  });

  it("types into the page from the typing dialog only while it holds the browser", async () => {
    vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
    const socket = await streaming("you");
    await act(async () => button("Type or paste text…").click());
    const field = host.querySelector<HTMLInputElement>('input[name="pageText"]')!;
    field.value = "hello there";
    await act(async () => { field.form!.requestSubmit(); });
    await flush();
    expect(socket.sent).toContainEqual({ type: "text", text: "hello there" });
    expect(field.value).toBe("");
  });

  it("sizes and zooms the page from the menu while it holds the browser", async () => {
    const socket = await streaming("you");
    await act(async () => button("Phone · 390×844").click());
    expect(socket.sent).toContainEqual({ type: "viewport", setting: { mode: "preset", preset: "phone" } });
    await act(async () => button("Zoom in").click());
    expect(socket.sent).toContainEqual({ type: "zoom", factor: 1.1 });
    await act(async () => socket.message({ type: "viewport", width: 1455, height: 909, zoom: 1.1, setting: { mode: "fill" } }));
    expect(host.textContent).toContain("110%");
  });

  it("takes the browser for a sign-in and opens its page on a blank tab", async () => {
    await render({ signIn: { url: "https://accounts.example.com/login", site: "example.com", nonce: 1 } });
    const socket = FakeSocket.instances.at(-1)!;
    await act(async () => {
      socket.open();
      socket.message({ type: "tabs", tabs: [{ tabId: "t1", title: "", url: "about:blank", active: true }] });
      socket.control("unclaimed");
    });
    await flush();
    expect(socket.sent).toEqual([{ type: "takeControl" }]);
    await act(async () => socket.control("you"));
    await flush();
    expect(socket.sent.at(-1)).toEqual({ type: "navigate", url: "https://accounts.example.com/login" });
  });
});
