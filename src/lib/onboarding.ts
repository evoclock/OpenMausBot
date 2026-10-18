import { ONBOARDING_CLOUD_HINT, WELCOME_VERSION } from "../../electron/onboarding-record.mjs";

export interface OnboardingStatus {
  completedAt: string;
  version: number;
  reelSeen: boolean;
  hintsSeen: string[];
  firstTurnAt?: string;
}

export { ONBOARDING_CLOUD_HINT, WELCOME_VERSION };

export const EMPTY_ONBOARDING: OnboardingStatus = {
  completedAt: "",
  version: 0,
  reelSeen: false,
  hintsSeen: [],
};

export interface WelcomeViewer {
  hosted: boolean;
  canSave: boolean;
  cloudHome?: boolean;
}

export const LOCAL_VIEWER: WelcomeViewer = { hosted: false, canSave: true };

export function hostedMember(viewer: WelcomeViewer | null): boolean {
  return Boolean(viewer?.hosted && !viewer.canSave);
}

export function spotlightsQuiet(viewer: WelcomeViewer | null): boolean {
  return viewer === null || hostedMember(viewer);
}

export function welcomeViewer(session: unknown): WelcomeViewer {
  const record = session && typeof session === "object" ? (session as { hosted?: unknown; scopes?: unknown; cloudHome?: unknown }) : {};
  return {
    hosted: record.hosted === true,
    canSave: Array.isArray(record.scopes) ? record.scopes.includes("admin") : true,
    ...(record.cloudHome === true ? { cloudHome: true } : {}),
  };
}

export function welcomeDue(
  config: { onboarding?: OnboardingStatus } | null | undefined,
  options: { remoteClient: boolean; legacyDone: boolean; hosted?: boolean; canSave?: boolean; cloudHome?: boolean },
): boolean {
  if (options.remoteClient || options.cloudHome) return false;
  if (options.canSave === false) return false;
  if (options.hosted && options.canSave !== true) return false;
  if (!config) return false;
  const record = config.onboarding ?? EMPTY_ONBOARDING;
  if (record.completedAt && record.version >= WELCOME_VERSION) return false;
  if (!record.completedAt && options.legacyDone) return false;
  return true;
}

export function completionPatch(now: Date = new Date()): { onboarding: { completedAt: string; version: number } } {
  return { onboarding: { completedAt: now.toISOString(), version: WELCOME_VERSION } };
}

export function hintSeen(record: OnboardingStatus | undefined, id: string): boolean {
  return (record?.hintsSeen ?? []).includes(id);
}

export function hintSeenPatch(
  record: OnboardingStatus | undefined,
  id: string,
): { onboarding: { hintsSeen: string[] } } | null {
  if (hintSeen(record, id)) return null;
  return { onboarding: { hintsSeen: [...(record?.hintsSeen ?? []), id] } };
}


export type BeatId = "hello" | "reel" | "engines" | "import" | "permissions" | "phone" | "cloud" | "bot";

export interface BeatOptions {
  dictation: boolean;
  reel: boolean;
  hosted?: boolean;
  /** This computer has skills or MCP servers from another AI tool to bring in. */
  setupImport?: boolean;
  /** MausBot Cloud can be bought from this desktop now (cloudBeatWanted); the first bot stays the last beat. */
  cloud?: boolean;
}

export function beatsFor(options: BeatOptions): BeatId[] {
  if (options.hosted) return ["hello", "bot"];
  const beats: BeatId[] = ["hello"];
  if (options.reel) beats.push("reel");
  beats.push("engines");
  if (options.setupImport) beats.push("import");
  if (options.dictation) beats.push("permissions");
  beats.push("phone");
  if (options.cloud) beats.push("cloud");
  beats.push("bot");
  return beats;
}

export function onboardingCloudOffered(record: OnboardingStatus | undefined): boolean {
  return hintSeen(record, ONBOARDING_CLOUD_HINT);
}

/** Where the welcome may offer MausBot Cloud at all: this computer's own page with the Cloud bridge, not a branded
 * build, not a hosted or remote viewer. */
export function cloudBeatPossible(input: { bridge: boolean; branded: boolean; hosted: boolean; remote: boolean }): boolean {
  return input.bridge && !input.branded && !input.hosted && !input.remote;
}

/** ...and whether it does: as the buy sheet decides, an account that may buy (buyOfferAllowed) and the Admin's offer
 * loaded. Anything unknown is no beat: onboarding never waits for it. */
export function cloudBeatWanted(input: { bridge: boolean; branded: boolean; hosted: boolean; remote: boolean; mayBuy: boolean | null; offer: unknown }): boolean {
  return cloudBeatPossible(input) && input.mayBuy === true && Boolean(input.offer);
}

let welcomeShown = 0;
/** The welcome flow is on screen (WelcomeFlow, until it closes): a Cloud sheet over it never switches the window away. */
export function showWelcome(): () => void {
  welcomeShown++;
  let gone = false;
  return () => { if (!gone) { gone = true; welcomeShown--; } };
}
export function welcomeOnScreen(): boolean {
  return welcomeShown > 0;
}

export function nextBeat(beats: readonly BeatId[], current: BeatId): BeatId | null {
  const index = beats.indexOf(current);
  if (index < 0 || index + 1 >= beats.length) return null;
  return beats[index + 1]!;
}

export function previousBeat(beats: readonly BeatId[], current: BeatId): BeatId | null {
  const index = beats.indexOf(current);
  if (index <= 0) return null;
  return beats[index - 1]!;
}

export function beatWidth(beat: BeatId): number {
  switch (beat) {
    case "engines":
      return 680;
    case "phone":
      return 620;
    case "import":
      return 540;
    case "reel":
      return 720;
    case "bot":
    case "cloud":
      return 520;
    default:
      return 460;
  }
}

export function flowDotsShown(beat: BeatId): boolean {
  return beat !== "reel";
}


export const DEFAULT_ADMIN_ORIGIN = "https://admin.openmausbot.com";

export function organisationSignIn<Bridge>(
  ogb: { organization?: Bridge; remoteClient?: { active?: boolean } } | undefined,
  options: { hosted: boolean },
): Bridge | undefined {
  if (options.hosted || !ogb || ogb.remoteClient?.active === true) return undefined;
  return ogb.organization;
}

export function companyModelCount(state: { providers?: Array<{ configured: boolean; models: string[] }> } | null): number {
  return (state?.providers ?? []).reduce((total, provider) => total + (provider.configured ? provider.models.length : 0), 0);
}

interface SummaryInstance {
  install?: unknown;
  managed?: unknown;
}

export function engineSummary<Instance extends SummaryInstance>(
  instances: readonly Instance[],
  ready: (instance: Instance) => boolean,
  options: { company: boolean },
): { ready: Instance[]; setup: Instance[]; company: number; allReady: boolean } {
  const engines = instances.filter((instance) => instance.install);
  const personal = engines.filter(ready);
  const setup = engines.filter((instance) => !ready(instance));
  const company = options.company ? instances.filter((instance) => instance.managed && ready(instance)).length : 0;
  return { ready: personal, setup, company, allReady: company > 0 || (personal.length > 0 && setup.length === 0) };
}

export function cloudSignInDue<Instance>(
  viewer: WelcomeViewer | null,
  state: { connected: boolean; instances: readonly Instance[] },
  ready: (instance: Instance) => boolean,
): boolean {
  return Boolean(viewer?.cloudHome && viewer.canSave) && state.connected && state.instances.length > 0 && !state.instances.some(ready);
}


export function reducedMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.reducedMotion === "true") return true;
  return globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
