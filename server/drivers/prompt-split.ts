// The stable/volatile system-prompt split: the stable half stays byte-identical for a provider's
// cached prefix; a changed volatile half rides inside the turn that changed it.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { SendTurnInput } from "../contracts.ts";

export interface PromptHalves {
  stable: string | null;
  volatile: string;
}

export function promptHalves(
  turn: Pick<SendTurnInput, "system" | "systemStable" | "systemVolatile">,
): PromptHalves {
  const { systemStable, systemVolatile } = turn;
  if (typeof systemStable !== "string" || typeof systemVolatile !== "string") {
    return { stable: null, volatile: "" };
  }
  return { stable: systemStable, volatile: systemVolatile };
}

export const VOLATILE_CONTEXT_NOTE_PREFIX =
  "Context from OpenMausBot updated since this conversation started; it replaces any earlier copy:";

export const VOLATILE_CONTEXT_CLEARED_NOTE =
  "The OpenMausBot context notes from earlier in this conversation have been cleared; the standing instructions still apply.";

export function volatileContextNote(volatile: string, hadVolatile: boolean): string {
  const text = volatile.trim();
  if (text) return VOLATILE_CONTEXT_NOTE_PREFIX + "\n\n" + text;
  return hadVolatile ? VOLATILE_CONTEXT_CLEARED_NOTE : "";
}

export function withContextNote(note: string, text: string): string {
  if (!note) return text;
  return text ? note + "\n\n" + text : note;
}

export interface PromptSplitReceipt {
  stable: string;
  volatile: string;
  turnsSinceFull?: number;
  lastUsed?: number;
  peakUsed?: number;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

const EMPTY_FINGERPRINT = digest("");

export function promptSplitFingerprints(stable: string, volatile: string): PromptSplitReceipt {
  return { stable: digest(stable), volatile: digest(volatile) };
}

const receiptPath = (scope: string, key: string) =>
  join(DATA_DIR, "prompt-split", digest(JSON.stringify([scope, key])) + ".json");

export function readPromptSplitReceipt(scope: string, key: string): PromptSplitReceipt | null {
  try {
    const raw = JSON.parse(readFileSync(receiptPath(scope, key), "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as { stable?: unknown; volatile?: unknown; turnsSinceFull?: unknown; lastUsed?: unknown; peakUsed?: unknown };
      if (typeof record.stable === "string" && typeof record.volatile === "string") {
        return {
          stable: record.stable,
          volatile: record.volatile,
          ...(typeof record.turnsSinceFull === "number" ? { turnsSinceFull: record.turnsSinceFull } : {}),
          ...(typeof record.lastUsed === "number" && record.lastUsed > 0 ? { lastUsed: record.lastUsed } : {}),
          ...(typeof record.peakUsed === "number" && record.peakUsed > 0 ? { peakUsed: record.peakUsed } : {}),
        };
      }
    }
  } catch {}
  return null;
}

export function writePromptSplitReceipt(scope: string, key: string, receipt: PromptSplitReceipt): void {
  mkdirSync(join(DATA_DIR, "prompt-split"), { recursive: true });
  writeFileAtomic(receiptPath(scope, key), JSON.stringify(receipt), { mode: 0o600 });
}

export function deletePromptSplitReceipt(scope: string, key: string): void {
  try {
    rmSync(receiptPath(scope, key));
  } catch {}
}

/** reAnchorAfterTurns re-sends the full prompt after that many bare turns, for history rewrites no event reports. */
export function splitSessionPrompt(
  stable: string,
  volatile: string,
  previous: PromptSplitReceipt | null,
  fullSystem: string | undefined,
  text: string,
  perTurnVolatile = false,
  reAnchorAfterTurns = 0,
): { text: string; receipt: PromptSplitReceipt } {
  const fingerprints = promptSplitFingerprints(stable, volatile);
  const turnsSinceFull = typeof previous?.turnsSinceFull === "number" ? previous.turnsSinceFull : 0;
  const reAnchor = reAnchorAfterTurns > 0 && previous !== null && turnsSinceFull >= reAnchorAfterTurns;
  if (previous === null || previous.stable !== fingerprints.stable || reAnchor) {
    return { text: fullSystem ? fullSystem + "\n\n" + text : text, receipt: { ...fingerprints, turnsSinceFull: 0 } };
  }
  const note = previous.volatile === fingerprints.volatile && !perTurnVolatile
    ? ""
    : volatileContextNote(volatile, previous.volatile !== EMPTY_FINGERPRINT);
  return { text: withContextNote(note, text), receipt: { ...fingerprints, turnsSinceFull: turnsSinceFull + 1 } };
}
