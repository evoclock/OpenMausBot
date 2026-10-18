import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot, BotSettingsSection } from "@/state/store";
import { ChatMoreMenu } from "@/components/ChatMoreMenu";
import { useCaptionChrome } from "../DesktopCapabilities";
import { MemorySection } from "../bot-settings/MemorySection";
import { HistoryRollbackDialog, useBotHistory, useBotOverview } from "../bot-settings/useBotOverview";
import type { useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { AvatarEditorCard } from "./AvatarEditorCard";
import { ComputerTab } from "./ComputerTab";
import { DetailsTab } from "./DetailsTab";
import { LibraryTab } from "./LibraryTab";
import { PANEL_TABS, PAGES, TAB_LABEL, type PageId, type PanelTab, type PanelTarget } from "./page-registry";
import { PageBody, pageSurfaceCls } from "./pages";
import { linkTarget, usePanelLink, type PanelLink } from "./panel-link";
import { PanelHero } from "./PanelHero";
import { PageHeader } from "./rows";
import { SettingsTab } from "./SettingsTab";

const roundButtonCls = "flex size-8 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-ink hover:bg-ink/[0.11]";

function initialTarget(section: BotSettingsSection | null, link: PanelLink | null): PanelTarget {
  return section ? linkTarget(section, link) : { tab: "details" };
}

export function BotPanel({ bot, derived, slackUrl = null, headerClassName, linkedSection, onClose }: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
  slackUrl?: string | null;
  headerClassName?: string;
  linkedSection: BotSettingsSection | null;
  onClose: () => void;
}) {
  const { dragProps } = useCaptionChrome();
  const link = usePanelLink();
  const [tab, setTab] = useState<PanelTab>(() => initialTarget(linkedSection, link).tab);
  const [stack, setStack] = useState<PageId[]>(() => {
    const page = initialTarget(linkedSection, link).page;
    return page ? [page] : [];
  });
  const [anchor, setAnchor] = useState<string | null>(() => initialTarget(linkedSection, link).anchor ?? null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [memoryMounted, setMemoryMounted] = useState(() => initialTarget(linkedSection, link).page === "memory");
  const [query, setQuery] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const page = stack.at(-1) ?? null;

  // Read when a view that shows it appears (the Details tab's setup row, the Setup and Overview pages), never while
  // the Details tab's own fields are being typed into.
  const overview = useBotOverview(bot, {
    overview: (page === null && tab === "details") || page === "setup" || page === "overview",
    prompt: page === "prompt" || page === "overview",
    followEdits: false,
  });
  const history = useBotHistory(bot, page === "history");

  const scrollTop = () => bodyRef.current?.scrollTo({ top: 0 });
  const go = (target: PanelTarget) => {
    setTab(target.tab);
    setStack(target.page ? [target.page] : []);
    setAnchor(target.anchor ?? null);
    setEditorOpen(false);
    if (target.page === "memory") setMemoryMounted(true);
    scrollTop();
  };
  const openTab = (next: PanelTab) => go({ tab: next });
  const openPage = (next: PageId) => {
    setStack((current) => [...current, next]);
    setEditorOpen(false);
    if (next === "memory") setMemoryMounted(true);
    scrollTop();
  };
  const closeEditor = () => {
    setEditorOpen(false);
    // The card held focus: hand it back to the avatar that opened it, before the card goes, not to the page body.
    editorRef.current?.querySelector<HTMLElement>("[data-panel-avatar]")?.focus();
  };
  const back = () => {
    setStack((current) => current.slice(0, -1));
    scrollTop();
  };

  // A new link re-runs this even when it names the section already linked, so a repeated link lands there again.
  useEffect(() => {
    if (linkedSection) go(linkTarget(linkedSection, link));
  }, [linkedSection, link]);

  useEffect(() => {
    if (!anchor || page) return;
    bodyRef.current?.querySelector(`[data-panel-card="${anchor}"]`)?.scrollIntoView({ block: "start" });
    setAnchor(null);
  }, [anchor, page, tab]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target as Partial<Element> | null;
    const inDialog = typeof target?.closest === "function" ? target.closest('[role="dialog"], [role="alertdialog"]') : null;
    // A dialog of its own (one this panel opened, perhaps portaled) owns its Escape; the settings dialog this panel
    // sits in, and the avatar editor, do not.
    const ownDialog = inDialog && !inDialog.contains(event.currentTarget) && inDialog !== editorRef.current && !editorRef.current?.contains(inDialog);
    if (ownDialog) return;
    if (editorOpen) closeEditor();
    else if (stack.length > 0) back();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const backLabel = stack.length > 1 ? t(PAGES[stack[stack.length - 2]!].title, { name: bot.name }) : t(TAB_LABEL[tab]);
  const header = page ? (
    <PageHeader
      back={backLabel}
      title={t(PAGES[page].title, { name: bot.name })}
      intro={page === "setup" ? t("botSetup.optional") : undefined}
      onBack={back}
    />
  ) : null;

  const context = { bot, derived, slackUrl, overview, history, onOpen: openPage, onGo: go };

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div {...dragProps} className={cn("flex h-[52px] shrink-0 items-center justify-end gap-2 px-3.5", headerClassName)}>
        <ChatMoreMenu bot={bot} />
        <button type="button" onClick={onClose} aria-label={t("botSettings.simple.close")} className={roundButtonCls}>
          <X size={16} className="pointer-events-none" />
        </button>
      </div>

      <div ref={bodyRef} className="@container relative min-h-0 flex-1 overflow-y-auto px-5 pb-7">
        {page === null ? (
          <>
            <div className="relative" ref={editorRef}>
              <PanelHero
                bot={bot}
                activeState={derived.activeState}
                patch={derived.patch}
                editorOpen={editorOpen}
                onToggleEditor={() => setEditorOpen((open) => !open)}
              />
              {editorOpen && (
                <>
                  <div className="fixed inset-0 z-20" aria-hidden="true" data-panel-scrim onClick={closeEditor} />
                  <AvatarEditorCard bot={bot} activeState={derived.activeState} onPatch={derived.patch} onClose={closeEditor} />
                </>
              )}
            </div>
            <div role="tablist" aria-label={t("botSettings.simple.tabs")} className="mt-4 flex justify-center gap-1">
              {PANEL_TABS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  data-panel-tab={id}
                  onClick={() => openTab(id)}
                  className={cn(
                    "min-w-0 truncate rounded-full px-[13px] py-1.5 text-[13.5px] transition-colors @max-[20rem]:px-2 @max-[20rem]:text-[12.5px]",
                    tab === id ? "bg-ink/[0.07] font-medium text-ink" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  {t(TAB_LABEL[id])}
                </button>
              ))}
            </div>
            <div role="tabpanel">
              {tab === "details" && <DetailsTab bot={bot} derived={derived} overview={overview.overview} onOpen={openPage} />}
              {tab === "library" && <LibraryTab bot={bot} onOpen={openPage} />}
              {tab === "computer" && <ComputerTab bot={bot} derived={derived} onOpen={openPage} />}
              {tab === "settings" && (
                <SettingsTab bot={bot} derived={derived} slackUrl={slackUrl} query={query} onQuery={setQuery} onOpen={openPage} onGo={go} />
              )}
            </div>
          </>
        ) : page !== "memory" && (
          <div data-panel-page-view={page}>
            <span id="bot-settings-title" className="sr-only">{bot.name}</span>
            {header}
            <div className={cn("mt-4", pageSurfaceCls)}>
              <PageBody page={page} {...context} />
            </div>
          </div>
        )}
        {memoryMounted && (
          <div data-panel-page-view="memory" hidden={page !== "memory"}>
            {page === "memory" && <><span id="bot-settings-title" className="sr-only">{bot.name}</span>{header}</>}
            <div className={cn("mt-4", pageSurfaceCls)}>
              <MemorySection bot={bot} active={page === "memory"} onToggle={(enabled) => derived.patch({ memoryEnabled: enabled })} />
            </div>
          </div>
        )}
      </div>
      <HistoryRollbackDialog history={history} />
    </div>
  );
}
