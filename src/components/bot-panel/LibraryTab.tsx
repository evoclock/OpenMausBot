import { useEffect, useMemo, useState } from "react";
import { AppWindow, FileText, Image as ImageIcon } from "lucide-react";

import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { fetchMemoryDoc, MEMORY_INDEX } from "@/lib/memory";
import { useStore, type Bot } from "@/state/store";
import { SkillReviewDialog, useManagedSkills } from "../bot-settings/SkillsSection";
import { botLibraryItems, isPageItem, memoryEntries, type LibraryItem } from "./library-items";
import type { PageId } from "./page-registry";
import { Card, LabelAction, LinkRow, NoteRow, rowCls, SwitchRow } from "./rows";

export type LibraryFilter = "all" | "memories" | "files" | "pages" | "skills";

const FILTERS: ReadonlyArray<readonly [LibraryFilter, LocaleKey]> = [
  ["all", "botPanel.library.all"],
  ["memories", "botPanel.library.memories"],
  ["files", "botPanel.library.files"],
  ["pages", "botPanel.library.pages"],
  ["skills", "botSettings.simple.skills"],
];

const MEMORIES_SHOWN = 5;

const dateLabel = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function LibraryTab({ bot, onOpen }: { bot: Bot; onOpen: (page: PageId) => void }) {
  const { dispatch } = useStore();
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [memory, setMemory] = useState<{ botId: string; entries: string[] } | null>(null);
  const [memoryError, setMemoryError] = useState(false);
  const skills = useManagedSkills(bot);
  const memoryOn = bot.memoryEnabled !== false;
  const items = useMemo(() => botLibraryItems(bot), [bot]);
  const files = items.filter((item) => !isPageItem(item));
  const pages = items.filter(isPageItem);
  const shows = (part: LibraryFilter) => filter === "all" || filter === part;

  useEffect(() => {
    if (!memoryOn) return;
    let cancelled = false;
    setMemoryError(false);
    fetchMemoryDoc(bot.id, MEMORY_INDEX)
      .then((doc) => { if (!cancelled) setMemory({ botId: bot.id, entries: memoryEntries(doc.text) }); })
      .catch(() => { if (!cancelled) setMemoryError(true); });
    return () => { cancelled = true; };
  }, [bot.id, memoryOn]);

  const entries = memory?.botId === bot.id ? memory.entries : null;
  const openItem = (item: LibraryItem) => dispatch({ type: "focusMessage", threadId: bot.threadId, messageId: item.messageId });
  const manage = (page: PageId) => (
    <LabelAction data-panel-action={page} onClick={() => onOpen(page)}>{t("botPanel.library.manage")}</LabelAction>
  );
  const counted = (key: LocaleKey, count: number | null) => (count ? `${t(key)} · ${count}` : t(key));

  return (
    <div data-panel-tabpanel="library">
      <div role="group" aria-label={t("botSettings.simple.library")} className="mt-[18px] flex flex-wrap gap-1.5">
        {FILTERS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            data-library-filter={id}
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
            className={filter === id
              ? "rounded-full bg-ink px-[11px] py-[5px] text-[12.5px] font-medium text-panel"
              : "rounded-full bg-ink/[0.04] px-[11px] py-[5px] text-[12.5px] text-ink-secondary hover:text-ink"}
          >
            {t(label)}
          </button>
        ))}
      </div>

      {shows("memories") && (
        <Card label={counted("botPanel.library.memories", entries?.length ?? null)} action={manage("memory")} anchor="memories">
          {!memoryOn ? (
            <NoteRow>{t("botPanel.library.memoryOff", { name: bot.name })}</NoteRow>
          ) : memoryError ? (
            <NoteRow>{t("botPanel.library.memoryError")}</NoteRow>
          ) : entries === null ? (
            <NoteRow>{t("common.checking")}</NoteRow>
          ) : entries.length === 0 ? (
            <NoteRow>{t("botPanel.library.memoryEmpty", { name: bot.name })}</NoteRow>
          ) : (
            <>
              {entries.slice(0, MEMORIES_SHOWN).map((entry, index) => (
                <div key={`${index}:${entry}`} data-library-memory className="px-3.5 py-2.5 text-[13px] leading-[1.45] text-ink">{entry}</div>
              ))}
              {entries.length > MEMORIES_SHOWN && (
                <LinkRow data-panel-link="memory" onClick={() => onOpen("memory")}>
                  {t("botPanel.library.memoryMore", { count: entries.length - MEMORIES_SHOWN })}
                </LinkRow>
              )}
            </>
          )}
        </Card>
      )}

      {shows("files") && (
        files.length === 0 ? (
          <Card label={t("botPanel.library.files")} anchor="files">
            <NoteRow>{t("botPanel.library.filesEmpty", { name: bot.name })}</NoteRow>
          </Card>
        ) : (
          <section data-panel-card="files">
            <div className="mx-1 mb-2 mt-5 text-[12.5px] text-ink-secondary">{counted("botPanel.library.files", files.length)}</div>
            <div className="grid grid-cols-2 gap-2">
              {files.map((item) => {
                const Icon = item.kind === "image" ? ImageIcon : FileText;
                return (
                  <button
                    key={item.key}
                    type="button"
                    data-library-item={item.messageId}
                    title={t("botSettings.simple.libraryOpen", { name: item.name })}
                    onClick={() => openItem(item)}
                    className="flex min-w-0 flex-col gap-2 rounded-xl border border-ink/[0.04] bg-ink/[0.03] p-2.5 text-left hover:bg-ink/[0.05]"
                  >
                    <span className="flex h-16 items-center justify-center rounded-lg bg-ink/[0.04] text-ink-secondary">
                      <Icon size={22} strokeWidth={1.6} aria-hidden="true" />
                    </span>
                    <span className="truncate text-[12.5px] font-medium text-ink">{item.name}</span>
                    <span className="text-[11.5px] text-ink-tertiary">{dateLabel(item.at)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )
      )}

      {shows("pages") && (
        <Card label={t("botPanel.library.pagesTitle")} anchor="pages">
          {pages.length === 0 ? (
            <NoteRow>{t("botPanel.library.pagesEmpty", { name: bot.name })}</NoteRow>
          ) : pages.map((item) => (
            <button
              key={item.key}
              type="button"
              data-library-item={item.messageId}
              title={t("botSettings.simple.libraryOpen", { name: item.name })}
              onClick={() => openItem(item)}
              className={`${rowCls} w-full text-left hover:bg-ink/[0.03]`}
            >
              <AppWindow size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{item.name}</span>
              <span className="shrink-0 text-[12px] text-ink-tertiary">{dateLabel(item.at)}</span>
            </button>
          ))}
        </Card>
      )}

      {shows("skills") && (
        <Card label={counted("botSettings.simple.skills", skills.skills.length)} action={manage("skills")} anchor="skills">
          {!skills.loading && skills.skills.length === 0 ? (
            <NoteRow>{t("botSettings.simple.noSkills")}</NoteRow>
          ) : skills.skills.map((skill) => (
            <SwitchRow
              key={skill.name}
              data-panel-row={`skill:${skill.name}`}
              title={skill.name}
              hint={skill.description || skill.source}
              label={t("botSettings.simple.skillToggle", { name: skill.name })}
              color={bot.color}
              checked={skill.enabled}
              disabled={Boolean(skills.working)}
              onChange={() => void skills.toggle(skill)}
            />
          ))}
          {skills.error && !skills.reviewing && <NoteRow tone="warn">{skills.error}</NoteRow>}
          <LinkRow data-panel-link="skills" onClick={() => onOpen("skills")}>{t("botPanel.library.writeCommand")}</LinkRow>
        </Card>
      )}

      {skills.reviewing && (
        <SkillReviewDialog
          skill={skills.reviewing.skill}
          text={skills.reviewing.text}
          error={skills.error}
          working={skills.working === skills.reviewing.skill.name}
          onCancel={() => skills.setReviewing(null)}
          onEnable={() => void skills.enableReviewed()}
        />
      )}
    </div>
  );
}
