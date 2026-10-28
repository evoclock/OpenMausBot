import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BEGIN = "BEGIN_CARD";
const END = "END_CARD";
const SECTION = "## Consolidation phase";

/** Interior bytes between BEGIN_CARD and END_CARD markers, or null if absent/malformed. */
export function extractFilledCard(text: string): string | null {
  const beginAt = text.indexOf(BEGIN);
  if (beginAt < 0) return null;
  const afterBegin = beginAt + BEGIN.length;
  // tolerate optional newline right after the marker
  const bodyStart = text[afterBegin] === "\n" ? afterBegin + 1 : afterBegin;
  const endAt = text.indexOf(END, bodyStart);
  if (endAt < 0) return null;
  let body = text.slice(bodyStart, endAt);
  if (body.endsWith("\n")) body = body.slice(0, -1);
  if (!body.includes(SECTION)) return null;
  return body;
}

/** Replace the ## Consolidation phase section with cardBody (which must start with that heading). */
export function applyFilledCardToTasksMd(tasksMd: string, cardBody: string): string {
  if (!cardBody.startsWith(SECTION)) {
    throw new Error("filled card body must start with ## Consolidation phase");
  }
  const start = tasksMd.indexOf(SECTION);
  if (start < 0) throw new Error("TASKS.md has no ## Consolidation phase section");
  const rest = tasksMd.slice(start + SECTION.length);
  const nextHeading = rest.search(/\n## /);
  const before = tasksMd.slice(0, start);
  const after = nextHeading < 0 ? "" : rest.slice(nextHeading + 1); // keep leading ## of next section
  const card = cardBody.endsWith("\n") ? cardBody : `${cardBody}\n`;
  const mid = after ? `${card}\n${after}` : card;
  return `${before}${mid}`;
}

/** If goal/prompt embeds BEGIN_CARD…END_CARD, write it into workspace TASKS.md. Returns applied body or null. */
export function applyEmbeddedCardInWorkspace(directory: string, goalText: string): string | null {
  const card = extractFilledCard(goalText);
  if (!card) return null;
  const tasksPath = join(directory, "TASKS.md");
  const tasksMd = readFileSync(tasksPath, "utf8");
  const next = applyFilledCardToTasksMd(tasksMd, card);
  if (next !== tasksMd) writeFileSync(tasksPath, next, "utf8");
  return card;
}
