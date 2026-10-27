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

test("Pi and agent npm roots resolve the installed driver without a package dependency", async () => {
  // Why: a globally installed driver must remain reachable when OMB cannot resolve its package name.
  for (const scope of [".pi/pi", ".pi/agent"]) {
    const home = await mkdtemp(join(process.cwd(), ".omb-driver-home-"));
    const root = join(home, scope, "npm", "node_modules", "@evoclock", "pi-agentic-driver");
    const entry = join(root, "scripts", "enforcement", "durable_driver_pi.js");
    try {
      await mkdir(join(root, "scripts", "enforcement"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "@evoclock/pi-agentic-driver", type: "module" }));
      await writeFile(entry, 'export const DURABLE_DRIVER_PROTOCOL = "agentic-driver.run.v1"; export const openDurableDriver = async () => ({});');
      const api = await requireDriverRunApi("omb-missing-driver-specifier", undefined, home);
      assert.equal(typeof api.openDurableDriver, "function");
    } finally { await rm(home, { recursive: true, force: true }); }
  }
});

test("npm root without a compatible protocol fails closed", async () => {
  // Why: discovering a package by path must not bypass the protocol check.
  const home = await mkdtemp(join(process.cwd(), ".omb-driver-home-"));
  const root = join(home, ".pi", "pi", "npm", "node_modules", "@evoclock", "pi-agentic-driver");
  try {
    await mkdir(join(root, "scripts", "enforcement"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@evoclock/pi-agentic-driver", type: "module" }));
    await writeFile(join(root, "scripts", "enforcement", "durable_driver_pi.js"), 'export const openDurableDriver = async () => ({});');
    await assert.rejects(requireDriverRunApi("omb-missing-driver-specifier", undefined, home), /installed driver-run API is unavailable.*agentic-driver\.run\.v1/i);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("driver-run rejects when neither package nor installed root is available", async () => {
  // Why: missing installations must not silently create an undurable worker.
  const home = await mkdtemp(join(process.cwd(), ".omb-driver-home-"));
  try {
    await assert.rejects(requireDriverRunApi("omb-missing-driver-specifier", undefined, home), /installed driver-run API is unavailable.*agentic-driver\.run\.v1/i);
  } finally { await rm(home, { recursive: true, force: true }); }
});
