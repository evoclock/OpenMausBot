import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export type CwdValidation = { ok: true; cwd: string | null } | { ok: false; error: string };

export function validateBotCwd(input: unknown): CwdValidation {
  if (input === null) return { ok: true, cwd: null };
  if (typeof input !== "string") return { ok: false, error: "working folder must be a path" };
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, cwd: null };
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? homedir() + trimmed.slice(1) : trimmed;
  if (!isAbsolute(expanded)) return { ok: false, error: "working folder must be an absolute path" };
  const cwd = resolve(expanded);
  let stat;
  try {
    stat = statSync(cwd);
  } catch {
    return { ok: false, error: `that folder doesn't exist: ${cwd}` };
  }
  if (!stat.isDirectory()) return { ok: false, error: `that path is not a folder: ${cwd}` };
  return { ok: true, cwd };
}

/** A conversation's folder a teammate may be sent to: one that still exists, outside OpenMausBot's own data (a bot's private workspace). */
export function sharedProjectFolder(cwd: string | null | undefined, dataDir: string): string | undefined {
  const checked = cwd ? validateBotCwd(cwd) : undefined;
  if (!checked?.ok || !checked.cwd) return undefined;
  const inside = relative(resolve(dataDir), checked.cwd);
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside)) ? undefined : checked.cwd;
}

/** coordinate_bots' in_my_folder: the sender's project folder for a new thread outside a room, or why it cannot be used. */
export function inMyFolderCwd(wanted: boolean | undefined, fresh: boolean, senderCwd: string | null | undefined, dataDir: string): { cwd?: string; error?: string } {
  if (!wanted) return {};
  if (!fresh) return { error: 'in_my_folder works only with thread "new", outside a room. Leave it out, or use thread "new".' };
  const cwd = sharedProjectFolder(senderCwd, dataDir);
  return cwd ? { cwd } : { error: "This conversation has no project folder to share (it works in its own private folder), so in_my_folder cannot be used. Leave it out; do not retry it." };
}
