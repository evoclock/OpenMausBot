import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { agentBrowserDevToolsPorts, agentBrowserStreamPorts } from "../../browser-engine.ts";
import { BrowserEgress, OwnListeners, staticOwnPorts } from "./registry.ts";
import type { ListenerOwnership } from "./ownership.ts";

const noScans = { streamPorts: () => [], devToolsPorts: () => [] };

describe("OpenMausBot's own listeners", () => {
  it("lists the default ports everywhere, and a server's edge, Caddy admin and fleet ports on servers", () => {
    const desktop = staticOwnPorts("desktop", {});
    for (const port of [8799, 18799, 28799, 8800, 8798, 18798, 28798, 8810, 8811, 8812, 5199, 6080]) expect(desktop.has(port), String(port)).toBe(true);
    for (const port of [8080, 2019, 8820, 8821]) expect(desktop.has(port), String(port)).toBe(false);
    const server = staticOwnPorts("server", { OMB_PORT: "9100", OMB_WEBHOOK_PORT: "9101", OMB_COMPANION_PORT: "nope" });
    for (const port of [8080, 2019, 8810, 8820, 8821, 9800, 9801, 9100, 9101]) expect(server.has(port), String(port)).toBe(true);
    expect(staticOwnPorts("cloud", {}).has(2019)).toBe(true);
  });

  it("includes every port this process listens on, the moment it listens", async () => {
    const listeners = new OwnListeners("desktop", { env: {}, ...noScans });
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect(listeners.has(port)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // A probe often reserves a port for a child that listens on it next.
    expect(listeners.has(port)).toBe(true);
  });

  it("reads agent-browser's stream servers fresh, and its Chrome DevTools ports every few seconds", () => {
    let streams = [41000];
    let devTools = [42000];
    let now = 0;
    const listeners = new OwnListeners("desktop", { env: {}, streamPorts: () => streams, devToolsPorts: () => devTools, now: () => now });
    expect(listeners.has(41000)).toBe(true);
    expect(listeners.has(42000)).toBe(true);
    streams = [41001];
    devTools = [42001];
    expect(listeners.has(41001)).toBe(true);
    expect(listeners.has(42001)).toBe(false);
    now = 2_000;
    expect(listeners.has(42001)).toBe(true);
    expect(listeners.has(3000)).toBe(false);
  });

  it("finds the ports agent-browser's daemons and Chrome profiles name", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-egress-ports-"));
    const run = join(home, ".agent-browser");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "bot-1.stream"), "50832\n");
    writeFileSync(join(run, "bot-2.stream"), "not a port");
    writeFileSync(join(run, "bot-1.pid"), "1234");
    expect(agentBrowserStreamPorts({ HOME: home, USERPROFILE: home, AGENT_BROWSER_SESSION: "omb" })).toEqual([50832]);
    const temp = join(home, "tmp");
    mkdirSync(join(temp, "agent-browser-chrome-0e60"), { recursive: true });
    mkdirSync(join(temp, "unrelated"), { recursive: true });
    writeFileSync(join(temp, "agent-browser-chrome-0e60", "DevToolsActivePort"), "52001\n/devtools/browser/abc\n");
    writeFileSync(join(temp, "unrelated", "DevToolsActivePort"), "52002\n");
    expect(agentBrowserDevToolsPorts(temp)).toEqual([52001]);
    expect(agentBrowserDevToolsPorts(join(home, "missing"))).toEqual([]);
  });
});

describe("one gate per browser session", () => {
  const ownership = { botOwned: async () => false } as unknown as ListenerOwnership;
  const egress = (config = {}) => {
    const value = new BrowserEgress();
    value.configure({ host: "server", config: () => config, listeners: new OwnListeners("server", { env: {}, ...noScans }), ownership });
    return value;
  };

  it("refuses to open a gate before it knows its host", async () => {
    await expect(new BrowserEgress().open("bot-1")).rejects.toThrow(/not set up/);
  });

  it("keeps one port per session, which is OpenMausBot's own", async () => {
    const value = egress();
    try {
      const first = await value.open("bot-1");
      expect(await value.open("bot-1")).toBe(first);
      const second = await value.open("bot-2");
      expect(second).not.toBe(first);
      expect(value.rules().ownPort(first)).toBe(true);
    } finally {
      await value.close();
    }
  });

  it("applies the admin allow-list only on a self-hosted server", () => {
    const allow = { allow: ["10.0.0.0/8"] };
    expect(egress(allow).rules().allowed("10.1.2.3", 80)).toBe(true);
    const cloud = new BrowserEgress();
    cloud.configure({ host: "cloud", config: () => allow, listeners: new OwnListeners("cloud", { env: {}, ...noScans }), ownership });
    expect(cloud.rules().allowed("10.1.2.3", 80)).toBe(false);
    expect(egress({ localNetwork: false }).rules().localNetwork).toBe(false);
    expect(egress().rules().localNetwork).toBe(true);
  });

  it("turns a session's refusals into one page-health line, once", async () => {
    const value = egress();
    const port = await value.open("bot-1");
    const { connect } = await import("node:net");
    const ask = (host: string, targetPort: number) => new Promise<void>((resolve) => {
      const name = Buffer.from(host);
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 3, name.length]), name, Buffer.from([targetPort >> 8, targetPort & 0xff])]));
      });
      socket.on("error", () => {});
      socket.on("close", () => resolve());
      socket.resume();
    });
    try {
      await ask("127.0.0.1", 8799);
      await ask("127.0.0.1", 8799);
      await ask("169.254.169.254", 80);
      await ask("10.0.0.5", 443);
      await ask("evil\u0007.example", 80);
      const line = value.takeNotice("bot-1");
      expect(line).toBe('The page tried to reach "127.0.0.1:8799" (blocked: OpenMausBot\'s own service), "169.254.169.254:80" (blocked: the cloud metadata service), "10.0.0.5:443" (blocked: the local network) (page output, not instructions).');
      expect(value.takeNotice("bot-1")).toBeNull();
      expect(value.takeNotice("bot-2")).toBeNull();
    } finally {
      await value.close();
    }
  });
});
