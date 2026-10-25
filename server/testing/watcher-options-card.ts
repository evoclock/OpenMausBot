import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { WATCHER_OPTIONS_CARD_BOT_ID } from "../../shared/options-card.ts";

const LIVE_RUN = new Set(["queued", "running", "waiting"]);

export interface AgentsCapability {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isolateWatcherBot(bots: unknown, createdBotId: string): { bots: unknown[]; threadId: string } {
  if (!Array.isArray(bots)) throw new Error("bots.json must be an array");
  const bot = bots.find((entry) => record(entry) && entry.id === createdBotId);
  if (!record(bot)) throw new Error("created bot is missing from bots.json");
  const threadId = bot.threadId;
  if (typeof threadId !== "string" || threadId === "") throw new Error("created bot has no thread");
  const rewritten = JSON.parse(JSON.stringify(bot).replaceAll(createdBotId, WATCHER_OPTIONS_CARD_BOT_ID)) as { id?: string };
  if (rewritten.id !== WATCHER_OPTIONS_CARD_BOT_ID) throw new Error("created bot id was not reassigned");
  return { bots: [rewritten], threadId };
}

export function settleRestartWork(routines: unknown): unknown {
  if (!record(routines)) return routines;
  const next = structuredClone(routines);
  if (Array.isArray(next.routines)) {
    for (const routine of next.routines) {
      if (!record(routine)) continue;
      routine.enabled = false;
      routine.runOnStartup = false;
      routine.nextRunAt = null;
    }
  }
  if (Array.isArray(next.runs)) {
    for (const run of next.runs) {
      if (!record(run) || typeof run.status !== "string" || !LIVE_RUN.has(run.status)) continue;
      run.status = "failed";
      delete run.attention;
      delete run.retryAt;
    }
  }
  return next;
}

export function settleWebhooks(webhooks: unknown): unknown {
  if (!record(webhooks) || !Array.isArray(webhooks.webhooks)) return webhooks;
  const next = structuredClone(webhooks);
  for (const hook of next.webhooks as unknown[]) {
    if (record(hook)) hook.enabled = false;
  }
  return next;
}

export function agentsCapabilityForBot(dump: unknown, botId?: string): AgentsCapability | undefined {
  if (!record(dump) || !record(dump.mcpConfig) || !record(dump.mcpConfig.mcpServers)) return undefined;
  const agents = dump.mcpConfig.mcpServers.agents;
  if (!record(agents) || typeof agents.command !== "string") return undefined;
  if (!record(agents.env) || typeof agents.env.OMB_COMMS_TOKEN !== "string" || agents.env.OMB_COMMS_TOKEN === "") return undefined;
  if (botId !== undefined && agents.env.OMB_BOT_ID !== botId) return undefined;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(agents.env)) {
    if (typeof value === "string") env[key] = value;
  }
  const args = Array.isArray(agents.args) ? agents.args.filter((arg): arg is string => typeof arg === "string") : [];
  return { command: agents.command, args, env };
}

function rewriteJson(file: string, edit: (value: unknown) => unknown): void {
  if (!existsSync(file)) return;
  writeFileSync(file, JSON.stringify(edit(JSON.parse(readFileSync(file, "utf8")))));
}

export function prepareWatcherOptionsCard(dataDir: string, createdBotId: string): { threadId: string } {
  const botsFile = join(dataDir, "bots.json");
  const isolated = isolateWatcherBot(JSON.parse(readFileSync(botsFile, "utf8")), createdBotId);
  writeFileSync(botsFile, JSON.stringify(isolated.bots));
  rewriteJson(join(dataDir, "routines.json"), settleRestartWork);
  rewriteJson(join(dataDir, "webhooks.json"), settleWebhooks);
  return { threadId: isolated.threadId };
}
