// The answer is a verdict (and how long it took), never the key and never the vendor's raw body.
import type { AppConfig } from "../config.ts";
import { OPENROUTER_MODEL_ID_MAX } from "../decider/config.ts";
import type { Decider } from "../decider/index.ts";
import { createOpenRouterModelCatalog, type OpenRouterModelCatalog } from "../decider/openrouter-models.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface DeciderRouteDeps {
  decider: Pick<Decider, "testKey">;
  models?: Pick<OpenRouterModelCatalog, "load">;
  config(): AppConfig;
}

const MAX_KEY_LENGTH = 512;

export function createDeciderRoutes(deps: DeciderRouteDeps): RouteHandler {
  const models = deps.models ?? createOpenRouterModelCatalog();
  return async ({ req, res, path, method, json, readBody }) => {
    if (path === "/api/decider/models" && method === "GET") {
      res.setHeader("cache-control", "no-store");
      return json(res, 200, await models.load(deps.config().decider?.openrouterBaseUrl));
    }
    if (path !== "/api/decider/test" || method !== "POST") return PASS;
    const body = await readBody(req, 8192);
    if (body?.key !== undefined && typeof body.key !== "string") return json(res, 400, { error: "key must be a string" });
    const draft = typeof body?.key === "string" ? body.key.trim() : "";
    if (draft.length > MAX_KEY_LENGTH) return json(res, 400, { error: "That does not look like an API key." });
    res.setHeader("cache-control", "no-store");
    const provider = body?.provider === "jev" || body?.provider === "openrouter" ? body.provider : undefined;
    if (body?.model !== undefined && (typeof body.model !== "string" || body.model.length > OPENROUTER_MODEL_ID_MAX)) {
      return json(res, 400, { error: "model must be an OpenRouter model id" });
    }
    const model = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    const api = body?.api === "decisions" || body?.api === "chat" ? body.api : undefined;
    const result = await deps.decider.testKey({
      ...(draft ? { key: draft } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(api ? { api } : {}),
    });
    if (result.ok) return json(res, 200, { ok: true, latencyMs: result.latencyMs });
    return json(res, 200, { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) });
  };
}
