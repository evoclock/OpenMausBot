import { emailGateDone } from "@/lib/analytics";
import { currentStep } from "@/lib/guided-tour";
import { welcomeDue, type WelcomeViewer } from "@/lib/onboarding";
import type { UpdaterState } from "@/lib/updater";
import type { AppState } from "@/state/store";

export function cornerPopupWaits(state: AppState, updater: UpdaterState | null,
  { quiet = false, idle = false, viewer }: { quiet?: boolean; idle?: boolean; viewer?: WelcomeViewer | null } = {}): boolean {
  const record = state.config?.onboarding;
  const busy = idle && (state.bots.some(bot => bot.busy || bot.tasks?.some(task => task.busy))
    || state.groups.some(group => group.working || group.busyBotId));
  const setup = state.welcomeOpen || state.tourOpen || (Boolean(record?.completedAt) && currentStep(record) !== null)
    || welcomeDue(state.config, { remoteClient: false, legacyDone: emailGateDone(), ...(viewer ? { hosted: viewer.hosted, canSave: viewer.canSave, cloudHome: viewer.cloudHome } : {}) });
  return !state.connected || !state.config || setup || busy || quiet
    || state.appSettingsOpen || state.settingsOpen || state.newBotOpen || state.pluginsOpen || state.shortcutsOpen
    || Boolean(updater && !["idle", "checking"].includes(updater.status));
}
