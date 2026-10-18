import type { CloudMoveState } from "../../electron/cloud-move.mjs";
import { hintSeen, type OnboardingStatus, type WelcomeViewer } from "@/lib/onboarding";

export const CLOUD_SETUP_HIDDEN = "cloud-setup-hidden";
export const CLOUD_SETUP_MOVE_SKIPPED = "cloud-setup-move-skipped";
export const CLOUD_INTENT_ASKED = "cloud-intent-asked";
export const CLOUD_INTENT_GIVEN = "cloud-intent-given";
export const CLOUD_WELCOME_DONE = "cloud-welcome-done";
export const CLOUD_WELCOME_SHOWN = "cloud-welcome-shown";

export const WELCOME_STEPS = ["bring", "engine", "files"] as const;
export type WelcomeStep = (typeof WELCOME_STEPS)[number];
export type WelcomeView = WelcomeStep | "done";
const WELCOME_FINISHED: Record<WelcomeStep, string> = { bring: "cloud-welcome-bring", engine: "cloud-welcome-engine", files: "cloud-welcome-files" };

export const welcomeStepHint = (step: WelcomeStep): string => WELCOME_FINISHED[step];
export const welcomeStepFinished = (onboarding: OnboardingStatus | undefined, step: WelcomeStep): boolean => hintSeen(onboarding, WELCOME_FINISHED[step]);

export type CloudSetupStep = "cloud" | "job" | "engine" | "plan" | "move" | "files";
export type CloudSetupStatus = "todo" | "done" | "skipped";
export interface CloudSetupItem { id: CloudSetupStep; status: CloudSetupStatus }

export interface CloudSetupFacts {
  viewer: WelcomeViewer | null;
  connected: boolean;
  enginesKnown: boolean;
  engineReady: boolean;
  onboarding: OnboardingStatus | undefined;
  planned?: boolean;
  /** The welcome fills the main pane right now. */
  welcomeShown?: boolean;
  move: { phase: CloudMoveState["phase"]; action?: CloudMoveState["action"]; suggest: boolean } | null;
}

type StageFacts = Pick<CloudSetupFacts, "viewer" | "connected" | "enginesKnown" | "onboarding">;

/**
 * "none" off the owner's Cloud home, and on a Cloud set up before the welcome: one that answered the first-job
 * question or worked without the welcome ever showing there. Once shown, a chat (from a phone, say) does not end it.
 */
export function cloudWelcomeStage(facts: StageFacts): "none" | "waiting" | "pending" | "ended" {
  if (!facts.viewer?.cloudHome || !facts.viewer.canSave) return "none";
  if (!facts.connected || !facts.enginesKnown || !facts.onboarding) return "waiting";
  const record = facts.onboarding;
  const started = hintSeen(record, CLOUD_WELCOME_SHOWN) || WELCOME_STEPS.some((step) => welcomeStepFinished(record, step));
  if (!started && (hintSeen(record, CLOUD_INTENT_ASKED) || record.firstTurnAt)) return "none";
  return hintSeen(record, CLOUD_WELCOME_DONE) || hintSeen(record, CLOUD_SETUP_HIDDEN) ? "ended" : "pending";
}

/** Bringing your stuff comes first: a copy from the Cloud's own page goes only into an empty Cloud, which a first chat ends. */
export function welcomeView(onboarding: OnboardingStatus | undefined): WelcomeView {
  return WELCOME_STEPS.find((step) => !welcomeStepFinished(onboarding, step)) ?? "done";
}

export function welcomeViewAfter(onboarding: OnboardingStatus | undefined, finished: WelcomeStep): WelcomeView {
  const open = WELCOME_STEPS.filter((step) => step !== finished && !welcomeStepFinished(onboarding, step));
  return open.find((step) => WELCOME_STEPS.indexOf(step) > WELCOME_STEPS.indexOf(finished)) ?? open[0] ?? "done";
}

export function cloudSetupStage(facts: Omit<CloudSetupFacts, "move">): "none" | "waiting" | "hidden" | "welcome" | "done" | "shown" {
  if (!facts.viewer?.cloudHome || !facts.viewer.canSave) return "none";
  if (!facts.connected || !facts.enginesKnown || !facts.onboarding) return "waiting";
  if (hintSeen(facts.onboarding, CLOUD_SETUP_HIDDEN)) return "hidden";
  const welcome = cloudWelcomeStage(facts);
  if (welcome === "pending") return facts.welcomeShown ? "welcome" : "shown";
  const given = hintSeen(facts.onboarding, CLOUD_INTENT_GIVEN);
  const worked = given ? Boolean(facts.planned) : welcome === "ended" || Boolean(facts.onboarding.firstTurnAt);
  if (facts.engineReady && worked) return "done";
  return "shown";
}

const UNDER_WAY = new Set<CloudMoveState["phase"]>(["preparing", "growing", "exporting", "uploading", "checking", "replacing", "restarting", "failed"]);

export function moveStatus(move: CloudSetupFacts["move"], onboarding: OnboardingStatus | undefined): CloudSetupStatus | null {
  if (!move) return null;
  if (move.action !== "restore" && move.phase === "done") return "done";
  if (move.action !== "restore" && UNDER_WAY.has(move.phase)) return "todo";
  if (hintSeen(onboarding, CLOUD_SETUP_MOVE_SKIPPED)) return "skipped";
  return move.suggest ? "todo" : null;
}

function welcomeBringStatus(facts: CloudSetupFacts): CloudSetupStatus | null {
  const copied = moveStatus(facts.move, facts.onboarding) === "done";
  if (!copied && hintSeen(facts.onboarding, CLOUD_SETUP_MOVE_SKIPPED)) return "skipped";
  if (copied || welcomeStepFinished(facts.onboarding, "bring")) return "done";
  return null;
}

/** On a Cloud with the welcome, the compact form of its steps; on one set up before it, the first-job checklist. */
export function cloudSetupItems(facts: CloudSetupFacts): CloudSetupItem[] {
  const given = hintSeen(facts.onboarding, CLOUD_INTENT_GIVEN);
  const welcome = cloudWelcomeStage(facts);
  if (welcome === "pending") {
    return [
      { id: "cloud", status: "done" },
      { id: "move", status: welcomeBringStatus(facts) ?? "todo" },
      { id: "engine", status: !welcomeStepFinished(facts.onboarding, "engine") ? "todo" : facts.engineReady ? "done" : "skipped" },
      { id: "files", status: welcomeStepFinished(facts.onboarding, "files") ? "done" : "todo" },
    ];
  }
  const items: CloudSetupItem[] = [{ id: "cloud", status: "done" }];
  if (welcome !== "ended") items.push({ id: "job", status: given || facts.onboarding?.firstTurnAt ? "done" : "todo" });
  else if (given) items.push({ id: "job", status: "done" });
  items.push({ id: "engine", status: facts.engineReady ? "done" : "todo" });
  if (given) items.push({ id: "plan", status: facts.planned ? "done" : "todo" });
  const move = welcome === "ended" ? welcomeBringStatus(facts) ?? moveStatus(facts.move, facts.onboarding) : moveStatus(facts.move, facts.onboarding);
  if (move) items.push({ id: "move", status: move });
  return items;
}
