import { Search } from "lucide-react";
import type { ReactNode } from "react";

import { t } from "@/lib/i18n";

import { SidebarFooterNav } from "./SidebarFooterNav";
import { SidebarProfileMenu } from "./SidebarProfileMenu";
import { SIMPLE_RAIL_BUTTON } from "./SidebarSimpleTop";
import { UpdateIndicator } from "./UpdateIndicator";

export function SidebarRailSeparator() {
  return <div aria-hidden="true" data-sidebar-rail-separator="" className="mx-auto my-1.5 h-px w-8 shrink-0 bg-hairline/70" />;
}

export function SimpleRailFooter({ onSearch, plus, server }: {
  onSearch: () => void;
  plus: ReactNode;
  server: ReactNode;
}) {
  return (
    <div data-sidebar-rail-footer="" className="flex flex-col items-center gap-0.5 px-2 pb-3 pt-2">
      <button type="button" onClick={onSearch} aria-label={t("sidebar.searchAria")} title={t("sidebar.searchAria")} className={SIMPLE_RAIL_BUTTON}>
        <Search size={18} aria-hidden="true" />
      </button>
      <div className="relative flex w-full justify-center">{plus}</div>
      {server}
      <SidebarFooterNav density="icons" rail />
      <UpdateIndicator />
      <div className="mt-1.5">
        <SidebarProfileMenu iconOnly rail />
      </div>
    </div>
  );
}
