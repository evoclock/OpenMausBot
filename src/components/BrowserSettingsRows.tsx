import { useState } from "react";

import { browserAvailable, browserUnavailableReason, builtInBrowserEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { SettingRow, Switch } from "./SettingsPrimitives";

export function BuiltInBrowserRow() {
  const { state, dispatch } = useStore();
  const browser = builtInBrowserEnabled(state.config);
  const desktopBrowser = browserAvailable(state.config);
  const browserInstallable = state.config?.browserEngine?.installable === true;
  const browserBlockedOnWindows = window.ogb?.platform === "win32" && !desktopBrowser && !browserInstallable;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { browser: next } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.experimental.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
    title={t("settings.experimental.browserAria")}
    subtitle={desktopBrowser
        ? browser
        ? t("settings.experimental.browserOn")
        : t("settings.experimental.browserOff")
        : browserBlockedOnWindows
        ? t("settings.experimental.browserWindows")
        : browserUnavailableReason(state.config)}
    message={error ? <p role="alert" className="text-danger">{error}</p> : null}
    >
      <Switch
          checked={browser}
          aria-label={t("settings.experimental.browserAria")}
          disabled={saving || (!browser && !desktopBrowser && !browserInstallable)}
          onClick={() => void toggle(!browser)}
          className="disabled:cursor-wait disabled:opacity-50"
      />
    </SettingRow>
  );
}

/** browserEngine.engine: the bots' browsers run on OpenMausBot's own Chrome driver instead of agent-browser. */
export function NewBrowserSettings() {
  const { state, dispatch } = useStore();
  const on = state.config?.browserEngine?.engine === "chrome";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ browserEngine: { engine: on ? "agent-browser" : "chrome" } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.experimental.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 border-t border-hairline/30 pt-4" data-testid="new-browser-settings">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">{t("settings.experimental.newBrowser")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("settings.experimental.newBrowserDetail")}</div>
        </div>
        <Switch
          checked={on}
          aria-label={t("settings.experimental.newBrowserAria")}
          disabled={saving}
          onClick={() => void toggle()}
          className="disabled:cursor-wait disabled:opacity-50"
        />
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </div>
  );
}
