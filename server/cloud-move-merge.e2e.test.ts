// Bring newer chats between two real servers over HTTP, driven by the desktop's own orchestrator (electron/cloud-move.mjs):
// This computer, and My Cloud, a Cloud home whose owner the test signs in as the Admin would. Each runs with a fresh HOME
// holding its OMB_DATA_DIR (a backup refuses a data folder that is its own HOME), a synthetic Claude CLI and no network.
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCloudMove } from "../electron/cloud-move.mjs";
import { activePath } from "./cloud-chat-merge.ts";
import { cloudPairingSignature } from "./cloud-home.ts";
import { RESTART_EXIT_CODE } from "./restart.ts";
import type { Message } from "./store.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0f1e2d3c4b5a.fly.dev";
const ORIGIN = `https://${HOST}`;
const MACHINE = "6a1f2e3d-4c5b-4a69-8778-9a0b1c2d3e4f";
const bootstrapSecret = randomBytes(32).toString("base64url");
const OFFLINE = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => new Response("offline fixture", { status: 503 });')}`;
// A 1×1 PNG.
const DOT = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

interface Fixture { name: string; home: string; dataDir: string; base: string; env: NodeJS.ProcessEnv; child?: ChildProcess; log: string; closing: boolean; boots: number; failure?: Error }
let desktop: Fixture;
let cloud: Fixture;
let scratch: string;
let owner: string;
const ids = { ava: "", main: "", doomed: "", desk: "", solo: "", routine: "" };

async function boot(fixture: Fixture): Promise<void> {
  const child = spawn(process.execPath, ["--import", OFFLINE, join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."), env: fixture.env, stdio: ["ignore", "pipe", "pipe"] });
  fixture.child = child;
  fixture.boots++;
  child.stdout?.on("data", (chunk) => { fixture.log += chunk; });
  child.stderr?.on("data", (chunk) => { fixture.log += chunk; });
  // The launcher: a copy restarts the server it went to, to install it.
  child.once("exit", (code) => { if (code === RESTART_EXIT_CODE && !fixture.closing && fixture.child === child) boot(fixture).catch((error: Error) => { fixture.failure = error; }); });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (fixture.closing || fixture.child !== child) return;
    if (child.exitCode !== null) throw new Error(`${fixture.name} exited:\n${fixture.log}`);
    try {
      const health = await (await fetch(`${fixture.base}/api/health`)).json() as { pid?: number };
      if (health.pid === child.pid) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`${fixture.name} did not start:\n${fixture.log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function launch(name: "desktop" | "cloud"): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), `omb-bring-${name}-`));
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  const cli = join(home, "fixture-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") {
  console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" }));
  process.exit(0);
}
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
    ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
    claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
  } }));
  const port = await freePortBlock([0, 1]);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
    ...(name === "cloud" ? { OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: MACHINE, OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
      OMB_CLOUD_BOOTSTRAP_SECRET: bootstrapSecret, OMB_PUBLIC_URL: ORIGIN } : {}),
  };
  const fixture: Fixture = { name, home, dataDir, base: `http://127.0.0.1:${port}`, env, log: "", closing: false, boots: 0 };
  await boot(fixture);
  return fixture;
}

const EDGE = { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };
async function onCloud(method: string, path: string, options: { body?: unknown; token?: string; remote?: boolean } = {}) {
  if (cloud.failure) throw cloud.failure;
  const response = await fetch(`${cloud.base}${path}`, { method, headers: {
    ...(options.remote || options.token ? EDGE : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
  }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}
async function onDesktop(method: string, path: string, body?: unknown, raw?: { bytes: Buffer; type: string }) {
  const url = desktop.base;
  const response = await fetch(`${url}${path}`, { method, headers: { origin: url,
    ...(raw ? { "content-type": raw.type } : body === undefined ? {} : { "content-type": "application/json" }) },
    body: raw ? raw.bytes : body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}
type Side = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
const desk: Side = (method, path, body) => onDesktop(method, path, body);
const home: Side = (method, path, body) => onCloud(method, path, { token: owner, body });

async function cloudGrant(): Promise<{ origin: string; code: string; expiresAt: number }> {
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${cloud.base}/api/cloud/pairing`, { method: "POST", body, headers: {
    ...EDGE, "content-type": "application/json", "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce,
    "x-omb-cloud-signature": `v1=${cloudPairingSignature(bootstrapSecret, timestamp, nonce, body)}`,
  } });
  const granted = await response.json() as { code: string; expiresAt: number };
  expect(response.status, JSON.stringify(granted)).toBe(200);
  return { origin: ORIGIN, code: granted.code, expiresAt: granted.expiresAt };
}
const myCloud = { id: "cloud", name: "My Cloud", origin: ORIGIN, kind: "cloud" as const, grant: cloudGrant };
function mover() {
  return createCloudMove({
    localRequest: (route, init) => fetch(`${desktop.base}${route}`, init),
    fetchImpl: ((url: string, init: RequestInit = {}) => fetch(String(url).replace(ORIGIN, cloud.base), { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), ...EDGE } })) as typeof fetch,
    tempRoot: join(scratch, "move-temp"),
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
    pollMs: 150, retryDelaysMs: [100, 300], restartTimeoutMs: 90_000,
  });
}
const why = (result: { error?: unknown }) => `${JSON.stringify(result.error ?? null)}\n${cloud.log.slice(-3000)}`;

async function until(what: string, check: () => Promise<boolean>, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const rowsOf = async (side: Side, threadId: string): Promise<Message[]> => (await side("GET", `/api/threads/${threadId}/messages?limit=500`)).body?.messages ?? [];
/** Says `text` in a conversation and waits until its bot has answered and every bot there is idle. */
async function say(side: Side, botId: string, threadId: string, text: string): Promise<void> {
  const sent = await side("POST", `/api/bots/${botId}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(`a reply to "${text}"`, async () => {
    const rows = await rowsOf(side, threadId);
    const asked = rows.findIndex((row) => row.role === "user" && row.text?.startsWith(text.split("\n")[0]!));
    return asked >= 0 && rows.slice(asked + 1).some((row) => row.role === "bot" && row.kind === "text");
  });
  await until("idle bots", async () => (await side("GET", "/api/bots")).body.bots.every((bot: { activity?: string }) => bot.activity !== "working"));
  // Distinct times for each side's turns, whatever the clock's resolution.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** Every message My Cloud holds, read from its database. */
function cloudRows(): Map<string, Message> {
  const db = new DatabaseSync(join(cloud.dataDir, "messages.db"), { readOnly: true });
  try {
    return new Map((db.prepare("SELECT thread_id, id, json FROM messages").all() as Array<{ thread_id: string; id: string; json: string }>)
      .map((row) => [`${row.thread_id}/${row.id}`, JSON.parse(row.json) as Message]));
  } finally { db.close(); }
}
const withoutLink = ({ parentId: _parentId, ...rest }: Message) => rest;
/** What a bring must never change: everything My Cloud holds besides chats, its bots' settings and the conversations it had. */
function untouched(added: string[] = []) {
  const hash = (path: string) => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
  const tree = (root: string): Record<string, string | null> => {
    const out: Record<string, string | null> = {};
    const walk = (dir: string, prefix: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        if (name.isDirectory()) walk(join(dir, name.name), `${prefix}${name.name}/`);
        else out[`${prefix}${name.name}`] = hash(join(dir, name.name));
      }
    };
    walk(root, "");
    return out;
  };
  const bots = (JSON.parse(readFileSync(join(cloud.dataDir, "bots.json"), "utf8")) as Array<Record<string, unknown>>).map(({ tasks, ...settings }) => ({
    settings, tasks: (tasks as Array<Record<string, unknown>>).filter((task) => !added.includes(task.threadId as string))
      .map(({ updatedAt: _u, lastThreadOrderAt: _o, ...task }) => task),
  }));
  return {
    bots, groups: JSON.parse(readFileSync(join(cloud.dataDir, "groups.json"), "utf8")),
    files: Object.fromEntries(["routines.json", "config.json", "webhooks.json", "calendar-calls.json", "lending-routines.json"].map((name) => [name, hash(join(cloud.dataDir, name))])),
    workspaces: tree(join(cloud.dataDir, "workspaces")), souls: tree(join(cloud.dataDir, "bots")),
  };
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "omb-bring-scratch-"));
  [desktop, cloud] = await Promise.all([launch("desktop"), launch("cloud")]);
  // This app's own session on My Cloud, as Open My Cloud makes it: the owner's.
  const paired = await onCloud("POST", "/api/auth/pair", { remote: true, body: { code: (await cloudGrant()).code } });
  expect(paired.status, JSON.stringify(paired.body)).toBe(200);
  owner = paired.body.token;

  // This computer before the copy: Ava's chat, a second conversation, a room and a routine that is on.
  const ava = await desk("POST", "/api/bots", { name: "Ava", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true });
  expect(ava.status, JSON.stringify(ava.body)).toBe(201);
  ids.ava = ava.body.bot.id; ids.main = ava.body.bot.threadId;
  await say(desk, ids.ava, ids.main, "Plan the launch party");
  const doomed = await desk("POST", `/api/bots/${ids.ava}/tasks`, { title: "Old notes" });
  expect(doomed.status).toBe(201);
  ids.doomed = doomed.body.task.threadId;
  await say(desk, ids.ava, ids.doomed, "Keep these notes");
  expect((await desk("POST", `/api/bots/${ids.ava}/tasks/${ids.main}`)).status).toBe(200);
  expect((await desk("POST", "/api/groups", { name: "Launch room", memberIds: [ids.ava] })).status).toBe(201);
  const routine = await desk("POST", "/api/routines", { name: "Weekly plan", prompt: "Plan the week.", botId: ids.ava, enabled: true,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
  expect(routine.status, JSON.stringify(routine.body)).toBe(201);
  ids.routine = routine.body.routine.id;

  const copied = await mover().move(myCloud);
  expect(copied, why(copied)).toMatchObject({ phase: "done", action: "move" });
  expect((await home("GET", "/api/bots")).body.bots.map((bot: { id: string }) => bot.id)).toContain(ids.ava);

  // Then both went on. My Cloud: the old conversation deleted there, a line in Ava's chat and a conversation of its own.
  expect((await home("POST", `/api/bots/${ids.ava}/tasks/delete`, { threadIds: [ids.doomed] })).body.deleted).toEqual([ids.doomed]);
  await say(desk, ids.ava, ids.main, "Desktop line one");
  await say(home, ids.ava, ids.main, "Cloud line");
  await say(desk, ids.ava, ids.main, "Desktop line two");
  const own = await home("POST", `/api/bots/${ids.ava}/tasks`, { title: "Cloud plan" });
  await say(home, ids.ava, own.body.task.threadId, "Only on My Cloud");
  expect((await home("POST", `/api/bots/${ids.ava}/tasks/${ids.main}`)).status).toBe(200);
  // This computer: a new conversation with a picture, and a bot My Cloud never had.
  const picture = await onDesktop("POST", "/api/attachments", undefined, { bytes: DOT, type: "image/png" });
  expect(picture.status, JSON.stringify(picture.body)).toBe(201);
  const plan = await desk("POST", `/api/bots/${ids.ava}/tasks`, { title: "Desk plan" });
  ids.desk = plan.body.task.threadId;
  await say(desk, ids.ava, ids.desk, `Look at this\n\n<attached-image path="${picture.body.path}" name="dot.png" />`);
  const solo = await desk("POST", "/api/bots", { name: "Only here", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true });
  ids.solo = solo.body.bot.threadId;
  await say(desk, solo.body.bot.id, ids.solo, "A bot only this computer has");
}, 240_000);

afterAll(async () => {
  for (const fixture of [desktop, cloud]) {
    if (!fixture) continue;
    fixture.closing = true;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
  }
  for (const directory of [desktop?.home, cloud?.home, scratch]) if (directory) await removeTempDir(directory);
  const failed = [desktop, cloud].find((fixture) => fixture?.failure);
  if (failed) throw failed.failure;
}, 60_000);

it("brings this computer's newer chats into My Cloud: the union, in time order, with nothing there changed or removed, and nothing the second time", async () => {
  const before = cloudRows(), kept = untouched(), boots = cloud.boots;
  const desktopMain = await rowsOf(desk, ids.main), desktopNew = await rowsOf(desk, ids.desk);

  const result = await mover().bring(myCloud);
  expect(result, why(result)).toMatchObject({ phase: "done", action: "bring", destination: { id: "cloud", origin: ORIGIN },
    brought: { conversations: 1, skippedBots: 1, skippedRooms: 0, deleted: 1 } });
  const brought = result.brought!;
  const text = (rows: Message[]) => rows.filter((row) => row.kind === "text" && !before.has(`${ids.main}/${row.id}`)).length;
  expect(brought.intoExisting).toBe(text(desktopMain));
  expect(brought.messages).toBe(brought.intoExisting + desktopNew.filter((row) => row.kind === "text").length);
  expect(cloud.boots, "My Cloud did not restart").toBe(boots);

  // The union: every message of both, and Ava's chat reads in the order it was said.
  const after = cloudRows();
  for (const row of desktopMain) expect(after.has(`${ids.main}/${row.id}`), row.text).toBe(true);
  for (const row of desktopNew) expect(after.has(`${ids.desk}/${row.id}`), row.text).toBe(true);
  const main = await rowsOf(home, ids.main);
  const leaf = (await home("GET", `/api/threads/${ids.main}/messages?limit=500`)).body.activeLeafId as string;
  const said = activePath(main.map((row) => ({ ...row, parentId: after.get(`${ids.main}/${row.id}`)!.parentId })), leaf)
    .filter((row) => row.role === "user").map((row) => row.text);
  expect(said).toEqual(["Plan the launch party", "Desktop line one", "Cloud line", "Desktop line two"]);
  // Nothing My Cloud had changed or went: only the link of the one line that now follows this computer's.
  const relinked = [...before].filter(([key, row]) => after.get(key)?.parentId !== row.parentId).map(([, row]) => row.text);
  for (const [key, row] of before) expect(withoutLink(after.get(key)!), key).toEqual(withoutLink(row));
  expect(relinked).toEqual(["Cloud line"]);
  expect(untouched([ids.desk])).toEqual(kept);
  expect(JSON.parse(readFileSync(join(cloud.dataDir, "routines.json"), "utf8")).routines.find((one: { id: string }) => one.id === ids.routine)).toMatchObject({ enabled: false });

  // The new conversation, under Ava, with its picture in My Cloud's own folder.
  const tasks = (await home("GET", "/api/bots")).body.bots.find((bot: { id: string }) => bot.id === ids.ava).tasks as Array<{ threadId: string; title: string }>;
  expect(tasks.find((task) => task.threadId === ids.desk)).toMatchObject({ title: "Desk plan" });
  expect(tasks.some((task) => task.threadId === ids.doomed), "a conversation deleted on My Cloud stays deleted").toBe(false);
  expect([...after.keys()].some((key) => key.startsWith(`${ids.doomed}/`) || key.startsWith(`${ids.solo}/`))).toBe(false);
  const asked = (await rowsOf(home, ids.desk)).find((row) => row.role === "user")!;
  const name = (desktopNew.find((row) => row.id === asked.id)!.attachments?.[0]?.path ?? /path="([^"]+)"/.exec(asked.text ?? "")![1]!).split(/[\\/]/).pop()!;
  const stored = JSON.stringify(after.get(`${ids.desk}/${asked.id}`));
  expect(stored).toContain(join(cloud.dataDir, "attachments", name).replaceAll("\\", "\\\\"));
  expect(stored).not.toContain(desktop.dataDir.replaceAll("\\", "\\\\"));
  expect(readFileSync(join(cloud.dataDir, "attachments", name)).equals(DOT)).toBe(true);
  expect(readdirSync(join(cloud.dataDir, ".backups")).filter((entry) => /^[0-9a-f-]{36}$/.test(entry))).toEqual([]);
  expect(existsSync(join(cloud.dataDir, ".backups", "cloud-move", "upload.json"))).toBe(false);

  const again = await mover().bring(myCloud);
  expect(again, why(again)).toMatchObject({ phase: "done", brought: { conversations: 0, messages: 0, intoExisting: 0, deleted: 1 } });
  expect(cloudRows()).toEqual(after);
  expect(untouched([ids.desk])).toEqual(kept);
}, 240_000);

it("only the owner's own app can bring chats: My Cloud opens no other kind of session, and refuses a process on the machine", async () => {
  const ask = { sha256: "a".repeat(64), password: "fixture password 123" };
  // A personal Cloud pairs nothing but its owner's devices, so no phone or guest session can ask.
  expect(await home("POST", "/api/auth/pairing", { scopes: ["client"], label: "Phone" })).toMatchObject({ status: 403, body: { code: "cloud_personal" } });
  const rows = cloudRows(), kept = untouched([ids.desk]);
  expect((await onCloud("POST", "/api/cloud-move/merge", { body: ask })).status, "a bot's shell, bare loopback").toBe(403);
  expect([401, 403]).toContain((await onCloud("POST", "/api/cloud-move/merge", { remote: true, body: ask })).status);
  expect([401, 403]).toContain((await onCloud("POST", "/api/cloud-move/merge", { token: "omb_sess_forged", body: ask })).status);
  const refused = await mover().bring({ ...myCloud, grant: async () => ({ origin: ORIGIN, code: "NOT-AN-OWNER-CODE", expiresAt: Date.now() + 60_000 }) });
  expect(refused).toMatchObject({ phase: "failed", action: "bring", error: { code: "cloud_unavailable" } });
  expect(cloudRows()).toEqual(rows);
  expect(untouched([ids.desk])).toEqual(kept);
}, 120_000);
