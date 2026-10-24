import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reportTaskCheckouts } from "./task-checkout-report.ts";

const workspace = () => mkdtempSync(join(process.cwd(), "node_modules", "task-checkout-"));

describe("task checkout report", () => {
  it("records nested Git directories and gitfiles without removing either", () => {
    const root = workspace();
    mkdirSync(join(root, "review", ".git"), { recursive: true });
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(join(root, "nested", ".git"), "gitdir: ../elsewhere");
    const report = reportTaskCheckouts(root);
    expect(report).toMatchObject({ found: ["nested/.git", "review/.git"], incomplete: false });
    expect(readFileSync(report.artifact!, "utf8")).toContain("review/.git");
    expect(existsSync(join(root, "review", ".git"))).toBe(true);
    expect(readFileSync(join(root, "nested", ".git"), "utf8")).toContain("gitdir:");
  });

  it("does not follow symlinks or silently call a truncated scan complete", () => {
    const root = workspace();
    const other = workspace();
    mkdirSync(join(other, ".git"));
    symlinkSync(other, join(root, "outside"));
    expect(reportTaskCheckouts(root).found).toEqual([]);
    expect(() => reportTaskCheckouts(join(root, "outside"), 20_000, root)).toThrow("not a directory");
    mkdirSync(join(root, "project", ".git"), { recursive: true });
    expect(reportTaskCheckouts(root, 1).incomplete).toBe(true);
  });
});
