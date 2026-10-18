// Bring newer chats: adds to this server what a copy of another computer's workspace has and it lacks, a whole
// conversation or the messages (by id) of one both have. Invariant: nothing here deletes a row, writes a bot's settings,
// a room's setup, a routine, a memory or a credential, or changes a message this server already has, except the parentId
// that orders it after an added message.
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { splitTranscriptAttachments } from "../src/lib/composer-attachments.ts";
import { movesThreadToTop } from "../shared/wire.ts";
import { cleanupStaleAttachmentPartials } from "./attachments.ts";
import type { BotRecord, GroupRecord, GroupTaskRecord, Message, Store, TaskRecord } from "./store.ts";
import { restorePaths } from "./workspace-backup-paths.ts";

export interface ThreadRows { rows: Message[]; leaf: string | null }
export interface ChatsSide {
  bots: ReadonlyArray<Pick<BotRecord, "id" | "threadId" | "tasks" | "projects">>;
  groups: ReadonlyArray<Pick<GroupRecord, "id" | "threadId" | "tasks" | "dm">>;
  thread(threadId: string): ThreadRows;
}
type Owner = { kind: "bot" | "group"; id: string };
type Link = { id: string; parentId: string | null };
export interface ThreadMerge { owner: Owner; threadId: string; task?: TaskRecord | GroupTaskRecord; added: Message[]; relinked: Link[]; leaf: string | null }
/** `messages`: text lines (what a person reads as messages); `intoExisting`: of those, the ones added to conversations it already had. */
export interface ChatMergeResult { conversations: number; messages: number; intoExisting: number; skippedBots: number; skippedRooms: number; deleted: number }
export interface ChatMergePlan extends ChatMergeResult { threads: ThreadMerge[] }
export type ChatStore = Pick<Store, "bots" | "groups" | "bot" | "group" | "messagesFor" | "activeLeaf" | "importTranscript" | "patchBot" | "patchGroup">;

const BOT_TASK_KEYS = ["threadId", "title", "createdAt", "titleFromFirstMessage", "openedBy", "closedBy", "archivedAt", "pinned", "link", "linkAuto",
  "lastReadMessageId", "pinnedMessageId", "routineRunId", "askedAt"] as const;
const GROUP_TASK_KEYS = ["threadId", "title", "createdAt", "titleFromFirstMessage", "pinned", "pinnedMessageId"] as const;
const ATTACHMENT_NAME = /^[A-Za-z0-9-]{1,80}\.[A-Za-z0-9]{1,10}$/;

const ownerKey = (owner: Owner) => `${owner.kind}:${owner.id}`;
const newest = (values: Iterable<number>) => { let max = Number.NEGATIVE_INFINITY; for (const value of values) if (value > max) max = value; return max; };
const textLines = (rows: readonly Message[]) => rows.filter((row) => row.kind === "text").length;

function* conversations(side: ChatsSide): Generator<{ owner: Owner; threadId: string; task?: TaskRecord | GroupTaskRecord; dm?: boolean }> {
  for (const bot of side.bots) {
    const owner = { kind: "bot" as const, id: bot.id }, seen = new Set<string>();
    for (const task of bot.tasks ?? []) if (!seen.has(task.threadId)) { seen.add(task.threadId); yield { owner, threadId: task.threadId, task }; }
    if (!seen.has(bot.threadId)) yield { owner, threadId: bot.threadId };
  }
  for (const group of side.groups) {
    const owner = { kind: "group" as const, id: group.id };
    if (group.dm || !group.tasks?.length) yield { owner, threadId: group.threadId, dm: Boolean(group.dm) };
    else for (const task of group.tasks) yield { owner, threadId: task.threadId, task };
  }
}

export function activePath(rows: readonly Message[], leaf: string | null): Message[] {
  const byId = new Map(rows.map((row) => [row.id, row])), path: Message[] = [], seen = new Set<string>();
  for (let row = leaf ? byId.get(leaf) : undefined; row && !seen.has(row.id); row = row.parentId ? byId.get(row.parentId) : undefined) {
    seen.add(row.id);
    path.push(row);
  }
  return path.reverse();
}

/** A conversation's own context summary describes the other computer's session, so it is not added to one both have. */
function withoutSummaries(thread: ThreadRows, have: ReadonlySet<string>): ThreadRows {
  const dropped = new Map(thread.rows.filter((row) => !have.has(row.id) && row.kind === "compaction").map((row) => [row.id, row.parentId ?? null]));
  if (!dropped.size) return thread;
  const above = (id: string | null) => { for (let hops = 0; id !== null && dropped.has(id) && hops <= dropped.size; hops++) id = dropped.get(id)!; return id; };
  return {
    rows: thread.rows.filter((row) => !dropped.has(row.id)).map((row) => row.parentId && dropped.has(row.parentId) ? { ...row, parentId: above(row.parentId) } : row),
    leaf: above(thread.leaf),
  };
}

/** A turn is a line a person (or a teammate) wrote and what answered it; a turn is never split. */
function turns(rows: readonly Message[]): Message[][] {
  const out: Message[][] = [];
  for (const row of rows) if (!out.length || row.role === "user") out.push([row]); else out.at(-1)!.push(row);
  return out;
}
function interleave(here: Message[][], added: Message[][]): Message[] {
  const out: Message[] = [];
  for (let i = 0, j = 0; i < here.length || j < added.length;) {
    out.push(...(j >= added.length || (i < here.length && here[i]![0]!.at <= added[j]![0]!.at) ? here[i++]! : added[j++]!));
  }
  return out;
}

/** Adds `from`'s rows `to` lacks; the ones on `from`'s visible path are placed among `to`'s by time, turn by turn. */
export function mergeThread(from: ThreadRows, to: ThreadRows): { added: Message[]; relinked: Link[]; leaf: string | null; synced: number } {
  const have = new Set(to.rows.map((row) => row.id));
  const synced = newest(from.rows.filter((row) => have.has(row.id)).map((row) => row.at));
  const source = withoutSummaries(from, have);
  const added = source.rows.filter((row) => !have.has(row.id));
  const unchanged = { added, relinked: [], leaf: to.leaf, synced };
  if (!added.length) return unchanged;
  const path = activePath(source.rows, source.leaf), first = path.findIndex((row) => !have.has(row.id));
  const fresh = first < 0 ? [] : path.slice(first);
  const fork = fresh[0]?.parentId ?? null, visible = activePath(to.rows, to.leaf);
  const after = fork === null ? 0 : visible.findIndex((row) => row.id === fork) + 1;
  // A path that continues a branch this server is not showing (or runs through rows it has again) stays that branch.
  if (!fresh.length || fresh.some((row) => have.has(row.id)) || (fork !== null && after === 0)) return unchanged;
  const placed = new Map<string, string | null>(), relinked: Link[] = [];
  let parent: string | null = fork;
  for (const row of interleave(turns(visible.slice(after)), turns(fresh))) {
    if (!have.has(row.id)) placed.set(row.id, parent);
    else if ((row.parentId ?? null) !== parent) relinked.push({ id: row.id, parentId: parent });
    parent = row.id;
  }
  return { added: added.map((row) => placed.has(row.id) ? { ...row, parentId: placed.get(row.id)! } : row), relinked, leaf: parent, synced };
}

function carriedTask(task: TaskRecord | GroupTaskRecord, owner: Owner, rows: readonly Message[], projects: ReadonlyArray<{ id: string }> | undefined): TaskRecord | GroupTaskRecord {
  const source = task as unknown as Record<string, unknown>;
  const kept = Object.fromEntries((owner.kind === "bot" ? BOT_TASK_KEYS : GROUP_TASK_KEYS)
    .filter((key) => source[key] !== undefined).map((key) => [key, structuredClone(source[key])]));
  const order = newest(rows.filter(movesThreadToTop).map((row) => row.turnCompletedAt ?? row.at));
  const stamps = { updatedAt: Math.max(task.createdAt, newest(rows.map((row) => row.at))), ...(Number.isFinite(order) ? { lastThreadOrderAt: order } : {}) };
  if (owner.kind === "group") return { ...kept, ...stamps } as unknown as GroupTaskRecord;
  const projectId = "projectId" in task && task.projectId && projects?.some((project) => project.id === task.projectId) ? { projectId: task.projectId } : {};
  return { ...kept, ...projectId, ...stamps, resumeCursors: {}, unread: false } as unknown as TaskRecord;
}

/**
 * A conversation `to` lacks is added unless `to` once had it: one with a message from before `syncedAt` (when the two were
 * last in step: the copy, or an earlier bring) or no newer than the newest message both share was there, so `to` deleted it since.
 */
export function planChatMerge(from: ChatsSide, to: ChatsSide, syncedAt = Number.NEGATIVE_INFINITY): ChatMergePlan {
  const owners = new Set([...to.bots.map((bot) => `bot:${bot.id}`), ...to.groups.map((group) => `group:${group.id}`)]);
  const homes = new Map<string, string>();
  for (const conversation of conversations(to)) homes.set(conversation.threadId, ownerKey(conversation.owner));
  const plan: ChatMergePlan = { threads: [], conversations: 0, messages: 0, intoExisting: 0, skippedBots: 0, skippedRooms: 0, deleted: 0 };
  const missing = new Set<string>(), fresh: Array<{ owner: Owner; threadId: string; task: TaskRecord | GroupTaskRecord; rows: ThreadRows }> = [];
  let synced = syncedAt;
  for (const { owner, threadId, task, dm } of conversations(from)) {
    const rows = from.thread(threadId);
    if (!rows.rows.length) continue;
    if (!owners.has(ownerKey(owner))) { if (!dm) missing.add(ownerKey(owner)); continue; }
    const home = homes.get(threadId);
    if (home === ownerKey(owner)) {
      const merged = mergeThread(rows, to.thread(threadId));
      synced = Math.max(synced, merged.synced);
      if (!merged.added.length) continue;
      plan.threads.push({ owner, threadId, added: merged.added, relinked: merged.relinked, leaf: merged.leaf });
      plan.intoExisting += textLines(merged.added);
    } else if (home === undefined && task && !to.thread(threadId).rows.length) fresh.push({ owner, threadId, task, rows });
  }
  for (const { owner, threadId, task, rows } of fresh) {
    if (rows.rows.some((row) => row.at <= synced)) { plan.deleted++; continue; }
    const projects = owner.kind === "bot" ? to.bots.find((bot) => bot.id === owner.id)?.projects : undefined;
    plan.threads.push({ owner, threadId, task: carriedTask(task, owner, rows.rows, projects), added: rows.rows, relinked: [], leaf: rows.leaf });
    plan.conversations++;
  }
  plan.messages = plan.threads.reduce((sum, thread) => sum + textLines(thread.added), 0);
  plan.skippedBots = [...missing].filter((key) => key.startsWith("bot:")).length;
  plan.skippedRooms = missing.size - plan.skippedBots;
  return plan;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const named = (value: unknown): boolean => record(value) && typeof value.id === "string" && typeof value.threadId === "string" &&
  (value.tasks === undefined || (Array.isArray(value.tasks) && value.tasks.every((task) => record(task) && typeof task.threadId === "string" && Number.isFinite(task.createdAt))));

/** The copy staged on this server, read only. */
export function stagedChats(data: string): ChatsSide & { close(): void } {
  const roster = (name: string): unknown[] => {
    try { const value: unknown = JSON.parse(readFileSync(join(data, name), "utf8")); return Array.isArray(value) ? value.filter(named) : []; } catch { return []; }
  };
  let db: DatabaseSync | null = null;
  try { if (lstatSync(join(data, "messages.db")).isFile()) db = new DatabaseSync(join(data, "messages.db"), { readOnly: true }); } catch {}
  const rowsOf = db?.prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid");
  const leafOf = db && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_state'").get()
    ? db.prepare("SELECT active_leaf_id AS leaf FROM thread_state WHERE thread_id = ?") : undefined;
  return {
    bots: roster("bots.json") as ChatsSide["bots"],
    groups: roster("groups.json") as ChatsSide["groups"],
    thread(threadId) {
      const rows: Message[] = [];
      let previous: string | null = null;
      for (const row of rowsOf?.all(threadId) ?? []) {
        let message: unknown;
        try { message = JSON.parse(String(row.json)); } catch { continue; }
        if (!record(message) || typeof message.id !== "string" || !Number.isFinite(message.at)) continue;
        if (message.parentId === undefined) message.parentId = previous;
        previous = message.id;
        rows.push(message as unknown as Message);
      }
      const stored = leafOf?.get(threadId)?.leaf;
      return { rows, leaf: typeof stored === "string" && rows.some((row) => row.id === stored) ? stored : rows.at(-1)?.id ?? null };
    },
    close: () => db?.close(),
  };
}

export function liveChats(store: ChatStore): ChatsSide {
  return { bots: store.bots, groups: store.groups, thread: (threadId) => ({ rows: store.messagesFor(threadId), leaf: store.activeLeaf(threadId) }) };
}

function attachmentNames(message: Message, source: string): string[] {
  const root = `${source.replaceAll("\\", "/").replace(/\/$/, "")}/attachments/`;
  const fold = (value: string) => /^(?:[A-Za-z]:\/|\/\/)/.test(root) ? value.toLowerCase() : value;
  const paths: unknown[] = Array.isArray(message.attachments) ? message.attachments.map((attachment) => (attachment as { path?: unknown } | null)?.path) : [];
  if (typeof message.text === "string" && message.text.includes("<attached-")) {
    const parsed = splitTranscriptAttachments(message.text, false);
    paths.push(...parsed.images.map((image) => image.path), ...parsed.files.map((file) => file.path));
  }
  return paths.flatMap((path) => {
    const value = typeof path === "string" ? path.replaceAll("\\", "/") : "";
    const name = fold(value.slice(0, root.length)) === fold(root) ? value.slice(root.length) : "";
    return ATTACHMENT_NAME.test(name) ? [name] : [];
  });
}

/** Never replaces a file already here: names are random, so one that exists is the same upload. */
function carryAttachment(data: string, dataDir: string, name: string): boolean {
  const from = join(data, "attachments", name);
  try { if (!lstatSync(from).isFile()) return false; } catch { return false; }
  mkdirSync(join(dataDir, "attachments"), { recursive: true, mode: 0o700 });
  try {
    copyFileSync(from, join(dataDir, "attachments", name), constants.COPYFILE_EXCL);
    chmodSync(join(dataDir, "attachments", name), 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Owners first, so a conversation's rows never exist without its entry in the list. */
export function applyChatMerge(store: ChatStore, plan: ChatMergePlan): void {
  const tasks = new Map<string, Array<TaskRecord | GroupTaskRecord>>();
  for (const thread of plan.threads) if (thread.task) tasks.set(ownerKey(thread.owner), [...tasks.get(ownerKey(thread.owner)) ?? [], thread.task]);
  for (const bot of store.bots) {
    const added = tasks.get(`bot:${bot.id}`);
    if (added) store.patchBot(bot.id, { tasks: [...bot.tasks ?? [], ...added as TaskRecord[]] });
  }
  for (const group of store.groups) {
    const added = tasks.get(`group:${group.id}`);
    if (added) { group.tasks = [...group.tasks ?? [], ...added as GroupTaskRecord[]]; store.patchGroup(group.id, {}); }
  }
  const touched = new Map<string, Owner>();
  for (const thread of plan.threads) {
    store.importTranscript(thread.threadId, thread.added, thread.leaf, thread.task ? undefined : thread.relinked);
    if (!thread.task) touched.set(ownerKey(thread.owner), thread.owner);
  }
  // Saves the conversations' new activity times and tells open apps about them; no message frame, so nothing is read aloud or notified.
  for (const owner of touched.values()) {
    if (owner.kind === "bot") store.patchBot(owner.id, {});
    else store.patchGroup(owner.id, {});
  }
}

export function mergeStagedChats(store: ChatStore, dataDir: string, staged: { data: string; sourceDataDir: string }, syncedAt?: number): ChatMergeResult {
  const from = stagedChats(staged.data);
  try {
    const plan = planChatMerge(from, liveChats(store), syncedAt);
    const destination = resolve(dataDir), paths = restorePaths(staged.sourceDataDir, destination);
    let copied = false;
    for (const thread of plan.threads) for (const message of thread.added) {
      for (const name of attachmentNames(message, staged.sourceDataDir)) copied = carryAttachment(staged.data, dataDir, name) || copied;
      if (staged.sourceDataDir !== destination) paths.message(message);
    }
    if (copied) cleanupStaleAttachmentPartials();
    applyChatMerge(store, plan);
    const { threads: _threads, ...result } = plan;
    return result;
  } finally { from.close(); }
}
