import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type CodingCommand = "status" | "diff" | "add" | "commit" | "typecheck" | "lint" | "test";

export function codingCommandAllowed(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const params = input as Record<string, unknown>;
  if (Object.keys(params).some((key) => !["command", "paths", "message", "revision"].includes(key)) || typeof params.command !== "string") return false;
  if (!Object.hasOwn(CHECKS, params.command) && !["status", "diff", "add", "commit"].includes(params.command as string)) return false;
  if (params.paths !== undefined && (!Array.isArray(params.paths) || params.paths.some((path) => typeof path !== "string"))) return false;
  if (params.message !== undefined && typeof params.message !== "string") return false;
  if (params.revision !== undefined && (params.command !== "diff" || typeof params.revision !== "string" || !/^[a-f0-9]{40}$/.test(params.revision))) return false;
  return true;
}

export function codingFileAllowed(cwd: string, input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const path = (input as { path?: unknown }).path;
  if (typeof path !== "string" || !path || path.includes("\0")) return false;
  const root = realpathSync(cwd);
  const target = resolve(root, path);
  const inside = relative(root, target);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || inside.split(sep).includes(".git")) return false;
  let existing = target;
  while (true) {
    try { lstatSync(existing); break; } catch { if (existing === root) return false; existing = dirname(existing); }
  }
  let canonical: string;
  try { canonical = realpathSync(existing); } catch { return false; }
  const real = relative(root, canonical);
  return real !== ".." && !real.startsWith(`..${sep}`) && !real.split(sep).includes(".git");
}

const CHECKS: Readonly<Record<string, readonly string[]>> = {
  typecheck: ["typecheck"],
  lint: ["lint"],
  test: ["exec", "vitest", "run"],
};

export function executeCodingCommand(cwd: string, command: CodingCommand, paths: string[] = [], message = "", expectedBranch?: string, revision?: string): string {
  if (!codingCommandAllowed({ command, paths, message, revision })) throw new Error("Coding run denied: command is outside the envelope");
  const root = realpathSync(cwd);
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024, env: {
    ...gitEnv, GIT_AUTHOR_NAME: "evoclock", GIT_AUTHOR_EMAIL: "52983349+evoclock@users.noreply.github.com",
    GIT_COMMITTER_NAME: "evoclock", GIT_COMMITTER_EMAIL: "52983349+evoclock@users.noreply.github.com",
  } }).trim();
  if (realpathSync(git(["rev-parse", "--show-toplevel"])) !== root ||
    !existsSync(resolve(root, ".git"))) throw new Error("Coding command denied: not the leased worktree root");
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch || branch === "main" || branch.startsWith("treehouse/") || (expectedBranch && branch !== expectedBranch)) throw new Error("Coding command denied: worktree branch changed");
  if (paths.length > 50 || paths.some((path) => typeof path !== "string" || !path || isAbsolute(path) || path.startsWith("-") || path.includes("\0") ||
    path.split(/[\\/]/).some((part) => part === ".." || part === ".git") ||
    (relative(root, resolve(root, path)).startsWith(`..${sep}`)))) throw new Error("Coding command denied: path outside the worktree");
  if (command !== "add" && paths.length) throw new Error("Coding run denied: paths are only supported for add");
  if (command !== "commit" && message) throw new Error("Coding command denied: message is only supported for commit");
  switch (command) {
    case "status": return git(["status", "--short", "--branch"]);
    case "diff":
      if (!revision) return git(["diff", "--no-ext-diff", "HEAD"]);
      if (revision !== git(["rev-parse", "HEAD"])) throw new Error("Coding command denied: review revision is not HEAD");
      return git(["diff", "--no-ext-diff", `${revision}^`, revision]);
    case "add":
      if (!paths.length) throw new Error("Coding command denied: explicit paths required");
      return git(["add", "--", ...paths]);
    case "commit":
      if (!message.trim() || message.length > 200 || /[\r\n\0]/.test(message)) throw new Error("Coding command denied: invalid commit message");
      // Git hooks can execute commands outside this envelope.
      let hookDir: string;
      try { hookDir = git(["config", "--get", "core.hooksPath"]); }
      catch { hookDir = git(["rev-parse", "--git-path", "hooks"]); }
      if (["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"].some((name) =>
        existsSync(resolve(root, hookDir, name)))) throw new Error("Coding command denied: executable commit hook");
      return git(["commit", "-m", message]);
    case "test":
      // Declared host checks (including package test suites) run after commit via
      // checkCommand. Mid-loop "test" is a cheap tree hygiene check so workers do
      // not block docs-only runs on a missing vitest install in the lease.
      return git(["diff", "--check"]);
    case "typecheck": case "lint":
      return execFileSync("pnpm", [...CHECKS[command]], { cwd: root, encoding: "utf8", timeout: 20 * 60_000, maxBuffer: 256 * 1024 }).trim();
    default: throw new Error("Coding command denied: command is outside the envelope");
  }
}
