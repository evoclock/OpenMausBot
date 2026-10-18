import { approvalCardOutcome } from "./ApprovalCard";
import type { Bot, Group, InstanceInfo, Message } from "@/state/store";
import { peerLine } from "@/lib/peer-message";
import { lastNonReceipt } from "@/lib/receipts";
import { activityPreview, botEngine } from "@/lib/failed-turn";
import { t } from "@/lib/i18n";
import { sidebarConnectorPreview, sidebarGoalRunPreview } from "@/lib/sidebar-layout";
import { citationPreviewText } from "@/lib/citations";
import { plainPreviewText } from "@/lib/plain-preview";
import { isClientCancellation } from "../../shared/client-cancel";
import { roomWorkingPreview } from "@/lib/room-threads";

export function botPreview(bot: Bot, visible: Message[], instances: InstanceInfo[], advanced: boolean): string {
  if (bot.activity === "waiting-on-you") return t("sidebar.preview.waiting");
  if (bot.waitingForTeammates) return t("sidebar.preview.waitingOnTeammate");
  if (bot.busy) return t("sidebar.preview.working");
  const last = lastNonReceipt(visible);
  if (!last) return "";
  if (last.kind === "options" && last.card) {
    return (last.card.requestId && last.card.tool && !last.card.questionRequest && approvalCardOutcome(last.card)) || last.card.title;
  }
  if (last.kind === "activity" && last.tool) return activityPreview(last.tool, botEngine(bot, instances), last.dataResult, advanced);
  if (last.kind === "screen") return t("sidebar.preview.screenFrame");
  if (last.kind === "connector" && last.connector) return sidebarConnectorPreview(last.connector, t);
  const peer = peerLine(last);
  if (peer) return `${peer.name}: ${plainPreviewText(peer.body)}`;
  if (last.role !== "user" && isClientCancellation(last.text ?? "")) return t("chat.turnStopped");
  return plainPreviewText(citationPreviewText(last.text ?? ""));
}

export function groupPreview(group: Group, bots: Bot[], instances: InstanceInfo[], advanced: boolean): string {
  const working = roomWorkingPreview(group, (botId) => bots.find((b) => b.id === botId)?.name);
  if (working) return working;
  if (group.working) return t("sidebar.preview.teamWorking");
  const last = lastNonReceipt(group.messages);
  if (!last) return t("sidebar.preview.noMessages");
  if (last.kind === "text" && last.role !== "user" && isClientCancellation(last.text ?? "")) {
    const stopped = t("chat.turnStopped");
    return last.from ? `${last.from.name}: ${stopped}` : stopped;
  }
  const text = last.kind === "activity" && last.tool
    ? activityPreview(last.tool, botEngine(bots.find((bot) => bot.id === last.from?.botId), instances), last.dataResult, advanced)
    : last.kind === "goal.run" && last.goalRun
      ? sidebarGoalRunPreview(last.goalRun)
      : last.kind === "connector" && last.connector
        ? sidebarConnectorPreview(last.connector, t)
        : (last.text ?? "");
  const readable = plainPreviewText(citationPreviewText(text));
  if (last.role === "user") return t("sidebar.preview.you", { text: readable });
  return last.from ? `${last.from.name}: ${readable}` : readable;
}
