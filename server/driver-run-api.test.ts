import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { test } from "vitest";
import * as durable from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { requireDriverRunApi } from "./driver-run-api.ts";

const require = createRequire(import.meta.url);

test("installed Pi Durable 1.0.4 provides OMB's harness but not the driver-run protocol", () => {
  assert.equal(require("@earendil-works/pi-durable/package.json").version, "1.0.4");
  assert.equal(typeof durable.Harness.open, "function");
  assert.equal(typeof durable.createRegistry, "function");
  assert.equal(typeof durable.defineTask, "function");
  assert.equal(typeof openNodeSqliteStorage, "function");
  assert.equal("openDurableDriver" in durable, false);
  assert.equal("DURABLE_DRIVER_PROTOCOL" in durable, false);
});

test("a driver-run request refuses before any effect when its installed package lacks the protocol", async () => {
  await assert.rejects(requireDriverRunApi(), /installed driver-run API is unavailable.*agentic-driver\.run\.v1/i);
});
