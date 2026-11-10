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

test("a configured driver below the minimum version is refused without fallback", async () => {
  const root = await mkdtemp(join(process.cwd(), "node_modules", ".cache", "omb-driver-version-"));
  try {
    await mkdir(join(root, "scripts", "enforcement"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@evoclock/pi-agentic-driver", version: "3.0.2", type: "module" }));
    await writeFile(join(root, "scripts", "enforcement", "durable_driver_pi.js"),
      'export const DURABLE_DRIVER_PROTOCOL = "agentic-driver.run.v1"; export const openDurableDriver = async () => ({});');
    await assert.rejects(requireDriverRunApi("omb-missing-driver-specifier", root), /3\.1\.7/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("configured installed driver root is used when package lookup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "omb-driver-"));
  const entry = join(root, "scripts", "enforcement", "durable_driver_pi.js");
  await mkdir(join(root, "scripts", "enforcement"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@evoclock/pi-agentic-driver", version: "3.1.7", type: "module" }));
  await writeFile(entry, 'export const DURABLE_DRIVER_PROTOCOL = "agentic-driver.run.v1"; export const openDurableDriver = async () => ({});');
  try {
    const api = await requireDriverRunApi("omb-missing-driver-specifier", root);
    assert.equal(typeof api.openDurableDriver, "function");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unconfigured driver refuses silent Pi or agent npm-root fallback", async () => {
  const home = await mkdtemp(join(process.cwd(), ".omb-driver-home-"));
  try {
    await assert.rejects(requireDriverRunApi(undefined, undefined, home), /configure one absolute driver root/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("configured driver with an incompatible protocol fails closed", async () => {
  const root = await mkdtemp(join(process.cwd(), ".omb-driver-home-"));
  try {
    await mkdir(join(root, "scripts", "enforcement"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@evoclock/pi-agentic-driver", version: "3.1.7", type: "module" }));
    await writeFile(join(root, "scripts", "enforcement", "durable_driver_pi.js"), 'export const openDurableDriver = async () => ({});');
    await assert.rejects(requireDriverRunApi("omb-missing-driver-specifier", root), /installed driver-run API is unavailable.*agentic-driver\.run\.v1/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("driver-run rejects without one configured root", async () => {
  const home = await mkdtemp(join(process.cwd(), ".omb-driver-home-"));
  try {
    await assert.rejects(requireDriverRunApi(undefined, undefined, home), /configure one absolute driver root/i);
  } finally { await rm(home, { recursive: true, force: true }); }
});
