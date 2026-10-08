import { afterEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  captureDriverScopedGateConfig,
  createDriverScopedDispatchRefusal,
  createDriverScopedWriteGate,
  createDriverStartupGateClient,
  runDriverScopedModelCall,
  type DriverScopedGateConfig,
} from "./driver-startup-gate.ts";

const fixtures: Array<{ input: PassThrough; output: PassThrough }> = [];
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const ASSIGNMENT_ID = "assignment-a";
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.input.destroy();
    fixture.output.destroy();
  }
});

function frame(value: unknown): Buffer {
  return rawFrame(Buffer.from(JSON.stringify(value), "utf8"));
}

function rawFrame(body: Buffer): Buffer {
  const result = Buffer.alloc(4 + body.length);
  result.writeUInt32BE(body.length, 0);
  body.copy(result, 4);
  return result;
}

function fixture(timeoutMs = 2000) {
  const input = new PassThrough();
  const output = new PassThrough();
  fixtures.push({ input, output });
  const requests: Record<string, unknown>[] = [];
  const waiters: Array<(request: Record<string, unknown>) => void> = [];
  let requestBuffer = Buffer.alloc(0);
  output.on("data", (chunk: Buffer) => {
    requestBuffer = Buffer.concat([requestBuffer, chunk]);
    while (requestBuffer.length >= 4) {
      const length = requestBuffer.readUInt32BE(0);
      if (requestBuffer.length < 4 + length) return;
      const request = JSON.parse(requestBuffer.subarray(4, 4 + length).toString("utf8"));
      requestBuffer = requestBuffer.subarray(4 + length);
      const waiter = waiters.shift();
      if (waiter) waiter(request);
      else requests.push(request);
    }
  });
  const nextRequest = () => {
    const queued = requests.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Record<string, unknown>>((resolve) => waiters.push(resolve));
  };
  const check = createDriverStartupGateClient({
    input,
    timeoutMs,
    writeFrame: (bytes) => new Promise<void>((resolve, reject) => {
      output.write(bytes, (error) => error ? reject(error) : resolve());
    }),
  });
  return {
    check,
    nextRequest,
    respond(value: unknown) { input.write(frame(value)); },
    respondRaw(body: Buffer) { input.write(rawFrame(body)); },
    respondBytes(bytes: Buffer) { input.write(bytes); },
    respondLength(length: number) {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(length, 0);
      input.write(header);
    },
    close() { input.end(); },
  };
}

function decision(request: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    schema: "agentic-driver.bot-stdio-decision.v1",
    sequence: request.sequence,
    runId: RUN_ID,
    assignmentId: ASSIGNMENT_ID,
    dispatch: true,
    code: "admitted",
    ...overrides,
  };
}

async function allowNext(broker: ReturnType<typeof fixture>) {
  const request = await broker.nextRequest();
  broker.respond(decision(request));
  return request;
}

describe("driver startup stdio protocol", () => {
  it("sends only the exact sequential gate request and accepts host-provided identity", async () => {
    const broker = fixture();
    const check = broker.check();
    const request = await broker.nextRequest();

    expect(request).toEqual({
      schema: "agentic-driver.bot-stdio-request.v1",
      kind: "gate.check",
      sequence: 0,
    });
    expect(Object.keys(request).sort()).toEqual(["kind", "schema", "sequence"]);
    broker.respond(decision(request));
    await expect(check).resolves.toBeUndefined();
  });

  it("serializes concurrent checks and advances sequence only after admission", async () => {
    const broker = fixture();
    const first = broker.check();
    const second = broker.check();
    const request0 = await broker.nextRequest();
    expect(request0.sequence).toBe(0);
    broker.respond(decision(request0));
    await expect(first).resolves.toBeUndefined();

    const request1 = await broker.nextRequest();
    expect(request1.sequence).toBe(1);
    broker.respond(decision(request1));
    await expect(second).resolves.toBeUndefined();
  });

  it.each([
    ["malformed JSON", Buffer.from("{")],
    ["invalid UTF-8", Buffer.from([0xff])],
  ])("fails closed on %s", async (_label, body) => {
    const broker = fixture();
    const check = broker.check();
    await broker.nextRequest();
    broker.respondRaw(body);
    await expect(check).rejects.toThrow(/malformed/);
  });

  it.each([
    ["wrong schema", { schema: "wrong" }],
    ["wrong sequence", { sequence: 1 }],
    ["invalid run ID", { runId: "run-a" }],
    ["invalid assignment ID", { assignmentId: "../other" }],
    ["non-boolean decision", { dispatch: "true" }],
    ["invalid decision code", { code: "not allowed" }],
    ["unexpected field", { extra: true }],
  ])("refuses %s", async (_label, override) => {
    const broker = fixture();
    const check = broker.check();
    const request = await broker.nextRequest();
    broker.respond(decision(request, override));
    await expect(check).rejects.toThrow(/refused|malformed/);
  });

  it.each([0, 4097])("refuses invalid frame length %i", async (length) => {
    const broker = fixture();
    const check = broker.check();
    await broker.nextRequest();
    broker.respondLength(length);
    await expect(check).rejects.toThrow(/frame length/);
  });

  it("refuses a response with trailing bytes", async () => {
    const broker = fixture();
    const check = broker.check();
    const request = await broker.nextRequest();
    const bytes = frame(decision(request));
    broker.respondBytes(Buffer.concat([bytes, bytes]));
    await expect(check).rejects.toThrow(/overlapping/);
  });

  it("refuses a host identity change between checks", async () => {
    const broker = fixture();
    const first = broker.check();
    const request0 = await broker.nextRequest();
    broker.respond(decision(request0));
    await expect(first).resolves.toBeUndefined();

    const second = broker.check();
    const request1 = await broker.nextRequest();
    broker.respond(decision(request1, { assignmentId: "assignment-b" }));
    await expect(second).rejects.toThrow(/identity changed/);
  });

  it("refuses a held assignment and permanently fails closed", async () => {
    const broker = fixture();
    const check = broker.check();
    const request = await broker.nextRequest();
    broker.respond(decision(request, { dispatch: false, code: "gate-refused" }));
    await expect(check).rejects.toThrow(/refused dispatch/);
    await expect(broker.check()).rejects.toThrow(/refused dispatch/);
  });

  it("fails closed on timeout, input closure, and transport write failure", async () => {
    const timed = fixture(20);
    const timedCheck = timed.check();
    await timed.nextRequest();
    await expect(timedCheck).rejects.toThrow(/timed out/);

    const closed = fixture();
    const closedCheck = closed.check();
    await closed.nextRequest();
    closed.close();
    await expect(closedCheck).rejects.toThrow(/closed/);

    const input = new PassThrough();
    fixtures.push({ input, output: new PassThrough() });
    const broken = createDriverStartupGateClient({
      input,
      writeFrame: async () => { throw new Error("fixture write failure"); },
    });
    await expect(broken()).rejects.toThrow(/transport failed/);
  });

  it("rejects invalid timeout configuration", () => {
    expect(() => createDriverStartupGateClient({
      input: new PassThrough(), writeFrame: async () => {}, timeoutMs: 5001,
    })).toThrow(/timeout configuration/);
  });
});

describe("driver-scoped recurring checks", () => {
  const scoped: DriverScopedGateConfig = { enabled: true };

  it("snapshots only the scoped marker and leaves ordinary launches untouched", async () => {
    const env: NodeJS.ProcessEnv = {
      OMB_DRIVER_SCOPED_BOOT: "1",
      OMB_DRIVER_ASSIGNMENT_ID: "ignored-guest-value",
      OMB_DRIVER_GATE_SOCKET: "/ignored/endpoint",
    };
    const config = captureDriverScopedGateConfig(env);
    env.OMB_DRIVER_SCOPED_BOOT = "0";
    expect(config).toEqual({ enabled: true });

    const ordinary = captureDriverScopedGateConfig({});
    let checks = 0;
    const refusal = createDriverScopedDispatchRefusal(ordinary, async () => {
      checks += 1;
      throw new Error("must not check an ordinary launch");
    });
    await expect(runDriverScopedModelCall(async () => "ordinary", refusal)).resolves.toBe("ordinary");
    expect(checks).toBe(0);
  });

  it("fails closed before a scoped write when the host holds after an allowed model call", async () => {
    let held = false;
    const broker = fixture();
    const refusal = createDriverScopedDispatchRefusal(scoped, () => broker.check());
    const beforeWrite = createDriverScopedWriteGate(refusal);
    let modelCalls = 0;
    let writes = 0;

    const model = runDriverScopedModelCall(async () => {
      modelCalls += 1;
      return "facts";
    }, refusal);
    await allowNext(broker);
    await expect(model).resolves.toBe("facts");
    held = true;

    const persist = async () => {
      await beforeWrite();
      writes += 1;
    };
    const pendingWrite = persist();
    const request = await broker.nextRequest();
    broker.respond(decision(request, { dispatch: held ? false : true, code: "gate-refused" }));
    await expect(pendingWrite).rejects.toThrow(/refused dispatch/);
    expect(modelCalls).toBe(1);
    expect(writes).toBe(0);
  });

  it("does not start title or upkeep provider calls after a scoped hold", async () => {
    const broker = fixture();
    const refusal = createDriverScopedDispatchRefusal(scoped, () => broker.check());
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

    const title = titleGenerateText();
    const request = await broker.nextRequest();
    broker.respond(decision(request, { dispatch: false, code: "gate-refused" }));
    await expect(title).rejects.toThrow(/refused dispatch/);
    await expect(upkeepGenerateText()).rejects.toThrow(/refused dispatch/);
    expect(titleCalls).toBe(0);
    expect(upkeepCalls).toBe(0);
  });
});
