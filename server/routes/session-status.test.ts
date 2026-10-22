import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { requiredScope } from "../request-auth.ts";
import { SessionStatusFeed, type SessionWake } from "../session-status-feed.ts";
import { createSessionStatusRoutes } from "./session-status.ts";
import { dispatchRoutes } from "./table.ts";

const start = 1_000_000;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

function serve(options: { now?: () => number } = {}) {
  const feed = new SessionStatusFeed(":memory:", { now: options.now ?? (() => start) });
  const wakes: SessionWake[][] = [];
  const frames: Record<string, unknown>[] = [];
  const routes = [createSessionStatusRoutes({
    feed,
    wake: (batch) => wakes.push([...batch]),
    broadcast: (payload) => frames.push(payload),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
    try {
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { error: "not this route" });
    } catch (error) {
      json(res, 500, { error: String(error) });
    }
  });
  servers.push(server);
  return new Promise<string>((ready) => {
    server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  }).then((base) => ({ base, feed, wakes, frames }));
}

const push = async (base: string, body: unknown, contentType = "application/json") => {
  const response = await fetch(`${base}/api/session-status/report`, {
    method: "POST", headers: { "content-type": contentType }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
};
const get = async (base: string, path = "/api/session-status") => {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() as any };
};
const ack = async (base: string, ids: unknown) => {
  const response = await fetch(`${base}/api/session-status/wake/ack`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }),
  });
  return { status: response.status, body: await response.json() as any };
};

const report = (over: Record<string, unknown> = {}) => ({
  sessionId: "lease-1", reportId: "lease-1:1", sequence: 1, state: "running",
  progressAt: start, reportedAt: start, ...over,
});

describe("session status feed routes", () => {
  it("is admin-only until listed, so a member cannot push or read it", () => {
    expect(requiredScope("POST", "/api/session-status/report")).toBe("admin");
    expect(requiredScope("GET", "/api/session-status")).toBe("admin");
    expect(requiredScope("POST", "/api/session-status/wake/ack")).toBe("admin");
  });

  it("records a quiet heartbeat without waking anything", async () => {
    const { base, feed, wakes, frames } = await serve();
    const first = await push(base, report());
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ accepted: true, changed: false, changes: [] });
    const beat = await push(base, report({ reportId: "lease-1:2", sequence: 2, progressAt: start + 1, reportedAt: start + 1 }));
    expect(beat.body).toMatchObject({ accepted: true, changed: false });
    expect(wakes).toEqual([]);
    expect(frames).toEqual([]);
    expect(feed.latest()[0]!.sequence).toBe(2);
    feed.close();
  });

  it("wakes once on a change and exposes it to the checkpoint", async () => {
    const { base, feed, wakes, frames } = await serve();
    await push(base, report());
    const changed = await push(base, report({ reportId: "lease-1:2", sequence: 2, needsDecision: true, decision: "merge?" }));
    expect(changed.body).toMatchObject({ accepted: true, changed: true, changes: ["decision"] });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.map((wake) => wake.kind)).toEqual(["decision"]);
    expect(frames).toEqual([{ kind: "session-status", wakes: [{ id: wakes[0]![0]!.id, sessionId: "lease-1", kind: "decision" }] }]);

    const read = await get(base);
    expect(read.status).toBe(200);
    expect(read.body.sessions[0]).toMatchObject({ sessionId: "lease-1", needsDecision: true, changes: ["decision"] });
    expect(read.body.wakes).toHaveLength(1);

    const consumed = await ack(base, read.body.wakes.map((wake: { id: number }) => wake.id));
    expect(consumed.body).toEqual({ acknowledged: 1 });
    expect((await get(base)).body.wakes).toEqual([]);
    expect((await ack(base, [999]))).toEqual({ status: 200, body: { acknowledged: 0 } });
    feed.close();
  });

  it("replays a duplicate push as a no-op and refuses a stale one", async () => {
    const { base, feed, wakes } = await serve();
    await push(base, report());
    const duplicate = await push(base, report({ reportedAt: start + 1 }));
    expect(duplicate.body).toMatchObject({ accepted: true, duplicate: true, changed: false });
    const stale = await push(base, report({ reportId: "lease-1:0", sequence: 0 }));
    expect(stale.body).toMatchObject({ accepted: false, stale: true });
    expect(wakes).toEqual([]);
    feed.close();
  });

  it("refuses a non-JSON push and a malformed report without touching the feed", async () => {
    const { base, feed } = await serve();
    const form = await fetch(`${base}/api/session-status/report`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "sessionId=lease-1",
    });
    expect(form.status).toBe(415);
    const bad = await push(base, report({ sessionId: "../escape" }));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/sessionId/);
    expect(feed.latest()).toEqual([]);
    expect((await ack(base, [])).status).toBe(400);
    feed.close();
  });
});
