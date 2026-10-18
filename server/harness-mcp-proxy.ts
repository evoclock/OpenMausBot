// Only a turn-scoped capability crosses into the agent process; engine commands, session names and provider credentials stay in OMB.
import { pathToFileURL } from "node:url";

import { DATA_INSTRUCTIONS } from "./data/instructions.ts";
import { HIGHLEVEL_INSTRUCTIONS } from "./highlevel/instructions.ts";
import { HARNESS_PROXY_TIMEOUT_MS } from "./harness-budget.ts";
import { harnessMcpTokenEnv } from "./harness-mcp-token.ts";

const MAX_INPUT_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 16_777_216;
const MAX_PENDING = 16;
type RpcId = string | number | null;
export type HarnessMcpKind = "browser" | "computer" | "data" | "highlevel";

const NAMES: Record<HarnessMcpKind, string> = { browser: "Browser", computer: "Cloud computer", data: "Data", highlevel: "HighLevel" };
const INSTRUCTIONS: Partial<Record<HarnessMcpKind, string>> = { data: DATA_INSTRUCTIONS, highlevel: HIGHLEVEL_INSTRUCTIONS };
const RECOVERY: Record<HarnessMcpKind, string> = {
  browser: " This failure does not establish that all browsers are unavailable. Inspect available connections with select_computer if that tool is present. Keep the requested computer and account; do not bypass a permission refusal or human takeover, and do not repeat an uncertain action without checking its result.",
  computer: " Keep working on the assigned cloud computer only; do not bypass a person's control of it, and take a fresh screenshot before repeating an action whose result is uncertain.",
  data: " The tables already loaded are unchanged; check with data_describe or SHOW TABLES before repeating a load, and do not repeat a statement whose result is uncertain.",
  highlevel: " The CRM may or may not have taken the change; read the record back (HIGHLEVEL_GET_CONTACT, HIGHLEVEL_GET_OPPORTUNITY) before repeating a write, and never message anyone through the CRM.",
};

function parseHarnessMcpKind(value: unknown): HarnessMcpKind | null {
  return value === "browser" || value === "computer" || value === "data" || value === "highlevel" ? value : null;
}

/** Node's fetch (undici) rejects with the socket error as its `cause`: refused before anything was sent, reset or closed after. */
function unansweredText(error: unknown, name: string): string {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  const call = `this ${name.toLowerCase()} call`;
  if (code === "ECONNREFUSED") return `OpenMausBot is restarting, so ${call} did not reach it and did not run. Wait a few seconds, then make it again.`;
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return `OpenMausBot restarted while ${call} was running, so it may or may not have taken effect. Check its result before repeating it.`;
  if ((error as { name?: unknown } | null)?.name === "TimeoutError") {
    return `OpenMausBot did not answer ${call} within ${HARNESS_PROXY_TIMEOUT_MS / 1_000} seconds. It may still be running, or it may already have taken effect. Do not repeat it until its result is checked.`;
  }
  return error instanceof Error && !/fetch failed|abort|timeout|terminated/i.test(error.message)
    ? error.message : `${name} connection was interrupted. Do not repeat the action until its state is checked.`;
}

function failure(id: RpcId, method: unknown, message: string, code = -32603): unknown {
  return method === "tools/call"
    ? { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: message }], isError: true } }
    : { jsonrpc: "2.0", id, error: { code, message } };
}

async function boundedJson(response: Response, name: string): Promise<unknown> {
  if (!response.body) throw new Error(`${name} server returned an empty response.`);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OUTPUT_BYTES) throw new Error(`${name} response exceeded the size limit.`);
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function harnessMcpRequest(
  frame: unknown,
  connection: { url: string; token: string; kind: HarnessMcpKind },
): Promise<unknown | undefined> {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return failure(null, null, "Invalid request.", -32600);
  const message = frame as { id?: RpcId; jsonrpc?: unknown; method?: unknown; params?: unknown };
  const id = message.id ?? null;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string" || (id !== null && typeof id !== "number" && typeof id !== "string")) return failure(null, null, "Invalid request.", -32600);
  if (!Object.hasOwn(message, "id")) return undefined;
  const name = NAMES[connection.kind];
  if (message.method === "initialize") return {
    jsonrpc: "2.0", id,
    result: {
      protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: `openmausbot-${connection.kind}`, version: "1" },
      ...(INSTRUCTIONS[connection.kind] ? { instructions: INSTRUCTIONS[connection.kind] } : {}),
    },
  };
  if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (message.method !== "tools/list" && message.method !== "tools/call") return failure(id, message.method, "Method not found.", -32601);
  try {
    const url = new URL(connection.url);
    if (!connection.token || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`${name} connection is not configured. Start a new bot turn from OpenMausBot.`);
    }
    const body = JSON.stringify({ method: message.method, params: message.params ?? {} });
    if (Buffer.byteLength(body) > MAX_INPUT_BYTES) throw new Error(`${name} request exceeded the size limit.`);
    const response = await fetch(new URL(`/api/internal/${connection.kind}/mcp`, url), {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${connection.token}` },
      body, signal: AbortSignal.timeout(HARNESS_PROXY_TIMEOUT_MS),
    });
    const payload = await boundedJson(response, name) as { result?: unknown; error?: unknown };
    if (!response.ok || !payload || typeof payload !== "object" || !Object.hasOwn(payload, "result")) {
      throw new Error(typeof payload?.error === "string" ? payload.error.slice(0, 2_000) : `${name} server is unavailable. Start a new bot turn or try again.`);
    }
    return { jsonrpc: "2.0", id, result: payload.result };
  } catch (error) {
    return failure(id, message.method, unansweredText(error, name) + RECOVERY[connection.kind]);
  }
}

function run(kind: HarnessMcpKind): void {
  const connection = { url: process.env.OMB_HARNESS_URL ?? "", token: process.env[harnessMcpTokenEnv(kind)] ?? "", kind };
  let input = Buffer.alloc(0);
  let pending = 0;
  const output = (message: unknown) => {
    if (message === undefined) return;
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > MAX_OUTPUT_BYTES || process.stdout.writableLength > MAX_OUTPUT_BYTES * 2) {
      process.stdin.destroy();
      process.exitCode = 1;
      return;
    }
    process.stdout.write(line);
  };
  process.stdout.on("error", () => { process.stdin.destroy(); process.exitCode = 1; });
  process.stdin.on("data", (chunk: Buffer) => {
    input = Buffer.concat([input, chunk]);
    let newline: number;
    while ((newline = input.indexOf(10)) !== -1) {
      if (newline > MAX_INPUT_BYTES) { process.stdin.destroy(); process.exitCode = 1; return; }
      const line = input.subarray(0, newline).toString("utf8");
      input = input.subarray(newline + 1);
      if (!line.trim()) continue;
      let frame: unknown;
      try { frame = JSON.parse(line); }
      catch { output(failure(null, null, "Parse error.", -32700)); continue; }
      if (pending >= MAX_PENDING) {
        const request = frame as { id?: RpcId; method?: unknown } | null;
        if (request && Object.hasOwn(request, "id")) output(failure(request.id ?? null, request.method, `Too many pending ${kind} requests.`));
        continue;
      }
      pending++;
      void harnessMcpRequest(frame, connection).then(output).finally(() => { pending--; });
    }
    if (input.length > MAX_INPUT_BYTES) { process.stdin.destroy(); process.exitCode = 1; }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const kind = parseHarnessMcpKind(process.argv[2]);
  if (!kind) {
    process.stderr.write("usage: harness-mcp-proxy browser|computer|data|highlevel\n");
    process.exitCode = 2;
  } else run(kind);
}
