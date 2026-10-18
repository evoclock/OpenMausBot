import { z } from "zod";

export interface InstallationRow {
  id: string;
  composio_user_id: string;
  session_id: string | null;
  disabled_at: number | null;
  last_seen_at?: number;
}

/** The installation columns the app-event routes read. authenticate() leaves them out, so the
 *  rest of the Worker keeps working on a database that has not run migration 0002 yet. */
export interface EventInstallation {
  id: string;
  composio_user_id: string;
  cloud_machine_id: string | null;
  events_polled_at: number | null;
  poll_lease_id: string | null;
  poll_lease_until: number | null;
  triggers_swept_at: number | null;
}

export const DAY_MS = 86_400_000;
/** Owner decision: app events delivered per UTC day. A Cloud counts once an Admin-signed grant names it. */
export const DESKTOP_DAILY_EVENTS = 500;
export const CLOUD_DAILY_EVENTS = 2_000;
export const QUEUE_MAX_EVENTS = 1_000;
export const QUEUE_MAX_BYTES = 20 * 1024 * 1024;

export const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
export const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// Workers on the free plan get 50 subrequests per request, and the connected
// inventory runs two paginated sweeps back to back: 20 pages each leaves
// headroom for the session lookup.
export const MAX_CONNECTED_ACCOUNT_PAGES = 20;

export function eventLimits(installation: Pick<EventInstallation, "cloud_machine_id">) {
  const cloud = installation.cloud_machine_id !== null;
  return {
    plan: cloud ? "cloud" as const : "desktop" as const,
    eventsPerDay: cloud ? CLOUD_DAILY_EVENTS : DESKTOP_DAILY_EVENTS,
    queuedEvents: QUEUE_MAX_EVENTS,
    queuedBytes: QUEUE_MAX_BYTES,
  };
}

export function utcDay(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function eventInstallation(env: Env, id: string) {
  return env.DB.prepare(
    "SELECT id, composio_user_id, cloud_machine_id, events_polled_at, poll_lease_id, poll_lease_until, triggers_swept_at FROM installations WHERE id = ?",
  ).bind(id).first<EventInstallation>();
}

export function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export function utf8(value: string) {
  return new TextEncoder().encode(value);
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", utf8(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reads a JSON body of at most `limit` bytes; a bad or oversized body is thrown as the 4xx Response. */
export async function readJsonBody(request: Request, limit: number): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? "0") > limit) {
    throw json({ error: "request body is too large" }, 413);
  }
  const raw = await request.text();
  if (utf8(raw).byteLength > limit) throw json({ error: "request body is too large" }, 413);
  try {
    return JSON.parse(raw);
  } catch {
    throw json({ error: "invalid JSON body" }, 400);
  }
}

const upstreamErrorSchema = z.object({
  message: z.string().optional(),
  error: z.union([
    z.string(),
    z.object({ message: z.string().optional(), error: z.string().optional() }),
  ]).optional(),
});

export async function upstreamError(response: Response, fallback: string) {
  const text = await response.text().catch(() => "");
  try {
    const body = upstreamErrorSchema.parse(JSON.parse(text));
    const nested = body.error instanceof Object ? body.error.message ?? body.error.error : body.error;
    return String(body.message ?? nested ?? fallback).slice(0, 240);
  } catch {
    return text.trim().slice(0, 240) || fallback;
  }
}

export function composioRequest(env: Env, path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  headers.set("x-api-key", env.COMPOSIO_API_KEY);
  if (init?.body) headers.set("content-type", "application/json");
  return fetch(`${env.COMPOSIO_API_BASE}${path}`, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
}

const connectedAccountResponseSchema = z.object({
  id: z.string().optional(),
  alias: z.string().nullable().optional(),
  status: z.string().optional(),
  updated_at: z.string().optional(),
  toolkit: z.object({ slug: z.string().optional() }).optional(),
});
export type ConnectedAccountResponse = z.infer<typeof connectedAccountResponseSchema>;
const connectedAccountsPageSchema = z.object({
  items: z.array(connectedAccountResponseSchema),
  next_cursor: z.string().nullable().optional(),
});

export async function listConnectedAccounts(env: Env, userId: string, slugs: string[]) {
  const accounts: ConnectedAccountResponse[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    const params = new URLSearchParams({
      limit: "50",
      user_ids: userId,
      order_by: "updated_at",
      order_direction: "desc",
    });
    if (slugs.length) params.set("toolkit_slugs", slugs.join(","));
    if (cursor) params.set("cursor", cursor);
    const response = await composioRequest(env, `/connected_accounts?${params}`);
    if (!response.ok) throw new Error(await upstreamError(response, `Account lookup failed (${response.status})`));
    const body = connectedAccountsPageSchema.parse(await response.json());
    accounts.push(...body.items);
    const next = body.next_cursor || undefined;
    if (!next || seenCursors.has(next)) return accounts;
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("Connected-account inventory exceeded the pagination safety limit");
}
