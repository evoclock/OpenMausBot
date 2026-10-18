import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountState, CloudCheckoutResult } from "../../electron/cloud-account.mjs";
import type { CloudCredit, CloudOffer, CloudTrial } from "../../electron/cloud-home.mjs";
import { setLocale } from "@/lib/i18n";

// useState by call order; useEffect as React runs it: again only when its dependencies change, after the last one's cleanup.
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as Array<{ effect: EffectCallback; deps?: readonly unknown[] }>,
  ran: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void } | undefined>, state: {} as any, dispatch: null as any }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? initial() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useEffect: (effect: EffectCallback, deps?: readonly unknown[]) => { f.effects.push({ effect, deps }); },
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }) }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./cloud-buy/CloudMascotScene", () => ({ CloudMascotScene: ({ variant }: { variant: string }) => createElement("div", { "data-cloud-scene": variant }) }));
import { CloudAddDialog, CloudAddPanel, CloudAddSheet, planFromKey, type CloudAddActions, type CloudAddUi } from "./CloudAddDialog";
import { cloudAddView, type CloudAddView } from "@/lib/cloud-plan";
import { track } from "@/lib/analytics";
import { showWelcome } from "@/lib/onboarding";

const DAY = 86_400_000, NOW = new Date(2026, 9, 8, 12).getTime();
const allowances = (cpus: number, diskGb: number, maxDiskGb: number, computers: number, computerHours: number) =>
  ({ cpus, memoryMb: cpus * 1024, diskGb, maxDiskGb, computers, computerHours, voiceCharacters: 100_000 });
const PLANS = [
  { tier: "personal", label: "Personal", amount: 2900, allowances: allowances(2, 20, 20, 1, 50), trialDays: 7 },
  { tier: "pro", label: "Pro", amount: 4900, allowances: allowances(4, 50, 50, 2, 200), trialDays: 7 },
  { tier: "max", label: "Max", amount: 9900, allowances: allowances(8, 100, 200, 4, 500), trialDays: 7 },
];
const TRIAL: CloudOffer = { plans: PLANS, recommended: "pro", creditUsd: 5, reminderDays: 2, refundDays: 14 };
const PLAIN: CloudOffer = { plans: PLANS.map(({ trialDays: _days, ...plan }) => plan), recommended: "pro", refundDays: 14 };
const EMAIL = "person@example.test";
const free: CloudAccountState = { status: "connected", account: { id: "a", email: EMAIL }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } };
const paid = (extra: Partial<CloudAccountState> = {}): CloudAccountState => ({ ...free, entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...extra });
const trial = (extra: Partial<CloudTrial> = {}): CloudTrial => ({ state: "active", tier: "pro", endsAt: NOW + 7 * DAY, amount: 4900, chargeAt: NOW + 7 * DAY, holdUntil: null, deleteAt: null, keep: "none", ...extra });
const credit: CloudCredit = { grantedUsd: 5, remainingUsd: 5, state: "active" };
const ready = { status: "ready" as const, origin: "https://omb-u-1.fly.dev" };

type Node = ReactElement<Record<string, any>>;
const nodes = (value: ReactNode): Node[] => {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const label = (node: Node) => text(renderToStaticMarkup(node));
const button = (tree: Node[], name: string) => tree.find(node => node.type === "button" && (label(node) === name || label(node).startsWith(name) || node.props["aria-label"] === name));
const actions = (): CloudAddActions => Object.fromEntries(["choose", "start", "signIn", "back", "email", "sendCode", "changeEmail", "code", "resend", "browser", "reopenBrowser",
  "cancelSignIn", "reopenCheckout", "copyLink", "changePlan", "retry", "name", "color", "openCloud", "notNow", "interest", "close"].map(name => [name, vi.fn()])) as unknown as CloudAddActions;
const baseUi = (extra: Partial<CloudAddUi> = {}): CloudAddUi => ({ chosen: null, offerShown: TRIAL, now: NOW, busy: false, openFailed: false, email: EMAIL, code: "", profileEmail: EMAIL,
  look: { typed: "Studio", name: "Studio", color: "teal" }, counting: null, copied: false, payFailed: false, interest: null, ...extra });
const panel = (view: CloudAddView, extra: Partial<CloudAddUi> = {}) => {
  const handlers = actions(), props = { view, ui: baseUi(extra), actions: handlers };
  return { html: renderToStaticMarkup(createElement(CloudAddPanel, props)), tree: nodes(CloudAddPanel(props)), handlers };
};
/** Each word appears, each after the one before it. */
const inOrder = (plain: string, words: string[]) => {
  let at = 0;
  for (const word of words) {
    const found = plain.indexOf(word, at);
    expect(found, `"${word}" after "${plain.slice(Math.max(0, at - 40), at)}"`).toBeGreaterThanOrEqual(0);
    at = found + word.length;
  }
};

beforeEach(() => { vi.clearAllMocks(); setLocale("en"); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setLocale("en"); });

describe("each screen of the sheet says one thing and offers one next step", () => {
  it("Choose: what Cloud is, the Admin's plans with its recommended one preselected and Most popular, the money in one line, Start free trial", () => {
    const { html, tree, handlers } = panel({ kind: "offer", offer: TRIAL, signedOut: true, notice: null });
    inOrder(text(html), ["MausBot Cloud", "Your bots, always on.", "A private computer in the cloud that runs your bots 24/7, even when this computer is off.",
      "Works while you're away", "Private to you", "Reach it from anywhere", "A real browser and desktop", "Bring everything over",
      "Choose your plan", "Personal", "$29", "per month", "1 cloud computer at once", "2 CPU · 2 GB", "20 GB storage", "50 h cloud computers",
      "Pro", "Most popular", "$49", "Up to 2 cloud computers at once", "Max", "$99", "100–200 GB storage",
      "Due today", "$0.00", "Card needed, nothing charged for 7 days. Then $49/month + tax. Cancel in the app any time.",
      "Today", "Trial starts, with $5 of Claude credit", "Oct 13", "Reminder email", "Oct 15", "$49/month begins",
      "Start free trial", "Secure checkout in your browser", "Apple Pay", "G Pay", "Card", "Cancel in two clicks", "14-day money-back", "Already have a plan? Sign in"]);
    expect(html, "the night shift scene between the lede and the benefits").toMatch(/this computer is off\.<\/p><\/div><div data-cloud-scene="hero"><\/div><ul/);
    expect(html).toContain('role="radio" aria-checked="true" tabindex="0" data-plan="pro"');
    expect(html).toContain('role="radio" aria-checked="false" tabindex="-1" data-plan="max"');
    expect(html.match(/Most popular/g)).toHaveLength(1);
    for (const gone of ["Compare plans", "launch", "$89", "Recommended", "AI credit", "this Mac"]) expect(text(html)).not.toContain(gone);
    button(tree, "Start free trial")!.props.onClick(); expect(handlers.start).toHaveBeenCalledOnce();
    tree.find(node => node.props["data-plan"] === "max")!.props.onClick(); expect(handlers.choose).toHaveBeenCalledWith("max");
    button(tree, "Already have a plan? Sign in")!.props.onClick(); expect(handlers.signIn).toHaveBeenCalledOnce();
    expect(text(panel({ kind: "offer", offer: TRIAL, signedOut: true, notice: null }, { chosen: "personal" }).html)).toContain("Then $29/month + tax.");
    const maxFirst = panel({ kind: "offer", offer: { ...TRIAL, recommended: "max" }, signedOut: false, notice: null }).html;
    expect(maxFirst).toContain('aria-checked="true" tabindex="0" data-plan="max"');
    expect(maxFirst.indexOf("Most popular"), "the Admin's recommended plan, not Pro by itself").toBeGreaterThan(maxFirst.indexOf("data-plan=\"max\""));
  });

  it("Choose without a trial: due today at the price, no card line or timeline, Continue · price; no Sign in once signed in", () => {
    const { html, tree, handlers } = panel({ kind: "offer", offer: PLAIN, signedOut: false, notice: null }, { offerShown: PLAIN });
    const plain = text(html);
    inOrder(plain, ["Due today", "$49 + tax", "Then $49/month + tax, each month from today. Cancel in the app any time.", "Continue · $49/month", "14-day money-back"]);
    for (const gone of ["Card needed", "Trial starts", "Reminder email", "Already have a plan", "Claude credit", "Start free trial"]) expect(plain).not.toContain(gone);
    button(tree, "Continue · $49/month")!.props.onClick(); expect(handlers.start).toHaveBeenCalledOnce();
    expect(text(panel({ kind: "offer", offer: { ...PLAIN, refundDays: undefined }, signedOut: false, notice: null }).html)).not.toContain("money-back");
    expect(text(panel({ kind: "offer", offer: TRIAL, signedOut: true, notice: "code-expired" }).html)).toContain("The sign-in code expired, so nothing changed.");
  });

  it("checking, Cloud out of reach and a checkout that did not open each say so, with Try again", () => {
    expect(text(panel({ kind: "checking" }).html)).toContain("Checking with MausBot Cloud…");
    const unreachable = panel({ kind: "unreachable" });
    expect(text(unreachable.html)).toContain("Can't reach MausBot Cloud right now. Check your connection and try again.");
    button(unreachable.tree, "Try again")!.props.onClick(); expect(unreachable.handlers.retry).toHaveBeenCalledOnce();
    expect(text(panel({ kind: "error", reason: "failed" }).html)).toContain("Checkout couldn't open. Nothing was charged. Try again.");
    expect(text(panel({ kind: "error", reason: "rate-limited" }).html)).toContain("You've opened several checkouts in the last hour.");
  });

  it("Sign in, email: create the account with a code, the profile's email filled in, and single sign-on in the browser", () => {
    const { html, tree, handlers } = panel({ kind: "sign-in", phase: { step: "email", intent: true, problem: null } });
    inOrder(text(html), ["Plans", "Create your MausBot account", "We'll email you a code. No password to remember.", "Email", "Send code",
      "Uses the email from your profile. You can change it.", "Work account with single sign-on? Continue in browser"]);
    const field = tree.find(node => node.props.id === "cloud-add-email")!;
    expect([field.props.value, field.props.type, field.props.autoComplete]).toEqual([EMAIL, "email", "email"]);
    field.props.onChange({ target: { value: "other@example.test" } }); expect(handlers.email).toHaveBeenCalledWith("other@example.test");
    tree.find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }); expect(handlers.sendCode).toHaveBeenCalledOnce();
    button(tree, "Plans")!.props.onClick(); expect(handlers.back).toHaveBeenCalledOnce();
    button(tree, "Continue in browser")!.props.onClick(); expect(handlers.browser).toHaveBeenCalledOnce();
    expect(text(panel({ kind: "sign-in", phase: { step: "email", intent: false, problem: null } }, { email: "else@example.test" }).html))
      .toMatch(/^Plans Sign in to MausBot Cloud(?!.*from your profile)/);
    expect(text(panel({ kind: "sign-in", phase: { step: "email", intent: true, problem: null } }, { profileEmail: null }).html)).not.toContain("from your profile");
  });

  it("Sign in, code: eight boxes, the address with Change, resend after 30 s; typing, pasting and backspace move along the boxes", () => {
    const view: CloudAddView = { kind: "sign-in", phase: { step: "code", intent: true, email: EMAIL, resendAt: NOW + 21_000, problem: null, triesLeft: null } };
    const { html, tree, handlers } = panel(view, { code: "4820" });
    inOrder(text(html), [`Enter the 8-digit code sent to ${EMAIL} · Change`, "Resend code in 0:21"]);
    const boxes = tree.filter(node => node.type === "input");
    expect(boxes.map(box => box.props["aria-label"])).toEqual(Array.from({ length: 8 }, (_, i) => `Digit ${i + 1} of 8`));
    expect(boxes.map(box => box.props.value)).toEqual(["4", "8", "2", "0", "", "", "", ""]);
    expect([boxes[0]!.props.autoComplete, boxes[0]!.props.inputMode]).toEqual(["one-time-code", "numeric"]);
    expect(boxes.findIndex(box => box.props["data-autofocus"]), "the next empty box takes focus").toBe(4);
    const focus = vi.fn(), parent = { querySelectorAll: () => Array.from({ length: 8 }, () => ({ focus })) };
    boxes[4]!.props.onChange({ target: { value: "1" }, currentTarget: { parentElement: parent } });
    expect(handlers.code).toHaveBeenLastCalledWith("48201"); expect(focus).toHaveBeenCalledOnce();
    boxes[0]!.props.onPaste({ clipboardData: { getData: () => " 4820-1937 " }, preventDefault() {}, currentTarget: { parentElement: parent } });
    expect(handlers.code).toHaveBeenLastCalledWith("48201937");
    const prevent = vi.fn();
    boxes[4]!.props.onKeyDown({ key: "Backspace", preventDefault: prevent, currentTarget: { parentElement: parent } });
    expect(handlers.code).toHaveBeenLastCalledWith("482"); expect(prevent).toHaveBeenCalledOnce();
    button(tree, "Change")!.props.onClick(); expect(handlers.changeEmail).toHaveBeenCalledOnce();
    const later = panel(view, { now: NOW + 21_000 });
    button(later.tree, "Didn't get it? Resend code")!.props.onClick(); expect(later.handlers.resend).toHaveBeenCalledOnce();
    expect(text(panel(view, { busy: true }).html)).toContain("Checking the code…");
  });

  it("Sign in, code: with new accounts closed it says a code comes only to an email that already has one", () => {
    const phase = { step: "code" as const, intent: true, email: EMAIL, resendAt: NOW + 21_000, problem: null, triesLeft: null };
    expect(text(panel({ kind: "sign-in", phase: { ...phase, signupOpen: false } }).html)).toContain("New MausBot accounts aren't open yet: a code comes only if this email already has one.");
    expect(text(panel({ kind: "sign-in", phase }).html)).not.toContain("aren't open yet");
  });

  it("Sign in: the Admin's answers in plain words, with the one way on", () => {
    const code = (problem: any, triesLeft: number | null = null): CloudAddView => ({ kind: "sign-in", phase: { step: "code", intent: true, email: EMAIL, resendAt: NOW - 1, problem, triesLeft } });
    expect(text(panel(code("wrong-code", 3)).html)).toContain("That code isn't right. 3 tries left.");
    expect(text(panel(code("wrong-code", 1)).html)).toContain("That code isn't right. 1 try left.");
    const expired = panel(code("expired"));
    expect(text(expired.html)).toContain("That code can't be used any more. Send a new one.");
    button(expired.tree, "Send a new code")!.props.onClick(); expect(expired.handlers.resend).toHaveBeenCalledOnce();
    for (const [problem, line] of [["signup-closed", "New Cloud accounts aren't available yet."], ["device-limit", "Sign one out on your Plan page"],
      ["rate-limited", "Too many codes were asked for just now."], ["failed", "Couldn't reach MausBot Cloud."]] as const) expect(text(panel(code(problem)).html)).toContain(line);
    const sso = panel({ kind: "sign-in", phase: { step: "email", intent: true, problem: "sso" } });
    expect(text(sso.html)).toContain("Your organization uses single sign-on. Continue in browser");
    expect(text(sso.html)).not.toContain("Work account with single sign-on?");
    expect(sso.tree.find(node => node.type === "button" && label(node) === "Continue in browser")!.props.className).toContain("ui-button-primary");
    expect(text(panel(code("two-factor")).html)).toContain("This account uses two-step verification, so it signs in through your browser. Continue in browser");
    expect(text(panel({ kind: "sign-in", phase: { step: "email", intent: true, problem: "invalid-email" } }).html)).toContain("Enter an email address like name@example.com.");
    expect(text(panel({ kind: "sign-in", phase: { step: "done", intent: true } }).html)).toContain("Signed in. Opening secure checkout…");
  });

  it("the browser approval (single sign-on): the code to check, Reopen browser and Cancel", () => {
    const { html, tree, handlers } = panel({ kind: "signing-in", code: "ABCDE-FGHJK", checkout: true });
    expect(text(html)).toContain("Finish in your browser Sign in with your email. Check that your browser shows this code: ABCDE-FGHJK Connect this app, then start your free trial.");
    button(tree, "Reopen browser")!.props.onClick(); expect(handlers.reopenBrowser).toHaveBeenCalledOnce();
    button(tree, "Cancel")!.props.onClick(); expect(handlers.cancelSignIn).toHaveBeenCalledOnce();
  });

  it("Pay: the checklist (signed in, waiting for the payment, setup next), Reopen checkout, Copy link and Change plan; late after 30 minutes", () => {
    const waiting: CloudAddView = { kind: "waiting", plan: "pro", browser: "checkout", late: false, link: true, email: EMAIL };
    const { html, tree, handlers } = panel(waiting);
    inOrder(text(html), ["Finish in your browser", "Checkout opened in your browser. Pay there and this window moves on by itself.",
      "Signed in", EMAIL, "Waiting for your payment", "Pro · free for 7 days · $0.00 today", "Set up your new Cloud", "About 2 minutes, all automatic",
      "Reopen checkout", "Copy link", "Change plan"]);
    expect(html).toContain('aria-current="step"');
    button(tree, "Reopen checkout")!.props.onClick(); expect(handlers.reopenCheckout).toHaveBeenCalledOnce();
    button(tree, "Copy link")!.props.onClick(); expect(handlers.copyLink).toHaveBeenCalledOnce();
    button(tree, "Change plan")!.props.onClick(); expect(handlers.changePlan).toHaveBeenCalledOnce();
    expect(text(panel(waiting, { copied: true }).html)).toContain("Link copied");
    expect(text(panel(waiting, { payFailed: true }).html)).toContain("Checkout couldn't open again. Nothing was charged.");
    expect(text(panel({ ...waiting, link: false }).html)).not.toContain("Copy link");
    expect(text(panel({ ...waiting, plan: "max" }, { offerShown: PLAIN }).html)).toContain("Max · $99/month + tax");
    const late = text(panel({ ...waiting, late: true }).html);
    inOrder(late, ["We haven't seen a payment yet.", "If you paid, it shows up here within a few minutes.", "Reopen checkout", "Change plan"]);
    expect(text(panel({ ...waiting, browser: "signin", link: false }).html)).toContain("Your browser shows the next step.");
  });

  it("Setting up: the badge (trial, credit, or paid), the Admin's steps, a name, a colour and the switcher preview; Open waits for ready", () => {
    const starting: CloudAddView = { kind: "starting", tier: "pro", trial: trial(), credit, step: "storage", slow: false, received: false };
    const { html, tree, handlers } = panel(starting);
    inOrder(text(html), ["Pro trial started · $5 Claude credit added", "Setting up your new Cloud", "About 2 minutes. Keep working if you like, it opens when it's ready.",
      "Reserving your machine", "Preparing storage", "Starting Studio", "Checking it's ready", "Name it", "Pick a colour", "In your switcher", "Studio", "Pro · always on", "Open Studio"]);
    expect(html).toContain('aria-valuenow="25"');
    expect(button(tree, "Open Studio")!.props.disabled).toBe(true);
    const name = tree.find(node => node.props.id === "cloud-add-name")!;
    expect([name.props.value, name.props.maxLength, name.props.placeholder]).toEqual(["Studio", 28, "My Cloud"]);
    name.props.onChange({ target: { value: "Work" } }); expect(handlers.name).toHaveBeenCalledWith("Work");
    const swatches = tree.filter(node => node.props.role === "radio" && node.props["data-color"]);
    expect(swatches.map(node => [node.props["data-color"], node.props["aria-label"], node.props["aria-checked"]])).toEqual([
      ["blue", "Blue", false], ["teal", "Teal", true], ["purple", "Purple", false], ["orange", "Orange", false], ["red", "Red", false], ["yellow", "Yellow", false]]);
    swatches[4]!.props.onClick(); expect(handlers.color).toHaveBeenCalledWith("red");
    expect(swatches[0]!.props.style.background).toBe("var(--identity-blue)");
    expect(text(panel({ ...starting, trial: null, credit: null }).html)).toContain("Pro started");
    expect(text(panel({ ...starting, credit: null }).html)).toMatch(/Pro trial started (?!·)/);
    const received = text(panel({ ...starting, trial: null, credit: null, received: true, step: null }).html);
    inOrder(received, ["Payment received", "Setting up your new Cloud", "We're linking your payment to this account"]);
    expect(text(panel({ ...starting, slow: true }).html)).toContain("This is taking longer than usual.");
  });

  it("Ready: it opens by itself in 3 seconds unless Not now; otherwise Open {name}", () => {
    const view: CloudAddView = { kind: "ready", tier: "pro", trial: trial(), credit };
    const { html, tree, handlers } = panel(view, { counting: 3 });
    inOrder(text(html), ["Studio is ready", "It keeps your bots running 24/7, even when this computer is off.", "Opening in 3…", "Not now", "Open Studio"]);
    expect(html).toContain('aria-valuenow="100"');
    button(tree, "Not now")!.props.onClick(); expect(handlers.notNow).toHaveBeenCalledOnce();
    button(tree, "Open Studio")!.props.onClick(); expect(handlers.openCloud).toHaveBeenCalledOnce();
    const still = text(panel(view).html);
    expect(still).toContain("Switch between This computer and Studio from the menu at the top of the sidebar."); expect(still).not.toContain("Opening in");
    expect(text(panel(view, { openFailed: true }).html)).toContain("Studio didn't open. Try again in a minute.");
  });

  it("Add a Cloud… with a Cloud: one Cloud per account for now, Email me and Open {name}, never an error", () => {
    const { html, tree, handlers } = panel({ kind: "has-cloud" });
    inOrder(text(html), ["One Cloud per account for now", "You have Studio. More than one Cloud per account is coming.", "Email me when I can add another", "Open Studio"]);
    button(tree, "Email me when I can add another")!.props.onClick(); expect(handlers.interest).toHaveBeenCalledOnce();
    button(tree, "Open Studio")!.props.onClick(); expect(handlers.openCloud).toHaveBeenCalledOnce();
    const sent = text(panel({ kind: "has-cloud" }, { interest: "sent" }).html);
    expect(sent).toContain("Thanks. We'll email you when you can add another Cloud."); expect(sent).not.toContain("Email me");
    expect(text(panel({ kind: "has-cloud" }, { interest: "failed" }).html)).toContain("Couldn't reach MausBot Cloud, so nothing was saved.");
    for (const word of ["error", "Error", "already have"]) expect(text(html)).not.toContain(word);
  });

  it("the sheet's frame: one width per screen, Close, and a Staging mark only on the staging Admin", () => {
    const sheet = (kind: CloudAddView["kind"], staging = false) => renderToStaticMarkup(createElement(CloudAddSheet, { kind, staging, onClose: vi.fn(), children: "x" }));
    expect(sheet("offer")).toContain("max-w-[900px]"); expect(sheet("starting")).toContain("max-w-[720px]"); expect(sheet("waiting")).toContain("max-w-[540px]");
    expect(sheet("offer")).toContain('aria-label="Close"');
    expect(sheet("offer"), "above Settings and the welcome flow (z-50), which it opens over").toContain("fixed inset-0 z-[60]");
    expect(sheet("offer")).not.toContain("data-cloud-staging");
    expect(text(sheet("offer", true))).toMatch(/Staging ?: This app uses the staging MausBot Cloud: test payments and test Clouds, not real ones\./);
  });

  it("a click beside the sheet closes it while choosing, never mid sign-in, checkout or setup", () => {
    const outside = (kind: CloudAddView["kind"]) => {
      const onClose = vi.fn(), backdrop = CloudAddSheet({ kind, staging: false, onClose, children: "x" });
      const event = { target: "backdrop", currentTarget: "backdrop" };
      (backdrop.props as { onMouseDown: (event: unknown) => void }).onMouseDown(event);
      (backdrop.props as { onMouseDown: (event: unknown) => void }).onMouseDown({ target: "sheet", currentTarget: "backdrop" });
      return onClose.mock.calls.length;
    };
    for (const kind of ["offer", "has-cloud", "ready", "error", "unreachable", "checking"] as const) expect(outside(kind), kind).toBe(1);
    for (const kind of ["sign-in", "signing-in", "waiting", "starting"] as const) expect(outside(kind), kind).toBe(0);
  });
});

describe("the sheet", () => {
  let account: CloudAccountState;
  let offer: CloudOffer | null;
  let bridge: Record<string, ReturnType<typeof vi.fn>>;
  let focused = true, push: (state: CloudAccountState) => void = () => {};
  const opener = { focus: vi.fn(), isConnected: true };
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const runEffects = () => f.effects.forEach(({ effect, deps }, i) => {
    const before = f.ran[i];
    if (before && deps && before.deps && deps.length === before.deps.length && deps.every((dep, k) => Object.is(dep, before.deps![k]))) return;
    before?.cleanup?.();
    const cleanup = effect();
    f.ran[i] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
  });
  const render = () => { f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(CloudAddDialog, { now: () => NOW })); };
  async function settle() { for (let i = 0; i < 5; i++) { render(); runEffects(); await flush(); } return text(render()); }
  const tree = () => { f.index = 0; f.effects = []; return nodes(CloudAddDialog({ now: () => NOW })); };
  const press = async (name: string) => { button(tree(), name)!.props.onClick(); await flush(); return settle(); };
  beforeEach(() => {
    f.values = []; f.index = 0; f.effects = []; f.ran = []; f.dispatch = vi.fn(); f.state = { cloudAdd: { source: "app_menu" }, config: { profile: { email: EMAIL } } };
    account = { status: "signed-out" }; offer = TRIAL; focused = true; opener.focus.mockClear();
    bridge = { state: vi.fn(async () => account), onState: vi.fn((callback: (state: CloudAccountState) => void) => { push = callback; return () => {}; }), offer: vi.fn(async () => offer),
      checkout: vi.fn(async (plan: string): Promise<CloudCheckoutResult> => ({ outcome: "opened", state: { ...free, checkout: { plan, startedAt: NOW, link: true } } })),
      begin: vi.fn(async () => ({ status: "connecting" })), reopen: vi.fn(async () => account), cancel: vi.fn(async () => ({ status: "signed-out" })),
      signInStart: vi.fn(async (email: string) => ({ outcome: "sent", email: email.trim().toLowerCase(), expiresAt: NOW + 600_000, resendAt: NOW + 30_000 })),
      signInVerify: vi.fn(async () => ({ outcome: "signed-in", state: { ...free, offer: TRIAL } })), signInCancel: vi.fn(async () => {}),
      reopenCheckout: vi.fn(async () => ({ outcome: "opened", state: account })), copyCheckoutLink: vi.fn(async () => true), interest: vi.fn(async () => {}),
      look: vi.fn(async () => ({ name: "My Cloud", color: "blue" })), setLook: vi.fn(async (name: string, color: string) => ({ name, color })), sheet: vi.fn(async () => {}),
      readySeen: vi.fn(async () => {}),
      connectHome: vi.fn(async () => account) };
    vi.stubGlobal("window", { ogb: { cloudAccount: bridge }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("document", { querySelector: () => null, activeElement: opener, body: {}, hasFocus: () => focused });
  });

  it("signed out, Start free trial signs in inside the sheet: the code, then straight to checkout, with no browser until payment", async () => {
    expect(await settle()).toContain("Your bots, always on.");
    expect(track).toHaveBeenCalledWith("cloud_dialog_shown", { source: "app_menu", view: "offer" });
    expect(bridge.sheet).toHaveBeenCalledWith(true);
    tree().find(node => node.props["data-plan"] === "max")!.props.onClick();
    expect(await press("Start free trial")).toContain("Create your MausBot account");
    expect(bridge.checkout).not.toHaveBeenCalled(); expect(bridge.begin).not.toHaveBeenCalled();
    expect(tree().find(node => node.props.id === "cloud-add-email")!.props.value, "the profile's email").toBe(EMAIL);
    tree().find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }); await flush();
    expect(bridge.signInStart).toHaveBeenCalledExactlyOnceWith(EMAIL);
    expect(await settle()).toContain(`Enter the 8-digit code sent to ${EMAIL}`);
    const parent = { querySelectorAll: () => [] };
    tree().filter(node => node.type === "input")[0]!.props.onChange({ target: { value: "48201937" }, currentTarget: { parentElement: parent } });
    await flush(); await flush();
    expect(bridge.signInVerify).toHaveBeenCalledExactlyOnceWith("48201937");
    expect(bridge.checkout).toHaveBeenCalledExactlyOnceWith("max", "app_menu");
    account = { ...free, checkout: { plan: "max", startedAt: NOW, link: true } };
    expect(await settle()).toContain("Waiting for your payment");
    expect(track).toHaveBeenCalledWith("cloud_signin", { step: "signed_in", source: "app_menu" });
    expect(track).toHaveBeenCalledWith("cloud_checkout_opened", { plan: "max", trial: true, source: "app_menu" });
  });

  it("the Admin's word that new accounts are closed reaches the code step", async () => {
    bridge.signInStart.mockResolvedValueOnce({ outcome: "sent", email: EMAIL, expiresAt: NOW + 600_000, resendAt: NOW + 30_000, signupOpen: false });
    await settle(); await press("Start free trial");
    tree().find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }); await flush();
    expect(await settle()).toContain("New MausBot accounts aren't open yet");
  });

  it("signed in to an account whose own terms differ (a trial already used): back to Choose with its terms, never a checkout said to be $0.00", async () => {
    await settle(); await press("Start free trial");
    tree().find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }); await flush(); await settle();
    const own = { ...PLAIN, recommended: "pro" };
    bridge.signInVerify.mockResolvedValueOnce({ outcome: "signed-in", state: { ...free, offer: own } });
    offer = own;
    tree().filter(node => node.type === "input")[0]!.props.onChange({ target: { value: "48201937" }, currentTarget: { parentElement: { querySelectorAll: () => [] } } });
    await flush(); await flush();
    expect(bridge.checkout).not.toHaveBeenCalled();
    push({ ...free, offer: own });
    const html = await settle();
    expect(html).toContain("You're signed in. These are the plans for your account");
    expect(html).toContain("Continue · $49/month"); expect(html).not.toContain("$0.00");
    await press("Continue · $49/month");
    expect(bridge.checkout).toHaveBeenCalledExactlyOnceWith("pro", "app_menu");
  });

  it("a wrong code says the tries left and empties the boxes; single sign-on continues in the browser with the plan", async () => {
    await settle(); await press("Start free trial");
    tree().find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }); await flush(); await settle();
    bridge.signInVerify.mockResolvedValueOnce({ outcome: "wrong-code", triesLeft: 4 });
    tree().filter(node => node.type === "input")[0]!.props.onPaste({ clipboardData: { getData: () => "11111111" }, preventDefault() {}, currentTarget: { parentElement: { querySelectorAll: () => [] } } });
    await flush(); await flush();
    expect(await settle()).toContain("That code isn't right. 4 tries left.");
    expect(tree().filter(node => node.type === "input").map(box => box.props.value).join("")).toBe("");
    expect(bridge.checkout).not.toHaveBeenCalled();
    bridge.signInStart.mockResolvedValueOnce({ outcome: "sso" });
    await press("Change");
    tree().find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }); await flush();
    expect(await settle()).toContain("Your organization uses single sign-on.");
    await press("Continue in browser");
    expect(bridge.signInCancel).toHaveBeenCalled();
    expect(bridge.checkout).toHaveBeenCalledExactlyOnceWith("pro", "app_menu");
  });

  it("signed in, Start free trial is the checkout of the chosen plan; Reopen uses main's kept page and Copy link copies it there", async () => {
    account = free;
    await settle();
    await press("Start free trial");
    expect(bridge.checkout).toHaveBeenCalledExactlyOnceWith("pro", "app_menu");
    expect(bridge.signInStart).not.toHaveBeenCalled();
    account = { ...free, checkout: { plan: "pro", startedAt: NOW, link: true } };
    expect(await settle()).toContain("Finish in your browser");
    await press("Reopen checkout");
    expect(bridge.reopenCheckout).toHaveBeenCalledExactlyOnceWith("pro", "app_menu"); expect(bridge.checkout).toHaveBeenCalledOnce();
    expect(await press("Copy link")).toContain("Link copied");
    expect(bridge.copyCheckoutLink).toHaveBeenCalledOnce();
    expect(await press("Change plan")).toContain("Choose your plan");
    expect(tree().find(node => node.props["data-plan"] === "pro")!.props["aria-checked"]).toBe(true);
    tree().find(node => node.props["data-plan"] === "personal")!.props.onClick();
    await press("Start free trial");
    expect(bridge.checkout).toHaveBeenLastCalledWith("personal", "app_menu");
  });

  it("the countdown stops when the window loses focus: nothing switches while the person is elsewhere", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("window", { ogb: { cloudAccount: bridge }, addEventListener: vi.fn((name: string, listener: () => void) => listeners.set(name, listener)),
      removeEventListener: vi.fn((name: string) => listeners.delete(name)) });
    account = paid({ machine: ready, checkout: { plan: "pro", startedAt: NOW - 120_000, link: true } });
    expect(await settle()).toContain("Opening in 3…");
    listeners.get("blur")!();
    const away = await settle();
    expect(away).not.toContain("Opening in"); expect(away).toContain("Open My Cloud");
    vi.advanceTimersByTime(5000); await settle();
    expect(bridge.connectHome).not.toHaveBeenCalled();
    expect(listeners.has("blur"), "not listening once it stopped").toBe(false);
  });

  it("ready shown ends the purchase for main; a later Add a Cloud… (bought, opened or told) is one Cloud for now, with no countdown", async () => {
    vi.useFakeTimers();
    account = paid({ machine: ready, checkout: { plan: "pro", startedAt: NOW - 120_000, link: true } });
    expect(await settle()).toContain("Opening in 3…");
    expect(bridge.readySeen).toHaveBeenCalledOnce();
    await press("Not now");
    f.values = []; f.ran = []; bridge.readySeen.mockClear();
    account = paid({ machine: ready, checkout: { plan: "pro", startedAt: NOW - 120_000, link: true, done: true } });
    const again = await settle();
    expect(again).toContain("One Cloud per account for now"); expect(again).not.toContain("Opening in");
    vi.advanceTimersByTime(5000); await settle();
    expect(bridge.connectHome).not.toHaveBeenCalled();
  });

  it("ready while open in the focused window: Opening in 3…, then the Cloud opens; Not now stops it; unfocused, Open {name}", async () => {
    vi.useFakeTimers();
    account = paid({ trial: trial(), credit, machine: ready, checkout: { plan: "pro", startedAt: NOW - 120_000, link: true } });
    expect(await settle()).toContain("Opening in 3…");
    expect(bridge.look).toHaveBeenCalled();
    expect(await settle()).toContain("Open My Cloud");
    vi.advanceTimersByTime(1000); expect(await settle()).toContain("Opening in 2…");
    vi.advanceTimersByTime(1000); await settle(); vi.advanceTimersByTime(1000); await settle();
    expect(bridge.connectHome).toHaveBeenCalledOnce();
    f.values = []; f.ran = []; bridge.connectHome.mockClear();
    await settle();
    expect(await press("Not now")).not.toContain("Opening in");
    vi.advanceTimersByTime(5000); await settle();
    expect(bridge.connectHome).not.toHaveBeenCalled();
    f.values = []; f.ran = []; focused = false;
    const away = await settle();
    expect(away).not.toContain("Opening in"); expect(away).toContain("Switch between This computer and My Cloud");
    vi.advanceTimersByTime(5000); await settle();
    expect(bridge.connectHome).not.toHaveBeenCalled();
  });

  it("after a restart mid-checkout: Pay from the Admin's open checkout, then setup, then ready is theirs to open, not one Cloud for now", async () => {
    focused = false;
    account = free; offer = { ...TRIAL, checkout: { plan: "pro", openUntil: NOW + 3600_000 } };
    expect(await settle()).toContain("Waiting for your payment");
    push(paid({ trial: trial(), machine: { status: "provisioning", setup: { step: "storage" } } }));
    expect(await settle()).toContain("Setting up your new Cloud");
    push(paid({ trial: trial(), machine: ready }));
    const html = await settle();
    expect(html).toContain("My Cloud is ready"); expect(html).not.toContain("One Cloud per account");
  });

  it("over the welcome flow a ready Cloud never switches the window: no countdown, main hears no sheet in front, Open {name} stays", async () => {
    vi.useFakeTimers();
    const hide = showWelcome();
    try {
      f.state = { cloudAdd: { source: "app_onboarding" }, config: {} };
      account = paid({ trial: trial(), credit, machine: ready, checkout: { plan: "pro", startedAt: NOW - 120_000, link: true } });
      const html = await settle();
      expect(html).toContain("My Cloud is ready"); expect(html).toContain("Open My Cloud"); expect(html).not.toContain("Opening in");
      vi.advanceTimersByTime(10_000); await settle();
      expect(bridge.connectHome).not.toHaveBeenCalled();
      expect(bridge.sheet, "main notifies instead, as for a closed sheet").not.toHaveBeenCalledWith(true);
      await press("Open My Cloud");
      expect(bridge.connectHome, "only when the person asks").toHaveBeenCalledOnce();
    } finally { hide(); }
  });

  it("the name and colour go to main as they are chosen (after a pause), and the last ones before the Cloud opens", async () => {
    vi.useFakeTimers();
    account = paid({ machine: { status: "provisioning", setup: { step: "starting" } } });
    expect(await settle()).toContain("Setting up your new Cloud");
    vi.advanceTimersByTime(400); await flush();
    expect(bridge.setLook).toHaveBeenCalledExactlyOnceWith("My Cloud", "blue");
    bridge.setLook.mockClear();
    tree().find(node => node.props.id === "cloud-add-name")!.props.onChange({ target: { value: "Studio" } });
    tree().find(node => node.props["data-color"] === "purple")!.props.onClick();
    expect(await settle()).toContain("Starting Studio");
    expect(bridge.setLook).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400); await flush();
    expect(bridge.setLook).toHaveBeenCalledWith("Studio", "purple");
    tree().find(node => node.props.id === "cloud-add-name")!.props.onChange({ target: { value: "   " } });
    expect(await settle()).toContain("Starting My Cloud");
    account = paid({ machine: ready, checkout: { plan: "pro", startedAt: NOW - 120_000 } }); focused = false;
    await settle();
    tree().find(node => node.props.id === "cloud-add-name")!.props.onChange({ target: { value: "Lab" } }); await settle();
    await press("Open Lab");
    expect(bridge.setLook).toHaveBeenLastCalledWith("Lab", "purple");
    expect(bridge.connectHome).toHaveBeenCalledOnce();
    expect(f.dispatch).toHaveBeenCalledWith({ type: "closeCloudAdd" });
  });

  it("Add a Cloud… with a Cloud: one Cloud for now, Email me and Open; during setup, the setup", async () => {
    vi.useFakeTimers();
    account = paid({ machine: ready });
    bridge.look.mockResolvedValue({ name: "Studio", color: "teal" });
    expect(await settle()).toContain("One Cloud per account for now");
    expect(await settle()).toContain("You have Studio.");
    vi.advanceTimersByTime(1000); await flush();
    expect(bridge.setLook, "an existing Cloud is never recoloured by opening the sheet").not.toHaveBeenCalled();
    expect(await press("Email me when I can add another")).toContain("Thanks. We'll email you");
    expect(bridge.interest).toHaveBeenCalledOnce();
    await press("Open Studio"); expect(bridge.connectHome).toHaveBeenCalledOnce();
    f.values = []; f.ran = [];
    account = paid({ machine: { status: "provisioning" } });
    expect(await settle()).toContain("Setting up your new Cloud");
  });

  it("closing gives focus back to what opened it, and tells main the sheet is closed", async () => {
    await settle();
    await press("Close");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "closeCloudAdd" });
    f.state = { cloudAdd: null };
    expect(await settle()).toBe("");
    expect(opener.focus).toHaveBeenCalledOnce();
    expect(bridge.sheet).toHaveBeenLastCalledWith(false);
  });

  it("opened at Sign in (the card, Settings): the sign-in first, without a plan; signed in, a ready Cloud is theirs to open", async () => {
    f.state = { cloudAdd: { source: "app_settings", signIn: true }, config: {} };
    expect(await settle()).toContain("Sign in to MausBot Cloud");
    bridge.signInVerify.mockResolvedValueOnce({ outcome: "signed-in", state: paid({ machine: ready }) });
    tree().find(node => node.props.id === "cloud-add-email")!.props.onChange({ target: { value: "me@example.test" } });
    await settle();
    tree().find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }); await flush(); await settle();
    tree().filter(node => node.type === "input")[0]!.props.onChange({ target: { value: "48201937" }, currentTarget: { parentElement: { querySelectorAll: () => [] } } });
    await flush(); await flush();
    account = paid({ machine: ready }); focused = false;
    expect(await settle()).toContain("My Cloud is ready");
    expect(bridge.checkout).not.toHaveBeenCalled();
  });

  it("Settings' Sign in after a saved sign-in was removed signs in here, instead of handing back to Settings at once", async () => {
    f.state = { cloudAdd: { source: "app_settings", signIn: true }, config: {} };
    account = { status: "signed-out", message: "restore-removed" }; offer = null;
    expect(await settle()).toContain("Sign in to MausBot Cloud");
    expect(f.dispatch).not.toHaveBeenCalledWith({ type: "closeCloudAdd" });
    tree().find(node => node.props.id === "cloud-add-email")!.props.onChange({ target: { value: EMAIL } }); await settle();
    tree().find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }); await flush();
    expect(bridge.signInStart).toHaveBeenCalledExactlyOnceWith(EMAIL);
  });

  it("a refused checkout says why and changes nothing; a conflict shows what the account is now", async () => {
    account = free;
    await settle();
    bridge.checkout.mockResolvedValueOnce({ outcome: "rate-limited", state: account });
    expect(await press("Start free trial")).toContain("You've opened several checkouts in the last hour.");
    expect(await press("Try again")).toContain("Start free trial");
    bridge.checkout.mockRejectedValueOnce(new Error("Choose a plan to continue."));
    expect(await press("Start free trial")).toContain("Checkout couldn't open. Nothing was charged.");
    await press("Try again");
    bridge.checkout.mockResolvedValueOnce({ outcome: "conflict", state: free });
    expect(await press("Start free trial")).toContain("A checkout is already being prepared. Try again in a moment.");
  });

  it("the plan picker moves with the arrow keys", async () => {
    const tiers = ["personal", "pro", "max"];
    expect([planFromKey(tiers, "pro", "ArrowDown"), planFromKey(tiers, "max", "ArrowRight"), planFromKey(tiers, "pro", "ArrowUp"), planFromKey(tiers, "personal", "ArrowLeft"),
      planFromKey(tiers, "max", "Home"), planFromKey(tiers, "personal", "End"), planFromKey(tiers, "pro", "Enter")]).toEqual(["max", "personal", "personal", "max", "personal", "max", null]);
    await settle();
    const focus = vi.fn(), prevent = vi.fn();
    tree().find(node => node.props["data-plan"] === "pro")!.props.onKeyDown({ key: "ArrowDown", preventDefault: prevent,
      currentTarget: { parentElement: { querySelector: (selector: string) => selector === '[data-plan="max"]' ? { focus } : null } } });
    expect(prevent).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledOnce();
    expect(await settle()).toContain("Then $99/month + tax.");
  });

  it("payment problems and ended sign-ins are Settings' to say: the sheet hands over and closes", async () => {
    account = { status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } };
    expect(await settle()).toBe("");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "closeCloudAdd" });
    expect(f.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "cloudAccount" });
  });

  it("is only on This computer's page, and only while asked for", async () => {
    f.state = { cloudAdd: null }; expect(await settle()).toBe("");
    f.state = { cloudAdd: { source: "app_card" } };
    vi.stubGlobal("window", { ogb: { remoteClient: { active: true }, cloudAccount: bridge } }); expect(await settle()).toBe("");
    vi.stubGlobal("window", {}); expect(await settle()).toBe("");
  });

  it("the view comes from the one state → view function", () => {
    expect(cloudAddView({ status: "signed-out" }, TRIAL, { now: NOW }).kind).toBe("offer");
  });
});
