// Memory upkeep: the background half of a bot's memory. On for every bot
// unless switched off (BotRecord.memoryUpkeep === false). The main agent
// keeps reading and writing its notes as before; this adds what happens
// without it choosing:
//   - capture: finished 1:1 turns are read after the chat goes quiet; core
//     facts go to MEMORY.md, detail to a topic file per subject that upkeep
//     creates and names, with other words for it (server/memory-capture.ts);
//   - About me: a durable fact about the person, from their own words, is
//     added to the shared About me and listed in Settings with Remove
//     (server/profile-learned.ts);
//   - tidy-up: nightly, and on demand, expired entries are archived, exact
//     duplicates merged (MEMORY.md and topic files) and contradictions in
//     MEMORY.md struck (server/memory-tidy.ts).
// Every memory write is a journal row with actor "upkeep", so the Memory
// panel shows it and Undo works. The model steps need a one-shot text call
// (`generateText`: Claude and the chat-completion engines); on any other
// engine they are skipped and only the deterministic tidy steps run.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { CaptureBuffer, capturePrompt, newCandidates, parseCandidates, type Candidate, type CaptureBatch, type CaptureTurn } from "./memory-capture.ts";
import { factIdentity, lineFactIdentity, notebookIdentities } from "./memory-entries.ts";
import { mergeTopicText } from "./memory-topics.ts";
import { applyMoves, MAX_MOVES, organizeCandidates, organizePrompt, parseMoves } from "./memory-organize.ts";
import { recordMemoryChange } from "./memory-journal.ts";
import { applyTidy, contradictionCandidates, contradictionPrompt, parseContradictions, planChanges, planTidy, type Contradiction } from "./memory-tidy.ts";
import { appendMemoryArchive, ARCHIVE_TOPIC, ensureWorkspace, listMemoryTopics, memoryDate, memoryEntry, memoryTopicIndex, readMemoryText, updateMemory, workspaceDir, writeMemoryFile, writeMemoryTopic } from "./workspace.ts";

export const CAPTURE_MAX_TURNS = 6;
export const MODEL_TIMEOUT_MS = 60_000;
export const TIDY_CHECK_MS = 10 * 60_000;
/** Below this many live entries there is nothing a contradiction pass may change. */
export const MIN_ENTRIES_FOR_CONTRADICTIONS = 5;
const ARCHIVE_PATH = `memory/${ARCHIVE_TOPIC}`;
/** A topic file past this size gains nothing more from capture. */
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

/** On unless switched off: every bot keeps its memory in shape by default. */
export function upkeepEnabled(bot: Pick<UpkeepBot, "memoryUpkeep" | "memoryEnabled"> | undefined): bot is UpkeepBot {
  return Boolean(bot) && bot!.memoryUpkeep !== false && bot!.memoryEnabled !== false;
}

export interface UpkeepDeps {
  bots: () => readonly UpkeepBot[];
  bot: (id: string) => UpkeepBot | undefined;
  /** The bot's engine when it may receive memory text (policy allows), else null. */
  engine: (botId: string) => UpkeepEngine | null;
  /** A turn is running for the bot: the scheduled tidy waits. */
  busy: (botId: string) => boolean;
  /** Append facts about the person to the shared About me; returns how many were added. */
  addToAboutMe: (from: { botId: string; botName: string }, texts: readonly string[]) => number;
  /** `chat "Title"`, for the source of a captured entry. */
  sourceLabel: (botId: string, threadId: string) => string;
  quietMs: () => number;
  tidyHour: () => number;
  /** Fresh scoped-lease check immediately before each synchronous upkeep
   * persistence burst. Optional; absent means no scoped write check. */
  beforeWrite?: () => Promise<void>;
  /** Wraps each synchronous burst of writes this makes to one bot's memory
   * (capture, organize, tidy), so the host can tell them from writes made
   * elsewhere (an OMB Cloud home: server/lending-memory.ts). */
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
  /** MEMORY.md entries moved into topic files. */
  organized?: number;
  /** Whether the contradiction step ran (needs a text engine and five entries). */
  contradictionsChecked: boolean;
  /** Why it did not run, in the person's words. */
  note?: string;
}

export interface CaptureReport {
  at: number;
  /** Facts appended to MEMORY.md. */
  added: number;
  /** Facts filed into topic files. */
  topics: number;
  /** Facts added to the shared About me. */
  aboutMe: number;
  /** MEMORY.md entries moved into topic files afterwards. */
  organized?: number;
  note?: string;
}

interface UpkeepState {
  bots: Record<string, { lastTidy?: TidyReport; lastCapture?: CaptureReport; core?: string[] }>;
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
    // status is a convenience; losing it only means the tidy may run again
  }
}

function readRaw(botId: string, relative: string): string | null {
  try {
    return readMemoryText(join(workspaceDir(botId), relative));
  } catch {
    return null;
  }
}

async function askModel(engine: UpkeepEngine, prompt: string): Promise<string | null> {
  if (!engine.generateText) return null;
  const expiry = AbortSignal.timeout(MODEL_TIMEOUT_MS);
  try {
    const answer = await Promise.race([
      engine.generateText(prompt, { signal: expiry }),
      new Promise<never>((_, reject) => expiry.addEventListener("abort", () => reject(new Error("timed out")), { once: true })),
    ]);
    return typeof answer === "string" ? answer : null;
  } catch {
    return null;
  }
}

export const NO_TEXT_ENGINE = "This bot's engine cannot make the quick background model call upkeep uses, so only expired notes and exact duplicates are tidied.";

export interface MemoryUpkeep {
  /** A finished 1:1 turn of an upkeep bot, for capture. */
  noteTurn(botId: string, threadId: string, turn: CaptureTurn): void;
  /** Capture a thread's waiting turns now, without waiting for the quiet spell. */
  flushThread(threadId: string): void;
  /** Forget a bot's waiting turns (switch turned off, bot deleted). */
  dropBot(botId: string): void;
  /** Run one capture batch; resolves with actual counts and a note on partial outcomes. */
  capture(batch: CaptureBatch): Promise<CaptureReport>;
  tidy(botId: string): Promise<TidyReport>;
  status(botId: string): { lastTidy?: TidyReport; lastCapture?: CaptureReport; modelSteps: boolean };
  /** One scheduler pass: tidy every due bot. Exposed for tests. */
  tick(): Promise<void>;
  start(): void;
  /** Shutdown: stop the scheduler; waiting turns are not captured. */
  stop(): void;
  /** Backup maintenance: nothing writes until resume, and batches that
   * came due meanwhile run then. */
  pause(): void;
  resume(): void;
  /** Wait for captures in flight (tests, shutdown). */
  idle(): Promise<void>;
}

export function createMemoryUpkeep(deps: UpkeepDeps): MemoryUpkeep {
  const now = () => deps.now?.() ?? new Date();
  const log = (line: string) => deps.log?.(line);
  const inflight = new Set<Promise<unknown>>();
  const tidying = new Map<string, Promise<TidyReport>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let paused = false;
  const deferred: CaptureBatch[] = [];
  // Keep truthful partial outcomes visible without attempting a status write
  // while the scoped gate refuses it. These reports are volatile until restart.
  const partialCaptureReports = new Map<string, CaptureReport>();
  const partialTidyReports = new Map<string, TidyReport>();
  // If a scoped tidy is partially applied but its status write is refused,
  // avoid replaying it automatically for this bot/date in this process.
  // Manual tidy calls remain explicit; this volatile guard does not survive restart.
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

  const record = async (botId: string, patch: { lastTidy?: TidyReport; lastCapture?: CaptureReport }): Promise<boolean> => {
    if (beforeWrite) {
      await checkWriteGate();
      if (paused) return false;
    }
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

  async function capture(batch: CaptureBatch): Promise<CaptureReport> {
    const bot = deps.bot(batch.botId);
    const at = now().getTime();
    const off: CaptureReport = { at, added: 0, topics: 0, aboutMe: 0, note: "upkeep is off" };
    if (!upkeepEnabled(bot)) return off;
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
      turns: batch.turns,
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
      // a backup began while the model answered: run it again after
      deferred.push(batch);
      return { at, added: 0, topics: 0, aboutMe: 0, note: "deferred until the backup finishes" };
    }
    // The broker check below can yield. Recheck upkeep state afterwards, then
    // keep each persistence burst synchronous with its journal rows.
    if (!upkeepEnabled(deps.bot(bot.id))) return off;
    if (beforeWrite) {
      await checkWriteGate();
      if (paused || !upkeepEnabled(deps.bot(bot.id))) return off;
    }
    const { parsed, added, topics } = writing(bot.id, () => {
      const before = readRaw(bot.id, "MEMORY.md");
      const archiveBefore = readRaw(bot.id, ARCHIVE_PATH);
      const parsed = parseCandidates(answer, today);
      const fresh = newCandidates(parsed, before ?? "");
      const source = `${deps.sourceLabel(bot.id, batch.threadId)} (noticed)`;
      let added = 0;
      const byTopic = new Map<string, Candidate[]>();
      for (const candidate of fresh) {
        if (candidate.topic) {
          byTopic.set(candidate.topic, [...(byTopic.get(candidate.topic) ?? []), candidate]);
          continue;
        }
        if (updateMemory(bot.id, { action: "append", text: candidate.text, ...(candidate.until ? { until: candidate.until } : {}) }, { source, now: now() }).ok) added += 1;
      }
      // Older entries the appends moved out are journaled first, as the
      // tidy-up does, so undoing the newest row (MEMORY.md) brings them back.
      recordMemoryChange(bot.id, { path: ARCHIVE_PATH, actor: "upkeep", via: "capture", threadId: batch.threadId, before: archiveBefore, after: readRaw(bot.id, ARCHIVE_PATH) });
      if (added) recordMemoryChange(bot.id, { path: "MEMORY.md", actor: "upkeep", via: "capture", threadId: batch.threadId, before, after: readRaw(bot.id, "MEMORY.md") });
      // Detail goes to a topic file the bot keeps for that subject, created
      // with a header (title and other words for it) the first time.
      const existing = new Map(listMemoryTopics(bot.id).map((topic) => [topic.name.toLowerCase(), topic.name]));
      let topics = 0;
      for (const [wanted, candidates] of byTopic) {
        const name = existing.get(wanted) ?? wanted;
        const path = `memory/${name}`;
        const current = readRaw(bot.id, path);
        if (current !== null && Buffer.byteLength(current, "utf8") > TOPIC_MAX_BYTES) continue;
        const seen = notebookIdentities(current ?? "");
        const lines = candidates
          .filter((candidate) => !seen.has(factIdentity(candidate.text)))
          .map((candidate) => memoryEntry(candidate.text, { source, now: now(), ...(candidate.until ? { until: candidate.until } : {}) }));
        if (!lines.length) continue;
        const title = name.replace(/\.md$/, "").replace(/-/g, " ");
        const aliases = [...new Set(candidates.flatMap((candidate) => candidate.topicAliases ?? []))];
        try {
          writeMemoryTopic(bot.id, name, mergeTopicText(current, { title, aliases, lines }));
        } catch {
          continue;
        }
        recordMemoryChange(bot.id, { path, actor: "upkeep", via: "capture", threadId: batch.threadId, before: current, after: readRaw(bot.id, path) });
        existing.set(name.toLowerCase(), name);
        topics += lines.length;
      }
      return { parsed, added, topics };
    });
    // Only the owner's own words reach About me: on a shared workspace
    // another person's facts are not the owner's profile. Every parsed fact
    // counts, not only new ones — the bot may already have noted it in its
    // own memory, and About me is where every other bot learns it.
    const owner = batch.turns.every((turn) => turn.owner !== false);
    const aboutMeTexts = parsed.filter((candidate) => candidate.aboutUser).map((candidate) => candidate.text);
    let aboutMe = 0;
    const partialCapture = (note: string, organized?: number): CaptureReport => ({
      at, added, topics, aboutMe, ...(organized !== undefined ? { organized } : {}), note,
    });
    if (owner && aboutMeTexts.length) {
      if (beforeWrite) {
        try {
          await checkWriteGate();
        } catch (error) {
          if (error instanceof ScopedWriteGateBlocked) return rememberPartialCapture(bot.id, partialCapture(`Capture saved ${added} notebook fact(s) and ${topics} topic fact(s), but About me was not updated because the scoped write gate refused it. This memory-upkeep instance will not retry this batch automatically.`));
          throw error;
        }
        if (paused || !upkeepEnabled(deps.bot(bot.id))) return rememberPartialCapture(bot.id, partialCapture("Notebook changes were saved, but About me was not updated because upkeep paused or was disabled. This memory-upkeep instance will not retry this batch automatically."));
      }
      aboutMe = deps.addToAboutMe({ botId: bot.id, botName: bot.name }, aboutMeTexts);
    }
    // whoever wrote MEMORY.md — the bot, the person or this capture — detail
    // that is not core moves to its topic now, not only at night
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
    if (!recorded) return rememberPartialCapture(bot.id, { ...report, note: `Capture completed with ${added} notebook fact(s), ${topics} topic fact(s), and ${aboutMe} About me fact(s); upkeep status was not recorded because upkeep paused. This memory-upkeep instance will not retry this batch automatically.` });
    if (added || topics || aboutMe) log(`memory upkeep: noticed ${added} fact(s) for MEMORY.md, ${topics} for topic files and ${aboutMe} for About me — ${bot.name} (${bot.id}) from ${batch.threadId}`);
    return report;
  }

  const buffer = new CaptureBuffer({
    quietMs: deps.quietMs,
    maxTurns: CAPTURE_MAX_TURNS,
    onFlush: (batch) => {
      if (paused) {
        deferred.push(batch);
        return;
      }
      void track(capture(batch)).then((report) => {
        if (report.note) log(`memory upkeep: capture outcome for ${batch.botId} — ${report.added} notebook fact(s), ${report.topics} topic fact(s), ${report.aboutMe} About me fact(s): ${report.note}`);
      }).catch((error: unknown) => log(`memory upkeep: capture failed for ${batch.botId}: ${(error as Error).message}`));
    },
  });

  /** Move MEMORY.md entries that are not core into their topic files. One
   * model call over entries not judged before; lines move unchanged, topics
   * first so undoing the newest row (MEMORY.md) never loses one. */
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
    // the line numbers are the file's as read; a write since means ask again later
    const before = readRaw(botId, "MEMORY.md") ?? "";
    if (before !== first) return 0;
    const proposed = parseMoves(answer, candidates);
    if (proposed === null) return 0;
    // Deferred moves are not core: let the next pass reconsider them.
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
    if (paused || !upkeepEnabled(deps.bot(botId))) return { ...stopped, ...(organized ? { organized } : {}) };
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
    if (paused || !upkeepEnabled(deps.bot(botId))) return { ...stopped, ...(organized ? { organized } : {}) };
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
      // The archive is written first: a line is never out of MEMORY.md
      // before it is in the archive, and the newest journal row — the one a
      // person undoes — is MEMORY.md, whose undo brings the line back.
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
    // Topic files get the two steps that need no model: expired lines to the
    // archive (written first, as above) and exact duplicates merged.
    let topicExpired = 0;
    let topicDuplicates = 0;
    let stoppedByGate = false;
    for (const topic of listMemoryTopics(botId)) {
      if (topic.name === ARCHIVE_TOPIC) continue;
      const path = `memory/${topic.name}`;
      const topicBefore = readRaw(botId, path);
      if (topicBefore === null) continue;
      const topicPlan = planTidy(topicBefore, today);
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
    const report: TidyReport = {
      at,
      expired: plan.expired.length + topicExpired,
      duplicates: plan.duplicates.length + topicDuplicates,
      superseded: plan.superseded.length,
      deferred: plan.deferred,
      ...(organized ? { organized } : {}),
      contradictionsChecked,
      ...(note ? { note } : {}),
      ...(stoppedByGate ? { note: [note, "The scoped write gate stopped later topic tidy writes; earlier tidy changes remain saved. Automatic tidy is suppressed for the rest of this process today."].filter(Boolean).join(" ") } : {}),
    };
    let recorded: boolean;
    try {
      recorded = await record(botId, { lastTidy: report });
    } catch (error) {
      if (error instanceof ScopedWriteGateBlocked) {
        suppressAutoTidyToday(botId);
        return rememberPartialTidy(botId, appendTidyNote(report, "Tidy changes shown above were saved, but upkeep status was not recorded because the scoped write gate refused it. Automatic tidy is suppressed for the rest of this process today."));
      }
      throw error;
    }
    if (!recorded) {
      suppressAutoTidyToday(botId);
      return rememberPartialTidy(botId, appendTidyNote(report, "Tidy changes shown above were saved, but upkeep status was not recorded because upkeep paused. Automatic tidy is suppressed for the rest of this process today."));
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
      partialCaptureReports.delete(botId);
      partialTidyReports.delete(botId);
      autoTidyBlockedDay.delete(botId);
    },
    capture: (batch) => track(capture(batch)),
    tidy,
    status(botId) {
      // the core judgements are upkeep's own bookkeeping, not status
      const { lastTidy, lastCapture } = loadState().bots[botId] ?? {};
      const currentTidy = partialTidyReports.get(botId) ?? lastTidy;
      const currentCapture = partialCaptureReports.get(botId) ?? lastCapture;
      return { ...(currentTidy ? { lastTidy: currentTidy } : {}), ...(currentCapture ? { lastCapture: currentCapture } : {}), modelSteps: Boolean(deps.engine(botId)?.generateText) };
    },
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), TIDY_CHECK_MS);
      timer.unref?.();
      // a first pass shortly after start catches a night the computer slept through
      const first = setTimeout(() => void tick(), 60_000);
      first.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      for (const batch of deferred.splice(0)) {
        void track(capture(batch)).then((report) => {
          if (report.note) log(`memory upkeep: capture outcome for ${batch.botId} — ${report.added} notebook fact(s), ${report.topics} topic fact(s), ${report.aboutMe} About me fact(s): ${report.note}`);
        }).catch((error: unknown) => log(`memory upkeep: capture failed for ${batch.botId}: ${(error as Error).message}`));
      }
    },
    async idle() {
      while (inflight.size) await Promise.allSettled(inflight);
    },
  };
}
