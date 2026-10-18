// Copyright 2026 OpenMausBot contributors. Licensed under Apache-2.0.
// Direct turn admission reads host state through explicit dependencies.
import { admit } from "../admission.ts";
import { maxConcurrentBotThreads } from "../config.ts";
import type { Store } from "../store.ts";

export function createDirectAdmission(deps: {
  store: Store;
  cfg: { threads?: { maxConcurrentPerBot?: number } };
  threadBusy: (botId: string, threadId: string) => boolean;
  awaitingTeammates: (threadId: string) => boolean;
  activeGroupTurnForBot: (botId: string) => unknown;
}) {
  const botAtThreadCapacity = (botId: string): boolean =>
    // threadBusy includes a dispatch claim even if early completion cleared the stored busy flag.
    deps.store.tasks(botId).filter((task) => deps.threadBusy(botId, task.threadId)).length >= maxConcurrentBotThreads(deps.cfg);

  const parksBehindCoordination = (botId: string, threadId: string): boolean => {
    if (!deps.awaitingTeammates(threadId)) return false;
    return (deps.store.projectBotForTask(botId, threadId) ?? deps.store.bot(botId))?.parkDirectMessages === true;
  };

  const canAdmitDirectTurn = (botId: string, threadId: string): boolean =>
    admit("peer", {}, {
      threadBusy: deps.threadBusy(botId, threadId),
      atCapacity: botAtThreadCapacity(botId),
      groupTurn: Boolean(deps.activeGroupTurnForBot(botId)),
    }).action === "start";

  const unattendedDispatchState = (botId: string): "ready" | "busy" | "missing" => {
    const bot = deps.store.bot(botId);
    const decision = admit("unattended", {}, {
      botPresent: Boolean(bot),
      atCapacity: Boolean(bot) && botAtThreadCapacity(botId),
      groupTurn: Boolean(bot) && Boolean(deps.activeGroupTurnForBot(botId)),
    });
    if (decision.action === "refuse") return decision.code === "missing" ? "missing" : "busy";
    return "ready";
  };

  return { botAtThreadCapacity, parksBehindCoordination, canAdmitDirectTurn, unattendedDispatchState };
}
