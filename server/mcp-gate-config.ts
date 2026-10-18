import { join } from "node:path";
import { parseToolScope, type ToolScope } from "../shared/tool-scope.ts";

import { DATA_DIR } from "./config.ts";
import { unbridgedServer } from "./drivers/agents-bridge.ts";
import { DEFAULT_RESULT_BUDGET } from "./mcp-trim.ts";
import { REMOTE_MCP_CONFIG_ENV, remoteMcpSpec } from "./mcp-http.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

/** `OMB_MCP_RESULT_BUDGET=0` mounts bot servers directly, for a bot that needs whole payloads. */
export function resultBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OMB_MCP_RESULT_BUDGET;
  if (raw === undefined || raw === "") return DEFAULT_RESULT_BUDGET;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_RESULT_BUDGET;
}

/** A bot-owned server's own `resultBudget` (0 = never trim), else the app-wide one. */
export function serverResultBudget(
  name: string,
  perServer: Readonly<Record<string, number>> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const own = perServer && Object.hasOwn(perServer, name) ? perServer[name] : undefined;
  if (typeof own === "number" && Number.isFinite(own) && own >= 0) return Math.floor(own);
  return resultBudget(env);
}

export function hasOwnResultBudget(name: string, perServer: Readonly<Record<string, number>> | undefined): boolean {
  const own = perServer && Object.hasOwn(perServer, name) ? perServer[name] : undefined;
  return typeof own === "number" && Number.isFinite(own) && own >= 1;
}

/** A URL server keeps its native connection (and Claude Code's tool search) unless it has a limit of its own, which must then hold. */
export function customServerGate(
  name: string,
  owned: boolean,
  perServer: Readonly<Record<string, number>> | undefined,
  env?: NodeJS.ProcessEnv,
): { budget: number; gateRemote: boolean } {
  return {
    budget: owned ? serverResultBudget(name, perServer, env) : 0,
    gateRemote: owned && hasOwnResultBudget(name, perServer),
  };
}

export function spillDir(threadId: string): string {
  return join(DATA_DIR, "tool-results", threadId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80) || "thread");
}

export interface StdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

/** Some engines start MCP children with a bare environment (Codex keeps a handful of names), so these travel in the descriptor. */
const NETWORK_ENV = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"];
const PROXY_ENV = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

/** Node's env proxy, unlike curl, does not exempt loopback, and matches an IPv6 host only bracketed ("[::1]"). */
const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];

/** On Node 24, fetch through an env proxy (NODE_USE_ENV_PROXY) hangs on a plain http:// request, ignoring its AbortSignal,
 * so for an http:// server the switch is "0" and the proxy sends the request to HTTP_PROXY itself. */
function networkEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined>, url: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of NETWORK_ENV) if (source[name]) env[name] = source[name];
  if (new URL(url).protocol !== "https:") {
    if (source.NODE_USE_ENV_PROXY || PROXY_ENV.some((name) => env[name])) env.NODE_USE_ENV_PROXY = "0";
  } else if (PROXY_ENV.some((name) => env[name])) {
    env.NODE_USE_ENV_PROXY = source.NODE_USE_ENV_PROXY || "1";
    const bypass = [env.no_proxy, env.NO_PROXY].flatMap((list) => (list ?? "").split(",")).map((entry) => entry.trim()).filter(Boolean);
    const merged = [...new Set([...bypass, ...LOOPBACK])].join(",");
    env.NO_PROXY = merged;
    env.no_proxy = merged;
  }
  return env;
}

export interface StdioServerOptions {
  nodeEnv?: Record<string, string>;
  execPath?: string;
  sourceEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  directory?: { name: string; toolScope?: ToolScope };
  configEnvName?: string;
}

export function mcpStdioServer(server: unknown, options: StdioServerOptions = {}): StdioServer | null {
  if (!server || typeof server !== "object" || Array.isArray(server)) return null;
  const spec = server as StdioServer;
  if (typeof spec.command === "string" && spec.command) return spec;
  const remote = remoteMcpSpec(server);
  if (!remote) return null;
  if (options.configEnvName !== undefined && !REMOTE_MCP_CONFIG_ENV.test(options.configEnvName)) {
    throw new Error("Invalid private MCP proxy configuration.");
  }
  let directory: string | undefined;
  if (options.directory) {
    const scope = parseToolScope(options.directory.toolScope);
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(options.directory.name) || !scope.ok) throw new Error("Invalid MCP tool search configuration.");
    directory = JSON.stringify({ name: options.directory.name, ...(scope.scope ? { toolScope: scope.scope } : {}) });
  }
  const settings = {
    OMB_REMOTE_MCP_SERVER: JSON.stringify(remote),
    ...(directory ? { OMB_REMOTE_MCP_DIRECTORY: directory } : {}),
  };
  return {
    command: options.execPath ?? process.execPath,
    args: [SPAWNED_PROXIES.mcpRemote, ...(options.configEnvName ? ["--config-env", options.configEnvName] : [])],
    env: {
      ...options.nodeEnv,
      ...networkEnv(options.sourceEnv ?? process.env, remote.url),
      ...(options.configEnvName ? { [options.configEnvName]: JSON.stringify(settings) } : settings),
    },
  };
}

/** The upstream spec travels in the gate's env, inside the 0600 MCP config: credentials must never reach argv, where `ps` shows them. */
export function gateServer(input: {
  name: string;
  server: unknown;
  threadId: string;
  budget: number;
  toolScope?: ToolScope;
  nodeEnv?: Record<string, string>;
  execPath?: string;
  configEnvName?: string;
  directory?: boolean;
  sourceEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  gateRemote?: boolean;
}): { command: string; args: string[]; env: Record<string, string> } | null {
  const { name, server, budget } = input;
  const parsed = parseToolScope(input.toolScope);
  if (!parsed.ok) throw new Error(parsed.error);
  const scoped = parsed.scope !== undefined;
  if (budget <= 0 && !scoped) return null;
  if (!scoped && input.gateRemote !== true && remoteMcpSpec(server)) return null;
  const directory = input.directory === true && remoteMcpSpec(server) !== undefined;
  const spec = mcpStdioServer(server, {
    nodeEnv: input.nodeEnv,
    execPath: input.execPath,
    sourceEnv: input.sourceEnv,
    ...(directory ? { directory: { name, ...(scoped ? { toolScope: parsed.scope } : {}) } } : {}),
  });
  if (!spec) {
    if (scoped) throw new Error("Tool selection requires a supported MCP server.");
    return null;
  }
  // Security: a selection matches the name in the call, so behind one the agents server is never bridged,
  // whatever the turn decided earlier.
  const upstream = scoped && name === "agents" ? unbridgedServer(spec) : spec;
  const env = {
    OMB_GATE_NAME: name,
    OMB_GATE_UPSTREAM: JSON.stringify({ command: upstream.command, args: upstream.args ?? [], env: upstream.env ?? {} }),
    OMB_GATE_SPILL_DIR: spillDir(input.threadId),
    OMB_GATE_BUDGET: String(budget),
    ...(scoped ? { OMB_GATE_TOOL_SCOPE: JSON.stringify(parsed.scope) } : {}),
    ...(directory ? { OMB_GATE_DIRECTORY: "1" } : {}),
  };
  if (input.configEnvName && (!scoped || !/^OMB_GATE_CONFIG_[a-f0-9]{64}$/.test(input.configEnvName))) {
    throw new Error("Invalid private MCP gate configuration.");
  }
  return {
    command: input.execPath ?? process.execPath,
    args: [SPAWNED_PROXIES.mcpGate, ...(input.configEnvName ? ["--config-env", input.configEnvName] : [])],
    env: {
      ...input.nodeEnv,
      ...(input.configEnvName ? { [input.configEnvName]: JSON.stringify(env) } : env),
    },
  };
}
