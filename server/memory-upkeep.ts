import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { CaptureBuffer, captureItemLimit, capturePrompt, captureSize, newCandidates, parseCandidates, worthCapturing, type Candidate, type CaptureBatch, type CaptureTurn } from "./memory-capture.ts";
import { factIdentity, lineFactIdentity, notebookIdentities } from "./memory-entries.ts";
import { mergeTopicText } from "./memory-topics.ts";
import { applyMoves, MAX_MOVES, organizeCandidates, organizePrompt, parseMoves } from "./memory-organize.ts";
import { recordMemoryChange } from "./memory-journal.ts";
import { applyTidy, contradictionCandidates, contradictionPrompt, parseContradictions, planChanges, planTidy, type Contradiction } from "./memory-tidy.ts";
import { appendMemoryArchive, ARCHIVE_TOPIC, ensureWorkspace, listMemoryTopics, memoryDate, memoryEntry, memoryTopicIndex, readMemoryText, updateMemory, workspaceDir, writeMemoryFile, writeMemoryTopic } from "./workspace.ts";

export const CAPTURE_MAX_TURNS = 6;
/** One capture call reads at most this much of one bot's waiting chats; the rest wait for the next call. */
export const CAPTURE_CALL_MAX_TURNS = 2 * CAPTURE_MAX_TURNS;
export const CAPTURE_CALL_MAX_BYTES = 24_000;
/** A chat that goes quiet takes along its bot's other chats that would go quiet within this long. */
export const CAPTURE_GATHER_MS = 15_000;
export const MODEL_TIMEOUT_MS = 60_000;
export const MAX_TOPIC_CHECKS = 4;
export const TIDY_CHECK_MS = 10 * 60_000;
export const MIN_ENTRIES_FOR_CONTRADICTIONS = 5;
const ARCHIVE_PATH = `memory/${ARCHIVE_TOPIC}`;
export const MAX_PENDING_THREADS = 50;
export const TOPIC_MAX_BYTES = 64 * 1024;

export interface UpkeepEngine {
  generateText?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<string>;
}

export interface UpkeepBot {
  id: string;
  name: string;
  memoryUpkeep?: boolean;
  memoryEnabled?: boolean;
}

export function upkeepEnabled(bot: Pick<UpkeepBot, "memoryUpkeep" | "memoryEnabled"> | undefined): bot is UpkeepBot {
  return Boolean(bot) && bot!.memoryUpkeep !== false && bot!.memoryEnabled !== false;
}

export interface UpkeepDeps {
  bots: () => readonly UpkeepBot[];
  bot: (id: string) => UpkeepBot | undefined;
  engine: (botId: string) => UpkeepEngine | null;
  busy: (botId: string) => boolean;
  addToAboutMe: (from: { botId: string; botName: string }, texts: readonly string[]) => number;
  sourceLabel: (botId: string, threadId: string) => string;
  /** Asked again at capture, so a turn queued before a visibility change is dropped. */
  mayCapture?: (botId: string, threadId: string) => boolean;
  restoreTurn?: (botId: string, threadId: string, turnId: string) => CaptureTurn | null;
  quietMs: () => number;
  tidyHour: () => number;
  /** Fresh scoped-lease check immediately before each synchronous upkeep persistence burst. */
  beforeWrite?: () => Promise<void>;
  /** Wrap each synchronous burst of memory writes for a bot (Cloud homes use this in lending-memory.ts). */
  writing?: <T>(botId: string, write: () => T) => T;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface TidyReport {
  at: number;
  expired: number;
  duplicates: number;
  superseded: number;
  deferred: number;
  organized?: number;
  contradictionsChecked: boolean;
  topicChecks?: number;
  topicsDeferred?: number;
  note?: string;
}

export interface CaptureReport {
  at: number;
  added: number;
  topics: number;
  aboutMe: number;
  organized?: number;
  note?: string;
}

interface UpkeepState {
  bots: Record<string, { lastTidy?: TidyReport; lastCapture?: CaptureReport; core?: string[]; topicCursor?: string }>;
}

class ScopedWriteGateBlocked extends Error {
  constructor() {
    super("the scoped broker refused this write");
    this.name = "ScopedWriteGateBlocked";
  }
}

/** How many "this entry is core" judgements are remembered per bot. */
const MAX_CORE = 500;

function statePath(): string {
  return join(DATA_DIR, "memory-upkeep.json");
}

function loadState(): UpkeepState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as UpkeepState;
    return parsed && typeof parsed.bots === "object" && parsed.bots ? parsed : { bots: {} };
  } catch {
    return { bots: {} };
  }
}

function saveState(state: UpkeepState): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileAtomic(statePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch {
  }
}

interface PendingCapture {
  batches: { botId: string; threadId: string; turnIds: string[] }[];
}

function pendingPath(): string {
  return join(DATA_DIR, "memory-capture-pending.json");
}

function savePending(batches: readonly CaptureBatch[]): void {
  const byThread = new Map<string, { botId: string; threadId: string; turnIds: string[] }>();
  for (const batch of batches) {
    const ids = batch.turns.map((turn) => turn.turnId).filter((id): id is string => typeof id === "string" && id.length > 0);
    if (!ids.length) continue;
    const key = `${batch.botId}\n${batch.threadId}`;
    const entry = byThread.get(key) ?? { botId: batch.botId, threadId: batch.threadId, turnIds: [] };
    entry.turnIds.push(...ids.filter((id) => !entry.turnIds.includes(id)));
    byThread.set(key, entry);
  }
  if (!byThread.size) return;
  const state: PendingCapture = {
    batches: [...byThread.values()].slice(-MAX_PENDING_THREADS).map((entry) => ({ ...entry, turnIds: entry.turnIds.slice(-CAPTURE_MAX_TURNS) })),
  };
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileAtomic(pendingPath(), `${JSON.stringify(state)}\n`, { mode: 0o600 });
  } catch {
  }
}

/** Removed before replay, so a start that fails part way never replays them twice. */
function takePending(): PendingCapture["batches"] {
  let raw: string;
  try {
    raw = readFileSync(pendingPath(), "utf8");
  } catch {
    return [];
  }
  rmSync(pendingPath(), { force: true });
  try {
    const parsed = JSON.parse(raw) as Partial<PendingCapture>;
    if (!Array.isArray(parsed?.batches)) return [];
    return parsed.batches
      .filter((batch) => batch && typeof batch.botId === "string" && typeof batch.threadId === "string" && Array.isArray(batch.turnIds))
      .slice(-MAX_PENDING_THREADS)
      .map((batch) => ({ botId: batch.botId, threadId: batch.threadId, turnIds: batch.turnIds.filter((id): id is string => typeof id === "string").slice(-CAPTURE_MAX_TURNS) }));
  } catch {
    return [];
  }
}

function dropPending(botId: string): void {
  let parsed: Partial<PendingCapture>;
  try {
    parsed = JSON.parse(readFileSync(pendingPath(), "utf8")) as Partial<PendingCapture>;
  } catch {
    return;
  }
  if (!Array.isArray(parsed?.batches)) return;
  const kept = parsed.batches.filter((batch) => batch?.botId !== botId);
  if (kept.length === parsed.batches.length) return;
  try {
    if (kept.length) writeFileAtomic(pendingPath(), `${JSON.stringify({ batches: kept })}\n`, { mode: 0o600 });
    else rmSync(pendingPath(), { force: true });
  } catch {
    // best effort: a deleted bot's saved turns are refused at capture anyway
  }
}

function readRaw(botId: string, relative: string): string | null {
  try {
    return readMemoryText(join(workspaceDir(botId), relative));
  } catch {
    return null;
  }
}

async function askModel(engine: UpkeepEngine, prompt: string, timeoutMs = MODEL_TIMEOUT_MS): Promise<string | null> {
  if (!engine.generateText) return null;
  const expiry = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException("The background model call timed out.", "TimeoutError");
      expiry.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    const answer = await Promise.race([engine.generateText(prompt, { signal: expiry.signal }), expired]);
    return typeof answer === "string" ? answer : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A flushed chat waiting for its capture call; `done` answers a caller of `capture`. */
interface Waiting {
  batch: CaptureBatch;
  done?: { resolve: (report: CaptureReport) => void; reject: (error: unknown) => void };
}

function callBytes(batch: CaptureBatch): number {
  const { said, replied } = captureSize(batch.turns);
  return said + replied;
}

function hasPersonalStatement(turns: readonly CaptureTurn[]): boolean {
  return turns.some((turn) => {
    const lines = turn.room ? turn.room.filter((line) => line.by === "person").map((line) => line.text) : [turn.person];
    return lines.some((line) => /\b(?:i|we|my|our)\b|\b(?:am|has|have|is|like|likes|live|lives|need|needs|prefer|prefers|use|uses|work|works)\b/i.test(line));
  });
}

export const NO_TEXT_ENGINE = "This bot's engine cannot make the quick background model call upkeep uses, so only expired notes and exact duplicates are tidied.";

export interface MemoryUpkeep {
  noteTurn(botId: string, threadId: string, turn: CaptureTurn): void;
  flushThread(threadId: string): void;
  dropBot(botId: string): void;
  /** Run a capture batch; resolves with counts and a note when a scoped gate blocks later writes. */
  forgetBot(botId: string): void;
  capture(batch: CaptureBatch): Promise<CaptureReport>;
  tidy(botId: string): Promise<TidyReport>;
  status(botId: string): { lastTidy?: TidyReport; lastCapture?: CaptureReport; modelSteps: boolean };
  tick(): Promise<void>;
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  idle(): Promise<void>;
}

export function createMemoryUpkeep(deps: UpkeepDeps): MemoryUpkeep {
  const now = () => deps.now?.() ?? new Date();
  const log = (line: string) => deps.log?.(line);
  const inflight = new Set<Promise<unknown>>();
  const tidying = new Map<string, Promise<TidyReport>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let paused = false;
  // Flushed chats wait here, also through a backup; one worker drains it, one capture call at a time.
  const queue: Waiting[] = [];
  let worker: Promise<void> | null = null;
  // Keep truthful partial outcomes visible when the scoped gate blocks a later write.
  const partialCaptureReports = new Map<string, CaptureReport>();
  const partialTidyReports = new Map<string, TidyReport>();
  // Avoid automatically replaying a partially applied tidy for the same bot/date.
  const autoTidyBlockedDay = new Map<string, string>();

  const beforeWrite = deps.beforeWrite;
  const checkWriteGate = async () => {
    try {
      await beforeWrite?.();
    } catch {
      throw new ScopedWriteGateBlocked();
    }
  };
  const suppressAutoTidyToday = (botId: string) => autoTidyBlockedDay.set(botId, memoryDate(now()));
  const rememberPartialCapture = (botId: string, report: CaptureReport) => {
    partialCaptureReports.set(botId, report);
    return report;
  };
  const rememberPartialTidy = (botId: string, report: TidyReport) => {
    partialTidyReports.set(botId, report);
    return report;
  };
  const appendTidyNote = (report: TidyReport, extra: string): TidyReport => ({
    ...report,
    note: [report.note, extra].filter(Boolean).join(" "),
  });

  const record = async (botId: string, patch: { lastTidy?: TidyReport; lastCapture?: CaptureReport; topicCursor?: string }): Promise<boolean> => {
    if (beforeWrite) {
      await checkWriteGate();
      if (paused) return false;
    }
    // A capture or tidy that was out when its bot was deleted leaves nothing behind.
    if (!deps.bot(botId)) return false;
    const state = loadState();
    state.bots[botId] = { ...state.bots[botId], ...patch };
    saveState(state);
    if (patch.lastCapture) partialCaptureReports.delete(botId);
    if (patch.lastTidy) partialTidyReports.delete(botId);
    return true;
  };

  const track = <T>(promise: Promise<T>): Promise<T> => {
    inflight.add(promise);
    void promise.finally(() => inflight.delete(promise)).catch(() => undefined);
    return promise;
  };

  const writing = deps.writing ?? (<T>(_botId: string, write: () => T): T => write());

  /** Files one conversation's items as that conversation's: its source label, its thread on every journal row. */
  function fileCandidates(botId: string, threadId: string, candidates: readonly Candidate[]): { added: number; topics: number } {
    const before = readRaw(botId, "MEMORY.md");
    const archiveBefore = readRaw(botId, ARCHIVE_PATH);
    const fresh = newCandidates(candidates, before ?? "");
    const source = `${deps.sourceLabel(botId, threadId)} (noticed)`;
    let added = 0;
    const byTopic = new Map<string, Candidate[]>();
    for (const candidate of fresh) {
      if (candidate.topic) {
        byTopic.set(candidate.topic, [...(byTopic.get(candidate.topic) ?? []), candidate]);
        continue;
      }
      if (updateMemory(botId, { action: "append", text: candidate.text, ...(candidate.until ? { until: candidate.until } : {}) }, { source, now: now() }).ok) added += 1;
    }
    // The archive is journaled before MEMORY.md, so undoing the newest row brings moved entries back.
    recordMemoryChange(botId, { path: ARCHIVE_PATH, actor: "upkeep", via: "capture", threadId, before: archiveBefore, after: readRaw(botId, ARCHIVE_PATH) });
    if (added) recordMemoryChange(botId, { path: "MEMORY.md", actor: "upkeep", via: "capture", threadId, before, after: readRaw(botId, "MEMORY.md") });
    const existing = new Map(listMemoryTopics(botId).map((topic) => [topic.name.toLowerCase(), topic.name]));
    let topics = 0;
    for (const [wanted, group] of byTopic) {
      const name = existing.get(wanted) ?? wanted;
      const path = `memory/${name}`;
      const current = readRaw(botId, path);
      if (current !== null && Buffer.byteLength(current, "utf8") > TOPIC_MAX_BYTES) continue;
      const seen = notebookIdentities(current ?? "");
      const lines = group
        .filter((candidate) => !seen.has(factIdentity(candidate.text)))
        .map((candidate) => memoryEntry(candidate.text, { source, now: now(), ...(candidate.until ? { until: candidate.until } : {}) }));
      if (!lines.length) continue;
      const title = name.replace(/\.md$/, "").replace(/-/g, " ");
      const aliases = [...new Set(group.flatMap((candidate) => candidate.topicAliases ?? []))];
      try {
        writeMemoryTopic(botId, name, mergeTopicText(current, { title, aliases, lines }));
      } catch {
        continue;
      }
      recordMemoryChange(botId, { path, actor: "upkeep", via: "capture", threadId, before: current, after: readRaw(botId, path) });
      existing.set(name.toLowerCase(), name);
      topics += lines.length;
    }
    return { added, topics };
  }

  /**
   * Which conversation each item came from. With several in one call and no valid "from", the guess is the
   * one with the most said, and a guess is used only where it cannot matter: the item is kept only if every
   * conversation still feeds memory, and reaches About me only if every one is the owner's own.
   */
  function attribute(candidates: readonly Candidate[], conversations: readonly CaptureBatch[], still: readonly boolean[]) {
    const owner = conversations.map((conversation) => conversation.turns.every((turn) => turn.owner !== false));
    const sizes = conversations.map((conversation) => captureSize(conversation.turns).said);
    const guess = sizes.indexOf(Math.max(...sizes));
    return candidates.flatMap((candidate) => {
      const named = conversations.length === 1 ? 0 : candidate.from !== undefined && candidate.from <= conversations.length ? candidate.from - 1 : -1;
      const sure = named >= 0;
      const at = sure ? named : guess;
      if (!still[at] || (!sure && !still.every(Boolean))) return [];
      // Only the owner's own words reach About me: another person's facts are not the owner's profile.
      return [{ candidate, at, aboutMe: candidate.aboutUser && owner[at]! && (sure || owner.every(Boolean)) }];
    });
  }

  /** One model call for one bot's waiting chats, each read as its own conversation. */
  async function captureCall(batches: readonly CaptureBatch[]): Promise<CaptureReport> {
    const bot = deps.bot(batches[0]!.botId);
    const at = now().getTime();
    const off: CaptureReport = { at, added: 0, topics: 0, aboutMe: 0, note: "upkeep is off" };
    if (!upkeepEnabled(bot)) return off;
    const byThread = new Map<string, CaptureBatch>();
    for (const batch of batches) {
      const same = byThread.get(batch.threadId);
      if (same) same.turns.push(...batch.turns);
      else byThread.set(batch.threadId, { ...batch, turns: [...batch.turns] });
    }
    const allowed = (threadId: string) => deps.mayCapture?.(bot.id, threadId) ?? true;
    const refused: CaptureReport = { at, added: 0, topics: 0, aboutMe: 0, note: "this conversation no longer feeds the bot's memory" };
    const conversations = [...byThread.values()].filter((conversation) => allowed(conversation.threadId));
    if (!conversations.length) return refused;
    const engine = deps.engine(bot.id);
    if (!engine?.generateText) {
      const report = { at, added: 0, topics: 0, aboutMe: 0, note: NO_TEXT_ENGINE };
      await record(bot.id, { lastCapture: report });
      return report;
    }
    ensureWorkspace(bot.id);
    const today = memoryDate(now());
    const answer = await askModel(engine, capturePrompt({
      botName: bot.name,
      conversations: conversations.map((conversation) => conversation.turns),
      notebook: readRaw(bot.id, "MEMORY.md") ?? "",
      today,
      topics: memoryTopicIndex(bot.id),
    }));
    if (answer === null) {
      const report = { at, added: 0, topics: 0, aboutMe: 0, note: "The capture call did not answer in time." };
      await record(bot.id, { lastCapture: report });
      return report;
    }
    if (paused) {
      queue.unshift(...conversations.map((batch) => ({ batch })));
      return { at, added: 0, topics: 0, aboutMe: 0, note: "deferred until the backup finishes" };
    }
    // The broker check can yield. Recheck upkeep state and conversation scope
    // afterwards, then keep each memory-file burst synchronous with its journal rows.
    if (!upkeepEnabled(deps.bot(bot.id))) return off;
    const parsed = parseCandidates(answer, today, captureItemLimit(conversations.length));
    if (beforeWrite) await checkWriteGate();
    if (paused || !upkeepEnabled(deps.bot(bot.id))) return off;
    const still = conversations.map((conversation) => allowed(conversation.threadId));
    if (!still.some(Boolean)) return refused;
    const filed = attribute(parsed, conversations, still);
    const { added, topics } = writing(bot.id, () => {
      let added = 0;
      let topics = 0;
      conversations.forEach((conversation, i) => {
        const own = filed.filter((item) => item.at === i).map((item) => item.candidate);
        if (!own.length) return;
        const result = fileCandidates(bot.id, conversation.threadId, own);
        added += result.added;
        topics += result.topics;
      });
      return { added, topics };
    });
    // Only attributed owner facts reach About me; room facts from another
    // person must never become the workspace owner's profile.
    const learned = filed.filter((item) => item.aboutMe).map((item) => item.candidate.text);
    let aboutMe = 0;
    const partialCapture = (note: string, organized?: number): CaptureReport => ({
      at, added, topics, aboutMe, ...(organized !== undefined ? { organized } : {}), note,
    });
    if (learned.length) {
      if (beforeWrite) {
        try {
          await checkWriteGate();
        } catch (error) {
          if (error instanceof ScopedWriteGateBlocked) return rememberPartialCapture(bot.id, partialCapture(`Capture saved ${added} notebook fact(s) and ${topics} topic fact(s), but About me was not updated because the scoped write gate refused it. This memory-upkeep instance will not retry this batch automatically.`));
          throw error;
        }
      }
      if (paused || !upkeepEnabled(deps.bot(bot.id))) return rememberPartialCapture(bot.id, partialCapture("Notebook changes were saved, but About me was not updated because upkeep paused or was disabled. This memory-upkeep instance will not retry this batch automatically."));
      aboutMe = deps.addToAboutMe({ botId: bot.id, botName: bot.name }, learned);
    }
    let organized: number;
    try {
      organized = await organize(bot.id);
    } catch (error) {
      if (error instanceof ScopedWriteGateBlocked) return rememberPartialCapture(bot.id, partialCapture(`Capture saved ${added} notebook fact(s), ${topics} topic fact(s), and ${aboutMe} About me fact(s); organization was blocked by the scoped write gate. This memory-upkeep instance will not retry this batch automatically.`, 0));
      throw error;
    }
    const report: CaptureReport = { at, added, topics, aboutMe, organized };
    let recorded: boolean;
    try {
      recorded = await record(bot.id, { lastCapture: report });
    } catch (error) {
      if (error instanceof ScopedWriteGateBlocked) return rememberPartialCapture(bot.id, { ...report, note: `Capture completed with ${added} notebook fact(s), ${topics} topic fact(s), and ${aboutMe} About me fact(s); upkeep status was not recorded because the scoped write gate refused it. This memory-upkeep instance will not retry this batch automatically.` });
      throw error;
    }
    if (!recorded) return rememberPartialCapture(bot.id, { ...report, note: `Capture completed with ${added} notebook fact(s), ${topics} topic fact(s), and ${aboutMe} About me fact(s); upkeep status was not recorded because upkeep paused or the bot was removed. This memory-upkeep instance will not retry this batch automatically.` });
    if (added || topics || aboutMe) log(`memory upkeep: noticed ${added} fact(s) for MEMORY.md, ${topics} for topic files and ${aboutMe} for About me — ${bot.name} (${bot.id}) from ${conversations.map((conversation) => conversation.threadId).join(", ")}`);
    return report;
  }

  /** The first waiting batch, with its bot's other waiting batches that fit in the same call. */
  function takeCall(): Waiting[] {
    const first = queue.shift()!;
    const call = [first];
    let turns = first.batch.turns.length;
    let bytes = callBytes(first.batch);
    for (let i = 0; i < queue.length;) {
      const next = queue[i]!;
      const size = callBytes(next.batch);
      if (next.batch.botId === first.batch.botId && turns + next.batch.turns.length <= CAPTURE_CALL_MAX_TURNS && bytes + size <= CAPTURE_CALL_MAX_BYTES) {
        call.push(...queue.splice(i, 1));
        turns += next.batch.turns.length;
        bytes += size;
      } else i += 1;
    }
    return call;
  }

  async function work(): Promise<void> {
    try {
      // chats flushed together are all queued before the first call takes its share
      await Promise.resolve();
      while (!paused && queue.length) {
        const call = takeCall();
        try {
          const report = await captureCall(call.map((entry) => entry.batch));
          if (partialCaptureReports.get(call[0]!.batch.botId) === report) log(`memory upkeep: capture outcome for ${call[0]!.batch.botId} — ${report.added} notebook fact(s), ${report.topics} topic fact(s), ${report.aboutMe} About me fact(s): ${report.note}`);
          for (const entry of call) entry.done?.resolve(report);
        } catch (error) {
          log(`memory upkeep: capture failed for ${call[0]!.batch.botId}: ${(error as Error).message}`);
          for (const entry of call) entry.done?.reject(error);
        }
      }
    } finally {
      worker = null;
    }
  }

  function kick(): void {
    if (!worker && !paused && queue.length) worker = track(work());
  }

  function enqueue(entry: Waiting): void {
    queue.push(entry);
    kick();
  }

  function dropQueued(botId: string): void {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i]!.batch.botId !== botId) continue;
      const [entry] = queue.splice(i, 1);
      entry!.done?.resolve({ at: now().getTime(), added: 0, topics: 0, aboutMe: 0, note: "upkeep is off" });
    }
  }

  const buffer = new CaptureBuffer({
    quietMs: deps.quietMs,
    maxTurns: CAPTURE_MAX_TURNS,
    gatherMs: CAPTURE_GATHER_MS,
    onFlush: (batch) => {
      // Skip tiny exchanges unless the person made a possible personal statement.
      if (worthCapturing(batch.turns) || hasPersonalStatement(batch.turns)) enqueue({ batch });
    },
  });

  async function organize(botId: string): Promise<number> {
    const engine = deps.engine(botId);
    if (!engine?.generateText) return 0;
    const today = memoryDate(now());
    const state = loadState();
    const core = new Set(state.bots[botId]?.core ?? []);
    const first = readRaw(botId, "MEMORY.md") ?? "";
    const candidates = organizeCandidates(first, today, core);
    if (!candidates.length) return 0;
    const answer = await askModel(engine, organizePrompt(candidates, memoryTopicIndex(botId)));
    if (answer === null || paused || !upkeepEnabled(deps.bot(botId))) return 0;
    const before = readRaw(botId, "MEMORY.md") ?? "";
    if (before !== first) return 0;
    const proposed = parseMoves(answer, candidates);
    if (proposed === null) return 0;
    const moved = new Set(proposed.map((move) => move.entry.line));
    const moves = proposed.slice(0, MAX_MOVES);
    const judgedCore = candidates.filter((entry) => !moved.has(entry.line)).map((entry) => factIdentity(entry.body));
    if (beforeWrite) {
      await checkWriteGate();
      if (paused || !upkeepEnabled(deps.bot(botId)) || (readRaw(botId, "MEMORY.md") ?? "") !== first) return 0;
    }
    const saved = loadState();
    saved.bots[botId] = { ...saved.bots[botId], core: [...new Set([...(saved.bots[botId]?.core ?? []), ...judgedCore])].slice(-MAX_CORE) };
    saveState(saved);
    if (!moves.length) return 0;
    if (beforeWrite) {
      await checkWriteGate();
      if (paused || !upkeepEnabled(deps.bot(botId)) || (readRaw(botId, "MEMORY.md") ?? "") !== first) return 0;
    }
    return writing(botId, () => {
      const { byTopic } = applyMoves(before, moves);
      const written = new Set<string>();
      const existing = new Map(listMemoryTopics(botId).map((topic) => [topic.name.toLowerCase(), topic.name]));
      let count = 0;
      for (const [wanted, group] of byTopic) {
        const name = existing.get(wanted) ?? wanted;
        const path = `memory/${name}`;
        const current = readRaw(botId, path);
        const seen = notebookIdentities(current ?? "");
        const lines = group.lines.filter((line) => !seen.has(lineFactIdentity(line)));
        if (lines.length) {
          try {
            writeMemoryTopic(botId, name, mergeTopicText(current, { title: name.replace(/\.md$/, "").replace(/-/g, " "), aliases: group.aliases, lines }));
          } catch (error) {
            log(`memory upkeep: could not write ${path}; kept its entries in MEMORY.md: ${(error as Error).message}`);
            continue;
          }
          recordMemoryChange(botId, { path, actor: "upkeep", via: "organize", before: current, after: readRaw(botId, path) });
        }
        existing.set(name.toLowerCase(), name);
        written.add(wanted);
        count += group.lines.length;
      }
      if (!written.size) return 0;
      const { text } = applyMoves(before, moves.filter((move) => written.has(move.topic)));
      writeMemoryFile(botId, text);
      recordMemoryChange(botId, { path: "MEMORY.md", actor: "upkeep", via: "organize", before, after: readRaw(botId, "MEMORY.md") });
      log(`memory upkeep: moved ${count} entr${count === 1 ? "y" : "ies"} from MEMORY.md into topic files for ${deps.bot(botId)?.name ?? botId}`);
      return count;
    });
  }

  function appendArchive(botId: string, archived: readonly string[]): void {
    const archiveBefore = readRaw(botId, ARCHIVE_PATH);
    appendMemoryArchive(botId, archived);
    recordMemoryChange(botId, { path: ARCHIVE_PATH, actor: "upkeep", via: "tidy", before: archiveBefore, after: readRaw(botId, ARCHIVE_PATH) });
  }

  async function runTidy(botId: string): Promise<TidyReport> {
    const bot = deps.bot(botId);
    const at = now().getTime();
    const today = memoryDate(now());
    const stopped: TidyReport = { at, expired: 0, duplicates: 0, superseded: 0, deferred: 0, contradictionsChecked: false, note: "Memory upkeep is off or paused; no further changes were made." };
    if (paused || !upkeepEnabled(bot)) return stopped;
    ensureWorkspace(botId);
    let organized: number;
    try {
      organized = await organize(botId);
    } catch (error) {
      if (error instanceof ScopedWriteGateBlocked) {
        suppressAutoTidyToday(botId);
        return rememberPartialTidy(botId, { ...stopped, note: "Organization was blocked by the scoped write gate; no tidy changes followed. Automatic tidy is suppressed for the rest of this process today." });
      }
      throw error;
    }
    const stoppedAfterOrganization = (): TidyReport => {
      if (!beforeWrite || !organized) return stopped;
      return rememberPartialTidy(botId, {
        ...stopped,
        organized,
        note: "Organization completed, but the tidy step was skipped because upkeep paused or was disabled. No further tidy writes were made.",
      });
    };
    if (paused || !upkeepEnabled(deps.bot(botId))) return stoppedAfterOrganization();
    const first = readRaw(botId, "MEMORY.md") ?? "";
    const engine = deps.engine(botId);
    const candidates = contradictionCandidates(first, today);
    let contradictions: Contradiction[] = [];
    let contradictionsChecked = false;
    let note: string | undefined;
    if (!engine?.generateText) note = NO_TEXT_ENGINE;
    else if (candidates.length < MIN_ENTRIES_FOR_CONTRADICTIONS) note = `Contradictions are checked from ${MIN_ENTRIES_FOR_CONTRADICTIONS} notes on.`;
    else {
      const answer = await askModel(engine, contradictionPrompt(candidates));
      if (answer === null) note = "The contradiction check did not answer in time.";
      else {
        contradictions = parseContradictions(answer, candidates.length);
        contradictionsChecked = true;
      }
    }
    if (paused || !upkeepEnabled(deps.bot(botId))) return stoppedAfterOrganization();
    // Re-read after the await. If the notes changed meanwhile, the model's
    // line numbers no longer point at the same facts: keep only the
    // deterministic steps this time.
    const before = readRaw(botId, "MEMORY.md") ?? "";
    if (before !== first && contradictions.length) {
      contradictions = [];
      note = "The notes changed during the check; contradictions wait for the next tidy-up.";
    }
    const plan = planTidy(before, today, contradictions);
    if (planChanges(plan)) {
      const { text, archived } = applyTidy(before, plan, today);
      // The archive is written first: a line is never out of MEMORY.md before it is in the archive.
      if (beforeWrite) {
        try {
          await checkWriteGate();
        } catch (error) {
          if (error instanceof ScopedWriteGateBlocked) {
            suppressAutoTidyToday(botId);
            return rememberPartialTidy(botId, { ...stopped, ...(organized ? { organized } : {}), note: "The scoped write gate blocked tidy changes; any organization reported above remains saved. Automatic tidy is suppressed for the rest of this process today." });
          }
          throw error;
        }
        if (paused || !upkeepEnabled(deps.bot(botId))) return { ...stopped, ...(organized ? { organized } : {}) };
        if ((readRaw(botId, "MEMORY.md") ?? "") !== before) return { ...stopped, ...(organized ? { organized } : {}), note: "Memory changed while waiting for the write gate; this tidy pass made no further changes." };
      }
      writing(botId, () => {
        if (archived.length) appendArchive(botId, archived);
        writeMemoryFile(botId, text);
      });
      recordMemoryChange(botId, { path: "MEMORY.md", actor: "upkeep", via: "tidy", before, after: readRaw(botId, "MEMORY.md") });
    }
    let topicExpired = 0;
    let topicDuplicates = 0;
    let stoppedByGate = false;
    let topicSuperseded = 0;
    let topicDeferred = 0;
    let topicChecks = 0;
    let topicsDeferred = 0;
    let topicCursor = loadState().bots[botId]?.topicCursor;
    const deadline = Date.now() + MODEL_TIMEOUT_MS;
    const topics = listMemoryTopics(botId).filter(topic => topic.name !== ARCHIVE_TOPIC).sort((a, b) => a.name.localeCompare(b.name));
    const cursorAt = topics.findIndex(topic => topic.name === topicCursor) + 1;
    for (const topic of [...topics.slice(cursorAt), ...topics.slice(0, cursorAt)]) {
      const path = `memory/${topic.name}`;
      const topicBefore = readRaw(botId, path);
      if (topicBefore === null) continue;
      const topicCandidates = contradictionCandidates(topicBefore, today);
      let topicContradictions: Contradiction[] = [];
      if (engine?.generateText && topicCandidates.length >= 2) {
        const remaining = deadline - Date.now();
        if (topicChecks >= MAX_TOPIC_CHECKS || remaining <= 0) topicsDeferred++;
        else {
          topicChecks++;
          topicCursor = topic.name;
          const answer = await askModel(engine, contradictionPrompt(topicCandidates), remaining);
          if (paused || !upkeepEnabled(deps.bot(botId))) return stoppedAfterOrganization();
          if (readRaw(botId, path) !== topicBefore) {
            topicsDeferred++;
            continue;
          }
          if (answer !== null) {
            topicContradictions = parseContradictions(answer, topicCandidates.length);
            contradictionsChecked = true;
            if (note?.startsWith("Contradictions are checked from")) note = undefined;
          } else topicsDeferred++;
        }
      }
      const topicPlan = planTidy(topicBefore, today, topicContradictions, 1);
      topicSuperseded += topicPlan.superseded.length;
      topicDeferred += topicPlan.deferred;
      if (!planChanges(topicPlan)) continue;
      const tidied = applyTidy(topicBefore, topicPlan, today);
      if (beforeWrite) {
        try {
          await checkWriteGate();
        } catch (error) {
          if (error instanceof ScopedWriteGateBlocked) {
            suppressAutoTidyToday(botId);
            stoppedByGate = true;
            break;
          }
          throw error;
        }
        if (paused || !upkeepEnabled(deps.bot(botId))) break;
        if ((readRaw(botId, path) ?? "") !== topicBefore) continue;
      }
      writing(botId, () => {
        if (tidied.archived.length) appendArchive(botId, tidied.archived);
        writeMemoryTopic(botId, topic.name, tidied.text);
      });
      recordMemoryChange(botId, { path, actor: "upkeep", via: "tidy", before: topicBefore, after: readRaw(botId, path) });
      topicExpired += topicPlan.expired.length;
      topicDuplicates += topicPlan.duplicates.length;
    }
    if (topicsDeferred) note = [note, `${topicsDeferred} topic checks deferred because of the budget, a timeout or concurrent edits.`].filter(Boolean).join(" ");
    const report: TidyReport = {
      at,
      expired: plan.expired.length + topicExpired,
      duplicates: plan.duplicates.length + topicDuplicates,
      superseded: plan.superseded.length + topicSuperseded,
      deferred: plan.deferred + topicDeferred,
      ...(organized ? { organized } : {}),
      contradictionsChecked,
      topicChecks,
      topicsDeferred,
      ...(note ? { note } : {}),
      ...(stoppedByGate ? { note: [note, "The scoped write gate stopped later topic tidy writes; earlier tidy changes remain saved. Automatic tidy is suppressed for the rest of this process today."].filter(Boolean).join(" ") } : {}),
    };
    let recorded: boolean;
    try {
      recorded = await record(botId, { lastTidy: report, topicCursor });
    } catch (error) {
      if (error instanceof ScopedWriteGateBlocked) {
        suppressAutoTidyToday(botId);
        return rememberPartialTidy(botId, appendTidyNote(report, "Tidy changes shown above were saved, but upkeep status was not recorded because the scoped write gate refused it. Automatic tidy is suppressed for the rest of this process today."));
      }
      throw error;
    }
    if (!recorded) {
      suppressAutoTidyToday(botId);
      return rememberPartialTidy(botId, appendTidyNote(report, "Tidy changes shown above were saved, but upkeep status was not recorded because upkeep paused or the bot was removed. Automatic tidy is suppressed for the rest of this process today."));
    }
    if (report.expired || report.duplicates || report.superseded || organized) log(`memory upkeep: tidied ${bot?.name ?? botId} — ${report.expired} expired, ${report.duplicates} duplicate(s), ${report.superseded} contradicted`);
    return report;
  }

  function tidy(botId: string): Promise<TidyReport> {
    const running = tidying.get(botId);
    if (running) return running;
    const promise = track(runTidy(botId)).finally(() => tidying.delete(botId));
    tidying.set(botId, promise);
    return promise;
  }

  function due(botId: string): boolean {
    const current = now();
    if (current.getHours() < deps.tidyHour()) return false;
    if (autoTidyBlockedDay.get(botId) === memoryDate(current)) return false;
    const last = loadState().bots[botId]?.lastTidy?.at;
    return !last || memoryDate(new Date(last)) < memoryDate(current);
  }

  async function tick(): Promise<void> {
    if (paused) return;
    for (const bot of deps.bots()) {
      if (paused) return;
      if (!upkeepEnabled(bot) || deps.busy(bot.id) || !due(bot.id)) continue;
      try {
        const report = await tidy(bot.id);
        if (report.note && autoTidyBlockedDay.get(bot.id) === memoryDate(now())) log(`memory upkeep: tidy outcome for ${bot.id} — ${report.expired} expired, ${report.duplicates} duplicate(s), ${report.superseded} contradicted, ${report.organized ?? 0} organized: ${report.note}`);
      } catch (error) {
        log(`memory upkeep: tidy failed for ${bot.id}: ${(error as Error).message}`);
      }
    }
  }

  return {
    noteTurn(botId, threadId, turn) {
      if (!upkeepEnabled(deps.bot(botId))) return;
      if (!turn.person.trim() && !turn.bot.trim()) return;
      buffer.add(botId, threadId, turn);
    },
    flushThread: (threadId) => buffer.flush(threadId),
    dropBot(botId) {
      buffer.dropBot(botId);
      dropQueued(botId);
      partialCaptureReports.delete(botId);
      partialTidyReports.delete(botId);
      autoTidyBlockedDay.delete(botId);
    },
    forgetBot(botId) {
      buffer.dropBot(botId);
      dropQueued(botId);
      dropPending(botId);
      partialCaptureReports.delete(botId);
      partialTidyReports.delete(botId);
      autoTidyBlockedDay.delete(botId);
      const state = loadState();
      if (!state.bots[botId]) return;
      delete state.bots[botId];
      saveState(state);
    },
    capture: (batch) => new Promise<CaptureReport>((resolve, reject) => enqueue({ batch, done: { resolve, reject } })),
    tidy,
    status(botId) {
      const { lastTidy, lastCapture } = loadState().bots[botId] ?? {};
      const currentTidy = partialTidyReports.get(botId) ?? lastTidy;
      const currentCapture = partialCaptureReports.get(botId) ?? lastCapture;
      return { ...(currentTidy ? { lastTidy: currentTidy } : {}), ...(currentCapture ? { lastCapture: currentCapture } : {}), modelSteps: Boolean(deps.engine(botId)?.generateText) };
    },
    tick,
    start() {
      if (timer) return;
      if (deps.restoreTurn) {
        try {
          for (const saved of takePending()) {
            if (!upkeepEnabled(deps.bot(saved.botId))) continue;
            for (const turnId of saved.turnIds) {
              const turn = deps.restoreTurn(saved.botId, saved.threadId, turnId);
              if (turn && (turn.person.trim() || turn.bot.trim())) buffer.add(saved.botId, saved.threadId, { ...turn, turnId });
            }
          }
        } catch (error) {
          log(`memory upkeep: could not queue turns saved at the last shutdown: ${(error as Error).message}`);
        }
      }
      timer = setInterval(() => void tick(), TIDY_CHECK_MS);
      timer.unref?.();
      const first = setTimeout(() => void tick(), 60_000);
      first.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      const queued = queue.splice(0);
      for (const entry of queued) entry.done?.resolve({ at: now().getTime(), added: 0, topics: 0, aboutMe: 0, note: "kept for the next start" });
      const waiting = [...queued.map((entry) => entry.batch), ...buffer.drain()];
      if (deps.restoreTurn) savePending(waiting);
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      kick();
    },
    async idle() {
      while (inflight.size) await Promise.allSettled(inflight);
    },
  };
}
