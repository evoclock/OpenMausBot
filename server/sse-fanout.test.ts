import { describe, expect, it } from "vitest";

import { deliverSseFrame, SSE_MAX_BUFFERED_BYTES, type SseFanoutClient } from "./sse-fanout.ts";

type TestClient = SseFanoutClient & { drains: (() => void)[] };

function fakeClient(resOverrides: Partial<SseFanoutClient["res"]> = {}): TestClient {
  const drains: (() => void)[] = [];
  return {
    backpressured: false,
    drains,
    res: {
      writableLength: 0,
      write: () => true,
      end: () => {},
      once: (_event: "drain", listener: () => void) => drains.push(listener),
      ...resOverrides,
    },
  };
}

describe("deliverSseFrame", () => {
  it("sends normally while write() returns true", () => {
    const client = fakeClient();
    expect(deliverSseFrame(client, "message", "frame-a")).toBe("sent");
    expect(client.backpressured).toBe(false);
  });

  it("marks the client backpressured when write() returns false, without dropping that frame", () => {
    const client = fakeClient({ write: () => false });
    expect(deliverSseFrame(client, "message", "frame-a")).toBe("sent");
    expect(client.backpressured).toBe(true);
  });

  it("drops a replaceable screen frame once backpressured, but never drops a durable event", () => {
    const written: string[] = [];
    const client = fakeClient({
      write: (chunk: string) => {
        written.push(chunk);
        return false;
      },
    });

    expect(deliverSseFrame(client, "screen", "screen-1")).toBe("sent");
    expect(client.backpressured).toBe(true);

    expect(deliverSseFrame(client, "screen", "screen-2")).toBe("dropped");

    expect(deliverSseFrame(client, "message", "message-1")).toBe("sent");

    expect(written).toEqual(["screen-1", "message-1"]);
  });

  it("disconnects a client once buffered bytes exceed the bound, even for a durable event", () => {
    let ended = false;
    const client = fakeClient({
      writableLength: SSE_MAX_BUFFERED_BYTES + 1,
      end: () => {
        ended = true;
      },
    });
    expect(deliverSseFrame(client, "message", "message-1")).toBe("disconnected");
    expect(ended).toBe(true);
  });

  it("resumes screen frames once the socket drains", () => {
    // A single screen frame exceeds the 16 KB highWaterMark, so even a healthy client's write() returns false.
    let full = true;
    const client = fakeClient({ write: () => !full });

    expect(deliverSseFrame(client, "screen", "screen-1")).toBe("sent");
    expect(client.backpressured).toBe(true);
    expect(deliverSseFrame(client, "screen", "screen-2")).toBe("dropped");
    expect(client.drains).toHaveLength(1);

    full = false;
    for (const drain of client.drains) drain();

    expect(client.backpressured).toBe(false);
    expect(deliverSseFrame(client, "screen", "screen-3")).toBe("sent");
  });

  it("queues one drain listener per backpressure episode, not per frame", () => {
    const client = fakeClient({ write: () => false });

    deliverSseFrame(client, "message", "message-1");
    deliverSseFrame(client, "message", "message-2");
    deliverSseFrame(client, "message", "message-3");

    expect(client.backpressured).toBe(true);
    expect(client.drains).toHaveLength(1);
  });

  it("treats a throwing write() as a dead connection", () => {
    const client = fakeClient({
      write: () => {
        throw new Error("socket hang up");
      },
    });
    expect(deliverSseFrame(client, "message", "message-1")).toBe("disconnected");
  });
});
