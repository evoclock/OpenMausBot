import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { RunContractStore } from "./run-contract.ts";
import { openDurableDriver as openTestDurableDriver } from "./testing/fake-durable-driver.ts";
import { SessionStatusFeed } from "./session-status-feed.ts";
import { scheduledCodingRunId } from "./run-triggers.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const serverDir = dirname(fileURLToPath(import.meta.url));
const root = join(serverDir, "..");
const fakePi = join(serverDir, "testing", "fake-pi-cli.ts");

async function fixture(mode: "coding" | "happy" | "permission" | "coding-denied" | "coding-hold" | "drill", localOnly = false) {
  const cache = join(root, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const home = mkdtempSync(join(cache, "coding-production-"));
  const dataDir = join(home, ".openmausbot");
  const bin = join(home, "bin");
  const repository = join(home, "repository");
  const leased = join(home, "leased");
  const state = join(home, "treehouse.json");
  const calls = join(home, "treehouse-calls.jsonl");
  const dump = join(home, "pi-turns.jsonl");
  const rolesFilePath = join(home, "pstack-model-roles.v1.json");
  writeFileSync(rolesFilePath, JSON.stringify({ schema: "pstack-model-roles.v1", roles: {
    development: "fixture/development", "independent-review": "fixture/review",
  } }));
  mkdirSync(dataDir);
  mkdirSync(bin);
  mkdirSync(repository);
  mkdirSync(join(home, "static"));
  writeFileSync(join(home, "static", "index.html"), "<html>fixture</html>");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git(repository, "init", "-b", "main");
  writeFileSync(join(repository, "README.md"), "isolated coding fixture\n");
  git(repository, "add", "README.md");
  git(repository, "-c", "user.name=evoclock", "-c", `user.email=${mode === "drill" ? "52983349+evoclock@users.noreply.github.com" : "evoclock@users.noreply.github.com"}`, "commit", "-m", "Fixture base");
  if (mode === "drill") {
    git(repository, "init", "--bare", join(home, "destination.git"));
    git(repository, "remote", "add", "origin", "git@github.com:fixture/agents.git");
    git(repository, "push", join(home, "destination.git"), "main");
  } else git(repository, "remote", "add", "origin", "git@github.com:fixture/agents.git");
  git(repository, "worktree", "add", "--detach", leased, "main");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node\nconst a=process.argv.slice(2);\nif(a.join(' ') !== 'repo view fixture/agents --json nameWithOwner,isPrivate,viewerPermission') process.exit(2);\nconsole.log(JSON.stringify({nameWithOwner:'fixture/agents',isPrivate:true,viewerPermission:'WRITE'}));\n`, { mode: 0o755 });
  writeFileSync(state, JSON.stringify({ holder: null }));
  writeFileSync(join(bin, "treehouse"), `#!/usr/bin/env node\nimport {appendFileSync,readFileSync,writeFileSync} from 'node:fs';\nimport {execFileSync} from 'node:child_process';\nconst a=process.argv.slice(2), file=${JSON.stringify(state)}, log=${JSON.stringify(calls)}, path=${JSON.stringify(leased)};\nconst s=JSON.parse(readFileSync(file,'utf8'));\nappendFileSync(log,JSON.stringify(a)+'\\n');\nconst git=(...args)=>execFileSync('git',args,{cwd:path,encoding:'utf8'}).trim();\nif(a[0]==='status') console.log(JSON.stringify(s.holder?[{path,status:'leased',lease_id:'fixture-lease',lease_holder:s.holder}]:[]));\nelse if(a[0]==='get' && a.includes('--lease') && a[a.indexOf('--base')+1]==='main') {\n  const branch=a.includes('--branch')?a[a.indexOf('--branch')+1]:'';\n  if(branch){\n    try { git('rev-parse','--verify','refs/heads/'+branch); git('switch',branch); }\n    catch { git('switch','-c',branch); }\n    const head=git('rev-parse','HEAD');\n    git('update-ref','refs/remotes/origin/'+branch,head);\n    git('branch','--set-upstream-to','origin/'+branch,branch);\n  }\n  s.holder=a[a.indexOf('--lease-holder')+1]; writeFileSync(file,JSON.stringify(s)); console.log(JSON.stringify({path,lease_id:'fixture-lease'}));\n} else if(a[0]==='return' && a[a.indexOf('--if-lease-id')+1]==='fixture-lease' && a[a.indexOf('--if-lease-holder')+1]===s.holder) {\n  s.holder=null; writeFileSync(file,JSON.stringify(s));\n} else process.exit(2);\n`, { mode: 0o755 });
  chmodSync(fakePi, 0o755);
  const configFile = join(dataDir, "config.json");
  const config = { instances: { pi: { driver: "piAgent", environment: { FAKE_PI_MODE: mode, FAKE_PI_DUMP: dump, FAKE_PI_MODELS: localOnly ? "dsf41/deepseek-v4.1-flash-tf" : "openai/gpt-5.4-mini,openai-codex/gpt-6-luna",
    FAKE_PI_DRILL_REVIEW_MARKER: join(home, "review-started.json"), FAKE_PI_SCOPE_ACK: "1" },
    config: { cli: fakePi, fullAuto: false } } } };
  writeFileSync(configFile, JSON.stringify(config));
  const reservePort = async () => {
    const listener = createServer();
    await new Promise<void>((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("fixture port was not assigned");
    return { port: address.port, release: () => new Promise<void>((resolve) => listener.close(() => resolve())) };
  };
  const mainPort = await reservePort();
  const webhookPort = await reservePort();
  const port = mainPort.port;
  const base = `http://127.0.0.1:${port}`;
  const env = { HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(webhookPort.port), OMB_STATIC_DIR: join(home, "static"), NODE_ENV: "test",
    OMB_TEST_DRIVER_RUN_API_MODULE: pathToFileURL(join(serverDir, "testing", "fake-durable-driver.ts")).href,
    PATH: `${bin}:${process.env.PATH ?? ""}` };
  let child: ChildProcess | undefined;
  let stderr = "";
  let reserved = true;
  const start = async () => {
    if (reserved) {
      await Promise.all([mainPort.release(), webhookPort.release()]);
      reserved = false;
    }
    child = spawn(process.execPath, ["--experimental-strip-types", join(serverDir, "index.ts")], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    await until(async () => {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) });
      return res.ok && (await res.json() as { pid: number }).pid === child?.pid;
    }, "server health");
  };
  const stop = async () => { await waitForExit(child, { signal: "SIGTERM" }); child = undefined; };
  const kill = async () => { await waitForExit(child, { signal: "SIGKILL" }); child = undefined; };
  const until = async (check: () => Promise<boolean>, label: string) => {
    for (let i = 0; i < 300; i++) {
      if (child?.exitCode !== null) throw new Error(`server exited during ${label}: ${stderr.slice(-4000)}`);
      try { if (await check()) return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${label}: ${stderr.slice(-4000)}`);
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
    return value;
  };
  return { home, dataDir, repository, leased, state, calls, dump, configFile, config, rolesFilePath, port,
    webhookPort: webhookPort.port, git, start, stop, kill, until, api,
    logs: () => stderr };
}

test("parallel composed fixtures bind distinct OS-assigned listener ports", async () => {
  const [first, second] = await Promise.all([fixture("happy"), fixture("happy")]);
  try {
    expect(new Set([first.port, first.webhookPort, second.port, second.webhookPort]).size).toBe(4);
    await Promise.all([first.start(), second.start()]);
    const [left, right] = await Promise.all([first.api("GET", "/api/health"), second.api("GET", "/api/health")]);
    expect(left.pid).not.toBe(right.pid);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
    await Promise.all([removeTempDir(first.home), removeTempDir(second.home)]);
  }
}, 90_000);

test.each([
  { mode: "coding" as const, expected: "done", released: false, localOnly: false },
  { mode: "coding" as const, expected: "done", released: false, localOnly: true },
  { mode: "happy" as const, expected: "blocked", released: true, localOnly: false },
  { mode: "permission" as const, expected: "blocked", released: true, localOnly: false },
  { mode: "coding-denied" as const, expected: "blocked", released: true, localOnly: false },
])("composed scheduled coding run uses Pi turns and %s workspace reconciliation", async ({ mode, expected, released, localOnly }) => {
  const f = await fixture(mode, localOnly);
  try {
    await f.start();
    const origin = (await f.api("POST", "/api/bots", { name: "Request owner" })).bot;
    const worker = (await f.api("POST", "/api/bots", { name: "Coding worker" })).bot;
    const reviewer = (await f.api("POST", "/api/bots", { name: "Independent reviewer" })).bot;
    await f.api("PATCH", `/api/bots/${origin.id}`, { approvalMode: "ask" });
    for (const bot of [worker, reviewer]) {
      await f.api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask", modelSelection: { instanceId: "pi",
        model: localOnly ? "dsf41/deepseek-v4.1-flash-tf" : "openai/gpt-5.4-mini" } });
    }
    const routine = (await f.api("POST", "/api/routines", {
      name: "Scheduled coding fixture", prompt: "Complete fixture coding task", botId: origin.id,
      schedule: { type: "once", at: Date.now() + 3_600_000 },
    })).routine;
    await f.stop();
    writeFileSync(f.configFile, JSON.stringify({ ...f.config, codingRuns: { repositoryRoot: f.repository, rolesFilePath: f.rolesFilePath,
      bots: { [origin.id]: { maxWallTimeMs: 120_000 } }, registrations: [{
      routineId: routine.id, workerBotId: worker.id, reviewerBotId: reviewer.id,
      developmentRole: "fixture/development", reviewRole: "fixture/review", repository: "fixture/agents", ref: "main",
      successCriteria: ["coding-fixture-result.txt exists"], checkCommand: ["node", "-e", "process.exit(0)"],
    }] } }));
    const routinesFile = join(f.dataDir, "routines.json");
    const saved = JSON.parse(readFileSync(routinesFile, "utf8"));
    const due = Date.now() - 1000;
    const scheduled = saved.routines.find((entry: { id: string }) => entry.id === routine.id);
    scheduled.schedule.at = due;
    scheduled.nextRunAt = due;
    writeFileSync(routinesFile, JSON.stringify(saved));
    await f.start();
    await f.until(async () => {
      const runs = (await f.api("GET", "/api/routines")).runs as Array<{ routineId: string; status: string }>;
      return runs.some((run) => run.routineId === routine.id && ["completed", "failed"].includes(run.status));
    }, "scheduled coding result");
    const run = (await f.api("GET", "/api/routines")).runs.find((entry: { routineId: string }) => entry.routineId === routine.id);
    expect(run.triggerSource).toBe("schedule");
    expect(run.status, JSON.stringify(run)).toBe(mode === "coding" ? "completed" : "failed");
    const workers = (await f.api("GET", "/api/bots")).bots;
    const workerTask = workers.find((bot: { id: string }) => bot.id === worker.id).tasks.find((task: { title: string }) => task.title.startsWith("Coding "));
    expect(workerTask?.cwd).toBe(f.leased);
    expect(workerTask?.approvalMode).toBe("full");
    expect(workerTask?.autoApprove).toBe(false);
    const reviewTask = workers.find((bot: { id: string }) => bot.id === reviewer.id).tasks
      .find((task: { title: string }) => task.title.startsWith("Coding "));
    if (mode === "coding") {
      expect(reviewTask?.cwd).toBe(f.leased);
      expect(reviewTask?.approvalMode).toBe("full");
      expect(reviewTask?.autoApprove).toBe(false);
    } else {
      expect(reviewTask).toBeUndefined();
    }
    const turns = readFileSync(f.dump, "utf8").trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      cwd: string; isTurnSpawn: boolean; argv: string[]; uiResponse?: { value?: string };
      mcpConfig?: { toolScope?: { allow?: string[] }; codingRun?: { id?: string } };
    }>;
    if (mode === "permission" || mode === "coding-denied") {
      expect(turns.some((turn) => turn.uiResponse)).toBe(false);
      const messages = (await f.api("GET", `/api/threads/${workerTask.threadId}/messages?limit=100`)).messages as Array<{ card?: unknown }>;
      expect(messages.some((message) => message.card)).toBe(false);
    }
    expect(turns.some((turn) => turn.isTurnSpawn && turn.cwd === f.leased)).toBe(true);
    for (const turn of turns.filter((item) => item.isTurnSpawn && item.cwd === f.leased)) {
      expect(turn.mcpConfig?.toolScope?.allow).toEqual(["native:read", "native:write", "native:edit", "native:coding_command"]);
      // Worker and reviewer share the bare run id; a `review:` prefix fails the closed profile and kills Pi.
      expect(turn.mcpConfig?.codingRun?.id).toBe(scheduledCodingRunId(run));
    }
    const operations = readFileSync(f.calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(operations.some((operation) => operation[0] === "get")).toBe(true);
    const returns = operations.filter((operation) => operation[0] === "return");
    expect(returns).toHaveLength(released ? 1 : 0);
    if (released) {
      expect(returns[0]).toContain("--if-lease-id");
      expect(returns[0]).toContain("--if-lease-holder");
    }
    expect(JSON.parse(readFileSync(f.state, "utf8")).holder === null).toBe(released);
    if (mode === "coding") {
      const runs = new RunContractStore(join(f.dataDir, "coding-run", "runtime.db"));
      try {
        const snapshot = runs.get(scheduledCodingRunId(run));
        expect(snapshot?.contract.limits?.maxSpendUsd).toBeUndefined();
        expect(snapshot?.modelsUsed).toEqual(Array.from({ length: 2 }, () => ({ iteration: 1,
          instanceId: "pi", model: localOnly ? "dsf41/deepseek-v4.1-flash-tf" : "openai-codex/gpt-6-luna" })));
      } finally { runs.close(); }
      expect(existsSync(join(f.leased, "coding-fixture-result.txt"))).toBe(true);
      expect(turns.filter((turn) => turn.isTurnSpawn && turn.cwd === f.leased)).toHaveLength(2);
    } else {
      expect(turns.filter((turn) => turn.isTurnSpawn && turn.cwd === f.leased)).toHaveLength(1);
    }
    const ownerMessages = (await f.api("GET", `/api/threads/${run.threadId}/messages?limit=100`)).messages as Array<{
      role: string; text?: string; turnId?: string;
    }>;
    expect(ownerMessages.filter((message) => message.turnId?.startsWith("coding-result:") &&
      message.text?.includes(`Coding run ${expected}:`))).toHaveLength(1);
    if (mode === "coding") expect(ownerMessages.find((message) => message.turnId?.startsWith("coding-result:"))?.text)
      .toContain("No authorized Git destination was configured");
    const workerMessages = (await f.api("GET", `/api/threads/${workerTask.threadId}/messages?limit=100`)).messages as Array<{
      role: string; text?: string; turnTerminal?: boolean;
    }>;
    if (mode !== "permission" && mode !== "coding-denied") expect(workerMessages.some((message) => message.role === "bot" && message.turnTerminal &&
      message.text === (mode === "coding" ? "Coding fixture committed" : "Hello from pi"))).toBe(true);
    if (mode === "permission" || mode === "coding-denied") {
      expect(workerMessages.some((message) => message.text === "ok")).toBe(false);
      expect(existsSync(join(f.leased, "coding-fixture-result.txt"))).toBe(false);
    }
    if (mode === "permission" || mode === "coding-denied") {
      const feed = new SessionStatusFeed(join(f.dataDir, "session-status.sqlite"));
      try {
        const notices = feed.pendingWakes().filter((wake) => wake.sessionId === scheduledCodingRunId(run));
        expect(notices).toHaveLength(1);
        expect(notices[0]?.kind).toBe("completion");
        expect(notices[0]?.detail).toContain(mode === "permission" ? "Run bash" : "bash");
        expect(feed.latest().find((record) => record.sessionId === scheduledCodingRunId(run))?.state).toBe("failed");
      } finally { feed.close(); }
    }
    if (mode === "permission") {
      await f.api("POST", `/api/bots/${worker.id}/messages`, { threadId: worker.threadId, text: "Interactive question" });
      await f.until(async () => {
        const messages = (await f.api("GET", `/api/threads/${worker.threadId}/messages?limit=100`)).messages as Array<{ card?: unknown }>;
        return messages.some((message) => message.card);
      }, "interactive chat permission card");
      const chatTurn = readFileSync(f.dump, "utf8").trim().split("\n").map((line) => JSON.parse(line))
        .findLast((item: { isTurnSpawn: boolean; cwd: string }) => item.isTurnSpawn && item.cwd !== f.leased);
      expect(chatTurn?.mcpConfig?.codingRun).toBeUndefined();
      expect(chatTurn?.mcpConfig?.approvalMode).toBe("ask");
    }
    if (mode === "coding") {
      const reviewMessages = (await f.api("GET", `/api/threads/${reviewTask.threadId}/messages?limit=100`)).messages as Array<{
        role: string; text?: string; turnTerminal?: boolean;
      }>;
      expect(reviewMessages.some((message) => message.role === "bot" && message.turnTerminal &&
        message.text === `ACCEPT ${f.git(f.leased, "rev-parse", "HEAD")}`)).toBe(true);
    }
    if (mode === "coding") {
      await f.stop();
      await f.start();
      const restoredRuns = (await f.api("GET", "/api/routines")).runs as Array<{ routineId: string; status: string }>;
      expect(restoredRuns.filter((entry) => entry.routineId === routine.id && entry.status === "completed")).toHaveLength(1);
      const restoredMessages = (await f.api("GET", `/api/threads/${run.threadId}/messages?limit=100`)).messages as Array<{
        turnId?: string;
      }>;
      expect(restoredMessages.filter((message) => message.turnId?.startsWith("coding-result:"))).toHaveLength(1);
      expect(JSON.parse(readFileSync(f.state, "utf8")).holder).not.toBeNull();
    }
    if (process.env.OMB_PARITY_PROOF_DIR) {
      writeFileSync(join(process.env.OMB_PARITY_PROOF_DIR, `coding-${mode}.json`), JSON.stringify({
        mode, routineId: routine.id, run, workerTask, reviewTask, ownerMessages, workerMessages,
        turns: turns.filter((turn) => turn.isTurnSpawn).map((turn) => ({ cwd: turn.cwd, argv: turn.argv })), operations, leased: f.leased,
        revision: f.git(f.leased, "rev-parse", "HEAD"), stderr: f.logs().slice(-3000),
      }, null, 2));
    }
  } catch (error) { console.error(f.logs().slice(-8000)); throw error; }
  finally { await f.stop(); await removeTempDir(f.home); }
}, 90_000);

test("composed server refuses unconfigured coding ceilings without a worker turn", async () => {
  const f = await fixture("happy");
  try {
    await f.start();
    const origin = (await f.api("POST", "/api/bots", { name: "Request owner" })).bot;
    const worker = (await f.api("POST", "/api/bots", { name: "Coding worker" })).bot;
    const reviewer = (await f.api("POST", "/api/bots", { name: "Independent reviewer" })).bot;
    const routine = (await f.api("POST", "/api/routines", {
      name: "Unconfigured ceiling fixture", prompt: "Complete fixture coding task", botId: origin.id,
      schedule: { type: "once", at: Date.now() + 3_600_000 },
    })).routine;
    await f.stop();
    writeFileSync(f.configFile, JSON.stringify({ ...f.config, codingRuns: { repositoryRoot: f.repository, rolesFilePath: f.rolesFilePath,
      registrations: [{ routineId: routine.id, workerBotId: worker.id, reviewerBotId: reviewer.id,
        developmentRole: "fixture/development", reviewRole: "fixture/review", repository: "fixture/agents", ref: "main",
        successCriteria: ["coding-fixture-result.txt exists"], checkCommand: ["node", "-e", "process.exit(0)"] }] } }));
    const routinesFile = join(f.dataDir, "routines.json");
    const saved = JSON.parse(readFileSync(routinesFile, "utf8"));
    const due = Date.now() - 1000;
    const scheduled = saved.routines.find((entry: { id: string }) => entry.id === routine.id);
    scheduled.schedule.at = due;
    scheduled.nextRunAt = due;
    writeFileSync(routinesFile, JSON.stringify(saved));
    await f.start();
    await f.until(async () => {
      const runs = (await f.api("GET", "/api/routines")).runs as Array<{ routineId: string; status: string }>;
      return runs.some((run) => run.routineId === routine.id && run.status === "failed");
    }, "unconfigured terminal report");
    const run = (await f.api("GET", "/api/routines")).runs.find((entry: { routineId: string }) => entry.routineId === routine.id);
    const messages = (await f.api("GET", `/api/threads/${run.threadId}/messages?limit=100`)).messages as Array<{
      turnId?: string; text?: string;
    }>;
    expect(messages.find((message) => message.turnId?.startsWith("coding-result:"))?.text)
      .toContain("configure this bot's wall-clock ceiling");
    const bots = (await f.api("GET", "/api/bots")).bots;
    for (const id of [worker.id, reviewer.id]) {
      expect(bots.find((bot: { id: string }) => bot.id === id).tasks
        .some((task: { title: string }) => task.title.startsWith("Coding "))).toBe(false);
    }
  } catch (error) { console.error(f.logs().slice(-8000)); throw error; }
  finally { await f.stop(); await removeTempDir(f.home); }
}, 90_000);

test("webhook coding delivery ends without an approval card", async () => {
  const f = await fixture("coding");
  try {
    await f.start();
    const origin = (await f.api("POST", "/api/bots", { name: "Webhook owner" })).bot;
    const worker = (await f.api("POST", "/api/bots", { name: "Webhook worker" })).bot;
    const reviewer = (await f.api("POST", "/api/bots", { name: "Webhook reviewer" })).bot;
    for (const bot of [worker, reviewer]) await f.api("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { instanceId: "pi", model: "openai/gpt-5.4-mini" },
    });
    const created = await f.api("POST", "/api/webhooks", {
      name: "Coding webhook", prompt: "Complete fixture coding task", botId: origin.id, runOn: "maus",
    });
    await f.stop();
    writeFileSync(f.configFile, JSON.stringify({ ...f.config, codingRuns: {
      repositoryRoot: f.repository, rolesFilePath: f.rolesFilePath,
      bots: { [origin.id]: { maxWallTimeMs: 120_000, maxSpendUsd: 1 } }, registrations: [{
        routineId: created.webhook.id, workerBotId: worker.id, reviewerBotId: reviewer.id,
        developmentRole: "fixture/development", reviewRole: "fixture/review", repository: "fixture/agents", ref: "main",
        successCriteria: ["coding-fixture-result.txt exists"], checkCommand: ["node", "-e", "process.exit(0)"],
      }],
    } }));
    await f.start();
    const delivery = await fetch(created.credential.url, { method: "POST", headers: {
      "content-type": "application/json", "idempotency-key": "fixture-delivery-1",
    }, body: JSON.stringify({ task: "fixture" }) });
    expect(delivery.status).toBe(202);
    await f.until(async () => ((await f.api("GET", "/api/routines")).runs as Array<{ webhookId: string; status: string }>).some(
      (run) => run.webhookId === created.webhook.id && run.status === "completed"), "webhook coding completion");
    const bots = (await f.api("GET", "/api/bots")).bots;
    for (const bot of [worker, reviewer]) {
      const task = bots.find((entry: { id: string }) => entry.id === bot.id)?.tasks.find((entry: { title: string }) => entry.title.startsWith("Coding "));
      expect(task?.approvalMode).toBe("full");
      const messages = (await f.api("GET", `/api/threads/${task.threadId}/messages?limit=100`)).messages as Array<{ card?: unknown }>;
      expect(messages.some((message) => message.card)).toBe(false);
    }
  } finally { await f.stop(); await removeTempDir(f.home); }
}, 90_000);

test("composed server interrupts an active coding turn at its wall-clock ceiling", async () => {
  const f = await fixture("coding-hold");
  try {
    await f.start();
    const origin = (await f.api("POST", "/api/bots", { name: "Request owner" })).bot;
    const worker = (await f.api("POST", "/api/bots", { name: "Coding worker" })).bot;
    const reviewer = (await f.api("POST", "/api/bots", { name: "Independent reviewer" })).bot;
    await f.api("PATCH", `/api/bots/${worker.id}`, { modelSelection: { instanceId: "pi", model: "openai/gpt-5.4-mini" } });
    await f.api("PATCH", `/api/bots/${reviewer.id}`, { modelSelection: { instanceId: "pi", model: "openai/gpt-5.4-mini" } });
    const routine = (await f.api("POST", "/api/routines", {
      name: "Deadline fixture", prompt: "Complete fixture coding task", botId: origin.id,
      schedule: { type: "once", at: Date.now() + 3_600_000 },
    })).routine;
    await f.stop();
    writeFileSync(f.configFile, JSON.stringify({ ...f.config, codingRuns: { repositoryRoot: f.repository, rolesFilePath: f.rolesFilePath,
      bots: { [origin.id]: { maxWallTimeMs: 5_000 } }, registrations: [{
        routineId: routine.id, workerBotId: worker.id, reviewerBotId: reviewer.id,
        developmentRole: "fixture/development", reviewRole: "fixture/review", repository: "fixture/agents", ref: "main",
        successCriteria: ["coding-fixture-result.txt exists"], checkCommand: ["node", "-e", "process.exit(0)"],
      }] } }));
    const routinesFile = join(f.dataDir, "routines.json");
    const saved = JSON.parse(readFileSync(routinesFile, "utf8"));
    const due = Date.now() - 1000;
    const scheduled = saved.routines.find((entry: { id: string }) => entry.id === routine.id);
    scheduled.schedule.at = due;
    scheduled.nextRunAt = due;
    writeFileSync(routinesFile, JSON.stringify(saved));
    await f.start();
    await f.until(async () => {
      const bot = (await f.api("GET", "/api/bots")).bots.find((entry: { id: string }) => entry.id === worker.id);
      return Boolean(bot?.tasks.some((task: { title: string }) => task.title.startsWith("Coding ")));
    }, "active worker turn");
    await f.until(async () => {
      const runs = (await f.api("GET", "/api/routines")).runs as Array<{ routineId: string; status: string }>;
      return runs.some((run) => run.routineId === routine.id && run.status === "failed");
    }, "wall-clock terminal report");
    const run = (await f.api("GET", "/api/routines")).runs.find((entry: { routineId: string }) => entry.routineId === routine.id);
    const messages = (await f.api("GET", `/api/threads/${run.threadId}/messages?limit=100`)).messages as Array<{
      turnId?: string; text?: string;
    }>;
    const report = messages.find((message) => message.turnId?.startsWith("coding-result:"));
    expect(report?.text).toContain("wall-clock ceiling reached");
    expect(existsSync(join(f.leased, "coding-fixture-result.txt"))).toBe(false);
    if (process.env.OMB_PARITY_PROOF_DIR) {
      writeFileSync(join(process.env.OMB_PARITY_PROOF_DIR, "run-limits-composed-ceiling.json"), JSON.stringify({
        result: run.status, report: report?.text, elapsedCeilingMs: 5_000,
      }, null, 2));
    }
  } catch (error) { console.error(f.logs().slice(-8000)); throw error; }
  finally { await f.stop(); await removeTempDir(f.home); }
}, 90_000);

test("drill: SIGKILL during review holds the prepared effect and delivers one blocked report", async () => {
  const f = await fixture("drill");
  const marker = join(f.home, "review-started.json");
  let reviewPid: number | undefined;
  try {
    await f.start();
    const owner = (await f.api("POST", "/api/bots", { name: "Fixture owner" })).bot;
    const worker = (await f.api("POST", "/api/bots", { name: "Fixture worker" })).bot;
    const reviewer = (await f.api("POST", "/api/bots", { name: "Fixture reviewer" })).bot;
    await f.api("PATCH", `/api/bots/${owner.id}`, { approvalMode: "ask" });
    for (const bot of [worker, reviewer]) {
      await f.api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "pi", model: "openai/gpt-5.4-mini" } });
    }
    const routine = (await f.api("POST", "/api/routines", {
      name: "Crash drill", prompt: "Complete fixture coding task", botId: owner.id,
      schedule: { type: "once", at: Date.now() + 3_600_000 },
    })).routine;
    await f.stop();
    writeFileSync(f.configFile, JSON.stringify({ ...f.config, codingRuns: { repositoryRoot: f.repository, rolesFilePath: f.rolesFilePath,
      bots: { [owner.id]: { maxWallTimeMs: 600_000, maxIterations: 3 } }, registrations: [{
        routineId: routine.id, workerBotId: worker.id, reviewerBotId: reviewer.id,
        developmentRole: "fixture/development", reviewRole: "fixture/review", repository: "fixture/agents", ref: "main",
        successCriteria: ["coding-fixture-result.txt exists"], checkCommand: ["node", "-e", "process.exit(0)"],
      }] } }));
    const routinesFile = join(f.dataDir, "routines.json");
    const saved = JSON.parse(readFileSync(routinesFile, "utf8"));
    const due = Date.now() - 1000;
    const scheduled = saved.routines.find((entry: { id: string }) => entry.id === routine.id);
    scheduled.schedule.at = due;
    scheduled.nextRunAt = due;
    writeFileSync(routinesFile, JSON.stringify(saved));
    await f.start();
    await f.until(async () => existsSync(marker), "review turn after worker commit");
    const review = JSON.parse(readFileSync(marker, "utf8")) as { pid: number; revision: string };
    reviewPid = review.pid;
    const store = new RunContractStore(join(f.dataDir, "coding-run", "runtime.db"));
    const activeRun = (await f.api("GET", "/api/routines")).runs.find((entry: { routineId: string }) => entry.routineId === routine.id);
    const before = store.get(scheduledCodingRunId(activeRun));
    expect(before?.state).toBe("running");
    expect(before?.contract.maxIterations).toBe(3);
    expect(before?.contract.limits?.maxWallTimeMs).toBe(600_000);
    const prepared = store.step(before!.contract.id, before!.iteration);
    expect(prepared?.status).toBe("prepared");
    const storeTaskId = store.taskId(before!.contract.id);
    store.close();
    expect(f.git(f.leased, "rev-parse", "HEAD")).toBe(review.revision);
    await f.kill();
    const driver = await openTestDurableDriver({ directory: join(f.dataDir, "coding-run", "durable-driver") });
    try {
      const driverRunId = createHash("sha256").update(`worker:${prepared!.requestId}`).digest("hex");
      const intent = await driver.status(driverRunId);
      expect(intent?.steps).toHaveLength(1);
      expect(intent?.steps[0]?.state).toBe("intent");
      const held = await driver.resume(driverRunId);
      expect(held.state).toBe("held");
      expect(held.steps[0]?.state).toBe("held");
    } finally { await driver.close(); }
    try { process.kill(reviewPid, "SIGKILL"); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
    reviewPid = undefined;
    await f.start();
    await f.until(async () => (await f.api("GET", "/api/routines")).runs
      .some((run: { routineId: string; status: string }) => run.routineId === routine.id && run.status === "failed"), "blocked settlement");
    const afterStore = new RunContractStore(join(f.dataDir, "coding-run", "runtime.db"));
    const after = afterStore.get(before!.contract.id);
    const receipt = afterStore.step(before!.contract.id, before!.iteration);
    afterStore.close();
    expect(after?.state).toBe("blocked");
    expect(after?.evidence.join(" ")).toContain("unknown outward effect");
    expect(receipt?.status).toBe("prepared");
    expect(f.git(f.leased, "rev-list", "--count", "main..HEAD")).toBe("1");
    const turns = readFileSync(f.dump, "utf8").trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      isTurnSpawn?: boolean; cwd?: string;
    }>;
    expect(turns.filter((turn) => turn.isTurnSpawn && turn.cwd === f.leased)).toHaveLength(2);
    const run = (await f.api("GET", "/api/routines")).runs.find((entry: { routineId: string }) => entry.routineId === routine.id);
    const messages = (await f.api("GET", `/api/threads/${run.threadId}/messages?limit=100`)).messages as Array<{
      turnId?: string; text?: string;
    }>;
    const ownerReports = messages.filter((message) => message.turnId?.startsWith("coding-result:"));
    expect(ownerReports).toHaveLength(1);
    expect(ownerReports[0].text).toContain("Coding run blocked:");
    const settlement = (JSON.parse(readFileSync(routinesFile, "utf8")).codingSettlementReceipts as Array<{
      routineRunId: string; codingRunId: string; status: string; disposition: string;
    }>).filter((entry) => entry.routineRunId === run.id);
    expect(settlement).toMatchObject([{ codingRunId: before!.contract.id, status: "APPLIED", disposition: "held" }]);
    f.git(f.leased, "push", join(f.home, "destination.git"), `HEAD:refs/heads/draft/drill-${before!.contract.id}`);
    expect(f.git(f.repository, "--git-dir", join(f.home, "destination.git"), "rev-parse",
      `refs/heads/draft/drill-${before!.contract.id}`)).toBe(review.revision);
    const auditConfigFile = join(f.home, "audit-config.json");
    const baseRevision = f.git(f.leased, "rev-parse", "main");
    const auditConfig = { destination: "fixture/agents", host: "fixture",
      credentialReference: "fixture-reference", worktree: f.leased, model: "openai-codex/gpt-6-luna", thinking: "low",
      botConfig: { originBotId: owner.id, workerBotId: worker.id, reviewerBotId: reviewer.id,
        modelSelection: { instanceId: "pi", model: "openai-codex/gpt-6-luna" }, maxIterations: 3,
        limits: { maxWallTimeMs: 600_000, modelAccess: "subscription" } }, baseRevision,
      expectedRevisions: [review.revision] };
    writeFileSync(auditConfigFile, JSON.stringify(auditConfig));
    const audit = JSON.parse(execFileSync(process.execPath,
      [join(root, "scripts", "drill-coding-run.mjs"), "--audit-sandbox", auditConfigFile],
      { cwd: root, encoding: "utf8" })) as { verifiedRevisions: string[]; mergeCommits: number };
    expect(audit.verifiedRevisions).toEqual([review.revision]);
    expect(audit.mergeCommits).toBe(0);
    writeFileSync(auditConfigFile, JSON.stringify({ ...auditConfig, expectedRevisions: [baseRevision] }));
    expect(() => execFileSync(process.execPath,
      [join(root, "scripts", "drill-coding-run.mjs"), "--audit-sandbox", auditConfigFile],
      { cwd: root, encoding: "utf8", stdio: "pipe" })).toThrow();
    const authors = f.git(f.leased, "log", "--format=%an <%ae>|%cn <%ce>|%P", "main..HEAD");
    expect(authors).toMatch(/^evoclock <52983349\+evoclock@users\.noreply\.github\.com>\|evoclock <52983349\+evoclock@users\.noreply\.github\.com>\|[0-9a-f]{40}$/);
    const result = { schema: "omb-drill-v1", outcome: "blocked", routineId: routine.id,
      runId: before!.contract.id, taskId: storeTaskId, revision: review.revision,
      configuredCeilings: { maxIterations: before!.contract.maxIterations,
        maxWallTimeMs: before!.contract.limits?.maxWallTimeMs, maxSpendUsd: before!.contract.limits?.maxSpendUsd },
      before: { state: before!.state, iteration: before!.iteration, receipt: prepared },
      after: { state: after?.state, iteration: after?.iteration, receipt, settlementReceipt: settlement[0] },
      effects: { workerCommits: 1, reviewerTurns: 1, repeatedTurns: 0, ownerReports: ownerReports.length,
        pushedRef: `refs/heads/draft/drill-${before!.contract.id}`, mergeCommits: 0, squash: false },
      verification: { entry: "blocked routine and exactly one owner report", attribution: authors,
        reviewAcceptance: "not claimed: reviewer interrupted before acceptance" } };
    if (process.env.OMB_DRILL_PROOF_DIR) {
      mkdirSync(process.env.OMB_DRILL_PROOF_DIR, { recursive: true });
      writeFileSync(join(process.env.OMB_DRILL_PROOF_DIR, "report.json"), JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(f.logs().slice(-4000));
    if (existsSync(f.dump)) console.error(readFileSync(f.dump, "utf8").slice(-4000));
    if (existsSync(join(f.dataDir, "routines.json"))) console.error(readFileSync(join(f.dataDir, "routines.json"), "utf8").slice(-3000));
    throw error;
  } finally {
    if (reviewPid) { try { process.kill(reviewPid, "SIGKILL"); } catch {} }
    await f.stop();
    await removeTempDir(f.home);
  }
}, 90_000);
