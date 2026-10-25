import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runHostCheck } from "./coding-host-check.ts";

describe("runHostCheck", () => {
  it.each([["process.exit(0)", 0], ["process.exit(1)", 1]])("records exit status for an argv check", async (script, exitCode) => {
    const base = join(process.cwd(), "node_modules", ".cache");
    mkdirSync(base, { recursive: true });
    const cwd = mkdtempSync(join(base, "omb-host-check-"));
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "fixture"], { cwd });
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const result = await runHostCheck({ command: ["node", "-e", script], cwd, revision });
    expect(result).toMatchObject({ exitCode, commitSha: revision, timedOut: false });
  });
});
