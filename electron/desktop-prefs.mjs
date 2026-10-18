// What this desktop keeps whatever page its window shows, whichever port its own page is served on: the notices it
// has shown and its usage-analytics switch.
import fs from "node:fs";
import { localDay } from "./cloud-trial-notice.mjs";
import { ONBOARDING_CLOUD_HINT, onboardingHints } from "./onboarding-record.mjs";

export { DESKTOP_PORTS } from "./desktop-ports.mjs";
/** The only notices a page may record, so no page can write anything else into the file. */
export const DESKTOP_NOTICES = Object.freeze(["cloud-pro-update-2026-10"]);
const CLOUD_PRO = DESKTOP_NOTICES[0];
const HANDOFFS = new Map([["cloud-pro", { settings: "cloud-add", pages: ["cloud", "server"] }], ["manage", { settings: "cloud-settings", pages: ["cloud"] }]]);
const VIA = { cloud: "my_cloud", server: "server" };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Security: a write that fails (a full disk, a kill mid-write) leaves the last whole record, analytics opt-out included.
 * A file another tool saved with a byte-order mark (Notepad on Windows) still reads. */
export function jsonFile(file, files = fs) {
  return {
    read: () => JSON.parse(files.readFileSync(file, "utf8").replace(/^\uFEFF/, "")),
    write: value => {
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        files.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
        files.renameSync(temporary, file);
      } catch (error) {
        try { files.rmSync(temporary, { force: true }); } catch {}
        throw error;
      }
    },
  };
}

function parse(raw) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const seen = Array.isArray(record.seen) ? DESKTOP_NOTICES.filter(id => record.seen.includes(id)) : [];
  const shown = Object.fromEntries(DESKTOP_NOTICES.flatMap(id => {
    const day = record.shown && typeof record.shown === "object" ? record.shown[id] : undefined;
    return typeof day === "string" && DAY.test(day) ? [[id, day]] : [];
  }));
  return { seen, shown, ...(typeof record.analytics === "boolean" ? { analytics: record.analytics } : {}) };
}

/** A record that cannot be written is still kept for this launch. */
export function createDesktopPrefs({ read, write, now = Date.now }) {
  let record = null;
  const current = () => {
    if (record) return record;
    let raw = null;
    try { raw = read(); } catch {}
    return (record = parse(raw));
  };
  const save = next => { record = next; try { write(next); } catch {} };
  return {
    seen: () => [...current().seen],
    markSeen(id) {
      const saved = current();
      if (DESKTOP_NOTICES.includes(id) && !saved.seen.includes(id)) save({ ...saved, seen: [...saved.seen, id] });
    },
    /** True the first time a notice not yet seen counts as shown on a calendar day. */
    shown(id) {
      const saved = current(), day = localDay(now());
      if (!DESKTOP_NOTICES.includes(id) || saved.seen.includes(id) || saved.shown[id] === day) return false;
      save({ ...saved, shown: { ...saved.shown, [id]: day } });
      return true;
    },
    /** null until a choice is saved. */
    analytics: () => current().analytics ?? null,
    setAnalytics(enabled) { save({ ...current(), analytics: enabled === true }); },
  };
}

/**
 * `page(event)`: "local" for this computer's page, "cloud" for My Cloud's own page as main verifies it, "server" for
 * another saved server open in this desktop's window, null for anything else. `cloudOffered()`: this desktop sells
 * MausBot Cloud, asked once its Cloud sign-in is restored. `localConfig()`: This computer's own workspace's config.json.
 * `thisComputer(landing)`: switches the window to This computer and loads its page at `landing`; false when it cannot,
 * or when that page does not load.
 */
export function registerDesktopPrefs({ ipcMain, read, write, page, cloudOffered, thisComputer, localConfig = () => null, now = Date.now }) {
  let prefs = null;
  const store = () => prefs ??= createDesktopPrefs({ read, write, now });
  let switching = false;
  const from = (channel, pages, handler) => (event, ...args) => {
    const asking = page(event);
    if (!pages.includes(asking)) throw new Error(`${channel} is only available in this app's window`);
    return handler(asking, ...args);
  };
  // This computer's workspace record counts on every page, before This computer's page has loaded: an earlier close, or the welcome's Cloud beat.
  const state = async () => {
    const cloud = await cloudOffered();
    let hints = [];
    try { hints = onboardingHints(localConfig()); } catch {}
    const seen = store().seen(), closed = hints.includes(CLOUD_PRO) || hints.includes(ONBOARDING_CLOUD_HINT);
    return { seen: closed && !seen.includes(CLOUD_PRO) ? [...seen, CLOUD_PRO] : seen, cloud };
  };
  const ANY = ["local", "cloud", "server"];
  ipcMain.handle("desktop-notices:state", from("desktop-notices:state", ANY, state));
  ipcMain.handle("desktop-notices:seen", from("desktop-notices:seen", ANY, (_, id) => store().markSeen(id)));
  ipcMain.handle("desktop-notices:shown", from("desktop-notices:shown", ANY, (_, id) => store().shown(id)));
  // Security: a server's page brings the window to This computer only while the popup is unseen, and the switch marks it
  // seen once that page has loaded. This computer's page opens only what main names for the popup's own click: Continue on this computer opens what that page's own popup would for the plan it knows; only My Cloud's own
  // page hands over Manage plan.
  ipcMain.handle("desktop-notices:this-computer", from("desktop-notices:this-computer", ["cloud", "server"], async (asking, intent) => {
    const handoff = HANDOFFS.get(intent);
    if (!handoff?.pages.includes(asking)) throw new Error("This page cannot hand that click to This computer");
    if (switching) return false;
    switching = true;
    try {
      const notices = await state();
      if (!notices.cloud || notices.seen.includes(CLOUD_PRO)) return false;
      if (await thisComputer(`?desktop-settings=${handoff.settings}&source=update_popup&via=${VIA[asking]}`) !== true) return false;
      store().markSeen(CLOUD_PRO);
      return true;
    } finally {
      switching = false;
    }
  }));
  // Security: a server's page learns only that this desktop turned analytics off, never that it is on.
  ipcMain.on("desktop-analytics:read", event => {
    try {
      const asking = page(event), saved = store().analytics();
      event.returnValue = asking === "local" ? saved : asking && saved === false ? false : null;
    } catch { event.returnValue = null; }
  });
  ipcMain.handle("desktop-analytics:set", from("desktop-analytics:set", ["local"], (_, enabled) => { store().setAnalytics(enabled === true); }));
}
