// Never throws into a turn: every failure comes back as { ok: false, reason }. The included relay
// token goes only to the relay's URL, and only with requests the relay accepts.
import type { AppConfig } from "../config.ts";
import { deciderCredential, type ServiceCredential } from "../included-services.ts";
import { jevBackend } from "./jev.ts";
import { appendDeciderLog, stateHash } from "./log.ts";
import { OPENROUTER_DEFAULT_API, OPENROUTER_DEFAULT_BASE_URL, OPENROUTER_DEFAULT_MODEL, openrouterBackend } from "./openrouter.ts";
import { KEY_CHECK_QUESTION, KEY_CHECK_STATE, relayAccepts, relaySeam } from "./relay.ts";
import type {
  Answers, AskOptions, BackendResult, ChoiceAnswer, ChoiceQuestion, DeciderBackend, DeciderFailure, DeciderJob,
  DeciderProvider, DeciderQuestion, DeciderResult, DeciderSeam, OpenRouterApi, ScoreAnswer, YesNoAnswer,
} from "./types.ts";

export { DECIDER_JOBS } from "./types.ts";

export const DEFAULT_DECIDER_TIMEOUT_MS = 1_500;
export const KEY_CHECK_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 30_000;

const offBackend: { id: "off"; decide(): Promise<BackendResult> } = {
  id: "off",
  decide: async () => ({ ok: false, reason: "disabled" }),
};
const BACKENDS: Record<DeciderProvider, DeciderBackend> = { jev: jevBackend, openrouter: openrouterBackend };

type DeciderConfig = NonNullable<AppConfig["decider"]>;

export function deciderProvider(cfg: AppConfig): DeciderProvider | "off" {
  const provider = cfg.decider?.provider ?? "jev";
  return provider in BACKENDS ? (provider as DeciderProvider) : "off";
}

export function deciderModel(cfg: AppConfig): string {
  return cfg.decider?.openrouterModel?.trim() || OPENROUTER_DEFAULT_MODEL;
}

export function deciderApi(cfg: AppConfig): OpenRouterApi {
  if (!cfg.decider?.openrouterModel?.trim()) return OPENROUTER_DEFAULT_API;
  return cfg.decider.openrouterApi === "decisions" ? "decisions" : "chat";
}

/** The OpenRouter key the decider uses: its own, else the one under Settings → API keys. The shared key goes
 * only to OpenRouter's default address: an operator base URL is not given the engine's key. */
export function deciderOpenRouterKey(cfg: AppConfig, draft?: string): { token: string; source: "own" | "shared" } | null {
  const own = draft?.trim() || cfg.decider?.openrouterKey?.trim();
  if (own) return { token: own, source: "own" };
  const shared = sharedOpenRouterKey(cfg);
  return shared ? { token: shared, source: "shared" } : null;
}

function sharedOpenRouterKey(cfg: AppConfig): string | undefined {
  const baseUrl = cfg.decider?.openrouterBaseUrl?.trim();
  if (baseUrl && baseUrl !== OPENROUTER_DEFAULT_BASE_URL) return undefined;
  return cfg.openrouter?.key?.trim() || undefined;
}

/** An own key goes to its provider (or the operator base URL); else Cloud Pro's included token goes to the
 * Admin's relay, Jev only, and only for seams the relay accepts. */
function deciderAccount(
  cfg: AppConfig,
  seam?: DeciderSeam,
  draft?: string,
  provider: DeciderProvider | "off" = deciderProvider(cfg),
): ServiceCredential | null {
  if (provider === "openrouter") {
    const key = deciderOpenRouterKey(cfg, draft);
    return key ? { token: key.token, api: cfg.decider?.openrouterBaseUrl?.trim() || OPENROUTER_DEFAULT_BASE_URL, included: false } : null;
  }
  const account = deciderCredential(draft?.trim() || cfg.decider?.key, cfg.decider?.baseUrl);
  return account?.included && seam && !relaySeam(seam) ? null : account;
}

export function deciderConfigured(cfg: AppConfig): boolean {
  return Boolean(deciderAccount(cfg));
}

export function deciderIncludedHere(): boolean {
  return deciderCredential(undefined, undefined)?.included === true;
}

export function deciderEnabled(cfg: AppConfig): boolean {
  const account = deciderAccount(cfg);
  if (!account || deciderProvider(cfg) === "off") return false;
  return account.included ? cfg.decider?.enabled !== false : cfg.decider?.enabled === true;
}

/** Absent means on. */
export function deciderJobOn(cfg: AppConfig, job: DeciderJob): boolean {
  return cfg.decider?.jobs?.[job] !== false;
}

export function deciderReady(cfg: AppConfig, job: DeciderJob): boolean {
  return deciderEnabled(cfg) && deciderJobOn(cfg, job) && Boolean(deciderAccount(cfg, job));
}

/** Whether Settings → API keys holds an OpenRouter key the decision model may use. */
export function deciderSharedKeyUsable(cfg: AppConfig): boolean {
  return Boolean(sharedOpenRouterKey(cfg));
}

/** Never the key, nor the base URL (an operator setting with no UI). `keySource` and `sharedKey` are OpenRouter's. */
export function describeDecider(cfg: AppConfig) {
  const account = deciderAccount(cfg);
  const provider = deciderProvider(cfg);
  const key = provider === "openrouter" ? deciderOpenRouterKey(cfg) : null;
  return {
    provider: provider === "off" ? "jev" as const : provider,
    ...(provider === "openrouter" ? { model: deciderModel(cfg), api: deciderApi(cfg) } : {}),
    configured: Boolean(account),
    ...(key ? { keySource: key.source } : {}),
    ...(provider === "openrouter" && deciderSharedKeyUsable(cfg) ? { sharedKey: true as const } : {}),
    ...(account?.included ? { included: true as const } : {}),
    enabled: deciderEnabled(cfg),
    jobs: { roomRouting: deciderJobOn(cfg, "roomRouting") },
  };
}

/** A key the provider in use falls back on when the decision model has none of its own. */
export interface DeciderKeyFallback {
  /** Cloud Pro's included Jev decisions. */
  included?: boolean;
  /** The OpenRouter key under Settings → API keys. */
  shared?: boolean;
}

/** Jobs merge per job, because saveConfig replaces a section's nested objects whole. */
export function deciderSavePatch(
  patch: Partial<DeciderConfig>,
  current: DeciderConfig | undefined,
  fallback: DeciderKeyFallback = {},
): { ok: true; patch: Partial<DeciderConfig> } | { ok: false; error: string } {
  const next: Partial<DeciderConfig> = { ...patch };
  const provider = patch.provider ?? current?.provider ?? "jev";
  const field = provider === "openrouter" ? "openrouterKey" : "key";
  const fallbackHere = field === "key" ? fallback.included === true : fallback.shared === true;
  const activeKey = patch[field];
  const savingKey = typeof activeKey === "string" && Boolean(activeKey.trim());
  const clearingKey = typeof activeKey === "string" && !activeKey.trim();
  if (patch.openrouterModel !== undefined && patch.openrouterApi === undefined) next.openrouterApi = "chat";
  if (typeof patch.key === "string") next.key = patch.key.trim();
  if (typeof patch.openrouterKey === "string") next.openrouterKey = patch.openrouterKey.trim();
  if (savingKey) {
    next.enabled = patch.enabled ?? true;
    next.jobs = { ...current?.jobs, roomRouting: true, ...patch.jobs };
  } else if (clearingKey) {
    if (!fallbackHere) next.enabled = false;
  } else if (patch.jobs) {
    next.jobs = { ...current?.jobs, ...patch.jobs };
  }
  if (next.enabled === true && !savingKey && !current?.[field]?.trim() && !fallbackHere) {
    const key = field === "key" ? "a Jev API key" : "an OpenRouter API key";
    return { ok: false, error: `Save ${key} before turning on fast decisions.` };
  }
  return { ok: true, patch: next };
}

export function deciderPatchKey(
  patch: Partial<DeciderConfig>,
  current: DeciderConfig | undefined,
): { provider: DeciderProvider; check: { key: string; provider: DeciderProvider; model?: string; api?: OpenRouterApi } } | null {
  const jevKey = patch.key?.trim();
  const openrouterKey = patch.openrouterKey?.trim();
  const jev = jevKey ? { provider: "jev" as const, check: { key: jevKey, provider: "jev" as const } } : null;
  const savedModel = (patch.openrouterModel ?? current?.openrouterModel)?.trim();
  const api = patch.openrouterModel !== undefined ? patch.openrouterApi : patch.openrouterApi ?? current?.openrouterApi;
  const openrouter = openrouterKey
    ? {
      provider: "openrouter" as const,
      check: {
        key: openrouterKey,
        provider: "openrouter" as const,
        model: savedModel || OPENROUTER_DEFAULT_MODEL,
        api: savedModel ? (api === "decisions" ? "decisions" as const : "chat" as const) : OPENROUTER_DEFAULT_API,
      },
    }
    : null;
  return (patch.provider ?? current?.provider) === "openrouter" ? openrouter ?? jev : jev ?? openrouter;
}

export interface DeciderDeps {
  config(): AppConfig;
  fetch?: typeof fetch;
  dataDir?: string;
  now?: () => number;
}

export interface Decider {
  ask<Qs extends Record<string, DeciderQuestion>>(
    seam: DeciderSeam,
    state: unknown,
    questions: Qs,
    options?: AskOptions,
  ): Promise<DeciderResult<Answers<Qs>>>;
  choose<K extends string>(
    seam: DeciderSeam,
    state: unknown,
    question: { instructions: string; options: Record<K, string> },
    options?: AskOptions,
  ): Promise<DeciderResult<ChoiceAnswer<K>>>;
  score(
    seam: DeciderSeam,
    state: unknown,
    question: { instructions: string; levels: string[] },
    options?: AskOptions,
  ): Promise<DeciderResult<ScoreAnswer>>;
  yesNo(seam: DeciderSeam, state: unknown, instructions: string, options?: AskOptions): Promise<DeciderResult<YesNoAnswer>>;
  /** One tiny yes/no call, whatever the switches say: the Settings Test button and the check on save. */
  testKey(input?: { key?: string; provider?: DeciderProvider; model?: string; api?: OpenRouterApi }, options?: AskOptions): Promise<DeciderResult<YesNoAnswer>>;
}

export function createDecider(deps: DeciderDeps): Decider {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => performance.now());

  function gate(cfg: AppConfig, seam: DeciderSeam): DeciderFailure | null {
    if (deciderProvider(cfg) === "off") return "disabled";
    if (seam === "keyCheck") return null;
    if (!deciderConfigured(cfg)) return cfg.decider?.enabled === true ? "no_key" : "disabled";
    if (!deciderEnabled(cfg)) return "disabled";
    if (!deciderJobOn(cfg, seam)) return "job_off";
    if (!deciderAccount(cfg, seam)) return "no_key";
    return null;
  }

  async function call<Qs extends Record<string, DeciderQuestion>>(
    seam: DeciderSeam,
    backend: DeciderBackend | typeof offBackend,
    request: { key: string; baseUrl?: string; model?: string; state: unknown; questions: Qs },
    options: AskOptions,
  ): Promise<DeciderResult<Answers<Qs>>> {
    const provider = backend.id === "off" ? undefined : backend.id;
    if (options.signal?.aborted) return { ok: false, ...(provider ? { provider } : {}), reason: "cancelled" };
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_DECIDER_TIMEOUT_MS));
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The race, not only the abort, bounds the call: a body that stalls after its headers must not hold a turn.
    const timedOut = new Promise<BackendResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, reason: "timeout" });
      }, timeoutMs);
    });
    const started = now();
    let outcome: BackendResult;
    try {
      const decided = Promise.resolve()
        .then(() => backend.decide({ ...request, signal: controller.signal, fetch: fetchImpl }))
        .catch((): BackendResult => ({ ok: false, reason: "malformed" }));
      outcome = await Promise.race([decided, timedOut]);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
    const latencyMs = Math.max(0, Math.round(now() - started));
    if (!outcome.ok && outcome.reason !== "timeout" && options.signal?.aborted) outcome = { ok: false, reason: "cancelled" };
    if (provider && deps.dataDir) {
      const first = outcome.ok ? Object.values(outcome.answers).find((answer) => answer.type === "choice") as ChoiceAnswer | undefined : undefined;
      appendDeciderLog(deps.dataDir, {
        at: new Date().toISOString(),
        seam,
        provider,
        ...(request.model ? { model: request.model } : {}),
        ok: outcome.ok,
        ...(!outcome.ok ? { reason: outcome.reason, ...(outcome.status ? { status: outcome.status } : {}) } : {}),
        ...(first ? { choice: first.choice } : {}),
        pTop: first?.pTop ?? null,
        margin: first?.margin ?? null,
        latencyMs,
        ...(outcome.ok && outcome.inputTokens !== undefined ? { inputTokens: outcome.inputTokens } : {}),
        stateHash: stateHash(request.state),
      });
    }
    if (!outcome.ok) return { ok: false, ...(provider ? { provider } : {}), reason: outcome.reason, ...(outcome.status ? { status: outcome.status } : {}), latencyMs };
    return {
      ok: true,
      provider: provider!,
      answers: outcome.answers as Answers<Qs>,
      latencyMs,
      ...(outcome.inputTokens !== undefined ? { inputTokens: outcome.inputTokens } : {}),
      ...(outcome.model ? { model: outcome.model } : {}),
    };
  }

  async function ask<Qs extends Record<string, DeciderQuestion>>(
    seam: DeciderSeam,
    state: unknown,
    questions: Qs,
    options: AskOptions = {},
  ): Promise<DeciderResult<Answers<Qs>>> {
    try {
      const cfg = deps.config();
      const refused = gate(cfg, seam);
      if (refused) return { ok: false, reason: refused };
      const provider = deciderProvider(cfg);
      const backend = provider === "off" ? offBackend : BACKENDS[provider];
      const account = deciderAccount(cfg, seam)!;
      // Through the included token, only the exact requests the relay takes.
      if (account.included && !relayAccepts(seam, state, questions)) return { ok: false, reason: "misconfigured" };
      return await call(seam, backend, {
        key: account.token,
        baseUrl: account.api,
        ...(provider === "openrouter" ? { model: deciderModel(cfg), api: deciderApi(cfg) } : {}),
        state,
        questions,
      }, options);
    } catch {
      return { ok: false, reason: "malformed" };
    }
  }

  const single = <A>(result: DeciderResult<{ answer: A }>): DeciderResult<A> =>
    result.ok ? { ...result, answers: result.answers.answer } : result;

  return {
    ask,
    async choose<K extends string>(
      seam: DeciderSeam,
      state: unknown,
      question: { instructions: string; options: Record<K, string> },
      options?: AskOptions,
    ): Promise<DeciderResult<ChoiceAnswer<K>>> {
      const asked: { answer: ChoiceQuestion<K> } = { answer: { type: "choice", instructions: question.instructions, options: question.options } };
      return single(await ask(seam, state, asked, options)) as DeciderResult<ChoiceAnswer<K>>;
    },
    async score(seam, state, question, options) {
      return single(await ask(seam, state, { answer: { type: "score", instructions: question.instructions, levels: question.levels } }, options));
    },
    async yesNo(seam, state, instructions, options) {
      return single(await ask(seam, state, { answer: { type: "yesno", instructions } }, options));
    },
    async testKey(input = {}, options = {}) {
      try {
        const cfg = deps.config();
        const provider = input.provider ?? deciderProvider(cfg);
        const account = deciderAccount(cfg, "keyCheck", input.key, provider);
        if (!account) return { ok: false, reason: "no_key" };
        const backend = provider === "off" ? offBackend : BACKENDS[provider];
        const questions = { answer: { type: "yesno" as const, instructions: KEY_CHECK_QUESTION } };
        if (account.included && !relayAccepts("keyCheck", KEY_CHECK_STATE, questions)) return { ok: false, reason: "misconfigured" };
        return single(await call("keyCheck", backend, {
          key: account.token,
          baseUrl: account.api,
          ...(provider === "openrouter"
            ? input.model?.trim()
              ? { model: input.model.trim(), api: input.api ?? "chat" }
              : { model: deciderModel(cfg), api: deciderApi(cfg) }
            : {}),
          state: KEY_CHECK_STATE,
          questions,
        }, { timeoutMs: KEY_CHECK_TIMEOUT_MS, ...options }));
      } catch {
        return { ok: false, reason: "malformed" };
      }
    },
  };
}
