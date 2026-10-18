// Copyright 2026 OpenMausBot contributors. Licensed under Apache-2.0.
// Queue ownership and admission reservations belong to the same drain.
import { drainSteeredMessages, type SteerQueueHead } from "../steer-queue.ts";
import type { Message, Store } from "../store.ts";
import type { UsageTrigger } from "../usage-ledger.ts";
import type { WorkOrigin } from "../peer-provenance.ts";

export function queuedTurnTrigger(item: { trigger?: UsageTrigger; sender?: { name: string }; peerAsk?: unknown }): UsageTrigger | undefined {
  if (item.trigger) return item.trigger;
  if (item.peerAsk) return undefined;
  return item.sender ? { kind: "user", label: item.sender.name } : { kind: "owner" };
}

interface QueuedSendDeps {
  store: Store;
  ready: () => boolean;
  start: (botId: string, prompt: string, options: {
    threadId: string; userMessage: Message; excludeMessageIds: string[]; unattended: boolean;
    onTurnSettled: () => void; trigger?: UsageTrigger; origin?: WorkOrigin;
  }) => Promise<unknown>;
  blocked: (botId: string, threadId: string, head: SteerQueueHead, reserved: number) => boolean;
  onError: (botId: string, threadId: string, excludeIds: string[], head: SteerQueueHead, reason: string) => void;
}

export function createQueuedSendDrain(deps: QueuedSendDeps): () => void {
  let draining = false, drainOwed = false;
  // start can await dispatch policy before it claims capacity; count that gap.
  const reservations = new Map<string, number>();
  function drain() {
    if (!deps.ready()) return;
    if (draining) { drainOwed = true; return; }
    draining = true;
    try {
      drainSteeredMessages(deps.store, (botId, threadId, prompt, userMessage, excludeIds, unattended, head) =>
        new Promise<void>((resolve, reject) => {
          void deps.start(botId, prompt, {
            threadId, userMessage, excludeMessageIds: excludeIds, unattended, onTurnSettled: resolve,
            trigger: queuedTurnTrigger(head), ...(head.origin ? { origin: head.origin } : {}),
          }).catch((error) => {
            const reason = error instanceof Error ? error.message : String(error);
            deps.onError(botId, threadId, excludeIds, head, reason);
            resolve();
            // No completion event wakes the queues when a turn never started.
            queueMicrotask(drain);
          }).catch(reject).finally(() => {
            const remaining = (reservations.get(botId) ?? 1) - 1;
            if (remaining) reservations.set(botId, remaining);
            else reservations.delete(botId);
            queueMicrotask(drain);
          });
        }),
      (botId, threadId, head) => {
        const reserved = reservations.get(botId) ?? 0;
        const blocked = deps.blocked(botId, threadId, head, reserved);
        if (!blocked) reservations.set(botId, reserved + 1);
        return blocked;
      });
    } finally {
      draining = false;
      if (drainOwed) { drainOwed = false; drain(); }
    }
  }
  return drain;
}
