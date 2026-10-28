import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { applyEmbeddedCardInWorkspace, applyFilledCardToTasksMd, extractFilledCard } from "./coding-filled-card-apply.ts";

const CARD = `## Consolidation phase

## Consolidation (owner-reviewable card — COMPLETE)

| Class | Path / piece | Maintained home | Pointer rule |
|---|---|---|---|
| moves | example | driver | pointer |
`;

describe("extractFilledCard", () => {
  it("returns interior when markers present", () => {
    const text = `Goal: do the thing\nBEGIN_CARD\n${CARD}\nEND_CARD\nBudget: 1`;
    assert.equal(extractFilledCard(text), CARD);
  });
  it("returns null without markers", () => {
    assert.equal(extractFilledCard("Goal: concise card"), null);
  });
  it("returns null if body lacks Consolidation phase heading", () => {
    assert.equal(extractFilledCard("BEGIN_CARD\nnope\nEND_CARD"), null);
  });
});

describe("applyFilledCardToTasksMd", () => {
  it("replaces the consolidation section and keeps neighbors", () => {
    const tasks = `# TASKS\n\n## Earlier\n\nhold\n\n## Consolidation phase\n\nold body\n\n## Later\n\nafter\n`;
    const out = applyFilledCardToTasksMd(tasks, CARD);
    assert.match(out, /## Earlier/);
    assert.match(out, /## Later/);
    assert.match(out, /Class \| Path/);
    assert.doesNotMatch(out, /old body/);
  });
});

describe("applyEmbeddedCardInWorkspace", () => {
  it("writes TASKS.md when goal embeds the card", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-card-"));
    writeFileSync(join(dir, "TASKS.md"), `# TASKS\n\n## Consolidation phase\n\nstale\n`, "utf8");
    const applied = applyEmbeddedCardInWorkspace(dir, `BEGIN_CARD\n${CARD}\nEND_CARD`);
    assert.ok(applied);
    const written = readFileSync(join(dir, "TASKS.md"), "utf8");
    assert.match(written, /owner-reviewable card/);
    assert.doesNotMatch(written, /stale/);
  });
  it("no-ops when markers absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-card-"));
    const before = `# TASKS\n\n## Consolidation phase\n\nstale\n`;
    writeFileSync(join(dir, "TASKS.md"), before, "utf8");
    assert.equal(applyEmbeddedCardInWorkspace(dir, "Goal: concise"), null);
    assert.equal(readFileSync(join(dir, "TASKS.md"), "utf8"), before);
  });
});
