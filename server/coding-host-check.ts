import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execFileSync } from "node:child_process";

const execute = promisify(execFile);
const MAX_OUTPUT = 16 * 1024;

export interface HostCheckRecord {
  command: string[];
  exitCode: number | null;
  commitSha: string;
  startedAt: number;
  durationMs: number;
  timedOut: boolean;
  outputTail: string;
}

export async function runHostCheck(input: { command: string[]; cwd: string; revision: string; timeoutMs?: number }): Promise<HostCheckRecord> {
  const startedAt = Date.now();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  let commitSha = "";
  let exitCode: number | null = null;
  let timedOut = false;
  let output = "";
  try {
    commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: input.cwd, encoding: "utf8", timeout: 10_000, env }).trim();
    if (commitSha !== input.revision) throw new Error("leased workspace HEAD differs from accepted revision");
    const result = await execute(input.command[0]!, input.command.slice(1), {
      cwd: input.cwd, env, timeout: input.timeoutMs ?? 120_000, maxBuffer: 1024 * 1024,
      encoding: "utf8", windowsHide: true,
    });
    exitCode = 0;
    output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    exitCode = typeof failure.code === "number" ? failure.code : null;
    timedOut = failure.killed === true || failure.code === "ETIMEDOUT";
    output = `${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message}`;
  }
  return { command: [...input.command], exitCode, commitSha, startedAt, durationMs: Date.now() - startedAt,
    timedOut, outputTail: output.replace(/(token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(-MAX_OUTPUT) };
}
