import type { RequestAuth } from "../request-auth.ts";
import { loopStatus, openLoopStatusReader } from "../loop-status.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createLoopStatusRoutes(deps: {
  dataDir: string;
  botVisible(auth: RequestAuth, botId: string): boolean;
  controls?: () => { get(id: string): { contract: { botId: string }; state: string } | undefined;
    hold(id: string): string; resumeRun(id: string): string; cancel(id: string): Promise<unknown> } | null;
}): RouteHandler {
  return async ({ path, method, auth, res, json }) => {
    const match = path.match(/^\/api\/bots\/([\w-]+)\/loop-status(?:\/([\w-]+)\/(hold|resume|cancel))?$/);
    if (!match || (match[3] ? method !== "POST" : method !== "GET")) return PASS;
    const botId = match[1];
    if (!deps.botVisible(auth, botId)) return json(res, 404, { error: "no such bot" });
    if (match[3]) {
      if (!auth.scopes.includes("admin")) return json(res, 403, { error: "owner access required" });
      const controls = deps.controls?.();
      const id = match[2]!;
      if (!controls || controls.get(id)?.contract.botId !== botId) return json(res, 404, { error: "no such run" });
      const outcome = match[3] === "hold" ? controls.hold(id)
        : match[3] === "resume" ? controls.resumeRun(id) : await controls.cancel(id);
      return json(res, 200, { outcome, run: controls.get(id) });
    }
    const reader = openLoopStatusReader(deps.dataDir);
    if (!reader) return json(res, 200, { runs: [] });
    try {
      return json(res, 200, { runs: reader.list(botId).map((snapshot) =>
        loopStatus(snapshot, reader.recent(snapshot.contract.id), reader.held(snapshot.contract.id))) });
    } finally { reader.close(); }
  };
}
