import { useState, type ReactNode } from "react";
import {
  Archive, AudioWaveform, Check, CheckCheck, Copy, FileCode2, FileText, History, LayoutGrid, Lock, Phone, Puzzle, Search,
  SlidersHorizontal, Slack, Smartphone, Trash2, Users, Zap, ClipboardCopy, Loader2,
} from "lucide-react";

import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { setAdvancedMode, useAdvancedMode } from "@/lib/interface-mode";
import { requestNotificationPermission } from "@/lib/notify";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore, type Bot } from "@/state/store";
import { ConfirmDialog } from "../ConfirmDialog";
import { PhoneAppDialog } from "../PhoneAppDialog";
import { botConfirmCopy } from "../Sidebar";
import { UsageSection } from "../bot-settings/UsageSection";
import { formFromVisibility } from "../bot-settings/VisibilitySection";
import type { useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { useBotActions } from "./bot-actions";
import { PAGES, type PageId, type PanelTarget } from "./page-registry";
import { Card, ColRow, ItemRow, LinkRow, NavRow, NoteRow, SoonBadge, SwitchRow } from "./rows";

type Derived = ReturnType<typeof useBotSettingsDerived>;

interface SettingRow {
  key: string;
  text: string;
  node: ReactNode;
  page?: PageId;
}

interface Jump {
  key: string;
  title: string;
  where: LocaleKey;
  target: PanelTarget;
  keywords: string;
}

const VISIBILITY_VALUE = {
  everyone: "botPanel.visibility.everyone",
  admins: "botSettings.visibility.admins",
  people: "botSettings.visibility.people",
} as const satisfies Record<string, LocaleKey>;

export function availablePages(bot: Bot, options: { slack: boolean; visibility: boolean; android: boolean }): PageId[] {
  return (Object.keys(PAGES) as PageId[]).filter((page) =>
    (page !== "slack" || options.slack)
    && (page !== "visibility" || options.visibility)
    && (page !== "android" || options.android)
    && (page !== "chiefteams" || Boolean(bot.chiefOfStaff)));
}

export function SettingsTab({ bot, derived, slackUrl, query, onQuery, onOpen, onGo }: {
  bot: Bot;
  derived: Derived;
  slackUrl: string | null;
  query: string;
  onQuery: (query: string) => void;
  onOpen: (page: PageId) => void;
  onGo: (target: PanelTarget) => void;
}) {
  const { state, dispatch } = useStore();
  const actions = useBotActions(bot);
  const ownerOrAdmin = useOwnerOrAdmin();
  const advanced = useAdvancedMode();
  const [phoneAppOpen, setPhoneAppOpen] = useState(false);
  const { patch, canCoordinate, sectionName } = derived;
  const displaySectionName = sectionName === "General" ? t("botAccess.teams.general") : sectionName;
  const visibilityShown = !window.ogb && ownerOrAdmin === true;
  const webhooks = state.webhooks.filter((webhook) => webhook.botId === bot.id).length;
  const alwaysAllowed = bot.alwaysAllow?.length ?? 0;
  const none = t("botPanel.none");
  const name = bot.name;

  const page = (key: PageId, icon: Parameters<typeof NavRow>[0]["icon"], hint?: string, value?: ReactNode): SettingRow => {
    const title = t(PAGES[key].title, { name });
    return {
      key,
      page: key,
      text: `${title} ${hint ?? ""}`,
      node: <NavRow key={key} data-panel-page={key} icon={icon} title={title} hint={hint} value={value} onClick={() => onOpen(key)} />,
    };
  };
  const inline = (key: string, text: string, node: ReactNode): SettingRow => ({ key, text, node });

  const cards: Array<{ label: string | null; anchor: string; rows: SettingRow[] }> = [
    { label: t("botPanel.card.profile"), anchor: "profile", rows: [
      page("blurb", FileText, bot.description.trim() || t("botPanel.blurbHint")),
      page("voice", AudioWaveform, t("botPanel.voiceHint")),
      inline("notify", `${t("notifications.title")} ${t("botPanel.notificationsHint")} alerts`, (
        <SwitchRow
          key="notify"
          data-panel-row="notify"
          title={t("notifications.title")}
          hint={t("botPanel.notificationsHint")}
          color={bot.color}
          checked={bot.notifications}
          onChange={() => {
            const enabled = !bot.notifications;
            if (enabled) void requestNotificationPermission();
            patch({ notifications: enabled });
          }}
        />
      )),
    ] },
    { label: t("botPanel.card.teamwork"), anchor: "teamwork", rows: [
      page("team", Users, undefined, displaySectionName),
      inline("chief", `${t("sidebar.bot.chiefOfStaff")} chief of staff`, (
        <SwitchRow
          key="chief"
          data-panel-row="chief"
          title={t("sidebar.bot.chiefOfStaff")}
          hint={t("botPanel.chiefHint", { team: displaySectionName })}
          color={bot.color}
          checked={Boolean(bot.chiefOfStaff)}
          disabled={!bot.chiefOfStaff && !canCoordinate}
          tooltip={!bot.chiefOfStaff && !canCoordinate ? t("sidebar.bot.chiefNeedsEngine") : undefined}
          onChange={() => patch({ chiefOfStaff: !bot.chiefOfStaff })}
        />
      )),
      ...(bot.chiefOfStaff ? [page("chiefteams", undefined, t("botPanel.chiefTeamsHint"), (bot.managedSections ?? []).length || none)] : []),
      inline("peers", `${t("botPanel.askBeforePeers")} peers contact coordination`, (
        <SwitchRow
          key="peers"
          data-panel-row="peers"
          title={t("botPanel.askBeforePeers")}
          color={bot.color}
          checked={Boolean(bot.approvePeerComms)}
          disabled={!bot.approvePeerComms && !canCoordinate}
          tooltip={!bot.approvePeerComms && !canCoordinate ? t("botPanel.peersNeedEngine") : undefined}
          onChange={() => patch({ approvePeerComms: !bot.approvePeerComms })}
        />
      )),
    ] },
    { label: t("botPanel.card.tools"), anchor: "tools", rows: [
      page("mcp", Puzzle, t("botPanel.mcpHint"), bot.mcpServers == null ? t("botPanel.all") : bot.mcpServers.length),
      page("tools", SlidersHorizontal, t("botPanel.toolsHint")),
      page("webhooks", Zap, t("botPanel.webhooksHint"), webhooks || none),
      page("always", Check, t("botPanel.alwaysHint"), alwaysAllowed || none),
    ] },
    { label: t("botPanel.card.sharing"), anchor: "sharing", rows: [
      inline("phoneapp", `${t("botPanel.phoneApp")} iphone android`, (
        <NavRow key="phoneapp" data-panel-row="phoneapp" icon={Smartphone} title={t("botPanel.phoneApp")} hint={t("botPanel.phoneAppHint")} onClick={() => setPhoneAppOpen(true)} />
      )),
      ...(slackUrl ? [page("slack", Slack, t("botPanel.slackHint"))] : []),
      ...(visibilityShown ? [page("visibility", Lock, t("botPanel.visibilityHint"), t(VISIBILITY_VALUE[formFromVisibility(bot.visibility).mode]))] : []),
      inline("contact", `${t("botPanel.phoneEmail")} ${t("botPanel.phoneEmailHint")} number inbox`, (
        <ItemRow key="contact" data-panel-row="contact" icon={Phone} title={t("botPanel.phoneEmail")} hint={t("botPanel.phoneEmailHint")}>
          <SoonBadge />
        </ItemRow>
      )),
    ] },
    { label: t("botPanel.card.activity"), anchor: "activity", rows: [
      inline("usage", `${t("usage.title")} tokens cost billing turns`, <ColRow key="usage" data-panel-row="usage"><UsageSection bot={bot} bare /></ColRow>),
      page("overview", LayoutGrid, t("botPanel.overviewHint")),
      page("prompt", FileCode2, t("botPanel.promptHint")),
      page("history", History, t("botPanel.historyHint")),
      inline("all-usage", `${t("botPanel.allUsage")} usage`, (
        <LinkRow key="all-usage" data-panel-link="all-usage" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}>
          {t("botPanel.allUsage")}
        </LinkRow>
      )),
    ] },
    { label: name, anchor: "bot", rows: [
      inline("pin", `${t("botPanel.pin")} pin`, (
        <SwitchRow key="pin" data-panel-row="pin" title={t("botPanel.pin")} color={bot.color} checked={Boolean(bot.pinned)} onChange={actions.togglePin} />
      )),
      inline("duplicate", t("sidebar.bot.duplicate"), (
        <NavRow key="duplicate" data-panel-row="duplicate" icon={Copy} title={t("sidebar.bot.duplicate")} drill={false} onClick={actions.duplicate} />
      )),
      inline("copy-id", t("sidebar.copyConversationId"), (
        <NavRow
          key="copy-id"
          data-panel-row="copy-id"
          icon={ClipboardCopy}
          title={t("sidebar.copyConversationId")}
          value={actions.copyState === "copied" ? t("chat.copyMessageDone") : actions.copyState === "failed" ? t("chat.copyMessageFailed") : undefined}
          drill={false}
          onClick={actions.copyId}
        />
      )),
      inline("read", t("sidebar.bot.markAllRead"), (
        <NavRow
          key="read"
          data-panel-row="read"
          icon={actions.reading ? Loader2 : CheckCheck}
          title={t(actions.reading ? "sidebar.bot.markingAllRead" : "sidebar.bot.markAllRead")}
          hint={actions.readError ?? undefined}
          drill={false}
          disabled={actions.reading || !actions.hasUnread}
          onClick={actions.markAllRead}
        />
      )),
      inline("archive", `${t("botPanel.archive", { name })} ${t("botPanel.archiveHint")}`, (
        <NavRow
          key="archive"
          data-panel-row="archive"
          icon={Archive}
          title={t("botPanel.archive", { name })}
          hint={actions.archiveHint ?? t("botPanel.archiveHint")}
          drill={false}
          disabled={actions.archiveBlocked}
          onClick={actions.requestArchive}
        />
      )),
      inline("delete", `${t("botPanel.delete", { name })} ${t("botPanel.deleteHint")}`, (
        <NavRow
          key="delete"
          data-panel-row="delete"
          title={t(actions.deleting ? "sidebar.bot.deleteChecking" : "botPanel.delete", { name })}
          hint={t("botPanel.deleteHint")}
          danger
          drill={false}
          disabled={actions.deleting}
          onClick={actions.requestDelete}
        />
      )),
    ] },
    { label: null, anchor: "mode", rows: [
      inline("advanced", `${t("settings.advancedMode.title")} ${t("botPanel.advancedHint")}`, (
        <SwitchRow
          key="advanced"
          data-panel-row="advanced"
          title={t("settings.advancedMode.title")}
          hint={t("botPanel.advancedHint")}
          color={bot.color}
          checked={advanced}
          onChange={() => setAdvancedMode(!advanced)}
        />
      )),
    ] },
  ];

  const pages = availablePages(bot, { slack: Boolean(slackUrl), visibility: visibilityShown, android: Boolean(window.ogb?.androidDevice) });
  const jumps: Jump[] = [
    { key: "rename", title: t("botPanel.jump.name"), where: "botSettings.simple.details", target: { tab: "details" }, keywords: "name rename label title job" },
    { key: "avatar", title: t("botPanel.avatar.edit"), where: "botSettings.simple.details", target: { tab: "details" }, keywords: "avatar look color colour body face expression picture image upload generate mascot" },
    { key: "thinking", title: t("botSettings.simple.thinking"), where: "botPanel.where.model", target: { tab: "details", anchor: "model" }, keywords: "thinking effort reasoning quick balanced deep" },
    { key: "reply", title: t("botSettings.replyStyle.title"), where: "botPanel.where.instructions", target: { tab: "details", anchor: "instructions" }, keywords: "reply style conversational" },
    { key: "acts", title: t("botSettings.simple.beforeActs", { name }), where: "botSettings.simple.details", target: { tab: "details", anchor: "approval" }, keywords: "approval ask decide full access" },
    { key: "where", title: t("computer.simple.whereWorks", { name }), where: "computer.tab.computer", target: { tab: "computer", anchor: "where" }, keywords: "works on computer place auto this mac cloud computer vm browser off backend vps" },
    { key: "files", title: t("botPanel.library.files"), where: "botSettings.simple.library", target: { tab: "library", anchor: "files" }, keywords: "files pages attachments library" },
  ];

  const q = query.trim().toLowerCase();
  let body: ReactNode;
  if (!q) {
    body = cards.map((card) => (
      <Card key={card.anchor} label={card.label ?? undefined} anchor={card.anchor}>{card.rows.map((row) => row.node)}</Card>
    ));
  } else {
    const where = (key: LocaleKey) => t(key);
    const pageHits = pages
      .filter((id) => `${t(PAGES[id].title, { name })} ${PAGES[id].keywords}`.toLowerCase().includes(q))
      .map((id) => (
        <NavRow key={`page:${id}`} data-panel-page={id} title={t(PAGES[id].title, { name })} hint={where(PAGES[id].where)} onClick={() => onOpen(id)} />
      ));
    const rowHits = cards.flatMap((card) => card.rows)
      .filter((row) => !row.page && row.text.toLowerCase().includes(q))
      .map((row) => row.node);
    const jumpHits = jumps
      .filter((jump) => `${jump.title} ${jump.keywords}`.toLowerCase().includes(q))
      .map((jump) => (
        <NavRow key={`jump:${jump.key}`} data-panel-jump={jump.key} title={jump.title} hint={where(jump.where)} onClick={() => onGo(jump.target)} />
      ));
    const hits = [...pageHits, ...rowHits, ...jumpHits];
    body = hits.length > 0 ? (
      <Card label={hits.length === 1 ? t("botPanel.search.one") : t("botPanel.search.many", { count: hits.length })} anchor="results">{hits}</Card>
    ) : (
      <Card anchor="results"><NoteRow>{t("botPanel.search.none", { query: query.trim() })}</NoteRow></Card>
    );
  }

  const confirmCopy = botConfirmCopy(actions.confirm ?? "archive", name);
  return (
    <div data-panel-tabpanel="settings">
      <label className="mt-[18px] flex h-[34px] items-center gap-[7px] rounded-full bg-ink/[0.08] pl-3 pr-2 text-ink-secondary">
        <Search size={14} className="shrink-0" aria-hidden="true" />
        <input
          data-panel-search
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !query) return;
            event.preventDefault();
            event.stopPropagation();
            onQuery("");
          }}
          placeholder={t("botPanel.search.placeholder")}
          aria-label={t("botPanel.search.label")}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-tertiary"
        />
      </label>
      {body}
      <PhoneAppDialog open={phoneAppOpen} onClose={() => setPhoneAppOpen(false)} />
      <ConfirmDialog
        open={actions.confirm !== null}
        {...confirmCopy}
        icon={actions.confirm === "delete" ? <Trash2 size={18} /> : <Archive size={18} />}
        onCancel={actions.cancelConfirm}
        onConfirm={actions.confirmed}
      />
    </div>
  );
}
