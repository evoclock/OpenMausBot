import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { CodingTreehouseWorkspace } from "./coding-treehouse-workspace.ts";

const contract = { id: "00000000-0000-4000-8000-000000000001", botId: "bot", repository: "fixture/agents", ref: "main",
  repositoryClass: "agent-private" as const, successCriteria: ["done"], allowedEffects: ["edit" as const] };

test("a task reacquires the same verified lease after reopening without a second get", async () => {
  const root = process.cwd();
  const entries = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" });
  const alternate = entries.match(/^worktree (.+)$/gm)?.map((line) => line.slice(9)).find((path) => path !== root);
  assert.ok(alternate, "fixture needs a second registered checkout");
  const cache = join(root, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "coding-treehouse-"));
  const executable = join(dir, "fake-treehouse.mjs");
  const state = join(dir, "state.json");
  const log = join(dir, "gets.log");
  writeFileSync(executable, `#!/usr/bin/env node\nimport { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';\nconst path = ${JSON.stringify(alternate)};\nconst state = ${JSON.stringify(state)};\nconst log = ${JSON.stringify(log)};\nconst args = process.argv.slice(2);\nif (args[0] === 'status') {\n const holder = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')).holder : null;\n console.log(JSON.stringify(holder ? [{ path, status: 'leased', lease_id: 'fake-lease', lease_holder: holder }] : []));\n} else if (args[0] === 'get') {\n const holder = args[args.indexOf('--lease-holder') + 1];\n appendFileSync(log, 'get\\n');\n writeFileSync(state, JSON.stringify({ holder }));\n console.log(JSON.stringify({ path, lease_id: 'fake-lease' }));\n} else process.exit(1);\n`);
  chmodSync(executable, 0o755);
  let workspace = new CodingTreehouseWorkspace({ repository: contract.repository, root, dataDir: dir, executable });
  const first = await workspace.acquire(contract, "task-1");
  workspace.close();
  const db = new DatabaseSync(join(dir, "coding-workspaces.sqlite"));
  db.prepare("UPDATE coding_workspaces SET path = NULL, lease_id = NULL WHERE request_id = ?").run("task-1");
  db.close();
  workspace = new CodingTreehouseWorkspace({ repository: contract.repository, root, dataDir: dir, executable });
  try {
    assert.deepEqual(await workspace.acquire(contract, "task-1"), first);
    await assert.rejects(workspace.acquire({ ...contract, ref: "--worktree-path" }, "task-2"), /not approved/);
    assert.equal(readFileSync(log, "utf8"), "get\n");
    await assert.rejects(workspace.acquire({ ...contract, ref: "other" }, "task-1"), /conflicts/);
  } finally { workspace.close(); }
});
