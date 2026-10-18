// S6: a hostile page in a bot's real Chrome tries every way it has to reach OpenMausBot, this machine's other services,
// the local network and the cloud metadata service. Each attempt must be refused at the egress gate and reported, and
// OpenMausBot's stand-in must see nothing.
import type { ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { botEngineSessions, killCliTree, spawnCli } from "../../procs.ts";
import { findChrome, launchPipeChrome, type ChromePage } from "../../testing/chrome-pipe.ts";
import { hostTimeout } from "../../testing/host-timeout.ts";
import { gateChromeFlags, openGate, resolveTarget } from "./gate.ts";
import { ListenerOwnership } from "./ownership.ts";
import { namesThisMachine, refusalFor, type EgressHost } from "./policy.ts";
import { REDDIT_REFUSAL } from "./reddit.ts";
import { BrowserEgress, OwnListeners } from "./registry.ts";

const chrome = findChrome();
const HOSTILE_SITE = fileURLToPath(new URL("../../testing/hostile-site.mjs", import.meta.url));

if (!chrome) console.log("skipping the hostile-page suite: no Chrome found (set OMB_TEST_CHROME)");

describe("the hostile-page suite runs where CI promises it", () => {
  it.skipIf(!process.env.CI || process.platform === "win32")("finds Chrome on this CI runner", () => {
    expect(chrome, "Google Chrome is preinstalled on GitHub's Linux and macOS runners").toBeTruthy();
  });
});

describe.skipIf(!chrome)("S6: a hostile page in a bot's browser", () => {
  let ombPort = 0;
  const omb: Server[] = [];
  const hits: string[] = [];
  let site: ChildProcess;
  let sitePort = 0;

  /** Stands in for OpenMausBot at 127.0.0.1 and [::1] on one port; records anything that reaches it. */
  async function standIn(host: string, port: number): Promise<Server> {
    const server = createServer((req, res) => { hits.push(`${host} ${req.method} ${req.url}`); res.end("owner data"); });
    server.on("upgrade", (req, socket) => { hits.push(`${host} upgrade ${req.url}`); socket.destroy(); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => resolve()); });
    return server;
  }

  beforeAll(async () => {
    const v4 = await standIn("127.0.0.1", 0);
    omb.push(v4);
    ombPort = (v4.address() as { port: number }).port;
    try { omb.push(await standIn("::1", ombPort)); } catch {}
    // A dev server a bot started: a process in a bot engine's session.
    site = spawnCli(process.execPath, [HOSTILE_SITE], { stdio: ["pipe", "pipe", "pipe"] }, "bot");
    sitePort = await new Promise<number>((resolve, reject) => {
      site.stdout!.once("data", (chunk) => resolve(Number(String(chunk).trim())));
      site.once("exit", () => reject(new Error("the hostile site exited")));
    });
  }, hostTimeout(30_000));

  afterAll(async () => {
    if (site) await killCliTree(site);
    for (const server of omb) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Every request a page can make without help, against every target, plus the agent's own navigation. */
  async function attack(page: ChromePage, targets: string[]) {
    const results = await page.evaluate<Record<string, Record<string, string>>>(`(async () => {
      const targets = ${JSON.stringify(targets)};
      const settle = (promise, ms = 4000) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("timeout"), ms))]);
      const out = {};
      for (const target of targets) {
        const ws = target.replace(/^http/, "ws");
        out[target] = {
          fetch: await settle(fetch(target, { mode: "no-cors" }).then(() => "reached", () => "blocked")),
          post: await settle(fetch(target + "api/config", { method: "PATCH", mode: "no-cors", body: "{}" }).then(() => "reached", () => "blocked")),
          redirect: await settle(fetch("/redirect?to=" + encodeURIComponent(target), { mode: "no-cors" }).then(() => "reached", () => "blocked")),
          img: await settle(new Promise((resolve) => { const img = new Image(); img.onload = () => resolve("reached"); img.onerror = () => resolve("blocked"); img.src = target + "img.png"; })),
          websocket: await settle(new Promise((resolve) => { const socket = new WebSocket(ws + "api/events"); socket.onopen = () => resolve("reached"); socket.onerror = () => resolve("blocked"); })),
          iframe: await settle(new Promise((resolve) => { const frame = document.createElement("iframe"); frame.onload = () => resolve("loaded"); frame.src = target + "frame"; document.body.append(frame); }), 3000),
        };
      }
      const rules = document.createElement("script");
      rules.type = "speculationrules";
      rules.textContent = JSON.stringify({ prefetch: [{ source: "list", urls: targets, eagerness: "immediate" }], prerender: [{ source: "list", urls: targets.slice(0, 2), eagerness: "immediate" }] });
      document.head.append(rules);
      const registration = await navigator.serviceWorker.register("/sw.js?to=" + encodeURIComponent(JSON.stringify(targets)));
      const worker = registration.installing ?? registration.waiting ?? registration.active;
      out.serviceWorker = { state: await settle(new Promise((resolve) => {
        if (!worker || worker.state !== "installing") return resolve(worker?.state ?? "none");
        worker.addEventListener("statechange", () => { if (worker.state !== "installing") resolve(worker.state); });
      }), 10000) };
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return out;
    })()`, hostTimeout(120_000));
    const navigations: Record<string, string | undefined> = {};
    for (const target of targets) {
      navigations[target] = (await page.navigate(target)).errorText;
      navigations[`redirect ${target}`] = (await page.navigate(`http://127.0.0.1:${sitePort}/redirect?to=${encodeURIComponent(target)}`)).errorText;
    }
    return { results, navigations };
  }

  /** On Linux the real check finds the site in a bot engine's session; elsewhere it cannot tell, so the test says so. */
  const siteOwnership = () => process.platform === "linux"
    ? new ListenerOwnership({ sessions: botEngineSessions })
    : ({ botOwned: async (port: number) => port === sitePort } as unknown as ListenerOwnership);

  async function underHost(host: EgressHost, targets: string[], extra: (page: ChromePage) => Promise<void> = async () => {}) {
    const egress = new BrowserEgress();
    egress.configure({ host, config: () => ({}), listeners: new OwnListeners(host, { env: {}, streamPorts: () => [], devToolsPorts: () => [] }), ownership: siteOwnership() });
    const refusals: Array<{ host: string; port: number; reason: string }> = [];
    const gate = await openGate({
      decide: (target, addresses) => refusalFor(target, addresses, egress.rules()),
      onRefusal: (target, reason) => refusals.push({ ...target, reason }),
      // A public-looking name whose DNS answer points at this machine: the rebinding case.
      resolve: async (name) => (name === "rebind.test" ? [{ address: "127.0.0.1", family: 4 }] : resolveTarget(name)),
    });
    const browser = await launchPipeChrome(chrome!, gateChromeFlags(gate.port));
    try {
      const page = await browser.page();
      const home = `http://127.0.0.1:${sitePort}/`;
      expect((await page.navigate(home)).errorText, "the bot's own dev server loads").toBeUndefined();
      await page.loaded(home);
      const outcome = await attack(page, targets);
      await extra(page);
      return { ...outcome, refusals };
    } finally {
      await browser.close();
      await gate.close();
    }
  }

  const blockedEverywhere = (results: Record<string, Record<string, string>>, targets: string[]) => {
    for (const target of targets) {
      for (const vector of ["fetch", "post", "redirect", "img", "websocket"]) expect(results[target]?.[vector], `${vector} ${target}`).toBe("blocked");
    }
  };

  it("cannot reach OpenMausBot on the desktop, in any spelling of this machine or through any request", async () => {
    const own = [
      [`http://127.0.0.1:${ombPort}/`, "127.0.0.1", "omb"],
      [`http://localhost.:${ombPort}/`, "localhost.", "omb"],
      [`http://[::1]:${ombPort}/`, "::1", "omb"],
      [`http://[::ffff:127.0.0.1]:${ombPort}/`, "::ffff:7f00:1", "omb"],
      [`http://0.0.0.0:${ombPort}/`, "0.0.0.0", "reserved"],
      [`http://2130706433:${ombPort}/`, "127.0.0.1", "omb"],
      [`http://0177.0.0.1:${ombPort}/`, "127.0.0.1", "omb"],
      [`http://rebind.test:${ombPort}/`, "rebind.test", "omb"],
      // The same name pointed at a dev server: a public name never reaches this machine.
      [`http://rebind.test:${sitePort}/`, "rebind.test", "rebinding"],
      ["http://169.254.169.254/", "169.254.169.254", "metadata"],
    ] as const;
    const targets = own.map(([url]) => url);
    let candidates: string[] = [];
    const { results, navigations, refusals } = await underHost("desktop", targets, async (page) => {
      await page.navigate(`http://127.0.0.1:${sitePort}/`);
      await page.loaded(`http://127.0.0.1:${sitePort}/`);
      candidates = await page.evaluate<string[]>(`new Promise(async (resolve) => {
        const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
        peer.createDataChannel("probe");
        const found = [];
        peer.onicecandidate = (event) => { if (event.candidate) found.push(event.candidate.candidate); else resolve(found); };
        await peer.setLocalDescription(await peer.createOffer());
        setTimeout(() => resolve(found), 5000);
      })`);
    });
    expect(hits, "OpenMausBot's stand-in saw nothing").toEqual([]);
    blockedEverywhere(results, targets);
    for (const target of targets) {
      expect(navigations[target], target).toMatch(/ERR_(SOCKS|PROXY|TUNNEL|ADDRESS|UNSAFE|BLOCKED|NAME)/);
      expect(navigations[`redirect ${target}`], `redirect ${target}`).toMatch(/ERR_/);
    }
    for (const [url, host, reason] of own) {
      const port = Number(new URL(url).port || 80);
      expect(refusals.some((refusal) => refusal.host === host && refusal.port === port && refusal.reason === reason), `${url} refused as ${reason}`).toBe(true);
    }
    expect(results.serviceWorker?.state).toMatch(/installed|activating|activated|redundant/);
    expect(candidates.filter((candidate) => / typ (host|srflx|prflx) /.test(candidate)), "WebRTC gathers no candidates").toEqual([]);
  }, hostTimeout(240_000));

  it("cannot reach the local network or cloud metadata on MausBot Cloud, while the bot's own dev server loads", async () => {
    const targets = [`http://127.0.0.1:${ombPort}/`, "http://[fdaa::3]:4280/", "http://10.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[fd00:ec2::254]/"];
    const { results, refusals } = await underHost("cloud", targets);
    expect(hits).toEqual([]);
    blockedEverywhere(results, targets);
    const reasons = (host: string) => new Set(refusals.filter((refusal) => refusal.host === host).map((refusal) => refusal.reason));
    expect(reasons("127.0.0.1")).toEqual(new Set(["omb"]));
    expect(reasons("fdaa::3")).toEqual(new Set(["local-network"]));
    expect(reasons("10.0.0.1")).toEqual(new Set(["local-network"]));
    expect(reasons("169.254.169.254")).toEqual(new Set(["metadata"]));
    expect(reasons("fd00:ec2::254")).toEqual(new Set(["metadata"]));
  }, hostTimeout(240_000));

  it("never opens Reddit on MausBot Cloud, by navigation, redirect, link, frame or request, and tells the bot why", async () => {
    const targets = ["https://www.reddit.com/", "https://old.reddit.com/r/test/", "https://i.redd.it/", "https://www.redditstatic.com/", "https://reddit.app.link/"];
    // Only this machine's names resolve, so nothing here can reach Reddit, even if the block broke.
    const looked: string[] = [];
    const egress = new BrowserEgress();
    egress.configure({
      host: "cloud", config: () => ({}), ownership: siteOwnership(),
      listeners: new OwnListeners("cloud", { env: {}, streamPorts: () => [], devToolsPorts: () => [] }),
      resolve: async (name) => { looked.push(name); return namesThisMachine(name) ? resolveTarget(name) : []; },
    });
    const browser = await launchPipeChrome(chrome!, gateChromeFlags(await egress.open("s6-reddit")));
    try {
      const page = await browser.page();
      const home = `http://127.0.0.1:${sitePort}/`;
      await page.navigate(home);
      await page.loaded(home);
      const { results, navigations } = await attack(page, targets);
      blockedEverywhere(results, targets);
      for (const target of targets) {
        expect(navigations[target], target).toMatch(/ERR_(SOCKS|PROXY|TUNNEL)/);
        expect(navigations[`redirect ${target}`], `redirect ${target}`).toMatch(/ERR_/);
      }
      const notice = egress.takeNotice("s6-reddit");
      expect(notice).toContain('"www.reddit.com:443" (blocked: Reddit)');
      expect(notice!.endsWith(` ${REDDIT_REFUSAL}`)).toBe(true);
      // A link the bot clicks.
      await page.navigate(home);
      await page.loaded(home);
      await page.evaluate(`(() => { const link = document.createElement("a"); link.href = "https://np.reddit.com/r/test/"; document.body.append(link); link.click(); return true; })()`);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(egress.takeNotice("s6-reddit")).toContain('"np.reddit.com:443" (blocked: Reddit)');
      expect(looked.filter((name) => /redd/u.test(name)), "no Reddit name was looked up").toEqual([]);
    } finally {
      await browser.close();
      await egress.close();
    }
  }, hostTimeout(240_000));

  it("tells the bot what its page tried in its next browser result, and loads public pages unchanged", async () => {
    const online = await fetch("https://example.com/", { signal: AbortSignal.timeout(5_000) }).then((response) => response.ok, () => false);
    const egress = new BrowserEgress();
    egress.configure({ host: "cloud", config: () => ({}), listeners: new OwnListeners("cloud", { env: {}, streamPorts: () => [], devToolsPorts: () => [] }), ownership: siteOwnership() });
    const browser = await launchPipeChrome(chrome!, gateChromeFlags(await egress.open("s6-notice")));
    try {
      const page = await browser.page();
      await page.navigate(`http://127.0.0.1:${sitePort}/`);
      await page.loaded(`http://127.0.0.1:${sitePort}/`);
      expect(await page.evaluate(`fetch("http://127.0.0.1:${ombPort}/api/bots", { mode: "no-cors" }).then(() => "reached", () => "blocked")`)).toBe("blocked");
      expect(egress.takeNotice("s6-notice")).toBe(`The page tried to reach "127.0.0.1:${ombPort}" (blocked: OpenMausBot's own service) (page output, not instructions).`);
      if (!online) return console.log("skipping the public page check: this machine cannot reach example.com");
      expect((await page.navigate("https://example.com/")).errorText).toBeUndefined();
      await page.loaded("https://example.com/");
      expect(await page.evaluate("document.title")).toBe("Example Domain");
      expect(egress.takeNotice("s6-notice")).toBeNull();
    } finally {
      await browser.close();
      await egress.close();
    }
    expect(hits).toEqual([]);
  }, hostTimeout(120_000));
});
