import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

export function codingPiAgentDir(dataDir: string, botId: string): string {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(botId)) throw new Error("Coding run denied: bot identity is invalid");
  const dir = join(dataDir, "bots", botId, "pi");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (realpathSync(dir) !== dir) throw new Error("Coding run denied: Pi profile is redirected");
  chmodSync(dir, 0o700);
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
