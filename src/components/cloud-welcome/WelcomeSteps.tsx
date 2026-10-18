import type { Ref } from "react";
import { Check, CircleAlert, FolderOpen, Plug } from "lucide-react";
import { cloudEngineChoices, useCloudEngineChoices } from "@/components/CloudEngineSignIn";
import { useCloudPlanSnapshot } from "@/components/CloudTrialNotice";
import { engineReady } from "@/components/EngineLibrary";
import { usd } from "@/lib/cloud-plan";
import { welcomeCredit } from "@/lib/cloud-welcome";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { CARD, CARD_IDLE, CardIcon, Footer, PRIMARY, QUIET, SECONDARY, StepHeading } from "./parts";

export function WelcomeEngine({ name, headingRef, onFinish }: { name: string; headingRef: Ref<HTMLHeadingElement>; onFinish: () => void }) {
  const engines = useCloudEngineChoices();
  const plan = useCloudPlanSnapshot(window.ogb?.cloudPlan);
  const own = engines.instances.some((instance) => !instance.trialCredit && engineReady(instance));
  const credit = own ? null : welcomeCredit(engines.instances, plan);
  return <section aria-labelledby="cloud-welcome-step" data-welcome-step="engine" className="flex flex-col">
    <StepHeading headingRef={headingRef} title={t("cloudSetup.engine.title")} sub={t("cloudWelcome.engine.sub", { name })} />
    {credit?.state === "active" && <p role="status" data-welcome-credit className="mt-5 flex items-start gap-2.5 rounded-xl bg-success/12 px-3.5 py-3 text-[13px] leading-relaxed text-ink">
      <Check size={16} strokeWidth={2.5} aria-hidden="true" className="mt-px shrink-0 text-success" />
      <span>{credit.left !== null ? t("cloudWelcome.engine.credit", { amount: usd(credit.left) }) : t("cloudWelcome.engine.creditPlain")}</span>
    </p>}
    {credit && credit.state !== "active" && <p role="status" data-welcome-credit={credit.state} className="mt-5 flex items-start gap-2.5 rounded-xl bg-warning/10 px-3.5 py-3 text-[13px] leading-relaxed text-ink">
      <CircleAlert size={16} aria-hidden="true" className="mt-px shrink-0 text-warning" />
      <span>{t(credit.state === "used_up" ? "cloudSignIn.creditUsedUp" : "cloudSignIn.creditEnded")}</span>
    </p>}
    {cloudEngineChoices(engines, { columns: engines.choices.length === 3 ? "grid-cols-1 @xl/step:grid-cols-3" : "grid-cols-1 @sm/step:grid-cols-2" })}
    <Footer className="mt-7">
      {own
        ? <button type="button" className={PRIMARY} onClick={onFinish}>{t("onboarding.continue")}</button>
        : credit?.state === "active"
          ? <button type="button" className={PRIMARY} onClick={onFinish}>{t("cloudWelcome.engine.useCredit")}</button>
          : <button type="button" className={QUIET} onClick={onFinish}>{t("cloudIntent.skip")}</button>}
    </Footer>
  </section>;
}

export function WelcomeFiles({ name, headingRef, onFinish }: { name: string; headingRef: Ref<HTMLHeadingElement>; onFinish: () => void }) {
  const { dispatch } = useStore();
  const lending = window.ogb?.cloudLending;
  const card = (id: string, icon: typeof Plug, title: string, body: string, action?: { label: string; run: () => void }) =>
    <div data-welcome-files={id} className={cn(CARD, CARD_IDLE)}>
      <CardIcon icon={icon} />
      <span className="text-[14.5px] font-semibold text-ink">{title}</span>
      <span className="text-[12.5px] leading-relaxed text-ink-secondary">{body}</span>
      {action && <span className="mt-1"><button type="button" className={SECONDARY} onClick={action.run}>{action.label}</button></span>}
    </div>;
  return <section aria-labelledby="cloud-welcome-step" data-welcome-step="files" className="flex flex-col gap-5">
    <StepHeading headingRef={headingRef} title={t("cloudWelcome.files.title")} aside={t("cloudWelcome.files.optional")} sub={t("cloudWelcome.files.sub")} />
    <div className="grid gap-3 @lg/step:grid-cols-2">
      {card("folders", FolderOpen, t("cloudWelcome.files.folders"),
        t(lending ? "cloudWelcome.files.foldersHint" : "cloudWelcome.files.foldersDesktop", { name }),
        lending ? { label: t("cloudWelcome.files.foldersAction"), run: () => void lending.open().catch(() => {}) } : undefined)}
      {card("apps", Plug, t("cloudWelcome.files.apps"), t("cloudWelcome.files.appsHint"),
        { label: t("cloudWelcome.files.appsAction"), run: () => dispatch({ type: "togglePlugins", open: true, surface: "apps" }) })}
    </div>
    <Footer>
      <button type="button" className={PRIMARY} onClick={onFinish}>{t("cloudWelcome.files.finish")}</button>
      <button type="button" className={QUIET} onClick={onFinish}>{t("cloudIntent.skip")}</button>
    </Footer>
  </section>;
}

export function WelcomeDone({ name, bot, headingRef, onSayHi, onJob }: {
  name: string; bot: Bot | null; headingRef: Ref<HTMLHeadingElement>; onSayHi: () => void; onJob: () => void;
}) {
  return <section aria-labelledby="cloud-welcome-step" data-welcome-step="done" className="flex flex-col items-start gap-4">
    <span aria-hidden="true" className="check-in flex size-[42px] items-center justify-center rounded-full bg-success">
      <Check size={22} strokeWidth={2.5} />
    </span>
    <StepHeading headingRef={headingRef} title={t("cloudWelcome.done.title", { name })} sub={t("cloudWelcome.done.body")} />
    <Footer>
      <button type="button" className={PRIMARY} onClick={onSayHi}>
        {bot?.chiefOfStaff || !bot ? t("cloudWelcome.done.chief") : t("cloudWelcome.done.bot", { name: bot.name })}
      </button>
      {bot && <button type="button" className={SECONDARY} onClick={onJob}>{t("cloudSetup.job.action")}</button>}
    </Footer>
  </section>;
}
