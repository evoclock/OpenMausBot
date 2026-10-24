import type { IterationContextCompactor, IterationEntry } from "./loop-ledger.ts";
import { redactToolResult } from "./redact.ts";

export const DEFAULT_CONTEXT_CARRY_BYTES = 8192;

function fit(text: string, bytes: number): string {
  let result = "";
  let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (used + size > bytes) break;
    result += character;
    used += size;
  }
  return result;
}

function safe(text: string): string {
  return redactToolResult(text).replace(/[\r\n]+/g, " ").trim();
}

export function createIterationContextCompactor(maxBytes = DEFAULT_CONTEXT_CARRY_BYTES): IterationContextCompactor {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) throw new Error("invalid context carry byte cap");
  return {
    compact(entries: readonly IterationEntry[]): string {
      const finished = entries.filter((entry) => entry.verdict !== "pending");
      const last = finished.at(-1);
      if (!last) return "";
      const header = `Previous iteration ${last.iteration} verdict: ${last.verdict}\nEvidence:\n`;
      const summaryHeader = "\nEarlier iterations (bounded receipt summary):\n";
      const recentBudget = Math.min(maxBytes - Buffer.byteLength(header), Math.ceil(maxBytes / 2));
      const recent = fit(last.evidence.map(safe).join("\n"), recentBudget);
      const base = header + recent;
      const earlier = finished.slice(0, -1).map((entry) => {
        const evidence = entry.evidence.map(safe).filter(Boolean);
        return `${entry.iteration} ${entry.verdict}: ${evidence.join("; ") || "no evidence"}`;
      });
      const selected: string[] = [];
      let remaining = maxBytes - Buffer.byteLength(base + summaryHeader);
      for (const line of earlier) {
        if (remaining <= 0) break;
        const item = fit(line, Math.min(remaining, 160));
        if (item) { selected.push(item); remaining -= Buffer.byteLength(item) + 1; }
      }
      return fit(base + (selected.length ? summaryHeader + selected.join("\n") : ""), maxBytes);
    },
  };
}
