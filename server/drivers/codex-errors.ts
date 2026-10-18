import { cloudHomeConfigured } from "../cloud-home.ts";
import { hostTimeZone } from "../turn-clock.ts";
import { USAGE_LIMIT } from "./retry.ts";
import { CODEX_USAGE_LIMIT_REACHED } from "../../shared/codex-usage-limit.ts";

/** How a Codex turn reaches OpenAI: OpenMausBot's ChatGPT plan, Codex's own sign-in, or any other provider. */
export type CodexRoute = "plan" | "own" | "other";

// codex-cli 0.160.1 holding no login sends no Authorization header and gets this 401.
export const CODEX_MISSING_CREDENTIALS = /missing bearer or basic authentication/i;

export function codexNotSignedIn(): string {
  return `Codex isn't signed in on this computer.${cloudHomeConfigured() ? " Sign-ins don't copy over when you move to My Cloud." : ""} Sign in to Codex in Settings → Model providers → Codex.`;
}

/** Codex's own words name ChatGPT's plans ("Upgrade to Pro"), which read as MausBot's. codex-cli 0.160.1 ends them
 * with "Try again at 5:23 PM." or "…or try again at Oct 17th, 2026 5:23 PM.", in its local time. */
export function codexLimitMessage(said: string, timeZone = hostTimeZone()): string {
  const resets = /\btry again at ([^.]+)/i.exec(said)?.[1]?.trim();
  return `${CODEX_USAGE_LIMIT_REACHED} This is OpenAI's limit, not your MausBot plan. ${resets
    ? `It resets at ${resets} (${timeZone}). Until then, manage your Codex usage in ChatGPT or switch this bot to another engine.`
    : "Manage your Codex usage in ChatGPT, or switch this bot to another engine until it resets."}`;
}

export function codexUserError(value: string, route: CodexRoute, codexErrorInfo?: unknown): string {
  if (route === "plan" && value.includes("subscription_sharing_usage_limit_exceeded")) {
    return "subscription_sharing_usage_limit_exceeded: Your ChatGPT plan usage limit was reached. Manage usage in ChatGPT Settings, or explicitly choose another provider.";
  }
  if (route === "own" && (codexErrorInfo === "usageLimitExceeded" || USAGE_LIMIT.test(value))) return codexLimitMessage(value);
  if (route === "own" && CODEX_MISSING_CREDENTIALS.test(value)) return codexNotSignedIn();
  if (value.includes("provider_not_configured")) {
    return route === "plan"
      ? "provider_not_configured: ChatGPT has not enabled this model for the selected account. Refresh models or reconnect ChatGPT plan in Settings. API billing will not be used."
      : "provider_not_configured: This Codex account cannot use the selected route. For the new ChatGPT plan models, choose ChatGPT plan in Settings → Engines and Continue with ChatGPT, then select a model from that account.";
  }
  return value.slice(0, 400);
}

// Codex's own words when OpenAI refuses its stored ChatGPT login (codex-cli 0.160 login/src/auth).
const CODEX_SIGN_IN_REFUSED = /workspace routing discovery unauthorized|access token could not be refreshed|authentication session could not be refreshed|ChatGPT login is required|auth data is not available|please (?:log out and )?sign in again/i;

/** A turn error saying Codex's own sign-in was refused (`unauthorized`, a model-backend 401, or its
 * sign-in words). A 401 from an MCP server or tool reaches the model as a tool result, never here. */
export function codexSignInRefused(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { message, codexErrorInfo: info } = error as { message?: unknown; codexErrorInfo?: unknown };
  if (info === "unauthorized") return true;
  if (info && typeof info === "object" &&
    Object.values(info).some((variant) => (variant as { httpStatusCode?: unknown } | null)?.httpStatusCode === 401)) return true;
  return typeof message === "string" && CODEX_SIGN_IN_REFUSED.test(message);
}

export const CODEX_SIGN_IN_EXPIRED = "Codex's ChatGPT sign-in has expired. Sign in again in Settings → Model providers → Codex.";

export function codexSignInExpired(raw: string): string {
  return `${CODEX_SIGN_IN_EXPIRED} Codex said: ${raw.slice(0, 300)}`;
}
