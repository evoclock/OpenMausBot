// Screen 1: what MausBot Cloud is, the plans the Admin sells now (its recommended one preselected) and the money in one line.
import type { KeyboardEvent } from "react";
import { CloudUpload, Lock, Monitor, Moon, Smartphone, type LucideIcon } from "lucide-react";
import type { CloudOffer } from "../../../electron/cloud-home.mjs";
import { cn } from "@/lib/cn";
import { offerPlan, planRow, planTerms, trialTimeline } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { CloudMascotScene } from "./CloudMascotScene";
import { LINK, PRIMARY_WIDE } from "./parts";

const BENEFITS: ReadonlyArray<readonly [LucideIcon, LocaleKey, LocaleKey]> = [
  [Moon, "cloudBuy.benefit.awayTitle", "cloudBuy.benefit.away"],
  [Lock, "cloudBuy.benefit.privateTitle", "cloudBuy.benefit.private"],
  [Smartphone, "cloudBuy.benefit.anywhereTitle", "cloudBuy.benefit.anywhere"],
  [Monitor, "cloudBuy.benefit.browserTitle", "cloudBuy.benefit.browser"],
  [CloudUpload, "cloudBuy.benefit.moveTitle", "cloudBuy.benefit.move"],
];

export function planFromKey(tiers: readonly string[], current: string, key: string): string | null {
  const at = tiers.indexOf(current);
  if (at === -1 || !tiers.length) return null;
  const next = key === "ArrowDown" || key === "ArrowRight" ? (at + 1) % tiers.length : key === "ArrowUp" || key === "ArrowLeft" ? (at - 1 + tiers.length) % tiers.length
    : key === "Home" ? 0 : key === "End" ? tiers.length - 1 : null;
  return next === null ? null : tiers[next]!;
}

export function ChooseScreen({ offer, chosen, now, busy, signedOut, notice, onChoose, onStart, onSignIn }: {
  offer: CloudOffer; chosen: string | null; now: number; busy: boolean; signedOut: boolean; notice: string | null;
  onChoose: (tier: string) => void; onStart: () => void; onSignIn: () => void;
}) {
  const plan = offerPlan(offer, chosen);
  const terms = planTerms(offer, plan);
  const timeline = trialTimeline(offer, plan, now);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = planFromKey(offer.plans.map(item => item.tier), plan.tier, event.key);
    if (!next) return;
    event.preventDefault();
    onChoose(next);
    event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-plan="${next}"]`)?.focus();
  };
  return <div data-cloud-add={terms.trial ? "offer-trial" : "offer"} className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)]">
    <div className="flex flex-col gap-[18px] border-b border-hairline/60 bg-linear-to-b from-accent/15 via-accent/[0.04] to-transparent px-7 pb-5 pt-6 md:border-b-0 md:border-e">
      <div>
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-accent-text">{t("pro.name")}</p>
        <h2 id="cloud-add-title" tabIndex={-1} className="mb-1.5 mt-1 text-[27px] font-bold leading-[1.12] tracking-[-0.025em] text-ink outline-none [text-wrap:balance]">{t("cloudBuy.title")}</h2>
        <p className="max-w-[34ch] text-[14px] leading-relaxed text-ink-secondary">{t("cloudBuy.lede")}</p>
      </div>
      <CloudMascotScene variant="hero" />
      <ul aria-label={t("cloudBuy.benefits")} className="flex flex-col gap-3">
        {BENEFITS.map(([Icon, title, body]) => <li key={title} className="grid grid-cols-[30px_minmax(0,1fr)] items-start gap-2.5">
          <span aria-hidden="true" className="grid size-[30px] place-items-center rounded-[9px] bg-accent/12 text-accent-text"><Icon size={17} /></span>
          <span><span className="block text-[13.5px] font-semibold text-ink">{t(title)}</span><span className="block text-[12.5px] leading-snug text-ink-secondary">{t(body)}</span></span>
        </li>)}
      </ul>
    </div>
    <div className="flex min-w-0 flex-col gap-3 px-[26px] pb-[18px] pt-6">
      <h3 id="cloud-add-plans" className="pe-8 text-[15px] font-semibold text-ink">{t("cloudBuy.choose")}</h3>
      <div role="radiogroup" aria-labelledby="cloud-add-plans" className="flex flex-col gap-2">
        {offer.plans.map(entry => {
          const row = planRow(entry, offer.recommended), selected = entry.tier === plan.tier;
          return <button key={entry.tier} type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1} data-plan={entry.tier}
            onClick={() => onChoose(entry.tier)} onKeyDown={onKeyDown}
            className={cn("grid w-full grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 rounded-xl border px-3.5 py-2.5 text-start transition-[border-color,background-color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none",
              selected ? "border-accent bg-accent/10 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_25%,transparent)]" : "border-hairline hover:border-ink-tertiary")}>
            <span aria-hidden="true" className={cn("mt-0.5 grid size-[18px] place-items-center rounded-full border-[1.8px]", selected ? "border-accent" : "border-ink-tertiary")}>
              {selected && <span className="size-2 rounded-full bg-accent" />}
            </span>
            <span className="flex flex-wrap items-center gap-2 text-[14.5px] font-semibold text-ink">{row.name}
              {row.popular && <span className="rounded-full bg-accent px-[7px] py-0.5 text-[10.5px] font-semibold tracking-[0.02em] text-accent-ink">{t("cloudAdd.popular")}</span>}
            </span>
            <span className="row-span-2 text-end text-[16px] font-bold tabular-nums text-ink">{row.price}<small className="block text-[11.5px] font-medium text-ink-tertiary">{t("cloudBuy.perMonth")}</small></span>
            {row.line && <span className="col-start-2 -mt-0.5 text-[12.5px] text-ink-secondary">{row.line}</span>}
            {row.chips.length > 0 && <span className="col-span-2 col-start-2 mt-1 flex flex-wrap gap-1.5">
              {row.chips.map(chip => <span key={chip} className="whitespace-nowrap rounded-full border border-hairline/70 bg-card px-[7px] py-0.5 text-[11px] text-ink-secondary">{chip}</span>)}
            </span>}
          </button>;
        })}
      </div>
      <div aria-live="polite" className="flex flex-col gap-2 rounded-xl border border-hairline/70 bg-card/70 px-3.5 py-3">
        <p className="flex items-baseline justify-between gap-2.5"><span className="text-[13.5px] font-semibold text-ink">{t("cloudBuy.dueToday")}</span>
          <strong className="text-[20px] tabular-nums tracking-[-0.01em] text-ink">{terms.due}</strong></p>
        <p className="text-[12.5px] leading-relaxed text-ink-secondary">{terms.money}</p>
        {timeline.length > 1 && <ol aria-label={t("cloudBuy.timeline")} className="relative mt-1 grid" style={{ gridTemplateColumns: `repeat(${timeline.length}, minmax(0, 1fr))` }}>
          <span aria-hidden="true" className="absolute inset-x-1.5 top-[6px] h-0.5 bg-hairline" />
          {timeline.map((step, index) => {
            const last = index === timeline.length - 1, first = index === 0;
            return <li key={step.when} className={cn("relative min-w-0 pt-[18px] text-[11.5px] leading-snug text-ink-secondary", !first && !last && "text-center", last && "text-end")}>
              <span aria-hidden="true" className={cn("absolute top-px size-3 rounded-full border-2", first ? "start-0 border-accent bg-accent" : "border-ink-tertiary bg-panel",
                !first && !last && "start-[calc(50%-6px)]", last && "end-0")} />
              <b className="block text-[12px] font-semibold text-ink">{step.when}</b>{step.text}
            </li>;
          })}
        </ol>}
      </div>
      {notice && <p role="status" className="text-[12.5px] text-ink">{notice}</p>}
      <button type="button" className={PRIMARY_WIDE} disabled={busy} onClick={onStart}>{terms.action}</button>
      <div className="flex flex-col items-center gap-1.5 text-center text-[12px] text-ink-tertiary">
        <p className="flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1">
          <span className="inline-flex items-center gap-1.5"><Lock size={13} aria-hidden="true" />{t("cloudBuy.secure")}</span>
          <span role="img" aria-label={t("cloudBuy.wallets")} className="inline-flex gap-1">
            {[t("cloudBuy.applePay"), t("cloudBuy.googlePay"), t("cloudBuy.card")].map(mark => <span key={mark} aria-hidden="true"
              className="rounded-[5px] border border-hairline px-[5px] py-px text-[10.5px] font-semibold text-ink-secondary">{mark}</span>)}
          </span>
        </p>
        <p className="flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1">
          <span>{t("cloudBuy.cancelEasy")}</span>{terms.moneyBack && <span>{terms.moneyBack}</span>}
        </p>
        {signedOut && <button type="button" className={LINK} onClick={onSignIn}>{t("cloudBuy.haveAccount")}</button>}
      </div>
    </div>
  </div>;
}
