import { ZodError } from "zod";

import type { SessionStatusFeed, SessionWake } from "../session-status-feed.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface SessionStatusRouteDeps {
  feed: SessionStatusFeed;
  /** Called once per push that produced new changes. Reuses the scheduler; the route itself starts nothing. */
  wake?: (wakes: readonly SessionWake[]) => void;
  broadcast?: (payload: Record<string, unknown>) => void;
}

function messageOf(error: ZodError): string {
  return error.issues[0]?.message ?? "invalid session status report";
}

function idsFrom(body: unknown): number[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const raw = (body as { ids?: unknown }).ids;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0).slice(0, 200);
}

export function createSessionStatusRoutes(deps: SessionStatusRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, json, readBody }) => {
    if (path === "/api/session-status/report" && method === "POST") {
      const mediaType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      if (mediaType !== "application/json") return json(res, 415, { error: "content-type must be application/json" });
      let outcome;
      try {
        outcome = deps.feed.record(await readBody(req));
      } catch (error) {
        if (error instanceof ZodError) return json(res, 400, { error: messageOf(error) });
        throw error;
      }
      if (outcome.wakes.length > 0) {
        deps.wake?.(outcome.wakes);
        deps.broadcast?.({ kind: "session-status", wakes: outcome.wakes.map((wake) => ({ id: wake.id, sessionId: wake.sessionId, kind: wake.kind })) });
      }
      return json(res, 200, {
        accepted: outcome.accepted, duplicate: outcome.duplicate, stale: outcome.stale,
        changed: outcome.changed, changes: outcome.changes,
      });
    }
    if (path === "/api/session-status" && method === "GET") {
      const limit = Number(url.searchParams.get("limit"));
      return json(res, 200, {
        sessions: deps.feed.latest(Number.isSafeInteger(limit) && limit > 0 ? limit : undefined),
        wakes: deps.feed.pendingWakes(),
      });
    }
    if (path === "/api/session-status/wake/ack" && method === "POST") {
      const ids = idsFrom(await readBody(req));
      if (ids.length === 0) return json(res, 400, { error: "ids must list at least one pending wake" });
      return json(res, 200, { acknowledged: deps.feed.acknowledge(ids) });
    }
    return PASS;
  };
}
