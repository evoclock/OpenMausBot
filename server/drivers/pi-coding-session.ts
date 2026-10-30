import { accessSync, chmodSync, constants, lstatSync, mkdirSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function hostProfileFile(hostDir: string, name: string, label: string): string {
  const path = resolve(hostDir, name);
  try {
    const source = realpathSync(path);
    const file = statSync(source);
    if (!file.isFile() || file.size <= 2) throw new Error("empty or not a file");
    accessSync(source, constants.R_OK);
  } catch {
    throw new Error(`Coding run denied: host Pi ${label} is unavailable`);
  }
  return path;
}

function linkProfileFile(agentDir: string, hostFile: string, name: string, label: string): void {
  const target = join(agentDir, name);
  if (lstatSync(target, { throwIfNoEntry: false })) {
    try {
      if (realpathSync(target) === realpathSync(hostFile) && lstatSync(target).isSymbolicLink()) return;
    } catch {}
    throw new Error(`Coding run denied: isolated Pi ${label} is not linked to the host`);
  }
  symlinkSync(hostFile, target);
}

export function codingPiAgentDir(
  dataDir: string,
  botId: string,
  hostPi = join(homedir(), ".pi", "pi", "harness", "bin", "pi"),
): string {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(botId)) throw new Error("Coding run denied: bot identity is invalid");
  const dir = join(dataDir, "bots", botId, "pi");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (realpathSync(dir) !== dir) throw new Error("Coding run denied: Pi profile is redirected");
  chmodSync(dir, 0o700);
  const harness = join(dir, "harness");
  mkdirSync(harness, { recursive: true, mode: 0o700 });
  if (realpathSync(harness) !== harness) throw new Error("Coding run denied: Pi harness is redirected");
  const bin = join(harness, "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  if (realpathSync(bin) !== bin) throw new Error("Coding run denied: Pi harness is redirected");
  const cli = join(bin, "pi");
  if (!lstatSync(cli, { throwIfNoEntry: false })) {
    let source: string;
    try {
      source = realpathSync(hostPi);
      if (!statSync(source).isFile()) throw new Error("not a file");
      accessSync(source, constants.X_OK);
    } catch {
      throw new Error("Coding run denied: host Pi CLI is unavailable");
    }
    symlinkSync(source, cli);
  }
  try {
    if (!statSync(cli).isFile()) throw new Error("not a file");
    accessSync(cli, constants.X_OK);
  } catch {
    throw new Error("Coding run denied: isolated Pi CLI is not executable");
  }
  const hostDir = dirname(dirname(dirname(hostPi)));
  const catalog = hostProfileFile(hostDir, "models-store.json", "model catalog");
  const auth = hostProfileFile(hostDir, "auth.json", "authentication");
  linkProfileFile(dir, catalog, "models-store.json", "model catalog");
  linkProfileFile(dir, auth, "auth.json", "authentication");
  return dir;
}

export async function openPiSession(
  send: (frame: Record<string, unknown>) => void,
  response: (command: string) => Promise<unknown>,
  sessionPath: string | null,
  durable: boolean,
): Promise<{ sessionFile: string | null; sessionId: string | null }> {
  const command = sessionPath ? "switch_session" : "new_session";
  const awaited = response(command);
  send(sessionPath ? { type: command, sessionPath } : { type: command });
  const handshake = await awaited as { cancelled?: boolean; sessionFile?: string; sessionId?: string } | undefined;
  if (handshake?.cancelled) throw new Error("Pi session switch was cancelled");
  if (!durable) return { sessionFile: handshake?.sessionFile ?? sessionPath, sessionId: handshake?.sessionId ?? null };
  const state = response("get_state");
  send({ type: "get_state" });
  const current = await state as { sessionFile?: string; sessionId?: string } | undefined;
  if (!current?.sessionFile) throw new Error("Coding run needs a Pi session-file path");
  return { sessionFile: current.sessionFile, sessionId: current.sessionId ?? null };
}
