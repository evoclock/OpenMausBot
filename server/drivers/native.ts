// Tees every provider-native message beside the canonical stream, so protocol drift shows up in a diff.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { NATIVE_DIR } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { capThreadLog, currentThreadLogCap } from "../thread-log-rotation.ts";

export function appendNative(threadId: string, entry: { dir: "in" | "out"; source: string; msg: unknown }) {
  const file = join(NATIVE_DIR, `${threadId}.ndjson`);
  try {
    // Session setup carries agent credentials (boat/comms tokens, MCP headers) and
    // people paste these logs into bug reports, so values are masked.
    appendFileSync(
      file,
      JSON.stringify({ at: new Date().toISOString(), ...entry, msg: redactSecrets(entry.msg) }) + "\n",
      { mode: 0o600 },
    );
    capThreadLog(file, currentThreadLogCap());
  } catch {}
}
