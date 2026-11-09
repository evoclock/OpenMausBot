import type { openProductionCodingRuntime } from "../coding-production.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

type CodingRuntime = Awaited<ReturnType<typeof openProductionCodingRuntime>>;

export function createCodingTaskRoutes(deps: {
  coding(): CodingRuntime | null;
  ownerSession(auth: RequestAuth): boolean;
}): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/coding-tasks" || method !== "POST") return PASS;
    if (!deps.ownerSession(auth)) return json(res, 403, { error: "owner admin session required" });
    const coding = deps.coding();
    if (!coding) return json(res, 503, { error: "coding runtime unavailable" });
    const body = await readBody(req, 8192);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).sort().join(",") !== "goal,idempotencyKey,repository" ||
      typeof body.repository !== "string" || typeof body.goal !== "string" ||
      typeof body.idempotencyKey !== "string") return json(res, 400, { error: "invalid owner coding task" });
    try {
      const result = await coding.ownerTask({ repository: body.repository, goal: body.goal,
        idempotencyKey: body.idempotencyKey }, true);
      return json(res, result.status === "accepted" ? 201 : 200, result);
    } catch (error) {
      return json(res, 409, { error: error instanceof Error ? error.message : "coding task refused" });
    }
  };
}
