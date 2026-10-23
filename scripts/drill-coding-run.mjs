#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const proof = join(root, ".omb-scratch", "proof", "omb-drill");
const mode = process.argv[2];
if (mode === "--fixture-real-worker" && process.argv.length === 3) {
  const localProof = join(root, ".omb-scratch", "proof", "omb-e2e-loop-drill", "round2");
  mkdirSync(localProof, { recursive: true });
  const runner = join(root, "node_modules", ".bin", "vitest");
  if (!existsSync(runner)) throw new Error("Install locked dependencies through sfw before running the fixture");
  const result = spawnSync(runner, ["run", "server/drill-real-worker.test.ts"], {
    cwd: root, env: { ...process.env, OMB_DRILL_REAL_PROOF_DIR: localProof }, stdio: "inherit", timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const report = JSON.parse(readFileSync(join(localProof, "drill-report.json"), "utf8"));
  if (report.outcome !== "pass") throw new Error("Local real-worker drill did not finish");
  console.log(join(localProof, "drill-report.json"));
} else if (mode === "--fixture" && process.argv.length === 3) {
  mkdirSync(proof, { recursive: true });
  const runner = join(root, "node_modules", ".bin", "vitest");
  if (!existsSync(runner)) throw new Error("Install locked dependencies through sfw before running the fixture");
  const result = spawnSync(runner, ["run", "server/coding-production.e2e.test.ts", "-t", "drill:"], {
    cwd: root, env: { ...process.env, OMB_DRILL_PROOF_DIR: proof }, stdio: "inherit", timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const report = JSON.parse(readFileSync(join(proof, "report.json"), "utf8"));
  if (report.outcome !== "blocked" || report.effects.ownerReports !== 1 || report.effects.repeatedTurns !== 0)
    throw new Error("Drill report did not prove fail-closed settlement");
  console.log(join(proof, "report.json"));
} else if (mode === "--live" || mode === "--audit-sandbox") {
  const file = process.argv[3];
  if (!file || !existsSync(file)) throw new Error("Set a named drill config path; destination, host and credential reference are required");
  const config = JSON.parse(readFileSync(file, "utf8"));
  if (!config.destination || !config.host || !config.credentialReference ||
    !config.worktree || !config.model || !config.thinking || !config.botConfig?.limits ||
    !config.botConfig?.originBotId || !config.botConfig?.workerBotId || !config.botConfig?.reviewerBotId ||
    !config.botConfig?.modelSelection?.instanceId || config.botConfig.modelSelection.model !== config.model ||
    !Number.isSafeInteger(config.botConfig.maxIterations) || config.botConfig.maxIterations <= 0 ||
    !Number.isSafeInteger(config.botConfig.limits.maxWallTimeMs) || config.botConfig.limits.maxWallTimeMs <= 0 ||
    !Number.isFinite(config.botConfig.limits.maxSpendUsd) || config.botConfig.limits.maxSpendUsd <= 0 ||
    !/^[0-9a-f]{40}$/.test(config.baseRevision ?? "") || !config.expectedRevisions?.length) {
    throw new Error("Refusing incomplete or unconfirmed sandbox drill configuration");
  }
  if (mode === "--live") throw new Error("Live drill is owner-held until this PR merges green; no sandbox was created or contacted");
  const localFixture = config.host === "fixture" && config.destination === "fixture/agents" &&
    resolve(config.worktree).startsWith(join(root, "node_modules", ".cache") + "/");
  if (!localFixture && (config.host !== "mac-mini" || config.destination !== "evoclock/omb-drill-sandbox"))
    throw new Error("Host or destination does not match the selected sandbox");
  const git = (...args) => execFileSync("git", args, { cwd: config.worktree, encoding: "utf8", timeout: 10_000 }).trim();
  const origin = git("remote", "get-url", "origin");
  if (origin !== `git@github.com:${config.destination}.git` && origin !== `https://github.com/${config.destination}.git`)
    throw new Error("Sandbox worktree origin does not match the confirmed destination");
  const head = git("rev-parse", "HEAD");
  git("merge-base", "--is-ancestor", config.baseRevision, head);
  const actualRevisions = git("rev-list", `${config.baseRevision}..${head}`).split("\n");
  if (actualRevisions.length !== config.expectedRevisions.length ||
    actualRevisions.some((revision) => !config.expectedRevisions.includes(revision)))
    throw new Error("Sandbox history differs from exact reviewed revisions; squash or extra commit");
  for (const revision of config.expectedRevisions) {
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Invalid expected revision");
    git("merge-base", "--is-ancestor", revision, head);
    const identity = git("show", "-s", "--format=%an <%ae>|%cn <%ce>", revision);
    if (identity !== "evoclock <52983349+evoclock@users.noreply.github.com>|evoclock <52983349+evoclock@users.noreply.github.com>")
      throw new Error("Unattributed bot commit or merge");
  }
  const history = git("rev-list", "--parents", head).split("\n");
  for (const entry of history) {
    const [revision, ...parents] = entry.split(" ");
    const identity = git("show", "-s", "--format=%an <%ae>|%cn <%ce>", revision);
    if (identity !== "evoclock <52983349+evoclock@users.noreply.github.com>|evoclock <52983349+evoclock@users.noreply.github.com>")
      throw new Error(`Unattributed sandbox commit or merge: ${revision}`);
    if (parents.length > 1 && !config.expectedRevisions.includes(revision))
      throw new Error("Unreviewed merge commit in sandbox history");
  }
  console.log(JSON.stringify({ destination: config.destination, head, verifiedRevisions: config.expectedRevisions,
    mergeCommits: history.filter((line) => line.split(" ").length > 2).length,
    squash: false, criterion: "all expected exact revisions remain ancestors; no replacements" }));
} else {
  throw new Error("Usage: node scripts/drill-coding-run.mjs --fixture-real-worker | --fixture | --live CONFIG | --audit-sandbox CONFIG");
}
