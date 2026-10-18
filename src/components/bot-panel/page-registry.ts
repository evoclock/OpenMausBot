import type { LocaleKey } from "@/locales";
import type { SetupStep } from "@/lib/bot-overview-types";
import type { BotSettingsSection } from "@/state/store";

export const PANEL_TABS = ["details", "library", "computer", "settings"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

export const TAB_LABEL: Record<PanelTab, LocaleKey> = {
  details: "botSettings.simple.details",
  library: "botSettings.simple.library",
  computer: "computer.tab.computer",
  settings: "settings.title",
};

export type PageId =
  | "setup" | "model" | "instructions" | "approvals" | "always" | "routines" | "apps"
  | "memory" | "skills"
  | "browser" | "folder" | "android"
  | "voice" | "blurb" | "team" | "chiefteams" | "mcp" | "tools" | "webhooks" | "visibility" | "slack"
  | "overview" | "prompt" | "history";

export interface PageMeta {
  title: LocaleKey;
  home: PanelTab;
  where: LocaleKey;
  keywords: string;
}

export const PAGES: Record<PageId, PageMeta> = {
  setup: { title: "botSetup.ideas", home: "details", where: "botSettings.simple.details", keywords: "setup ideas finish" },
  model: { title: "model.simple.model", home: "details", where: "botPanel.where.model", keywords: "engine provider effort reasoning backup fallback cache warm default model" },
  instructions: { title: "botSettings.simple.instructions", home: "details", where: "botPanel.where.instructions", keywords: "soul.md soul standing instructions reply style conversational persona rules" },
  approvals: { title: "botPanel.page.approvals", home: "details", where: "botPanel.where.beforeActs", keywords: "approve approval level auto mode full access ask custom config.toml sending daily limit outbound permissions command allowlist" },
  routines: { title: "botSettings.simple.routines", home: "details", where: "botPanel.where.routines", keywords: "schedule routines cron tasks run logs" },
  apps: { title: "botPanel.page.apps", home: "details", where: "botPanel.where.apps", keywords: "composio connected apps per-app tools grants gmail calendar read write limit vault" },
  memory: { title: "botSettings.simple.memory", home: "library", where: "botPanel.where.memories", keywords: "memory notes remember obsidian upkeep tidy topic daily logs undo" },
  skills: { title: "botSettings.simple.skills", home: "library", where: "botPanel.where.skills", keywords: "skills import command learned procedures organization library teach" },
  browser: { title: "place.browser", home: "computer", where: "computer.tab.computer", keywords: "browser logins sign in record steps profile sign out" },
  folder: { title: "computer.files.folder", home: "computer", where: "computer.tab.computer", keywords: "working folder directory cwd files" },
  android: { title: "botPanel.page.android", home: "computer", where: "computer.tab.computer", keywords: "android phone usb device" },
  voice: { title: "botPanel.page.voice", home: "settings", where: "botPanel.where.profile", keywords: "voice speak read aloud elevenlabs fish chatterbox grok voice notes alerts notifications" },
  blurb: { title: "botPanel.page.blurb", home: "settings", where: "botPanel.where.profile", keywords: "blurb description what it does" },
  team: { title: "botPanel.page.team", home: "settings", where: "botPanel.where.teamwork", keywords: "team move to team section" },
  chiefteams: { title: "botPanel.page.chiefTeams", home: "settings", where: "botPanel.where.teamwork", keywords: "chief of staff additional teams coordinate" },
  mcp: { title: "connectors.tab.mcp", home: "settings", where: "botPanel.where.tools", keywords: "mcp servers plugins" },
  tools: { title: "botAccess.tools.title", home: "settings", where: "botPanel.where.tools", keywords: "tool selection allow exclude native tools" },
  webhooks: { title: "botPanel.page.webhooks", home: "settings", where: "botPanel.where.tools", keywords: "webhooks triggers inbound" },
  always: { title: "botPanel.page.always", home: "settings", where: "botPanel.where.tools", keywords: "always allowed grants tools" },
  visibility: { title: "botSettings.visibility.title", home: "settings", where: "botPanel.where.sharing", keywords: "visibility who can see private people admins members emails hide" },
  slack: { title: "botPanel.page.slack", home: "settings", where: "botPanel.where.sharing", keywords: "slack slack app admin direct messages mentions" },
  overview: { title: "botPanel.page.overview", home: "settings", where: "botPanel.where.activity", keywords: "overview summary status what it does can reach won't recent changes" },
  prompt: { title: "botPanel.page.prompt", home: "settings", where: "botPanel.where.activity", keywords: "prompt preview what the model sees tokens bytes context" },
  history: { title: "botPanel.page.history", home: "settings", where: "botPanel.where.activity", keywords: "history changes undo rollback log earlier versions" },
};

export const PAGE_IDS = Object.keys(PAGES) as PageId[];

export interface PanelTarget {
  tab: PanelTab;
  page?: PageId;
  anchor?: string;
}

const SECTION_TARGET: Record<BotSettingsSection, PanelTarget> = {
  overview: { tab: "settings", page: "overview" },
  identity: { tab: "details" },
  slack: { tab: "settings", page: "slack" },
  soul: { tab: "details", page: "instructions" },
  skills: { tab: "library", page: "skills" },
  memory: { tab: "library", page: "memory" },
  routines: { tab: "details", page: "routines" },
  access: { tab: "computer" },
  model: { tab: "details", page: "model" },
  permissions: { tab: "details", page: "approvals" },
  voice: { tab: "settings", page: "voice" },
  visibility: { tab: "settings", page: "visibility" },
  history: { tab: "settings", page: "history" },
  usage: { tab: "settings", anchor: "activity" },
};

export function sectionTarget(section: BotSettingsSection): PanelTarget {
  return SECTION_TARGET[section];
}

const SETUP_TARGET: Record<SetupStep["id"], PanelTarget> = {
  identity: { tab: "details" },
  soul: { tab: "details", page: "instructions" },
  folder: { tab: "computer", page: "folder" },
  apps: { tab: "details", page: "apps" },
  schedule: { tab: "details", page: "routines" },
};

export function setupTarget(step: SetupStep["id"]): PanelTarget {
  return SETUP_TARGET[step];
}
