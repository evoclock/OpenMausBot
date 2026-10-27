import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { removeTempDir } from "./testing/cleanup.ts";
import { CodingTreehouseWorkspace } from "./coding-treehouse-workspace.ts";

const contract = { id: "00000000-0000-4000-8000-000000000001", botId: "bot", repository: "fixture/agents", ref: "main",
  repositoryClass: "agent-private" as const, successCriteria: ["done"], allowedEffects: ["edit" as const, "push" as const] };

test("a task reacquires its lease without another get or pushing recovered commits", async () => {
  const root = realpathSync(process.cwd());
  const cache = join(root, ".omb-scratch", "coding-treehouse-tests");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "coding-treehouse-"));
  const alternate = join(dir, "leased-slot");
  const bare = join(dir, "origin.git");
  mkdirSync(alternate);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args,
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git(dir, "init", "--bare", "--initial-branch=main", bare);
  git(alternate, "init", "-b", "main");
  git(alternate, "remote", "add", "origin", bare);
  git(alternate, "config", "user.name", "evoclock");
  git(alternate, "config", "user.email", "52983349+evoclock@users.noreply.github.com");
  writeFileSync(join(alternate, "base.txt"), "base\n");
  git(alternate, "add", "base.txt");
  git(alternate, "commit", "-m", "base");
  git(alternate, "push", "--set-upstream", "origin", "main");
  git(alternate, "checkout", "--detach", "main");
  const executable = join(dir, "fake-treehouse.mjs");
  const state = join(dir, "state.json");
  const log = join(dir, "gets.log");
  const branchFile = join(dir, "branch.txt");
  writeFileSync(executable, `#!/usr/bin/env node\nimport { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';\nconst path = ${JSON.stringify(alternate)};\nconst state = ${JSON.stringify(state)};\nconst log = ${JSON.stringify(log)};\nconst branchFile = ${JSON.stringify(branchFile)};\nconst args = process.argv.slice(2);\nif (args[0] === 'status') {\n const holder = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')).holder : null;\n console.log(JSON.stringify(holder ? [{ path, status: 'leased', lease_id: 'fake-lease', lease_holder: holder }] : []));\n} else if (args[0] === 'get') {\n const holder = args[args.indexOf('--lease-holder') + 1];\n const branchIndex = args.indexOf('--branch');\n writeFileSync(branchFile, branchIndex < 0 ? '' : args[branchIndex + 1]);\n appendFileSync(log, 'get\\n');\n writeFileSync(state, JSON.stringify({ holder }));\n console.log(JSON.stringify({ path, lease_id: 'fake-lease' }));\n} else if (args[0] === 'return') {\n if (args[args.indexOf('--if-lease-id') + 1] !== 'fake-lease') process.exit(2);\n writeFileSync(state, JSON.stringify({ holder: null }));\n} else process.exit(1);\n`);
  chmodSync(executable, 0o755);
  const pushCalls: string[] = [];
  const checks = { verifyRepository: () => true, verifySlot: () => true,
    readRevision: (path: string, ref: string) => git(path, "rev-parse", ref),
    readStatus: (path: string) => git(path, "status", "--porcelain", "--untracked-files=all"),
    async pushWorkspaceBranch({ directory, branch }: { directory: string; branch: string }) {
      pushCalls.push(branch);
      git(directory, "push", "--set-upstream", "origin", branch);
    } };
  const requestId = `${contract.id}:1`;
  const expectedBranch = `omb/coding-${createHash("sha256").update(requestId).digest("hex").slice(0, 24)}`;
  let workspace = new CodingTreehouseWorkspace({ repository: contract.repository, root, dataDir: dir, executable,
    ...checks });
  const first = await workspace.acquire(contract, requestId);
  const base = git(alternate, "rev-parse", "HEAD");
  assert.deepEqual(workspace.findForRun(contract.id), { repository: contract.repository, directory: alternate,
    branch: expectedBranch, baseBranch: contract.ref, base, leaseId: "fake-lease" });
  workspace.close();
  const reopenedDb = new DatabaseSync(join(dir, "coding-workspaces.sqlite"));
  reopenedDb.prepare("UPDATE coding_workspaces SET path = NULL, lease_id = NULL WHERE request_id = ?").run(requestId);
  reopenedDb.close();
  workspace = new CodingTreehouseWorkspace({ repository: contract.repository, root, dataDir: dir, executable,
    ...checks });
  try {
    assert.deepEqual(await workspace.acquire(contract, requestId), first);
    assert.equal(readFileSync(branchFile, "utf8"), expectedBranch);
    await assert.rejects(workspace.acquire({ ...contract, ref: "--worktree-path" }, "task-2"), /not approved/);
    assert.equal(readFileSync(log, "utf8"), "get\n");
    await assert.rejects(workspace.acquire({ ...contract, ref: "other" }, requestId), /conflicts/);
    writeFileSync(join(alternate, "progress.txt"), "unpublished\n");
    git(alternate, "add", "progress.txt");
    git(alternate, "commit", "-m", "unpublished");
    git(alternate, "branch", "--unset-upstream");
    workspace.close();
    const retryDb = new DatabaseSync(join(dir, "coding-workspaces.sqlite"));
    retryDb.prepare("UPDATE coding_workspaces SET path = NULL, lease_id = NULL WHERE request_id = ?").run(requestId);
    retryDb.close();
    workspace = new CodingTreehouseWorkspace({ repository: contract.repository, root, dataDir: dir, executable,
      ...checks });
    await assert.rejects(workspace.acquire(contract, requestId), /unpublished commits/);
    assert.deepEqual(pushCalls, [expectedBranch]);
    assert.equal(git(bare, "rev-parse", `refs/heads/${expectedBranch}`), base);
    await assert.rejects(workspace.release("unknown-lease"), /cannot be verified/);
    const db2 = new DatabaseSync(join(dir, "coding-workspaces.sqlite"));
    db2.prepare("UPDATE coding_workspaces SET lease_id = ? WHERE request_id = ?").run("different-lease", requestId);
    db2.close();
    await assert.rejects(workspace.release("fake-lease"), /does not belong/);
  } finally { workspace.close(); }
});

test("first acquire records the upstream tip when local main lags a clean slot", async () => {
  const root = process.cwd();
  const dir = mkdtempSync(join(root, "node_modules", ".cache", "coding-upstream-"));
  const slot = join(dir, "slot");
  mkdirSync(slot);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: slot, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("remote", "add", "origin", slot);
  writeFileSync(join(slot, "tracked.txt"), "original");
  git("add", "tracked.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "local base");
  const local = git("rev-parse", "HEAD");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "remote base");
  const tip = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", tip);
  git("branch", "--set-upstream-to=origin/main", "main");
  git("switch", "--detach", tip);
  git("branch", "-f", "main", local);
  const executable = join(dir, "treehouse.mjs");
  writeFileSync(executable, `#!/usr/bin/env node\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nconst state = ${JSON.stringify(join(dir, "holder"))};\nconst path = ${JSON.stringify(slot)};\nif (args[0] === 'status') {\n let holder; try { holder = readFileSync(state, 'utf8'); } catch {}\n console.log(JSON.stringify(holder ? [{ path, status: 'leased', lease_id: 'lease-1', lease_holder: holder }] : []));\n} else if (args[0] === 'get') {\n writeFileSync(state, args[args.indexOf('--lease-holder') + 1]);\n console.log(JSON.stringify({ path, lease_id: 'lease-1' }));\n} else process.exit(1);\n`);
  chmodSync(executable, 0o755);
  const workspace = new CodingTreehouseWorkspace({ repository: contract.repository, root, dataDir: dir,
    executable, verifyRepository: () => true, verifySlot: () => true,
    pushWorkspaceBranch: async ({ branch }) => {
      git("update-ref", `refs/remotes/origin/${branch}`, tip);
      git("config", `branch.${branch}.remote`, "origin");
      git("config", `branch.${branch}.merge`, `refs/heads/${branch}`);
    } });
  try {
    assert.equal(git("rev-parse", "main"), local);
    assert.equal(git("rev-parse", "main@{upstream}"), tip);
    assert.equal(git("status", "--porcelain"), "");
    const request = { ...contract, allowedEffects: ["edit", "push"] as Array<"edit" | "push"> };
    writeFileSync(join(slot, "tracked.txt"), "dirty");
    await assert.rejects(workspace.acquire(request, "upstream-task"), /base cannot be recovered/);
    writeFileSync(join(slot, "tracked.txt"), "original");
    git("switch", "--detach", local);
    await assert.rejects(workspace.acquire(request, "upstream-task"), /base cannot be recovered/);
    git("switch", "--detach", tip);
    assert.equal((await workspace.acquire(request, "upstream-task")).base, tip);
    const db = new DatabaseSync(join(dir, "coding-workspaces.sqlite"));
    try {
      assert.equal((db.prepare("SELECT base_sha FROM coding_workspaces WHERE request_id = ?")
        .get("upstream-task") as { base_sha: string }).base_sha, tip);
    } finally { db.close(); }
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

test("acquire creates and pushes a named upstream branch when Treehouse returns a detached slot", async () => {
  const cache = join(process.cwd(), ".omb-scratch", "coding-treehouse-tests");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "coding-branch-"));
  const root = join(dir, "root");
  const bare = join(dir, "origin.git");
  const slot = join(dir, "slot");
  mkdirSync(root);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args,
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let workspace: CodingTreehouseWorkspace | undefined;
  try {
    git(dir, "init", "--bare", "--initial-branch=main", bare);
    git(root, "init", "-b", "main");
    git(root, "remote", "add", "origin", bare);
    writeFileSync(join(root, "TASKS.md"), "base\n");
    git(root, "add", "TASKS.md");
    git(root, "-c", "user.name=evoclock", "-c", "user.email=52983349+evoclock@users.noreply.github.com", "commit", "-m", "base");
    git(root, "push", "--set-upstream", "origin", "main");
    git(dir, "clone", "--branch", "main", bare, slot);
    git(slot, "checkout", "--detach", "main");
    const state = join(dir, "state.json");
    const executable = join(dir, "fake-treehouse.mjs");
    const pushCalls: string[] = [];
    writeFileSync(executable, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const path = ${JSON.stringify(slot)};
const state = ${JSON.stringify(state)};
const args = process.argv.slice(2);
if (args[0] === 'status') {
 const holder = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')).holder : null;
 console.log(JSON.stringify(holder ? [{ path, status: 'leased', lease_id: 'coding-lease', lease_holder: holder }] : []));
} else if (args[0] === 'get') {
 const holder = args[args.indexOf('--lease-holder') + 1];
 writeFileSync(state, JSON.stringify({ holder }));
 console.log(JSON.stringify({ path, lease_id: 'coding-lease' }));
} else process.exit(1);
`, { mode: 0o755 });
    workspace = new CodingTreehouseWorkspace({
      repository: contract.repository, root, dataDir: join(dir, "data"), executable,
      verifyRepository: () => true, verifySlot: () => true,
      pushWorkspaceBranch: async ({ directory, branch }) => {
        pushCalls.push(branch);
        git(directory, "push", "--set-upstream", "origin", branch);
      },
    });
    const requestId = `${contract.id}:1`;
    const expectedBranch = `omb/coding-${createHash("sha256").update(requestId).digest("hex").slice(0, 24)}`;
    const acquired = await workspace.acquire(contract, requestId);
    assert.equal(acquired.branch, expectedBranch);
    assert.equal(acquired.baseBranch, contract.ref);
    assert.equal(git(slot, "branch", "--show-current"), expectedBranch);
    assert.equal(git(slot, "config", "--get", `branch.${expectedBranch}.remote`), "origin");
    assert.equal(git(slot, "config", "--get", `branch.${expectedBranch}.merge`), `refs/heads/${expectedBranch}`);
    assert.equal(git(bare, "rev-parse", `refs/heads/${expectedBranch}`), git(slot, "rev-parse", "HEAD"));
    assert.deepEqual(pushCalls, [expectedBranch]);
    assert.deepEqual(workspace.findForRun(contract.id), acquired);
  } finally {
    workspace?.close();
    await removeTempDir(dir);
  }
});

test("acquire binds upstream when remote.origin.fetch only tracks main", async () => {
  const cache = join(process.cwd(), ".omb-scratch", "coding-treehouse-tests");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "coding-narrow-fetch-"));
  const root = join(dir, "root");
  const bare = join(dir, "origin.git");
  const slot = join(dir, "slot");
  mkdirSync(root);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args,
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let workspace: CodingTreehouseWorkspace | undefined;
  try {
    git(dir, "init", "--bare", "--initial-branch=main", bare);
    git(root, "init", "-b", "main");
    git(root, "remote", "add", "origin", bare);
    writeFileSync(join(root, "TASKS.md"), "base\n");
    git(root, "add", "TASKS.md");
    git(root, "-c", "user.name=evoclock", "-c", "user.email=52983349+evoclock@users.noreply.github.com", "commit", "-m", "base");
    git(root, "push", "--set-upstream", "origin", "main");
    git(dir, "clone", "--branch", "main", bare, slot);
    git(slot, "checkout", "--detach", "main");
    git(slot, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
    const state = join(dir, "state.json");
    const executable = join(dir, "fake-treehouse.mjs");
    writeFileSync(executable, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const path = ${JSON.stringify(slot)};
const state = ${JSON.stringify(state)};
const args = process.argv.slice(2);
if (args[0] === 'status') {
 const holder = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')).holder : null;
 console.log(JSON.stringify(holder ? [{ path, status: 'leased', lease_id: 'coding-lease', lease_holder: holder }] : []));
} else if (args[0] === 'get') {
 const holder = args[args.indexOf('--lease-holder') + 1];
 writeFileSync(state, JSON.stringify({ holder }));
 console.log(JSON.stringify({ path, lease_id: 'coding-lease' }));
} else process.exit(1);
`, { mode: 0o755 });
    workspace = new CodingTreehouseWorkspace({
      repository: contract.repository, root, dataDir: join(dir, "data"), executable,
      verifyRepository: () => true, verifySlot: () => true,
      pushWorkspaceBranch: async ({ directory, branch }) => {
        git(directory, "push", "--set-upstream", "origin", branch);
        git(directory, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
      },
    });
    const requestId = `${contract.id}:narrow-fetch`;
    const expectedBranch = `omb/coding-${createHash("sha256").update(requestId).digest("hex").slice(0, 24)}`;
    const acquired = await workspace.acquire(contract, requestId);
    assert.equal(acquired.branch, expectedBranch);
    assert.equal(git(slot, "config", "--get", `branch.${expectedBranch}.remote`), "origin");
    assert.equal(git(slot, "config", "--get", `branch.${expectedBranch}.merge`), `refs/heads/${expectedBranch}`);
    assert.equal(git(slot, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
      `origin/${expectedBranch}`);
    assert.equal(git(slot, "merge-base", "--is-ancestor", "HEAD", "@{upstream}"), "");
    assert.deepEqual(workspace.findForRun(contract.id), acquired);
  } finally {
    workspace?.close();
    await removeTempDir(dir);
  }
});

