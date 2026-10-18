import type { ConnectorScope, ConnectorScopes } from "../../shared/connector-scopes";

interface AccessBot {
  composio?: boolean;
  connectorScopes?: ConnectorScopes;
}

export function botAppScope(bot: AccessBot, slug: string): ConnectorScope | null {
  if (bot.composio === false) return null;
  if (!bot.connectorScopes) return "write";
  return bot.connectorScopes.apps[slug] ?? null;
}

export function withBotApp(
  scopes: ConnectorScopes | undefined,
  connected: readonly string[],
  slug: string,
  on: boolean,
): ConnectorScopes | undefined {
  if (!scopes) {
    if (on) return undefined;
    const apps: Record<string, ConnectorScope> = {};
    for (const other of connected) if (other !== slug) apps[other] = "write";
    return { apps };
  }
  const apps = { ...scopes.apps };
  if (on) {
    if (apps[slug]) return undefined;
    apps[slug] = "write";
  } else {
    if (!apps[slug]) return undefined;
    delete apps[slug];
  }
  return { apps };
}
