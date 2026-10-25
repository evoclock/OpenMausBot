import type { RuntimeEvent } from "./contracts.ts";
import type { SessionStatusFeed } from "./session-status-feed.ts";
import { redactSecretsInText } from "./redact.ts";

export interface CodingThread {
  id: string;
  branch: string;
  directory: string;
}

export class CodingDenialBoundary {
  private readonly threads = new Map<string, CodingThread>();
  private readonly feed: SessionStatusFeed;
  private readonly onWake: () => void;
  private readonly interrupt: (event: RuntimeEvent) => void;

  constructor(feed: SessionStatusFeed, onWake: () => void, interrupt: (event: RuntimeEvent) => void) {
    this.feed = feed;
    this.onWake = onWake;
    this.interrupt = interrupt;
  }

  register(threadId: string, run: CodingThread): void { this.threads.set(threadId, run); }
  lookup(threadId: string): CodingThread | undefined { return this.threads.get(threadId); }
  forget(threadId: string): void { this.threads.delete(threadId); }

  handle(event: RuntimeEvent): boolean {
    const id = this.lookup(event.threadId)?.id;
    if (!id || (event.type !== "request.opened" &&
      !(event.type === "runtime.error" && event.message.startsWith(`Coding run ${id} denied `)))) return false;
    const action = event.type === "request.opened" ? event.tool : event.message.slice(`Coding run ${id} denied `.length).split(":")[0];
    const why = event.type === "request.opened" ? "interactive request is outside the coding envelope" : event.message.split(": ").slice(1).join(": ");
    if (event.type === "request.opened") this.interrupt(event);
    try {
      const now = Date.now();
      const previous = this.feed.latest().find((row) => row.sessionId === id);
      if (previous?.reportId === `${id}:denied`) return true;
      if (!previous) this.feed.record({ sessionId: id, reportId: `${id}:started`, sequence: 0,
        state: "running", progressAt: now, reportedAt: now });
      const outcome = this.feed.record({ sessionId: id, reportId: `${id}:denied`, sequence: (previous?.sequence ?? 0) + 1,
        state: "failed", progressAt: now, reportedAt: now,
        evidence: [redactSecretsInText(`Coding run ${id} denied ${action}: ${why}`).slice(0, 500)] });
      if (outcome.wakes.length) this.onWake();
    } catch { console.error("coding run denial feed unavailable"); }
    return true;
  }
}
