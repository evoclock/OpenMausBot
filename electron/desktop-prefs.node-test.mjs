import assert from "node:assert/strict";
import fs, { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createDesktopPrefs, DESKTOP_NOTICES, DESKTOP_PORTS, jsonFile, registerDesktopPrefs } from "./desktop-prefs.mjs";
import { localDay } from "./cloud-trial-notice.mjs";
import { ONBOARDING_CLOUD_HINT, onboardingHints, WELCOME_VERSION } from "./onboarding-record.mjs";

const require = createRequire(import.meta.url);
const environments = require("./environments.cjs");
const localOrigin = require("./local-origin.cjs");

const POPUP = "cloud-pro-update-2026-10";
const HOUR = 3600_000, NOON = new Date(2026, 9, 16, 12).getTime();
const LOCAL = "http://127.0.0.1:18799", CLOUD = "https://omb-u-1.fly.dev", VPS = "https://bots.example.test";

test("the popup is the one notice a page can record; seen and analytics survive a restart; a broken record never stops the app", () => {
  assert.deepEqual([...DESKTOP_NOTICES], [POPUP]);
  let saved = null;
  const writes = [];
  const prefs = createDesktopPrefs({ read: () => saved, write: value => { writes.push(value); saved = structuredClone(value); }, now: () => NOON });
  assert.deepEqual(prefs.seen(), []); assert.equal(prefs.analytics(), null);
  for (const id of ["other-notice", "__proto__", "", 42]) prefs.markSeen(id);
  assert.equal(writes.length, 0, "nothing a page names outside the list is written");
  prefs.markSeen(POPUP); prefs.markSeen(POPUP);
  assert.deepEqual(prefs.seen(), [POPUP]); assert.equal(writes.length, 1);
  prefs.setAnalytics(false);
  const restarted = createDesktopPrefs({ read: () => saved, write: value => { saved = value; }, now: () => NOON });
  assert.deepEqual(restarted.seen(), [POPUP]); assert.equal(restarted.analytics(), false);
  restarted.setAnalytics("yes"); assert.equal(restarted.analytics(), false, "only true turns it on");
  restarted.setAnalytics(true); assert.equal(restarted.analytics(), true);

  const broken = createDesktopPrefs({ read: () => { throw new Error("unreadable"); }, write: () => { throw new Error("read-only disk"); }, now: () => NOON });
  assert.deepEqual(broken.seen(), []);
  broken.markSeen(POPUP); broken.setAnalytics(false);
  assert.deepEqual(broken.seen(), [POPUP], "kept for this launch when the file cannot be written");
  assert.equal(broken.analytics(), false);
  for (const record of ["nonsense", [POPUP], { seen: "all", shown: [], analytics: "off" }, { seen: [POPUP, "<b>"], shown: { [POPUP]: "today" } }]) {
    const prefs = createDesktopPrefs({ read: () => record, write: () => {}, now: () => NOON });
    assert.equal(prefs.analytics(), null, JSON.stringify(record));
    assert.ok(prefs.seen().every(id => id === POPUP), JSON.stringify(record));
    if (!prefs.seen().length) assert.equal(prefs.shown(POPUP), true, JSON.stringify(record));
  }
});

test("a write that fails leaves the last whole record on disk, analytics opt-out included", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "desktop-prefs-"));
  try {
    const file = path.join(dir, "desktop-prefs.json");
    createDesktopPrefs(jsonFile(file)).setAnalytics(false);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { seen: [], shown: {}, analytics: false });
    // As a full disk or a file-size limit does: the file is opened and emptied, then the write fails.
    const full = { ...fs, writeFileSync: target => { fs.writeFileSync(target, ""); throw Object.assign(new Error("file too large"), { code: "EFBIG" }); } };
    const launch = createDesktopPrefs({ ...jsonFile(file, full), now: () => NOON });
    assert.equal(launch.shown(POPUP), true, "kept for this launch");
    launch.markSeen(POPUP);
    assert.throws(() => jsonFile(file, full).write({ seen: [] }), /file too large/);
    assert.deepEqual(readdirSync(dir), ["desktop-prefs.json"], "no temporary file is left behind");
    const next = createDesktopPrefs(jsonFile(file));
    assert.equal(next.analytics(), false, "the opt-out survives");
    assert.deepEqual(next.seen(), []);
    assert.deepEqual(createDesktopPrefs(jsonFile(path.join(dir, "missing.json"))).seen(), [], "no file yet");
    const notepad = path.join(dir, "config.json");
    fs.writeFileSync(notepad, `\uFEFF${JSON.stringify({ onboarding: { hintsSeen: [ONBOARDING_CLOUD_HINT] } })}`);
    assert.deepEqual(onboardingHints(jsonFile(notepad).read()), [ONBOARDING_CLOUD_HINT], "a byte-order mark, as Notepad saves on Windows");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("shown counts once a day on this desktop, whichever page asks, until the popup is seen", () => {
  let now = NOON, saved = null;
  const prefs = createDesktopPrefs({ read: () => saved, write: value => { saved = structuredClone(value); }, now: () => now });
  assert.equal(prefs.shown(POPUP), true);
  assert.equal(prefs.shown(POPUP), false, "a reload the same day");
  assert.equal(createDesktopPrefs({ read: () => saved, write: () => {}, now: () => now }).shown(POPUP), false, "another page, another launch, the same day");
  assert.equal(saved.shown[POPUP], localDay(NOON));
  now += 24 * HOUR;
  assert.equal(prefs.shown(POPUP), true, "the next day, still not seen");
  prefs.markSeen(POPUP); now += 24 * HOUR;
  assert.equal(prefs.shown(POPUP), false);
  assert.equal(prefs.shown("other-notice"), false);
});

const WELCOMED = { onboarding: { completedAt: "2026-10-01T09:00:00.000Z", version: WELCOME_VERSION, hintsSeen: [] } };
function desktopMain({ offered = true, switches = () => true, page = event => event.page, config = () => WELCOMED } = {}) {
  const handlers = new Map(), listeners = new Map(), calls = [], landings = [];
  let saved = null, now = NOON;
  registerDesktopPrefs({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: (channel, listener) => listeners.set(channel, listener) },
    read: () => saved, write: value => { saved = structuredClone(value); }, page,
    cloudOffered: async () => { calls.push("offered"); return offered; },
    thisComputer: async landing => { calls.push("this-computer"); const moved = await switches(); if (moved === true) landings.push(landing); return moved; },
    localConfig: () => config(),
    now: () => now,
  });
  const ask = (channel, page, ...args) => handlers.get(channel)({ page }, ...args);
  const read = page => { const event = { page }; listeners.get("desktop-analytics:read")(event); return event.returnValue; };
  return { ask, read, calls, landings, channels: [...handlers.keys()], saved: () => saved, later: ms => { now += ms; } };
}

test("every page of this desktop's window reads and records the same notices; nothing else is answered", async () => {
  const main = desktopMain();
  assert.deepEqual(main.channels, ["desktop-notices:state", "desktop-notices:seen", "desktop-notices:shown", "desktop-notices:this-computer", "desktop-analytics:set"]);
  for (const page of ["local", "cloud", "server"]) assert.deepEqual(await main.ask("desktop-notices:state", page), { seen: [], cloud: true });
  assert.equal(await main.ask("desktop-notices:shown", "server", POPUP), true);
  assert.equal(await main.ask("desktop-notices:shown", "local", POPUP), false, "once a day for the desktop, not per page");
  await main.ask("desktop-notices:seen", "server", POPUP);
  assert.deepEqual(await main.ask("desktop-notices:state", "local"), { seen: [POPUP], cloud: true });
  for (const channel of main.channels) assert.throws(() => main.ask(channel, null, POPUP), /only available in this app's window/, channel);
  assert.deepEqual((await desktopMain({ offered: false }).ask("desktop-notices:state", "server")).cloud, false);
});

test("This computer's own record counts on every page before its page loads on this build: an earlier close or the welcome's Cloud beat", async () => {
  assert.equal(ONBOARDING_CLOUD_HINT, "onboarding-cloud-v1");
  const record = (onboarding) => () => ({ composio: { apiKey: "" }, onboarding });
  for (const hint of [POPUP, ONBOARDING_CLOUD_HINT]) {
    const main = desktopMain({ config: record({ completedAt: "2026-10-01", version: 1, hintsSeen: ["tour-finished", hint] }) });
    for (const page of ["local", "cloud", "server"]) assert.deepEqual(await main.ask("desktop-notices:state", page), { seen: [POPUP], cloud: true }, `${hint} ${page}`);
    assert.equal(await main.ask("desktop-notices:this-computer", "server", "cloud-pro"), false, `${hint}: nothing to switch for`);
    assert.deepEqual(main.calls.filter(call => call === "this-computer"), []);
    assert.equal(main.saved(), null, "read, never written into this desktop's record");
  }
  assert.deepEqual(onboardingHints({ onboarding: { completedAt: "x", version: 2, hintsSeen: ["a", 1, null, "b"] } }), ["a", "b"]);
});

test("every desktop gets the popup on whichever page its window opens, whatever This computer's welcome record says or lacks", async () => {
  // An install from before the welcome kept a record, a welcome never finished, no config.json, or one main cannot read.
  const records = [() => ({ onboarding: { completedAt: "", version: 0, hintsSeen: [] } }), () => ({ composio: {} }), () => null, () => "nonsense",
    () => { throw new Error("ENOENT"); }, () => { throw new SyntaxError("Unexpected token"); }, () => ({ onboarding: { hintsSeen: POPUP } }), () => ({ onboarding: { hintsSeen: [{ id: POPUP }] } })];
  for (const config of records) {
    for (const [page, intent] of [["cloud", "manage"], ["server", "cloud-pro"]]) {
      const main = desktopMain({ config }), name = `${String(config)} ${page}`;
      assert.deepEqual(await main.ask("desktop-notices:state", page), { seen: [], cloud: true }, name);
      assert.equal(await main.ask("desktop-notices:this-computer", page, intent), true, `${name}: its click switches`);
      assert.deepEqual(main.saved().seen, [POPUP], name);
    }
  }
});

test("main takes only the popup's own click: Continue on this computer from My Cloud's or a saved server's page, Manage plan from My Cloud's own page alone", async () => {
  const refused = [["server", "manage"], ["server", undefined], ["cloud", undefined], ["cloud", null], ["server", "upgrade"], ["cloud", "Cloud-Pro"],
    ["server", "__proto__"], ["cloud", "constructor"], ["server", { intent: "cloud-pro" }], ["cloud", ["manage"]]];
  for (const [page, intent] of refused) {
    const main = desktopMain(), name = `${page} ${JSON.stringify(intent)}`;
    await assert.rejects(main.ask("desktop-notices:this-computer", page, intent), /cannot hand that click/, name);
    assert.deepEqual(main.calls, [], `${name}: nothing is asked, nothing moves`);
    assert.equal(main.saved(), null, name);
    assert.equal(await main.ask("desktop-notices:this-computer", page, "cloud-pro"), true, `${name}: its own click still switches`);
  }
  for (const page of ["local", null, "elsewhere"]) {
    for (const intent of ["cloud-pro", "manage"]) assert.throws(() => desktopMain().ask("desktop-notices:this-computer", page, intent), /only available/, `${page} ${intent}`);
  }
});

test("the click brings the window to This computer's page on what it opens there, and the popup is seen: Continue on this computer from any server's page, Manage plan from My Cloud's", async () => {
  const landings = [
    ["server", "cloud-pro", "?desktop-settings=cloud-add&source=update_popup&via=server"],
    ["cloud", "cloud-pro", "?desktop-settings=cloud-add&source=update_popup&via=my_cloud"],
    ["cloud", "manage", "?desktop-settings=cloud-settings&source=update_popup&via=my_cloud"],
  ];
  for (const [page, intent, landing] of landings) {
    const main = desktopMain(), name = `${page} ${intent}`;
    assert.equal(await main.ask("desktop-notices:this-computer", page, intent), true, name);
    assert.deepEqual(main.landings, [landing], name);
    assert.deepEqual(main.saved().seen, [POPUP], `${name}: seen once the window has switched`);
    for (const other of ["local", "cloud", "server"]) assert.deepEqual((await main.ask("desktop-notices:state", other)).seen, [POPUP], `${name}: no page shows it again`);
    assert.equal(await main.ask("desktop-notices:this-computer", page, intent), false, `${name}: once`);
    assert.deepEqual(main.calls.filter(call => call === "this-computer"), ["this-computer"], name);
  }
  const seen = desktopMain();
  await seen.ask("desktop-notices:seen", "local", POPUP);
  assert.equal(await seen.ask("desktop-notices:this-computer", "server", "cloud-pro"), false, "a seen popup switches nothing");
  const unsold = desktopMain({ offered: false });
  assert.equal(await unsold.ask("desktop-notices:this-computer", "server", "cloud-pro"), false);
  assert.equal(unsold.calls.includes("this-computer"), false);
});

test("a switch that fails marks nothing, so a later click or launch can try again; two clicks at once switch once", async () => {
  let switches = false;
  const main = desktopMain({ switches: () => switches });
  for (const [page, intent] of [["cloud", "manage"], ["server", "cloud-pro"]]) assert.equal(await main.ask("desktop-notices:this-computer", page, intent), false);
  assert.equal(main.saved(), null);
  assert.deepEqual((await main.ask("desktop-notices:state", "server")).seen, []);
  switches = true;
  assert.equal(await main.ask("desktop-notices:this-computer", "server", "cloud-pro"), true, "a failed switch is not the one switch");
  assert.deepEqual(main.landings, ["?desktop-settings=cloud-add&source=update_popup&via=server"]);
  const both = desktopMain({ switches: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return true; } });
  const [first, second] = await Promise.all([both.ask("desktop-notices:this-computer", "server", "cloud-pro"), both.ask("desktop-notices:this-computer", "cloud", "manage")]);
  assert.deepEqual([first, second], [true, false]);
  assert.deepEqual(both.landings, ["?desktop-settings=cloud-add&source=update_popup&via=server"], "and land on the first");
});

test("the analytics switch is This computer's page's to set; a server's page in the window is told only that it is off", async () => {
  const main = desktopMain();
  for (const page of ["local", "cloud", "server", null]) assert.equal(main.read(page), null, String(page));
  await main.ask("desktop-analytics:set", "local", false);
  assert.equal(main.read("local"), false);
  assert.equal(main.read("cloud"), false, "My Cloud's page starts with analytics off");
  assert.equal(main.read("server"), false);
  assert.equal(main.read(null), null, "a page outside this desktop's window is told nothing");
  for (const page of ["cloud", "server"]) assert.throws(() => main.ask("desktop-analytics:set", page, true), /only available/);
  assert.equal(main.read("local"), false);
  await main.ask("desktop-analytics:set", "local", true);
  assert.equal(main.read("local"), true);
  assert.equal(main.read("cloud"), null, "a server's page never learns it is on");
  assert.equal(main.read("server"), null);
  const broken = desktopMain({ page: () => { throw new Error("Object has been destroyed"); } });
  assert.equal(broken.read("local"), null);
});

const PRELOAD = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function preload(origin, { activation = false, saved = null } = {}) {
  let bridge;
  const invoked = [], synced = [];
  vm.runInNewContext(PRELOAD, {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`, "--omb-company-desktop=1"] },
    location: { origin }, navigator: { userActivation: { isActive: activation } }, TextEncoder, localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {},
        sendSync: channel => { synced.push(channel); return channel === "desktop-analytics:read" ? saved : undefined; },
        invoke: (...args) => { invoked.push(args); return Promise.resolve(true); } } }),
  });
  return { bridge, invoked, synced };
}

test("the preload gives every page of the window the notices and the switch's state, and only This computer's page a way to set it", async () => {
  for (const origin of [CLOUD, VPS]) {
    const page = preload(origin, { saved: false });
    assert.equal(typeof page.bridge.desktopNotices.state, "function", origin);
    assert.equal(page.bridge.cloudAccount, undefined, origin);
    const asked = () => page.synced.filter(channel => channel.startsWith("desktop-"));
    assert.deepEqual(asked(), [], "nothing is asked until analytics asks");
    assert.equal(page.bridge.desktopAnalytics.enabled(), false, "turned off on this desktop");
    assert.deepEqual(asked(), ["desktop-analytics:read"]);
    assert.equal(page.bridge.desktopAnalytics.set, undefined, "a server's page cannot change the desktop's switch");
    await page.bridge.desktopNotices.state(); await page.bridge.desktopNotices.seen({ toString: () => POPUP }); await page.bridge.desktopNotices.shown(POPUP);
    assert.deepEqual(page.invoked, [["desktop-notices:state"], ["desktop-notices:seen", POPUP], ["desktop-notices:shown", POPUP]]);
    await assert.rejects(page.bridge.desktopNotices.thisComputer("cloud-pro"), /Choose Continue on this computer/, "only on a click");
    const clicked = preload(origin, { activation: true });
    await clicked.bridge.desktopNotices.thisComputer("cloud-pro"); await clicked.bridge.desktopNotices.thisComputer("manage");
    for (const intent of [undefined, null, "", "upgrade", "MANAGE", { toString: () => "manage" }, ["cloud-pro"], new String("cloud-pro")]) {
      await assert.rejects(clicked.bridge.desktopNotices.thisComputer(intent), /only its own click/, String(intent));
    }
    assert.deepEqual(clicked.invoked, [["desktop-notices:this-computer", "cloud-pro"], ["desktop-notices:this-computer", "manage"]], "nothing else reaches main");
  }
  const local = preload(LOCAL, { activation: true, saved: false });
  assert.equal(typeof local.bridge.desktopNotices.state, "function");
  await assert.rejects(local.bridge.desktopNotices.thisComputer("cloud-pro"), /Choose Continue/, "This computer's page has nothing to switch to");
  assert.deepEqual(local.synced, [], "nothing is asked until analytics asks");
  assert.equal(local.bridge.desktopAnalytics.enabled(), false, "answered at once, before anything loads");
  assert.equal(local.bridge.desktopAnalytics.enabled(), false);
  assert.deepEqual(local.synced, ["desktop-analytics:read"], "asked once a page");
  await local.bridge.desktopAnalytics.set(true);
  assert.equal(local.bridge.desktopAnalytics.enabled(), true);
  assert.deepEqual(local.invoked, [["desktop-analytics:set", true]]);
  const unsaved = preload(LOCAL);
  for (let i = 0; i < 3; i++) assert.equal(unsaved.bridge.desktopAnalytics.enabled(), null);
  assert.deepEqual(unsaved.synced, ["desktop-analytics:read"], "no choice saved yet is asked once too");
  assert.equal(preload(LOCAL, { saved: "off" }).bridge.desktopAnalytics.enabled(), null);
  const safe = PRELOAD.match(/const REMOTE_SAFE = new Set\(\[([^\]]*)\]\)/)[1];
  assert.ok(safe.includes('"desktopNotices"')); assert.ok(safe.includes('"desktopAnalytics"'));
});

test("production wiring: main answers this computer's page, My Cloud's own page and the active saved server's own page, and no other", async () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(main, /for \(const port of DESKTOP_PORTS\)/, "main tries the ports this module names, in order");
  assert.deepEqual([...DESKTOP_PORTS], [8799, 18799, 28799]);
  const start = main.indexOf("  registerDesktopPrefs({"), end = main.indexOf("\n", main.indexOf("thisComputer:", start));
  assert.ok(start >= 0 && end > start, "main.mjs registers the desktop prefs");
  let options = null;
  const localFrame = { url: `${LOCAL}/` }, serverFrame = { url: `${VPS}/` };
  const contents = { mainFrame: serverFrame };
  const calls = [];
  localOrigin.setLocalOrigin(LOCAL);
  let switched = async id => { calls.push(["switch", id]); }, loads = true;
  const context = vm.createContext({
    registerDesktopPrefs: value => { options = value; }, jsonFile: file => ({ read: () => file, write: () => {} }), ipcMain: {},
    path: { join: (...parts) => parts.join("/") }, app: { getPath: () => "/user-data" }, desktopDataDir: () => "/home/.openmausbot",
    navigateMainWindow: async url => { calls.push(["navigate", url]); return loads; },
    senderIsLocal: localOrigin.isLocalSender, workspaceSenderAllowed: environments.workspaceSenderAllowed,
    mainWindow: { webContents: contents }, environmentsState: { environments: [{ id: "vps", name: "VPS", origin: VPS }], activeId: "vps" },
    rendererOrigin: () => LOCAL, cloudAccountRestored: async () => calls.push("restored"), cloudOffersReady: async () => { calls.push("offers"); return true; },
    cloudPageAsking: event => event.verifiedCloud ? "cloud" : null,
    serverReady: true, LOCAL_ID: "local", switchEnvironment: id => switched(id),
    // main's own: a failed switch shows its dialog and resolves.
    workspaceMenuAction: async action => { try { await action(); } catch { calls.push("dialog"); } },
  });
  vm.runInContext(main.slice(start, end), context);
  assert.equal(options.read(), "/user-data/desktop-prefs.json");
  assert.equal(options.localConfig(), "/home/.openmausbot/config.json", "This computer's own workspace, whichever server the window shows");
  assert.equal(options.page({ sender: { mainFrame: localFrame }, senderFrame: localFrame }), "local");
  assert.equal(options.page({ sender: contents, senderFrame: serverFrame }), "server");
  assert.equal(options.page({ sender: contents, senderFrame: serverFrame, verifiedCloud: true }), "cloud", "My Cloud's page as main verifies it");
  assert.equal(options.page({ sender: contents, senderFrame: { url: `${VPS}/` } }), null, "a frame inside the server's page");
  assert.equal(options.page({ sender: {}, senderFrame: serverFrame }), null, "another window");
  const evil = { url: "https://evil.example.test/" };
  assert.equal(options.page({ sender: { mainFrame: evil }, senderFrame: evil }), null, "a page that is not the active server");
  const landing = "?desktop-settings=cloud-add&source=update_popup&via=server";
  const [offered, done] = await Promise.all([options.cloudOffered(), options.thisComputer(landing)]);
  assert.equal(offered, true); assert.equal(done, true);
  assert.deepEqual(calls, ["restored", ["switch", "local"], "offers", ["navigate", `${LOCAL}/${landing}`]], "the page loads on the click once the window has switched");
  const navigated = () => calls.filter(call => call[0] === "navigate").length;
  switched = async () => { throw new Error("could not save the servers list"); };
  assert.equal(await options.thisComputer(landing), false, "a switch that threw");
  assert.equal(calls.at(-1), "dialog", "still shows main's dialog");
  switched = async () => ({ ok: false, error: "switch-failed" });
  assert.equal(await options.thisComputer(landing), false, "a local environment switch that failed");
  switched = async () => ({ ok: false, error: "busy" });
  assert.equal(await options.thisComputer(landing), false, "another environment switch in flight");
  assert.equal(navigated(), 1, "nothing loads for a switch that failed");
  switched = async () => ({ ok: true });
  assert.equal(await options.thisComputer(landing), true);
  assert.equal(navigated(), 2);
  loads = false;
  assert.equal(await options.thisComputer(landing), false, "a page that does not load counts as no switch, so the popup is not seen");
  assert.equal(navigated(), 3);
  loads = true; context.serverReady = false;
  assert.equal(await options.thisComputer(landing), false, "no server to switch to");
  assert.equal(navigated(), 3);
  const navigate = main.slice(main.indexOf("function navigateMainWindow(url) {"), main.indexOf("\n}\n", main.indexOf("function navigateMainWindow(url) {")) + 3);
  const load = vm.runInNewContext(`${navigate}; navigateMainWindow`, { mainWindow: { isDestroyed: () => false, loadURL: async url => { if (url.endsWith("fail")) throw new Error("ERR_CONNECTION_REFUSED"); } } });
  assert.equal(await load(`${LOCAL}/ok`), true); assert.equal(await load(`${LOCAL}/fail`), false, "a failed load answers false, never throws");
  assert.equal(await vm.runInNewContext(`${navigate}; navigateMainWindow`, { mainWindow: null })(`${LOCAL}/`), false, "no window");
});
