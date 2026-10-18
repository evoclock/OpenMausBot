import { useEffect, useState } from "react";

import { isOwnerOrAdmin, readSessionState } from "./session";

let pending: Promise<boolean> | null = null;

function ownerOrAdmin(): Promise<boolean> {
  pending ??= readSessionState().then(isOwnerOrAdmin, () => false);
  return pending;
}

export function useOwnerOrAdmin(): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void ownerOrAdmin().then((value) => {
      if (alive) setAllowed(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return allowed;
}
