// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { MAUS_COLOR_NAMES } from "@/lib/mascot";
import en from "@/locales/en.json";

type Seen = { color: string; state: string; animated: boolean; trackPointer?: boolean; size: number };
vi.mock("@/components/Avatar", () => ({
  MausAvatar: ({ color, state, animated, trackPointer, size: _size, ...choreography }: Seen) => createElement("i", {
    "data-maus": color, "data-state": state, "data-animated": String(animated), "data-pointer": String(trackPointer),
    "data-extra": Object.keys(choreography).join(",") }),
}));
const { CloudMascotScene } = await import("./CloudMascotScene");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const render = async (props: { variant: "hero" | "beat"; paused?: boolean }) => { await act(async () => { root.render(createElement(CloudMascotScene, props)); }); };
const scene = () => host.querySelector<HTMLElement>("[data-cloud-scene]")!;
const mascots = () => [...host.querySelectorAll<HTMLElement>("[data-maus]")];
const animated = () => mascots().map(node => node.dataset.animated);
const twinkling = () => host.querySelectorAll(".cloud-scene-twinkle").length;
const drifting = () => host.querySelectorAll(".cloud-scene-z").length;

beforeEach(() => { setLocale("en"); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete document.documentElement.dataset.reducedMotion;
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it("three of the app's own mascots in three colours, each in its own calm state, one picture named for its message", async () => {
  for (const variant of ["hero", "beat"] as const) {
    await render({ variant });
    const colors = mascots().map(node => node.dataset.maus!);
    expect(colors, variant).toHaveLength(3);
    expect(new Set(colors).size, variant).toBe(3);
    for (const color of colors) expect(MAUS_COLOR_NAMES).toContain(color);
    expect(mascots().map(node => node.dataset.state), variant).toEqual(["working", "idle", "thinking"]);
    expect(mascots().map(node => node.dataset.extra), "no faces, gazes or motions laid on top").toEqual(["", "", ""]);
    expect(mascots().map(node => node.dataset.pointer)).toEqual(["false", "false", "false"]);
    expect(scene().dataset.cloudScene).toBe(variant);
    expect(scene().getAttribute("role")).toBe("img");
    expect(scene().getAttribute("aria-label")).toBe(en["cloudScene.label"]);
  }
  expect(en["cloudScene.label"]).toMatch(/^Three bots keep working .* while this computer sleeps$/);
});

it("live, the only motion is the mascots' own, a few twinkling stars and three drifting z's: no timer or frame of its own", async () => {
  vi.useFakeTimers();
  await render({ variant: "hero" });
  expect(scene().hasAttribute("data-paused")).toBe(false);
  expect(animated()).toEqual(["true", "true", "true"]);
  expect(twinkling()).toBe(6);
  expect(drifting()).toBe(3);
  expect(vi.getTimerCount(), "no setTimeout, setInterval or requestAnimationFrame").toBe(0);
  const markup = host.innerHTML;
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(host.innerHTML, "nothing changes on a clock").toBe(markup);
});

it("its CSS moves two things, slowly, and holds them while paused", () => {
  const css = readFileSync("src/styles.css", "utf8");
  expect([...css.matchAll(/@keyframes (cloud-scene-[\w-]+)/g)].map(match => match[1])).toEqual(["cloud-scene-twinkle", "cloud-scene-z"]);
  for (const [, seconds] of css.matchAll(/animation: cloud-scene-[\w-]+ ([\d.]+)s/g)) expect(Number(seconds)).toBeGreaterThanOrEqual(4);
  expect(css).toContain(".cloud-scene[data-paused] * { animation-play-state: paused; }");
});

it("reduced motion is the same picture held still: no CSS animation and no mascot moving", async () => {
  document.documentElement.dataset.reducedMotion = "true";
  await render({ variant: "hero" });
  expect(animated()).toEqual(["false", "false", "false"]);
  expect(twinkling()).toBe(0);
  expect(drifting()).toBe(0);
  expect(host.querySelectorAll("[style*='animation']")).toHaveLength(0);
  expect(host.querySelectorAll("path[d^='M-2.4-2.4']"), "the z's still rise from the laptop").toHaveLength(3);
});

it("the system setting or the dev hook, switched while the scene is shown, stills it at once and lets it go again", async () => {
  let reduce = false;
  const changes = new Set<() => void>();
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: reduce && query.includes("reduce"), media: query,
    addEventListener: (_: string, changed: () => void) => changes.add(changed), removeEventListener: (_: string, changed: () => void) => changes.delete(changed) }) as unknown as MediaQueryList);
  const still = () => twinkling() + drifting() === 0 && animated().every(flag => flag === "false");
  const moving = () => twinkling() + drifting() > 0 && animated().every(flag => flag === "true");
  await render({ variant: "beat" });
  expect(moving()).toBe(true);
  reduce = true;
  await act(async () => { changes.forEach(changed => changed()); });
  expect(still(), "system setting on").toBe(true);
  reduce = false;
  await act(async () => { changes.forEach(changed => changed()); });
  expect(moving(), "system setting off").toBe(true);
  await act(async () => { document.documentElement.dataset.reducedMotion = "true"; await Promise.resolve(); });
  expect(still(), "dev hook on").toBe(true);
  await act(async () => { delete document.documentElement.dataset.reducedMotion; await Promise.resolve(); });
  expect(moving(), "dev hook off").toBe(true);
});

it("paused or out of view it holds: the mascots stop and the CSS animations pause until it is back", async () => {
  let visible: (seen: boolean) => void = () => {};
  vi.stubGlobal("IntersectionObserver", class {
    constructor(report: IntersectionObserverCallback) {
      visible = seen => report([{ isIntersecting: seen } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    observe() {}
    disconnect() {}
  });
  await render({ variant: "beat", paused: true });
  expect(scene().hasAttribute("data-paused")).toBe(true);
  expect(animated()).toEqual(["false", "false", "false"]);
  await render({ variant: "beat" });
  expect(scene().hasAttribute("data-paused")).toBe(false);
  expect(animated()).toEqual(["true", "true", "true"]);
  await act(async () => visible(false));
  expect(scene().hasAttribute("data-paused")).toBe(true);
  expect(animated()).toEqual(["false", "false", "false"]);
  await act(async () => visible(true));
  expect(scene().hasAttribute("data-paused")).toBe(false);
  expect(animated()).toEqual(["true", "true", "true"]);
});
