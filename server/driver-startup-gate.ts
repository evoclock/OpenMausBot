// Offline integration seam for a host-owned, scoped bot launcher. The socket
// must be mounted and pinned by the native launcher; this code cannot prove
// who owns an arbitrary path supplied by the bot process.
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";

const REQUEST_SCHEMA = "agentic-driver.bot-startup-check.v1";
const RESPONSE_SCHEMA = "agentic-driver.bot-startup-decision.v1";
const MAX_BYTES = 4096;
const ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

export interface DriverScopedGateConfig {
  readonly enabled: boolean;
  readonly socketPath: string;
  readonly assignmentId: string;
}

/** Snapshot launcher-owned gate settings once. Later process.env changes must
 * neither disable a scoped runtime nor redirect its broker checks. */
export function captureDriverScopedGateConfig(env: NodeJS.ProcessEnv = process.env): DriverScopedGateConfig {
  return Object.freeze({
    enabled: env.OMB_DRIVER_SCOPED_BOOT === "1",
    socketPath: env.OMB_DRIVER_GATE_SOCKET ?? "",
    assignmentId: env.OMB_DRIVER_ASSIGNMENT_ID ?? "",
  });
}

export const DRIVER_SCOPED_GATE_CONFIG = captureDriverScopedGateConfig();

/** Every scoped turn dispatch re-asks the host broker. Ordinary unscoped
 * launches never set the boot marker and are untouched. */
export function createDriverScopedDispatchRefusal(
  config: DriverScopedGateConfig = DRIVER_SCOPED_GATE_CONFIG,
): () => Promise<string | null> {
  const snapshot = Object.freeze({ ...config });
  return async () => {
    if (!snapshot.enabled) return null;
    try {
      await requireDriverStartupGate(snapshot);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "driver startup gate refused dispatch";
    }
  };
}

export const driverScopedDispatchRefusal = createDriverScopedDispatchRefusal();

/** Recheck the scoped lease immediately before a synchronous upkeep write burst. */
export function createDriverScopedWriteGate(
  refusal: () => Promise<string | null> = driverScopedDispatchRefusal,
): () => Promise<void> {
  return async () => {
    const reason = await refusal();
    if (reason) throw new Error(reason);
  };
}

export const driverScopedWriteGate = createDriverScopedWriteGate();

/** Guard provider calls that happen outside the main turn-dispatch seam. */
export async function runDriverScopedModelCall<T>(
  call: () => Promise<T>,
  refusal: () => Promise<string | null> = driverScopedDispatchRefusal,
): Promise<T> {
  const reason = await refusal();
  if (reason) throw new Error(reason);
  return call();
}

export async function requireDriverStartupGate({ socketPath, assignmentId, timeoutMs = 2000 }: {
  socketPath: string; assignmentId: string; timeoutMs?: number;
}): Promise<void> {
  if (typeof socketPath !== "string" || !socketPath.startsWith("/") || socketPath.includes("\0") ||
      !ID.test(assignmentId) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) {
    throw new Error("driver startup gate configuration invalid");
  }
  const nonce = randomBytes(24).toString("hex");
  const decision = await new Promise<unknown>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    let body = "";
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error("driver startup gate timed out")));
    socket.on("error", () => finish(new Error("driver startup gate unavailable")));
    socket.on("connect", () => socket.write(JSON.stringify({ schema: REQUEST_SCHEMA, assignmentId, nonce }) + "\n"));
    socket.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (Buffer.byteLength(body, "utf8") > MAX_BYTES) return finish(new Error("driver startup gate response too large"));
      const end = body.indexOf("\n");
      if (end < 0) return;
      try { finish(undefined, JSON.parse(body.slice(0, end))); }
      catch { finish(new Error("driver startup gate response malformed")); }
    });
    socket.on("end", () => finish(new Error("driver startup gate response incomplete")));
  });
  if (!decision || typeof decision !== "object" || Array.isArray(decision) ||
      (decision as Record<string, unknown>).schema !== RESPONSE_SCHEMA ||
      (decision as Record<string, unknown>).assignmentId !== assignmentId ||
      (decision as Record<string, unknown>).nonce !== nonce ||
      (decision as Record<string, unknown>).dispatch !== true ||
      Object.keys(decision).sort().join(",") !== "assignmentId,dispatch,nonce,schema") {
    throw new Error("driver startup gate refused dispatch");
  }
}
