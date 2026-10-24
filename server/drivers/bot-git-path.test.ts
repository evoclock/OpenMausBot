import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { botGitPath } from "./bot-git-path.ts";

const scratch = join(process.cwd(), "node_modules");

describe("bot Git PATH", () => {
  it.skipIf(process.platform === "win32")("blocks checkout creation and delegates other commands to the resolved executable", () => {
    const dataDir = mkdtempSync(join(scratch, "bot-git-"));
    const path = botGitPath(process.env.PATH!, dataDir);
    const run = (...args: string[]) => spawnSync("git", args, { env: { ...process.env, PATH: path }, cwd: process.cwd(), encoding: "utf8" });
    for (const args of [["clone", "source", "destination"], ["init", "new"], ["worktree", "add", "new"], ["-C", process.cwd(), "worktree", "add", "new"]]) {
      const result = run(...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Treehouse");
    }
    expect(run("rev-parse", "--show-toplevel").stdout.trim()).toBe(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
    expect(run("-C", process.cwd(), "rev-parse", "--show-toplevel").status).toBe(0);
  });

  it.skipIf(process.platform === "win32")("fails closed without a real Git executable", () => {
    expect(() => botGitPath("/nonexistent", mkdtempSync(join(scratch, "bot-git-missing-")))).toThrow("Git is unavailable");
  });
});
