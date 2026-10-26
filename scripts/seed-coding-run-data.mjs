#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function prepareCodingSeed(config, routines, lease, agentsRoot, main, originMain, rolesFile) {
  if (!/^[a-f0-9]{40}$/.test(main) || main !== originMain) throw new Error("agents main must match origin/main");
  const entries = config.codingRuns?.registrations;
  if (entries?.length !== 1 || routines.routines?.length !== 1 ||
    entries[0].routineId !== routines.routines[0].id ||
    routines.routines[0].enabled !== false || routines.routines[0].schedule?.type !== "once") {
    throw new Error("seed requires one disabled registered one-shot routine");
  }
  if (rolesFile.schema !== "pstack-model-roles.v1" ||
    rolesFile.roles?.development !== entries[0].developmentRole ||
    rolesFile.roles?.["independent-review"] !== entries[0].reviewRole ||
    entries[0].developmentRole === entries[0].reviewRole || entries[0].workerBotId === entries[0].reviewerBotId) {
    throw new Error("seeded worker and reviewer routes do not match the registration");
  }
  const limits = config.codingRuns.bots?.[entries[0].workerBotId];
  if (limits?.modelAccess !== "subscription" || limits.maxSpendUsd !== undefined ||
    limits.maxWallTimeMs !== 45 * 60_000 || limits.maxIterations !== 8 ||
    limits.allowedFallbackModels?.length || limits.allowedFallbackDataRoutes?.length) {
    throw new Error("seed requires the approved no-spend 45-minute, eight-iteration budget");
  }
  const dataDir = join(lease, ".omb-scratch", "item-i-data");
  return {
    dataDir,
    config: { ...config, codingRuns: { ...config.codingRuns, repositoryRoot: agentsRoot,
      rolesFilePath: join(dataDir, "pi-roles.json"),
      registrations: [{ ...entries[0], ref: "main" }] } },
    routines: { version: routines.version, frozenResultsCleared: true,
      routines: routines.routines.map((routine) => ({ ...routine, enabled: false, nextRunAt: null })),
      runs: [], routineRequestReceipts: [], codingSettlementReceipts: [], webhookRunReceipts: [] },
  };
}

export function seedCodingRunData(leaseArg, sourceArg, agentsArg) {
  const lease = realpathSync(resolve(leaseArg));
  const source = realpathSync(resolve(sourceArg));
  const agentsRoot = realpathSync(resolve(agentsArg));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 }).trim();
  if (realpathSync(git(lease, "rev-parse", "--show-toplevel")) !== lease ||
    realpathSync(git(agentsRoot, "rev-parse", "--show-toplevel")) !== agentsRoot ||
    !lease.includes(`${sep}.treehouse${sep}`) || !source.includes(`${sep}.treehouse-salvage${sep}`)) {
    throw new Error("seed needs an exact Treehouse checkout, salvage source, and agents repository root");
  }
  const slots = JSON.parse(execFileSync("treehouse", ["status", "--json"],
    { cwd: lease, encoding: "utf8", timeout: 10_000 }));
  if (!slots.some((slot) => slot.status === "leased" && realpathSync(slot.path) === lease)) {
    throw new Error("the checkout has no active Treehouse lease");
  }
  const main = git(agentsRoot, "rev-parse", "refs/heads/main");
  const originMain = git(agentsRoot, "rev-parse", "refs/remotes/origin/main");
  const read = (name) => JSON.parse(readFileSync(join(source, name), "utf8"));
  const seed = prepareCodingSeed(read("config.json"), read("routines.json"), lease, agentsRoot, main, originMain,
    read("pi-roles.json"));
  if (existsSync(seed.dataDir)) throw new Error("destination data already exists; preserve it before seeding");
  mkdirSync(join(lease, ".omb-scratch"), { recursive: true, mode: 0o700 });
  mkdirSync(seed.dataDir, { mode: 0o700 });
  cpSync(join(source, "bots.json"), join(seed.dataDir, "bots.json"));
  cpSync(join(source, "bots"), join(seed.dataDir, "bots"), { recursive: true });
  cpSync(join(source, "providers"), join(seed.dataDir, "providers"), { recursive: true });
  cpSync(join(source, "pi-roles.json"), join(seed.dataDir, "pi-roles.json"));
  writeFileSync(join(seed.dataDir, "config.json"), `${JSON.stringify(seed.config, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(seed.dataDir, "routines.json"), `${JSON.stringify(seed.routines, null, 2)}\n`, { mode: 0o600 });
  if (realpathSync(seed.config.codingRuns.rolesFilePath) !== join(seed.dataDir, "pi-roles.json")) {
    throw new Error("seeded roles file is not in this lease");
  }
  return { dataDir: seed.dataDir, base: main, rolesFilePath: seed.config.codingRuns.rolesFilePath };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) throw new Error("Usage: node scripts/seed-coding-run-data.mjs LEASE SALVAGE_DATA AGENTS_REPO");
  console.log(JSON.stringify(seedCodingRunData(process.argv[2], process.argv[3], process.argv[4])));
}
