import { useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Check, CloudUpload, Laptop, Sparkles, Users } from "lucide-react";
import type { CloudMoveState } from "../../../electron/cloud-move.mjs";
import { formatMoveBytes, moveView, type CloudMoveHandle } from "@/components/CloudMove";
import { TeamLibraryPanel } from "@/components/TeamLibraryPanel";
import { suggestedChoice, type BringChoice } from "@/lib/cloud-welcome";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { CARD, CARD_IDLE, CARD_PICKED, CardIcon, Chip, Footer, PRIMARY, QUIET, SECONDARY, StepHeading } from "./parts";

export type BringOutcome = "copied" | "team" | "here" | "skipped";

function counted(count: number, one: LocaleKey, many: LocaleKey): string {
  return count === 1 ? t(one) : t(many, { count: new Intl.NumberFormat(activeLocale()).format(count) });
}

function MoveProgress({ done, total, label }: { done: number; total: number; label: string }) {
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const amount = t("cloudMove.transferred", { done: formatMoveBytes(done), total: formatMoveBytes(total) });
  return <div className="flex flex-col gap-2">
    <div role="progressbar" aria-label={t("cloudMove.progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={amount}
      className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
      <div className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out motion-reduce:transition-none" style={{ width: `${percent}%` }} />
    </div>
    <p role="status" className="flex flex-wrap items-baseline justify-between gap-x-3 text-[13px] text-ink-secondary">
      <span>{label}</span><span className="text-[12px] tabular-nums text-ink-tertiary">{amount}</span>
    </p>
  </div>;
}

export function WelcomeBring({ name, move, cloudHasWork, headingRef, onTeam, onFinish }: {
  name: string;
  /** Null outside the desktop app, where nothing can be copied from this computer. */
  move: CloudMoveHandle | null;
  /** The Cloud has bots or chats of its own (a copy from before, a chat from a phone): nothing is copied over them. */
  cloudHasWork: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  /** Before the team library selects the bots it adds, so that is not read as the person leaving. */
  onTeam: () => void;
  onFinish: (outcome: BringOutcome) => void;
}) {
  const desktop = move !== null;
  const overview = move?.overview ?? null;
  const [chosen, setChosen] = useState<BringChoice | null>(null);
  const [teams, setTeams] = useState(false);
  const teamButton = useRef<HTMLButtonElement>(null);
  const mac = window.ogb?.platform === "darwin";
  const state: CloudMoveState = move?.state ?? { phase: "idle" };
  const view = move ? moveView(overview, state, { onServerPage: true }) : null;
  const running = view?.running === true;
  const copied = state.phase === "done" && state.action !== "restore";
  const underWay = (state.action === "move" && state.phase !== "idle") || copied;
  const here = cloudHasWork && !underWay;
  const choice = underWay ? "copy" : chosen ?? suggestedChoice(desktop, overview);
  const copying = desktop && choice === "copy";
  const local = overview?.local;

  const pick = (next: BringChoice) => { if (!running && !copied) setChosen(next); };
  const onArrows = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const next: BringChoice = choice === "copy" ? "fresh" : "copy";
    pick(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-bring-choice="${next}"]`)?.focus();
  };

  const card = (id: BringChoice, body: ReactNode) => {
    const on = choice === id;
    return <button type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-bring-choice={id} disabled={running || copied}
      onClick={() => pick(id)}
      className={cn(CARD, "transition-[border-color,background-color,box-shadow] duration-200 ease-out motion-reduce:transition-none disabled:cursor-default", on ? CARD_PICKED : cn(CARD_IDLE, "hover:border-hairline hover:bg-card"))}>
      {body}
    </button>;
  };
  const copyCard = card("copy", <>
    <CardIcon icon={CloudUpload} />
    <span className="text-[14.5px] font-semibold text-ink">{t(mac ? "cloudWelcome.bring.copyMac" : "cloudWelcome.bring.copy")}</span>
    <span className="text-[12.5px] leading-relaxed text-ink-secondary">{t("cloudWelcome.bring.copyHint")}</span>
    {overview ? local && <span data-bring-counts className="flex flex-wrap gap-1.5">
      <Chip>{counted(local.bots, "cloudWelcome.count.botsOne", "cloudWelcome.count.bots")}</Chip>
      <Chip>{counted(local.chats, "cloudWelcome.count.chatsOne", "cloudWelcome.count.chats")}</Chip>
      {local.routines ? <Chip>{counted(local.routines, "cloudWelcome.count.routinesOne", "cloudWelcome.count.routines")}</Chip> : null}
      <Chip>{formatMoveBytes(local.bytes)}</Chip>
    </span> : <span className="text-[12px] text-ink-tertiary">{t("cloudMove.measuring")}</span>}
    <span className="text-[12px] leading-relaxed text-ink-tertiary">{t(mac ? "cloudWelcome.bring.footnoteMac" : "cloudWelcome.bring.footnote")}</span>
  </>);
  const freshBody = <>
    <CardIcon icon={Sparkles} />
    <span className="text-[14.5px] font-semibold text-ink">{t("cloudWelcome.bring.fresh")}</span>
    <span className="text-[12.5px] leading-relaxed text-ink-secondary">{t("cloudWelcome.bring.freshHint")}</span>
  </>;

  const moved = copied ? state.moved : undefined;
  const message = moved && view?.message ? { ...view.message, text: t("cloudWelcome.bring.copied", {
    bots: counted(moved.bots, "cloudWelcome.count.botsOne", "cloudWelcome.count.bots"),
    chats: counted(moved.chats, "cloudWelcome.count.chatsOne", "cloudWelcome.count.chats"), name,
  }) } : view?.message;
  const progress = running && state.progress && state.progress.totalBytes > 0 && (state.phase === "uploading" || state.phase === "exporting") ? state.progress : null;
  const status = copying && (running || message || view?.next.length) ? <div data-bring-status={state.phase} className="flex flex-col gap-2">
    {progress && <MoveProgress done={progress.bytesTransferred} total={progress.totalBytes} label={message?.text ?? ""} />}
    {message && !progress && <p role={message.tone === "error" ? "alert" : message.tone === "note" ? "note" : "status"}
      className={cn("flex items-start gap-2 text-[13px] leading-relaxed", message.tone === "error" ? "text-danger" : message.tone === "status" ? "text-ink-secondary" : "text-ink")}>
      {message.tone === "done" && <Check size={15} strokeWidth={2.5} aria-hidden="true" className="check-in mt-0.5 shrink-0 text-success" />}
      <span>{message.text}</span>
    </p>}
    {view?.next.map((line) => <p key={line} className="text-[12px] leading-relaxed text-ink-secondary">{line}</p>)}
    {view?.resumable && <p className="text-[12px] leading-relaxed text-ink-secondary">{t("cloudMove.resumeNote", { server: view.server })}</p>}
  </div> : null;

  const skip = <button type="button" className={QUIET} onClick={() => onFinish("skipped")}>{t("cloudIntent.skip")}</button>;
  let actions: ReactNode;
  if (here) {
    actions = <button type="button" className={PRIMARY} onClick={() => onFinish("here")}>{t("onboarding.continue")}</button>;
  } else if (!copying) {
    actions = <>
      <button ref={teamButton} type="button" className={PRIMARY} onClick={() => setTeams(true)}>{t("cloudWelcome.bring.chooseTeam")}</button>
      {skip}
    </>;
  } else if (running) {
    actions = view?.action && <button type="button" className={SECONDARY} disabled={move!.pending} onClick={() => move!.run(view.action!.kind)}>{view.action.label}</button>;
  } else if (copied) {
    actions = <button type="button" className={PRIMARY} onClick={() => onFinish("copied")}>{t("onboarding.continue")}</button>;
  } else if (view?.action?.kind === "start") {
    actions = <>
      <button type="button" className={PRIMARY} disabled={move!.pending || !overview} onClick={() => move!.run("start")}>
        {state.phase === "failed" ? view.action.label : t("cloudMove.start", { server: name })}
      </button>
      {skip}
    </>;
  } else {
    actions = <>
      {view?.action && <button type="button" className={SECONDARY} disabled={move!.pending} onClick={() => move!.run(view.action!.kind)}>{view.action.label}</button>}
      <button type="button" className={PRIMARY} onClick={() => onFinish("skipped")}>{t("onboarding.continue")}</button>
    </>;
  }

  return <section aria-labelledby="cloud-welcome-step" data-welcome-step="bring" className="flex flex-col gap-5">
    <StepHeading headingRef={headingRef} title={t("cloudWelcome.bring.title", { name })} sub={t("cloudWelcome.bring.sub")} />
    {here
      ? <div data-bring-here className={cn(CARD, CARD_IDLE)}>
          <CardIcon icon={Users} />
          <span className="text-[14.5px] font-semibold text-ink">{t("cloudWelcome.bring.hereTitle")}</span>
          <span className="text-[12.5px] leading-relaxed text-ink-secondary">{t("cloudWelcome.bring.hereBody", { name })}</span>
        </div>
      : desktop
      ? <div role="radiogroup" aria-label={t("cloudWelcome.bring.choices")} onKeyDown={onArrows} className="grid gap-3 @lg/step:grid-cols-2">
          {copyCard}
          {card("fresh", freshBody)}
        </div>
      : <div className="grid gap-3 @lg/step:grid-cols-2">
          <div data-bring-choice="fresh" className={cn(CARD, CARD_PICKED)}>{freshBody}</div>
          <div data-bring-desktop className={cn(CARD, "border-dashed border-hairline/60 bg-transparent")}>
            <CardIcon icon={Laptop} />
            <span className="text-[14.5px] font-semibold text-ink">{t("cloudWelcome.bring.desktopTitle")}</span>
            <span className="text-[12.5px] leading-relaxed text-ink-secondary">{t("cloudWelcome.bring.desktopOnly")}</span>
          </div>
        </div>}
    {status}
    <Footer>{actions}</Footer>
    {teams && <TeamLibraryPanel returnFocusRef={teamButton} onClose={() => setTeams(false)}
      onImported={() => { onTeam(); setTeams(false); onFinish("team"); }} />}
  </section>;
}
