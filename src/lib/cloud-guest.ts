import { useEffect, useState } from "react";

import { readSessionState, type SessionState } from "./session";

let session: Promise<SessionState | null> | null = null;
const read = (fresh = false) => {
  if (fresh || !session) session = readSessionState().catch(() => null);
  return session;
};

export function canWriteIn(state: SessionState | null, threadId: string): boolean {
  if (state?.kind !== "session" || !state.cloudGuest) return true;
  return state.openedThreads?.includes(threadId) === true;
}

export function useCanWriteIn(threadId: string): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    setAllowed(null);
    void read().then(async (state) => {
      const known = canWriteIn(state, threadId) ? state : await read(true);
      if (alive) setAllowed(canWriteIn(known, threadId));
    });
    return () => {
      alive = false;
    };
  }, [threadId]);
  return allowed;
}
