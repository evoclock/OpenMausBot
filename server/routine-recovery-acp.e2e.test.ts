// An independent ACP recovery case runs in its own Vitest shard rather than
// extending every other routine recovery case in one file.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

let fixture: VerificationServer | undefined;
let restarted: ChildProcess | undefined;
afterEach(async () => {
  await waitForExit(restarted, { signal: "SIGTERM" });
  await fixture?.close();
  fixture = restarted = undefined;
});

it("keeps an ACP engine's run that a graceful shutdown cut off, and starts it once more on the next start", async () => {
  fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["cline"]);
  const { url, dataDir, logPath } = fixture.info;
  const configPath = join(dataDir, "config.json");
  const acpMode = (mode: string) => {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.cline.environment.FAKE_ACP_MODE = mode;
    writeFileSync(configPath, JSON.stringify(config));
  };
  const restart = async () => {
    const env = verificationServerEnvironment({}, dataDir, Number(new URL(url).port));
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, verificationServerArgs(env), { cwd: process.cwd(), env, stdio: ["ignore", log, log] });
    closeSync(log);
    await expect.poll(async () => { try { return (await fetch(`${url}/api/health`)).ok; } catch { return false; } }, { timeout: hostTimeout(30_000) }).toBe(true);
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => (await fetch(url + path, {
    method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })).json() as Promise<any>;
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  acpMode("hang");
  await restart();
  const { bot } = await cli("new-bot", "--name", "Inbox bot");
  await cli("set-model", "--bot", bot.id, "--instance", "cline", "--model", "cline-default");
  const { routine } = await api("POST", "/api/routines", { name: "Inbox brief", prompt: "Summarise my inbox.", botId: bot.id,
    schedule: { type: "cron", expression: "0 7 * * *", timeZone: "Europe/London" } });
  const { run } = await api("POST", `/api/routines/${routine.id}/run`);
  const read = async () => ((await api("GET", "/api/routines").catch(() => ({ runs: [] }))).runs as any[]).find((candidate) => candidate.id === run.id);
  await expect.poll(async () => (await read())?.status, { timeout: hostTimeout(15_000) }).toBe("running");
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  await waitForExit(restarted, { signal: "SIGTERM" });
  expect(JSON.parse(readFileSync(join(dataDir, "routines.json"), "utf8")).runs).toMatchObject([{ id: run.id, status: "running" }]);
  acpMode("happy");
  await restart();
  await expect.poll(async () => (await read())?.status, { timeout: hostTimeout(60_000) }).toBe("completed");
  expect(await read()).toMatchObject({ retried: "restarted" });
}, hostTimeout(120_000));
