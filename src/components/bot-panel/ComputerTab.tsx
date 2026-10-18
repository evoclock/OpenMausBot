import { useState } from "react";
import { Folder, Globe, KeyRound, Monitor, Smartphone, Table } from "lucide-react";

import { writeComputerPanelView, type ComputerPanelView } from "@/lib/computer-panel-view";
import { t } from "@/lib/i18n";
import type { Place } from "@/lib/place";
import { placeFacts, placeHasIssue, placeViewFor, usePlaceSeat, worksOnSimpleLabel } from "@/lib/place-view";
import { shortPath } from "@/lib/short-path";
import { useStore, type Bot } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { LocalComputerAutoWarning } from "../LocalComputerAutoWarning";
import { usePlaceViews } from "../PlaceChip";
import { screenFramePreview } from "../ScreenFrame";
import { CloudPreference, cloudPreferenceShown } from "../bot-settings/AccessSection";
import type { BotPatch, useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import type { PageId } from "./page-registry";
import { Card, chipCls, ColRow, LinkRow, NavRow, Segmented } from "./rows";

type Derived = ReturnType<typeof useBotSettingsDerived>;
type PlaceChoice = "auto" | Place | "off";

const SIMPLE_PLACES: readonly Place[] = ["local", "cloud"];

export function useOpenComputer(bot: Pick<Bot, "id">) {
  const { dispatch } = useStore();
  return (view: ComputerPanelView = "computer") => {
    writeComputerPanelView(bot.id, view);
    dispatch({ type: "toggleSettings", open: false });
    dispatch({ type: "toggleComputer", open: true });
  };
}

export function ComputerTab({ bot, derived, onOpen }: { bot: Bot; derived: Derived; onOpen: (page: PageId) => void }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const platform = capabilities.host?.platform ?? "other";
  const placeSeat = usePlaceSeat(state.config, platform);
  const placeViews = usePlaceViews(bot);
  const openComputer = useOpenComputer(bot);
  const [localAutoWarning, setLocalAutoWarning] = useState<{ botId: string; patch: BotPatch } | null>(null);
  const { patch, approvalMode, browserEnabled } = derived;

  const currentPlace: PlaceChoice = bot.computer ?? "auto";
  const worksOn = placeViewFor(placeFacts({
    bot, place: currentPlace, seat: placeSeat, config: state.config, instances: state.instances,
  }));
  const choice = (place: Place) => {
    const { view, reachable } = placeViews[place];
    return { disabled: !reachable, tooltip: !reachable || placeHasIssue(view) ? view.line : undefined };
  };
  const mainChoices = [
    { value: "auto" as PlaceChoice, label: worksOnSimpleLabel(undefined, platform) },
    ...SIMPLE_PLACES.filter((place) => placeViews[place].policy)
      .map((place) => ({ value: place as PlaceChoice, label: worksOnSimpleLabel(place, platform), ...choice(place) })),
  ];
  const moreChoices = [
    ...(placeViews.vm.policy ? [{ value: "vm" as PlaceChoice, label: t("place.vm"), ...choice("vm") }] : []),
    ...(placeViews.browser.policy ? [{ value: "browser" as PlaceChoice, label: t("botPanel.place.browserOnly"), ...choice("browser") }] : []),
    { value: "off" as PlaceChoice, label: t("place.off"), disabled: false, tooltip: undefined },
  ];
  const listed = [...mainChoices, ...moreChoices].some((option) => option.value === currentPlace);
  const choosePlace = (value: PlaceChoice) => {
    if (value === currentPlace) return;
    if (value === "local" && approvalMode === "auto") {
      setLocalAutoWarning({ botId: bot.id, patch: { computer: "local", acknowledgeLocalAuto: true } });
      return;
    }
    if (value === "browser") patch({ computer: "browser", browser: true });
    else patch({ computer: value === "auto" ? null : value });
  };

  const screen = [...bot.messages].reverse().find((message) => message.kind === "screen" && (message.hasImage || message.png));
  const screenSrc = screen ? screenFramePreview({ threadId: bot.threadId, messageId: screen.id }, screen.mime).src : null;
  const home = capabilities.host?.homeDir;
  const android = Boolean(window.ogb?.androidDevice);

  return (
    <div data-panel-tabpanel="computer">
      <div className="relative mt-[18px] flex aspect-[16/10] max-w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-[14px] border border-ink/[0.06] bg-inset">
        {screenSrc ? (
          <img src={screenSrc} alt={t("computer.screenOf", { name: bot.name })} className="absolute inset-0 size-full object-cover" />
        ) : (
          <>
            <span className="opacity-55"><BotAvatar bot={bot} size={52} animated={false} /></span>
            <span className="text-[12.5px] text-ink-secondary">{t(bot.busy ? "botPanel.screen.working" : "botPanel.screen.idle")}</span>
          </>
        )}
        <button
          type="button"
          data-panel-action="open-computer"
          onClick={() => openComputer()}
          className="absolute bottom-2.5 right-2.5 flex h-7 items-center gap-1.5 rounded-full border border-ink/10 bg-panel/80 px-2.5 text-[12px] text-ink backdrop-blur-sm hover:bg-panel"
        >
          <Monitor size={13} aria-hidden="true" />
          {t("botPanel.openFullView")}
        </button>
      </div>
      <div className="mt-[7px] text-center text-[12px] text-ink-tertiary">{t("computer.screenOf", { name: bot.name })}</div>

      <Card label={t("computer.simple.whereWorks", { name: bot.name })} anchor="where">
        <ColRow data-panel-row="where">
          <Segmented
            attr="data-place-choice"
            label={t("computer.simple.whereWorks", { name: bot.name })}
            value={currentPlace}
            onChange={choosePlace}
            options={mainChoices}
          />
          <div role="group" aria-label={t("botPanel.place.more")} className="flex flex-wrap items-center gap-1.5">
            <span className="mr-0.5 text-[12px] text-ink-tertiary">{t("botPanel.place.more")}</span>
            {moreChoices.map((option) => (
              <button
                key={option.value}
                type="button"
                data-place-choice={option.value}
                aria-pressed={option.value === currentPlace}
                disabled={option.disabled}
                title={option.tooltip}
                onClick={() => choosePlace(option.value)}
                className={chipCls(option.value === currentPlace)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="mx-0.5 text-[12.5px] leading-[1.35] text-ink-secondary">
            {currentPlace === "auto" ? t("place.autoDetail")
              : listed ? worksOn.line : `${worksOnSimpleLabel(bot.computer, platform)}: ${worksOn.line}`}
          </div>
        </ColRow>
        {cloudPreferenceShown(bot, state.config) && (
          <div className="px-3.5 pb-3.5 [&>.bg-inset]:bg-transparent [&>.bg-inset]:px-0.5">
            <CloudPreference bot={bot} patch={patch} />
          </div>
        )}
      </Card>

      <Card label={t("botPanel.onThisComputer")} anchor="on-computer">
        <NavRow
          data-panel-page="browser"
          icon={Globe}
          title={t("place.browser")}
          hint={t(browserEnabled && bot.computer !== "off" ? "botPanel.browserOn" : "botPanel.browserOff")}
          onClick={() => onOpen("browser")}
        />
        <NavRow
          data-panel-page="logins"
          icon={KeyRound}
          title={t("botSettings.simple.logins")}
          hint={t("botPanel.loginsHint", { name: bot.name })}
          onClick={() => onOpen("browser")}
        />
        <NavRow
          data-panel-page="folder"
          icon={Folder}
          title={t("computer.files.folder")}
          hint={bot.cwd ? shortPath(bot.cwd, home) : t("computer.files.privateFolder", { name: bot.name })}
          onClick={() => onOpen("folder")}
        />
        <NavRow
          data-panel-row="data"
          icon={Table}
          title={t("computer.tab.data")}
          hint={t("botPanel.dataHint")}
          drill={false}
          onClick={() => openComputer("data")}
        />
        {android && (
          <NavRow
            data-panel-page="android"
            icon={Smartphone}
            title={t("botPanel.page.android")}
            hint={t("botPanel.androidHint")}
            onClick={() => onOpen("android")}
          />
        )}
      </Card>

      <Card>
        <LinkRow data-panel-link="computer" icon={Monitor} onClick={() => openComputer()}>{t("botPanel.openFullComputer")}</LinkRow>
      </Card>
      <p className="mt-2 text-center text-[12px] text-ink-tertiary">{t("botPanel.fullViewHint")}</p>

      <LocalComputerAutoWarning
        open={localAutoWarning !== null}
        onCancel={() => setLocalAutoWarning(null)}
        onConfirm={() => {
          const target = localAutoWarning;
          setLocalAutoWarning(null);
          if (!target) return;
          dispatch({ type: "updateBot", botId: target.botId, patch: target.patch });
        }}
      />
    </div>
  );
}
