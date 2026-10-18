import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, RefreshCw } from "lucide-react";
import { EngineSetup } from "@/components/EngineSetup";
import { engineReady } from "@/components/EngineLibrary";
import { InstanceProviderMark } from "@/components/ProviderIcons";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { engineSummary, organisationSignIn } from "@/lib/onboarding";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { OrganisationRow } from "./OrganisationRow";
import { PrimaryButton, staggerIndex, type BeatProps } from "./shared";

function version(instance: InstanceInfo): string | null {
  return instance.snapshot.version ? instance.snapshot.version.split(" ")[0]! : null;
}

function StatusPill({ ready }: { ready: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
        ready ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
      )}
    >
      <span className={cn("size-1.5 rounded-full", ready ? "bg-success" : "bg-warning")} aria-hidden="true" />
      {ready ? t("onboarding.engines.ready") : t("onboarding.engines.needsSetup")}
    </span>
  );
}

function SkeletonRow({ index }: { index: number }) {
  return (
    <div className="animate-rise flex items-center gap-3 px-3.5 py-3" style={staggerIndex(index)} aria-hidden="true">
      <span className="size-[18px] rounded-md bg-raised" />
      <span className="h-3 w-32 rounded bg-raised" />
      <span className="ml-auto h-4 w-14 rounded-full bg-raised" />
    </div>
  );
}

export function EnginesBeat({
  onNext,
  setMascot,
  bump,
  hosted = false,
  onOpenOrganisation,
}: BeatProps & {
  hosted?: boolean;
  onOpenOrganisation?: () => void;
}) {
  const { state, dispatch } = useStore();
  const organisation = organisationSignIn(window.ogb, { hosted });
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const latestRequest = useRef(0);
  const instances = loaded || state.instances.length ? state.instances : null;
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    setChecking(true);
    try {
      const d = await api("/api/instances", { signal: AbortSignal.timeout(10_000) });
      if (request !== latestRequest.current) return;
      dispatch({ type: "instances", instances: d.instances ?? [] });
      setLoaded(true);
      setFailed(false);
    } catch {
      if (request === latestRequest.current) setFailed(true);
    } finally {
      if (request === latestRequest.current) setChecking(false);
    }
  }, [dispatch]);

  useEffect(() => {
    void refresh();
    return () => {
      latestRequest.current++;
    };
  }, [refresh]);

  const summary = engineSummary(instances ?? [], engineReady, { company: Boolean(organisation) });
  const { ready, setup } = summary;
  const allReady = instances !== null && summary.allReady;
  const expanded = open;

  useEffect(() => {
    if (instances === null) {
      setMascot("searching");
      return;
    }
    if (allReady) {
      setMascot("proud");
      bump("success");
    } else {
      setMascot("curious");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instances === null, allReady, setup.length]);

  return (
    <div className="flex min-h-0 flex-col">
      <p className="animate-rise mt-1 text-[13.5px] text-ink-secondary">{t("onboarding.engines.intro")}</p>

      {organisation && (
        <OrganisationRow
          bridge={organisation}
          onOpenSettings={() => (onOpenOrganisation ? onOpenOrganisation() : dispatch({ type: "toggleAppSettings", open: true, section: "organization" }))}
          onConnected={() => void refresh()}
        />
      )}

      <div className="animate-rise mt-4 flex items-center justify-between gap-3" style={staggerIndex(1)}>
        <div className={cn("flex items-center gap-2 text-[12.5px]", allReady ? "text-success" : "text-ink-secondary")} aria-live="polite">
          {instances === null ? (
            <span>{failed ? t("onboarding.engines.error") : t("common.checking")}</span>
          ) : allReady ? (
            <>
              <Check size={14} strokeWidth={2.5} />
              <span>{t("onboarding.engines.allReady")}</span>
            </>
          ) : (
            <span className="tabular-nums">
              {t("onboarding.engines.readyCount", { count: ready.length })}
              <span className="mx-1.5 text-hairline">·</span>
              {t("onboarding.engines.setupCount", { count: setup.length })}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={checking}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-secondary transition-colors hover:bg-raised hover:text-ink disabled:opacity-50"
        >
          <RefreshCw size={12} className={checking ? "animate-spin" : ""} />
          {checking ? t("common.checking") : t("common.checkAgain")}
        </button>
      </div>
      {failed && instances !== null && <p role="alert" className="mt-2 text-[13px] text-danger">{t("onboarding.engines.error")}</p>}
      {summary.company > 0 && ready.length + setup.length > 0 && (
        <p className="mt-2 text-[12px] text-ink-secondary">{t("onboarding.org.personalOptional")}</p>
      )}

      <div
        className="animate-rise mt-2.5 min-h-0 divide-y divide-hairline/40 overflow-y-auto rounded-xl border border-hairline/40 bg-card [scrollbar-width:thin]"
        style={staggerIndex(2)}
      >
        {instances === null
          ? !failed && [0, 1, 2].map((i) => <SkeletonRow key={i} index={i} />)
          : [...ready, ...setup].map((instance, i) => {
              const ok = engineReady(instance);
              const v = version(instance);
              return (
                <div key={instance.instanceId} className="animate-rise" style={staggerIndex(i)}>
                  {ok ? (
                    <div className="flex items-center gap-3 px-3.5 py-3">
                      <span className="flex size-[18px] shrink-0 items-center justify-center">
                        <InstanceProviderMark instance={instance} size={18} />
                      </span>
                      <div className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="truncate text-[13.5px] font-medium text-ink">{instance.displayName}</span>
                        {v && <span className="shrink-0 text-[11.5px] tabular-nums text-ink-secondary">{v}</span>}
                      </div>
                      <StatusPill ready />
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setOpen(expanded === instance.instanceId ? null : instance.instanceId)}
                      aria-expanded={expanded === instance.instanceId}
                      className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-raised/40"
                    >
                      <span className="flex size-[18px] shrink-0 items-center justify-center">
                        <InstanceProviderMark instance={instance} size={18} />
                      </span>
                      <div className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="truncate text-[13.5px] font-medium text-ink">{instance.displayName}</span>
                        {v && <span className="shrink-0 text-[11.5px] tabular-nums text-ink-secondary">{v}</span>}
                      </div>
                      <StatusPill ready={false} />
                      <ChevronDown
                        size={14}
                        className={cn("shrink-0 text-ink-secondary transition-transform duration-200", expanded === instance.instanceId && "rotate-180")}
                      />
                    </button>
                  )}
                  {!ok && expanded === instance.instanceId && (
                    <EngineSetup
                      instance={instance}
                      intent={instance.access === "custom" ? "inject" : "cloud"}
                      className="mx-3.5 mb-3.5 border-0 bg-inset"
                    />
                  )}
                </div>
              );
            })}
      </div>

      <PrimaryButton onClick={onNext} className="mt-5">
        {t("onboarding.continue")}
      </PrimaryButton>
    </div>
  );
}
