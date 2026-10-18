// The bots' browser as the server hosts it: the engine's runtime and live view, which session a bot's browser is, and
// the integration a turn mounts. browserEngine.engine picks agent-browser (the default) or the new Chrome engine; a
// person's own Chrome (My Chrome) stays on agent-browser either way.
import { existsSync } from "node:fs";

import type { AppConfig } from "../config.ts";
import { browserEngineAttachCdpUrl, browserProfilePartitionTarget, builtInBrowserEnabled, DATA_DIR } from "../config.ts";
import { BrowserRuntime, TransportError, attachesToChrome, browserRuntimeEnv, formatBrowserTiming } from "../browser-runtime.ts";
import { RelayTimeout, relayCommand, relayInput } from "../browser-relay.ts";
import { browserSteps } from "../browser-steps.ts";
import { BrowserLive } from "../browser-live.ts";
import { browserEgress } from "../browser/egress/registry.ts";
import {
  agentBrowserIntegration,
  BUILT_IN_BROWSER_SYSTEM_PROMPT,
  browserEngineEncryptionKey,
  prepareBrowserSessionState,
  clearBrowserSessionState,
  closeBrowserSession,
  browserEngineStatus,
  inRunningBrowser,
  browserSessionId, isTemporaryBrowserSession,
  noteBrowserEngineUnavailable,
  setBrowserViewport,
} from "../browser-engine.ts";
import { BrowserSweep, browserIdleMs } from "../browser-lifecycle-cleanup.ts";
import { chromeLauncher } from "../browser/chrome/launcher.ts";
import type { HostKind } from "../browser/chrome/flags.ts";
import { browserEngineKind, type BrowserEngineKind } from "../browser/config.ts";
import { ChromeEngine, chromeTarget, LiveRouter, profileKey, RuntimeRouter } from "../browser/engines.ts";
import { CHROME_BROWSER_SYSTEM_PROMPT } from "../browser/prompt.ts";
import { augmentedPath } from "../env-path.ts";
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import type { FillLoginDeps } from "../login-fill.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "../proxy-paths.ts";
import type { Store } from "../store.ts";
import type { TurnResources } from "../turn-resources.ts";

export interface BrowserHostDeps {
  cfg: AppConfig;
  /** The store is built after this host, so it is read when used. */
  store(): Pick<Store, "bots" | "bot">;
  turnResources: Pick<TurnResources, "free">;
  activeInternalGenerationByThread: ReadonlyMap<string, string>;
  mintInternalCapability(capability: {
    botId: string; threadId: string; generation: string; browserSession: string; kind: "browser";
    depth: number; skillAuthoring: boolean; createdBots: number; openedThreads: number;
  }): string;
  DESKTOP_MANAGED: boolean;
  CLOUD_HOME: unknown;
  PORT: number;
}

type Spec = { command: string; args?: readonly string[]; env: Record<string, string> };

export function createBrowserHost(deps: BrowserHostDeps) {
  const { cfg, turnResources, activeInternalGenerationByThread, mintInternalCapability, DESKTOP_MANAGED, CLOUD_HOME, PORT } = deps;
  const store: Pick<Store, "bots" | "bot"> = { get bots() { return deps.store().bots; }, bot: (id: string) => deps.store().bot(id) };

  const agentBrowserRuntime = new BrowserRuntime({
    closeBrowser: async (session, spec) => {
      const closed = await closeBrowserSession(spec.command, browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session }));
      if (closed) browserLive.closeForSession(session);
      return closed;
    },
    applyViewport: (spec) => setBrowserViewport(spec.command, spec.env),
    launch: chromeLauncher,
    relayCommand: (spec, session, command, timeoutMs) => relayCommand(spec, session, command, timeoutMs).catch((error: unknown) => {
      throw error instanceof RelayTimeout ? new TransportError(error.message) : error;
    }),
    steps: browserSteps,
    onTiming: process.env.OMB_BROWSER_TIMING === "1" ? (timing) => console.info(formatBrowserTiming(timing)) : undefined,
  });
  const agentBrowserLive = new BrowserLive({ runtime: agentBrowserRuntime });
  const host: HostKind = DESKTOP_MANAGED ? "desktop" : CLOUD_HOME || existsSync("/.dockerenv") ? "container" : "server";
  const chromeEngine = new ChromeEngine({
    dataDir: DATA_DIR,
    host,
    egressPort: (key) => browserEgress.open(key),
    egressNotice: (key) => browserEgress.takeNotice(key),
    idleMs: () => browserIdleMs(cfg),
    log: (line) => console.warn(line),
  });
  // A tool call that would open Reddit from MausBot Cloud is refused before it reaches the browser. My Chrome is the
  // person's own, outside the egress gate too.
  const browserRuntime = new RuntimeRouter(agentBrowserRuntime, chromeEngine, {
    refusal: (spec, params) => (attachesToChrome(spec.env) ? null : browserEgress.callRefusal(params)),
  });
  const browserLive = new LiveRouter(agentBrowserLive, chromeEngine);
  const usedBrowserSessions = new Map<string, Spec>();
  browserEgress.configure({ host: DESKTOP_MANAGED ? "desktop" : CLOUD_HOME ? "cloud" : "server", config: () => cfg.browserEngine?.egress });
  // The agent-browser daemon outlives its MCP transport and this server; My Chrome is the person's own.
  const agentBrowserSweep = new BrowserSweep({
    engine: () => { const engine = browserEngineStatus(); return engine.kind === "ready" ? engine.binaryPath : null; },
    owns: (session) => isTemporaryBrowserSession(session) || store.bots.some((bot) => browserSessionId(bot.id, "") === session)
      || (cfg.browserProfiles ?? []).some((profile) => !usesMyChrome(profile.id) && currentBrowserSession("", profile.id) === session),
    live: (session) => usedBrowserSessions.has(session),
    held: (session) => !turnResources.free(`browser:${session}`),
    closeIdle: (session) => browserRuntime.closeIfIdle(session, browserIdleMs(cfg), usedBrowserSessions.get(session)),
  });
  const browserSweep = {
    start() {
      agentBrowserSweep.start();
      chromeEngine.start({ inUse: browserEngineKind(cfg) === "chrome", prepare: builtInBrowserEnabled(cfg) });
      return browserSweep;
    },
    closeAll: () => agentBrowserSweep.closeAll(),
  };
  // The viewer and the agent must address the SAME temporary browser.
  const temporaryBrowserSessions = new Map<string, string>();
  function currentBrowserSession(botId: string, profile: string | undefined): string {
    if (profile === "guest") {
      let session = temporaryBrowserSessions.get(botId);
      if (!session) {
        session = browserSessionId(botId, "guest");
        temporaryBrowserSessions.set(botId, session);
      }
      return session;
    }
    const target = profile ? browserProfilePartitionTarget(cfg, profile) : null;
    return browserSessionId(botId, target?.partitionId ?? "");
  }
  async function forgetTemporaryBrowser(botId: string): Promise<void> {
    const session = temporaryBrowserSessions.get(botId);
    if (!session) return;
    temporaryBrowserSessions.delete(botId);
    const spec = usedBrowserSessions.get(session);
    usedBrowserSessions.delete(session);
    if (chromeTarget(session, spec)) {
      await chromeEngine.service.close(session);
      return;
    }
    const engine = browserEngineStatus();
    if (engine.kind !== "ready") return;
    const closed = await clearBrowserSessionState(engine.binaryPath, session, {
      env: { PATH: augmentedPath() }, encryptionKey: browserEngineEncryptionKey(),
    });
    if (closed) await browserRuntime.close(session);
    else console.warn(`temporary browser ${session}: could not close its session; run agent-browser --session ${session} close on this server`);
  }
  function myChromeAvailable(): boolean {
    return DESKTOP_MANAGED || browserEngineAttachCdpUrl(cfg) !== null;
  }
  function usesMyChrome(profileId: string | undefined): boolean {
    return Boolean(profileId) && myChromeAvailable()
      && cfg.browserProfiles?.some((profile) => profile.id === profileId && profile.browser === "chrome") === true;
  }
  function browserSessionSpec(binaryPath: string, session: string, profile: string | undefined, egressPort?: number) {
    const attachCdpUrl = browserEngineAttachCdpUrl(cfg);
    return agentBrowserIntegration({
      binaryPath, session, encryptionKey: browserEngineEncryptionKey(), persistent: profile !== "guest", egressPort,
      env: { ...process.env, PATH: augmentedPath() },
      launcher: chromeLauncher.env(),
      ...(usesMyChrome(profile) ? { attach: attachCdpUrl ? { cdpUrl: attachCdpUrl } : {} } : {}),
    });
  }
  function browserProfileIdOf(profile: string | undefined): string | undefined {
    const target = profile && profile !== "guest" ? browserProfilePartitionTarget(cfg, profile) : null;
    return target?.profileId ?? profile;
  }
  /** The new engine runs a bot's browser when the flag is on, except in the person's own Chrome. */
  function onChrome(profile: string | undefined): boolean {
    return browserEngineKind(cfg) === "chrome" && !usesMyChrome(browserProfileIdOf(profile));
  }
  function chromeSpec(botId: string, profile: string | undefined): { session: string; spec: ReturnType<ChromeEngine["spec"]> } {
    const session = currentBrowserSession(botId, profile);
    const target = profile && profile !== "guest" ? browserProfilePartitionTarget(cfg, profile) : null;
    return { session, spec: chromeEngine.spec(session, profileKey(botId, session, { guest: profile === "guest", partitionId: target?.partitionId ?? null })) };
  }
  /** Chrome for the new engine, the installed agent-browser otherwise. */
  function browserReady(profile: string | undefined): boolean {
    return onChrome(profile) ? chromeEngine.summary().kind === "engine" : browserEngineStatus().kind === "ready";
  }
  function turnIntegration(botId: string, session: string, turn: { threadId: string; generation: string }) {
    const token = mintInternalCapability({ botId, ...turn, browserSession: session,
      kind: "browser", depth: 0, skillAuthoring: false, createdBots: 0, openedThreads: 0 });
    return {
      command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "browser"], env: {
        ...AGENTS_NODE_FLAG, [harnessMcpTokenEnv("browser")]: token, OMB_HARNESS_URL: `http://127.0.0.1:${PORT}`,
      },
    };
  }
  async function browserIntegration(botId: string, profile: string | undefined, turn?: { threadId: string; generation: string }) {
    const profileTarget = profile && profile !== "guest" ? browserProfilePartitionTarget(cfg, profile) : null;
    const partitionId = profile === "guest" ? "guest" : (profileTarget?.partitionId ?? "");
    const browserProfileId = profileTarget?.profileId ?? profile;
    if (onChrome(profile)) {
      const { session, spec } = chromeSpec(botId, profile);
      usedBrowserSessions.set(session, spec);
      return { profile: partitionId, session, spec, integration: turn ? turnIntegration(botId, session, turn) : spec };
    }
    const status = browserEngineStatus();
    if (status.kind !== "ready") {
      noteBrowserEngineUnavailable(status);
      return null;
    }
    const session = currentBrowserSession(botId, profile);
    const spec = browserSessionSpec(status.binaryPath, session, browserProfileId, usesMyChrome(browserProfileId) ? undefined : await browserEgress.open(session));
    usedBrowserSessions.set(session, spec);
    await prepareBrowserSessionState(status.binaryPath, session, { env: spec.env, persistent: profile !== "guest" && !attachesToChrome(spec.env), isCurrent: () => {
      const current = store.bot(botId);
      return !!current && current.browser !== false && builtInBrowserEnabled(cfg)
        && currentBrowserSession(current.id, current.browserProfile) === session
        && (!turn || activeInternalGenerationByThread.get(turn.threadId) === turn.generation);
    } });
    if (!turn) return { profile: partitionId, session, spec, integration: spec };
    return { profile: partitionId, session, spec, integration: turnIntegration(botId, session, turn) };
  }
  /** A bot's browser as it runs or would run now, without preparing it; null while its engine is not installed. */
  async function currentBrowserSpec(botId: string, profile: string | undefined): Promise<{ session: string; spec: Spec } | null> {
    if (onChrome(profile)) return chromeSpec(botId, profile);
    const engine = browserEngineStatus();
    if (engine.kind !== "ready") return null;
    const session = currentBrowserSession(botId, profile);
    return { session, spec: usedBrowserSessions.get(session) ?? browserSessionSpec(engine.binaryPath, session, browserProfileIdOf(profile), await browserEgress.open(session)) };
  }
  /** fill_login's reads and typing, on whichever engine runs the session. */
  function loginInput(session: string, spec: Spec, env: NodeJS.ProcessEnv): Pick<FillLoginDeps, "engine" | "insertText" | "press" | "click"> {
    if (chromeTarget(session, spec)) {
      const deps = chromeEngine.loginDeps(session);
      if (deps) return deps;
    }
    return { engine: (args) => inRunningBrowser(spec.command, env, args), ...relayInput(spec, session) };
  }
  function browserSystemPrompt(profile: string | undefined): string {
    return onChrome(profile) ? CHROME_BROWSER_SYSTEM_PROMPT : BUILT_IN_BROWSER_SYSTEM_PROMPT;
  }
  /** The signed-in sites list reads agent-browser's saved state, which My Chrome and the new browser do not keep. */
  function signedInSitesRefusal(profile: string | undefined): string | null {
    if (usesMyChrome(profile)) return "This profile uses your own Chrome. Sign in and out of sites there.";
    return onChrome(profile) ? "The new browser does not list signed-in sites yet. Sign out in the browser itself, or turn off New browser in Settings." : null;
  }
  async function closeBrowser(session: string, spec: Spec): Promise<boolean> {
    if (!chromeTarget(session, spec)) return closeBrowserSession(spec.command, browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session }));
    await chromeEngine.service.close(session);
    return true;
  }
  /** After browserEngine.engine changed: viewers reconnect and each bot's next call starts its browser on the engine now chosen. */
  function browserEngineSwitched(): void {
    browserLive.closeAll();
    for (const [session, spec] of usedBrowserSessions) {
      if (attachesToChrome(spec.env)) continue;
      usedBrowserSessions.delete(session);
      void closeBrowser(session, spec).then((closed) => {
        if (!closed) console.warn(`browser ${session}: could not close it after the browser engine changed`);
      });
    }
    if (browserEngineKind(cfg) !== "chrome") void chromeEngine.service.closeAll().catch(() => undefined);
    chromeEngine.start({ inUse: browserEngineKind(cfg) === "chrome", prepare: builtInBrowserEnabled(cfg) });
  }
  /** A deleted bot's or profile's browser on the new engine, whatever the flag says now. */
  function eraseChromeBrowser(request: { type: string; botId?: string; partitionId?: string }): Promise<boolean> {
    if (request.type === "openmausbot:browser-bot-deleted" && request.botId) return chromeEngine.erase({ kind: "bot", id: request.botId, partitionId: "" });
    if (request.partitionId) return chromeEngine.erase({ kind: "profile", id: request.partitionId, partitionId: request.partitionId });
    return Promise.resolve(true);
  }
  /** What Settings shows of the engine that runs bots' browsers here; My Chrome stays on agent-browser. */
  function engineSummary<T extends { myChrome: boolean }>(agentBrowser: T): (T | (ReturnType<ChromeEngine["summary"]> & { myChrome: boolean })) & { engine: BrowserEngineKind } {
    if (browserEngineKind(cfg) !== "chrome") return { ...agentBrowser, engine: "agent-browser" };
    return { ...chromeEngine.summary(), myChrome: agentBrowser.myChrome, engine: "chrome" };
  }

  return {
    browserRuntime, browserLive, usedBrowserSessions, browserSweep, temporaryBrowserSessions,
    currentBrowserSession, forgetTemporaryBrowser, myChromeAvailable, usesMyChrome, browserSessionSpec, browserIntegration,
    browserReady, currentBrowserSpec, loginInput, browserSystemPrompt, signedInSitesRefusal, closeBrowser, browserEngineSwitched,
    eraseChromeBrowser, engineSummary,
  };
}
