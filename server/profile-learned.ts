// Facts bots added to About me on their own; a removed fact is remembered by identity and never added again.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { factIdentity } from "./memory-entries.ts";
import { redactSecretsInText } from "./redact.ts";

const MAX_KEPT = 200;
const MAX_REMOVED = 500;
const TEXT_MAX = 300;

export interface LearnedFact {
  id: string;
  text: string;
  line: string;
  botId: string;
  botName: string;
  at: number;
}

interface LearnedFile {
  learned: LearnedFact[];
  removed: string[];
}

function filePath(): string {
  return join(DATA_DIR, "profile-learned.json");
}

function load(): LearnedFile {
  try {
    const parsed = JSON.parse(readFileSync(filePath(), "utf8")) as Partial<LearnedFile>;
    const learned = Array.isArray(parsed.learned)
      ? parsed.learned.filter((f): f is LearnedFact =>
        Boolean(f) && typeof f.id === "string" && typeof f.text === "string" && typeof f.line === "string" && typeof f.botId === "string" && typeof f.botName === "string" && typeof f.at === "number")
      : [];
    const removed = Array.isArray(parsed.removed) ? parsed.removed.filter((r): r is string => typeof r === "string") : [];
    return { learned, removed };
  } catch {
    return { learned: [], removed: [] };
  }
}

function save(file: LearnedFile): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(filePath(), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

export function listLearnedFacts(): LearnedFact[] {
  return [...load().learned].reverse();
}

export function aboutMeLine(fact: { text: string; botName: string }, today: string): string {
  return `- ${today} · learned by ${fact.botName.replace(/·/g, "-").replace(/\s+/g, " ").trim().slice(0, 60)} · ${fact.text}`;
}

function lineIdentity(line: string): string {
  return factIdentity(line.replace(/^\s*-\s*\d{4}-\d{2}-\d{2} · learned by [^·\n]* · /, ""));
}

export function planLearned(from: { botId: string; botName: string }, texts: readonly string[], aboutMe: string, today: string, now = Date.now()): LearnedFact[] {
  const file = load();
  const known = new Set([...file.removed, ...aboutMe.split("\n").map(lineIdentity)]);
  const out: LearnedFact[] = [];
  for (const raw of texts) {
    const text = redactSecretsInText(raw.replace(/\s+/g, " ").trim()).slice(0, TEXT_MAX);
    const key = factIdentity(text);
    if (!key || known.has(key)) continue;
    known.add(key);
    out.push({ id: randomUUID(), text, line: aboutMeLine({ text, botName: from.botName }, today), botId: from.botId, botName: from.botName, at: now });
  }
  return out;
}

export function commitLearned(facts: readonly LearnedFact[]): void {
  if (!facts.length) return;
  const file = load();
  file.learned = [...file.learned, ...facts].slice(-MAX_KEPT);
  save(file);
}

export function appendAboutMe(aboutMe: string, lines: readonly string[], maxChars = 24_000): string | null {
  if (!lines.length) return aboutMe;
  const base = aboutMe.replace(/\s+$/, "");
  const next = base ? `${base}\n${lines.join("\n")}` : lines.join("\n");
  return next.length > maxChars ? null : next;
}

/** Save About me before committing removal, so a failed profile save leaves the fact retryable. */
export function removeLearned(id: string, aboutMe: string, saveAboutMe?: (text: string) => void): { fact: LearnedFact; aboutMe: string } | null {
  const file = load();
  const fact = file.learned.find((f) => f.id === id);
  if (!fact) return null;
  const lines = aboutMe.split("\n");
  const at = lines.indexOf(fact.line);
  if (at !== -1) lines.splice(at, 1);
  const next = lines.join("\n");
  if (next !== aboutMe) saveAboutMe?.(next);
  file.learned = file.learned.filter((f) => f.id !== id);
  file.removed = [...file.removed, factIdentity(fact.text)].slice(-MAX_REMOVED);
  save(file);
  return { fact, aboutMe: next };
}
