import { useEffect, useState } from "react";
import { api } from "@/state/store";

type Status = { available: boolean; action?: string; skill?: { ready: boolean; action: string }; roles?: Record<"development" | "independent-review", { ready: boolean; action: string }> };

export function PiReadiness({ botId }: { botId: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let active = true;
    api<Status>(`/api/pi/readiness?botId=${encodeURIComponent(botId)}`).then((next) => { if (active) setStatus(next); }).catch(() => {});
    return () => { active = false; };
  }, [botId]);
  if (!status || !status.available) return null;
  const checks = [
    ["Pi skill", status.skill],
    ["Development", status.roles?.development],
    ["Independent review", status.roles?.["independent-review"]],
  ] as const;
  return <section className="rounded-xl bg-card p-4" aria-label="Pi coding readiness">
    <div className="text-[15px] font-medium text-ink">Pi coding readiness</div>
    <p className="mt-1 text-[13px] text-ink-secondary">Configure the private role file for this server’s working repository. Bot standing instructions are in Soul; this status does not enable a coding runner.</p>
    <ul className="mt-2 text-[13px] text-ink-secondary">
      {checks.map(([label, check]) => <li key={label}>{label}: {check?.ready ? "Available in Pi" : check?.action || "Not checked"}</li>)}
    </ul>
  </section>;
}
