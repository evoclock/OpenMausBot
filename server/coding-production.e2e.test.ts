import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const serverDir = dirname(fileURLToPath(import.meta.url));
const root = join(serverDir, "..");
const fakePi = join(serverDir, "testing", "fake-pi-cli.ts");

async function fixture(mode: "coding" | "happy" | "permission") {
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
  mkdirSync(dataDir);
  mkdirSync(bin);
  mkdirSync(repository);
  mkdirSync(join(home, "static"));
  writeFileSync(join(home, "static", "index.html"), "<html>fixture</html>");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git(repository, "init", "-b", "main");
  writeFileSync(join(repository, "README.md"), "isolated coding fixture\n");
  git(repository, "add", "README.md");
  git(repository, "-c", "user.name=evoclock", "-c", "user.email=evoclock@users.noreply.github.com", "commit", "-m", "Fixture base");
  git(repository, "remote", "add", "origin", "git@github.com:fixture/agents.git");
  git(repository, "worktree", "add", "-b", "fixture-lease", leased, "main");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node\nconst a=process.argv.slice(2);\nif(a.join(' ') !== 'repo view fixture/agents --json nameWithOwner,isPrivate,viewerPermission') process.exit(2);\nconsole.log(JSON.stringify({nameWithOwner:'fixture/agents',isPrivate:true,viewerPermission:'WRITE'}));\n`, { mode: 0o755 });
  writeFileSync(state, JSON.stringify({ holder: null }));
  writeFileSync(join(bin, "treehouse"), `#!/usr/bin/env node\nimport {appendFileSync,readFileSync,writeFileSync} from 'node:fs';\nconst a=process.argv.slice(2), file=${JSON.stringify(state)}, log=${JSON.stringify(calls)}, path=${JSON.stringify(leased)};\nconst s=JSON.parse(readFileSync(file,'utf8'));\nappendFileSync(log,JSON.stringify(a)+'\\n');\nif(a[0]==='status') console.log(JSON.stringify(s.holder?[{path,status:'leased',lease_id:'fixture-lease',lease_holder:s.holder}]:[]));\nelse if(a[0]==='get' && a.includes('--lease') && a[a.indexOf('--base')+1]==='main') {\n  s.holder=a[a.indexOf('--lease-holder')+1]; writeFileSync(file,JSON.stringify(s)); console.log(JSON.stringify({path,lease_id:'fixture-lease'}));\n} else if(a[0]==='return' && a[a.indexOf('--if-lease-id')+1]==='fixture-lease' && a[a.indexOf('--if-lease-holder')+1]===s.holder) {\n  s.holder=null; writeFileSync(file,JSON.stringify(s));\n} else process.exit(2);\n`, { mode: 0o755 });
  chmodSync(fakePi, 0o755);
  const configFile = join(dataDir, "config.json");
  const config = { instances: { pi: { driver: "piAgent", environment: { FAKE_PI_MODE: mode, FAKE_PI_DUMP: dump, FAKE_PI_MODELS: "openai/gpt-5.4-mini", FAKE_PI_SCOPE_ACK: "1" },
    config: { cli: fakePi, fullAuto: false } } } };
  writeFileSync(configFile, JSON.stringify(config));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const env = { HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: join(home, "static"),
    PATH: `${bin}:${process.env.PATH ?? ""}` };
  let child: ChildProcess | undefined;
  let stderr = "";
  const start = async () => {
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
  return { home, dataDir, repository, leased, state, calls, dump, configFile, config, git, start, stop, until, api,
    logs: () => stderr };
}

test.each([
  { mode: "coding" as const, expected: "done", released: false },
  { mode: "happy" as const, expected: "blocked", released: true },
  { mode: "permission" as const, expected: "blocked", released: true },
])("composed scheduled coding run uses Pi turns and %s workspace reconciliation", async ({ mode, expected, released }) => {
  const f = await fixture(mode);
  try {
    await f.start();
    const origin = (await f.api("POST", "/api/bots", { name: "Request owner" })).bot;
    const worker = (await f.api("POST", "/api/bots", { name: "Coding worker" })).bot;
    const reviewer = (await f.api("POST", "/api/bots", { name: "Independent reviewer" })).bot;
    await f.api("PATCH", `/api/bots/${origin.id}`, { approvalMode: "ask" });
    for (const bot of [worker, reviewer]) {
      await f.api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "pi", model: "openai/gpt-5.4-mini" } });
    }
    const routine = (await f.api("POST", "/api/routines", {
      name: "Scheduled coding fixture", prompt: "Complete fixture coding task", botId: origin.id,
      schedule: { type: "once", at: Date.now() + 3_600_000 },
    })).routine;
    await f.stop();
    writeFileSync(f.configFile, JSON.stringify({ ...f.config, codingRuns: { repositoryRoot: f.repository,
      bots: { [origin.id]: { maxWallTimeMs: 120_000, maxSpendUsd: 1 } }, registrations: [{
      routineId: routine.id, workerBotId: worker.id, reviewerBotId: reviewer.id,
      developmentRole: "development", reviewRole: "review", repository: "fixture/agents", ref: "main",
      successCriteria: ["coding-fixture-result.txt exists"],
    }] } }));
    const routinesFile = join(f.dataDir, "routines.json");
    const saved = JSON.parse(readFileSync(routinesFile, "utf8"));
    const due = Date.now() - 1000;
    const scheduled = saved.routines.find((entry: { id: string }) => entry.id === routine.id);
    scheduled.schedule.at = due;
    scheduled.nextRunAt = due;
    writeFileSync(routinesFile, JSON.stringify(saved));
    await f.start();
    if (mode === "permission") {
      let requestId = "";
      let requestThreadId = "";
      await f.until(async () => {
        const bot = (await f.api("GET", "/api/bots")).bots.find((entry: { id: string }) => entry.id === worker.id);
        const task = bot?.tasks.find((entry: { title: string }) => entry.title.startsWith("Coding "));
        if (!task) return false;
        expect(task.approvalMode).toBe("ask");
        const messages = (await f.api("GET", `/api/threads/${task.threadId}/messages?limit=100`)).messages as Array<{
          card?: { requestId?: string; title?: string; answered?: string };
        }>;
        const card = messages.find((message) => message.card?.requestId)?.card;
        if (!card?.requestId) return false;
        expect(card.answered).toBeUndefined();
        requestId = card.requestId;
        requestThreadId = task.threadId;
        return true;
      }, "worker permission request");
      expect(existsSync(join(f.leased, "coding-fixture-result.txt"))).toBe(false);
      await f.api("POST", `/api/threads/${requestThreadId}/respond`, { requestId, behavior: "answer", message: "Deny" });
    }
    await f.until(async () => {
      const runs = (await f.api("GET", "/api/routines")).runs as Array<{ routineId: string; status: string }>;
      return runs.some((run) => run.routineId === routine.id && ["completed", "failed"].includes(run.status));
    }, "scheduled coding result");
    const run = (await f.api("GET", "/api/routines")).runs.find((entry: { routineId: string }) => entry.routineId === routine.id);
    expect(run.triggerSource).toBe("schedule");
    expect(run.status).toBe(mode === "coding" ? "completed" : "failed");
    const workers = (await f.api("GET", "/api/bots")).bots;
    const workerTask = workers.find((bot: { id: string }) => bot.id === worker.id).tasks.find((task: { title: string }) => task.title.startsWith("Coding "));
    expect(workerTask?.cwd).toBe(f.leased);
    expect(workerTask?.approvalMode).toBe("ask");
    expect(workerTask?.autoApprove).toBe(false);
    const reviewTask = workers.find((bot: { id: string }) => bot.id === reviewer.id).tasks
      .find((task: { title: string }) => task.title.startsWith("Coding "));
    if (mode === "coding") {
      expect(reviewTask?.cwd).toBe(f.leased);
      expect(reviewTask?.approvalMode).toBe("ask");
      expect(reviewTask?.autoApprove).toBe(false);
    } else {
      expect(reviewTask).toBeUndefined();
    }
    const turns = readFileSync(f.dump, "utf8").trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      cwd: string; isTurnSpawn: boolean; argv: string[]; uiResponse?: { value?: string };
      mcpConfig?: { toolScope?: { allow?: string[] } };
    }>;
    if (mode === "permission") expect(turns.some((turn) => turn.uiResponse?.value === "Deny")).toBe(true);
    expect(turns.some((turn) => turn.isTurnSpawn && turn.cwd === f.leased)).toBe(true);
    for (const turn of turns.filter((item) => item.isTurnSpawn && item.cwd === f.leased)) {
      expect(turn.mcpConfig?.toolScope?.allow).toEqual(["native:read", "native:write", "native:edit"]);
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
    const workerMessages = (await f.api("GET", `/api/threads/${workerTask.threadId}/messages?limit=100`)).messages as Array<{
      role: string; text?: string; turnTerminal?: boolean;
    }>;
    expect(workerMessages.some((message) => message.role === "bot" && message.turnTerminal &&
      message.text === (mode === "coding" ? "Coding fixture committed" : mode === "permission" ? "Permission denied" : "Hello from pi"))).toBe(true);
    if (mode === "permission") {
      expect(workerMessages.some((message) => message.text === "ok")).toBe(false);
      expect(existsSync(join(f.leased, "coding-fixture-result.txt"))).toBe(false);
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
    writeFileSync(f.configFile, JSON.stringify({ ...f.config, codingRuns: { repositoryRoot: f.repository,
      registrations: [{ routineId: routine.id, workerBotId: worker.id, reviewerBotId: reviewer.id,
        developmentRole: "development", reviewRole: "review", repository: "fixture/agents", ref: "main",
        successCriteria: ["coding-fixture-result.txt exists"] }] } }));
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
      .toContain("configure this bot's wall-clock and spend ceilings");
    const bots = (await f.api("GET", "/api/bots")).bots;
    for (const id of [worker.id, reviewer.id]) {
      expect(bots.find((bot: { id: string }) => bot.id === id).tasks
        .some((task: { title: string }) => task.title.startsWith("Coding "))).toBe(false);
    }
  } catch (error) { console.error(f.logs().slice(-8000)); throw error; }
  finally { await f.stop(); await removeTempDir(f.home); }
}, 90_000);

test("composed server interrupts an active coding turn at its wall-clock ceiling", async () => {
  const f = await fixture("permission");
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
    writeFileSync(f.configFile, JSON.stringify({ ...f.config, codingRuns: { repositoryRoot: f.repository,
      bots: { [origin.id]: { maxWallTimeMs: 5_000, maxSpendUsd: 1 } }, registrations: [{
        routineId: routine.id, workerBotId: worker.id, reviewerBotId: reviewer.id,
        developmentRole: "development", reviewRole: "review", repository: "fixture/agents", ref: "main",
        successCriteria: ["coding-fixture-result.txt exists"],
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
