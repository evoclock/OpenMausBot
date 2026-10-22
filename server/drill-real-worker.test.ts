import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { test } from "vitest";
import { openOuterRunner } from "./outer-runner.ts";
import { createLoopStatusRoutes } from "./routes/loop-status.ts";
import { json, readBody } from "./harness/http.ts";
import { redactToolFields } from "./redact.ts";

const root = resolve(import.meta.dirname, "..");
const proof = process.env.OMB_DRILL_REAL_PROOF_DIR ?? join(root, ".omb-scratch", "proof", "omb-e2e-loop-ci");
const config = { maxIterations: 3, limits: { maxWallTimeMs: 60_000, maxSpendUsd: 1 },
  repository: "local/fixture", model: "scripted/local", thinking: "none" };

test("drill: scripted local worker finishes on iteration two with the previous verdict", async () => {
  assert.ok(proof?.startsWith(join(root, ".omb-scratch", "proof") + "/"), "proof must stay in fixture checkout");
  mkdirSync(proof, { recursive: true });
  const run = mkdtempSync(join(proof, "local-run-"));
  const data = join(run, "coding-run");
  const repo = join(run, "fixture-repo");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  writeFileSync(join(repo, "check.mjs"), "import { strict as assert } from 'node:assert';\nimport { double } from './double.mjs';\nassert.equal(double(3), 6);\nconsole.log('done-check passed');\n");
  git("add", "check.mjs");
  git("-c", "user.name=evoclock", "-c", "user.email=52983349+evoclock@users.noreply.github.com", "commit", "-m", "Fixture base");
  const destination = join(run, "destination.git");
  execFileSync("git", ["init", "--bare", destination], { cwd: run, stdio: "pipe" });
  git("push", destination, "main");
  const contract = { id: "44444444-4444-4444-8444-444444444444", botId: "fixture-owner", repository: config.repository,
    ref: "main", successCriteria: ["node check.mjs exits zero"], repositoryClass: "agent-private" as const,
    allowedEffects: ["edit" as const], authorisedExternalWrites: [], limits: config.limits,
    maxIterations: config.maxIterations };
  const startedAt = Date.now();
  const inputs: unknown[] = [];
  const records: unknown[] = [];
  const reports: unknown[] = [];
  let during: unknown;
  let releaseSecond!: () => void;
  const secondReady = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const statusRoute = createLoopStatusRoutes({ dataDir: run, botVisible: (_auth, botId) => botId === contract.botId });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void statusRoute({ req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["client"] }, json, readBody });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const status = async () => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/bots/${contract.botId}/loop-status`);
    assert.equal(response.status, 200);
    return (await response.json() as { runs: Array<{ state: string; iteration: number; budget: {
      spentUsd: number; iterationsRemaining: number } }> }).runs[0];
  };
  const runner = await openOuterRunner(data, {
    async invoke(_contract, iteration, requestId, signal, _remainingUsd, context) {
      assert.equal(signal.aborted, false);
      const input = { iteration, requestId, previous: context?.previous };
      inputs.push(input);
      writeFileSync(join(proof, `iteration-${iteration}-input.json`), JSON.stringify(input, null, 2));
      const observed = spawnSync(process.execPath, ["check.mjs"], { cwd: repo, encoding: "utf8" });
      const tool = redactToolFields({ name: "bash", input: "node check.mjs", output:
        `${observed.stdout}${observed.stderr}\nfixture_token=synthetic-value-${iteration}` });
      records.push({ iteration, tool });
      if (iteration === 1) {
        assert.notEqual(observed.status, 0);
        writeFileSync(join(repo, "double.mjs"), "export const double = (n) => n + n + 1;\n");
        return { kind: "progress", evidence: ["node check.mjs failed; double.mjs returns one too many"], costUsd: 0.01 };
      }
      await secondReady;
      assert.equal(context?.previous?.iteration, 1);
      assert.equal(context.previous.verdict, "waiting");
      assert.match(context.previous.evidence.join(" "), /failed/);
      assert.notEqual(observed.status, 0);
      writeFileSync(join(repo, "double.mjs"), "export const double = (n) => n + n;\n");
      const check = spawnSync(process.execPath, ["check.mjs"], { cwd: repo, encoding: "utf8" });
      writeFileSync(join(proof, "test-output.txt"), `${check.stdout}${check.stderr}`);
      assert.equal(check.status, 0, check.stderr);
      return { kind: "verified", evidence: ["node check.mjs passed", check.stdout.trim()], costUsd: 0.01 };
    },
  }, { onTerminal(snapshot) { reports.push({ state: snapshot.state, evidence: snapshot.evidence }); } });
  try {
    writeFileSync(join(proof, "config.json"), JSON.stringify(config, null, 2));
    const id = await runner.start(contract);
    for (let attempt = 0; attempt < 200 && runner.get(contract.id)?.iteration < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    during = await status();
    assert.equal((during as { state: string }).state, "running");
    releaseSecond();
    await runner.wait(id);
    const after = await status();
    assert.equal(after.state, "done");
    assert.equal(after.iteration, 2);
    assert.equal(after.budget.spentUsd, 0.02);
    assert.equal(after.budget.iterationsRemaining, 1);
    assert.equal(runner.ledger(contract.id).length, 2);
    assert.equal(reports.length, 1);
    assert.equal((reports[0] as { state: string }).state, "done");
    const stored = JSON.stringify(records);
    assert.doesNotMatch(stored, /synthetic-value/);
    assert.match(stored, /redacted/);
    writeFileSync(join(proof, "run-record.json"), JSON.stringify(records, null, 2));
    writeFileSync(join(proof, "worker-transcript-excerpt.json"), JSON.stringify(inputs, null, 2));
    writeFileSync(join(proof, "ledger.json"), JSON.stringify(runner.ledger(contract.id), null, 2));
    writeFileSync(join(proof, "status-during.json"), JSON.stringify(during, null, 2));
    writeFileSync(join(proof, "status-after.json"), JSON.stringify(after, null, 2));
    writeFileSync(join(proof, "owner-report.json"), JSON.stringify(reports[0], null, 2));
    writeFileSync(join(proof, "drill-report.json"), JSON.stringify({ outcome: "pass", criteria: {
      configuredLimits: true, ledgerCarried: true, redactedStoredToolResults: true,
      statusDuringAndAfter: true, ownerReport: true, doneCheck: true },
      iterationsUsed: after.iteration, spendUsd: after.budget.spentUsd,
      wallTimeMs: Date.now() - startedAt, statusRoute: `/api/bots/${contract.botId}/loop-status` }, null, 2));
  } finally {
    releaseSecond();
    await runner.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}, 90_000);
