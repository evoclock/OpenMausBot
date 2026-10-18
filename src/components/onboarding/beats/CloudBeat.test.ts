// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudAccountState } from "../../../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../../../electron/cloud-home.mjs";
import { setLocale } from "@/lib/i18n";

const f = vi.hoisted(() => ({ state: {} as any, dispatch: vi.fn(), api: vi.fn(), branded: false }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: (...args: unknown[]) => f.api(...args) }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/brand", async original => ({ ...await original<typeof import("@/lib/brand")>(), brandStatus: () => ({ source: f.branded ? "file" : "default" }) }));
vi.mock("@/components/Avatar", () => ({ MausAvatar: () => null }));
const { CloudBeat, useCloudBeatOffer } = await import("./CloudBeat");
const { track } = await import("@/lib/analytics");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const allowances = { cpus: 2, memoryMb: 2048, diskGb: 20, maxDiskGb: 20, computers: 1, computerHours: 50, voiceCharacters: 1 };
const OFFER: CloudOffer = { recommended: "pro", creditUsd: 5, reminderDays: 1, refundDays: 14, plans: [
  { tier: "personal", amount: 2900, trialDays: 3, allowances }, { tier: "pro", amount: 4900, trialDays: 3, allowances }] };
const signedOut: CloudAccountState = { status: "signed-out" };
let host: HTMLDivElement, root: Root | null = null;
const mount = async (element: ReturnType<typeof createElement>) => {
  root = createRoot(host);
  await act(async () => { root!.render(element); });
  await act(async () => { await Promise.resolve(); });
};
const rerender = async (element: ReturnType<typeof createElement>) => { await act(async () => { root!.render(element); }); };
const button = (name: string) => [...host.querySelectorAll("button")].find(node => node.textContent === name)!;
beforeEach(() => {
  setLocale("en"); f.state = { config: { onboarding: { completedAt: "", version: 0, reelSeen: false, hintsSeen: [] } }, cloudAdd: null };
  f.dispatch = vi.fn(); f.api = vi.fn(async () => ({ onboarding: {} })); f.branded = false; vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function Probe({ hosted = false, wait }: { hosted?: boolean; wait?: number }) {
  const offer = useCloudBeatOffer(hosted, undefined, wait);
  return createElement("output", null, offer ? `offer:${offer.plans.length}` : "none");
}
const desktop = (account: CloudAccountState, offer: () => Promise<CloudOffer | null>, extra: Record<string, unknown> = {}) => {
  const bridge = { state: vi.fn(async () => account), onState: vi.fn(() => () => {}), offer: vi.fn(offer) };
  vi.stubGlobal("window", Object.assign(window, { ogb: { remoteClient: { active: false }, cloudAccount: bridge, ...extra } }));
  return bridge;
};

it("the beat's offer: an account that may buy and the Admin's offer; nothing for a plan, no offer, branded, hosted or remote", async () => {
  desktop(signedOut, async () => OFFER);
  await mount(createElement(Probe)); expect(host.textContent).toBe("offer:2");
  await act(async () => root!.unmount()); root = null;
  desktop({ status: "connected", entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } }, async () => OFFER);
  await mount(createElement(Probe)); expect(host.textContent, "a free account may buy too").toBe("offer:2");
  for (const [why, account, offer, setup] of [
    ["a paid plan", { status: "connected", entitlement: { plan: "pro", status: "active", expiresAt: Date.now() + 86_400_000, version: 1 } }, OFFER, () => {}],
    ["no offer", signedOut, null, () => {}],
    ["a branded build", signedOut, OFFER, () => { f.branded = true; }],
  ] as const) {
    await act(async () => root!.unmount()); root = null;
    (setup as () => void)();
    desktop(account as CloudAccountState, async () => offer as CloudOffer | null);
    await mount(createElement(Probe)); expect(host.textContent, why).toBe("none");
    f.branded = false;
  }
  await act(async () => root!.unmount()); root = null;
  desktop(signedOut, async () => OFFER);
  await mount(createElement(Probe, { hosted: true })); expect(host.textContent, "a hosted workspace").toBe("none");
  await act(async () => root!.unmount()); root = null;
  vi.stubGlobal("window", Object.assign(window, { ogb: { cloudAccount: { state: async () => signedOut, onState: () => () => {}, offer: async () => OFFER } } }));
  await mount(createElement(Probe)); expect(host.textContent, "a page that is not this computer's own").toBe("none");
});

it("no beat once main says this desktop has seen the Cloud Pro popup; it waits for main's answer, and none is no beat", async () => {
  const notices = (state: () => Promise<{ seen: string[]; cloud: boolean }>) => ({ desktopNotices: { state: vi.fn(state) } });
  desktop(signedOut, async () => OFFER, notices(async () => ({ seen: ["cloud-pro-update-2026-10"], cloud: true })));
  await mount(createElement(Probe)); expect(host.textContent, "seen").toBe("none");
  await act(async () => root!.unmount()); root = null;
  let answer: (seen: string[]) => void = () => {};
  desktop(signedOut, async () => OFFER, notices(() => new Promise(resolve => { answer = seen => resolve({ seen, cloud: true }); })));
  await mount(createElement(Probe)); expect(host.textContent, "main has not answered").toBe("none");
  await act(async () => { answer([]); await Promise.resolve(); });
  expect(host.textContent, "not seen").toBe("offer:2");
  await act(async () => root!.unmount()); root = null;
  desktop(signedOut, async () => OFFER, notices(async () => { throw new Error("only available in this app's window"); }));
  await mount(createElement(Probe)); expect(host.textContent, "no answer").toBe("none");
});

it("an offer that has not come in time leaves the beat out for this welcome, and a late one changes nothing", async () => {
  vi.useFakeTimers();
  let late: (offer: CloudOffer) => void = () => {};
  desktop(signedOut, () => new Promise(resolve => { late = resolve; }));
  await mount(createElement(Probe, { wait: 6000 }));
  expect(host.textContent).toBe("none");
  await act(async () => { vi.advanceTimersByTime(6000); });
  await act(async () => { late(OFFER); await Promise.resolve(); });
  expect(host.textContent).toBe("none");
});

it("the beat: what Cloud does, the night shift scene, the Admin's offer in one line, Start free trial opens the sheet over the welcome, which goes on once it closes", async () => {
  const onNext = vi.fn(), onSkip = vi.fn(), setMascot = vi.fn();
  const beat = () => createElement(CloudBeat, { offer: OFFER, onNext, onSkip, setMascot, bump: vi.fn() });
  await mount(beat());
  const text = host.textContent!;
  for (const words of ["MausBot Cloud is your own computer in the cloud. Your bots keep going 24/7, even when this computer is off.",
    "Routines run on time, day and night", "Talk to your bots from your phone", "Bring everything over in one click",
    "Free for 3 days, then from $29/month + tax. Includes $5 of Claude credit. 14-day money-back.", "Start free trial", "Not now",
    "You can add a Cloud any time from the switcher."]) expect(text).toContain(words);
  expect(f.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ onboarding: { hintsSeen: ["onboarding-cloud-v1"] } }) });
  expect(button("Start free trial").hasAttribute("data-primary"), "the welcome focuses it").toBe(true);
  const scene = () => host.querySelector("[data-cloud-scene='beat']")!;
  expect(scene().getAttribute("aria-label")).toBe("Three bots keep working on a cloud under the moon while this computer sleeps");
  expect(scene().hasAttribute("data-paused")).toBe(false);
  await act(async () => { button("Start free trial").click(); });
  expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_onboarding" });
  expect(track).toHaveBeenCalledWith("onboarding_cloud", { action: "start_trial", trial: true });
  expect(scene().hasAttribute("data-paused"), "held from the moment the sheet is asked for").toBe(true);
  f.state = { ...f.state, cloudAdd: { source: "app_onboarding" } }; await rerender(beat());
  expect(onNext, "not while the sheet is open").not.toHaveBeenCalled();
  expect(scene().hasAttribute("data-paused"), "held under the open sheet").toBe(true);
  f.state = { ...f.state, cloudAdd: null }; await rerender(beat());
  expect(onNext).toHaveBeenCalledOnce();
  expect(scene().hasAttribute("data-paused"), "moving again once the sheet is gone").toBe(false);
  await act(async () => { button("Not now").click(); });
  expect(onSkip).toHaveBeenCalledOnce(); expect(track).toHaveBeenCalledWith("onboarding_cloud", { action: "not_now" });
});

it("without a trial the beat says the lowest price and See plans; a beat already recorded is not written again", async () => {
  f.state = { ...f.state, config: { onboarding: { completedAt: "", version: 0, reelSeen: false, hintsSeen: ["onboarding-cloud-v1"] } } };
  await mount(createElement(CloudBeat, { offer: { ...OFFER, creditUsd: undefined, plans: OFFER.plans.map(({ trialDays: _days, ...plan }) => plan) },
    onNext: vi.fn(), onSkip: vi.fn(), setMascot: vi.fn(), bump: vi.fn() }));
  expect(host.textContent).toContain("From $29/month + tax. 14-day money-back.");
  expect(button("See plans")).toBeTruthy();
  expect(f.api).not.toHaveBeenCalled();
});
