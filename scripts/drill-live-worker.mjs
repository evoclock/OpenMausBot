import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openOuterRunner } from "../server/outer-runner.ts";
import { createLoopStatusRoutes } from "../server/routes/loop-status.ts";
import { json, readBody } from "../server/harness/http.ts";
import { redactToolResult } from "../server/redact.ts";
import { createGitHubAppCredentialProvider } from "../server/github-app-credential.ts";
import { SANDBOX, runGit, withSandboxGitToken } from "./drill-github-app.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const proofRoot = join(root, ".omb-scratch", "proof", "omb-e2e-loop-drill", "live");
const identity = { GIT_AUTHOR_NAME: "evoclock", GIT_AUTHOR_EMAIL: "52983349+evoclock@users.noreply.github.com",
  GIT_COMMITTER_NAME: "evoclock", GIT_COMMITTER_EMAIL: "52983349+evoclock@users.noreply.github.com" };
const save = (name, value) => writeFileSync(join(proofRoot, name), JSON.stringify(value, null, 2));

export function checkLiveConfig(config) {
  if (config.destination !== SANDBOX || config.host !== "mac-mini" ||
    config.credentialReference?.kind !== "github-app" || config.credentialReference.reference !== "sandbox-drill" ||
    config.gitAppInstallations?.["sandbox-drill"]?.appId !== 5424694 ||
    config.gitAppInstallations?.["sandbox-drill"]?.installationId !== 174083987 ||
    config.gitAppInstallations?.["sandbox-drill"]?.visibility !== "private" ||
    config.gitAppInstallations?.["sandbox-drill"]?.repositories?.length !== 1 ||
    config.gitAppInstallations["sandbox-drill"].repositories[0] !== SANDBOX ||
    !config.gitAppInstallations["sandbox-drill"].privateKeyPath?.startsWith("/") ||
    config.model !== "openai-codex/gpt-6-sol" ||
    config.thinking !== "low" || config.botConfig?.modelSelection?.model !== config.model ||
    !Number.isSafeInteger(config.botConfig?.maxIterations) || config.botConfig.maxIterations < 2 ||
    !Number.isSafeInteger(config.botConfig?.limits?.maxWallTimeMs) || config.botConfig.limits.maxWallTimeMs < 30_000 ||
    !Number.isFinite(config.botConfig?.limits?.maxSpendUsd) || config.botConfig.limits.maxSpendUsd <= 0 ||
    !resolve(config.worktree ?? "/").startsWith(proofRoot + "/") ||
    !config.skillPath?.startsWith("/") ||
    !/^[0-9a-f]{40}$/.test(config.baseRevision ?? "") ||
    !config.botConfig?.originBotId || !config.botConfig?.workerBotId || !config.botConfig?.reviewerBotId)
    throw new Error("live sandbox config refused");
}

export async function runPi(cwd, config, prompt, signal) {
  const events = [];
  const argv = ["--mode", "json", "--no-session", "--no-mcp", "--no-extensions", "--no-prompt-templates",
    "--no-context-files", "--tools", "read,write,edit", "--skill", config.skillPath,
    "--model", config.model, "--thinking", config.thinking, prompt];
  const child = spawn("pi", argv, { cwd, signal, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, GIT_AUTHOR_NAME: identity.GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL: identity.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: identity.GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL: identity.GIT_COMMITTER_EMAIL,
  } });
  let buffered = "";
  let bytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 8_000_000) { child.kill(); return; }
    buffered += chunk.toString();
    let index;
    while ((index = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      try { events.push(JSON.parse(line)); } catch { child.kill(); }
    }
  });
  child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; if (stderrBytes > 1_000_000) child.kill(); });
  const code = await new Promise((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  });
  if (code !== 0 || buffered.trim() || bytes > 8_000_000 || !events.some((event) => event.type === "agent_settled" && !event.aborted))
    throw new Error("Pi worker failed, exceeded output limit, or did not settle");
  const messages = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant");
  if (!messages.length || messages.some((event) => event.message.stopReason === "error" || event.message.stopReason === "aborted"))
    throw new Error("Pi worker returned an error or abort");
  const costs = messages.map((event) => event.message.usage?.cost?.total);
  const costUsd = costs.length && costs.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
    ? costs.reduce((sum, value) => sum + value, 0) : null;
  const transcript = events.filter((event) => event.type === "tool_execution_end" ||
    event.type === "message_end" && event.message?.role === "assistant").map((event) =>
    event.type === "tool_execution_end" ? { type: "tool", name: event.toolName,
      result: redactToolResult(JSON.stringify(event.result), JSON.stringify(event.args ?? {})) }
      : { type: "assistant", text: redactToolResult(JSON.stringify(event.message.content ?? [])) });
  return { costUsd, transcript };
}

export async function runLive(config) {
  checkLiveConfig(config);
  if (existsSync(config.worktree)) throw new Error("live destination must be a fresh sandbox checkout");
  mkdirSync(proofRoot, { recursive: true });
  const started = Date.now();
  const credentials = createGitHubAppCredentialProvider({ installations: config.gitAppInstallations });
  const token = await credentials.scopedToken(config.credentialReference, SANDBOX);
  if (!token) throw new Error("scoped GitHub App installation credential unavailable");
  const destination = `https://github.com/${SANDBOX}.git`;
  const askpass = join(root, "scripts", "drill-git-askpass.mjs");
  const parent = dirname(config.worktree);
  mkdirSync(parent, { recursive: true });
  const git = (args, cwd = config.worktree, env = process.env, signal) => runGit(args, cwd, env, signal);
  await withSandboxGitToken(token, askpass, (env) => git(["clone", "--branch", "main", "--single-branch", destination, config.worktree], parent, env));
  const base = await git(["rev-parse", "HEAD"]);
  if (base !== config.baseRevision || await git(["remote", "get-url", "origin"]) !== destination)
    throw new Error("sandbox base or destination changed before run");
  const branch = `draft/drill-${Date.now()}-${randomUUID().slice(0, 8)}`;
  await git(["switch", "-c", branch]);
  await git(["remote", "remove", "origin"]);
  const data = join(proofRoot, "coding-run");
  const reports = [];
  const transcripts = [];
  const inputs = [];
  const contract = { id: randomUUID(), botId: config.botConfig.originBotId, repository: SANDBOX,
    ref: branch, repositoryClass: "agent-private", successCriteria: ["node drill-double.test.mjs exits zero"],
    allowedEffects: ["edit", "commit"], authorisedExternalWrites: [], maxIterations: config.botConfig.maxIterations,
    limits: config.botConfig.limits };
  const route = createLoopStatusRoutes({ dataDir: proofRoot, botVisible: (_auth, botId) => botId === contract.botId });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void route({ req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["client"] }, json, readBody });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const status = async () => (await (await fetch(`http://127.0.0.1:${address.port}/api/bots/${contract.botId}/loop-status`)).json()).runs[0];
  let during;
  let revision;
  const runner = await openOuterRunner(data, { async invoke(_contract, iteration, requestId, signal, _remaining, context) {
    const input = { iteration, requestId, previous: context?.previous };
    inputs.push(input);
    save(`iteration-${iteration}-input.json`, input);
    if (iteration === 2 && (!context?.previous || context.previous.iteration !== 1 || context.previous.verdict !== "waiting"))
      return { kind: "blocked", evidence: ["ledger did not carry previous verdict"], costUsd: 0 };
    const prompt = iteration === 1
      ? "/skill:poteto-mode-pi Work only in this checkout. Create drill-double.mjs exporting double(n) that returns n+n+1. Create drill-double.test.mjs using node:assert/strict asserting double(3) equals 6. The host will run the test; report expected failure and stop. Do not commit, push, or access any other repository."
      : `/skill:poteto-mode-pi Iteration ${iteration}. Previous verdict ${context?.previous?.verdict}. Previous evidence: ${context?.previous?.evidence.join("; ")}. Work only in this checkout. Fix drill-double.mjs so node drill-double.test.mjs passes. The host will run the check; report the fix and stop. Do not commit, push, or access any other repository.`;
    const result = await runPi(config.worktree, config, prompt, signal);
    transcripts.push({ iteration, events: result.transcript });
    save("worker-transcript-excerpt.json", transcripts);
    const check = await new Promise((done) => {
      const child = spawn(process.execPath, ["drill-double.test.mjs"], { cwd: config.worktree, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("close", (code) => done({ code, output: output.slice(0, 3000) }));
      child.on("error", () => done({ code: -1, output: "done check could not start" }));
    });
    save(`iteration-${iteration}-check.json`, check);
    if (iteration === 1 && check.code === 0) return { kind: "blocked", evidence: ["first iteration unexpectedly passed; required failing check missing"], costUsd: result.costUsd };
    if (iteration === 1) return { kind: "progress", evidence: ["first iteration check failed", `exit ${check.code}`], costUsd: result.costUsd };
    if (check.code !== 0) return { kind: "progress", evidence: ["done check failed", `exit ${check.code}`], costUsd: result.costUsd };
    return { kind: "verified", evidence: ["node drill-double.test.mjs passed"], costUsd: result.costUsd };
  } }, { onTerminal(snapshot) { reports.push({ state: snapshot.state, evidence: snapshot.evidence }); } });
  try {
    const task = await runner.start(contract);
    for (let i = 0; i < 200 && (runner.get(contract.id)?.iteration ?? 0) < 2; i++)
      await new Promise((done) => setTimeout(done, 50));
    during = await status();
    save("status-during.json", during);
    await runner.wait(task);
    const after = await status();
    save("status-after.json", after);
    save("ledger.json", runner.ledger(contract.id));
    save("owner-report.json", reports[0] ?? null);
    save("run-record.json", transcripts);
    if (after.state !== "done" || after.iteration < 2 || !reports.some((entry) => entry.state === "done"))
      throw new Error("real Pi outer loop did not reach done in two iterations");
    await git(["add", "--", "drill-double.mjs", "drill-double.test.mjs"]);
    await git(["-c", "user.name=evoclock", "-c", "user.email=52983349+evoclock@users.noreply.github.com",
      "commit", "-m", "Add verified drill double"]);
    revision = await git(["rev-parse", "HEAD"]);
    await git(["diff", "--check", `${base}..${revision}`]);
    await git(["remote", "add", "origin", destination]);
    await withSandboxGitToken(token, askpass, (env) => git(["push", "origin", `HEAD:refs/heads/${branch}`], config.worktree, env));
    const response = await fetch(`https://api.github.com/repos/${SANDBOX}/pulls`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
        "content-type": "application/json", "x-github-api-version": "2022-11-28" },
      body: JSON.stringify({ title: "Add a verified drill double", head: branch, base: "main", draft: true,
        body: "I added a small test-backed coding drill for review. I will handle integration separately." }),
    });
    if (!response.ok) throw new Error("sandbox draft pull request could not be created");
    const pr = await response.json();
    if (pr.base?.repo?.full_name !== SANDBOX || pr.head?.ref !== branch || pr.draft !== true)
      throw new Error("sandbox draft pull request destination did not match");
    const report = { outcome: "pass", destination: SANDBOX, branch, revision, baseRevision: base,
      iterationsUsed: after.iteration, spendUsd: after.budget.spentUsd, wallTimeMs: Date.now() - started,
      url: pr.html_url, criteria: { ledgerCarried: Boolean(inputs[1]?.previous?.evidence?.length),
        configuredLimits: after.budget.iterationsRemaining >= 0, redactedRunRecord: true,
        statusDuringAndAfter: Boolean(during && after), ownerReport: true, doneCheck: true } };
    save("drill-report.json", report);
    return report;
  } finally {
    await runner.close();
    await new Promise((done) => server.close(done));
  }
}
