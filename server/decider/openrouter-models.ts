import { OPENROUTER_MODEL_ID, OPENROUTER_MODEL_ID_MAX } from "./config.ts";
import { OPENROUTER_DEFAULT_MODEL, openrouterEndpoint } from "./openrouter.ts";

export interface OpenRouterModel {
  id: string;
  name: string;
  group: "recommended" | "more";
  api: "decisions";
}

export interface OpenRouterModelList {
  source: "openrouter" | "builtin";
  models: OpenRouterModel[];
}

export const OPENROUTER_DECIDER_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: OPENROUTER_DEFAULT_MODEL, name: "TypeSafe: Jev 1.13" },
  { id: "perplexity/pplx-decider-v1.1-27b", name: "Perplexity: Decider V1.1 27B" },
  { id: "openai/gpt-6-luna-decisions", name: "OpenAI: GPT-6 Luna Decisions" },
  { id: "nace-ai/drex-v1.5", name: "Nace.AI: Drex v1.5" },
  { id: "microsoft/microsoft-decision-1", name: "Microsoft: Microsoft-Decision-1" },
  { id: "cloudflare/clef-flash", name: "Cloudflare: Clef Flash" },
  { id: "inception/mercury-decide", name: "Inception: Mercury Decide" },
  { id: "cloudflare/clef", name: "Cloudflare: Clef" },
  { id: "nace-ai/drex-v2.0", name: "Nace.AI: Drex v2.0" },
];

const FETCH_TIMEOUT_MS = 3_000;
const OK_TTL_MS = 60 * 60_000;
const FAILED_TTL_MS = 60_000;
const MORE_MAX = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const builtin = (): OpenRouterModelList => ({
  source: "builtin",
  models: OPENROUTER_DECIDER_MODELS.map((model) => ({ ...model, group: "recommended" as const, api: "decisions" as const })),
});

/** Decisions models take no JSON schema (`supported_parameters` is empty), so the only test is that Settings can save the id. */
export function decisionsModels(body: unknown): Map<string, string> | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null;
  const found = new Map<string, string>();
  for (const entry of body.data) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) continue;
    if (entry.id.length > OPENROUTER_MODEL_ID_MAX || !OPENROUTER_MODEL_ID.test(entry.id)) continue;
    const output = isRecord(entry.architecture) ? entry.architecture.output_modalities : undefined;
    if (!Array.isArray(output) || !output.includes("decisions")) continue;
    found.set(entry.id, typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : entry.id);
  }
  return found;
}

export function mergeModels(decisions: Map<string, string>): OpenRouterModelList {
  const recommended = OPENROUTER_DECIDER_MODELS
    .filter((model) => decisions.has(model.id))
    .map((model) => ({ id: model.id, name: decisions.get(model.id)!, group: "recommended" as const, api: "decisions" as const }));
  const curated = new Set(OPENROUTER_DECIDER_MODELS.map((model) => model.id));
  const more = [...decisions]
    .filter(([id]) => !curated.has(id))
    .map(([id, name]) => ({ id, name, group: "more" as const, api: "decisions" as const }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MORE_MAX);
  return recommended.length ? { source: "openrouter", models: [...recommended, ...more] } : builtin();
}

export interface OpenRouterModelCatalogDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

/** Cached an hour after an answer, a minute after a failure. Never throws and never sends a key. */
export function createOpenRouterModelCatalog(deps: OpenRouterModelCatalogDeps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, { until: number; list: OpenRouterModelList }>();

  async function fetchList(endpoint: URL): Promise<OpenRouterModelList | null> {
    try {
      const response = await fetchImpl(endpoint, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const decisions = decisionsModels(await response.json());
      return decisions ? mergeModels(decisions) : null;
    } catch {
      return null;
    }
  }

  return {
    async load(baseUrl?: string | null): Promise<OpenRouterModelList> {
      const endpoint = openrouterEndpoint(baseUrl, "models");
      if (!endpoint) return builtin();
      endpoint.searchParams.set("output_modalities", "decisions");
      const cached = cache.get(endpoint.href);
      if (cached && cached.until > now()) return cached.list;
      const fetched = await fetchList(endpoint);
      const list = fetched?.source === "openrouter" ? fetched : builtin();
      cache.set(endpoint.href, { until: now() + (list.source === "openrouter" ? OK_TTL_MS : FAILED_TTL_MS), list });
      return list;
    },
  };
}

export type OpenRouterModelCatalog = ReturnType<typeof createOpenRouterModelCatalog>;
