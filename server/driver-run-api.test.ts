import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import * as durable from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { requireDriverRunApi } from "./driver-run-api.ts";

const require = createRequire(import.meta.url);

test("installed Pi Durable 1.4.0 provides OMB's harness but not the driver-run protocol", () => {
  assert.equal(require("@earendil-works/pi-durable/package.json").version, "1.4.0");
  assert.equal(typeof durable.Harness.open, "function");
  assert.equal(typeof durable.createRegistry, "function");
  assert.equal(typeof durable.defineTask, "function");
  assert.equal(typeof openNodeSqliteStorage, "function");
  assert.equal("openDurableDriver" in durable, false);
  assert.equal("DURABLE_DRIVER_PROTOCOL" in durable, false);
});

test("configured installed driver root is used when package lookup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "omb-driver-"));
  const entry = join(root, "scripts", "enforcement", "durable_driver_pi.js");
  await mkdir(join(root, "scripts", "enforcement"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@evoclock/pi-agentic-driver" }));
  await writeFile(entry, 'export const DURABLE_DRIVER_PROTOCOL = "agentic-driver.run.v1"; export const openDurableDriver = async () => ({});');
  try {
    const api = await requireDriverRunApi("omb-missing-driver-specifier", root);
    assert.equal(typeof api.openDurableDriver, "function");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("driver-run requires a compatible installed protocol and otherwise fails closed", async () => {
  let installed: unknown;
  const moduleName = "@evoclock/pi-agentic-driver/scripts/enforcement/durable_driver_pi.js";
  try { installed = await import(moduleName); }
  catch { installed = null; }
  if (!installed) {
    await assert.rejects(requireDriverRunApi(), /installed driver-run API is unavailable.*agentic-driver\.run\.v1/i);
  } else {
    assert.equal((installed as { DURABLE_DRIVER_PROTOCOL?: string }).DURABLE_DRIVER_PROTOCOL, "agentic-driver.run.v1");
    assert.equal(typeof (await requireDriverRunApi()).openDurableDriver, "function");
  }
});
