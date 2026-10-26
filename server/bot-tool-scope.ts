import { parseToolScope } from "../shared/tool-scope.ts";
import type { Store } from "./store.ts";

export function botToolScopeForTurn(store: Pick<Store, "bot">, botId: string) {
  const bot = store.bot(botId);
  if (!bot) throw Object.assign(new Error("no such bot"), { status: 404 });
  const parsed = parseToolScope(bot.toolScope);
  if (!parsed.ok) throw Object.assign(new Error("This bot's tool selection is invalid. Open Access settings and save a valid selection before starting a turn."), { status: 409, code: "tool_scope" });
  return parsed.scope;
}
