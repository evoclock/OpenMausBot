import { approvalModeFor, approvalModeWidens } from "../shared/approval-mode.ts";
import { botsSaveFailure } from "../shared/bots-save-failure.ts";
import type { BotRecord, TaskPatch, TaskRecord } from "./store.ts";

export class BotsSaveError extends Error {
  constructor(action: string, cause: unknown) {
    super(botsSaveFailure(action, (cause as { code?: unknown } | null)?.code), { cause });
  }
}

export function saveBotsFor(action: string, save: () => void): void {
  try { save(); } catch (error) { throw new BotsSaveError(action, error); }
}

/** Memory changes only once bots.json holds them; a failed save restores the bot in place. */
export function commitBotChange(bot: BotRecord, action: string, save: () => void, change: () => void, onRollback?: () => void): void {
  const rollback = snapshotBot(bot);
  change();
  try { save(); } catch (error) {
    rollback();
    onRollback?.();
    throw new BotsSaveError(action, error);
  }
}

function snapshotBot(bot: BotRecord): () => void {
  const { tasks, ...fields } = bot;
  const saved = structuredClone(fields);
  const list = tasks ? [...tasks] : undefined;
  const states = list?.map((task) => structuredClone(task));
  return () => {
    restore(bot, tasks ? { ...saved, tasks } : saved);
    if (tasks && list) tasks.splice(0, tasks.length, ...list);
    list?.forEach((task, index) => restore(task, states![index]!));
  };
}

function restore(target: object, saved: object): void {
  for (const key of Object.keys(target)) {
    if (!Object.hasOwn(saved, key)) delete (target as Record<string, unknown>)[key];
  }
  Object.assign(target, saved);
}

const PERMISSION_FIELDS = ["approvalMode", "autoApprove", "alwaysAllow"] as const;

/** A revocation stays live when its save fails; a widening never does. */
export function keptRevocation(task: TaskRecord, patch: TaskPatch): TaskPatch | undefined {
  const fields = PERMISSION_FIELDS.filter((key) => Object.hasOwn(patch, key));
  if (!fields.length) return undefined;
  const next = { ...task, ...patch };
  const allowed = task.alwaysAllow ?? [];
  if (approvalModeWidens(approvalModeFor(task), approvalModeFor(next))) return undefined;
  if ((next.alwaysAllow ?? []).some((key) => !allowed.includes(key))) return undefined;
  return structuredClone(Object.fromEntries(fields.map((key) => [key, patch[key]])));
}
