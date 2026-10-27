import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { codingCommandAllowed, codingFileAllowed, executeCodingCommand } from "./coding-command.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const cache = join(process.cwd(), "node_modules", ".cache");

test("coding command permits only fixed local git verbs on a feature worktree", async () => {
  mkdirSync(cache, { recursive: true });
  const home = mkdtempSync(join(cache, "coding-command-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: home, encoding: "utf8" });
    git("init", "-b", "main");
    git("config", "user.name", "evoclock");
    git("config", "user.email", "52983349+evoclock@users.noreply.github.com");
    writeFileSync(join(home, "file.txt"), "base\n");
    git("add", "file.txt");
    git("-c", "user.name=evoclock", "-c", "user.email=52983349+evoclock@users.noreply.github.com", "commit", "-m", "base");
    git("switch", "-c", "feat/closed");
    assert.match(executeCodingCommand(home, "status", [], "", "feat/closed"), /feat\/closed/);
    assert.throws(() => executeCodingCommand(home, "status", [], "", "main"), /worktree branch changed/i);
    writeFileSync(join(home, "file.txt"), "changed\n");
    assert.match(executeCodingCommand(home, "status"), /file.txt/);
    assert.match(executeCodingCommand(home, "diff"), /\+changed/);
    assert.equal(executeCodingCommand(home, "add", ["file.txt"]), "");
    assert.match(executeCodingCommand(home, "commit", [], "Closed coding change"), /Closed coding change/);
    assert.equal(codingCommandAllowed({ command: "push" }), false);
    assert.equal(codingCommandAllowed({ command: "lint", extra: "--fix" }), false);
    assert.throws(() => executeCodingCommand(home, "push" as "commit"), /denied/i);
    assert.throws(() => executeCodingCommand(home, "add", ["../other"]), /denied/i);
    assert.throws(() => executeCodingCommand(home, "status", [], "--exec"), /denied/i);
    git("switch", "main");
    assert.throws(() => executeCodingCommand(home, "status"), /denied/i);
    git("switch", "--detach", "HEAD");
    assert.throws(() => executeCodingCommand(home, "status"));
  } finally { await removeTempDir(home); }
});

test("a reviewer can inspect only the committed HEAD patch through the closed command", async () => {
  mkdirSync(cache, { recursive: true });
  const home = mkdtempSync(join(cache, "coding-review-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: home, encoding: "utf8" }).trim();
    git("init", "-b", "main");
    git("config", "user.name", "evoclock");
    git("config", "user.email", "52983349+evoclock@users.noreply.github.com");
    writeFileSync(join(home, "file.txt"), "base\n");
    git("add", "file.txt");
    git("commit", "-m", "base");
    git("switch", "-c", "feat/review");
    writeFileSync(join(home, "file.txt"), "committed\n");
    git("add", "file.txt");
    git("commit", "-m", "change");
    const head = git("rev-parse", "HEAD");
    const base = git("rev-parse", "HEAD^");
    writeFileSync(join(home, "file.txt"), "uncommitted\n");
    assert.equal(codingCommandAllowed({ command: "diff", revision: head }), true);
    const patch = executeCodingCommand(home, "diff", [], "", "feat/review", head);
    assert.match(patch, /\+committed/);
    assert.doesNotMatch(patch, /uncommitted/);
    assert.throws(() => executeCodingCommand(home, "diff", [], "", "feat/review", base), /denied/i);
    assert.equal(codingCommandAllowed({ command: "diff", revision: `${head}^ ${head}` }), false);
    assert.equal(codingCommandAllowed({ command: "commit", revision: head }), false);
    assert.equal(codingCommandAllowed({ command: "diff", revision: "HEAD" }), false);
  } finally { await removeTempDir(home); }
});

test("coding file operations cannot escape through absolute paths or symlinks", async () => {
  mkdirSync(cache, { recursive: true });
  const home = mkdtempSync(join(cache, "coding-files-"));
  try {
    mkdirSync(join(home, "inside"));
    symlinkSync(process.cwd(), join(home, "escape"));
    assert.equal(codingFileAllowed(home, { path: "inside/new.txt" }), true);
    assert.equal(codingFileAllowed(home, { path: "../outside" }), false);
    assert.equal(codingFileAllowed(home, { path: "escape/package.json" }), false);
    assert.equal(codingFileAllowed(home, { path: ".git/config" }), false);
    assert.equal(codingFileAllowed(home, { text: "missing path" }), false);
  } finally { await removeTempDir(home); }
});
