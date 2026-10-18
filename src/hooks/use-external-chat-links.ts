import { useEffect, useState } from "react";
import { openChatLink } from "@/components/ThreadRefs";
import { useShowThreads } from "@/lib/thread-preferences";
import type { Action, AppState } from "@/state/store";

export function useExternalChatLinks(state: AppState, dispatch: (action: Action) => void): void {
  const [link, setLink] = useState<string | null>(null);
  const showThreads = useShowThreads();
  useEffect(() => window.ogb?.onChatLink?.(setLink), []);
  useEffect(() => {
    if (!link || !state.hydrated) return;
    setLink(null);
    if (state.appSettingsOpen) dispatch({ type: "toggleAppSettings", open: false });
    if (state.shortcutsOpen) dispatch({ type: "toggleShortcuts", open: false });
    openChatLink(dispatch, link, state, showThreads);
  }, [link, state, showThreads, dispatch]);
}
