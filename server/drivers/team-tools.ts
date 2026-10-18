/** Shown in the chat when an engine could not start the `agents` MCP server, a bot's only way to reach other bots. */
export const TEAM_TOOLS_FAILED = "This bot's team tools didn't connect, so it couldn't reach other bots this time. They reconnect on your next message.";

/** One MCP server's startup state, as Claude Code's `system/init` lists it in `mcp_servers` and
 * Codex's `mcpServer/startupStatus/updated` sends it: the `agents` server failed. */
export function teamToolsFailed(server: unknown): boolean {
  const record = server && typeof server === "object" ? server as { name?: unknown; status?: unknown } : null;
  return record?.name === "agents" && record.status === "failed";
}
