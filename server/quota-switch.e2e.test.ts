// The fake CLI plays the frames Claude Code 2.1.295 sent past its weekly limit.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { freePortBlock } from "./testing/ports.ts";

const LIMITED = "Limited Claude";
const BACKUP = "Backup Claude";
const FAKE_CLI = fileURLToPath(new URL("./testing/fake-claude-cli.ts", import.meta.url));
const jsonLines = (path: string): any[] => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

async function withQuotaFixture(
  options: { env?: Record<string, string> },
  check: (fixture: {
    api: (method: string, path: string, body?: unknown) => Promise<any>;
    control: (...args: string[]) => Promise<any>;
    respond: (threadId: string, body: unknown) => Promise<{ status: number; body: any }>;
    backupPrompts: () => any[];
    dataDir: string;
  }) => Promise<void>,
) {
  const port = await freePortBlock([0, 1]);
  const url = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), "openmausbot-quota-switch-"));
  mkdirSync(join(dataDir, "tmp"), { recursive: true });
  const evidenceDir = join(tmpdir(), "openmausbot-verification-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const logPath = join(evidenceDir, `quota-switch-${Date.now()}-${process.pid}.log`);
  const backupFile = join(dataDir, "backup-prompts.jsonl");
  const engine = (displayName: string, environment: Record<string, string>) =>
    ({ driver: "claudeAgent", displayName, config: { cli: FAKE_CLI }, environment });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      claude: engine(LIMITED, { FAKE_CLAUDE_MODE: "usage-limit" }),
      backup: engine(BACKUP, { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_PROMPTS: backupFile, FAKE_CLAUDE_TOOL_CALLS: "[]" }),
    },
  }));
  const evidence: unknown[] = [{ url, options }];
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  /** A card answer as a client posts it, with the status it got. */
  const respond = async (threadId: string, body: unknown) => {
    const response = await fetch(`${url}/api/threads/${threadId}/respond`, {
      method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    const answer = { status: response.status, body: await response.json() };
    evidence.push({ respond: body, answer });
    return answer;
  };
  try {
    const env = { ...verificationServerEnvironment({}, dataDir, port), ...options.env };
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, verificationServerArgs(env), {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 90_000 }).toBe(true);
    await check({ api, control, respond, backupPrompts: () => jsonLines(backupFile), dataDir });
  } finally {
    evidence.push({ backupPrompts: jsonLines(backupFile), roots: readHandoffs(dataDir) });
    const evidencePath = `${logPath}.quota-switch.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await removeTempDir(dataDir);
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}

/** A bot whose conversation runs on the limited engine, and the turn that
 * meets the limit. */
async function meetTheLimit(api: (method: string, path: string, body?: unknown) => Promise<any>, control: (...args: string[]) => Promise<any>, text: string) {
  const { bot } = await control("new-bot", "--name", "Out of quota");
  const threadId = bot.activeTaskId as string;
  const limited = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).modelSelection;
  await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: { ...limited, instanceId: "claude" }, updateBotDefault: true });
  await control("send", "--bot", bot.id, "--task", threadId, "--text", text);
  expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("failed");
  const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const state = async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
  return { bot, threadId, messages, state };
}

it("offers the working engine once, and on the person's answer switches this conversation and resends the exact message", async () => {
  await withQuotaFixture({}, async ({ api, control, respond, backupPrompts, dataDir }) => {
    const text = "SUMMARISE_THE_QUARTER_4K";
    const { bot, threadId, messages, state } = await meetTheLimit(api, control, text);
    const { task: sibling } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Sibling keeps its engine" });

    // One account of the failure, and one offer: the engine that works, by name.
    await expect.poll(async () => (await messages()).filter((message) => message.card?.quotaSwitch).length, { timeout: 20_000 }).toBe(1);
    const before = await messages();
    const failures = before.filter((message) => message.tool?.name?.startsWith("error:"));
    expect(failures).toHaveLength(1);
    expect(failures[0].tool.name).toMatch(/This Claude account has reached its usage limit/);
    const offer = before.find((message) => message.card?.quotaSwitch);
    expect(offer.card).toMatchObject({
      title: `${LIMITED} is out of quota`,
      subtitle: "Continue this conversation on another engine?",
      options: [BACKUP, "Not now"],
      fixedOptions: true,
      quotaSwitch: { engines: [{ instanceId: "backup", name: BACKUP }], messageId: before.find((message) => message.role === "user").id },
    });
    expect(offer.card.tool).toBeUndefined();
    // Nothing moved without the answer: same engine, the failed turn's root settled, nothing else begun.
    expect((await state()).tasks.find((task: any) => task.threadId === threadId)).toMatchObject({ busy: false });
    expect((await state()).modelSelection.instanceId).toBe("claude");
    expect(backupPrompts()).toHaveLength(0);
    const rootsBefore = readHandoffs(dataDir).filter((node) => node.threadId === threadId);
    expect(rootsBefore.map((node) => [node.status, node.outcome, node.executions])).toEqual([["failed", "provider_error", 1]]);
    // The card names that root: the answer asks the runtime about the request that ran out, not about the thread.
    expect(offer.card.quotaSwitch.rootId).toBe(rootsBefore[0]!.id);

    expect(await respond(threadId, { requestId: offer.card.requestId, behavior: "answer", message: BACKUP }))
      .toEqual({ status: 200, body: { ok: true, outcome: "answered" } });
    await expect.poll(() => backupPrompts().length, { timeout: 20_000 }).toBe(1);
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");

    const after = await messages();
    // The message whose turn failed, sent once more: twice in the conversation, once to the engine that works.
    expect(after.filter((message) => message.role === "user" && message.text === text)).toHaveLength(2);
    expect(backupPrompts()).toHaveLength(1);
    expect(JSON.stringify(backupPrompts()[0])).toContain(text);
    expect(after.findLast((message) => message.role === "bot" && message.kind === "text")).toMatchObject({ text: "hello from fake claude", turnSucceeded: true });
    expect(after.filter((message) => message.tool?.name === `notice: continuing on ${BACKUP} after hitting quota`)).toHaveLength(1);
    // Settled only once the switch went through, inside the answer's own request: so who answered is on the card.
    expect(after.find((message) => message.id === offer.id).card).toMatchObject({ answered: "answer", answeredText: BACKUP, answeredBy: { kind: "loopback" } });
    expect(after.filter((message) => message.card?.quotaSwitch)).toHaveLength(1);
    expect(after.filter((message) => message.tool?.name?.startsWith("error:"))).toHaveLength(1);

    // This conversation moved; the bot's own engine and its other conversation did not.
    const bots = await state();
    const instances = (await api("GET", "/api/instances")).instances as any[];
    expect(bots.tasks.find((task: any) => task.threadId === threadId)).toMatchObject({
      modelSelection: { instanceId: "backup", model: instances.find((instance) => instance.instanceId === "backup").models.default }, busy: false,
    });
    expect(bots.modelSelection.instanceId).toBe("claude");
    expect(bots.tasks.find((task: any) => task.threadId === sibling.threadId).modelSelection?.instanceId ?? bots.modelSelection.instanceId).toBe("claude");

    // No job twice: the failed turn's root stayed settled, and the resend is one new root that completed.
    const roots = readHandoffs(dataDir).filter((node) => node.threadId === threadId);
    expect(roots.map((node) => [node.status, node.executions])).toEqual([["failed", 1], ["completed", 1]]);
    expect(roots[0]!.id).toBe(rootsBefore[0]!.id);

    // A second press on the settled card is refused as already answered: it
    // switches nothing, and its words never reach the bot as a message.
    const again = await respond(threadId, { requestId: offer.card.requestId, behavior: "answer", message: BACKUP });
    expect(again).toEqual({ status: 409, body: { error: "this question has already been answered" } });
    expect((await messages()).filter((message) => message.role === "user")).toHaveLength(2);
    expect(backupPrompts()).toHaveLength(1);
    expect(readHandoffs(dataDir).filter((node) => node.threadId === threadId)).toHaveLength(2);
  });
}, 240_000);

it.each([
  { name: "Not now", behavior: "answer", message: "Not now", outcome: "answered" },
  { name: "typed words that name no offered engine", behavior: "answer", message: "use whichever is fastest", outcome: "answered" },
  // Decline-only service trust (hosted, Cloud home, OMB_LOOPBACK_TRUST=service): a decline naming an engine chooses nothing.
  { name: "a decline that carries the offered engine's label", behavior: "deny", message: BACKUP, outcome: "rejected" },
  { name: "an allow that carries the offered engine's label", behavior: "allow", message: BACKUP, outcome: "rejected" },
])("changes nothing on $name", async ({ behavior, message, outcome }) => {
  await withQuotaFixture({}, async ({ api, control, respond, backupPrompts, dataDir }) => {
    const text = "LEAVE_THIS_WHERE_IT_IS_7M";
    const { threadId, messages, state } = await meetTheLimit(api, control, text);
    await expect.poll(async () => (await messages()).filter((entry) => entry.card?.quotaSwitch).length, { timeout: 20_000 }).toBe(1);
    const offer = (await messages()).find((entry) => entry.card?.quotaSwitch);

    expect(await respond(threadId, { requestId: offer.card.requestId, behavior, message }))
      .toEqual({ status: 200, body: { ok: true, outcome } });

    const after = await messages();
    expect(after.find((entry) => entry.id === offer.id).card).toMatchObject({ answered: "answer", answeredText: "Not now" });
    expect(after.filter((entry) => entry.role === "user")).toHaveLength(1);
    expect(after.some((entry) => entry.tool?.name?.startsWith("notice:"))).toBe(false);
    expect((await state()).tasks.find((task: any) => task.threadId === threadId)).toMatchObject({ busy: false });
    expect((await state()).modelSelection.instanceId).toBe("claude");
    // Nothing was switched and nothing was sent again: asked once more, the settled
    // card is refused, and the working engine was never run.
    expect(await respond(threadId, { requestId: offer.card.requestId, behavior: "answer", message: BACKUP }))
      .toEqual({ status: 409, body: { error: "this question has already been answered" } });
    expect((await state()).tasks.find((task: any) => task.threadId === threadId).modelSelection?.instanceId ?? "claude").toBe("claude");
    expect(backupPrompts()).toHaveLength(0);
    expect(readHandoffs(dataDir).filter((node) => node.threadId === threadId).map((node) => node.status)).toEqual(["failed"]);
  });
}, 240_000);

it("raises no card when OMB_QUOTA_SWITCH=0 switches it off", async () => {
  await withQuotaFixture({ env: { OMB_QUOTA_SWITCH: "0" } }, async ({ api, control, backupPrompts }) => {
    const { bot, threadId, messages } = await meetTheLimit(api, control, "NO_OFFER_WHEN_OFF_2B");
    // A second failed turn is the event that proves the first one's offer was never coming.
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "STILL_NO_OFFER_3C");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("failed");
    const after = await messages();
    expect(after.filter((message) => message.tool?.name?.startsWith("error:"))).toHaveLength(2);
    expect(after.some((message) => message.kind === "options")).toBe(false);
    expect(backupPrompts()).toHaveLength(0);
  });
}, 240_000);
