// The "agents" MCP server inside a bot's agent process: stdio JSON-RPC 2.0 (no MCP SDK), every tool
// routed through the harness. Env, set by the harness:
//   OMB_HARNESS_URL  base URL of the harness (http://127.0.0.1:8799)
//   OMB_BOT_ID  the calling bot's id
//   OMB_COMMS_TOKEN  shared secret for the localhost-only internal endpoints
//   OMB_TURN_DEPTH  this turn's comms depth (the harness refuses recursion)
//   OMB_EXTERNAL_RUNTIME  "1" for a standing process: oversized results are cut instead of cached
//   OMB_CHIEF_OF_STAFF  "1" for a Chief of Staff, the only bot shown the Chief-only tools
//   OMB_AGENTS_TOOL_BRIDGE  "1" lists a few tools and puts the rest behind find_tool and use_tool
// scripts/bundle-server.mjs inlines agents-catalog/-call/-client/-bridge into this file, which the harness spawns.
import readline from "node:readline";

import { TOOL_BRIDGE_ENV, createToolBridge } from "./agents-bridge.ts";
import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";
import { callTool, capResult, toolCallContextFromEnv } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

const AVAILABLE_TOOLS = availableTools(catalogProfileFromEnv(process.env));
const BRIDGE = process.env[TOOL_BRIDGE_ENV] === "1" ? createToolBridge(AVAILABLE_TOOLS) : undefined;
const CONTEXT = toolCallContextFromEnv(process.env);

const send = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id: unknown, text: string, isError = false) =>
  ok(id, { content: [{ type: "text", text }], isError });

async function handle(msg: Json) {
  const id = msg.id;
  const method = msg.method as string | undefined;
  if (!method) return;
  const params = (msg.params ?? {}) as Json;
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: (params.protocolVersion as string) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "openmausbot-agents", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: BRIDGE ? BRIDGE.listed : AVAILABLE_TOOLS });
      return;
    case "tools/call": {
      const called = { name: params.name as string, arguments: (params.arguments ?? {}) as Json };
      // Security: past the bridge a use_tool call is a direct call: same unknown-tool check, callTool and result bounds.
      const bridged = BRIDGE ? await BRIDGE.route(called.name, called.arguments) : undefined;
      if (bridged && "answer" in bridged) return textResult(id, bridged.answer.text, bridged.answer.isError);
      const { name, arguments: args } = bridged ?? called;
      if (!AVAILABLE_TOOLS.some((t) => t.name === name)) {
        // A name written into use_tool fails the call, not the protocol: the chat runtime ends a turn on a protocol error.
        const unknown = `Unknown tool: ${name}`;
        return bridged ? textResult(id, unknown, true) : rpcErr(id, -32602, unknown);
      }
      try {
        const { text, isError, passthrough } = await callTool(name, args, CONTEXT);
        if (passthrough) ok(id, passthrough);
        else textResult(id, name === "tool_result_read" ? text : await capResult(text, CONTEXT), isError);
      } catch (e) {
        textResult(id, await capResult((e as Error).message, CONTEXT), true);
      }
      return;
    }
    default:
      if (id !== undefined) rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: Json;
  try {
    msg = JSON.parse(t) as Json;
  } catch {
    return;
  }
  void handle(msg).catch((e) => {
    if (msg.id !== undefined) rpcErr(msg.id, -32603, (e as Error).message);
  });
});
rl.on("close", () => process.exit(0));
