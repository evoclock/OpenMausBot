// Host-owned, scoped bot startup gate over the launcher's stdin/stdout pipes.
// The scoped entrypoint reserves stdout for framed broker traffic before it
// imports the server. Ordinary unscoped launches do not touch these streams.
import { TextDecoder } from "node:util";
import type { Readable } from "node:stream";

const REQUEST_SCHEMA = "agentic-driver.bot-stdio-request.v1";
const DECISION_SCHEMA = "agentic-driver.bot-stdio-decision.v1";
const MAX_FRAME_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 2000;
const ASSIGNMENT_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECISION_CODE = /^[a-z0-9-]{1,64}$/;

export interface DriverScopedGateConfig {
  readonly enabled: boolean;
}

export interface DriverStartupGateClientOptions {
  readonly input: Readable;
  readonly writeFrame: (frame: Buffer) => Promise<void>;
  readonly timeoutMs?: number;
}

/** Snapshot the launcher-owned scoped marker once. No guest-supplied identity
 * or endpoint is trusted; the host returns run and assignment IDs per check. */
export function captureDriverScopedGateConfig(env: NodeJS.ProcessEnv = process.env): DriverScopedGateConfig {
  return Object.freeze({ enabled: env.OMB_DRIVER_SCOPED_BOOT === "1" });
}

export const DRIVER_SCOPED_GATE_CONFIG = captureDriverScopedGateConfig();

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) {
    throw new Error("driver startup gate request exceeds the frame limit");
  }
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function decodeDecision(body: Buffer, sequence: number): {
  runId: string;
  assignmentId: string;
  dispatch: boolean;
  code: string;
} {
  let decision: unknown;
  try {
    decision = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new Error("driver startup gate response malformed");
  }
  if (!decision || typeof decision !== "object" || Array.isArray(decision) ||
      Object.getPrototypeOf(decision) !== Object.prototype) {
    throw new Error("driver startup gate response malformed");
  }
  const value = decision as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "assignmentId,code,dispatch,runId,schema,sequence" ||
      value.schema !== DECISION_SCHEMA || value.sequence !== sequence ||
      typeof value.runId !== "string" || !RUN_ID.test(value.runId) ||
      typeof value.assignmentId !== "string" || !ASSIGNMENT_ID.test(value.assignmentId) ||
      typeof value.dispatch !== "boolean" ||
      typeof value.code !== "string" || !DECISION_CODE.test(value.code)) {
    throw new Error("driver startup gate response refused or out of sequence");
  }
  return value as { runId: string; assignmentId: string; dispatch: boolean; code: string };
}

/** Create one serialized, fail-closed client. This stream-injected seam keeps
 * protocol tests isolated from host pipes and from machine/user state. */
export function createDriverStartupGateClient({ input, writeFrame, timeoutMs = DEFAULT_TIMEOUT_MS }: DriverStartupGateClientOptions): () => Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) {
    throw new Error("driver startup gate timeout configuration invalid");
  }

  let buffer = Buffer.alloc(0);
  let nextSequence = 0;
  let runId: string | null = null;
  let assignmentId: string | null = null;
  let terminalError: Error | null = null;
  let pending: {
    readonly sequence: number;
    readonly timer: NodeJS.Timeout;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  } | null = null;
  let queue: Promise<void> = Promise.resolve();

  const fail = (error: Error) => {
    if (terminalError) return;
    terminalError = error;
    const current = pending;
    pending = null;
    if (current) {
      clearTimeout(current.timer);
      current.reject(error);
    }
  };

  const onData = (chunk: Buffer | string) => {
    if (terminalError) return;
    if (!pending || !Buffer.isBuffer(chunk)) {
      fail(new Error("driver startup gate received unexpected transport data"));
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_FRAME_BYTES + 4) {
      fail(new Error("driver startup gate response exceeds the frame limit"));
      return;
    }
    if (buffer.length < 4) return;
    const length = buffer.readUInt32BE(0);
    if (length === 0 || length > MAX_FRAME_BYTES) {
      fail(new Error("driver startup gate response frame length invalid"));
      return;
    }
    if (buffer.length < 4 + length) return;
    if (buffer.length !== 4 + length) {
      fail(new Error("driver startup gate received overlapping responses"));
      return;
    }

    const current = pending;
    let decision: ReturnType<typeof decodeDecision>;
    try {
      decision = decodeDecision(buffer.subarray(4), current.sequence);
    } catch (error) {
      fail(error instanceof Error ? error : new Error("driver startup gate response refused"));
      return;
    }
    buffer = Buffer.alloc(0);
    if ((runId !== null && decision.runId !== runId) ||
        (assignmentId !== null && decision.assignmentId !== assignmentId)) {
      fail(new Error("driver startup gate host identity changed"));
      return;
    }
    runId = decision.runId;
    assignmentId = decision.assignmentId;
    pending = null;
    clearTimeout(current.timer);
    if (!decision.dispatch) {
      const error = new Error(`driver startup gate refused dispatch (${decision.code})`);
      terminalError = error;
      current.reject(error);
      return;
    }
    nextSequence += 1;
    current.resolve();
  };

  input.on("data", onData);
  input.on("error", () => fail(new Error("driver startup gate transport failed")));
  input.on("end", () => fail(new Error("driver startup gate transport closed")));
  input.on("close", () => fail(new Error("driver startup gate transport closed")));

  const check = (): Promise<void> => {
    if (terminalError) return Promise.reject(terminalError);
    if (!Number.isSafeInteger(nextSequence)) {
      fail(new Error("driver startup gate sequence exhausted"));
      return Promise.reject(terminalError!);
    }
    const sequence = nextSequence;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error("driver startup gate timed out")), timeoutMs);
      pending = { sequence, timer, resolve, reject };
      let frame: Buffer;
      try {
        frame = encodeFrame({ schema: REQUEST_SCHEMA, kind: "gate.check", sequence });
      } catch (error) {
        fail(error instanceof Error ? error : new Error("driver startup gate request failed"));
        return;
      }
      void writeFrame(frame).catch(() => fail(new Error("driver startup gate transport failed")));
    });
  };

  return () => {
    const current = queue.then(check);
    queue = current.catch(() => {});
    return current;
  };
}

function reserveStdoutForBroker(): (frame: Buffer) => Promise<void> {
  const stdout = process.stdout;
  const writeControlFrame = stdout.write.bind(stdout);
  stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (typeof chunk === "string") {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      return encoding
        ? process.stderr.write(chunk, encoding, done)
        : process.stderr.write(chunk, done);
    }
    return process.stderr.write(chunk, done);
  }) as typeof process.stdout.write;
  // A closed host pipe is reported by the next write callback and by stdin;
  // keep the stream error observed if it closes between checks.
  stdout.on("error", () => {});

  return (frame) => new Promise<void>((resolve, reject) => {
    try {
      writeControlFrame(frame, (error?: Error | null) => error ? reject(error) : resolve());
    } catch (error) {
      reject(error instanceof Error ? error : new Error("driver startup gate transport failed"));
    }
  });
}

const processGateCheck = DRIVER_SCOPED_GATE_CONFIG.enabled
  ? createDriverStartupGateClient({ input: process.stdin, writeFrame: reserveStdoutForBroker() })
  : null;

/** Recheck the host-owned scoped lease immediately before each protected
 * dispatch or effect. Unscoped launches remain unchanged. */
export async function requireDriverStartupGate(config: DriverScopedGateConfig = DRIVER_SCOPED_GATE_CONFIG): Promise<void> {
  if (!config.enabled) return;
  if (!processGateCheck) throw new Error("driver startup gate is unavailable");
  await processGateCheck();
}

export function createDriverScopedDispatchRefusal(
  config: DriverScopedGateConfig = DRIVER_SCOPED_GATE_CONFIG,
  check: (config: DriverScopedGateConfig) => Promise<void> = requireDriverStartupGate,
): () => Promise<string | null> {
  const snapshot = Object.freeze({ ...config });
  return async () => {
    if (!snapshot.enabled) return null;
    try {
      await check(snapshot);
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
