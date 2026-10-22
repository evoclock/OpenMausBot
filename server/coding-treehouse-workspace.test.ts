import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { CodingTreehouseWorkspace } from "./coding-treehouse-workspace.ts";

const contract = { id: "00000000-0000-4000-8000-000000000001", botId: "bot", repository: "fixture/agents", ref: "main",
  repositoryClass: "agent-private" as const, successCriteria: ["done"], allowedEffects: ["edit" as const] };

test("a task reacquires the same verified lease after reopening without a second get", async () => {
  const root = process.cwd();
  const cache = join(root, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "coding-treehouse-"));
  const alternate = join(dir, "leased-slot");
  mkdirSync(alternate);
  const executable = join(dir, "fake-treehouse.mjs");
  const state = join(dir, "state.json");
  const log = join(dir, "gets.log");
  writeFileSync(executable, `#!/usr/bin/env node\nimport { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';\nconst path = ${JSON.stringify(alternate)};\nconst state = ${JSON.stringify(state)};\nconst log = ${JSON.stringify(log)};\nconst args = process.argv.slice(2);\nif (args[0] === 'status') {\n const holder = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')).holder : null;\n console.log(JSON.stringify(holder ? [{ path, status: 'leased', lease_id: 'fake-lease', lease_holder: holder }] : []));\n} else if (args[0] === 'get') {\n const holder = args[args.indexOf('--lease-holder') + 1];\n appendFileSync(log, 'get\\n');\n writeFileSync(state, JSON.stringify({ holder }));\n console.log(JSON.stringify({ path, lease_id: 'fake-lease' }));\n} else if (args[0] === 'return') {\n if (args[args.indexOf('--if-lease-id') + 1] !== 'fake-lease') process.exit(2);\n writeFileSync(state, JSON.stringify({ holder: null }));\n} else process.exit(1);\n`);
  chmodSync(executable, 0o755);
  const checks = { verifyRepository: () => true, verifySlot: () => true,
    readRevision: () => "fixture-base", readStatus: () => "" };
  let workspace = new CodingTreehouseWorkspace({ repository: contract.repository, root, dataDir: dir, executable,
    ...checks });
  const first = await workspace.acquire(contract, "task-1");
  workspace.close();
  const db = new DatabaseSync(join(dir, "coding-workspaces.sqlite"));
  db.prepare("UPDATE coding_workspaces SET path = NULL, lease_id = NULL WHERE request_id = ?").run("task-1");
  db.close();
  workspace = new CodingTreehouseWorkspace({ repository: contract.repository, root, dataDir: dir, executable,
    ...checks });
  try {
    assert.deepEqual(await workspace.acquire(contract, "task-1"), first);
    await assert.rejects(workspace.acquire({ ...contract, ref: "--worktree-path" }, "task-2"), /not approved/);
    assert.equal(readFileSync(log, "utf8"), "get\n");
    await assert.rejects(workspace.acquire({ ...contract, ref: "other" }, "task-1"), /conflicts/);
    await assert.rejects(workspace.release("fake-lease", "worker route failed"), /owner-confirmed/);
    await workspace.release("fake-lease", "owner-confirmed integration");
  } finally { workspace.close(); }
});
