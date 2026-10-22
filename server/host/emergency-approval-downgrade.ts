import type { Store } from "../store.ts";

export function createEmergencyApprovalDowngrade(options: {
  store: Store;
  stopDirect: (botId: string) => Promise<void>;
  activeRoutine: (botId: string) => { id: string; threadId?: string } | null | undefined;
  cancelRoutine: (runId: string) => Promise<unknown>;
  activeGroup: (botId: string) => { group: { id: string }; threadId: string } | null;
  cancelGroup: (groupId: string, threadId: string) => void;
  revoke: (threadId: string) => void;
  cancelDispatch: (botId: string, threadId: string | undefined) => void;
  closeApprovals: (threadId: string) => void;
  interruptGroup: (botId: string, threadId: string) => Promise<void> | undefined;
}) {
  return async (botId: string): Promise<void> => {
    const bot = options.store.bot(botId);
    if (!bot) return;
    for (const task of options.store.tasks(botId)) {
      if (task.approvalMode === "full" || task.approvalMode === "custom") {
        options.store.patchTask(botId, task.threadId, { approvalMode: "ask", autoApprove: false, alwaysAllow: [] });
      }
    }
    const directStop = options.stopDirect(botId);
    const routineRun = options.activeRoutine(bot.id);
    if (routineRun) {
      if (routineRun.threadId) options.revoke(routineRun.threadId);
      options.cancelDispatch(bot.id, routineRun.threadId);
      await options.cancelRoutine(routineRun.id);
      if (routineRun.threadId) options.closeApprovals(routineRun.threadId);
      await directStop;
      return;
    }
    const groupTurn = options.activeGroup(bot.id);
    if (groupTurn) {
      options.revoke(groupTurn.threadId);
      options.cancelGroup(groupTurn.group.id, groupTurn.threadId);
      const results = await Promise.allSettled([
        directStop,
        options.interruptGroup(bot.id, groupTurn.threadId),
      ]);
      options.closeApprovals(groupTurn.threadId);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
      return;
    }
    await directStop;
  };
}
