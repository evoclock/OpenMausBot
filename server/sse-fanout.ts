export interface SseFanoutClient {
  res: {
    write(chunk: string): boolean;
    end(): void;
    writableLength: number;
    once(event: "drain", listener: () => void): unknown;
  };
  backpressured: boolean;
}

/** Past this, cut the client loose; its EventSource reconnects and replays via Last-Event-ID. */
export const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export type SseFanoutOutcome = "sent" | "dropped" | "disconnected";

/** Only screen captures are skipped while backpressured; durable events are always written, or the client is disconnected to replay them. */
export function deliverSseFrame(client: SseFanoutClient, kind: string, frame: string): SseFanoutOutcome {
  if (client.res.writableLength > SSE_MAX_BUFFERED_BYTES) {
    try {
      client.res.end();
    } catch {
    }
    return "disconnected";
  }
  if (client.backpressured && kind === "screen") return "dropped";
  try {
    if (!client.res.write(frame) && !client.backpressured) {
      // write() returns false past the 16 KB highWaterMark, which one screen frame clears: it means "not drained yet", and without the drain listener the flag latches forever.
      client.backpressured = true;
      client.res.once("drain", () => {
        client.backpressured = false;
      });
    }
    return "sent";
  } catch {
    return "disconnected";
  }
}
