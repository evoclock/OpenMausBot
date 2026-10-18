import type { PriceList } from "../prices.ts";
import type { SpendState } from "../spend.ts";
import {
  parseUsageRange,
  readUsage,
  summarizeUsage,
  usageCsv,
  USAGE_GROUPINGS,
  type UsageGroupBy,
} from "../usage-ledger.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface UsageRouteDeps {
  dataDir: string;
  prices(): PriceList | null;
  budget(): SpendState | null;
  currency(): string;
}

export function createUsageRoutes(deps: UsageRouteDeps): RouteHandler {
  return async ({ res, url, path, method, json }) => {
    if (!(method === "GET" && (path === "/api/usage" || path === "/api/usage.csv"))) return PASS;
    const range = parseUsageRange(url.searchParams.get("from"), url.searchParams.get("to"));
    if (!range) return json(res, 400, { error: "from and to must be YYYY-MM-DD, from no later than to, at most a year apart" });
    const rows = readUsage(deps.dataDir, range);
    const prices = deps.prices();
    if (path === "/api/usage.csv") {
      const stamp = (date: Date) => date.toISOString().slice(0, 10);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="usage-${stamp(range.from)}-${stamp(range.to)}.csv"`,
        "cache-control": "no-store",
      });
      res.end(usageCsv(rows, prices));
      return;
    }
    const requested = url.searchParams.get("groupBy") ?? "bot";
    if (!USAGE_GROUPINGS.includes(requested as UsageGroupBy)) {
      return json(res, 400, { error: `groupBy must be one of ${USAGE_GROUPINGS.join(", ")}` });
    }
    const groupBy = requested as UsageGroupBy;
    res.setHeader("cache-control", "no-store");
    return json(res, 200, {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      groupBy,
      ...summarizeUsage(rows, groupBy, prices),
      budget: deps.budget(),
      billing: prices ? { currency: deps.currency() } : null,
    });
  };
}
