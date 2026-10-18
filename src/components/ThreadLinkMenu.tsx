import { createContext, useContext, useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Link2, Link2Off, Pin } from "lucide-react";
import { t } from "@/lib/i18n";
import { copyText } from "@/lib/copy-text";
import { threadLinkUrl } from "../../shared/thread-link";

export const ThreadLinkContext = createContext<{ link?: string; assign: (link: string | null) => void } | null>(null);

const ITEM_CLASS = "flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-[12px] text-ink hover:bg-raised";

export function useThreadLinkMenu(href: string | undefined) {
  const thread = useContext(ThreadLinkContext);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: Event) => { if (!(event.target instanceof Node && menuRef.current?.contains(event.target))) setAt(null); };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("scroll", close, true); };
  }, [at]);
  const url = threadLinkUrl(href);
  if (!thread || !url) return { onContextMenu: undefined, menu: null };
  const assigned = thread.link === url;
  const run = (action: () => void) => () => { setAt(null); action(); };
  return {
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      setAt({ left: Math.max(8, Math.min(event.clientX, window.innerWidth - 228)), top: Math.max(8, Math.min(event.clientY, window.innerHeight - 100)) });
    },
    menu: at && createPortal(<div ref={menuRef} role="group" aria-label={url} style={at}
      className="fixed z-50 w-[220px] rounded-lg border border-hairline/50 bg-card p-1 shadow-xl"
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setAt(null); } }}>
      <button type="button" onClick={run(() => thread.assign(assigned ? null : url))} className={ITEM_CLASS}>
        {assigned ? <Link2Off size={12} /> : <Pin size={12} />}{t(assigned ? "task.unassignLink" : "task.assignLink")}
      </button>
      <button type="button" onClick={run(() => void copyText(url))} className={ITEM_CLASS}><Link2 size={12} />{t("task.copyLink")}</button>
    </div>, document.body),
  };
}
