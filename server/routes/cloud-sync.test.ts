import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createCloudSyncRoutes } from "./cloud-sync.ts";
import { dispatchRoutes } from "./table.ts";

const PC = "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const owner = { kind: "session", session: { id: "s1" }, via: "bearer", scopes: ["admin", "client"] } as unknown as RequestAuth;
const client = { ...owner, scopes: ["client"] } as unknown as RequestAuth;
let auth: RequestAuth, cloudHome: boolean, home: string, server: Server, base: string, routes: ReturnType<typeof createCloudSyncRoutes>;

beforeEach(async () => {
  auth = owner; cloudHome = true;
  home = mkdtempSync(join(tmpdir(), "omb-sync-routes-"));
  mkdirSync(join(home, ".openmausbot"));
  routes = createCloudSyncRoutes({ dataDir: join(home, ".openmausbot"), cloudHome: () => cloudHome, statfs: () => ({ totalBytes: 10 * 1024 ** 3, freeBytes: 9 * 1024 ** 3 }) });
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (!await dispatchRoutes([routes], { req, res, url, path: url.pathname, method: req.method!, auth, json, readBody })) json(res, 404, { error: "not ours" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  routes.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
});
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined || body instanceof Uint8Array ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) });
  const text = await response.text();
  let parsed: any = text; try { parsed = JSON.parse(text); } catch {}
  return { status: response.status, body: parsed, headers: response.headers };
};

it("is not there off a Cloud home, and only the owner's admin session may use it", async () => {
  cloudHome = false;
  expect((await call("GET", "/api/sync")).body).toEqual({ error: "not ours" });
  cloudHome = true; auth = client;
  expect((await call("GET", "/api/sync")).status).toBe(403);
});

it("registers, uploads in parts, lists, serves a range, deletes and restores", async () => {
  const registered = await call("POST", "/api/sync/folders", { computerId: PC, computerName: "Ash-PC", pcPath: "/Users/ash/PA", name: "PA" });
  expect(registered.status).toBe(200);
  const id = registered.body.folder.id as string;
  const begun = await call("POST", `/api/sync/folders/${id}/uploads`, { path: "a.txt", size: 11, sha256: sha("hello world"), baseSha256: null });
  const uploadId = begun.body.uploadId as string;
  expect((await call("PUT", `/api/sync/uploads/${uploadId}?offset=0`, new TextEncoder().encode("hello "))).body).toEqual({ received: 6 });
  expect((await call("PUT", `/api/sync/uploads/${uploadId}?offset=0`, new TextEncoder().encode("hello "))).body).toMatchObject({ received: 6 });
  await call("PUT", `/api/sync/uploads/${uploadId}?offset=6`, new TextEncoder().encode("world"));
  expect((await call("POST", `/api/sync/uploads/${uploadId}/commit`)).body).toEqual({ sha256: sha("hello world") });
  expect((await call("GET", `/api/sync/folders/${id}/files`)).body.files).toMatchObject([{ path: "a.txt", size: 11 }]);
  const ranged = await call("GET", `/api/sync/folders/${id}/file?path=a.txt`, undefined, { range: "bytes=6-" });
  expect(ranged.status).toBe(206);
  expect(ranged.body).toBe("world");
  expect(ranged.headers.get("x-omb-sha256")).toBe(sha("hello world"));
  expect((await call("POST", `/api/sync/folders/${id}/ops`, { ops: [{ op: "delete", path: "a.txt", baseSha256: sha("hello world") }] })).body).toEqual({ results: [{ ok: true }] });
  const [entry] = (await call("GET", "/api/sync/trash")).body.entries;
  expect((await call("POST", "/api/sync/trash/restore", { entryId: entry.id })).body).toEqual({ folderId: id, path: "a.txt" });
  expect((await call("DELETE", `/api/sync/folders/${id}?keepCloudCopy=1`)).status).toBe(204);
  expect((await call("GET", "/api/sync")).body.folders).toEqual([]);
});

it("answers a stale commit with what is there now", async () => {
  const id = (await call("POST", "/api/sync/folders", { computerId: PC, computerName: "PC", pcPath: "/p", name: "P" })).body.folder.id;
  const upload = async (text: string, baseSha256: string | null) => {
    const { uploadId } = (await call("POST", `/api/sync/folders/${id}/uploads`, { path: "a.txt", size: text.length, sha256: sha(text), baseSha256 })).body;
    await call("PUT", `/api/sync/uploads/${uploadId}?offset=0`, new TextEncoder().encode(text));
    return call("POST", `/api/sync/uploads/${uploadId}/commit`);
  };
  await upload("v1", null);
  const stale = await upload("v2", null);
  expect(stale.status).toBe(409);
  expect(stale.body.current).toMatchObject({ sha256: sha("v1") });
});

it("survives a file that cannot be read while it is being served", async () => {
  const folder = (await call("POST", "/api/sync/folders", { computerId: PC, computerName: "PC", pcPath: "/p", name: "P" })).body.folder;
  const { uploadId } = (await call("POST", `/api/sync/folders/${folder.id}/uploads`, { path: "a.txt", size: 5, sha256: sha("hello"), baseSha256: null })).body;
  await call("PUT", `/api/sync/uploads/${uploadId}?offset=0`, new TextEncoder().encode("hello"));
  await call("POST", `/api/sync/uploads/${uploadId}/commit`);
  chmodSync(join(folder.cloudPath, "a.txt"), 0o000);
  try {
    await fetch(`${base}/api/sync/folders/${folder.id}/file?path=a.txt`).then((response) => response.text()).catch(() => "");
    expect((await call("GET", "/api/sync")).status).toBe(200);
  } finally { chmodSync(join(folder.cloudPath, "a.txt"), 0o600); }
});
