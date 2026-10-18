import { hostTimeZone } from "../turn-clock.ts";
import { engineFailureMessage, type EngineFailureKind } from "./engine-errors.ts";
import { USAGE_LIMIT } from "./retry.ts";

export interface ClaudeLimit {
  /** the CLI's rateLimitType: five_hour, seven_day, seven_day_opus, seven_day_sonnet,
   * seven_day_overage_included or overage (2.1.295) */
  window: string | null;
  /** epoch seconds */
  resetsAt: number | null;
}

/** The window refusing this account per the CLI's `rate_limit_info` ("allowed", "allowed_warning",
 * "rejected"; on `rate_limit_event` since 2.1.272 and on the refused call's `api_error_params` since
 * 2.1.295), or null. A rejected window with extra usage in use still runs the turn on credits. */
export function claudeLimitRefusal(info: unknown): ClaudeLimit | null {
  if (!info || typeof info !== "object") return null;
  const { status, rateLimitType, resetsAt, isUsingOverage } = info as Record<string, unknown>;
  if (status !== "rejected" || isUsingOverage === true) return null;
  return {
    window: typeof rateLimitType === "string" ? rateLimitType : null,
    resetsAt: typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null,
  };
}

/** The CLI's api-error frame for a usage-limit refusal: `api_error: "usage_limit_reached"` (2.1.295),
 * the words ("You've hit your weekly limit · resets …"), or an earlier refusing `rate_limit_event`.
 * It outranks whatever else the frame says: 2.1.272 answered a limited account with "does not
 * support this model". */
export function claudeUsageLimit(
  frame: { error?: unknown; is_api_error_message?: unknown; api_error?: unknown },
  text: string,
  refused = false,
): boolean {
  if (frame.is_api_error_message !== true && typeof frame.error !== "string") return false;
  return refused || frame.api_error === "usage_limit_reached" || USAGE_LIMIT.test(text);
}

const CLAUDE_LIMIT_NAMES: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "weekly limit",
  seven_day_opus: "weekly Opus limit",
  seven_day_sonnet: "weekly Sonnet limit",
};

export function claudeLimitMessage(limit: ClaudeLimit | null, said?: string, now = Date.now(), timeZone = hostTimeZone()): string {
  const name = limit?.window && Object.hasOwn(CLAUDE_LIMIT_NAMES, limit.window) ? CLAUDE_LIMIT_NAMES[limit.window] : "usage limit";
  const meanwhile = /^seven_day_(?:opus|sonnet)$/.test(limit?.window ?? "") ? "choose another model for this bot" : "switch this bot to another engine or Claude account";
  if (limit?.resetsAt && limit.resetsAt * 1000 > now) {
    let resets: string;
    try {
      resets = `${new Date(limit.resetsAt * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone })} (${timeZone})`;
    } catch {
      resets = `${new Date(limit.resetsAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    }
    return `This Claude account has reached its ${name}, which resets ${resets}. Until then, ${meanwhile}.`;
  }
  const words = said?.trim().replace(/[.\s]+$/, "");
  return `This Claude account has reached its ${name}${words ? ` (Claude says: "${words}")` : ""}. For now, ${meanwhile}.`;
}

/** Claude Code 2.1.295's api-error kinds (the assistant frame's `error`) that say the cause outright. */
const CLAUDE_ERROR_KINDS: Record<string, EngineFailureKind> = {
  billing_error: "credits",
  overloaded: "overloaded",
  server_error: "server",
  rate_limit: "rate_limit",
};

/** An api-error frame or error result in plain words. Claude Code sends the frame as a synthetic message whose
 * stop_reason is "stop_sequence", with `error` (billing_error, overloaded, server_error, rate_limit, invalid_request,
 * model_not_found, unknown…) and its text ("API Error: 529 …", "Credit balance is too low"); the result repeats the
 * text with `api_error_status`. Each is one plain row, never a reply: a kind or status OMB words is named, anything
 * else keeps Claude's own words. */
export function claudeApiErrorMessage(frame: { error?: unknown; api_error_status?: unknown }, text: string): string {
  const said = text.trim();
  const kind = typeof frame.error === "string" && Object.hasOwn(CLAUDE_ERROR_KINDS, frame.error) ? CLAUDE_ERROR_KINDS[frame.error] : null;
  const status = typeof frame.api_error_status === "number" ? frame.api_error_status : undefined;
  return engineFailureMessage("Claude", said, { kind, status }) ?? said;
}
