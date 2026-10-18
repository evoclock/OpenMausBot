import { markAllNotificationLogRead, markNotificationLogRead, recentNotificationLog } from "../message-db.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createNotificationRoutes(deps = {
  recent: recentNotificationLog,
  markRead: markNotificationLogRead,
  markAllRead: markAllNotificationLogRead,
}): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method === "GET" && path === "/api/notifications") {
      return json(res, 200, { notifications: deps.recent() });
    }
    if (method !== "POST") return PASS;
    if (path === "/api/notifications/read-all") {
      deps.markAllRead();
      return json(res, 200, { ok: true });
    }
    const m = path.match(/^\/api\/notifications\/([\w-]+)\/read$/);
    if (!m) return PASS;
    deps.markRead(m[1]!);
    return json(res, 200, { ok: true });
  };
}
