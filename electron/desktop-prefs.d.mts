export { DESKTOP_PORTS } from "./desktop-ports.mjs";
export declare const DESKTOP_NOTICES: readonly string[];
export interface DesktopNoticesState {
  /** Notices this desktop has shown and someone closed, on whichever page of its window; This computer's own workspace
   * record counts too (an earlier close of the popup, or the welcome's Cloud beat). */
  seen: string[];
  /** This desktop sells MausBot Cloud: the installed app, not a branded build, not connected to another computer. */
  cloud: boolean;
}
/**
 * A click on the Cloud Pro popup that a server's page hands This computer's page to finish, without the popup showing
 * there: "manage" (My Cloud's own page only) opens Settings → MausBot Cloud; "cloud-pro", sent by a page that cannot know
 * the plan, does what This computer's own popup offers for the plan it knows: the Add a Cloud dialog, or Settings.
 */
export type DesktopHandoffIntent = "manage" | "cloud-pro";
/** On every page this desktop's window shows: this computer's, My Cloud's or another saved server's. */
export interface DesktopNoticesBridge {
  state(): Promise<DesktopNoticesState>;
  seen(id: string): Promise<void>;
  /** True the first time today the notice counts as shown on this desktop. */
  shown(id: string): Promise<boolean>;
  /**
   * A server's page only, right after a click on it: switches the window to This computer while the Cloud Pro popup is
   * unseen, loads its page on that click (`?desktop-settings=cloud-add` or `cloud-settings`, with `source=update_popup`
   * and `via=my_cloud` or `server`) and, once it has loaded, marks the popup seen. False when main cannot switch or that page does not load. Any other intent, or "manage" from a page
   * main does not verify as My Cloud's, is refused.
   */
  thisComputer(intent: DesktopHandoffIntent): Promise<boolean>;
}
/** The desktop's own switch, the same on every port its page is served from. */
export interface DesktopAnalyticsBridge {
  /** null until a choice is saved; a server's page is told only false, when this desktop turned analytics off. */
  enabled(): boolean | null;
  /** This computer's page only. */
  set?(enabled: boolean): Promise<void>;
}
export interface DesktopPrefs {
  seen(): string[];
  markSeen(id: string): void;
  shown(id: string): boolean;
  analytics(): boolean | null;
  setAnalytics(enabled: boolean): void;
}
type Files = Pick<typeof import("node:fs"), "readFileSync" | "writeFileSync" | "renameSync" | "rmSync">;
export declare function jsonFile(file: string, files?: Files): { read(): unknown; write(value: unknown): void };
export declare function createDesktopPrefs(options: { read(): unknown; write(value: unknown): void; now?: () => number }): DesktopPrefs;
export declare function registerDesktopPrefs(options: {
  ipcMain: { handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void; on(channel: string, listener: (event: { returnValue?: unknown }) => void): void };
  read(): unknown;
  write(value: unknown): void;
  page(event: unknown): "local" | "cloud" | "server" | null;
  cloudOffered(): Promise<boolean>;
  thisComputer(landing: string): Promise<boolean>;
  localConfig?(): unknown;
  now?: () => number;
}): void;
