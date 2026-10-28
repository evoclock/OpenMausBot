import { redactSecretsInText } from "../shared/redact.ts";
import type { RunSnapshot } from "./run-contract.ts";
import type { SessionStatusFeed, SessionWake } from "./session-status-feed.ts";

export function createCodingRunStatusReporter(options: {
  feed: SessionStatusFeed;
  list: () => RunSnapshot[];
  wake: (wakes: readonly SessionWake[]) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  return {
    tick() {
      const latest = new Map(options.feed.latest().map((record) => [record.sessionId, record]));
      for (const snapshot of options.list()) {
        const id = snapshot.contract.id;
        const previous = latest.get(id);
        if (previous?.reportId === `${id}:denied`) continue;
        const sequence = (previous?.sequence ?? -1) + 1;
        const outcome = options.feed.record({ sessionId: id, reportId: `${id}:${sequence}`, sequence,
          state: snapshot.state, phase: "coding", stepId: `iteration-${snapshot.iteration}`,
          progressAt: snapshot.updatedAt, reportedAt: now(), evidence: snapshot.evidence.slice(-5)
            .map((item) => redactSecretsInText(item).trim().slice(0, 500)).filter(Boolean) });
        if (outcome.stale) throw new Error("coding status sequence is stale");
        if (outcome.wakes.length) options.wake(outcome.wakes);
      }
    },
  };
}
