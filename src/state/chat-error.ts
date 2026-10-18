import { useEffect } from "react";

export const CHAT_ERROR_CLEAR_MS = 6_000;

export function useChatErrorClear(error: string | null, clear: () => void): void {
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(clear, CHAT_ERROR_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [error, clear]);
}
