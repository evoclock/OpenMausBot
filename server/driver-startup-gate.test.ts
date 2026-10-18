import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  captureDriverScopedGateConfig,
  createDriverScopedDispatchRefusal,
  createDriverScopedWriteGate,
  requireDriverStartupGate,
  runDriverScopedModelCall,
  type DriverScopedGateConfig,
} from "./driver-startup-gate.ts";

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

describe("driver-scoped recurring checks", () => {
  const scoped = (socket: string): DriverScopedGateConfig => ({ enabled: true, socketPath: socket, assignmentId: "a" });

  it("leaves ordinary unscoped model calls alone after later environment changes", async () => {
    const env: NodeJS.ProcessEnv = {};
    const config = captureDriverScopedGateConfig(env);
    env.OMB_DRIVER_SCOPED_BOOT = "1";
    env.OMB_DRIVER_GATE_SOCKET = "/no/such/broker.sock";
    env.OMB_DRIVER_ASSIGNMENT_ID = "a";
    const refusal = createDriverScopedDispatchRefusal(config);
    let calls = 0;
    await expect(runDriverScopedModelCall(async () => ++calls, refusal)).resolves.toBe(1);
    expect(calls).toBe(1);
  });

  it("fails closed before a scoped write when the broker socket is gone", async () => {
    const refusal = createDriverScopedDispatchRefusal(scoped("/no/such/broker.sock"));
    await expect(refusal()).resolves.toMatch(/unavailable/);
    await expect(createDriverScopedWriteGate(refusal)()).rejects.toThrow(/unavailable/);
  });

  it("fails closed when the broker holds the assignment", async () => {
    const path = await broker((request) => ({
      schema: "agentic-driver.bot-startup-decision.v1", assignmentId: request.assignmentId,
      nonce: request.nonce, dispatch: false,
    }));
    const refusal = createDriverScopedDispatchRefusal(scoped(path));
    await expect(refusal()).resolves.toMatch(/refused/);
  });

  it("admits a scoped dispatch only on a fresh positive decision", async () => {
    const path = await broker((request) => ({
      schema: "agentic-driver.bot-startup-decision.v1", assignmentId: request.assignmentId,
      nonce: request.nonce, dispatch: true,
    }));
    const refusal = createDriverScopedDispatchRefusal(scoped(path));
    await expect(refusal()).resolves.toBeNull();
    await expect(refusal()).resolves.toBeNull();
  });

  it("keeps the scoped marker and broker identity from mutable environment changes", async () => {
    const path = await broker((request) => ({
      schema: "agentic-driver.bot-startup-decision.v1", assignmentId: request.assignmentId,
      nonce: request.nonce, dispatch: false,
    }));
    const env: NodeJS.ProcessEnv = {
      OMB_DRIVER_SCOPED_BOOT: "1",
      OMB_DRIVER_GATE_SOCKET: path,
      OMB_DRIVER_ASSIGNMENT_ID: "a",
    };
    const config = captureDriverScopedGateConfig(env);
    const refusal = createDriverScopedDispatchRefusal(config);
    env.OMB_DRIVER_SCOPED_BOOT = "0";
    env.OMB_DRIVER_GATE_SOCKET = "/no/such/broker.sock";
    env.OMB_DRIVER_ASSIGNMENT_ID = "b";
    await expect(refusal()).resolves.toMatch(/refused/);
  });

  it("blocks a memory write when the broker holds after an allowed model call", async () => {
    let held = false;
    const path = await broker((request) => ({
      schema: "agentic-driver.bot-startup-decision.v1", assignmentId: request.assignmentId,
      nonce: request.nonce, dispatch: !held,
    }));
    const refusal = createDriverScopedDispatchRefusal(scoped(path));
    const beforeWrite = createDriverScopedWriteGate(refusal);
    let modelCalls = 0;
    let writes = 0;
    await expect(runDriverScopedModelCall(async () => {
      modelCalls += 1;
      return "facts";
    }, refusal)).resolves.toBe("facts");
    held = true;

    const persist = async () => {
      await beforeWrite();
      writes += 1;
    };
    await expect(persist()).rejects.toThrow(/refused/);
    expect(modelCalls).toBe(1);
    expect(writes).toBe(0);
  });

  it("does not start title or memory-upkeep provider calls after a scoped hold", async () => {
    const path = await broker((request) => ({
      schema: "agentic-driver.bot-startup-decision.v1", assignmentId: request.assignmentId,
      nonce: request.nonce, dispatch: false,
    }));
    const refusal = createDriverScopedDispatchRefusal(scoped(path));
    let titleCalls = 0;
    let upkeepCalls = 0;
    const titleGenerateText = () => runDriverScopedModelCall(async () => {
      titleCalls += 1;
      return "a title";
    }, refusal);
    const upkeepGenerateText = () => runDriverScopedModelCall(async () => {
      upkeepCalls += 1;
      return "memory facts";
    }, refusal);

    await expect(titleGenerateText()).rejects.toThrow(/refused/);
    await expect(upkeepGenerateText()).rejects.toThrow(/refused/);
    expect(titleCalls).toBe(0);
    expect(upkeepCalls).toBe(0);
  });
});
