// People's views of a bot's browser on real Chrome: the page fills the panel at the screen's real scale, frames wait
// for acknowledgements, the bot's clicks land where they aim while people watch, no window outgrows its screen, and a
// phone's v1 session matches the golden recorded on agent-browser.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hostTimeout } from "../../testing/host-timeout.ts";
import { FixtureServer } from "../cdp/testing/fixtures.ts";
import { CHROME } from "../cdp/testing/real-chrome.ts";
import { fitPage, pageLimit, type ScreenSpec } from "../chrome/flags.ts";
import type { BrowserTarget } from "../service.ts";
import { jpegSize, startService, until, type RealService } from "../testing/real-service.ts";
import type { Viewer, ViewerOptions, ViewerOutput } from "./core.ts";
import { LiveV1 } from "./live-v1.ts";
import { v1Differences } from "./testing/v1-compare.ts";
import { normalizeV1, runV1Session, startV1Pages } from "./testing/v1-session.ts";

const suite = CHROME ? describe : describe.skip;

/** A page that keeps painting, so a screencast keeps sending frames. */
const ANIMATED = `<!doctype html><title>animated</title><style>@keyframes spin{to{transform:rotate(360deg)}}#s{width:60px;height:60px;background:#36c;animation:spin 1s linear infinite}</style><div id="s"></div><div style="height:4000px"></div>`;

/** Buttons A and B swap places on a page narrower than 1000 CSS pixels, or once /state says so; a click notes the width. */
const SWAP = `<!doctype html><title>swap</title><style>
body{margin:0} button{position:absolute;left:100px;width:300px;height:120px;font-size:30px}
#a{top:100px} #b{top:300px}
@media (max-width: 1000px) { #a{top:300px} #b{top:100px} }
body.swapped #a{top:300px} body.swapped #b{top:100px}
</style>
<button id="a" onclick="document.body.dataset.clicked='a:'+innerWidth">A</button>
<button id="b" onclick="document.body.dataset.clicked='b:'+innerWidth">B</button>
<script>setInterval(async () => { if (await (await fetch("/state", { cache: "no-store" })).text() === "swap") document.body.classList.add("swapped"); }, 10);</script>`;

const SCREEN: ScreenSpec = { width: 2560, height: 1600, deviceScaleFactor: 2 };

interface Seen { width: number; height: number; still: boolean; at: number }

suite("viewers of the new browser on real Chrome", () => {
  let fx: FixtureServer;
  let real: RealService;
  let page: string;
  let swap: string;
  let state = "still";
  let sessions = 0;

  beforeAll(async () => {
    fx = await FixtureServer.start();
    page = fx.page("/animated", ANIMATED);
    swap = fx.page("/swap", SWAP);
    fx.route("/state", () => ({ body: state, type: "text/plain" }));
    real = await startService({ screen: SCREEN });
  }, hostTimeout(240_000));

  afterAll(async () => {
    await real?.close();
    await fx?.close();
  });

  async function opened(url = page): Promise<BrowserTarget> {
    const target = { session: `viewers-${++sessions}`, key: `bot:viewers-${sessions}` };
    const result = await real.call(target, "agent_browser_open", { url });
    expect(result.isError).toBeUndefined();
    return target;
  }

  async function watch(target: BrowserTarget, options: Partial<ViewerOptions>, { ack = true } = {}): Promise<{ viewer: Viewer; frames: Seen[]; outputs: ViewerOutput[] }> {
    const frames: Seen[] = [];
    const outputs: ViewerOutput[] = [];
    const viewer = await real.service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 3200, maxHeight: 2000, ...options }, (output) => {
      if (output.type !== "frame") {
        outputs.push(output);
        return;
      }
      frames.push({ ...jpegSize(output.data), still: output.still, at: Date.now() });
      if (ack) output.ack();
    });
    return { viewer, frames, outputs };
  }

  const pageSize = (target: BrowserTarget) => real.peek<[number, number, number]>(target, "[innerWidth, innerHeight, devicePixelRatio]");
  const same = (expected: unknown[]) => (actual: unknown[]) => JSON.stringify(actual) === JSON.stringify(expected);

  it("fills the panel: the page takes the viewer's size, frames come at the screen's scale, and 1280x800 returns when it leaves", async () => {
    const target = await opened();
    expect(await pageSize(target)).toEqual([1280, 800, 2]);
    const { viewer, frames } = await watch(target, { size: { width: 1600, height: 1000 } });
    await until(() => pageSize(target), same([1600, 1000, 2]));
    await until(() => frames.at(-1), (frame) => frame?.width === 3200 && frame.height === 2000);
    await viewer.input({ type: "resize", width: 1200, height: 900 });
    await until(() => pageSize(target), same([1200, 900, 2]));
    await until(() => frames.at(-1), (frame) => frame?.width === 2400 && frame.height === 1800);
    await viewer.close();
    await until(() => pageSize(target), same([1280, 800, 2]));
  }, hostTimeout(90_000));

  it("follows the viewer that asked last, and a preset narrower than any window is emulated", async () => {
    const target = await opened();
    const first = await watch(target, { size: { width: 1000, height: 700 } });
    const second = await watch(target, { size: { width: 1400, height: 900 } });
    await until(() => pageSize(target), same([1400, 900, 2]));
    await first.viewer.input({ type: "resize", width: 900, height: 600 });
    await until(() => pageSize(target), same([900, 600, 2]));
    await second.viewer.input({ type: "takeControl" });
    await second.viewer.input({ type: "viewport", setting: { mode: "preset", preset: "phone" } });
    await until(() => pageSize(target), same([390, 844, 2]));
    await second.viewer.input({ type: "viewport", setting: { mode: "fill" } });
    await until(() => pageSize(target), same([900, 600, 2]));
    await second.viewer.input({ type: "releaseControl" });
    await first.viewer.close();
    await second.viewer.close();
  }, hostTimeout(90_000));

  it("lays a tab that opens later out at a panel narrower than any window too, and leaves it so when the bot comes back", async () => {
    const target = await opened();
    const { viewer } = await watch(target, { size: { width: 400, height: 700 } });
    await until(() => pageSize(target), same([400, 700, 2]));
    const windowWidth = await real.peek<number>(target, "outerWidth");
    expect((await real.call(target, "agent_browser_tabs", { action: "new", url: page })).isError).toBeUndefined();
    await until(() => pageSize(target), same([400, 700, 2]));
    expect((await real.call(target, "agent_browser_tabs", { action: "switch", tab: "t1" })).isError).toBeUndefined();
    expect(await pageSize(target)).toEqual([400, 700, 2]);
    expect(await real.peek<number>(target, "outerWidth")).toBe(windowWidth);
    await viewer.close();
  }, hostTimeout(90_000));

  it("sends no more frames until the viewer acknowledges the ones it has", async () => {
    const target = await opened();
    const unacked = await watch(target, { size: { width: 1280, height: 800 } }, { ack: false });
    await until(() => unacked.frames.length, (count) => count > 0);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const stalled = unacked.frames.filter((frame) => !frame.still).length;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(unacked.frames.filter((frame) => !frame.still)).toHaveLength(stalled);
    expect(stalled).toBeLessThanOrEqual(3);
    await unacked.viewer.close();
    const acked = await watch(target, { size: { width: 1280, height: 800 } });
    await until(() => acked.frames.filter((frame) => !frame.still).length, (count) => count > stalled + 3, 20_000);
    await acked.viewer.close();
  }, hostTimeout(90_000));

  it("clicks an element where it is once the pointer people watch got there, after the page moved it", async () => {
    state = "still";
    const target = await opened(swap);
    const ref = /button "A" \[ref=(e\d+)\]/u.exec(real.text(await real.call(target, "agent_browser_snapshot")))![1]!;
    const viewer = await real.service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 1280, maxHeight: 1280 }, (output) => {
      if (output.type === "frame") output.ack();
      else if (output.type === "pointer" && output.phase === "move") state = "swap";
    });
    expect(real.text(await real.call(target, "agent_browser_click", { ref }))).toContain(`Clicked ${ref}.`);
    expect(await until(() => real.peek<string | undefined>(target, "document.body.dataset.clicked"), (value) => value !== undefined)).toMatch(/^a:/u);
    await viewer.close();
    state = "still";
  }, hostTimeout(90_000));

  it("resizes the page for a watching panel only once the bot's click is done, so the click lands where it aimed", async () => {
    state = "still";
    const target = await opened(swap);
    const ref = /button "A" \[ref=(e\d+)\]/u.exec(real.text(await real.call(target, "agent_browser_snapshot")))![1]!;
    let resized: Promise<void> | null = null;
    const viewer: Viewer = await real.service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 2560, maxHeight: 1600, size: { width: 1280, height: 800 } }, (output) => {
      if (output.type === "frame") output.ack();
      else if (output.type === "pointer" && output.phase === "move") resized ??= viewer.input({ type: "resize", width: 900, height: 800 });
    });
    await until(() => pageSize(target), same([1280, 800, 2]));
    expect(real.text(await real.call(target, "agent_browser_click", { ref }))).toContain(`Clicked ${ref}.`);
    expect(resized).not.toBeNull();
    await resized;
    expect(await until(() => real.peek<string | undefined>(target, "document.body.dataset.clicked"), (value) => value !== undefined)).toBe("a:1280");
    await until(() => pageSize(target), same([900, 800, 2]));
    await viewer.close();
  }, hostTimeout(90_000));

  it("ends a scroll on a sharp frame at full size", async () => {
    const target = await opened();
    const { viewer, frames } = await watch(target, { size: { width: 1280, height: 800 }, maxWidth: 2560, maxHeight: 1600 });
    await until(() => frames.at(-1), (frame) => frame?.width === 2560);
    await viewer.input({ type: "takeControl" });
    for (let step = 0; step < 12; step++) {
      await viewer.input({ type: "wheel", x: 400, y: 400, deltaX: 0, deltaY: 120 });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const settled = Date.now() + 400;
    await until(() => frames.at(-1), (frame) => frame !== undefined && frame.at > settled && frame.width === 2560 && frame.height === 1600);
    for (const frame of frames) expect([1280, 2560]).toContain(frame.width);
    expect(await real.peek<number>(target, "scrollY")).toBeGreaterThan(0);
    await viewer.input({ type: "releaseControl" });
    await viewer.close();
  }, hostTimeout(90_000));
});

suite("a bot's browser on a laptop's screen", () => {
  it("never makes its window larger than the screen it reports, and fills a panel too large for it in the panel's shape", async () => {
    const screen: ScreenSpec = { width: 1512, height: 982, deviceScaleFactor: 2 };
    const fits = (size: { width: number; height: number }) => fitPage(size, pageLimit(screen));
    const fx = await FixtureServer.start();
    const real = await startService({ screen });
    try {
      const target = { session: "screen-1", key: "bot:screen-1" };
      expect((await real.call(target, "agent_browser_open", { url: fx.page("/plain", "<!doctype html><title>plain</title><p>plain</p>") })).isError).toBeUndefined();
      type Geometry = { inner: [number, number]; outer: [number, number]; avail: [number, number] };
      const geometry = () => real.peek<Geometry>(target, "({ inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], avail: [screen.availWidth, screen.availHeight] })");
      const viewports: Array<{ width: number; height: number }> = [];
      // A tab with a taller bar than the limit allows for gets a shorter page, never a larger window.
      const showsWithin = async (size: { width: number; height: number }, told = true) => {
        const seen = await until(geometry, (value) => value.inner[0] === size.width && value.inner[1] <= size.height);
        expect(seen.outer[0]).toBeLessThanOrEqual(seen.avail[0]);
        expect(seen.outer[1]).toBeLessThanOrEqual(seen.avail[1]);
        if (told) await until(() => viewports.at(-1), (last) => last?.width === seen.inner[0] && last.height === seen.inner[1]);
      };
      await showsWithin(fits({ width: 1280, height: 800 }), false);
      const viewer = await real.service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 3200, maxHeight: 2000, size: { width: 1600, height: 1000 } }, (output) => {
        if (output.type === "frame") output.ack();
        else if (output.type === "viewport") viewports.push({ width: output.width, height: output.height });
      });
      await showsWithin(fits({ width: 1600, height: 1000 }));
      await viewer.input({ type: "resize", width: 3000, height: 1800 });
      await showsWithin(fits({ width: 3000, height: 1800 }));
      await viewer.input({ type: "takeControl" });
      await viewer.input({ type: "viewport", setting: { mode: "preset", preset: "tablet" } });
      await showsWithin({ width: 820, height: pageLimit(screen).height });
      await viewer.input({ type: "releaseControl" });
      await viewer.close();
    } finally {
      await real.close();
      await fx.close();
    }
  }, hostTimeout(180_000));
});

suite("a phone's v1 live view on real Chrome", () => {
  it("sends the events and fields the agent-browser engine sent, step for step", async () => {
    const pages = await startV1Pages();
    const real = await startService({ screen: { width: 1512, height: 982, deviceScaleFactor: 2 } });
    const target = { session: "bot-golden", key: "bot:golden" };
    const live = new LiveV1({ service: real.service, target: () => target });
    try {
      const records = await runV1Session({
        open: (res) => live.open({ botId: "bot", session: target.session, owner: "local-owner", isCurrent: () => true, res }),
        action: (viewerId, body) => live.action({ viewerId, botId: "bot", owner: "local-owner", body }),
      }, pages.origin);
      expect(v1Differences(normalizeV1(records, pages.origin))).toEqual([]);
    } finally {
      live.closeAll();
      await real.close();
      await pages.close();
    }
  }, hostTimeout(180_000));
});
