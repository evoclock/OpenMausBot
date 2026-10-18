import { useState } from "react";
import { analyticsEnabled, setAnalyticsEnabled } from "@/lib/analytics";
import { t } from "@/lib/i18n";
import { SettingRow, Switch } from "./SettingsPrimitives";

const ANALYTICS_DOC_URL = "https://github.com/milind-soni/OpenMausBot/blob/main/docs/analytics.md";

export function AnalyticsRow() {
  const [on, setOn] = useState(analyticsEnabled);
  const subtitle = (
    <>
      {t("settings.analytics.subtitle")}{" "}
      <a href={ANALYTICS_DOC_URL} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
        {t("settings.analytics.link")}
      </a>
    </>
  );
  return (
    <SettingRow title={t("settings.analytics.title")} subtitle={subtitle}>
      <Switch
        checked={on}
        aria-label={t("settings.analytics.aria")}
        onClick={() => {
          const next = !on;
          setAnalyticsEnabled(next);
          setOn(next);
        }}
      />
    </SettingRow>
  );
}
