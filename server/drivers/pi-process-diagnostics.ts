import { readFileSync } from "node:fs";

/** Extension load failures reach only stderr; keep a short tail so an early exit is not silent. */
export function captureStderrTail(child: { stderr?: NodeJS.ReadableStream | null }): () => string {
  let tail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { tail = (tail + chunk).slice(-2_000); });
  return () => tail;
}

export function piExitMessage(stderrTail: string): string {
  const detail = stderrTail.trim().split("\n").filter((line) => line.trim()).slice(-2).join(" ").slice(-500);
  return detail ? `pi process exited before replying: ${detail}` : "pi process exited before replying";
}

/** Missing or malformed readiness is never a grant. */
export function scopeReceiptReady(path: string, toolScope: unknown): boolean {
  try {
    const receipt = JSON.parse(readFileSync(path, "utf8")) as { status?: unknown; toolScope?: unknown };
    return (receipt.status === "registered" || receipt.status === "enforced") && JSON.stringify(receipt.toolScope) === JSON.stringify(toolScope);
  } catch { return false; }
}
