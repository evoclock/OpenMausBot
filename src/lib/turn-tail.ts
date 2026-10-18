import type { Message } from "@/state/store";

/** A turn ends across three frames (reply, turn.completed, busy off): a settled reply at the tail keeps the dots hidden. */
export function showWorkingDots(
  busy: boolean | undefined,
  lastMessage: Message | undefined,
  speakerBotId?: string,
): boolean {
  if (!busy) return false;
  if (!lastMessage) return true;
  const settledReply = lastMessage.role === "bot" && lastMessage.kind === "text";
  if (!settledReply) return true;
  return speakerBotId !== undefined && lastMessage.from?.botId !== speakerBotId;
}

export function awaitedMemberId(
  working: boolean | undefined,
  speakerBotId: string | null | undefined,
  lastMessage: Message | undefined,
): string | undefined {
  if (!working || speakerBotId) return undefined;
  if (lastMessage?.kind !== "activity" || !lastMessage.tool || lastMessage.tool.ok !== undefined) return undefined;
  return lastMessage.from?.botId;
}
