import type { ChildProcess } from "node:child_process";
import { cpus } from "node:os";

/** Every Codex app-server starts its MCP servers with its thread; many starting at once on a small host
 * push those calls past their timeouts. Launches past this many wait until one has its turn running. */
export function codexLaunchLimit(): number {
  const configured = Number(process.env.OMB_CODEX_LAUNCH_SLOTS);
  return Number.isInteger(configured) && configured > 0 ? configured : Math.max(2, cpus().length);
}

let starting = 0;
const waiting: Array<() => boolean> = [];

/** A held slot, released once; null when every slot is taken. */
export function tryCodexLaunchSlot(): (() => void) | null {
  if (starting >= codexLaunchLimit()) return null;
  starting++;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    starting--;
    while (waiting.length && !waiting.shift()!());
  };
}

export function codexLaunchesStarting(): number {
  return starting;
}

/** Resolves null when `signal` aborts first. */
export function codexLaunchSlot(signal: AbortSignal): Promise<(() => void) | null> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(null);
    const take = () => {
      const slot = tryCodexLaunchSlot();
      if (!slot) return false;
      signal.removeEventListener("abort", abort);
      resolve(slot);
      return true;
    };
    const abort = () => {
      const index = waiting.indexOf(take);
      if (index >= 0) waiting.splice(index, 1);
      resolve(null);
    };
    if (take()) return;
    waiting.push(take);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** The slot is released when the process exits or fails to start, if not before; not on `close`, which
 * waits for every descendant (its MCP servers, shells) to let go of the inherited pipes. */
export function spawnHoldingSlot<T extends ChildProcess>(release: () => void, spawn: () => T): T {
  try {
    const child = spawn();
    child.once("exit", release).once("error", release);
    return child;
  } catch (error) {
    release();
    throw error;
  }
}

const STARTUP_METHODS = new Set(["initialize", "config/read", "thread/start", "thread/resume", "thread/unarchive", "turn/start"]);

/** A loaded host can take minutes to start an app-server and its MCP servers; later calls answer quickly. */
export function codexRpcTimeoutMs(method: string): number {
  return STARTUP_METHODS.has(method) ? 180_000 : 60_000;
}

/** How long a relaunch waits for a process whose stop could not be confirmed to exit by itself. */
export const RELAUNCH_EXIT_WAIT_MS = 30_000;

/** Retries a failed stop every few seconds while the turn still owns it, for about a minute; true once it stopped. */
export async function keepStopping(stop: () => Promise<boolean>, owned: () => boolean): Promise<boolean> {
  const everyMs = Math.max(1, Number(process.env.FAKE_CODEX_STOP_RETRY_MS) || 5_000);
  for (let attempt = 0; attempt < 12 && owned(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, everyMs).unref?.());
    if (owned() && await stop()) return true;
  }
  return false;
}
