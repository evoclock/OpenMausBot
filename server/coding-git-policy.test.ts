import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { codingGitToolScope, createCodingGitPolicy, createCodingGitRunPolicy, type CodingGitPort, type CodingGitRequest, type RepositoryFacts } from "./coding-git-policy.ts";
import { codingRunIdForRequest, codingTurnToolScope } from "./coding-production.ts";
import { allowsTool } from "../shared/tool-scope.ts";
import { codingGitDestinationSchema, type CodingGitCredential, type CodingGitDestination } from "./coding-run-config.ts";
import { RunContractStore } from "./run-contract.ts";
import { createProductionCodingGitHost } from "./coding-git-host.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const repository = "evoclock/fixture";
const author = { name: "evoclock", email: "52983349+evoclock@users.noreply.github.com" };
const grant: CodingGitDestination = { repository, branchPrefix: "bot/",
  credential: { kind: "fine-grained-token", reference: "fixture-grant" } };
const request: CodingGitRequest = { botId: "worker", repository, workspace: "fixture", branch: "bot/review", action: "push" };
const facts: RepositoryFacts = { nameWithOwner: repository, visibility: "private", defaultBranch: "trunk",
  protectedBranches: ["trunk", "bot/protected"], remoteUrls: ["fixture-remote"], viewerPermission: "WRITE",
  pullRequest: { number: 7, base: "trunk", head: "bot/review", draft: true, checksGreen: true } };

function harness() {
  let current = { ...facts };
  let destination = grant;
  let remote = "fixture-remote";
  let branch = "bot/review";
  let authors = [author];
  let credentialAllowed = true;
  let groups = { public: { reference: "public-group", visibility: "public" as const, repositories: [repository] } };
  const actions: string[] = [];
  const prOptions: Array<{ draft: true; prNumber?: number }> = [];
  const port: CodingGitPort = {
    async origin() { return remote; }, async branch() { return branch; }, async createBranch() {},
    async head() { return "a".repeat(40); }, async outgoingAuthors() { return authors; },
    async push(_workspace, _remote, _revision, ref) { actions.push(`push:${ref}`); },
    async pullRequest(action, _repo, _base, _head, _credential, options) { actions.push(action); prOptions.push(options); },
    async recordOwnerMerge(_run, _repo, reason, method) { actions.push(`owner:${method}:${reason}`); },
  };
  const policy = () => createCodingGitPolicy({ destinations: { worker: [destination] },
    groups,
    async inspect() { return current; }, credentials: { async canWrite() { return credentialAllowed; } }, port });
  return { policy, port, actions, prOptions, setFacts(next: Partial<RepositoryFacts>) { current = { ...current, ...next }; },
    setGrant(next: CodingGitDestination) { destination = next; },
    setRemote(value: string) { remote = value; }, setBranch(value: string) { branch = value; },
    setAuthors(value: typeof authors) { authors = value; }, denyCredential() { credentialAllowed = false; },
    setGroupReference(reference: string) { groups = { public: { ...groups.public, reference } }; } };
}

async function denied(h: ReturnType<typeof harness>, input: CodingGitRequest, pattern: RegExp) {
  const before = [...h.actions];
  await assert.rejects(h.policy()(input), pattern);
  assert.deepEqual(h.actions, before);
}

test("production Git host resolves an App installation and creates the checked port", async () => {
  const calls: string[] = [];
  let gitInvocation: { args: string[]; cwd: string; env: NodeJS.ProcessEnv } | undefined;
  const host = createProductionCodingGitHost({ repositoryRoot: "fixture", registrations: [],
    gitDestinations: { worker: [{ ...grant, credential: { kind: "github-app", reference: "app" } }] },
    gitAppInstallations: { app: { appId: 1, installationId: 2, privateKeyPath: "/fixture/key.pem",
      repositories: [repository], visibility: "private" } },
  }, { credentials: { async canWrite() { return true; } }, scopedToken: async () => "fixture-token",
    runGit: async (args, cwd, env) => {
      if (args.includes("push")) gitInvocation = { args, cwd, env };
      if (args[0] === "config" && args[1] === "--get" && args[2]?.endsWith(".remote")) return "origin";
      if (args[0] === "config" && args[1] === "--get" && args[2]?.endsWith(".merge")) {
        const branch = args[2].slice("branch.".length, -".merge".length);
        return `refs/heads/${branch}`;
      }
      if (args.includes("push")) {
        const askpass = env.GIT_ASKPASS ?? "";
        assert.ok(askpass.startsWith("/"), "GIT_ASKPASS must be one absolute executable path");
        assert.equal(askpass.includes("'"), false);
        assert.equal(/\s/.test(askpass), false);
        assert.ok(existsSync(askpass), "askpass wrapper must exist while git runs");
        assert.ok((statSync(askpass).mode & 0o111) !== 0, "askpass wrapper must be executable");
        assert.equal(execFileSync(askpass, ["Username for 'https://github.com'"], {
          encoding: "utf8", env: { ...process.env, ...env },
        }).trim(), "x-access-token");
      }
      if (args[0] === "branch" && args[1] === "--show-current") return "omb/coding-fixture";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "a".repeat(40);
      if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") return `https://github.com/${repository}.git`;
      return "";
    },
    gitHubRequest: (async (input, init) => {
      const url = new URL(String(input)); calls.push(`${init?.method ?? "GET"}:${url.pathname}`);
      if (url.pathname.endsWith("/pulls/77")) return new Response(JSON.stringify({ number: 77,
        base: { ref: "trunk" }, head: { ref: "bot/review" }, draft: true }), { status: 200 });
      if (url.pathname.endsWith("/ready_for_review")) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(url.pathname.endsWith("/branches")
        ? [{ name: "trunk", protected: true }] : { full_name: repository, private: true,
          default_branch: "trunk", permissions: { push: false } }), { status: 200 });
    }) as typeof fetch });
  const facts = await host.inspect(repository);
  assert.equal(facts.viewerPermission, "WRITE");
  assert.deepEqual(facts.protectedBranches, ["trunk"]);
  assert.deepEqual(calls, [`GET:/repos/${repository}`, `GET:/repos/${repository}/branches`]);
  await host.port.pullRequest("pr-ready", repository, "trunk", "bot/review",
    { kind: "github-app", reference: "app" }, { draft: true, prNumber: 77 });
  assert.deepEqual(calls.slice(-2), [`GET:/repos/${repository}/pulls/77`, `POST:/repos/${repository}/pulls/77/ready_for_review`]);
  await host.port.push("/fixture", `https://github.com/${repository}.git`, "a".repeat(40),
    "refs/heads/bot/review", { kind: "github-app", reference: "app" }, repository);
  assert.equal(gitInvocation?.cwd, "/fixture");
  assert.deepEqual(gitInvocation?.args.slice(-3), ["push", `https://github.com/${repository}.git`,
    `${"a".repeat(40)}:refs/heads/bot/review`]);
  await host.port.push("/fixture", `https://github.com/${repository}.git`, "a".repeat(40),
    "refs/heads/omb/coding-fixture", { kind: "github-app", reference: "app" }, repository, { setUpstream: true });
  assert.deepEqual(gitInvocation?.args.slice(-4), ["push", "--set-upstream", "origin",
    "omb/coding-fixture:refs/heads/omb/coding-fixture"]);
  assert.equal(Object.values(gitInvocation?.env ?? {}).includes("fixture-token"), false);
  assert.equal(typeof host.credentials.canWrite, "function");
  assert.equal(typeof host.port.push, "function");
  assert.equal(typeof host.port.pullRequest, "function");
});

test("production Git host reads outgoing authors with a narrow remote fetch refspec", async () => {
  const cache = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "git-host-narrow-fetch-"));
  const bare = join(dir, "origin.git");
  const root = join(dir, "root");
  const slot = join(dir, "slot");
  mkdirSync(root);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git(dir, "init", "--bare", "--initial-branch=main", bare);
    git(root, "init", "-b", "main");
    git(root, "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "--allow-empty", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");
    git(root, "push", bare, `${base}:refs/heads/main`);
    git(dir, "clone", "--branch", "main", bare, slot);
    git(slot, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
    const branch = "omb/coding-fixture";
    git(slot, "switch", "-c", branch);
    const head = git(slot, "rev-parse", "HEAD");
    const host = createProductionCodingGitHost({ repositoryRoot: root, registrations: [] }, {
      scopedToken: async () => "fixture-token",
      runGit: async (args, cwd, env) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim(),
    });
    await host.port.push(slot, bare, head, `refs/heads/${branch}`,
      { kind: "fine-grained-token", reference: "fixture" }, repository, { setUpstream: true });
    git(slot, "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "--allow-empty", "-m", "change");
    assert.deepEqual(await host.port.outgoingAuthors(slot, bare, branch), [author]);
  } finally { await removeTempDir(dir); }
});

test("configured mixed-case evoclock repositories are allowed without widening the owner", async () => {
  const h = harness();
  const realName = "evoclock/OpenMausBot";
  h.setGrant({ ...grant, repository: realName });
  h.setFacts({ nameWithOwner: realName });
  assert.equal(await h.policy()({ ...request, repository: realName }), "applied");
  await denied(h, { ...request, repository: "other/OpenMausBot" }, /canonical/);
});

test("credential selection is explicit, unambiguous and names no token value", () => {
  assert.equal(codingGitDestinationSchema.safeParse({ ...grant, credential: {} }).success, false);
  assert.equal(codingGitDestinationSchema.safeParse({ ...grant,
    credential: { kind: "fine-grained-group", group: "public", reference: "accidental-secret" } }).success, false);
  assert.equal(codingGitDestinationSchema.safeParse({ ...grant,
    credential: { kind: "github-app", reference: "installation" } }).success, true);
});

test("coding bots receive only closed worktree tools, not shell or MCP executors", () => {
  const scope = codingGitToolScope(undefined);
  for (const name of ["bash", "exec", "codemode", "tool_search"])
    assert.equal(allowsTool(scope, { kind: "native", name }), false);
  assert.equal(allowsTool(scope, { kind: "mcp", server: "custom", name: "execute" }), false);
  assert.equal(allowsTool(scope, { kind: "native", name: "edit" }), true);
  const narrower = codingGitToolScope({ allow: ["native:read"] });
  assert.equal(allowsTool(narrower, { kind: "native", name: "read" }), true);
  assert.equal(allowsTool(narrower, { kind: "native", name: "edit" }), true);
  assert.equal(allowsTool(narrower, { kind: "native", name: "coding_command" }), true);
  const config = { repositoryRoot: "fixture", registrations: [{ routineId: "routine", workerBotId: "worker",
    reviewerBotId: "reviewer", developmentRole: "dev", reviewRole: "review", repository,
    ref: "trunk", successCriteria: ["verified"], checkCommand: ["node", "-e", "process.exit(0)"] }] };
  assert.equal(codingTurnToolScope(config, "other", undefined), undefined);
  assert.equal(allowsTool(codingTurnToolScope(config, "worker", undefined), { kind: "native", name: "bash" }), false);
  assert.equal(allowsTool(codingTurnToolScope(config, "reviewer", undefined), { kind: "native", name: "bash" }), false);
});

test("unknown destination, wrong remote, mismatched visibility and missing credential refuse before effects", async () => {
  const h = harness();
  await denied(h, { ...request, botId: "unconfigured" }, /destination grant/);
  h.setRemote("fixture-remote.evil");
  await denied(h, request, /remote/);
  h.setRemote("https://github.com/evoclock/fixture.git@evil.example/fixture.git");
  await denied(h, request, /remote/);
  h.setRemote("fixture-remote");
  h.setGrant({ ...grant, visibility: "private" });
  h.setFacts({ visibility: "public" });
  await denied(h, request, /visibility/);
  h.setFacts({ visibility: "private" });
  h.denyCredential();
  await denied(h, request, /write grant/);
});

test("default, main, protected and refspec tricks never authorize a push", async () => {
  const h = harness();
  for (const name of ["HEAD:main", "+main", "refs/heads/main", " bot/review", "bot/review ", "BOT/review"])
    await denied(h, { ...request, branch: name }, /canonical/);
  h.setGrant({ ...grant, branchPrefix: "m" });
  h.setBranch("main");
  await denied(h, { ...request, branch: "main" }, /main, default or protected/);
  h.setGrant({ ...grant, branchPrefix: "t" });
  h.setBranch("trunk");
  await denied(h, { ...request, branch: "trunk" }, /main, default or protected/);
  h.setGrant({ ...grant, branchPrefix: "bot/" });
  h.setBranch("bot/protected");
  await denied(h, { ...request, branch: "bot/protected" }, /main, default or protected/);
  h.setBranch("bot/review");
  h.setFacts({ defaultBranch: "Main", protectedBranches: ["Main"] });
  await denied(h, { ...request, branch: "bot/review", base: "Main", action: "pr-open", draft: true }, /unverified/);
});

test("group and App providers require explicit scoped grants and evoclock authorship", async () => {
  const h = harness();
  h.setGrant({ ...grant, credential: { kind: "fine-grained-group", group: "unknown" } });
  await denied(h, request, /credential group/);
  h.setGrant({ ...grant, credential: { kind: "fine-grained-group", group: "public" } });
  await denied(h, request, /credential group/);
  h.setFacts({ visibility: "public" });
  h.setGroupReference("");
  await denied(h, request, /credential group/);
  h.setGroupReference("public-group");
  h.setGrant({ ...grant, repository: "evoclock/other", credential: { kind: "fine-grained-group", group: "public" } });
  h.setFacts({ nameWithOwner: "evoclock/other" });
  await denied(h, { ...request, repository: "evoclock/other" }, /credential group/);
  h.setGrant({ ...grant, credential: { kind: "fine-grained-group", group: "public" } });
  h.setFacts({ nameWithOwner: repository });
  assert.equal(await h.policy()(request), "applied");
  h.actions.length = 0;
  h.setGrant({ ...grant, credential: { kind: "github-app", reference: "app-installation" } });
  h.setAuthors([{ name: "github[bot]", email: "app@example.test" }]);
  await denied(h, request, /verified Git author/);
  h.setAuthors([author, { name: "other", email: author.email }]);
  await denied(h, request, /verified Git author/);
  h.setAuthors([author]);
  assert.equal(await h.policy()(request), "applied");
});

test("PR opens as draft; update and ready are allowed; public merge and squash refuse", async () => {
  const h = harness();
  const pr = { ...request, action: "pr-open" as const, base: "trunk" };
  await denied(h, { ...pr, draft: false }, /draft/);
  assert.equal(await h.policy()({ ...pr, draft: true }), "applied");
  await denied(h, { ...pr, action: "pr-ready" }, /identity/);
  await denied(h, { ...pr, action: "pr-update", prNumber: 8 }, /identity/);
  h.setFacts({ pullRequest: { ...facts.pullRequest!, head: "bot/other" } });
  await denied(h, { ...pr, action: "pr-update", prNumber: 7 }, /identity/);
  h.setFacts({ pullRequest: facts.pullRequest });
  assert.equal(await h.policy()({ ...pr, action: "pr-update", prNumber: 7 }), "applied");
  assert.equal(await h.policy()({ ...pr, action: "pr-ready", prNumber: 7 }), "applied");
  h.setFacts({ pullRequest: { ...facts.pullRequest!, draft: false } });
  await denied(h, { ...pr, action: "pr-ready", prNumber: 7 }, /not a draft/);
  h.setFacts({ pullRequest: facts.pullRequest });
  assert.deepEqual(h.actions, ["pr-open", "pr-update", "pr-ready"]);
  assert.deepEqual(h.prOptions, [{ draft: true }, { draft: true, prNumber: 7 }, { draft: true, prNumber: 7 }]);
  h.actions.length = 0;
  h.setFacts({ visibility: "public" });
  const merge = { ...pr, action: "pr-merge" as const, prNumber: 7, runId: "run-1",
    unblockReason: "This unblocks further development", mergeMethod: "merge" as const };
  await denied(h, merge, /public.*forbidden/);
  h.setFacts({ visibility: "private", pullRequest: { ...facts.pullRequest!, checksGreen: false } });
  await denied(h, merge, /every.*check/);
  h.setFacts({ pullRequest: { ...facts.pullRequest!, checksGreen: undefined } });
  await denied(h, merge, /every.*check/);
  h.setFacts({ pullRequest: { ...facts.pullRequest!, checksGreen: true } });
  await denied(h, { ...merge, unblockReason: "ship now" }, /unblock reason/);
  await denied(h, { ...merge, mergeMethod: "squash" }, /squash/);
  assert.equal(await h.policy()(merge), "owner-eligible");
  assert.deepEqual(h.actions, ["owner:merge:This unblocks further development"]);
});

test("a private merge eligibility reason is stored on the verified coding run", async () => {
  const cache = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const path = join(mkdtempSync(join(cache, "git-policy-merge-")), "runtime.db");
  const store = new RunContractStore(path);
  const runId = "11111111-1111-4111-8111-111111111111";
  store.create({ id: runId, botId: "worker", repository, ref: "bot/review",
    successCriteria: ["verified"], checkCommand: ["node", "-e", "process.exit(0)"], repositoryClass: "agent-private", allowedEffects: ["edit"],
    authorisedExternalWrites: [] }, 1);
  store.transition(runId, "running", 2);
  store.transition(runId, "done", 3, ["review verified"], { command: ["node", "-e", "process.exit(0)"], exitCode: 0,
    commitSha: "fixture", startedAt: 2, durationMs: 1, timedOut: false, outputTail: "" });
  const h = harness();
  const { recordOwnerMerge: _unused, ...port } = h.port;
  const policy = createCodingGitRunPolicy({ repositoryRoot: "fixture", registrations: [],
    gitDestinations: { worker: [grant] } }, store, { port,
    async inspect() { return facts; }, credentials: { async canWrite() { return true; } } });
  try {
    assert.equal(await policy({ ...request, action: "pr-merge", base: "trunk", prNumber: 7, runId,
      unblockReason: "This unblocks further development", mergeMethod: "merge" }), "owner-eligible");
  } finally { store.close(); }
  const reopened = new RunContractStore(path);
  try { assert.equal(reopened.ownerMergeReason(runId)?.reason, "This unblocks further development"); }
  finally { reopened.close(); }
});

test("force, release, tags, publication and absent facts refuse", async () => {
  const h = harness();
  for (const action of ["force-push", "tag", "release", "publish"] as const) {
    await denied(h, { ...request, action }, /not permitted/);
  }
  h.setFacts({ viewerPermission: "READ" });
  await denied(h, request, /unverified/);
  h.setFacts({ viewerPermission: "WRITE", protectedBranches: [] });
  await denied(h, { ...request, action: "pr-open", base: "trunk", draft: true }, /protected/);
});

test("checked push reaches a real local bare repository with a canonical ref", async () => {
  const cache = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "git-policy-"));
  const bare = join(dir, "remote.git");
  const work = join(dir, "work");
  mkdirSync(work);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git(dir, "init", "--bare", "--initial-branch=trunk", bare);
  git(work, "init", "-b", "trunk");
  git(work, "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "--allow-empty", "-m", "fixture base");
  const base = git(work, "rev-parse", "HEAD");
  git(work, "push", bare, `${base}:refs/heads/trunk`);
  git(work, "remote", "add", "origin", bare);
  git(work, "switch", "-c", "bot/review");
  git(work, "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "--allow-empty", "-m", "fixture change");
  const port: CodingGitPort = {
    async origin(cwd) { return git(cwd, "remote", "get-url", "origin"); },
    async branch(cwd) { return git(cwd, "branch", "--show-current"); }, async createBranch() {},
    async head(cwd) { return git(cwd, "rev-parse", "HEAD"); },
    async outgoingAuthors(cwd) { return git(cwd, "log", "trunk..HEAD", "--format=%an%x00%ae").split("\n")
      .map((line) => { const [name, email] = line.split("\0"); return { name, email }; }); },
    async push(cwd, remote, revision, ref) { git(cwd, "push", remote, `${revision}:${ref}`); },
    async pullRequest() { throw new Error("fixture does not contact a forge"); },
    async recordOwnerMerge() { throw new Error("fixture does not merge"); },
  };
  const policy = createCodingGitPolicy({ destinations: { worker: [grant] },
    async inspect() { return { ...facts, remoteUrls: [bare] }; },
    credentials: { async canWrite(credential: CodingGitCredential) {
      return credential.kind === "fine-grained-token" && credential.reference === "fixture-grant";
    } }, port });
  assert.equal(await policy({ ...request, workspace: work }), "applied");
  const revision = git(work, "rev-parse", "HEAD");
  assert.equal(git(bare, "rev-parse", "refs/heads/bot/review"), revision);
  assert.equal(git(bare, "rev-parse", "refs/heads/trunk"), base);
  if (process.env.OMB_GIT_POLICY_PROOF_DIR) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(process.env.OMB_GIT_POLICY_PROOF_DIR, "bare-push.txt"),
      `bare branch bot/review: ${revision}\nprotected base trunk: ${base}\n`);
  }
});

test("review turns reuse the run id the closed Pi profile accepts", () => {
  const runId = "24421e77-046b-5e9b-8162-b06f26914964";
  const review = codingRunIdForRequest(`review:${runId}:816360d21b9dfb2f569343f47638fd3a398da697`);
  assert.equal(review, runId);
  assert.equal(codingRunIdForRequest(runId), runId);
  // Same pattern pi-mcp-extension enforces before loading a closed coding profile.
  assert.match(review, /^[a-zA-Z0-9_-]{1,128}$/);
});
