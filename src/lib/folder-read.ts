import type { Bot, BotAnnouncement } from "@/state/store";

type FolderBot = Pick<Bot, "id" | "threadId" | "unread" | "tasks">;

export function botUnreadThreadIds(bot: FolderBot): string[] {
  if (!bot.tasks?.length) return bot.unread ? [bot.threadId] : [];
  return bot.tasks
    .filter((task) => task.unread ?? (task.threadId === bot.threadId && bot.unread))
    .map((task) => task.threadId);
}

export function folderUnreadThreadIds(bot: FolderBot, projectId: string): string[] {
  return (bot.tasks ?? [])
    .filter((task) => task.projectId === projectId && (task.unread ?? (task.threadId === bot.threadId && bot.unread)))
    .map((task) => task.threadId);
}

export async function markFolderRead(
  bot: FolderBot,
  projectId: string,
  request: (path: string, init?: RequestInit) => Promise<{ bot: BotAnnouncement }>,
  onRead: (bot: BotAnnouncement) => void,
): Promise<void> {
  await markThreadsRead(bot.id, folderUnreadThreadIds(bot, projectId), request, onRead);
}

export async function markBotRead(
  bot: FolderBot,
  request: (path: string, init?: RequestInit) => Promise<{ bot: BotAnnouncement }>,
  onRead: (bot: BotAnnouncement) => void,
): Promise<void> {
  await markThreadsRead(bot.id, botUnreadThreadIds(bot), request, onRead);
}

async function markThreadsRead(
  botId: string,
  threadIds: readonly string[],
  request: (path: string, init?: RequestInit) => Promise<{ bot: BotAnnouncement }>,
  onRead: (bot: BotAnnouncement) => void,
): Promise<void> {
  for (const threadId of threadIds) {
    const result = await request(`/api/bots/${botId}/read`, {
      method: "POST",
      body: JSON.stringify({ threadId }),
    });
    onRead(result.bot);
  }
}
