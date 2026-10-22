import type { RequestAuth } from "../request-auth.ts";
import { loopStatus, openLoopStatusReader } from "../loop-status.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createLoopStatusRoutes(deps: {
  dataDir: string;
  botVisible(auth: RequestAuth, botId: string): boolean;
}): RouteHandler {
  return async ({ path, method, auth, res, json }) => {
    const match = path.match(/^\/api\/bots\/([\w-]+)\/loop-status$/);
    if (!match || method !== "GET") return PASS;
    const botId = match[1];
    if (!deps.botVisible(auth, botId)) return json(res, 404, { error: "no such bot" });
    const reader = openLoopStatusReader(deps.dataDir);
    if (!reader) return json(res, 200, { runs: [] });
    try {
      return json(res, 200, { runs: reader.list(botId).map((snapshot) =>
        loopStatus(snapshot, reader.recent(snapshot.contract.id))) });
    } finally { reader.close(); }
  };
}
