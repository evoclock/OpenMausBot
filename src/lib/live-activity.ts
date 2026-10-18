import type { Message } from "@/state/store";
import { t } from "./i18n";
import type { LocaleKey } from "@/locales";

// Keys, not labels: this array is built at import time, and t() reads the active pack when called.
const FALLBACK_LABELS: Array<[RegExp, LocaleKey]> = [
  [/\b(?:bash|shell|terminal|exec|command|run_command)\b/i, "chat.activity.runCommand"],
  [/\b(?:read|read_file|view|open_file)\b/i, "chat.activity.readFile"],
  [/\b(?:write|write_file|create_file)\b/i, "chat.activity.writeFile"],
  [/\b(?:edit|apply_patch|replace|str_replace)\b/i, "chat.activity.editFile"],
  [/\b(?:web_search|search_web)\b/i, "chat.activity.searchWeb"],
  [/\b(?:web_fetch|fetch_url|read_page)\b/i, "chat.activity.readPage"],
  [/\b(?:grep|glob|find|search)\b/i, "chat.activity.searching"],
  [/\b(?:screenshot|screen_capture)\b/i, "chat.activity.screen"],
  [/\b(?:click|type|keypress|press|scroll|computer)\b/i, "chat.activity.computer"],
  [/\b(?:open_url|navigate)\b/i, "chat.activity.openPage"],
  [/\b(?:list_bots|list_agents)\b/i, "chat.activity.whosAround"],
  [/\blist_rooms\b/i, "chat.activity.rooms"],
  [/\bpost_to_room\b/i, "chat.activity.postRoom"],
  [/\bdelegate_bot\b/i, "chat.activity.handoff"],
  [/\b(?:ask_bot|send_message)\b/i, "chat.activity.askTeammate"],
];

function sentenceCase(value: string): string {
  const trimmed = value.trim().replace(/[.\s]+$/, "");
  if (!trimmed) return t("chat.activity.thinking");
  return `${trimmed[0].toUpperCase()}${trimmed.slice(1)}`;
}

export function liveActivityLabel(message?: Message): string {
  return liveActivityPhrases(message).phrases[0];
}

const ALTERNATES: Partial<Record<LocaleKey, LocaleKey[]>> = {
  "chat.activity.thinking": [
    "chat.activity.alt.mullingItOver",
    "chat.activity.alt.piecingItTogether",
    "chat.activity.alt.workingItOut",
    "chat.activity.alt.weighingOptions",
    "chat.activity.alt.chippingAway",
    "chat.activity.alt.diggingIn",
    "chat.activity.alt.liningThingsUp",
    "chat.activity.alt.makingProgress",
  ],
  "chat.activity.working": [
    "chat.activity.alt.chippingAway",
    "chat.activity.alt.makingProgress",
    "chat.activity.alt.liningThingsUp",
  ],
  "chat.activity.runCommand": ["chat.activity.alt.checkingTheOutput"],
  "chat.activity.readFile": ["chat.activity.alt.readingThrough", "chat.activity.alt.lookingItOver"],
  "chat.activity.writeFile": ["chat.activity.alt.draftingIt"],
  "chat.activity.editFile": ["chat.activity.alt.makingChanges"],
  "chat.activity.searchWeb": ["chat.activity.alt.lookingItUp", "chat.activity.alt.goingThroughResults"],
  "chat.activity.readPage": ["chat.activity.alt.skimmingThePage"],
  "chat.activity.searching": ["chat.activity.alt.narrowingItDown"],
  "chat.activity.screen": ["chat.activity.alt.takingALook"],
  "chat.activity.computer": ["chat.activity.alt.clickingThrough"],
  "chat.activity.handoff": ["chat.activity.alt.passingItAlong"],
};

export type LiveActivityPhrases = {
  phase: string;
  phrases: string[];
};

function phaseOf(key: LocaleKey): LiveActivityPhrases {
  return { phase: key, phrases: [key, ...(ALTERNATES[key] ?? [])].map((k) => t(k)) };
}

export function liveActivityPhrases(message?: Message): LiveActivityPhrases {
  if (
    message?.kind !== "activity" ||
    !message.tool ||
    message.tool.ok !== undefined ||
    message.comm
  ) {
    return phaseOf("chat.activity.thinking");
  }
  return toolActivityPhrases(message.tool);
}

export function activityStepLabel(tool: { name: string; spoken?: string }): string {
  return toolActivityPhrases(tool).phrases[0];
}

function toolActivityPhrases(tool: { name: string; spoken?: string }): LiveActivityPhrases {
  const spoken = tool.spoken?.trim();
  if (spoken) return { phase: `spoken:${spoken}`, phrases: [sentenceCase(spoken)] };

  const toolName = tool.name.replace(/^mcp__[^_]+__/, "").split(":", 1)[0] ?? "";
  for (const [pattern, key] of FALLBACK_LABELS) {
    if (pattern.test(toolName)) return phaseOf(key);
  }
  return phaseOf("chat.activity.working");
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function phraseAt(phrases: readonly string[], seed: string, step: number): string {
  if (phrases.length < 2 || step <= 0) return phrases[0] ?? "";
  const rest = phrases.slice(1);
  const order = rest
    .map((phrase, index) => ({ phrase, rank: hash(`${seed}|${index}`) }))
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.phrase);
  const cycle = [...order, phrases[0]];
  return cycle[(step - 1) % cycle.length];
}

export function phraseHoldMs(seed: string, step: number): number {
  return 4000 + (hash(`${seed}#${step}`) % 2001);
}
