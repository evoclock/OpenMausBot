// The driver's real-Chrome suites run when OMB_CDP_CHROME names a Chrome, or
// when OMB_CDP_E2E=1 asks for the one installed in the usual place (GitHub's
// runners have Google Chrome). Otherwise they are skipped.
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeTempDir } from "../../../testing/cleanup.ts";
import { launchChrome, type ChromeProcess, type LaunchOptions } from "../../chrome/launch.ts";
import { sandboxDisabled } from "../../chrome/host-setup.ts";
import { CdpBrowser, type BrowserOptions } from "../browser.ts";
import { tracingTransport, type SentCommand } from "../transport.ts";

const INSTALLED: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"],
  win32: [
    `${process.env["PROGRAMFILES"] ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["LOCALAPPDATA"] ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
};

export function chromeForTests(): string | null {
  const named = process.env.OMB_CDP_CHROME;
  if (named) {
    if (!existsSync(named)) throw new Error(`OMB_CDP_CHROME names no file: ${named}`);
    return named;
  }
  if (process.env.OMB_CDP_E2E !== "1") return null;
  const found = (INSTALLED[process.platform] ?? []).find((path) => existsSync(path));
  if (!found) throw new Error("OMB_CDP_E2E=1 but no installed Google Chrome was found; set OMB_CDP_CHROME.");
  return found;
}

export const CHROME = chromeForTests();
if (!CHROME) console.log("skipping omb-cdp real-Chrome suites: set OMB_CDP_CHROME to a Chrome executable, or OMB_CDP_E2E=1 to use the installed Google Chrome");

/** A runner's first Chrome launch builds caches (and on Windows waits for a scan of the binary): over 30 s on GitHub's runners. */
export const FIRST_LAUNCH_MS = 120_000;

/** Linux CI on containers and some runners needs the operator opt-out; never set by the driver itself. */
const sandbox = !sandboxDisabled(process.env);

export const HOST = process.env.OMB_CDP_HOST === "container" ? "container" : process.env.OMB_CDP_HOST === "server" ? "server" : "desktop";

export function testRoot(): string {
  const root = process.env.OMB_CDP_TEST_TMP ?? tmpdir();
  mkdirSync(root, { recursive: true });
  return root;
}

export interface TracedCommand extends SentCommand {
  label: string;
  /** Sent while a test deliberately evaluated in the page's own world. */
  pageWorld: boolean;
}

/** Every command a suite's browsers sent, for the forbidden-method assertion. */
export const TRACE: TracedCommand[] = [];

let pageWorldCalls = 0;

/** Marks the commands `work` sends as a deliberate page-world evaluation. */
export async function inPageWorld<T>(work: () => Promise<T>): Promise<T> {
  pageWorldCalls++;
  try {
    return await work();
  } finally {
    pageWorldCalls--;
  }
}

/** Kept apart from the driver's own guard on purpose: a trace is checked against the design's list, not the code under test. */
const FORBIDDEN = /^(?:Runtime\.enable|Runtime\.addBinding|Console\.\w+|Debugger\.\w+|Profiler\.\w+|HeapProfiler\.\w+|Network\.getAllCookies)$/;

export function forbiddenCommand(sent: Pick<TracedCommand, "method" | "params" | "pageWorld">): boolean {
  if (FORBIDDEN.test(sent.method)) return true;
  if (sent.method === "Runtime.evaluate" && sent.params.contextId === undefined) return !sent.pageWorld;
  return sent.method === "Page.addScriptToEvaluateOnNewDocument" && !sent.params.worldName;
}

export function forbiddenCommands(trace: readonly TracedCommand[] = TRACE): string[] {
  return trace.filter(forbiddenCommand).map((sent) => `${sent.label}: ${sent.method} ${JSON.stringify(sent.params).slice(0, 120)}`);
}

export interface RunningChrome {
  chrome: ChromeProcess;
  browser: CdpBrowser;
  dir: string;
  trace: TracedCommand[];
  close(): Promise<void>;
}

export async function startChrome(label: string, { launch = {}, browser: browserOptions = {} }: { launch?: Partial<LaunchOptions>; browser?: BrowserOptions } = {}): Promise<RunningChrome> {
  if (!CHROME) throw new Error("No Chrome to test with.");
  const dir = mkdtempSync(join(testRoot(), "omb-cdp-"));
  const chrome = await launchChrome({
    executablePath: CHROME,
    userDataDir: join(dir, "profile"),
    mode: "headless",
    host: HOST,
    sandbox,
    handshakeTimeoutMs: FIRST_LAUNCH_MS,
    ...launch,
  });
  const trace: TracedCommand[] = [];
  const transport = tracingTransport(chrome.transport, (sent) => {
    const traced = { ...sent, label, pageWorld: pageWorldCalls > 0 };
    trace.push(traced);
    TRACE.push(traced);
  });
  const browser = await CdpBrowser.connect(transport, { downloadDir: join(dir, "downloads"), ...browserOptions });
  return {
    chrome,
    browser,
    dir,
    trace,
    async close() {
      await browser.close().catch(() => {});
      await chrome.close(3_000);
      await removeTempDir(dir);
    },
  };
}
