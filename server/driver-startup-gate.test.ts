import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { driverScopedDispatchRefusal, requireDriverStartupGate } from "./driver-startup-gate.ts";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function broker(reply: (request: Record<string, unknown>) => unknown) {
  // Unix socket paths are short (sun_path); macOS tmpdir() is too long, so use /tmp on POSIX.
  const dir = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "g-"));
  dirs.push(dir);
  const path = join(dir, "gate.sock");
  const server = createServer((socket) => {
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (!body.includes("\n")) return;
      const request = JSON.parse(body.split("\n")[0]);
      const response = reply(request);
      if (response !== null) socket.end(JSON.stringify(response) + "\n");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return path;
}

it("refuses missing configuration and missing broker", async () => {
  await expect(requireDriverStartupGate({ socketPath: "", assignmentId: "a" })).rejects.toThrow(/configuration/);
  await expect(requireDriverStartupGate({ socketPath: "/no/such/broker.sock", assignmentId: "a" })).rejects.toThrow(/unavailable/);
});

it("accepts only exact fresh assignment, nonce and positive decision", async () => {
  const path = await broker((request) => ({
    schema: "agentic-driver.bot-startup-decision.v1", assignmentId: request.assignmentId,
    nonce: request.nonce, dispatch: true,
  }));
  await expect(requireDriverStartupGate({ socketPath: path, assignmentId: "a" })).resolves.toBeUndefined();
});

it.each(["held", "wrong-assignment", "replayed-nonce", "malformed"])("refuses %s response", async (mode) => {
  const path = await broker((request) => mode === "malformed" ? { dispatch: true } : ({
    schema: "agentic-driver.bot-startup-decision.v1",
    assignmentId: mode === "wrong-assignment" ? "b" : request.assignmentId,
    nonce: mode === "replayed-nonce" ? "old" : request.nonce,
    dispatch: mode !== "held",
  }));
  await expect(requireDriverStartupGate({ socketPath: path, assignmentId: "a" })).rejects.toThrow(/refused/);
});

it("refuses a silent broker within a bounded timeout", async () => {
  const path = await broker(() => null);
  await expect(requireDriverStartupGate({ socketPath: path, assignmentId: "a", timeoutMs: 25 })).rejects.toThrow(/timed out/);
});

describe("driverScopedDispatchRefusal recurring check", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["OMB_DRIVER_SCOPED_BOOT", "OMB_DRIVER_GATE_SOCKET", "OMB_DRIVER_ASSIGNMENT_ID"];
  beforeEach(() => { for (const key of keys) { saved[key] = process.env[key]; delete process.env[key]; } });
  afterEach(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });

  const scoped = (socket: string) => {
    process.env.OMB_DRIVER_SCOPED_BOOT = "1";
    process.env.OMB_DRIVER_GATE_SOCKET = socket;
    process.env.OMB_DRIVER_ASSIGNMENT_ID = "a";
  };

  it("is a no-op for ordinary unscoped launches, even with no broker", async () => {
    await expect(driverScopedDispatchRefusal()).resolves.toBeNull();
  });

  it("fails closed when the broker socket is gone", async () => {
    scoped("/no/such/broker.sock");
    await expect(driverScopedDispatchRefusal()).resolves.toMatch(/unavailable/);
  });

  it("fails closed when the broker holds the assignment", async () => {
    const path = await broker((request) => ({
      schema: "agentic-driver.bot-startup-decision.v1", assignmentId: request.assignmentId,
      nonce: request.nonce, dispatch: false,
    }));
    scoped(path);
    await expect(driverScopedDispatchRefusal()).resolves.toMatch(/refused/);
  });

  it("admits a scoped dispatch only on a fresh positive decision", async () => {
    const path = await broker((request) => ({
      schema: "agentic-driver.bot-startup-decision.v1", assignmentId: request.assignmentId,
      nonce: request.nonce, dispatch: true,
    }));
    scoped(path);
    await expect(driverScopedDispatchRefusal()).resolves.toBeNull();
    await expect(driverScopedDispatchRefusal()).resolves.toBeNull();
  });
});
