import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ home: "", script: "", socketReady: false, openMakesSocket: true, installed: true, packaged: false, requests: 0, grantFails: false, children: [], calls: [], embeddedDelays: [], hosts: [], handlers: new Map() }));
vi.mock("electron", () => ({ app: { get isPackaged() { return fixture.packaged; }, getPath: () => fixture.home }, ipcMain: { handle: (name, handler) => fixture.handlers.set(name, handler) } }));
vi.mock("@trycua/cua-driver/embedded", () => ({
  EmbeddedCuaDriverHost: class {
    constructor() { this.delay = fixture.embeddedDelays.shift(); fixture.hosts.push(this); }
    async start({ signal }) {
      if (this.delay === "until-abort") {
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      } else {
        await new Promise((resolve) => setTimeout(resolve, this.delay));
      }
      return { socketPath: `/fixture/${this.delay}.sock` };
    }
    stop = vi.fn(async () => {});
    uniffiDestroy = vi.fn();
  },
}));
vi.mock("@trycua/cua-driver/electron", () => ({
  requestMacOSPermissions: () => { fixture.requests++; return { accessibility: false, screenRecording: false }; },
  hasRequiredMacOSPermissions: () => fixture.embeddedDelays.length > 0,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original();
  return { ...fs, default: { ...fs.default, existsSync: (file) => {
    if (file === "/Applications/CuaDriver.app/Contents/MacOS/cua-driver") return fixture.installed;
    if (String(file).endsWith("/cua-driver") && String(file).includes("Resources")) return true;
    if (String(file).endsWith("cua-driver.sock")) return fixture.socketReady;
    return fs.existsSync(file);
  } } };
});
vi.mock("node:net", async (original) => {
  const net = await original();
  const { EventEmitter } = await import("node:events");
  return { ...net, default: { ...net.default, createConnection: () => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  } } };
});
vi.mock("node:child_process", async (original) => {
  const process = await original();
  const { promisify } = await import("node:util");
  const execFile = (command, args, options, callback) => {
    fixture.calls.push({ command, args, options });
    // Always run this inert Node child, never open the operator's native app.
    const script = fixture.grantFails && args[0] === "permissions" && args[1] === "grant"
      ? "process.exit(1)" : fixture.script;
    const child = process.execFile(globalThis.process.execPath, ["-e", script], options, (error, stdout, stderr) => {
      if (!error && command === "/usr/bin/open" && fixture.openMakesSocket) fixture.socketReady = true;
      callback(error, stdout, stderr);
    });
    fixture.children.push(child);
    return child;
  };
  execFile[promisify.custom] = (...args) => {
    let child;
    const promise = new Promise((resolve, reject) => {
      child = execFile(...args, (error, stdout, stderr) => error
        ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }));
    });
    promise.child = child;
    return promise;
  };
  return { ...process, execFile };
});

let cua;
let localOriginModule;
const originalResourcesPath = process.resourcesPath;
beforeEach(async () => {
  fixture.home = mkdtempSync(join(tmpdir(), "omb-cua-async-"));
  process.resourcesPath = join(fixture.home, "Resources");
  fixture.script = "setTimeout(() => process.exit(0), 120)";
  fixture.socketReady = false;
  fixture.openMakesSocket = true;
  fixture.installed = true;
  fixture.packaged = false;
  fixture.requests = 0;
  fixture.grantFails = false;
  fixture.children = [];
  fixture.calls = [];
  fixture.embeddedDelays = [];
  fixture.hosts = [];
  fixture.handlers.clear();
  vi.stubEnv("OPENMAUSBOT_CUA_EMBEDDED", "1");
  vi.stubEnv("CUA_DRIVER_PATH", "/fixture/cua-driver");
  vi.resetModules();
  cua = await import("./cua.mjs");
  localOriginModule = (await import("./local-origin.cjs")).default;
  localOriginModule.setLocalOrigin("http://127.0.0.1:19777");
});
afterEach(async () => {
  await cua?.stopCua();
  for (const child of fixture.children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
  }
  vi.unstubAllEnvs();
  process.resourcesPath = originalResourcesPath;
  localOriginModule.setLocalOrigin(null);
  rmSync(fixture.home, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "darwin")("async standalone CUA launch (isolated commands)", () => {
  it("keeps the event loop responsive and publishes the existing descriptor shape", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      await expect(cua.startCua()).resolves.toMatchObject({ mode: "standalone", mcpArgs: ["mcp"] });
      expect(ticks).toBeGreaterThan(2);
      expect(fixture.calls[0]).toMatchObject({ command: "/usr/bin/open", args: ["-a", "CuaDriver"], options: { timeout: 8_000, killSignal: "SIGKILL" } });
    } finally { clearInterval(timer); }
  });

  // Why: failures in both launch paths must remain visible after the signed launch is tried first.
  it("keeps the embedded and fallback launch failures visible", async () => {
    fixture.script = "process.stderr.write('fixture launch failure'); process.exit(4)";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await cua.startCua();
      expect(result.mode).toBe("unavailable");
      expect(result.reason).toContain("embedded host failed");
      expect(result.reason).toContain("standalone launch failed");
      expect(result.reason).toContain("fixture launch failure");
    } finally { error.mockRestore(); }
  });

  // Why: an attach that returns no connection must retain the embedded fallback and its error.
  it("keeps the embedded and fallback launch failures visible after a null attach", async () => {
    fixture.openMakesSocket = false;
    const result = await cua.startCua();
    expect(result.mode).toBe("unavailable");
    expect(result.reason).toContain("embedded host failed");
  }, 15_000);

  it("cancels a pending launch without publishing a stale ready connection", async () => {
    fixture.script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
    const started = cua.startCua();
    const aborted = expect(started).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => fixture.children.length).toBe(1);
    await cua.stopCua();
    await aborted;
    await expect.poll(() => fixture.children[0].signalCode).toBe("SIGKILL");
    expect(fixture.socketReady).toBe(false);
  });

  it("bounds a TERM-ignoring launch with forceful timeout", async () => {
    fixture.script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(cua.startCua()).resolves.toMatchObject({ mode: "unavailable", reason: expect.stringContaining("standalone launch failed") });
      expect(fixture.children[0].signalCode).toBe("SIGKILL");
    } finally { error.mockRestore(); }
  }, 22_000);

  it("does not let an aborted embedded start publish over or stop its replacement", async () => {
    fixture.installed = false;
    fixture.embeddedDelays = [150, 10];
    const first = cua.startCua();
    const aborted = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => fixture.hosts.length).toBe(1);
    await cua.stopCua();
    await expect(cua.startCua()).resolves.toMatchObject({ mode: "embedded", socketPath: "/fixture/10.sock" });
    await aborted;
    expect(fixture.hosts[0].stop).toHaveBeenCalledOnce();
    expect(fixture.hosts[1].stop).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(fixture.home, "cua-connection.json"), "utf8")).socketPath).toBe("/fixture/10.sock");
  });

  it("passes cancellation to an embedded startup stalled until abort", async () => {
    fixture.installed = false;
    fixture.embeddedDelays = ["until-abort"];
    const started = cua.startCua();
    const aborted = expect(started).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => fixture.hosts.length).toBe(1);
    await cua.stopCua();
    await aborted;
    expect(fixture.hosts[0].stop).toHaveBeenCalledOnce();
    expect(fixture.hosts[0].uniffiDestroy).toHaveBeenCalledOnce();
    expect(fixture.calls).toHaveLength(0);
  });

  it("keeps a replacement host when the previous host's Stop finishes late", async () => {
    fixture.installed = false;
    fixture.embeddedDelays = [1, 10];
    await cua.startCua();
    fixture.hosts[0].stop.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 150)));
    const stopping = cua.stopCua();
    await expect(cua.startCua()).resolves.toMatchObject({ socketPath: "/fixture/10.sock" });
    await stopping;
    expect(fixture.hosts[0].uniffiDestroy).toHaveBeenCalledOnce();
    expect(fixture.hosts[1].stop).not.toHaveBeenCalled();
    expect(fixture.hosts[1].uniffiDestroy).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(fixture.home, "cua-connection.json"), "utf8")).socketPath).toBe("/fixture/10.sock");
    await cua.stopCua();
    expect(fixture.hosts[1].stop).toHaveBeenCalledOnce();
  });

  it.each([false, true])("coalesces concurrent IPC retries and respects explicit Stop during cleanup: %s", async (cancel) => {
    fixture.installed = false;
    fixture.embeddedDelays = [1, 10, 20];
    await cua.startCua();
    let releaseStop;
    fixture.hosts[0].stop.mockImplementation(() => new Promise((resolve) => { releaseStop = resolve; }));
    cua.registerCuaIpc();
    const retry = fixture.handlers.get("cua:linux-retry");
    const event = { senderFrame: { url: "http://127.0.0.1:19777/" } };
    let attempts;
    try {
      attempts = [retry(event), retry(event)];
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(fixture.hosts).toHaveLength(1);
      expect(fixture.hosts[0].stop).toHaveBeenCalledOnce();
      if (cancel) await cua.stopCua(); // the same boundary quit calls
    } finally {
      releaseStop?.();
      fixture.hosts[0].stop.mockResolvedValue();
    }
    const results = await Promise.all(attempts);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject(cancel
      ? { enabled: false, status: "error", message: "Computer use restart cancelled" }
      : { enabled: true, status: "ready" });
    expect(fixture.hosts).toHaveLength(cancel ? 1 : 2);
    await cua.stopCua();
    for (const host of fixture.hosts) {
      expect(host.stop).toHaveBeenCalledOnce();
      expect(host.uniffiDestroy).toHaveBeenCalledOnce();
    }
    expect(JSON.parse(readFileSync(join(fixture.home, "cua-connection.json"), "utf8")).mode).toBe("unavailable");
  });

  it("cancels concurrent IPC retries during replacement startup", async () => {
    fixture.installed = false;
    fixture.embeddedDelays = [1, "until-abort"];
    await cua.startCua();
    cua.registerCuaIpc();
    const retry = fixture.handlers.get("cua:linux-retry");
    const event = { senderFrame: { url: "http://127.0.0.1:19777/" } };
    const attempts = [retry(event), retry(event)];
    await expect.poll(() => fixture.hosts.length).toBe(2);
    await cua.stopCua();
    const results = await Promise.all(attempts);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ enabled: false, status: "error" });
    for (const host of fixture.hosts) {
      expect(host.stop).toHaveBeenCalledOnce();
      expect(host.uniffiDestroy).toHaveBeenCalledOnce();
    }
    expect(JSON.parse(readFileSync(join(fixture.home, "cua-connection.json"), "utf8")).mode).toBe("unavailable");
  });

  // Why: a packaged unsigned binary must never be queried for the signed app's grants.
  it("reads permission status from the signed driver when packaged", async () => {
    fixture.packaged = true;
    vi.stubEnv("CUA_DRIVER_PATH", "");
    fixture.script = "console.log(JSON.stringify({ accessibility: true, screen_recording: true }))";
    expect(cua.resolveDriverBinary()).toBe(join(process.resourcesPath, "cua-driver"));
    await cua.cuaPermissionsStatus();
    expect(fixture.calls[0]).toMatchObject({ command: "/Applications/CuaDriver.app/Contents/MacOS/cua-driver", args: ["permissions", "status", "--json"] });
  });

  // Why: the signed daemon needs its permission cache populated without querying the unsigned bundle.
  it.each([{ status: "unknown" }, { status: "granted", accessibility: true }])("grants once when signed status is incomplete: %j", async (status) => {
    fixture.packaged = true;
    fixture.socketReady = true;
    fixture.script = `console.log(${JSON.stringify(JSON.stringify(status))})`;
    await expect(cua.startCua()).resolves.toMatchObject({ mode: "standalone" });
    expect(fixture.hosts).toHaveLength(0);
    expect(fixture.requests).toBe(0);
    expect(fixture.calls.map(({ command, args }) => [command, args])).toEqual([
      ["/Applications/CuaDriver.app/Contents/MacOS/cua-driver", ["permissions", "status", "--json"]],
      ["/Applications/CuaDriver.app/Contents/MacOS/cua-driver", ["permissions", "grant"]],
    ]);
  });

  // Why: an already-granted signed app must not raise new consent sheets.
  it("does not grant when both permissions are already true", async () => {
    fixture.packaged = true;
    fixture.socketReady = true;
    fixture.script = "console.log(JSON.stringify({ accessibility: true, screen_recording: true }))";
    await expect(cua.startCua()).resolves.toMatchObject({ mode: "standalone" });
    expect(fixture.calls.map(({ args }) => args)).toEqual([["permissions", "status", "--json"]]);
    expect(fixture.requests).toBe(0);
  });

  // Why: a failed grant must not discard an already-connected standalone daemon.
  it("keeps the standalone connection when grant fails", async () => {
    fixture.socketReady = true;
    fixture.grantFails = true;
    fixture.script = "console.log(JSON.stringify({ status: 'unknown' }))";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(cua.startCua()).resolves.toMatchObject({ mode: "standalone" });
      expect(fixture.calls.map(({ args }) => args)).toEqual([
        ["permissions", "status", "--json"], ["permissions", "grant"],
      ]);
      expect(error).toHaveBeenCalledOnce();
    } finally { error.mockRestore(); }
  });

  it("reads permission status asynchronously with bounded output", async () => {
    fixture.script = "setTimeout(() => console.log(JSON.stringify({ accessibility: true })), 120)";
    await expect(cua.cuaPermissionsStatus()).resolves.toEqual({ available: true, accessibility: true });
    expect(fixture.calls[0]).toMatchObject({ args: ["permissions", "status", "--json"], options: { timeout: 5_000, maxBuffer: 65_536, killSignal: "SIGKILL" } });
  });
});

it("does not add blocking subprocess calls to Electron runtime modules", () => {
  const root = dirname(fileURLToPath(import.meta.url));
  // These synchronous ownership checks need separate lifecycle work: the boot ID read, the Windows creation-time query, Linux group validation.
  const allowed = { "data-dir-lease.mjs": 3, "cua-linux.cjs": 2 };
  for (const entry of readdirSync(root, { recursive: true })) {
    const name = String(entry).replaceAll("\\", "/");
    if (!/\.(?:mjs|cjs)$/.test(name) || /(?:\.test\.|\.node-test\.|^vendor\/|^build-)/.test(name)) continue;
    const matches = readFileSync(join(root, name), "utf8").match(/\b(?:spawnSync|execFileSync|execSync)\b/g) ?? [];
    expect(matches.length, name).toBeLessThanOrEqual(allowed[name] ?? 0);
  }
});
