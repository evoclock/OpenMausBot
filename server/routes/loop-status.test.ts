import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { json, readBody } from "../harness/http.ts";
import { RunContractStore } from "../run-contract.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createLoopStatusRoutes } from "./loop-status.ts";
import { dispatchRoutes } from "./table.ts";

const scratch = join(process.cwd(), ".omb-scratch", "proof", "loop-status");
mkdirSync(scratch, { recursive: true });

it("serves only the visible bot's durable run over HTTP, without write methods", async () => {
  const dir = mkdtempSync(join(scratch, "route-"));
  mkdirSync(join(dir, "coding-run"));
  const store = new RunContractStore(join(dir, "coding-run", "runtime.db"));
  store.create({ id: "7898b674-9669-43c1-84d5-f0955fd4e1cd", botId: "visible",
    repository: "repo", ref: "main", repositoryClass: "agent-private", successCriteria: ["pass"],
    allowedEffects: [] }, 100);
  const route = createLoopStatusRoutes({ dataDir: dir, botVisible: (_auth, id) => id === "visible" });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes([route], { req, res, url, path: url.pathname,
      method: req.method ?? "GET", auth: { kind: "loopback" } as RequestAuth, json, readBody });
    if (!handled) json(res, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const visible = await fetch(`${base}/api/bots/visible/loop-status`);
    expect(visible.status).toBe(200);
    expect((await visible.json() as { runs: Array<{ state: string }> }).runs).toMatchObject([{ state: "queued" }]);
    expect((await fetch(`${base}/api/bots/hidden/loop-status`)).status).toBe(404);
    expect((await fetch(`${base}/api/bots/visible/loop-status`, { method: "POST" })).status).toBe(404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
