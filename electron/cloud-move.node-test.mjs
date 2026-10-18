import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import environments from "./environments.cjs";
import localOrigin from "./local-origin.cjs";
import { cloudPageSenderAllowed, createCloudMove, mintOwnerCode, moveBlocked, moveFit, moveRefusal, moveSenderDestination, olderVersion, parseBrought, parseCloudMoveStatus, parseMoveEstimate } from "./cloud-move.mjs";
import { cloudMoveChoices } from "./cloud-move-choices.mjs";
import { cloudPlanSnapshot } from "./cloud-account.mjs";
import { cloudPlanDisk, isCloudHomeEntry, myCloudOrigin } from "./cloud-home.mjs";

const ORIGIN = "https://omb-u-1a2b3c4d5e6f.fly.dev";
const MAGIC = Buffer.from("OMB-WORKSPACE-1\n");
const UUID = () => "3f9c2a4e-8b1d-4c6e-9a7f-" + randomBytes(6).toString("hex");
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function desktop({ bytes = 5000, busy = false, exportError = null, routines, identity = {} } = {}) {
  const archive = Buffer.concat([MAGIC, randomBytes(bytes - MAGIC.length)]), calls = [];
  const id = UUID();
  return {
    archive, calls,
    request: async (route, init) => {
      calls.push([init.method, route, init.body ? JSON.parse(init.body) : undefined]);
      if (route === "/api/cloud-move/estimate") return json(200, { bots: 3, rooms: 1, chats: 7, bytes, files: 12, ...(routines === undefined ? {} : { routines }), ...identity });
      if (route === "/api/workspace-backup/status") return json(200, { busy, pendingRestore: false });
      if (route === "/api/workspace-backup/export") {
        if (exportError) return json(400, { error: exportError });
        return busy ? json(409, { error: "busy" }) : json(200, { id, bytes, summary: { bots: 3, files: 12, messages: 40 } });
      }
      if (route === `/api/workspace-backup/download/${id}`) return new Response(archive, { status: 200, headers: { "content-length": String(bytes) } });
      return json(404, {});
    },
  };
}

const BROUGHT = { conversations: 12, messages: 340, intoExisting: 40, skippedBots: 1, skippedRooms: 0, deleted: 0 };
function cloudFake({ freeBytes = 1024 ** 4, volumeBytes, empty = true, failPut = () => false, dropAnswer = () => false, loseAt = 0, busyRestores = 0, storedPart = 0, previewBots = 3, identity = {}, refuse = null,
  partBytes = 1024, proxyLimit = Infinity, leftBehind = null, brought = BROUGHT, mergeError = null } = {}) {
  const state = { freeBytes, upload: storedPart ? { sha256: "e".repeat(64), bytes: storedPart } : null, received: Buffer.alloc(storedPart), job: null, lastRestoreId: null, restarting: 0,
      previous: null, contents: { bots: 1, rooms: 0, chats: 0 }, empty, discards: 0, restoreAsks: [] },
    log = [], tokens = new Set();
  let lost = false;
  const fetchImpl = async (url, init = {}) => {
    init.signal?.throwIfAborted();
    const { pathname, searchParams } = new URL(url);
    const auth = new Headers(init.headers).get("authorization");
    log.push([init.method ?? "GET", pathname]);
    if (pathname === "/api/auth/pair") {
      assert.equal(JSON.parse(init.body).code, "ABCD-EFGH-JKLM");
      const token = `omb_sess_${randomBytes(8).toString("hex")}`; tokens.add(token);
      return json(200, { token });
    }
    if (!tokens.has(auth?.slice("Bearer ".length))) return json(401, { error: "unauthorized" });
    if (pathname === "/api/auth/logout") { tokens.delete(auth.slice("Bearer ".length)); return json(200, { ok: true }); }
    if (state.restarting > 0) { state.restarting--; throw new TypeError("fetch failed"); }
    if (refuse && pathname.startsWith("/api/cloud-move")) return json(refuse.status, refuse.body);
    if (pathname === "/api/cloud-move" && (init.method ?? "GET") === "GET") {
      return json(200, { ...identity, contents: state.contents, empty: state.empty, freeBytes: state.freeBytes, ...(volumeBytes ? { volumeBytes } : {}), previous: state.previous, job: state.job, pendingRestore: false, busy: false,
        lastRestoreId: state.lastRestoreId, leftBehind: state.lastRestoreId ? leftBehind : null, rolledBackId: null, partBytes: 1024,
        upload: state.upload && { ...state.upload, received: state.received.length } });
    }
    const body = init.body && !(init.body instanceof Uint8Array) ? JSON.parse(init.body) : undefined;
    if (pathname === "/api/cloud-move/discard") { state.discards++; if (state.job?.kind === "preview") state.job = null; return json(200, { ok: true }); }
    if (pathname === "/api/cloud-move/upload") {
      if (3 * body.bytes > state.freeBytes + state.received.length) return json(507, { error: "full", freeBytes: state.freeBytes, neededBytes: 3 * body.bytes });
      if (state.upload?.sha256 !== body.sha256) { state.upload = { sha256: body.sha256, bytes: body.bytes }; state.received = Buffer.alloc(0); }
      return json(200, { received: state.received.length, partBytes });
    }
    if (pathname.startsWith("/api/cloud-move/upload/")) {
      const offset = Number(searchParams.get("offset")), part = Buffer.from(init.body);
      state.puts = [...(state.puts ?? []), part.length];
      // A proxy in front (nginx: client_max_body_size), before the server sees anything.
      if (part.length > proxyLimit) return new Response("<html><body><h1>413 Request Entity Too Large</h1></body></html>", { status: 413, headers: { "content-type": "text/html" } });
      if (failPut(offset)) throw new TypeError("fetch failed");
      if (offset + part.length <= state.received.length) return json(200, { received: state.received.length });
      if (offset !== state.received.length) return json(409, { error: "elsewhere", received: state.received.length });
      state.received = Buffer.concat([state.received, part]);
      const received = state.received.length;
      // Stored, but the answer never arrives: the app sends the part again.
      if (dropAnswer(offset)) throw new TypeError("fetch failed");
      // Answered, then lost (a restart mid-upload): the next part is refused with where it stands.
      if (loseAt && received === loseAt && !lost) { lost = true; state.received = state.received.subarray(0, received - part.length); }
      return json(200, { received });
    }
    if (pathname === "/api/cloud-move/preview") {
      const hash = createHash("sha256").update(state.received).digest("hex");
      assert.equal(hash, state.upload.sha256);
      assert.ok(body.password.length >= 12);
      state.job = { kind: "preview", state: "done", id: UUID(), summary: { bots: previewBots, messages: 40 } };
      return json(202, { job: { kind: "preview", state: "running" } });
    }
    if (pathname === "/api/cloud-move/merge") {
      assert.equal(createHash("sha256").update(state.received).digest("hex"), state.upload.sha256);
      assert.ok(body.password.length >= 12);
      state.merges = (state.merges ?? 0) + 1;
      state.job = mergeError ? { kind: "merge", state: "failed", error: mergeError } : { kind: "merge", state: "done", id: UUID(), result: brought };
      return json(202, { job: { kind: "merge", state: "running" } });
    }
    if (pathname === "/api/cloud-move/restore") {
      state.restoreAsks.push(body.id);
      if (busyRestores-- > 0) return json(409, { error: "Another move step is running on your Cloud. Wait for it to finish." });
      assert.equal(body.id, state.job.id);
      state.previous = state.empty ? null : { createdAt: new Date().toISOString(), bots: 2, rooms: 0, chats: 4 };
      state.job = null; state.restarting = 2; state.lastRestoreId = body.id;
      state.contents = { bots: 3, rooms: 1, chats: 7 }; state.empty = false;
      return json(202, { job: { kind: "restore", state: "running" } });
    }
    return json(404, {});
  };
  return { state, log, tokens, fetchImpl };
}

const CLOUD = { id: "cloud", name: "My Cloud", origin: ORIGIN, kind: "cloud" };
function cloudDestination(options = {}) {
  return { ...CLOUD, grant: options.pairHome ?? (async () => ({ origin: ORIGIN, code: "ABCD-EFGH-JKLM", expiresAt: Date.now() + 60_000 })),
    disk: options.cloudDisk ?? (() => null), grow: options.growCloud ?? (async () => ({ supported: false })) };
}
function harness(options = {}) {
  const temp = mkdtempSync(join(tmpdir(), "omb-cloud-move-test-"));
  const local = desktop(options.desktop), cloud = cloudFake(options.cloud), states = [];
  const dest = options.dest ?? cloudDestination(options);
  const engine = createCloudMove({
    localRequest: local.request, fetchImpl: cloud.fetchImpl, tempRoot: join(temp, "move"),
    availableBytes: async () => options.localFree ?? 1024 ** 4, sleep: async (_ms, signal) => signal?.throwIfAborted(), pollMs: 0, retryDelaysMs: [0, 0],
    ...(options.now ? { now: options.now } : {}), ...(options.growTimeoutMs !== undefined ? { growTimeoutMs: options.growTimeoutMs } : {}),
    onState: state => { states.push(state); options.onState?.(state, move); },
  });
  const move = { ...engine, move: copy => engine.move(dest, copy), restorePrevious: () => engine.restorePrevious(dest), bring: () => engine.bring(dest) };
  return { temp, local, cloud, states, move, engine, dest, done: () => rmSync(temp, { recursive: true, force: true }) };
}

test("moves this computer's archive in parts, waits out the restart, signs its session out and leaves no temporary file", async () => {
  const f = harness();
  try {
    const result = await f.move.move();
    assert.deepEqual(result, { phase: "done", action: "move", moved: { bots: 3, rooms: 1, chats: 7 }, previous: false, destination: CLOUD });
    assert.ok(f.cloud.state.received.equals(f.local.archive));
    assert.deepEqual([...new Set(f.states.map(state => state.phase))], ["preparing", "exporting", "uploading", "checking", "replacing", "restarting", "done"]);
    assert.equal(f.cloud.log.filter(([method, path]) => method === "PUT" && path.startsWith("/api/cloud-move/upload/")).length, 5);
    const exported = f.local.calls.find(([, route]) => route === "/api/workspace-backup/export")[2];
    assert.deepEqual(exported.clientState, {});
    assert.ok(exported.password.length >= 40);
    assert.equal(f.cloud.tokens.size, 0, "the move's session was signed out");
    assert.deepEqual(readdirSync(join(f.temp, "move")), []);
  } finally { f.done(); }
});

test("brings newer chats over the same upload: the destination adds what it lacks, never restarts or replaces anything, and nothing stays behind", async () => {
  const f = harness({ cloud: { empty: false } });
  try {
    const result = await f.move.bring();
    assert.deepEqual(result, { phase: "done", action: "bring", brought: BROUGHT, destination: CLOUD });
    assert.ok(f.cloud.state.received.equals(f.local.archive));
    assert.deepEqual([...new Set(f.states.map(state => state.phase))], ["preparing", "exporting", "uploading", "merging", "done"]);
    assert.ok(f.states.every(state => state.action === "bring"), "every step says it is a bring");
    assert.equal(f.cloud.state.merges, 1);
    assert.deepEqual(f.cloud.state.restoreAsks, [], "nothing asked the destination to replace its workspace");
    assert.equal(f.cloud.log.some(([, path]) => path === "/api/cloud-move/preview" || path === "/api/cloud-move/discard"), false);
    assert.equal(f.cloud.tokens.size, 0, "the bring's session was signed out");
    assert.deepEqual(readdirSync(join(f.temp, "move")), []);
  } finally { f.done(); }
});

test("a bring the destination could not finish says why, and Bring again exports afresh; one it never started can be stopped", async () => {
  const f = harness({ cloud: { empty: false, mergeError: "This backup was made by a newer OpenMausBot version. Update the app before restoring it." } });
  try {
    const result = await f.move.bring();
    assert.equal(result.phase, "failed");
    assert.equal(result.action, "bring");
    assert.deepEqual(result.error, { code: "merge_failed", message: "This backup was made by a newer OpenMausBot version. Update the app before restoring it." });
    assert.equal(result.resumable, undefined);
    assert.equal(f.cloud.state.discards, 0, "a started bring is never discarded");
    f.cloud.state.job = null;
    await f.move.bring();
    assert.equal(f.local.calls.filter(([, route]) => route === "/api/workspace-backup/export").length, 2);
  } finally { f.done(); }
  const stopped = harness({ cloud: { empty: false }, onState: (state, engine) => { if (state.phase === "uploading") engine.cancel(); } });
  try {
    const result = await stopped.move.bring();
    assert.equal(result.error.code, "cancelled");
    assert.equal(stopped.cloud.state.merges, undefined);
    assert.equal(stopped.cloud.state.discards, 1);
  } finally { stopped.done(); }
  assert.deepEqual(parseBrought({ ...BROUGHT, extra: "x" }), BROUGHT);
  assert.equal(parseBrought({ ...BROUGHT, deleted: -1 }), null);
  assert.equal(parseBrought(null), null);
});

test("this desktop remembers the Cloud its bots were copied to until it swaps back, beside the servers whose offer it hid", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-move-choices-"));
  try {
    const file = join(dir, "cloud-move.json"), choices = cloudMoveChoices(file);
    assert.equal(choices.movedHome(ORIGIN), false);
    choices.dismiss("https://bots.example.test");
    choices.setHome(ORIGIN);
    assert.equal(choices.movedHome(ORIGIN), true);
    assert.equal(choices.movedHome("https://other.example.test"), false);
    assert.equal(choices.movedHome(null), false);
    assert.equal(choices.dismissed("https://bots.example.test"), true);
    choices.setHome(null);
    assert.equal(choices.movedHome(ORIGIN), false);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { dismissed: ["https://bots.example.test"] });
    assert.equal(cloudMoveChoices(join(dir, "missing", "cloud-move.json")).movedHome(ORIGIN), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("after a move from another kind of computer, says which of its folders and files did not come over", async () => {
  const leftBehind = { bots: 2, paths: ["C:\\Users\\Ada\\Projects\\site", "C:\\Users\\Ada\\Desktop\\x.docx"] };
  const f = harness({ cloud: { leftBehind } });
  try {
    const result = await f.move.move();
    assert.equal(result.phase, "done", JSON.stringify(result));
    assert.deepEqual(result.leftBehind, leftBehind);
  } finally { f.done(); }
  const status = { contents: { bots: 1, rooms: 0, chats: 0 }, empty: false, freeBytes: 1 };
  assert.equal(parseCloudMoveStatus(status).leftBehind, null);
  assert.equal(parseCloudMoveStatus({ ...status, leftBehind: { bots: -1, paths: [] } }).leftBehind, null);
  assert.equal(parseCloudMoveStatus({ ...status, leftBehind: { bots: 0, paths: [7, ""] } }).leftBehind, null);
  assert.deepEqual(parseCloudMoveStatus({ ...status, leftBehind: { bots: 0, paths: ["C:\\a\nb", ...Array(30).fill("D:\\x")] } }).leftBehind,
    { bots: 0, paths: ["C:\\a b", ...Array(19).fill("D:\\x")] });
});

const puts = f => f.cloud.log.filter(([method, path]) => method === "PUT" && path.startsWith("/api/cloud-move/upload/")).length;
test("continues a dropped upload: a part whose answer was lost is sent again without being stored twice", async () => {
  let drops = 1;
  const f = harness({ cloud: { dropAnswer: offset => offset === 2048 && drops-- > 0 } });
  try {
    const result = await f.move.move();
    assert.equal(result.phase, "done", JSON.stringify(result));
    assert.ok(f.cloud.state.received.equals(f.local.archive));
    assert.equal(puts(f), 6);
  } finally { f.done(); }
});

test("continues from where the Cloud stands when it lost a part", async () => {
  const f = harness({ cloud: { loseAt: 2048 } });
  try {
    const result = await f.move.move();
    assert.equal(result.phase, "done", JSON.stringify(result));
    assert.ok(f.cloud.state.received.equals(f.local.archive));
    assert.equal(puts(f), 7);
  } finally { f.done(); }
});

test("an upload that keeps failing stops resumable, and moving again continues it without a second export", async () => {
  let failing = true;
  const f = harness({ cloud: { failPut: offset => failing && offset >= 3072 } });
  try {
    const first = await f.move.move();
    assert.equal(first.phase, "failed");
    assert.equal(first.error.code, "upload_failed");
    assert.equal(first.resumable, true);
    assert.equal(f.cloud.state.lastRestoreId, null, "nothing was replaced");
    assert.equal(f.cloud.tokens.size, 0);
    failing = false;
    const second = await f.move.move();
    assert.equal(second.phase, "done", JSON.stringify(second));
    assert.equal(f.local.calls.filter(([, route]) => route === "/api/workspace-backup/export").length, 1);
    assert.ok(f.cloud.state.received.equals(f.local.archive));
  } finally { f.done(); }
});

test("a proxy that refuses large parts gets smaller ones; one that refuses even 512 KB is named, with what to change, and the copy continues later", async () => {
  const MB = 1024 ** 2;
  // nginx's default client_max_body_size, 1 MB, in front of a server that asks for 4 MB parts.
  const behind = harness({ desktop: { bytes: 8 * MB + 5000 }, cloud: { partBytes: 4 * MB, proxyLimit: MB } });
  try {
    const result = await behind.move.move();
    assert.equal(result.phase, "done", JSON.stringify(result.error));
    assert.ok(behind.cloud.state.received.equals(behind.local.archive));
    assert.deepEqual(behind.cloud.state.puts.slice(0, 3), [4 * MB, 2 * MB, MB]);
    assert.ok(behind.cloud.state.puts.slice(2).every(size => size <= MB), "every later part fits");
  } finally { behind.done(); }
  const tight = harness({ desktop: { bytes: 4 * MB }, cloud: { partBytes: 3 * MB, proxyLimit: 256 * 1024 } });
  try {
    const result = await tight.move.move();
    assert.equal(result.phase, "failed");
    assert.equal(result.error.code, "proxy_limit");
    assert.equal(result.error.partBytes, 512 * 1024);
    assert.match(result.error.message, /^A proxy in front of My Cloud refused a 512 KB upload\. Raise its request size limit \(nginx: client_max_body_size 64m\), then copy again\.$/);
    assert.deepEqual(tight.cloud.state.puts, [3 * MB, 1.5 * MB, 768 * 1024, 512 * 1024]);
    assert.equal(result.resumable, true);
    assert.equal(tight.cloud.state.restoreAsks.length, 0);
    assert.equal(tight.cloud.tokens.size, 0);
  } finally { tight.done(); }
  const declared = harness({ cloud: { refuse: null } });
  try {
    const fetchImpl = declared.cloud.fetchImpl;
    const big = createCloudMove({ localRequest: declared.local.request, tempRoot: join(declared.temp, "move"), availableBytes: async () => 1024 ** 4, sleep: async () => {}, pollMs: 0,
      fetchImpl: (url, init) => new URL(url).pathname === "/api/cloud-move/upload" ? Promise.resolve(json(413, { error: "This workspace is larger than the 10 GB a copy can carry." })) : fetchImpl(url, init) });
    assert.equal((await big.move(cloudDestination())).error.code, "too_large");
  } finally { declared.done(); }
});

test("refuses a Cloud without room before anything is uploaded, saying how much it needs", async () => {
  const f = harness({ cloud: { freeBytes: 10_000 } });
  try {
    const result = await f.move.move();
    assert.equal(result.phase, "failed");
    assert.equal(result.error.code, "cloud_full");
    assert.equal(result.error.freeBytes, 10_000);
    assert.ok(result.error.neededBytes > 10_000);
    assert.equal(f.local.calls.filter(([, route]) => route === "/api/workspace-backup/export").length, 0);
    assert.equal(f.cloud.log.some(([method]) => method === "PUT"), false);
  } finally { f.done(); }
});

const GB = 1024 ** 3, MARGIN = 256 * 1024 ** 2;
test("a move is measured against the plan's largest disk when the disk grows, and against today's when it cannot", () => {
  const local = 3.4 * GB, free = 8.9 * GB;
  assert.deepEqual(moveFit({ localBytes: 1 * GB, freeBytes: free }), { fit: "now", neededBytes: 3 * GB + MARGIN, freeBytes: free });
  const grow = moveFit({ localBytes: local, freeBytes: free, disk: { maxBytes: 100 * GB, startBytes: 10 * GB } });
  assert.equal(grow.fit, "grow"); assert.equal(grow.sizeGb, 20); assert.equal(grow.maxBytes, 100 * GB);
  assert.deepEqual(moveFit({ localBytes: local, freeBytes: free, disk: { maxBytes: 10 * GB, startBytes: 10 * GB } }),
    { fit: "never", neededBytes: 3 * local + MARGIN, freeBytes: free, maxBytes: 10 * GB });
  assert.equal(moveFit({ localBytes: 40 * GB, freeBytes: 5 * GB, volumeBytes: 10 * GB, disk: { maxBytes: 100 * GB, volumeBytes: 10 * GB, largest: true } }).largest, true);
  assert.deepEqual(moveFit({ localBytes: local, freeBytes: free }), { fit: "never", neededBytes: 3 * local + MARGIN, freeBytes: free });
  assert.deepEqual(moveFit({ localBytes: local, freeBytes: free, volumeBytes: 10 * GB }), { fit: "never", neededBytes: 3 * local + MARGIN, freeBytes: free, volumeBytes: 10 * GB });
  assert.equal(moveFit({ localBytes: 10 * GB, freeBytes: 15 * GB, volumeBytes: 40 * GB, disk: { maxBytes: 100 * GB, startBytes: 10 * GB } }).sizeGb, 60);
  assert.equal(moveFit({ localBytes: 28 * GB, freeBytes: 15 * GB, volumeBytes: 20 * GB, disk: { maxBytes: 100 * GB, startBytes: 10 * GB } }).sizeGb, 90);
  assert.equal(moveFit({ localBytes: 40 * GB, freeBytes: 5 * GB, volumeBytes: 10 * GB, disk: { maxBytes: 100 * GB } }).fit, "never");
  assert.equal(moveFit({ localBytes: 1 * GB, freeBytes: 2 * GB, uploadReceived: 2 * GB }).fit, "now");
  assert.deepEqual(parseMoveEstimate({ bots: 1, rooms: 0, chats: 2, bytes: 10, files: 1, routines: 4 }).routines, 4);
  assert.equal(parseMoveEstimate({ bots: 1, rooms: 0, chats: 2, bytes: 10, files: 1, routines: -1 }).routines, undefined);
});

const OVERVIEW_START = "async function cloudMoveOverview(", IPC_START = "// ── Who asks, and where to", IPC_END = "// ── end Copy this computer here ──";
async function mainOverview({ dest, peek, local = { bots: 3, rooms: 1, chats: 12, bytes: 3.4 * GB, files: 100 }, state = { phase: "idle" }, running = false, onServerPage = true }) {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf(OVERVIEW_START), end = source.indexOf(IPC_START, start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ moveFit, moveBlocked, moveChoices: () => ({ dismissed: () => false, movedHome: origin => origin === ORIGIN }), myCloud: () => ORIGIN, cloudAccountRestored: async () => {}, peekCloudMove: async () => peek,
    ensureCloudMove: () => ({ estimate: async () => local, state: () => state, running: () => running }) });
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.cloudMoveOverview = cloudMoveOverview;`, context);
  // Made in main's own realm: compared as plain data.
  return JSON.parse(JSON.stringify(await context.cloudMoveOverview(dest, onServerPage)));
}
test("a server's card offers a copy only when it can fit and nothing blocks it: Cloud growth counts only when the Admin says the disk grows", async () => {
  const max = machine => ({ status: "connected", account: { id: "a1", email: "p@example.test" },
    entitlement: { plan: "pro", tier: "max", status: "active", expiresAt: 1, version: 1 }, machine });
  const peek = { status: { empty: true, freeBytes: 8.9 * GB, uploadReceived: 0, volumeBytes: 10 * GB, contents: { bots: 0, rooms: 0, chats: 0 }, previous: null }, refusal: null };
  const cloud = machine => ({ ...CLOUD, disk: () => cloudPlanDisk(max(machine)) });
  let result = await mainOverview({ dest: cloud({ status: "ready", origin: ORIGIN }), peek });
  assert.equal(result.fit.fit, "never"); assert.equal(result.fit.volumeBytes, 10 * GB); assert.equal(result.suggest, false);
  result = await mainOverview({ dest: cloud({ status: "ready", origin: ORIGIN, disk: { gb: 10, maxGb: 100 } }), peek });
  assert.equal(result.fit.fit, "grow"); assert.equal(result.suggest, true); assert.deepEqual(result.destination, CLOUD); assert.equal(result.blocked, null);
  const roomy = { ...peek, status: { ...peek.status, freeBytes: 50 * GB } };
  const server = { ...VPS_ENTRY, disk: () => { throw new Error("a server has no plan"); } };
  result = await mainOverview({ dest: server, peek });
  assert.equal(result.fit.fit, "never"); assert.equal(result.suggest, false);
  result = await mainOverview({ dest: server, peek: roomy });
  assert.equal(result.suggest, true); assert.deepEqual(result.destination, VPS_ENTRY);
  for (const [blocked, input] of [
    ["owner_needed", { peek: { status: null, refusal: "owner_needed" } }],
    ["shared_workspace", { peek: { status: null, refusal: "shared_workspace" } }],
    ["outdated", { peek: { status: null, refusal: "outdated" } }],
    ["unreachable", { peek: { status: null, refusal: "unreachable" } }],
    ["same_computer", { peek: { ...roomy, status: { ...roomy.status, environmentId: "env-1" } }, local: { bots: 3, rooms: 1, chats: 12, bytes: GB, files: 1, environmentId: "env-1" } }],
  ]) {
    result = await mainOverview({ dest: server, ...input });
    assert.equal(result.blocked, blocked); assert.equal(result.suggest, false);
    assert.equal(JSON.stringify(result).includes("env-1"), false);
  }
  result = await mainOverview({ dest: server, peek: roomy, running: true, state: { phase: "uploading", action: "move", destination: CLOUD } });
  assert.equal(result.blocked, "busy_elsewhere"); assert.equal(result.busyWith, "My Cloud"); assert.equal(result.phase, "idle"); assert.equal(result.suggest, false);
  result = await mainOverview({ dest: server, peek: roomy, state: { phase: "done", action: "move", destination: CLOUD } });
  assert.equal(result.phase, "idle"); assert.equal(result.suggest, true);
  result = await mainOverview({ dest: cloud({ status: "ready", origin: ORIGIN }), peek: { status: null, refusal: "owner_needed" }, onServerPage: false });
  assert.equal(result.blocked, null); assert.equal(result.cloud, null);
  result = await mainOverview({ dest: null, peek });
  assert.deepEqual([result.destination, result.blocked, result.suggest, result.movedHome], [null, null, false, true]);
});

test("a Cloud whose plan's disk grows makes room first, then the move continues", async () => {
  const asked = [];
  const f = harness({ desktop: { bytes: 5000, routines: 4 }, cloud: { freeBytes: 10_000, volumeBytes: 1_000_000 },
    cloudDisk: () => ({ maxBytes: 100 * GB, startBytes: 10 * GB }),
    growCloud: async sizeGb => { asked.push(sizeGb); f.cloud.state.freeBytes = GB; return { supported: true, disk: { gb: sizeGb, maxGb: 100 } }; } });
  try {
    const result = await f.move.move();
    assert.equal(result.phase, "done"); assert.equal(result.routines, 4);
    assert.deepEqual(asked, [10]);
    assert.ok(f.states.some(state => state.phase === "growing"));
    assert.ok(f.cloud.state.received.equals(f.local.archive));
  } finally { f.done(); }
});

test("when the disk cannot grow for the move (an Admin without it, too slow, or over the plan), it says so and moves nothing", async () => {
  const cases = [
    ["cloud_grow_unsupported", async () => ({ supported: false })],
    ["cloud_grow_unavailable", async () => { throw new Error("offline"); }],
    ["cloud_full", async () => ({ supported: true, refused: true })],
  ];
  for (const [code, growCloud] of cases) {
    const f = harness({ cloud: { freeBytes: 10_000 }, cloudDisk: () => ({ maxBytes: 100 * GB, startBytes: 10 * GB }), growCloud });
    try {
      const result = await f.move.move();
      assert.equal(result.phase, "failed"); assert.equal(result.error.code, code); assert.equal(result.error.maxBytes, 100 * GB);
      assert.equal(f.local.calls.filter(([, route]) => route === "/api/workspace-backup/export").length, 0);
      assert.equal(f.cloud.log.some(([method]) => method === "PUT"), false);
    } finally { f.done(); }
  }
  let clock = 0;
  const slow = harness({ cloud: { freeBytes: 10_000 }, cloudDisk: () => ({ maxBytes: 100 * GB, startBytes: 10 * GB }), growTimeoutMs: 5,
    now: () => (clock += 2), growCloud: async () => ({ supported: true, disk: { gb: 20, maxGb: 100 } }) });
  try { assert.equal((await slow.move.move()).error.code, "cloud_grow_unavailable"); } finally { slow.done(); }
});

test("a disk that does not grow refuses a move it cannot hold, naming the plan's disk", async () => {
  let grown = 0;
  const f = harness({ cloud: { freeBytes: 10_000 }, cloudDisk: () => ({ maxBytes: 10_000, startBytes: 10_000 }), growCloud: async () => { grown++; return { supported: true }; } });
  try {
    const result = await f.move.move();
    assert.equal(result.error.code, "cloud_full"); assert.equal(result.error.maxBytes, 10_000); assert.equal(grown, 0);
  } finally { f.done(); }
});

test("a busy computer, a missing Cloud and a stop all end before the Cloud replaces anything", async () => {
  const busy = harness({ desktop: { busy: true } });
  try { assert.equal((await busy.move.move()).error.code, "busy"); } finally { busy.done(); }
  const missing = harness({ pairHome: async () => { throw new Error("Your Cloud is not ready to connect yet."); } });
  try {
    assert.equal((await missing.move.move()).error.code, "cloud_unavailable");
    assert.deepEqual(missing.cloud.log, []);
  } finally { missing.done(); }
  const stopped = harness({ onState: (state, move) => { if (state.phase === "uploading") move.cancel(); } });
  try {
    const result = await stopped.move.move();
    assert.equal(result.phase, "failed");
    assert.equal(result.error.code, "cancelled");
    assert.equal(stopped.cloud.log.some(([, path]) => path === "/api/cloud-move/restore"), false);
  } finally { stopped.done(); }
});

test("says a Cloud from before any server could receive a copy has to update first", async () => {
  const f = harness();
  const fetchImpl = f.cloud.fetchImpl;
  const outdated = createCloudMove({
    localRequest: f.local.request, tempRoot: join(f.temp, "move"), availableBytes: async () => 1024 ** 4, sleep: async () => {}, pollMs: 0,
    fetchImpl: (url, init) => new URL(url).pathname === "/api/cloud-move" ? Promise.resolve(json(404, { error: "not found" })) : fetchImpl(url, init),
  });
  try {
    const result = await outdated.move(cloudDestination());
    assert.equal(result.error.code, "outdated");
    assert.equal(f.local.calls.some(([, route]) => route === "/api/workspace-backup/export"), false);
  } finally { f.done(); }
});

test("asks a busy Cloud again with the same staged workspace, instead of uploading it twice", async () => {
  const f = harness({ cloud: { busyRestores: 2 } });
  try {
    const result = await f.move.move();
    assert.equal(result.phase, "done", JSON.stringify(result));
    assert.equal(f.cloud.state.restoreAsks.length, 3);
    assert.equal(new Set(f.cloud.state.restoreAsks).size, 1);
    assert.equal(f.cloud.log.filter(([, path]) => path === "/api/cloud-move/preview").length, 1);
  } finally { f.done(); }
});

test("a Cloud that stays busy, a stop while it checks, and a mismatch each drop what the move staged there", async () => {
  const busy = harness({ cloud: { busyRestores: 10 } });
  try {
    const result = await busy.move.move();
    assert.equal(result.error.code, "cloud_busy");
    assert.equal(busy.cloud.state.discards, 1);
    assert.equal(busy.cloud.state.lastRestoreId, null);
  } finally { busy.done(); }
  const stopped = harness({ onState: (state, move) => { if (state.phase === "checking") move.cancel(); } });
  try {
    const result = await stopped.move.move();
    assert.equal(result.error.code, "cancelled");
    assert.match(result.error.message, /was not replaced/);
    assert.equal(stopped.cloud.state.discards, 1);
  } finally { stopped.done(); }
  const different = harness({ cloud: { previewBots: 2 } });
  try {
    const result = await different.move.move();
    assert.equal(result.error.code, "invalid_backup");
    assert.equal(different.cloud.state.discards, 1);
    assert.equal(different.cloud.state.restoreAsks.length, 0);
  } finally { different.done(); }
});

test("credits a stored part of an earlier upload when checking the Cloud's room", async () => {
  // 3 × 5000 bytes plus the margin is more than is free, until the stored part is counted.
  const f = harness({ cloud: { freeBytes: 256 * 1024 ** 2 + 12_000, storedPart: 4_000 } });
  try {
    const result = await f.move.move();
    assert.equal(result.phase, "done", JSON.stringify(result));
  } finally { f.done(); }
});

test("says why this computer's server could not export, in its own words, on one line", async () => {
  const f = harness({ desktop: { exportError: "Cannot back up user-created symbolic link; replace it with regular files first: workspaces/bot/link\n\u0007" } });
  try {
    const result = await f.move.move();
    assert.equal(result.error.code, "export_failed");
    assert.equal(result.error.message, "Cannot back up user-created symbolic link; replace it with regular files first: workspaces/bot/link");
  } finally { f.done(); }
});

test("reports a replaced Cloud's backup", async () => {
  const f = harness({ cloud: { empty: false } });
  try {
    const result = await f.move.move();
    assert.equal(result.phase, "done");
    assert.equal(result.previous, true);
    assert.equal(f.states.find(state => state.phase === "replacing").replacing, true);
  } finally { f.done(); }
});

const VPS = "https://bots.example.test";
const VPS_ENTRY = { id: "vps", name: "bots.example.test", origin: VPS, kind: "server" };
function windowSession({ session = { kind: "session", id: "s1", scopes: ["admin", "client"] }, status = 200, pairing = null } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    calls.push({ method: init.method ?? "GET", pathname, credentials: init.credentials, origin: new Headers(init.headers).get("origin"), body: init.body ? JSON.parse(init.body) : undefined });
    if (pathname === "/api/auth/session") return json(status, status === 200 ? session : { error: "unauthorized" });
    if (pathname === "/api/auth/pairing" && init.method === "POST") return pairing ?? json(200, { code: "ABCD-EFGH-JKLM", expiresAt: Date.now() + 60_000 });
    return json(404, {});
  };
  return { fetch, calls };
}
const serverDestination = (cookie, extra = {}) => ({ ...VPS_ENTRY, grant: () => mintOwnerCode(cookie.fetch, VPS), ...extra });

test("a self-hosted server receives the copy through the same engine: the window's owner session mints the code, the copy's own session signs out", async () => {
  const cookie = windowSession();
  const f = harness({ desktop: { routines: 2 }, dest: serverDestination(cookie) });
  try {
    const result = await f.move.move();
    assert.equal(result.phase, "done", JSON.stringify(result));
    assert.deepEqual(result.destination, VPS_ENTRY);
    assert.equal(result.routines, 2);
    assert.ok(f.cloud.state.received.equals(f.local.archive));
    assert.ok(f.states.every(state => state.destination?.origin === VPS), "every state names where it goes");
    assert.deepEqual(cookie.calls.map(call => `${call.method} ${call.pathname}`), ["GET /api/auth/session", "POST /api/auth/pairing"]);
    assert.ok(cookie.calls.every(call => call.credentials === "include" && call.origin === VPS));
    assert.deepEqual(cookie.calls[1].body.scopes, ["admin", "client"]);
    assert.equal(f.cloud.tokens.size, 0);
    assert.ok(f.cloud.log.some(([method, path]) => method === "POST" && path === "/api/auth/logout"));
    assert.equal(cookie.calls.some(call => call.pathname === "/api/auth/logout"), false);
  } finally { f.done(); }
});

const exportsOf = f => f.local.calls.filter(([, route]) => route === "/api/workspace-backup/export").length;
test("refuses before exporting anything: another origin's grant, an old server, a shared one, this computer itself, an older version, or work a page may not replace", async () => {
  const cases = [
    ["cloud_unavailable", { dest: { ...VPS_ENTRY, grant: async () => ({ origin: "https://elsewhere.example.test", code: "ABCD-EFGH-JKLM" }) } }],
    ["outdated", { cloud: { refuse: { status: 404, body: { error: "Unknown" } } } }],
    ["shared_workspace", { cloud: { refuse: { status: 403, body: { error: "This server is shared with other people.", code: "shared_workspace" } } } }],
    ["same_computer", { desktop: { identity: { environmentId: "env-1", appVersion: "0.1.96" } }, cloud: { identity: { environmentId: "env-1", appVersion: "0.1.96" } } }],
    ["outdated", { desktop: { identity: { environmentId: "env-1", appVersion: "0.1.96" } }, cloud: { identity: { environmentId: "env-2", appVersion: "0.1.95" } } }],
    ["not_empty", { cloud: { empty: false }, copy: { requireEmpty: true } }],
  ];
  for (const [code, options] of cases) {
    const f = harness({ dest: serverDestination(windowSession()), ...options });
    try {
      const result = await f.move.move(options.copy);
      assert.equal(result.phase, "failed", `${code}: ${JSON.stringify(result)}`);
      assert.equal(result.error.code, code);
      assert.equal(exportsOf(f), 0, `${code}: nothing exported`);
      assert.equal(f.cloud.log.some(([method]) => method === "PUT"), false);
      assert.equal(f.cloud.tokens.size, 0, `${code}: the copy's session was signed out`);
      if (options.dest) assert.deepEqual(f.cloud.log, [], "never signed in anywhere else");
    } finally { f.done(); }
  }
  const older = harness({ dest: serverDestination(windowSession()), desktop: { identity: { appVersion: "0.1.96" } }, cloud: { identity: { appVersion: "0.1.95" } } });
  try {
    const result = await older.move.move();
    assert.deepEqual([result.error.destVersion, result.error.localVersion], ["0.1.95", "0.1.96"]);
    assert.match(result.error.message, /^bots\.example\.test runs 0\.1\.95; this computer runs 0\.1\.96/);
  } finally { older.done(); }
  const same = harness({ dest: serverDestination(windowSession()), desktop: { identity: { appVersion: "0.1.96", environmentId: "env-1" } }, cloud: { identity: { appVersion: "0.1.96", environmentId: "env-2" } } });
  try { assert.equal((await same.move.move({ requireEmpty: true })).phase, "done"); } finally { same.done(); }
});

test("only the Cloud grows its disk: a server's copy never asks for the plan's disk or growth", async () => {
  let asked = 0;
  const dest = { ...serverDestination(windowSession()), disk: () => { asked++; return { maxBytes: 100 * GB, startBytes: 10 * GB }; }, grow: async () => { asked++; return { supported: true }; } };
  const full = harness({ dest, cloud: { freeBytes: 10_000, volumeBytes: 1_000_000 } });
  try {
    const result = await full.move.move();
    assert.equal(result.error.code, "cloud_full");
    assert.equal(result.error.maxBytes, undefined);
    assert.equal(full.states.some(state => state.phase === "growing"), false);
  } finally { full.done(); }
  const roomy = harness({ dest });
  try { assert.equal((await roomy.move.move()).phase, "done"); } finally { roomy.done(); }
  assert.equal(asked, 0);
});

test("the window's session mints an owner code only when it is a signed-in owner of a server only they use", async () => {
  const minted = windowSession();
  assert.deepEqual(Object.keys(await mintOwnerCode(minted.fetch, VPS)).sort(), ["code", "expiresAt", "origin"]);
  assert.equal((await mintOwnerCode(minted.fetch, VPS)).origin, VPS);
  for (const [code, options] of [
    ["owner_needed", { session: { kind: "session", id: "s1", scopes: ["client"] } }],
    ["owner_needed", { status: 401 }],
    ["owner_needed", { session: { kind: "loopback", scopes: ["admin", "client"] } }],
    ["shared_workspace", { session: { kind: "session", id: "s1", scopes: ["admin", "client"], hosted: true } }],
  ]) {
    const refused = windowSession(options);
    await assert.rejects(mintOwnerCode(refused.fetch, VPS), error => error.code === code);
    assert.equal(refused.calls.some(call => call.method === "POST"), false, `${code}: no code minted`);
  }
  const managed = windowSession({ pairing: json(403, { error: "Your organisation turned off remote access.", code: "managed_policy" }) });
  await assert.rejects(mintOwnerCode(managed.fetch, VPS), error => error.code === "cloud_refused" && error.message === "Your organisation turned off remote access.");
  const offline = { fetch: async () => { throw new TypeError("fetch failed"); } };
  await assert.rejects(mintOwnerCode(offline.fetch, VPS), error => error.code === "network");
});

test("says why a server cannot receive a copy before one starts, one reason each", () => {
  assert.equal(moveRefusal(403, { code: "shared_workspace" }), "shared_workspace");
  assert.equal(moveRefusal(404, {}), "outdated");
  assert.equal(moveRefusal(401, {}), "owner_needed");
  assert.equal(moveRefusal(403, { error: "forbidden" }), "owner_needed");
  assert.equal(moveRefusal(502, {}), "unreachable");
  assert.equal(olderVersion("0.1.95", "0.1.96"), true);
  assert.equal(olderVersion("0.2.0", "0.1.96"), false);
  assert.equal(olderVersion("0.1.96", "0.1.96"), false);
  assert.equal(olderVersion(null, "0.1.96"), false);
  const local = { appVersion: "0.1.96", environmentId: "env-1" };
  assert.equal(moveBlocked({ kind: "server", local, cloud: { appVersion: "0.1.96", environmentId: "env-2" } }), null);
  assert.equal(moveBlocked({ kind: "server", local, cloud: { appVersion: "0.1.96", environmentId: "env-1" } }), "same_computer");
  assert.equal(moveBlocked({ kind: "server", local, cloud: { appVersion: "0.1.90", environmentId: "env-2" } }), "outdated");
  assert.equal(moveBlocked({ kind: "server", refusal: "owner_needed", local }), "owner_needed");
  assert.equal(moveBlocked({ kind: "server", refusal: "unreachable", local }), "unreachable");
  assert.equal(moveBlocked({ kind: "cloud", refusal: "owner_needed", local }), null);
  assert.equal(moveBlocked({ kind: "cloud", refusal: "unreachable", local }), null);
  assert.equal(moveBlocked({ kind: "cloud", refusal: "shared_workspace", local }), "shared_workspace");
  assert.equal(moveBlocked({ kind: "server", local, busyElsewhere: true }), "busy_elsewhere");
});

test("where a copy goes comes from main: this computer's page names a saved server, a server's page gets only itself", () => {
  const LOCAL_PAGE = "http://127.0.0.1:48993";
  const saved = [{ id: "vps", name: "VPS", origin: VPS }, { id: "cloud-entry", name: "My Cloud", origin: ORIGIN }];
  const localFrame = { url: `${LOCAL_PAGE}/settings` }, localContents = { mainFrame: localFrame };
  const onLocal = { environments: saved, activeId: "local" };
  const ask = (event, context) => moveSenderDestination(event, { contents: localContents, environments: onLocal, localOrigin: LOCAL_PAGE, cloudHomeOrigin: ORIGIN, ...context });
  const local = { sender: localContents, senderFrame: localFrame };
  assert.deepEqual(ask(local, { id: "vps" }), { entry: saved[0], remote: false });
  assert.deepEqual(ask(local, {}), { entry: null, remote: false });
  assert.deepEqual(ask(local, { id: "cloud" }), { entry: { ...saved[1], cloud: true }, remote: false });
  assert.deepEqual(ask(local, { id: "cloud", environments: { environments: [saved[0]], activeId: "local" } }), { entry: { id: "cloud", name: "My Cloud", origin: ORIGIN, cloud: true }, remote: false });
  assert.equal(ask(local, { id: "nope" }), null, "an unknown id");
  assert.equal(ask(local, { id: { origin: "https://evil.example.test" } }), null, "not an id");
  const vpsFrame = { url: `${VPS}/` }, vpsContents = { mainFrame: vpsFrame };
  const onVps = { environments: saved, activeId: "vps" };
  const page = { sender: vpsContents, senderFrame: vpsFrame };
  assert.deepEqual(moveSenderDestination(page, { contents: vpsContents, environments: onVps, localOrigin: LOCAL_PAGE }), { entry: saved[0], remote: true });
  assert.equal(moveSenderDestination(page, { contents: vpsContents, environments: onVps, localOrigin: LOCAL_PAGE, id: "cloud-entry" }), null, "a server's page naming a destination");
  assert.equal(moveSenderDestination(page, { contents: vpsContents, environments: onLocal, localOrigin: LOCAL_PAGE }), null, "while Local is active");
  assert.equal(moveSenderDestination(page, { contents: vpsContents, environments: { environments: saved, activeId: "cloud-entry" }, localOrigin: LOCAL_PAGE }), null, "another server is active");
  assert.equal(moveSenderDestination({ sender: vpsContents, senderFrame: { url: `${VPS}/` } }, { contents: vpsContents, environments: onVps, localOrigin: LOCAL_PAGE }), null, "a subframe");
  assert.equal(moveSenderDestination({ sender: {}, senderFrame: vpsFrame }, { contents: vpsContents, environments: onVps, localOrigin: LOCAL_PAGE }), null, "another window");
  const evil = { url: "https://evil.example.test/" }, evilContents = { mainFrame: evil };
  assert.equal(moveSenderDestination({ sender: evilContents, senderFrame: evil }, { contents: evilContents, environments: onVps, localOrigin: LOCAL_PAGE }), null, "a page that is not the saved server");
});

test("only the verified Cloud, open as this window's active server, counts as the Cloud page", () => {
  const frame = { url: `${ORIGIN}/` }, contents = { mainFrame: frame };
  const context = { contents, homeOrigin: ORIGIN, activeOrigin: ORIGIN };
  assert.equal(cloudPageSenderAllowed({ sender: contents, senderFrame: frame }, context), true);
  assert.equal(cloudPageSenderAllowed({ sender: contents, senderFrame: { url: `${ORIGIN}/` } }, context), false, "a subframe");
  assert.equal(cloudPageSenderAllowed({ sender: {}, senderFrame: frame }, context), false, "another window");
  assert.equal(cloudPageSenderAllowed({ sender: contents, senderFrame: frame }, { ...context, activeOrigin: "https://other.example.test" }), false);
  assert.equal(cloudPageSenderAllowed({ sender: contents, senderFrame: frame }, { ...context, homeOrigin: null }), false, "signed out of Cloud");
  const evil = { url: "https://evil.example.test/" }, evilContents = { mainFrame: evil };
  assert.equal(cloudPageSenderAllowed({ sender: evilContents, senderFrame: evil }, { contents: evilContents, homeOrigin: ORIGIN, activeOrigin: ORIGIN }), false);
});

const LOCAL = "http://127.0.0.1:48993";
function preload({ remote = false, activation = false } = {}) {
  let bridge; const invoked = [], listeners = new Map();
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`, "--omb-company-desktop=1"] },
    location: { origin: remote ? ORIGIN : LOCAL }, navigator: { userActivation: { isActive: activation } },
    TextEncoder, localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on: (channel, handler) => listeners.set(channel, handler), removeListener() {}, send() {}, invoke: (...args) => { invoked.push(args); return Promise.resolve({ phase: "idle" }); } } }),
  });
  return { bridge, invoked, listeners };
}
test("the bridge forwards only a saved server's id, only from this computer's page; a server's page names nothing and starts a copy only from the person's click", async () => {
  const local = preload();
  for (const method of ["state", "start", "cancel", "restorePrevious", "bring", "dismiss"]) await local.bridge.cloudMove[method]({ origin: "https://evil.example.test", token: "forged" });
  assert.deepEqual(local.invoked, [["cloud-move:state"], ["cloud-move:start"], ["cloud-move:cancel"], ["cloud-move:restore-previous"], ["cloud-move:bring"], ["cloud-move:dismiss"]]);
  local.invoked.length = 0;
  for (const method of ["state", "start", "cancel", "restorePrevious", "bring", "dismiss"]) await local.bridge.cloudMove[method]("vps");
  assert.deepEqual(local.invoked, [["cloud-move:state", "vps"], ["cloud-move:start", "vps"], ["cloud-move:cancel"], ["cloud-move:restore-previous", "vps"], ["cloud-move:bring", "vps"], ["cloud-move:dismiss", "vps"]]);
  const page = preload({ remote: true });
  assert.ok(page.bridge.cloudMove, "a server's card can reach it; main decides whether to answer");
  assert.equal(page.bridge.cloudAccount, undefined);
  await assert.rejects(page.bridge.cloudMove.start(), /Choose Copy/);
  await assert.rejects(page.bridge.cloudMove.bring("cloud"), /this computer's Settings/);
  assert.deepEqual(page.invoked, []);
  await page.bridge.cloudMove.state("vps"); await page.bridge.cloudMove.dismiss("vps");
  assert.deepEqual(page.invoked, [["cloud-move:state"], ["cloud-move:dismiss"]]);
  const clicked = preload({ remote: true, activation: true });
  await clicked.bridge.cloudMove.start("cloud");
  assert.deepEqual(clicked.invoked, [["cloud-move:start"]]);
  const seen = [];
  local.bridge.environments.onOpenSettings((id, panel) => seen.push([id, panel]));
  for (const panel of ["copy", "evil", undefined]) local.listeners.get("workspaces:open-settings")({}, "vps", panel);
  assert.deepEqual(seen, [["vps", "copy"], ["vps", undefined], ["vps", undefined]]);
});

function mainIpc(extra = {}) {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf(IPC_START), end = source.indexOf(IPC_END, start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map(), calls = [];
  let engineState = { phase: "idle" };
  localOrigin.setLocalOrigin(LOCAL);
  const describe = dest => ({ id: dest.id, name: dest.name, origin: dest.origin, kind: dest.kind, grant: typeof dest.grant, grows: typeof dest.grow === "function" });
  const context = vm.createContext({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: () => {} },
    senderIsLocal: localOrigin.isLocalSender, workspaceSenderAllowed: environments.workspaceSenderAllowed, cloudPageSenderAllowed, moveSenderDestination,
    activeEnvironment: environments.activeEnvironment, rendererOrigin: () => LOCAL, desktopRemoteAccess: false,
    mainWindow: { isDestroyed: () => false, webContents: localContents },
    environmentsState: { environments: SAVED, activeId: "local" },
    cloudAccount: { homeTarget: () => ({ origin: ORIGIN }) }, isCloudHomeEntry, cloudPlanDisk, mintOwnerCode,
    session: { defaultSession: { fetch: async () => { throw new Error("no network in this test"); } } },
    ensureCloudAccount: () => ({ pairHome: async () => ({ origin: ORIGIN, code: "ABCD-EFGH-JKLM" }), state: () => ({}) }),
    ensureCloudMove: () => ({
      // What main passes is made in its own realm: compared as plain data.
      move: async (dest, options) => { calls.push(["move", describe(dest), JSON.parse(JSON.stringify(options))]); return context.result ?? { phase: "idle" }; },
      cancel: () => { calls.push(["cancel"]); return engineState; }, state: () => engineState,
      restorePrevious: async dest => { calls.push(["restorePrevious", describe(dest)]); return context.result ?? { phase: "idle" }; },
      bring: async dest => { calls.push(["bring", describe(dest)]); return context.result ?? { phase: "idle" }; } }),
    moveChoices: () => ({ setHome: origin => calls.push(["home", origin]) }),
    cloudMoveOverview: (dest, onServerPage) => { calls.push(["overview", dest && describe(dest), onServerPage]); return { suggest: false }; },
    dismissCloudMove: origin => calls.push(["dismiss", origin]),
    connectCloudHome: async () => calls.push(["connectCloudHome"]), switchEnvironment: async id => calls.push(["switch", id]),
    navigateMainWindow: url => calls.push(["navigate", url]), slog: () => {},
    openWorkspaceSettings: (id, panel) => calls.push(["openSettings", id, panel]),
    ...extra,
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, handlers, calls, setState: next => { engineState = next; } };
}
const SAVED = [{ id: "vps", name: "VPS", origin: "https://bots.example.test" }, { id: "cloud-entry", name: "My Cloud", origin: ORIGIN }];
const localFrame = { url: `${LOCAL}/` }, localContents = { mainFrame: localFrame };
const vpsFrame = { url: "https://bots.example.test/" }, vpsContents = { mainFrame: vpsFrame };
const cloudFrame = { url: `${ORIGIN}/` }, cloudContents = { mainFrame: cloudFrame };
const VPS_DEST = { id: "vps", name: "VPS", origin: "https://bots.example.test", kind: "server", grant: "function", grows: false };
const CLOUD_DEST = { id: "cloud-entry", name: "My Cloud", origin: ORIGIN, kind: "cloud", grant: "function", grows: true };

test("production IPC: this computer's page names a saved server or the Cloud, and each gets its own way in", async () => {
  const { handlers, calls } = mainIpc();
  const local = { sender: localContents, senderFrame: localFrame };
  await handlers.get("cloud-move:state")(local, "vps");
  await handlers.get("cloud-move:start")(local, "vps");
  await handlers.get("cloud-move:start")(local, "cloud");
  await handlers.get("cloud-move:restore-previous")(local, "vps");
  await handlers.get("cloud-move:bring")(local, "cloud");
  await handlers.get("cloud-move:dismiss")(local, "vps");
  await handlers.get("cloud-move:cancel")(local);
  await handlers.get("cloud-move:state")(local);
  assert.deepEqual(calls, [
    ["overview", VPS_DEST, false], ["move", VPS_DEST, { requireEmpty: false }], ["move", CLOUD_DEST, { requireEmpty: false }], ["restorePrevious", VPS_DEST],
    ["bring", CLOUD_DEST], ["dismiss", VPS_DEST.origin], ["overview", VPS_DEST, false], ["cancel"], ["overview", null, false],
  ]);
  assert.throws(() => handlers.get("cloud-move:bring")(local), /Choose a server/);
  assert.throws(() => handlers.get("cloud-move:start")(local), /Choose a server/);
  for (const id of ["nope", { origin: "https://evil.example.test" }]) assert.throws(() => handlers.get("cloud-move:start")(local, id), /only available/);
});

test("production IPC: the Cloud is the Cloud even before its address is known, and nothing is local until this computer's origin is", async () => {
  const { context, handlers, calls } = mainIpc();
  const local = { sender: localContents, senderFrame: localFrame };
  context.cloudAccount = { homeTarget: () => null };
  context.environmentsState = { environments: [SAVED[0]], activeId: "local" };
  await handlers.get("cloud-move:start")(local, "cloud");
  assert.deepEqual(calls, [["move", { id: "cloud", name: "My Cloud", origin: null, kind: "cloud", grant: "function", grows: true }, { requireEmpty: false }]]);
  context.senderIsLocal = () => false;
  for (const channel of ["cloud-move:state", "cloud-move:start", "cloud-move:restore-previous"]) assert.throws(() => handlers.get(channel)(local, "vps"), /only available/);
  assert.throws(() => handlers.get("cloud-move:state")(local), /only available/);
});

test("production IPC: a server's own page gets only itself, never starts a copy to itself (only the verified Cloud's does, while empty), and cannot swap back", async () => {
  const { context, handlers, calls, setState } = mainIpc();
  context.mainWindow.webContents = vpsContents;
  context.environmentsState = { environments: SAVED, activeId: "vps" };
  const page = { sender: vpsContents, senderFrame: vpsFrame };
  await handlers.get("cloud-move:state")(page);
  assert.deepEqual(JSON.parse(JSON.stringify(await handlers.get("cloud-move:start")(page))), { phase: "idle" });
  await handlers.get("cloud-move:dismiss")(page);
  assert.deepEqual(calls, [["overview", VPS_DEST, true], ["openSettings", "vps", "copy"], ["dismiss", VPS_DEST.origin], ["overview", VPS_DEST, true]]);
  calls.length = 0;
  context.mainWindow.webContents = cloudContents;
  context.environmentsState = { environments: SAVED, activeId: "cloud-entry" };
  context.cloudAccount = { homeTarget: () => null };
  await handlers.get("cloud-move:start")({ sender: cloudContents, senderFrame: cloudFrame });
  assert.deepEqual(calls, [["openSettings", "cloud-entry", "copy"]]);
  context.cloudAccount = { homeTarget: () => ({ origin: ORIGIN }) };
  calls.length = 0;
  context.mainWindow.webContents = vpsContents;
  context.environmentsState = { environments: SAVED, activeId: "vps" };
  context.isCloudHomeEntry = () => true;
  await handlers.get("cloud-move:start")(page);
  assert.deepEqual(calls, [["openSettings", "vps", "copy"]]);
  context.isCloudHomeEntry = isCloudHomeEntry;
  context.mainWindow.webContents = vpsContents;
  context.environmentsState = { environments: SAVED, activeId: "vps" };
  assert.throws(() => handlers.get("cloud-move:start")(page, "cloud-entry"), /only available/);
  assert.throws(() => handlers.get("cloud-move:restore-previous")(page), /only available/);
  assert.throws(() => handlers.get("cloud-move:bring")(page), /only available/);
  calls.length = 0;
  setState({ phase: "uploading", destination: { origin: ORIGIN } });
  await handlers.get("cloud-move:cancel")(page);
  setState({ phase: "uploading", destination: { origin: "https://bots.example.test" } });
  await handlers.get("cloud-move:cancel")(page);
  assert.deepEqual(calls, [["cancel"]]);
  calls.length = 0;
  context.mainWindow.webContents = cloudContents;
  context.environmentsState = { environments: SAVED, activeId: "cloud-entry" };
  await handlers.get("cloud-move:start")({ sender: cloudContents, senderFrame: cloudFrame });
  assert.deepEqual(calls, [["move", CLOUD_DEST, { requireEmpty: true }]]);
  for (const event of [{ sender: cloudContents, senderFrame: { url: `${ORIGIN}/` } }, { sender: {}, senderFrame: cloudFrame }, { sender: cloudContents, senderFrame: { url: "https://evil.example.test/" } }]) {
    for (const channel of ["cloud-move:state", "cloud-move:start", "cloud-move:cancel", "cloud-move:dismiss", "cloud-move:restore-previous"]) assert.throws(() => handlers.get(channel)(event), /only available/);
  }
  context.desktopRemoteAccess = true;
  assert.throws(() => handlers.get("cloud-move:start")({ sender: cloudContents, senderFrame: cloudFrame }), /only available/);
});

test("production IPC: a finished copy opens the server it went to", async () => {
  const { context, handlers, calls } = mainIpc();
  context.result = { phase: "done", action: "move" };
  const local = { sender: localContents, senderFrame: localFrame };
  await handlers.get("cloud-move:start")(local, "vps");
  context.environmentsState = { environments: [SAVED[0]], activeId: "local" };
  await handlers.get("cloud-move:start")(local, "cloud");
  context.mainWindow.webContents = cloudContents;
  context.environmentsState = { environments: SAVED, activeId: "cloud-entry" };
  const cloudPage = { sender: cloudContents, senderFrame: cloudFrame };
  await handlers.get("cloud-move:start")(cloudPage);
  assert.deepEqual(calls.filter(([kind]) => kind !== "move"), [["switch", "vps"], ["home", ORIGIN], ["connectCloudHome"], ["home", ORIGIN], ["navigate", ORIGIN]]);
  calls.length = 0;
  context.result = { phase: "failed", error: { code: "network" } };
  await handlers.get("cloud-move:start")(cloudPage);
  assert.deepEqual(calls.filter(([kind]) => kind !== "move"), []);
  // Swapping My Cloud back means this computer's bots are no longer what it holds; a bring stays in Settings and changes neither.
  context.mainWindow.webContents = localContents;
  context.environmentsState = { environments: SAVED, activeId: "local" };
  context.result = { phase: "done", action: "restore" };
  await handlers.get("cloud-move:restore-previous")({ sender: localContents, senderFrame: localFrame }, "cloud");
  context.result = { phase: "done", action: "bring" };
  await handlers.get("cloud-move:bring")({ sender: localContents, senderFrame: localFrame }, "cloud");
  assert.deepEqual(calls.filter(([kind]) => !["move", "restorePrevious", "bring"].includes(kind)), [["home", null], ["switch", "cloud-entry"]]);
});

test("a server's Copy opens this computer's Settings → Servers on that server's copy, in this window or by switching it to this computer", () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("function openWorkspaceSettings("), end = source.indexOf("\n}\n", start) + 3;
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const context = vm.createContext({ LOCAL_ID: "local", rendererOrigin: () => LOCAL, environmentsState: { environments: SAVED, activeId: "vps" },
    withActive: (state, id) => ({ ...state, activeId: id }), persistEnvironments: state => calls.push(["persist", state.activeId]),
    navigateMainWindow: url => calls.push(["navigate", url]), senderIsLocal: ({ sender }) => sender === localContents,
    mainWindow: { isDestroyed: () => false, webContents: { ...vpsContents, send: (...args) => calls.push(["send", ...args]) } } });
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.openWorkspaceSettings = openWorkspaceSettings;`, context);
  context.openWorkspaceSettings("vps", "copy");
  context.openWorkspaceSettings("vps");
  assert.deepEqual(calls, [["persist", "local"], ["navigate", `${LOCAL}/?desktop-settings=workspaces&copy-to=vps`],
    ["persist", "local"], ["navigate", `${LOCAL}/?desktop-settings=workspaces&share-computer=vps`]]);
  calls.length = 0;
  const send = (...args) => calls.push(["send", ...args]);
  context.mainWindow = { isDestroyed: () => false, webContents: localContents };
  localContents.send = send;
  try {
    context.openWorkspaceSettings("vps", "copy");
    context.openWorkspaceSettings("vps");
  } finally { delete localContents.send; }
  assert.deepEqual(calls, [["send", "workspaces:open-settings", "vps", "copy"], ["send", "workspaces:open-settings", "vps"]]);
});

test("the Cloud's setup checklist can open the lending switch here, and nothing else can", async () => {
  const local = preload();
  await local.bridge.cloudLending.open({ origin: "https://evil.example.test", folders: ["/"] });
  assert.deepEqual(local.invoked, [["cloud-lending:open"]]);
  const page = preload({ remote: true });
  assert.ok(page.bridge.cloudLending);
  assert.deepEqual(Object.keys(page.bridge.cloudLending), ["open"]);
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf(IPC_START), end = source.indexOf(IPC_END, start);
  const handlers = new Map(), opened = [];
  const localFrame = { url: `${LOCAL}/` }, localContents = { mainFrame: localFrame };
  const cloudFrame = { url: `${ORIGIN}/` }, cloudContents = { mainFrame: cloudFrame };
  localOrigin.setLocalOrigin(LOCAL);
  const context = vm.createContext({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: () => {} },
    senderIsLocal: localOrigin.isLocalSender, workspaceSenderAllowed: environments.workspaceSenderAllowed, cloudPageSenderAllowed,
    activeEnvironment: environments.activeEnvironment, rendererOrigin: () => LOCAL, desktopRemoteAccess: false,
    mainWindow: { isDestroyed: () => false, webContents: localContents },
    environmentsState: { environments: [], activeId: "local" },
    cloudAccount: { homeTarget: () => ({ origin: ORIGIN }) }, myCloudOrigin, rememberedHome: null,
    openLendingSettings: async (...args) => { opened.push(args); },
  });
  vm.runInContext(source.slice(start, end), context);
  const open = handlers.get("cloud-lending:open");
  await open({ sender: localContents, senderFrame: localFrame }, { origin: "https://evil.example.test" });
  context.mainWindow.webContents = cloudContents;
  context.environmentsState = { environments: [{ id: "cloud", name: "My Cloud", origin: ORIGIN }], activeId: "cloud" };
  await open({ sender: cloudContents, senderFrame: cloudFrame });
  assert.deepEqual(opened, [[], []]);
  for (const event of [{ sender: cloudContents, senderFrame: { url: "https://other.example.test/" } }, { sender: {}, senderFrame: cloudFrame }]) {
    assert.throws(() => open(event), /only available/);
  }
  context.environmentsState = { environments: [{ id: "other", name: "Other", origin: "https://other.example.test" }], activeId: "other" };
  assert.throws(() => open({ sender: cloudContents, senderFrame: cloudFrame }), /only available/);
  assert.equal(opened.length, 2);
});

test("Settings on the person's own Cloud shows the plan read only, and can only open the dashboard or switch back", async () => {
  const page = preload({ remote: true });
  assert.deepEqual(Object.keys(page.bridge.cloudPlan), ["state", "manage", "useThisComputer", "noticeSeen"]);
  assert.equal(page.bridge.cloudAccount, undefined, "no account, credential or address reaches the Cloud's page");
  await page.bridge.cloudPlan.state({ origin: "https://evil.example.test" });
  await assert.rejects(page.bridge.cloudPlan.manage(), /Choose Manage/);
  await assert.rejects(page.bridge.cloudPlan.useThisComputer(), /Choose Use this computer/);
  await page.bridge.cloudPlan.noticeSeen("ended", { day: "2099-01-01" });
  assert.deepEqual(page.invoked, [["cloud-plan:state"], ["cloud-plan:notice-seen"]]);
  const clicked = preload({ remote: true, activation: true });
  await clicked.bridge.cloudPlan.manage("https://evil.example.test"); await clicked.bridge.cloudPlan.useThisComputer("vps");
  assert.deepEqual(clicked.invoked, [["cloud-plan:manage"], ["cloud-plan:local"]]);

  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf(IPC_START), end = source.indexOf(IPC_END, start);
  const handlers = new Map(), calls = [];
  const cloudFrame = { url: `${ORIGIN}/` }, cloudContents = { mainFrame: cloudFrame };
  localOrigin.setLocalOrigin(LOCAL);
  const account = { status: "connected", account: { id: "a1", email: "person@example.test" }, deviceId: "d1",
    entitlement: { plan: "pro", tier: "max", status: "active", expiresAt: 1, version: 1 }, machine: { status: "ready", origin: ORIGIN } };
  const context = vm.createContext({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: () => {} },
    senderIsLocal: localOrigin.isLocalSender, workspaceSenderAllowed: environments.workspaceSenderAllowed, cloudPageSenderAllowed,
    activeEnvironment: environments.activeEnvironment, rendererOrigin: () => LOCAL, desktopRemoteAccess: false,
    mainWindow: { isDestroyed: () => false, webContents: cloudContents },
    environmentsState: { environments: [{ id: "cloud", name: "My Cloud", origin: ORIGIN }], activeId: "cloud" },
    cloudAccount: { homeTarget: () => ({ origin: ORIGIN }), state: () => account }, cloudPlanSnapshot, LOCAL_ID: environments.LOCAL_ID, myCloudOrigin, rememberedHome: null,
    cloudTrialNotices: () => ({ due: () => null, seen: (...args) => { calls.push(["notice-seen", ...args]); } }),
    ensureCloudAccount: () => ({ openDashboard: async (...args) => { calls.push(["dashboard", ...args]); return account; } }),
    openLendingSettings: async () => { calls.push(["lending"]); },
    workspaceMenuAction: action => action(), switchEnvironment: id => { calls.push(["switch", id]); },
  });
  vm.runInContext(source.slice(start, end), context);
  const event = { sender: cloudContents, senderFrame: cloudFrame };
  assert.deepEqual(await handlers.get("cloud-plan:state")(event, { tier: "personal" }), { status: "paid", tier: "max" });
  assert.equal(await handlers.get("cloud-plan:manage")(event, "https://evil.example.test"), undefined);
  await handlers.get("cloud-plan:local")(event, "vps");
  assert.deepEqual(calls, [["dashboard"], ["switch", environments.LOCAL_ID]]);
  for (const sender of [{ sender: cloudContents, senderFrame: { url: "https://other.example.test/" } }, { sender: {}, senderFrame: cloudFrame }]) {
    for (const channel of ["cloud-plan:state", "cloud-plan:manage", "cloud-plan:local", "cloud-plan:notice-seen"]) assert.throws(() => handlers.get(channel)(sender), /only available/);
  }
  calls.length = 0;
  await handlers.get("cloud-plan:notice-seen")(event, "ended");
  assert.deepEqual(calls, [["notice-seen", account]]);
  calls.length = 0;
  const trial = { state: "ending", tier: "max", endsAt: 1_900_000_000_000, amount: 9900, chargeAt: null, holdUntil: null, deleteAt: 1_900_259_200_000, keep: "portal" };
  const onTrial = { ...account, trial };
  context.cloudAccount = { homeTarget: () => ({ origin: ORIGIN }), state: () => onTrial };
  context.cloudTrialNotices = () => ({ due: state => state === onTrial ? "ending" : null, seen: () => {} });
  assert.deepEqual(await handlers.get("cloud-plan:state")(event), { status: "paid", tier: "max", trial, notice: "ending" });
  context.cloudAccount = { homeTarget: () => ({ origin: ORIGIN }), state: () => account };
  let current = { status: "reauth-required", message: "expired", account: account.account, lastPlan: { tier: "max", active: true } };
  context.cloudAccount = { homeTarget: () => null, state: () => current };
  assert.throws(() => handlers.get("cloud-plan:state")(event), /only available/);
  context.rememberedHome = { accountId: "a1", origin: ORIGIN };
  assert.deepEqual(await handlers.get("cloud-plan:state")(event), { status: "signin", tier: "max" });
  current = { status: "unavailable", account: account.account, lastPlan: { tier: "max", active: true } };
  assert.deepEqual(await handlers.get("cloud-plan:state")(event), { status: "checking", tier: "max" });
  await handlers.get("cloud-plan:local")(event);
  assert.deepEqual(calls.at(-1), ["switch", environments.LOCAL_ID]);
  context.rememberedHome = { accountId: "someone-else", origin: ORIGIN };
  assert.throws(() => handlers.get("cloud-plan:state")(event), /only available/);
  assert.throws(() => handlers.get("cloud-lending:open")(event), /only available/);
  context.rememberedHome = { accountId: "a1", origin: ORIGIN };
  assert.throws(() => handlers.get("cloud-plan:state")({ sender: cloudContents, senderFrame: { url: "https://other.example.test/" } }), /only available/);
  await handlers.get("cloud-lending:open")(event);
  assert.deepEqual(calls.at(-1), ["lending"]);
  context.cloudAccount = { homeTarget: () => ({ origin: ORIGIN }), state: () => account };
  assert.deepEqual(cloudPlanSnapshot({ status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } }), { status: "signin", tier: "pro" });
  assert.deepEqual(cloudPlanSnapshot({ status: "reauth-required", message: "access-ended", lastPlan: { active: true } }), { status: "signin", tier: "pro" });
  assert.deepEqual(cloudPlanSnapshot({ status: "reauth-required", message: "access-ended" }), { status: "signin" });
  assert.deepEqual(cloudPlanSnapshot({ status: "unavailable", lastPlan: { tier: "pro", active: true } }), { status: "checking", tier: "pro" });
  assert.deepEqual(cloudPlanSnapshot({ ...account, entitlement: { ...account.entitlement, status: "inactive" } }), { status: "attention", tier: "max" });
  assert.deepEqual(cloudPlanSnapshot({ status: "signed-out" }), { status: "none" });
});
