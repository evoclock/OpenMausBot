import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudOffer, CloudTrial } from "../../electron/cloud-home.mjs";
import { withTourFinished } from "@/lib/guided-tour";
import { setLocale } from "@/lib/i18n";
import { EMPTY_ONBOARDING, LOCAL_VIEWER, type WelcomeViewer } from "@/lib/onboarding";
import { setPendingIntent } from "@/lib/cloud-intent";
import { registerDesktopPrefs } from "../../electron/desktop-prefs.mjs";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], state: {} as any, updater: null as any, dispatch: null as any, brand: "default" }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? initial() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: vi.fn().mockResolvedValue({}),
  CLOUD_LINK_SETTINGS: { type: "toggleAppSettings", open: true, section: "cloudAccount", cloudLink: true } }));
vi.mock("@/lib/analytics", () => ({ emailGateDone: () => false, track: vi.fn(), identifyEmail: vi.fn(), analyticsChoiceKnown: () => true }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => f.updater }));
vi.mock("@/lib/brand", () => ({ brandStatus: () => ({ brand: { name: "OpenMausBot" }, source: f.brand, file: "" }) }));
vi.mock("@/components/EngineLibrary", () => ({ engineReady: (instance: { snapshot: { state: string; authenticated?: boolean } }) =>
  instance.snapshot.state === "available" && instance.snapshot.authenticated !== false }));
import { AppNotices } from "./AppNotices";
import { CLOUD_NOTICE_DISMISSED } from "./CloudNotice";
import { CLOUD_PRO_HANDOFF_WAIT_MS, finishCloudProHandoff, takeCloudProHandoff } from "./CloudProPopup";
import { CLOUD_PRO_UPDATE_NOTICE, PRODUCT_HUNT_NOTICE, PRODUCT_HUNT_UNTIL, PRODUCT_HUNT_URL, CLOUD_INTRO, localDay, STAR_NOTICE } from "@/lib/notices";
import { identifyEmail, track } from "@/lib/analytics";
import { api } from "@/state/store";

const DAY = 86_400_000, NOW = new Date(2026, 9, 9, 12).getTime();
const plans = [
  { tier: "personal", label: "Personal", amount: 2900, trialDays: 7 },
  { tier: "pro", label: "Pro", amount: 4900, trialDays: 7 },
  { tier: "max", label: "Max", amount: 9900, trialDays: 7 },
];
const TRIAL_OFFER: CloudOffer = { plans, recommended: "pro", creditUsd: 5, refundDays: 14 };
const PLAIN_OFFER: CloudOffer = { plans: plans.map(({ trialDays: _days, ...plan }) => plan), recommended: "pro", refundDays: 14 };
const INTRO = "Keep your bots working when this computer is off";
const STAR = "Enjoying OpenMausBot?";
const signedOut: CloudAccountState = { status: "signed-out" };
const free: CloudAccountState = { status: "connected", account: { id: "a", email: "person@example.test" }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } };
const paid = (extra: Partial<CloudAccountState> = {}): CloudAccountState => ({ ...free, entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...extra });
const ready = { status: "ready" as const, origin: "https://omb-u-1.fly.dev" };
const trial = (state: CloudTrial["state"], extra: Partial<CloudTrial> = {}): CloudTrial =>
  ({ state, tier: "pro", endsAt: NOW + DAY, amount: 4900, chargeAt: NOW + DAY, holdUntil: null, deleteAt: null, keep: "none", ...extra });

let storage: Map<string, string>;
let account: CloudAccountState;
let snapshot: CloudPlanSnapshot | Error;
let offer: CloudOffer | null;
let viewer: WelcomeViewer | null;
let bridges: { cloud: Record<string, ReturnType<typeof vi.fn>>; plan: Record<string, ReturnType<typeof vi.fn>> };
let accountListeners: Set<(next: CloudAccountState) => void>;
let now: number;
// As App mounts it: quiet on a page that has just finished the popup's click another page handed over.
let quiet: boolean;

const PRELOAD = readFileSync(join(process.cwd(), "electron", "preload.cjs"), "utf8").replace(/\r\n/g, "\n");
const LOCAL_ORIGIN = "http://127.0.0.1:8799", MY_CLOUD = "https://omb-u-1.fly.dev", VPS = "https://bots.example.test";
type Page = "local" | "cloud" | "server";
type Handler = (event: { page: Page; returnValue?: unknown }, ...args: unknown[]) => unknown;
interface Desktop {
  handlers: Map<string, Handler>; listeners: Map<string, Handler>; saved: { seen?: string[] } | null; offered: boolean; moves: boolean; switches: number;
  /** Where main loaded This computer's page after a switch. */
  landing: string | null;
  /** This computer's own workspace config.json, as main reads it. */
  config: unknown;
}
let desk: Desktop;

// Main's own record for this one desktop, behind its real IPC.
function desktopMachine(): Desktop {
  const machine: Desktop = { handlers: new Map(), listeners: new Map(), saved: null, offered: true, moves: true, switches: 0, landing: null,
    config: { onboarding: { completedAt: "2026-09-01", version: 1, hintsSeen: [] } } };
  registerDesktopPrefs({
    ipcMain: { handle: (channel, handler) => void machine.handlers.set(channel, handler as Handler), on: (channel, listener) => void machine.listeners.set(channel, listener as Handler) },
    read: () => machine.saved, write: value => { machine.saved = JSON.parse(JSON.stringify(value)); }, page: event => (event as { page: Page }).page,
    cloudOffered: async () => machine.offered, localConfig: () => machine.config, now: () => now,
    thisComputer: async landing => { if (machine.moves) { machine.switches += 1; machine.landing = landing; } return machine.moves; },
  });
  return machine;
}

// The real preload, as this desktop's window loads it for a page; the Cloud account and plan answer from this file's fakes.
function windowOn(origin: string, { click = true } = {}) {
  const page: Page = origin === LOCAL_ORIGIN ? "local" : origin === MY_CLOUD ? "cloud" : "server";
  let ogb: Record<string, unknown> = {};
  vm.runInNewContext(PRELOAD, {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL_ORIGIN}`, "--omb-company-desktop=1"] },
    location: { origin }, navigator: { userActivation: { isActive: click } }, TextEncoder,
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name: string, value: Record<string, unknown>) => { ogb = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {},
        sendSync: (channel: string) => { const event = { page, returnValue: undefined as unknown }; desk.listeners.get(channel)?.(event); return event.returnValue; },
        invoke: async (channel: string, ...args: unknown[]) => desk.handlers.get(channel)?.({ page }, ...args) } }),
  });
  const fakes: Record<string, unknown> = { cloudAccount: bridges.cloud, cloudPlan: bridges.plan, openExternal: vi.fn(async () => true), organization: undefined };
  return { ...ogb, ...Object.fromEntries(Object.entries(fakes).filter(([key]) => key in ogb)) };
}
const showWindow = (origin: string, options?: { click?: boolean }) => {
  quiet = false;
  vi.stubGlobal("window", { ogb: windowOn(origin, options), addEventListener: vi.fn(), removeEventListener: vi.fn() });
};

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const render = () => { f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(AppNotices, { viewer, quiet, now: () => now })); };
async function settle(rounds = 4) { for (let i = 0; i < rounds; i++) { render(); f.effects.forEach(effect => effect()); await flush(); } return render(); }
const launch = () => { f.values = []; return settle(); };
type Node = ReactElement<Record<string, any>>;
const nodes = (value: ReactNode): Node[] => {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
};
const tree = () => { f.index = 0; f.effects = []; return nodes(AppNotices({ viewer, quiet, now: () => now })); };
const press = (label: string) => {
  const button = tree().find(node => node.type === "button" && (renderToStaticMarkup(node).includes(`>${label}<`) || node.props["aria-label"] === label));
  expect(button, label).toBeTruthy(); button!.props.onClick();
};
const returning = () => { f.state.bots = [{ tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }]; };
const launchCardsSeen = () => { desk.saved = { seen: [CLOUD_PRO_UPDATE_NOTICE] }; storage.set(PRODUCT_HUNT_NOTICE, "1"); };
const hints = () => f.state.config.onboarding.hintsSeen as string[];

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  storage = new Map(); f.values = []; f.index = 0; f.effects = []; f.updater = null; f.brand = "default"; f.dispatch = vi.fn(); now = NOW; desk = desktopMachine();
  setLocale("en"); viewer = LOCAL_VIEWER; account = signedOut; snapshot = { status: "none" }; offer = TRIAL_OFFER;
  f.state = { connected: true, bots: [], groups: [], routines: [], instances: [{ instanceId: "claude", snapshot: { state: "available", authenticated: true } }],
    config: { onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen: withTourFinished(undefined) } } };
  vi.mocked(api).mockImplementation(async (_path, init) => {
    const patch = JSON.parse(String((init as RequestInit).body));
    f.state.config.onboarding.hintsSeen = patch.onboarding.hintsSeen;
    return f.state.config;
  });
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  // The Cloud Pro popup and the Product Hunt card come first; the tests before their own are about the cards after them.
  launchCardsSeen();
  accountListeners = new Set();
  bridges = {
    cloud: { state: vi.fn(async () => account), onState: vi.fn((listener: (next: CloudAccountState) => void) => { accountListeners.add(listener); return () => accountListeners.delete(listener); }),
      offer: vi.fn(async () => offer), begin: vi.fn(async () => account),
      signInAgain: vi.fn(async () => account), connectHome: vi.fn(async () => account), openDashboard: vi.fn(async () => account) },
    plan: { state: vi.fn(async () => { if (snapshot instanceof Error) throw snapshot; return snapshot; }), manage: vi.fn(async () => {}), useThisComputer: vi.fn(), noticeSeen: vi.fn(async () => {}) },
  };
  showWindow(LOCAL_ORIGIN);
  vi.stubGlobal("document", { activeElement: null, body: null, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setLocale("en"); });

describe("the card after the update", () => {
  it("offers the free trial to someone signed out who has used the app before, in the Admin's numbers, with Start free trial and Show me how", async () => {
    returning();
    const html = await launch();
    const words = [INTRO, "Free for 7 days", "MausBot Cloud is your own always-on computer in the cloud.", "Routines run on time, day and night",
      "Reach your bots from your phone, even with this computer off", "$5 of Claude credit to start", "Then from $29/month + tax. Cancel any time.",
      "14-day money-back on every plan.", "Start free trial", "Show me how", "Sign in to your Cloud plan", "Not now"];
    for (const text of words) expect(html).toContain(text);
    for (let i = 1; i < words.length; i++) expect(html.indexOf(words[i - 1]!), words[i]).toBeLessThan(html.indexOf(words[i]!));
    for (const gone of ["launch price", "first 100", "$89", "New features first", "Get Pro", STAR]) expect(html).not.toContain(gone);
    expect(html).not.toContain('aria-modal="true"');
    expect(bridges.cloud.offer).toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith("cloud_card_shown", { variant: "signed_out" });
    expect(JSON.parse(storage.get(`${CLOUD_INTRO}:days`)!)).toEqual([localDay(NOW)]);
    expect(hints()).toContain(`${CLOUD_INTRO}:day-1`);
    expect(await settle()).toContain(INTRO);
    expect(await launch()).toBe("");
    now = NOW + 3 * 3600_000; expect(await launch()).toBe("");
    now = NOW + DAY; account = free;
    const again = await launch();
    expect(again).toContain(INTRO); expect(again).not.toContain("Sign in to your Cloud plan");
    expect(track).toHaveBeenCalledWith("cloud_card_shown", { variant: "free" });
  });

  it("needs a trial: without one it waits (the star may show), and without money-back from the Admin it says none", async () => {
    returning(); offer = { ...PLAIN_OFFER };
    let html = await launch();
    expect(html).not.toContain(INTRO); expect(html).toContain(STAR);
    expect(storage.get(`${CLOUD_INTRO}:days`)).toBeUndefined();
    offer = null; expect(await launch()).not.toContain(INTRO);
    offer = { ...TRIAL_OFFER, refundDays: undefined, creditUsd: undefined };
    html = await launch();
    expect(html).toContain(INTRO); expect(html).toContain("Cloud computers and voice included");
    expect(html).not.toContain("money-back"); expect(html).not.toContain("Claude credit");
  });

  it("never to someone new this launch, who pays or may pay, on a branded build, or a desktop signed in with an organization", async () => {
    expect(await launch()).toBe("");
    returning();
    for (const state of [paid(), paid({ trial: trial("active") }), { ...free, purchase: { state: "confirming" as const } },
      { status: "reauth-required" as const, lastPlan: { active: true } }, { status: "unavailable" as const }, { status: "connecting" as const }]) {
      account = state; expect(await launch(), JSON.stringify(state)).not.toContain(INTRO);
    }
    account = signedOut; f.brand = "file";
    expect(await launch()).toBe("");
    f.brand = "default";
    (window.ogb as Record<string, unknown>).organization = { state: async () => ({ status: "connected", organization: { id: "o", name: "Acme" } }), onState: () => () => {} };
    const org = await launch();
    expect(org).not.toContain(INTRO); expect(org).toContain(STAR);
  });

  it("Start free trial opens the Add a Cloud dialog from the card, and the card is done for good", async () => {
    returning(); await launch();
    press("Start free trial"); await flush();
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_card" });
    expect(track).toHaveBeenCalledWith("cloud_card_action", { action: "start" });
    expect(storage.get(CLOUD_INTRO)).toBe("1"); expect(hints()).toContain(CLOUD_INTRO);
    expect(render()).toBe("");
    now = NOW + 5 * DAY; storage.clear(); launchCardsSeen(); expect(await launch()).not.toContain(INTRO);
  });

  it("Show me how starts the one-step tip; Not now, the X and Escape end it for good, then say where Add a Cloud lives", async () => {
    returning(); await launch();
    press("Show me how");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "cloudHowTo", open: true });
    expect(track).toHaveBeenCalledWith("cloud_card_action", { action: "howto" });
    expect(storage.get(CLOUD_INTRO)).toBe("1");
    for (const close of ["Not now", "Dismiss for good", "Escape"]) {
      storage.clear(); launchCardsSeen(); f.state.config.onboarding.hintsSeen = withTourFinished(undefined); now += DAY;
      expect(await launch(), close).toContain(INTRO);
      if (close === "Escape") {
        const card = tree().find(node => node.type === "aside")!;
        const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
        card.props.onKeyDown(event); expect(event.preventDefault).toHaveBeenCalled();
      } else press(close);
      expect(storage.get(CLOUD_INTRO), close).toBe("1"); expect(hints()).toContain(CLOUD_INTRO);
      expect(render()).toContain("You can add a Cloud any time from the menu at the top of the sidebar.");
    }
    expect(track).toHaveBeenCalledWith("cloud_card_action", { action: "not_now" });
    expect(track).toHaveBeenCalledWith("cloud_card_action", { action: "close" });
  });

  it("Sign in to your Cloud plan opens the sheet at its own sign-in and only hides the card for now", async () => {
    returning(); await launch();
    press("Sign in to your Cloud plan");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_card", signIn: true });
    expect(storage.get(CLOUD_INTRO)).toBeUndefined(); expect(render()).toBe("");
    now = NOW + DAY; expect(await launch()).toContain(INTRO);
  });

  it("shows on at most three days, or one for someone who closed the earlier Pro card", async () => {
    returning();
    for (let day = 0; day < 3; day++) { now = NOW + day * DAY; expect(await launch(), `day ${day}`).toContain(INTRO); }
    now = NOW + 3 * DAY;
    const after = await launch();
    expect(after).not.toContain(INTRO); expect(after).toContain(STAR);
    storage.clear(); launchCardsSeen(); f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "pro-introduction-dismissed-v3"];
    now = NOW + 10 * DAY; expect(await launch()).toContain(INTRO);
    now = NOW + 11 * DAY; expect(await launch()).not.toContain(INTRO);
  });

  it("never after the welcome's Cloud step, which was this desktop's Cloud offer however it was answered", async () => {
    returning(); f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "onboarding-cloud-v1"];
    for (const state of [signedOut, free]) {
      account = state;
      for (let day = 0; day < 3; day++) {
        now = NOW + day * DAY;
        const html = await launch();
        expect(html, `${state.status} day ${day}`).not.toContain(INTRO); expect(html, `${state.status} day ${day}`).toContain(STAR);
      }
    }
    expect(storage.get(`${CLOUD_INTRO}:days`)).toBeUndefined();
    expect(track).not.toHaveBeenCalledWith("cloud_card_shown", expect.anything());
    expect(bridges.cloud.offer, "nothing to load the offer for").not.toHaveBeenCalled();
  });

  it("never over setup, a dialog, the Add a Cloud dialog or its tip, busy work, or an update being offered", async () => {
    returning();
    const waits: Array<() => void> = [
      () => { f.state.welcomeOpen = true; }, () => { f.state.tourOpen = true; }, () => { f.state.appSettingsOpen = true; },
      () => { f.state.cloudAdd = { source: "app_menu" }; }, () => { f.state.cloudHowTo = true; }, () => { f.updater = { status: "downloaded" }; },
      () => { f.state.bots = [{ busy: true, tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }]; }, () => { f.state.connected = false; },
    ];
    for (const wait of waits) {
      const saved = structuredClone(f.state); wait();
      expect(await launch(), wait.toString()).toBe("");
      f.state = saved; f.updater = null;
    }
    expect(storage.get(`${CLOUD_INTRO}:days`)).toBeUndefined();
    expect(await launch()).toContain(INTRO);
  });
});

describe("the free trial's notice, here and on My Cloud", () => {
  it("shows the notice main says is due, tells main once, and stays up until it is closed", async () => {
    account = paid({ trial: trial("active") }); snapshot = { status: "paid", tier: "pro", trial: trial("active"), notice: "active", credit: { grantedUsd: 5, remainingUsd: 3.2, state: "active" } };
    offer = { ...PLAIN_OFFER };
    const html = await launch();
    expect(html).toContain("Your free trial ends on"); expect(html).toContain("Includes $5 of Claude credit: $3.20 left.");
    expect(html).toContain("Prefer Personal at $29?");
    expect(bridges.plan.noticeSeen).toHaveBeenCalledOnce();
    snapshot = { ...snapshot, notice: undefined };
    expect(await settle()).toContain("Your free trial ends on");
    expect(bridges.plan.noticeSeen).toHaveBeenCalledOnce();
    press("Manage subscription"); await flush();
    expect(bridges.plan.manage).toHaveBeenCalledOnce();
    expect(render()).toBe("");
    expect(await launch()).not.toContain("Your free trial");
  });

  it("on My Cloud's own page, only the trial's notice, after its sign-in and setup checklist", async () => {
    viewer = { hosted: false, canSave: true, cloudHome: true };
    showWindow(MY_CLOUD);
    returning();
    snapshot = { status: "none", trial: trial("ended", { deleteAt: NOW + 3 * DAY, keep: "checkout" }), notice: "ended" };
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"];
    expect(await launch()).toContain("Your free trial has ended");
    f.state.instances = [{ instanceId: "claude", snapshot: { state: "available", authenticated: false } }];
    expect(await launch()).toBe("");
    f.state.instances = [{ instanceId: "claude", snapshot: { state: "available", authenticated: true } }];
    snapshot = { status: "none" };
    expect(await launch()).toBe("");
    expect(bridges.cloud.offer).not.toHaveBeenCalled();
    snapshot = new Error("only available in this app's window");
    expect(await launch()).toBe("");
  });
});

describe("This computer's My Cloud card and the star", () => {
  it("someone with a ready My Cloud is told once where the always-on bots are; Not now is kept", async () => {
    account = paid({ machine: ready }); returning();
    const html = await launch();
    expect(html).toContain("Your always-on bots are on My Cloud"); expect(html).not.toContain(STAR);
    press("Open My Cloud"); await flush();
    expect(bridges.cloud.connectHome).toHaveBeenCalledOnce();
    press("Not now");
    expect(storage.get(CLOUD_NOTICE_DISMISSED)).toBe("1"); expect(hints()).toContain(CLOUD_NOTICE_DISMISSED);
    expect(await launch()).toContain(STAR);
  });

  it("an ended sign-in on a paid plan asks to sign in again; the star comes last and is for good", async () => {
    account = { status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } }; returning();
    expect(await launch()).toContain("Sign in again to reach My Cloud");
    press("Sign in again"); await flush();
    expect(bridges.cloud.signInAgain).toHaveBeenCalledOnce();
    account = { ...free }; offer = { ...PLAIN_OFFER };
    expect(await launch()).toContain(STAR);
    press("Not now");
    expect(storage.get(STAR_NOTICE)).toBe("1"); expect(await launch()).toBe("");
  });
});

describe("the Product Hunt launch card", () => {
  const PH = "live on Product Hunt";
  const fresh = () => { storage.delete(PRODUCT_HUNT_NOTICE); };

  it("comes first, for everyone (new or not, any plan), and the upvote opens the launch and ends it for good", async () => {
    fresh(); account = paid({ machine: ready });
    const html = await launch();
    expect(html).toContain(PH); expect(html).toContain("Upvote on Product Hunt");
    expect(html).not.toContain(STAR); expect(html).not.toContain("Your always-on bots are on My Cloud");
    press("Upvote on Product Hunt"); await flush();
    expect(window.ogb?.openExternal).toHaveBeenCalledWith(PRODUCT_HUNT_URL);
    expect(vi.mocked(track)).toHaveBeenCalledWith("product_hunt_card", { action: "upvote" });
    expect(storage.get(PRODUCT_HUNT_NOTICE)).toBe("1"); expect(hints()).toContain(PRODUCT_HUNT_NOTICE);
    expect(await launch()).toContain("Your always-on bots are on My Cloud");
  });

  it("Not now, the X and Escape end it for good too", async () => {
    fresh();
    expect(await launch()).toContain(PH);
    press("Not now");
    expect(vi.mocked(track)).toHaveBeenCalledWith("product_hunt_card", { action: "not_now" });
    expect(storage.get(PRODUCT_HUNT_NOTICE)).toBe("1");
    expect(await launch()).not.toContain(PH);
  });

  it("never on a branded build or an organization's desktop, never after the launch window, never over setup or an update", async () => {
    fresh(); f.brand = "file";
    expect(await launch()).not.toContain(PH);
    f.brand = "default"; now = PRODUCT_HUNT_UNTIL;
    expect(await launch()).not.toContain(PH);
    now = NOW; f.updater = { status: "available", version: "9.9.9" };
    expect(await launch()).not.toContain(PH);
  });
});

describe("the Cloud Pro popup after the update", () => {
  const POPUP = "MausBot Cloud Pro";
  const ID = CLOUD_PRO_UPDATE_NOTICE;
  const REFUSED = "switch to this computer just now. Try again, or choose This computer from the menu at the top of the sidebar.";
  let modal: boolean;
  const popupEvents = (action: string) => vi.mocked(track).mock.calls.filter(([event, props]) => event === "cloud_pro_popup" && (props as { action?: string }).action === action);
  const event = (action: string, plan: string, signedIn: boolean, page: string, via?: string) =>
    ["cloud_pro_popup", { action, plan, signed_in: signedIn, page, ...(via ? { via } : {}) }];
  const lastOrder = (calls: { mock: { invocationCallOrder: number[] } }) => calls.mock.invocationCallOrder.at(-1)!;
  const seenOnDesktop = () => desk.saved?.seen ?? [];
  const SETTINGS = { type: "toggleAppSettings", open: true, section: "cloudAccount" };
  const ADD_CLOUD = { type: "openCloudAdd", source: "update_popup" };
  const fresh = () => { desk = desktopMachine(); storage.delete(ID); f.state.config.onboarding.hintsSeen = withTourFinished(undefined); f.state.routines = []; };
  const TITLE = { id: "cloud-pro-popup-title" }, DIALOG = { contains: (node: unknown) => node === TITLE };
  const keydown = (key: string, shiftKey = false) => {
    const handler = vi.mocked(window.addEventListener).mock.calls.filter(([type]) => type === "keydown").at(-1)![1] as (event: unknown) => void;
    const event = { key, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    handler(event);
    return event;
  };
  const tierPlan = (tier: string, extra: Partial<CloudAccountState> = {}) =>
    paid({ entitlement: { plan: "pro", tier, status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...extra });
  const onMyCloud = (plan: CloudPlanSnapshot) => {
    snapshot = plan; viewer = { hosted: false, canSave: true, cloudHome: true }; f.state.config.cloudHome = true;
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"]; showWindow(MY_CLOUD);
  };
  const onSavedServer = (options?: { click?: boolean }) => { viewer = { hosted: true, canSave: true }; showWindow(VPS, options); };
  const onThisComputer = () => { viewer = LOCAL_VIEWER; delete f.state.config.cloudHome; f.state.config.onboarding.hintsSeen = withTourFinished(undefined); showWindow(LOCAL_ORIGIN); };
  // This computer's page, loaded where main switched the window to: App finishes the click from its address.
  const land = async () => {
    onThisComputer();
    const handoff = takeCloudProHandoff(new URL(desk.landing ?? "/", `${LOCAL_ORIGIN}/`));
    if (handoff) { quiet = true; finishCloudProHandoff(handoff, window.ogb!.cloudAccount!, f.dispatch); }
    await flush();
  };
  const signal = (next: CloudAccountState) => { account = next; for (const listener of accountListeners) listener(next); };
  const primaryButton = (label: string) => tree().find(node => node.type === "button" && renderToStaticMarkup(node).includes(`>${label}<`))!;

  beforeEach(() => {
    fresh(); modal = false;
    vi.stubGlobal("document", { activeElement: TITLE, body: null, getElementById: () => null,
      querySelector: (selector: string) => selector === "[data-cloud-pro-popup]" ? DIALOG : null,
      querySelectorAll: () => modal ? [{ closest: () => null, checkVisibility: () => true }] : [] });
  });

  it("every install gets it once, before every other card, as a modal dialog with the Admin's offer; Start free trial opens Add a Cloud from it", async () => {
    returning(); storage.delete(PRODUCT_HUNT_NOTICE);
    const html = await launch();
    const words = [POPUP, "Free for 7 days", "MausBot Cloud is your own always-on computer in the cloud.", "Routines run on time, day and night",
      "Reach your bots from your phone, even with this computer off", "$5 of Claude credit to start", "Then from $29/month + tax. Cancel any time.",
      "14-day money-back on every plan.", "Start free trial", "Compare plans", "OpenMausBot on this computer stays free and open source.", "Not now"];
    for (const text of words) expect(html).toContain(text);
    for (let i = 1; i < words.length; i++) expect(html.indexOf(words[i - 1]!), words[i]).toBeLessThan(html.indexOf(words[i]!));
    for (const part of ['role="dialog"', 'aria-modal="true"', 'aria-labelledby="cloud-pro-popup-title"', 'aria-describedby="cloud-pro-popup-body"']) expect(html).toContain(part);
    for (const other of ["live on Product Hunt", INTRO, STAR]) expect(html).not.toContain(other);
    expect(popupEvents("shown")).toEqual([event("shown", "none", false, "local")]);
    expect(await settle()).toContain(POPUP);
    expect(popupEvents("shown")).toHaveLength(1);
    expect(seenOnDesktop()).toEqual([]);

    press("Start free trial");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "update_popup" });
    expect(popupEvents("upgrade")).toEqual([event("upgrade", "none", false, "local")]);
    expect(identifyEmail).not.toHaveBeenCalled();
    await flush(); expect(seenOnDesktop()).toEqual([ID]);
    expect(render()).toBe("");
    const next = await launch();
    expect(next).not.toContain(POPUP); expect(next).toContain("live on Product Hunt");
  });

  it("a new install gets it once onboarding is done, never in the middle of it", async () => {
    f.state.config.onboarding = { ...EMPTY_ONBOARDING };
    expect(await launch()).toBe("");
    f.state.config.onboarding = { ...EMPTY_ONBOARDING, completedAt: "2026-10-16", version: 1, hintsSeen: [] };
    expect(await launch()).toBe("");
    f.state.config.onboarding.hintsSeen = withTourFinished(undefined); f.state.welcomeOpen = true;
    expect(await launch()).toBe("");
    f.state.welcomeOpen = false;
    const html = await launch();
    expect(html).toContain(POPUP); expect(html).not.toContain(INTRO);
    expect(popupEvents("shown")).toHaveLength(1);
  });

  it("is counted as shown once a day on this desktop, not on every reload, until it is closed", async () => {
    expect(await launch()).toContain(POPUP);
    for (let i = 0; i < 3; i++) expect(await launch()).toContain(POPUP);
    expect(popupEvents("shown")).toHaveLength(1);
    now = NOW + DAY;
    expect(await launch()).toContain(POPUP);
    expect(popupEvents("shown")).toHaveLength(2);
    press("Not now"); await flush();
    now = NOW + 2 * DAY;
    expect(await launch()).not.toContain(POPUP);
    expect(popupEvents("shown")).toHaveLength(2);
  });

  it("someone signed in with no plan: each click is tied to their Cloud account's email before it is counted, and only once across reloads", async () => {
    account = free; offer = { ...PLAIN_OFFER };
    const html = await launch();
    expect(html).toContain("Upgrade to Cloud Pro"); expect(html).toContain("MausBot Cloud plans from $29/month + tax.");
    for (const gone of ["Free for", "Start free trial", "Claude credit"]) expect(html).not.toContain(gone);
    expect(popupEvents("shown")).toEqual([event("shown", "none", true, "local")]);
    expect(identifyEmail).not.toHaveBeenCalled();

    press("Compare plans"); await flush();
    // Compare plans stays in the app: the Add a Cloud dialog lists every plan.
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "update_popup" });
    expect(window.ogb?.openExternal).not.toHaveBeenCalled();
    expect(identifyEmail).toHaveBeenCalledWith("person@example.test", { submitted: false });
    expect(popupEvents("see_plans")).toEqual([event("see_plans", "none", true, "local")]);
    expect(lastOrder(vi.mocked(identifyEmail))).toBeLessThan(lastOrder(vi.mocked(track)));
    expect(render()).toBe("");
    storage.clear(); storage.set(PRODUCT_HUNT_NOTICE, "1");
    expect(await launch(), "the desktop keeps it, not the page's storage").not.toContain(POPUP);

    vi.clearAllMocks(); fresh(); await launch();
    press("Upgrade to Cloud Pro");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "update_popup" });
    expect(identifyEmail).toHaveBeenCalledWith("person@example.test", { submitted: false });
    expect(popupEvents("upgrade")).toEqual([event("upgrade", "none", true, "local")]);
    expect(lastOrder(vi.mocked(identifyEmail))).toBeLessThan(lastOrder(vi.mocked(track)));
  });

  it("a trial or any plan gets Manage plan in Settings → MausBot Cloud, in the app; no Compare plans, never a checkout or the browser", async () => {
    const cases = [
      { state: paid({ trial: trial("active") }), plan: "trial", line: "Pro free trial · verified by MausBot Cloud" },
      { state: paid(), plan: "pro", line: "Pro active · verified by MausBot Cloud" },
      { state: tierPlan("max"), plan: "max", line: "Max active · verified by MausBot Cloud" },
      { state: tierPlan("personal"), plan: "personal", line: "Personal active · verified by MausBot Cloud" },
    ];
    for (const { state, plan, line } of cases) {
      vi.clearAllMocks(); fresh(); account = state; showWindow(LOCAL_ORIGIN);
      const html = await launch();
      expect(html, plan).toContain(POPUP); expect(html, plan).toContain("Manage plan"); expect(html, plan).toContain(line);
      for (const gone of ["Start free trial", "Free for", "/month", "Compare plans", "Upgrade to Cloud Pro"]) expect(html, plan).not.toContain(gone);
      expect(popupEvents("shown"), plan).toEqual([event("shown", plan, true, "local")]);
      press("Manage plan"); await flush();
      expect(f.dispatch, plan).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "cloudAccount" });
      expect(bridges.cloud.openDashboard, plan).not.toHaveBeenCalled(); expect(window.ogb?.openExternal, plan).not.toHaveBeenCalled();
      expect(bridges.plan.manage, plan).not.toHaveBeenCalled();
      expect(f.dispatch, plan).not.toHaveBeenCalledWith(expect.objectContaining({ type: "openCloudAdd" }));
      expect(identifyEmail, plan).toHaveBeenCalledWith("person@example.test", { submitted: false });
      expect(popupEvents("manage"), plan).toEqual([event("manage", plan, true, "local")]);
      expect(seenOnDesktop(), plan).toEqual([ID]); expect(render(), plan).toBe("");
      expect(bridges.cloud.offer, plan).not.toHaveBeenCalled();
    }
  });

  it("a desktop signed in with an organization gets it too", async () => {
    account = paid();
    (window.ogb as Record<string, unknown>).organization = { state: async () => ({ status: "connected", organization: { id: "o", name: "Acme" } }), onState: () => () => {} };
    const html = await launch();
    expect(html).toContain(POPUP); expect(html).toContain("Manage plan");
    expect(popupEvents("shown")).toEqual([event("shown", "pro", true, "local")]);
  });

  it("a desktop whose window opens on My Cloud gets it there once; Manage plan switches to This computer, whose page opens Settings → MausBot Cloud, tied to the email there", async () => {
    account = paid();
    onMyCloud({ status: "paid", tier: "pro" });
    const html = await launch();
    expect(html).toContain(POPUP); expect(html).toContain("Manage plan"); expect(html).toContain("Pro active · verified by MausBot Cloud");
    for (const gone of ["Compare plans", "Upgrade to Cloud Pro", "Start free trial", "/month", "Continue on this computer"]) expect(html).not.toContain(gone);
    expect(popupEvents("shown")).toEqual([event("shown", "pro", true, "my_cloud")]);
    expect(bridges.cloud.state).not.toHaveBeenCalled();
    press("Manage plan"); await flush();
    expect(desk.switches).toBe(1);
    expect(desk.landing).toBe("?desktop-settings=cloud-settings&source=update_popup&via=my_cloud");
    expect(seenOnDesktop(), "seen once the window has switched").toEqual([ID]);
    expect(popupEvents("continue"), "the click, on the page it was made").toEqual([event("continue", "pro", true, "my_cloud")]);
    expect(bridges.plan.manage, "never the plan page in the browser").not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled(); expect(identifyEmail, "My Cloud's page is not told the email").not.toHaveBeenCalled();
    expect(popupEvents("manage")).toEqual([]);
    expect(render()).toBe("");

    await land();
    expect(f.dispatch).toHaveBeenCalledWith(SETTINGS); expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(identifyEmail).toHaveBeenCalledWith("person@example.test", { submitted: false });
    expect(popupEvents("manage")).toEqual([event("manage", "pro", true, "local", "my_cloud")]);
    expect(lastOrder(vi.mocked(identifyEmail))).toBeLessThan(lastOrder(vi.mocked(track)));
    expect(await launch(), "no second popup").not.toContain(POPUP);
    expect(f.dispatch, "once").toHaveBeenCalledTimes(1);
    expect(popupEvents("shown"), "counted once, on My Cloud").toHaveLength(1);
    onMyCloud({ status: "paid", tier: "pro" });
    expect(await launch(), "and not again on My Cloud").not.toContain(POPUP);
  });

  it("on My Cloud: a trial, a lapsed plan and an ended sign-in get Manage plan, through This computer; no plan read, or one being checked, never offers one", async () => {
    const cases: Array<[CloudPlanSnapshot, string, boolean, string]> = [
      [{ status: "paid", tier: "pro", trial: trial("active") }, "trial", true, "Pro free trial · verified by MausBot Cloud"],
      [{ status: "paid", tier: "max" }, "max", true, "Max active · verified by MausBot Cloud"],
      [{ status: "attention", tier: "pro" }, "none", true, "Pro · not active right now"],
      [{ status: "signin", tier: "pro" }, "unknown", false, "Sign in again to use My Cloud on this computer. Your plan is not affected."],
    ];
    for (const [plan, name, signedIn, line] of cases) {
      vi.clearAllMocks(); fresh(); onMyCloud(plan);
      const html = await launch();
      expect(html, name).toContain("Manage plan"); expect(html, name).toContain(line); expect(html, name).not.toContain("Compare plans");
      expect(popupEvents("shown"), name).toEqual([event("shown", name, signedIn, "my_cloud")]);
      press("Manage plan"); await flush();
      expect(desk.switches, name).toBe(1); expect(bridges.plan.manage, name).not.toHaveBeenCalled();
      expect(popupEvents("continue"), name).toEqual([event("continue", name, signedIn, "my_cloud")]);
    }
    // The ended sign-in ends where Sign in again is.
    account = { status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } };
    await land();
    expect(f.dispatch).toHaveBeenCalledWith(SETTINGS);
    expect(popupEvents("manage")).toEqual([event("manage", "unknown", false, "local", "my_cloud")]);
    expect(identifyEmail).not.toHaveBeenCalled();

    vi.clearAllMocks(); fresh(); onMyCloud({ status: "checking", tier: "pro" }); returning();
    const checking = await launch();
    expect(checking).not.toContain(POPUP);
    expect(seenOnDesktop()).toEqual([]);
    for (const plan of [{ status: "none" as const }, new Error("only available in this app's window")]) {
      vi.clearAllMocks(); fresh(); onMyCloud(plan as CloudPlanSnapshot); if (plan instanceof Error) snapshot = plan;
      const html = await launch();
      expect(html).toContain("Continue on this computer");
      for (const gone of ["Manage plan", "Compare plans", "Upgrade to Cloud Pro", "/month"]) expect(html).not.toContain(gone);
    }
  });

  it("This computer opens what the click asked for at once, whatever else is on its screen: busy bots and groups, an update", async () => {
    const clicks: Array<[string, () => void, string, unknown, string, string]> = [
      ["Manage plan", () => { account = paid(); onMyCloud({ status: "paid", tier: "pro" }); }, "manage", SETTINGS, "pro", "my_cloud"],
      ["Continue on this computer", () => { account = free; offer = { ...PLAIN_OFFER }; onSavedServer(); }, "upgrade", ADD_CLOUD, "none", "server"],
    ];
    for (const [label, show, action, opens, plan, via] of clicks) {
      vi.clearAllMocks(); fresh(); show();
      await launch(); press(label); await flush();
      f.state.bots = [{ busy: true, tasks: [{ threadId: "t", createdAt: 1, busy: true, usage: { turns: 2 } }] }];
      f.state.groups = [{ id: "g", working: true, busyBotId: "b" }];
      f.updater = { status: "downloaded" };
      await land();
      expect(f.dispatch, label).toHaveBeenCalledWith(opens);
      expect(popupEvents(action), label).toEqual([event(action, plan, true, "local", via)]);
      expect(await launch(), `${label}: the cards there still wait`).toBe("");
      f.state.bots = []; f.state.groups = []; f.updater = null;
    }
  });

  it("waits for main to restore the Cloud sign-in before it reads the plan on My Cloud's page", async () => {
    let answer!: () => void;
    const restored = new Promise<void>(resolve => { answer = resolve; });
    desk.offered = true;
    const state = desk.handlers.get("desktop-notices:state")!;
    desk.handlers.set("desktop-notices:state", async (...args) => { await restored; return state(...args); });
    onMyCloud({ status: "paid", tier: "pro" });
    expect(await launch()).toBe("");
    expect(bridges.plan.state).not.toHaveBeenCalled();
    answer(); await flush();
    expect(await settle()).toContain("Manage plan");
    expect(bridges.plan.state).toHaveBeenCalled();
  });

  it("a saved server's page is told no plan: for someone who can buy, Continue on this computer opens Add a Cloud on This computer at once, with no second popup", async () => {
    account = free; offer = { ...PLAIN_OFFER };
    onSavedServer();
    const html = await launch();
    expect(html).toContain(POPUP); expect(html).toContain("Continue on this computer"); expect(html).toContain("Not now");
    for (const gone of ["Manage plan", "Compare plans", "Upgrade to Cloud Pro", "Start free trial", "/month", "verified by"]) expect(html).not.toContain(gone);
    expect(bridges.plan.state).not.toHaveBeenCalled(); expect(bridges.cloud.state).not.toHaveBeenCalled();
    expect(popupEvents("shown")).toEqual([event("shown", "unknown", false, "server")]);

    press("Continue on this computer"); await flush();
    expect(desk.switches).toBe(1);
    expect(desk.landing).toBe("?desktop-settings=cloud-add&source=update_popup&via=server");
    expect(seenOnDesktop()).toEqual([ID]);
    expect(popupEvents("continue")).toEqual([event("continue", "unknown", false, "server")]);
    expect(f.dispatch).not.toHaveBeenCalled(); expect(identifyEmail).not.toHaveBeenCalled(); expect(popupEvents("upgrade")).toEqual([]);
    expect(render()).toBe("");

    await land();
    expect(f.dispatch).toHaveBeenCalledWith(ADD_CLOUD); expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(identifyEmail).toHaveBeenCalledWith("person@example.test", { submitted: false });
    expect(popupEvents("upgrade")).toEqual([event("upgrade", "none", true, "local", "server")]);
    expect(lastOrder(vi.mocked(identifyEmail))).toBeLessThan(lastOrder(vi.mocked(track)));
    expect(await launch(), "no second popup").toBe("");
    expect(popupEvents("shown"), "shown once, on the server's page").toHaveLength(1);
    expect(bridges.cloud.openDashboard).not.toHaveBeenCalled(); expect(window.ogb?.openExternal).not.toHaveBeenCalled();
    expect(f.dispatch, "finished once").toHaveBeenCalledTimes(1);
  });

  it("someone signed out gets Add a Cloud at once too, from a saved server's page or from My Cloud's reading no plan, and no email is tied", async () => {
    for (const [where, show, via] of [["saved server", () => onSavedServer(), "server"], ["My Cloud", () => onMyCloud({ status: "none" }), "my_cloud"]] as const) {
      vi.clearAllMocks(); fresh(); account = signedOut; offer = TRIAL_OFFER; show();
      expect(await launch(), where).toContain("Continue on this computer");
      press("Continue on this computer"); await flush();
      expect(desk.switches, where).toBe(1);
      expect(desk.landing, where).toBe(`?desktop-settings=cloud-add&source=update_popup&via=${via}`);
      await land();
      expect(await launch(), where).toBe("");
      expect(f.dispatch, where).toHaveBeenCalledWith(ADD_CLOUD);
      expect(popupEvents("upgrade"), where).toEqual([event("upgrade", "none", false, "local", via)]);
      expect(identifyEmail, where).not.toHaveBeenCalled();
      expect(seenOnDesktop(), where).toEqual([ID]);
    }
  });

  it("for a plan, a payment being linked or an ended sign-in, Continue on this computer opens Settings → MausBot Cloud there at once, never a checkout; nothing switches without a click", async () => {
    const cases: Array<[CloudAccountState, string, boolean]> = [
      [tierPlan("personal"), "personal", true], [paid({ trial: trial("active") }), "trial", true], [paid({ checking: true }), "pro", true],
      [{ ...free, purchase: { state: "confirming" } }, "none", true],
      [{ status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } }, "unknown", false],
    ];
    for (const [state, plan, signedIn] of cases) {
      vi.clearAllMocks(); fresh(); account = state; onSavedServer();
      await launch(); press("Continue on this computer"); await flush();
      await land();
      expect(await launch(), plan).toBe("");
      expect(f.dispatch, plan).toHaveBeenCalledWith(SETTINGS); expect(f.dispatch, plan).toHaveBeenCalledTimes(1);
      expect(popupEvents("manage"), plan).toEqual([event("manage", plan, signedIn, "local", "server")]);
      expect(popupEvents("upgrade"), plan).toEqual([]);
      if (signedIn) expect(identifyEmail, plan).toHaveBeenCalledWith("person@example.test", { submitted: false });
      else expect(identifyEmail, plan).not.toHaveBeenCalled();
      expect(bridges.plan.manage, plan).not.toHaveBeenCalled(); expect(bridges.cloud.openDashboard, plan).not.toHaveBeenCalled();
      expect(window.ogb?.openExternal, plan).not.toHaveBeenCalled();
      expect(seenOnDesktop(), plan).toEqual([ID]);
    }

    vi.clearAllMocks(); fresh(); account = free; offer = { ...PLAIN_OFFER };
    onSavedServer({ click: false });
    await launch(); press("Continue on this computer"); await flush();
    expect(desk.switches).toBe(0); expect(seenOnDesktop(), "it comes back").toEqual([]);
    expect(render(), "it stays up and says so").toContain(REFUSED);
    expect(f.dispatch).not.toHaveBeenCalled(); expect(popupEvents("upgrade")).toEqual([]);
    onThisComputer(); expect(await launch()).toContain("Upgrade to Cloud Pro");
  });

  it("This computer's page waits for a sign-in that is restoring or connecting, or a plan it cannot check yet, then opens what the plan calls for, once", async () => {
    const unsettled: Record<string, CloudAccountState> = { restoring: { status: "signed-out", message: "restoring" }, connecting: { status: "connecting" },
      unchecked: { status: "unavailable", lastPlan: { tier: "pro", active: false } } };
    for (const wait of Object.keys(unsettled)) {
      vi.clearAllMocks(); fresh(); account = free; offer = { ...PLAIN_OFFER };
      onSavedServer(); await launch(); press("Continue on this computer"); await flush();
      account = unsettled[wait]!;
      await land();
      expect(f.dispatch, wait).not.toHaveBeenCalled(); expect(popupEvents("upgrade"), wait).toEqual([]);
      signal(free); await flush();
      expect(f.dispatch, wait).toHaveBeenCalledWith(ADD_CLOUD);
      expect(popupEvents("upgrade"), wait).toEqual([event("upgrade", "none", true, "local", "server")]);
      signal(paid()); await flush();
      expect(f.dispatch, `${wait}: decided once`).toHaveBeenCalledTimes(1);
    }
  });

  it("a sign-in or plan still unknown once the wait is over gets Settings → MausBot Cloud, which says where it stands, counted as manage; nothing opens later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    for (const unsettled of [{ status: "connecting" }, { status: "unavailable", lastPlan: { tier: "pro", active: true } }] as CloudAccountState[]) {
      vi.clearAllMocks(); fresh(); account = free; offer = { ...PLAIN_OFFER };
      onSavedServer(); await launch(); press("Continue on this computer"); await flush();
      account = unsettled;
      await land();
      vi.advanceTimersByTime(CLOUD_PRO_HANDOFF_WAIT_MS - 1); await flush();
      expect(f.dispatch, unsettled.status).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1); await flush();
      expect(f.dispatch, unsettled.status).toHaveBeenCalledWith(SETTINGS);
      expect(popupEvents("manage"), unsettled.status).toEqual([event("manage", "unknown", false, "local", "server")]);
      signal(free); vi.advanceTimersByTime(10 * CLOUD_PRO_HANDOFF_WAIT_MS); await flush();
      expect(f.dispatch, `${unsettled.status}: nothing later`).toHaveBeenCalledTimes(1);
      expect(popupEvents("upgrade"), unsettled.status).toEqual([]);
    }
  });

  it("someone who can buy gets the dialog even while the Admin's offer cannot be read: the dialog loads it itself", async () => {
    account = signedOut; offer = null;
    onSavedServer(); await launch(); press("Continue on this computer"); await flush();
    await land();
    expect(f.dispatch).toHaveBeenCalledWith(ADD_CLOUD);
    expect(bridges.cloud.offer).not.toHaveBeenCalled();
  });

  it("a saved server's page cannot hand This computer Manage plan or anything but Continue on this computer: it is refused and nothing moves", async () => {
    account = free; offer = { ...PLAIN_OFFER };
    onSavedServer();
    const remote = () => (window.ogb as unknown as { desktopNotices: { thisComputer(intent?: unknown): Promise<boolean> } }).desktopNotices;
    await expect(remote().thisComputer("manage")).rejects.toThrow(/cannot hand that click/);
    for (const intent of [undefined, "upgrade", { toString: () => "cloud-pro" }]) await expect(remote().thisComputer(intent), String(intent)).rejects.toThrow(/only its own click/);
    expect(desk.switches).toBe(0); expect(seenOnDesktop()).toEqual([]);
    onThisComputer();
    expect(await launch(), "This computer's own popup asks").toContain("Upgrade to Cloud Pro");
    expect(f.dispatch).not.toHaveBeenCalled(); expect(identifyEmail).not.toHaveBeenCalled();
    for (const action of ["upgrade", "manage", "see_plans"]) expect(popupEvents(action), action).toEqual([]);
    onSavedServer();
    expect(await remote().thisComputer("cloud-pro"), "its own click still switches").toBe(true);
    expect(await remote().thisComputer("cloud-pro"), "once: the popup is seen").toBe(false);
    expect(desk.switches).toBe(1);
  });

  it("a switch main refuses keeps the popup up and says so, and leaves it unseen; its button tries again", async () => {
    account = paid();
    for (const [show, label, page] of [[() => onMyCloud({ status: "paid", tier: "pro" }), "Manage plan", "my_cloud"], [() => onSavedServer(), "Continue on this computer", "server"]] as const) {
      vi.clearAllMocks(); fresh(); desk.moves = false; show();
      expect(await launch(), label).toContain(POPUP);
      press(label); press(label);
      expect(primaryButton(label).props.disabled, `${label}: held while main switches`).toBe(true);
      await flush();
      const html = render();
      expect(html, label).toContain(POPUP); expect(html, label).toContain(REFUSED); expect(html, label).toContain('role="alert"');
      expect(primaryButton(label).props.disabled, label).toBe(false);
      expect(seenOnDesktop(), label).toEqual([]); expect(desk.switches, label).toBe(0);
      expect(f.dispatch, label).not.toHaveBeenCalled();
      expect(popupEvents("continue"), `${label}: one click`).toEqual([event("continue", page === "my_cloud" ? "pro" : "unknown", page === "my_cloud", page)]);
      for (const action of ["upgrade", "manage"]) expect(popupEvents(action), label).toEqual([]);
      expect(await launch(), `${label}: and on a later load`).toContain(POPUP);
      desk.moves = true; press(label); await flush();
      expect(desk.switches, `${label}: tried again`).toBe(1);
      expect(render(), label).toBe(""); expect(seenOnDesktop(), label).toEqual([ID]);
    }
  });

  it("on My Cloud it waits for the setup checklist, and shows once that checklist is done, though nobody pressed Hide", async () => {
    account = paid({ trial: trial("active") });
    onMyCloud({ status: "paid", tier: "pro", trial: trial("active") });
    const onboarding = f.state.config.onboarding;
    onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-intent-asked", "cloud-intent-given"]; onboarding.firstTurnAt = "2026-10-10T08:00:00.000Z";
    expect(await launch(), "its first job has no routine yet").toBe("");
    const routine = { id: "r1", botId: "b1", createdAt: NOW - DAY, name: "Morning brief", nextRunAt: NOW + DAY };
    f.state.routines = [routine];
    expect(await launch(), "its first job made a routine").toContain(POPUP);
    expect(popupEvents("shown")).toHaveLength(1);

    vi.clearAllMocks(); fresh(); onMyCloud({ status: "paid", tier: "pro", trial: trial("active") }); f.state.routines = [routine];
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-intent-asked"]; delete f.state.config.onboarding.firstTurnAt;
    expect(await launch(), "nothing worked yet").toBe("");
    setPendingIntent("Send me a morning brief");
    try { expect(await launch(), "a job just given, its routine made").toContain(POPUP); } finally { setPendingIntent(null); }
  });

  it("never shows one account's offer for another while the new one loads", async () => {
    offer = TRIAL_OFFER;
    expect(await launch()).toContain("Start free trial");
    account = free; let answer!: (next: CloudOffer) => void;
    bridges.cloud.offer.mockImplementation(() => new Promise<CloudOffer>(resolve => { answer = resolve; }));
    expect(await settle(), "the signed-out trial is not shown for the signed-in account").not.toContain("Free for 7 days");
    answer({ ...PLAIN_OFFER }); await flush();
    const html = await settle();
    expect(html).toContain("Upgrade to Cloud Pro"); expect(html).not.toContain("Free for 7 days");
  });

  it("Not now, the X, Escape and a click outside end it for good and never say who it was", async () => {
    account = free; offer = { ...PLAIN_OFFER };
    for (const how of ["Not now", "Close", "Escape", "outside"] as const) {
      fresh();
      expect(await launch(), how).toContain(POPUP);
      if (how === "Escape") expect(keydown("Escape").preventDefault, how).toHaveBeenCalled();
      else if (how === "outside") {
        const backdrop = tree().find(node => typeof node.props.onMouseDown === "function")!;
        backdrop.props.onMouseDown({ target: {}, currentTarget: backdrop });
        expect(render(), "a press inside the dialog").toContain(POPUP);
        backdrop.props.onMouseDown({ target: backdrop, currentTarget: backdrop });
      } else press(how);
      await flush(); expect(seenOnDesktop(), how).toEqual([ID]);
      expect(render(), how).toBe("");
      expect(await launch(), how).not.toContain(POPUP);
    }
    expect(popupEvents("not_now")).toEqual([event("not_now", "none", true, "local")]);
    expect(popupEvents("close")).toHaveLength(3);
    expect(identifyEmail).not.toHaveBeenCalled();
  });

  it("an Escape meant for something else leaves it up", async () => {
    expect(await launch()).toContain(POPUP);
    (document as { activeElement: unknown }).activeElement = { id: "spotlight-button" };
    const escape = keydown("Escape");
    expect(escape.preventDefault).not.toHaveBeenCalled(); expect(escape.stopPropagation).not.toHaveBeenCalled();
    expect(render()).toContain(POPUP); expect(popupEvents("close")).toEqual([]);
    await flush(); expect(seenOnDesktop()).toEqual([]);
  });

  it("an earlier close kept by this computer's page or its workspace still counts, and the desktop learns it", async () => {
    for (const keep of [() => storage.set(ID, "1"), () => { f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), ID]; }]) {
      fresh(); keep();
      expect(await launch()).not.toContain(POPUP);
      await flush(); expect(seenOnDesktop()).toEqual([ID]);
      onMyCloud({ status: "paid", tier: "pro" });
      expect(await launch()).not.toContain(POPUP);
      onThisComputer();
    }
    expect(popupEvents("shown")).toEqual([]);
  });

  it("This computer's workspace counts on My Cloud's and a saved server's page before This computer's page has loaded on this build: an earlier close or the welcome's Cloud step", async () => {
    for (const hint of [ID, "onboarding-cloud-v1"]) {
      fresh(); account = paid(); desk.config = { onboarding: { completedAt: "2026-09-01", version: 1, hintsSeen: ["tour-finished", hint] } };
      onMyCloud({ status: "paid", tier: "pro" });
      expect(await launch(), `${hint} on My Cloud`).not.toContain(POPUP);
      onSavedServer();
      expect(await launch(), `${hint} on a saved server`).not.toContain(POPUP);
      const remote = (window.ogb as unknown as { desktopNotices: { thisComputer(intent: string): Promise<boolean> } }).desktopNotices;
      expect(await remote.thisComputer("cloud-pro"), `${hint}: nothing to switch for`).toBe(false);
      expect(desk.switches, hint).toBe(0);
    }
    expect(popupEvents("shown")).toEqual([]);
  });

  it("a desktop whose first-run onboarding already offered Cloud counts it as seen, here and on My Cloud", async () => {
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "onboarding-cloud-v1"];
    expect(await launch()).not.toContain(POPUP);
    await flush(); expect(seenOnDesktop()).toEqual([ID]);
    onMyCloud({ status: "paid", tier: "pro" });
    expect(await launch()).not.toContain(POPUP);
    expect(popupEvents("shown")).toEqual([]);
  });

  it("a window that opens on My Cloud or a saved server gets it whatever This computer's welcome record says or lacks", async () => {
    // An install from before the welcome kept a record, a welcome never finished, or no config.json main can read.
    for (const config of [{ onboarding: { completedAt: "", version: 0, hintsSeen: [] } }, {}, null]) {
      fresh(); account = paid(); desk.config = config;
      onMyCloud({ status: "paid", tier: "pro" });
      expect(await launch(), `${JSON.stringify(config)} on My Cloud`).toContain(POPUP);
      onSavedServer();
      expect(await launch(), `${JSON.stringify(config)} on a saved server`).toContain(POPUP);
      press("Continue on this computer");
      await flush();
      expect(desk.switches, JSON.stringify(config)).toBe(1);
      expect(seenOnDesktop(), JSON.stringify(config)).toEqual([ID]);
    }
  });

  it("never in a remote client's window, on a branded build, or on a desktop that sells no Cloud", async () => {
    (window.ogb as Record<string, any>).remoteClient.active = true;
    expect(await launch()).not.toContain(POPUP);
    showWindow(LOCAL_ORIGIN); f.brand = "file";
    expect(await launch()).not.toContain(POPUP);
    f.brand = "default"; desk.offered = false;
    expect(await launch()).not.toContain(POPUP);
    onMyCloud({ status: "paid", tier: "pro" });
    expect(await launch()).not.toContain(POPUP);
    onSavedServer();
    expect(await launch()).not.toContain(POPUP);
    expect(popupEvents("shown")).toEqual([]);
    expect(seenOnDesktop()).toEqual([]);
  });

  it("waits, and holds back the cards after it, while the plan or the offer loads, a dialog or a call is open, or the app is busy or updating", async () => {
    returning(); storage.set(CLOUD_INTRO, "1");
    const waits: Array<() => void> = [
      () => { account = { status: "signed-out", message: "restoring" }; }, () => { account = { status: "connecting" }; },
      () => { bridges.cloud.offer.mockImplementation(() => new Promise(() => {})); },
      () => { desk.handlers.set("desktop-notices:state", () => new Promise(() => {})); },
      () => { modal = true; }, () => { f.state.liveCall = { status: "live" }; },
      () => { f.state.appSettingsOpen = true; }, () => { f.state.cloudAdd = { source: "app_menu" }; }, () => { f.updater = { status: "downloaded" }; },
      () => { f.state.bots = [{ busy: true, tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }]; },
    ];
    for (const wait of waits) {
      const saved = structuredClone(f.state); wait();
      expect(await launch(), wait.toString()).toBe("");
      f.state = saved; f.updater = null; account = signedOut; modal = false; bridges.cloud.offer.mockImplementation(async () => offer); desk = desktopMachine();
    }
    expect(popupEvents("shown")).toEqual([]);
    expect(seenOnDesktop()).toEqual([]);
    f.state.liveCall = { status: "ended" };
    expect(await launch()).toContain(POPUP);
    modal = true;
    expect(render(), "a dialog that opens over it hides it").not.toContain(POPUP);
    modal = false;
    expect(await settle(), "and it comes back when that dialog closes").toContain(POPUP);
    expect(popupEvents("shown")).toHaveLength(1);
  });

  it("offline, it waits for a later launch and lets the other cards show meanwhile", async () => {
    returning(); account = { status: "unavailable" };
    const offline = await launch();
    expect(offline).not.toContain(POPUP); expect(offline).toContain(STAR);
    account = signedOut; offer = null;
    const unreachable = await launch();
    expect(unreachable).not.toContain(POPUP); expect(unreachable).toContain(STAR);
    expect(seenOnDesktop()).toEqual([]);
    offer = TRIAL_OFFER;
    expect(await launch()).toContain(POPUP);
  });
});
