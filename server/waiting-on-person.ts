// The engines' own prompts stay the only gates: nothing here answers, holds or grants anything.
import type { RuntimeEvent } from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";

type Resolved = Extract<RuntimeEvent, { type: "request.resolved" }>;

export function settledWaitingChip(name: string, kind: string, behavior: Resolved["behavior"], source: Resolved["source"]): { name: string; ok: boolean } {
  const who = `@${name}`;
  const question = kind === "answer";
  // A timeout or closed turn says so even when the engine filed it as an answer (Claude's note for an unanswered question).
  if (source === "timeout") return question
    ? { name: `Nobody answered ${who}'s question in time`, ok: false }
    : { name: `Nobody answered ${who}'s approval in time — that step did not run`, ok: false };
  if (source === "system" || source === "unavailable") return question
    ? { name: `${who}'s turn ended before anyone answered its question`, ok: false }
    : { name: `${who}'s approval closed before anyone answered — that step did not run`, ok: false };
  if (behavior === "deny") return { name: question ? `${who}'s question was dismissed` : `${who}'s request was denied`, ok: false };
  return source === "user"
    ? { name: `${who} got your ${question ? "answer" : "approval"}`, ok: true }
    : { name: question ? `${who}'s question was answered` : `${who}'s request was approved`, ok: true };
}

export function queuedBehindPersonText(name: string, kind: "approval" | "question" | "review", title: string): string {
  return `Queued for @${name} behind your ${kind === "question" ? "answer" : kind} in “${title}”`;
}

const MAX_ACTIONS = 10;
const MAX_THREADS = 256;

function actionLine(tool: string | undefined, summary: string | undefined): string {
  return redactSecretsInText(tool && summary && !summary.includes(tool) ? `${tool}: ${summary}` : summary || tool || "an action")
    .replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Every engine denies an unanswered approval on its own timer and the turn carries on, so its result can read as done while those actions never ran. */
export class UnansweredApprovals {
  private readonly byThread = new Map<string, { turnId: string; actions: string[] }>();

  record(threadId: string, turnId: string | undefined, tool: string | undefined, summary: string | undefined): void {
    if (!turnId) return;
    const noted = this.byThread.get(threadId);
    const actions = noted?.turnId === turnId ? noted.actions : [];
    const action = actionLine(tool, summary);
    if (!actions.includes(action) && actions.length < MAX_ACTIONS) actions.push(action);
    this.byThread.delete(threadId);
    this.byThread.set(threadId, { turnId, actions });
    if (this.byThread.size > MAX_THREADS) this.byThread.delete(this.byThread.keys().next().value!);
  }

  answered(threadId: string, turnId: string | undefined, tool: string | undefined, summary: string | undefined): void {
    const noted = this.byThread.get(threadId);
    if (!turnId || noted?.turnId !== turnId) return;
    const action = actionLine(tool, summary);
    noted.actions = noted.actions.filter(candidate => candidate !== action);
    if (!noted.actions.length) this.byThread.delete(threadId);
  }

  annotate(threadId: string, turnId: string | undefined, text: string, ok: boolean): string {
    const noted = this.byThread.get(threadId);
    if (!noted || noted.turnId !== turnId) return text;
    const one = noted.actions.length === 1;
    const note = `[OpenMausBot: nobody answered the ${one ? "approval" : "approvals"} for ${noted.actions.map(action => `“${action}”`).join(", ")} in time, so ${one ? "it" : "they"} did not run. Do not report ${one ? "it" : "them"} as done; ${one ? "it needs" : "they need"} the person's approval.]`;
    if (!text) return note;
    return ok ? `${note}\n\n${text}` : `${text}\n\n${note}`;
  }
}
