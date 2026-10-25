import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
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
    await assert.rejects(workspace.release("unknown-lease"), /cannot be verified/);
    const db2 = new DatabaseSync(join(dir, "coding-workspaces.sqlite"));
    db2.prepare("UPDATE coding_workspaces SET lease_id = ? WHERE request_id = ?").run("different-lease", "task-1");
    db2.close();
    await assert.rejects(workspace.release("fake-lease"), /does not belong/);
  } finally { workspace.close(); }
});

test.each(["clean", "dirty", "bundle-failure", "unpushed-clean", "ignored", "ignored-unreadable"])("release reconciles %s workspace before guarded return", async (condition) => {
  const root = process.cwd();
  const dir = mkdtempSync(join(root, "node_modules", ".cache", "coding-release-"));
  const fakeTreehouse = join(dir, "treehouse.mjs");
  const fakeGit = join(dir, "git.mjs");
  const log = join(dir, "calls.log");
  const slot = join(dir, "slot");
  mkdirSync(slot);
  if (condition === "ignored") writeFileSync(join(slot, "ignored.txt"), "preserve ignored work");
  const common = realpathSync(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim());
  writeFileSync(fakeTreehouse, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nconst a = process.argv.slice(2);\nif (a[0] === 'status') console.log(JSON.stringify([{path:${JSON.stringify(slot)},status:'leased',lease_id:'lease-1',lease_holder:'omb-coding-'+requireHash()}]));\nelse if (a[0] === 'return') appendFileSync(${JSON.stringify(log)}, 'return '+a.join(' ')+'\\n');\nelse if (a[0] === 'get') console.log(JSON.stringify({path:${JSON.stringify(slot)},lease_id:'lease-1'}));\nfunction requireHash(){return ${JSON.stringify(createHash("sha256").update("request-1").digest("hex").slice(0, 24))}}\n`);
  writeFileSync(fakeGit, `#!/usr/bin/env node\nimport { appendFileSync, existsSync, writeFileSync } from 'node:fs';\nconst a=process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)}, 'git '+a.join(' ')+'\\n');\nif(a[0]==='rev-parse') console.log(a.includes('--git-common-dir') ? ${JSON.stringify(common)} : ${JSON.stringify(condition === "unpushed-clean" ? "HEAD" : ["clean", "ignored", "ignored-unreadable"].includes(condition) ? "main" : "openai-work/fixture")});\nelse if(a[0]==='merge-base' && ${JSON.stringify(condition === "unpushed-clean")}) process.exit(1);\nelse if(a[0]==='status') console.log(existsSync(${JSON.stringify(join(dir, "committed"))}) ? '' : ${JSON.stringify(condition === "dirty" || condition === "bundle-failure" ? " M file.txt" : "")});
else if(a[0]==='ls-files' && ${JSON.stringify(condition === "ignored" || condition === "ignored-unreadable")}) process.stdout.write('ignored.txt\\0');\nelse if(a[0]==='-c') writeFileSync(${JSON.stringify(join(dir, "committed"))}, 'yes');\n\nelse if(a[0]==='bundle' && a[1]==='create') writeFileSync(a[2], 'bundle');\nelse if(a[0]==='bundle' && a[1]==='verify' && ${JSON.stringify(condition === "bundle-failure")}) process.exit(1);\n`);
  chmodSync(fakeTreehouse, 0o755);
  chmodSync(fakeGit, 0o755);
  const workspace = new CodingTreehouseWorkspace({ repository: contract.repository, root, dataDir: dir,
    executable: fakeTreehouse, gitExecutable: fakeGit, salvageDir: join(dir, "salvage") });
  const db = new DatabaseSync(join(dir, "coding-workspaces.sqlite"));
  db.prepare("INSERT INTO coding_workspaces (request_id, contract, path, lease_id, base_sha) VALUES (?, ?, ?, ?, ?)")
    .run("request-1", JSON.stringify(contract), slot, "lease-1", "fixture-base");
  db.close();
  try {
    if (condition === "bundle-failure" || condition === "ignored-unreadable") await assert.rejects(workspace.release("lease-1"));
    else await workspace.release("lease-1");
    const calls = readFileSync(log, "utf8");
    if (condition === "bundle-failure" || condition === "ignored-unreadable") assert.doesNotMatch(calls, /return /);
    else assert.match(calls, /return .*--if-lease-id lease-1 --if-lease-holder omb-coding-/);
    assert.equal(calls.includes("git bundle create"), !["clean", "ignored", "ignored-unreadable"].includes(condition));
    if (condition === "unpushed-clean") assert.match(calls, /git switch -c openai-work\/main-/);
    if (condition === "ignored") {
      const folder = readdirSync(join(dir, "salvage")).find((name) => name.startsWith("ignored-"));
      assert.equal(readFileSync(join(dir, "salvage", folder!, "ignored.txt"), "utf8"), "preserve ignored work");
      assert.match(calls, /git ls-files --others --ignored --exclude-standard -z/);
    }
    if (condition === "dirty") {
      assert.ok(existsSync(join(dir, "salvage", "fixture.bundle")));
      assert.match(readFileSync(join(dir, "salvage", "INDEX.md"), "utf8"), /openai-work\/fixture/);
    }
  } finally { workspace.close(); }
});
