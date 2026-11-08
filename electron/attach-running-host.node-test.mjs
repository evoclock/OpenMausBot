import test from "node:test";
import assert from "node:assert/strict";
import { choosePackagedHost, probeRunningHost } from "./attach-running-host.mjs";

const health = (body, ok = true) => ({ ok, json: async () => body });

test("attaches to a healthy OpenMausBot on the default port", async () => {
  const urls = [];
  const host = await probeRunningHost({ fetchImpl: async url => {
    urls.push(url);
    return health({ app: "openmausbot", pid: 40062 });
  } });
  assert.deepEqual(host, { port: 8799, origin: "http://127.0.0.1:8799", pid: 40062 });
  assert.deepEqual(urls, ["http://127.0.0.1:8799/api/health"]);
});

test("skips foreign listeners, failed responses, and timed out fetches", async () => {
  for (const response of [health({ app: "other" }), health({ app: "openmausbot" }, false), null]) {
    const host = await probeRunningHost({ fetchImpl: async () => {
      if (!response) throw new Error("timeout");
      return response;
    } });
    assert.equal(host, null);
  }
});

test("live host never leases or starts a child; missing host retains lease path", async () => {
  let leases = 0;
  let starts = 0;
  let quits = 0;
  const acquireLease = () => { leases++; return { release() {} }; };
  const start = () => { starts++; };
  const host = { port: 8799, origin: "http://127.0.0.1:8799", pid: 12 };
  const attached = await choosePackagedHost({ companion: null, acquireLease, probe: async () => host });
  if (!attached.host) start();
  assert.equal(attached.host, host);
  assert.equal(attached.lease, null);
  assert.deepEqual([leases, starts, quits], [0, 0, 0]);
  const owned = await choosePackagedHost({ companion: null, acquireLease, probe: async () => null });
  if (!owned.host) start();
  assert.ok(owned.lease);
  assert.deepEqual([leases, starts, quits], [1, 1, 0]);
  const companion = await choosePackagedHost({ companion: {}, acquireLease, probe: () => { throw Error("probed companion"); } });
  assert.equal(companion.host, null);
  assert.equal(leases, 2);
});
