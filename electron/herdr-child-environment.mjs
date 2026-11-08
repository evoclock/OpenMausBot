import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function withHerdrChildEnvironment(env, { exists = existsSync, home = homedir } = {}) {
  const childEnv = { ...env };
  if (typeof childEnv.HERDR_SOCKET_PATH !== "string" || !childEnv.HERDR_SOCKET_PATH) {
    const socketPath = join(home(), ".config/herdr/herdr.sock");
    if (!exists(socketPath)) return childEnv;
    childEnv.HERDR_SOCKET_PATH = socketPath;
  }
  if (!childEnv.HERDR_ENV) childEnv.HERDR_ENV = "1";
  return childEnv;
}
