// Real processes stand in for agent-browser's: node with Chrome's telltale
// arguments, in a process group of its own, with the environment a daemon
// hands its Chrome.
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { browserProcessesRunning, browserProcessTree, orphanedBrowsers, stopBrowserProcesses } from "./browser-processes.ts";
import { removeTempDir } from "./testing/cleanup.ts";

// The real tools, except where a test stands in for Windows' tasklist and taskkill.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

const posix = process.platform !== "win32";
const groups: number[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const group of groups.splice(0)) { try { process.kill(-group, "SIGKILL"); } catch {} }
  for (const home of homes.splice(0)) await removeTempDir(home);
});

const IDLE = "setInterval(() => {}, 1000)";
/** Chrome as agent-browser starts it: its own group, a temporary profile,
 * a DevTools port, and the daemon's environment. */
const chromeArgs = (home: string, profile = join(home, "agent-browser-chrome-0000")) => ["-e", IDLE, "--", "--remote-debugging-port=0", `--user-data-dir=${profile}`];
/** agent-browser's own temporary profile folder, with something in it. */
function profileFolder(home: string, name = `agent-browser-chrome-${randomUUID()}`): string {
  const folder = join(home, name);
  mkdirSync(join(folder, "Default"), { recursive: true });
  writeFileSync(join(folder, "Default", "Cookies"), "fixture");
  return folder;
}
const daemonEnv = (home: string, session: string) => ({ PATH: process.env.PATH, HOME: home, AGENT_BROWSER_DAEMON: "1", AGENT_BROWSER_SESSION: session });
const gone = (pid: number) => {
  try { return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z"); } catch { return true; }
};

function start(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, { detached: true, stdio: "ignore", env });
  child.unref();
  groups.push(child.pid!);
  return child;
}

describe.skipIf(!posix)("browsers whose engine was killed under them", () => {
  it("finds a Chrome of a session whose daemon is gone, by the session its environment names, and stops its group", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-orphan-"));
    homes.push(home);
    // Its parent is this test, not a daemon: as good as re-parented to init.
    const profile = profileFolder(home);
    const lookalikeProfile = profileFolder(home, "agent-browser-chrome-0000");
    const orphan = start(process.execPath, chromeArgs(home, profile), daemonEnv(home, "bot-orphan"));
    // One still under its daemon (in a group of its own, as agent-browser
    // starts Chrome) is not an orphan, nor is one of another HOME.
    const servedPid = join(home, "served.pid");
    const daemon = start(process.execPath, ["-e", `const served = require('node:child_process').spawn(process.execPath, ${JSON.stringify(chromeArgs(home))}, { stdio: 'ignore', detached: true }); require('node:fs').writeFileSync(${JSON.stringify(servedPid)}, String(served.pid)); ${IDLE}`], daemonEnv(home, "bot-served"));
    const elsewhere = start(process.execPath, chromeArgs(home), daemonEnv(join(home, "other"), "bot-elsewhere"));
    // A process with the arguments and a session's name that no daemon
    // started (no AGENT_BROWSER_DAEMON) is not one either.
    const lookalike = start(process.execPath, chromeArgs(home), { PATH: process.env.PATH, HOME: home, AGENT_BROWSER_SESSION: "bot-lookalike" });
    await vi.waitFor(() => expect(existsSync(servedPid) && readFileSync(servedPid, "utf8")).toBeTruthy());
    const served = Number(readFileSync(servedPid, "utf8"));
    groups.push(served);
    await vi.waitFor(async () => expect((await orphanedBrowsers(home)).map((found) => found.session)).toEqual(["bot-orphan"]), { timeout: 5_000 });
    const [found] = await orphanedBrowsers(home);
    expect(found!.tree.groups).toEqual([orphan.pid]);
    expect(await stopBrowserProcesses(found!.tree)).toBe(true);
    expect(gone(orphan.pid!)).toBe(true);
    expect(await browserProcessesRunning(found!.tree)).toBe(false);
    for (const other of [daemon.pid!, served, elsewhere.pid!, lookalike.pid!]) expect(gone(other)).toBe(false);
    expect(existsSync(profile)).toBe(false);
    expect(existsSync(lookalikeProfile)).toBe(true);
  });

  it("stops a helper the browser started in its group, with the browser", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-orphan-"));
    homes.push(home);
    const helperPid = join(home, "helper.pid");
    // Not named the way agent-browser names its own profile folders: kept.
    const kept = profileFolder(home, "agent-browser-chrome-1111");
    const orphan = start(process.execPath, ["-e", `const helper = require('node:child_process').spawn('sleep', ['30'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(helperPid)}, String(helper.pid)); ${IDLE}`, "--", "--remote-debugging-port=0", `--user-data-dir=${join(home, "agent-browser-chrome-1111")}`], daemonEnv(home, "bot-helper"));
    await vi.waitFor(() => expect(existsSync(helperPid) && readFileSync(helperPid, "utf8")).toBeTruthy());
    const helper = Number(readFileSync(helperPid, "utf8"));
    const [found] = await orphanedBrowsers(home);
    expect(found?.session).toBe("bot-helper");
    expect(await stopBrowserProcesses(found!.tree)).toBe(true);
    expect(gone(orphan.pid!)).toBe(true);
    expect(gone(helper)).toBe(true);
    expect(existsSync(kept)).toBe(true);
  });

  it("never counts or stops a process that took the number of one of the browser's", async () => {
    const stranger = start("sleep", ["30"], { PATH: process.env.PATH });
    const tree = { daemon: stranger.pid!, members: new Map([[stranger.pid!, "an earlier process"]]), groups: [stranger.pid!] };
    expect(await browserProcessesRunning(tree)).toBe(false);
    expect(await stopBrowserProcesses(tree, 100)).toBe(true);
    expect(gone(stranger.pid!)).toBe(false);
  });

  it("stops a helper the browser starts while it exits, once the browser is gone", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-orphan-"));
    homes.push(home);
    const latePid = join(home, "late.pid");
    const ready = join(home, "ready");
    const orphan = start(process.execPath, ["-e", `process.on("SIGTERM", () => { const late = require("node:child_process").spawn("sleep", ["30"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(latePid)}, String(late.pid)); process.exit(0); }); require("node:fs").writeFileSync(${JSON.stringify(ready)}, ""); ${IDLE}`, "--", "--remote-debugging-port=0", `--user-data-dir=${profileFolder(home)}`], daemonEnv(home, "bot-late"));
    // Its command line and environment, which find it, exist from the start;
    // a SIGTERM before node has run the script above would simply kill it.
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5_000 });
    await vi.waitFor(async () => expect((await orphanedBrowsers(home)).map((found) => found.session)).toEqual(["bot-late"]), { timeout: 5_000 });
    const [found] = await orphanedBrowsers(home);
    expect(await stopBrowserProcesses(found!.tree)).toBe(true);
    const late = Number(readFileSync(latePid, "utf8"));
    expect(gone(orphan.pid!)).toBe(true);
    expect(gone(late)).toBe(true);
  });
});

// Windows soon gives a freed pid to a new process, and tasklist shows no
// start time to tell the two apart: the daemon is the image it ran when read.
describe("a browser on Windows", () => {
  const platform = process.platform;
  const actualExecFile = vi.mocked(execFile).getMockImplementation()!;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    vi.mocked(execFile).mockImplementation(actualExecFile);
  });

  it("kills the daemon's tree while the daemon runs, and never a program that took its pid or one tasklist cannot vouch for", async () => {
    // A live process answers for the pid, as whatever Windows gave it to would.
    const holder = spawn(process.execPath, ["-e", IDLE], { stdio: "ignore" });
    try {
      let image: string | null = "agent-browser.exe";
      const commands: string[][] = [];
      vi.mocked(execFile).mockImplementation(((file: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) => {
        commands.push([file, ...args]);
        if (file === "taskkill") image = ""; // the tree is gone
        const row = image ? `"${image}","${holder.pid}","Console","1","12,345 K"\r\n` : "INFO: No tasks are running which match the specified criteria.\r\n";
        queueMicrotask(() => image === null && file === "tasklist" ? done(new Error("tasklist failed"), "") : done(null, file === "tasklist" ? row : ""));
        return {} as ChildProcess;
      }) as unknown as typeof execFile);
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      // A pid file naming another program gives no tree to stop.
      image = "notepad.exe";
      expect(await browserProcessTree("/engine/agent-browser.exe", holder.pid!, "bot-a")).toBeNull();
      image = "agent-browser.exe";
      const tree = (await browserProcessTree("/engine/agent-browser.exe", holder.pid!, "bot-a"))!;
      expect(tree).toMatchObject({ daemon: holder.pid, image: "agent-browser.exe" });
      expect(await browserProcessesRunning(tree)).toBe(true);
      const killed = () => commands.filter(([file]) => file === "taskkill");
      // The daemon exited and Windows gave its pid to another program.
      image = "notepad.exe";
      expect(await browserProcessesRunning(tree)).toBe(false);
      expect(await stopBrowserProcesses(tree)).toBe(true);
      // tasklist could not say what runs there: nothing is killed, and the
      // browser is not reported stopped.
      image = null;
      expect(await stopBrowserProcesses(tree)).toBe(false);
      expect(killed()).toEqual([]);
      image = "agent-browser.exe";
      expect(await stopBrowserProcesses(tree)).toBe(true);
      expect(killed()).toEqual([["taskkill", "/PID", String(holder.pid), "/T", "/F"]]);
      expect(await browserProcessesRunning(tree)).toBe(false);
    } finally {
      holder.kill("SIGKILL");
    }
  });
});
