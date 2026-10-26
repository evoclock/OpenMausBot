import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHubAppCredentialProvider } from "./github-app-credential.ts";
import type { CodingGitCredential, CodingRunConfig } from "./coding-run-config.ts";
import type { CodingGitHost, CodingGitRequest, RepositoryFacts } from "./coding-git-policy.ts";

const REPOSITORY = /^evoclock\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;
type Dependencies = { request?: typeof fetch; runGit?: (args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;
  gitHubRequest?: typeof fetch; credentials?: CodingGitHost["credentials"];
  scopedToken?: (credential: CodingGitCredential, repository: string) => Promise<string | null> };

function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; if (stdout.length > 1_000_000) child.kill(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; if (stderr.length > 1_000_000) child.kill(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`git ${args[0]} failed (${code}): ${stderr.slice(0, 200)}`)));
  });
}

async function withToken<T>(token: string, run: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const nonce = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== `/${nonce}` || request.socket.remoteAddress !== "127.0.0.1") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end(token);
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Git credential listener unavailable");
  // git execs GIT_ASKPASS as a single program (no shell), so a quoted "node script"
  // path fails with cannot exec. Use one executable wrapper that invokes node.
  const askpass = fileURLToPath(new URL("./coding-git-askpass.mjs", import.meta.url));
  const wrapper = join(tmpdir(), `omb-git-askpass-${nonce}`);
  writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(askpass)} "$@"\n`, { mode: 0o755 });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
    TMPDIR: process.env.TMPDIR, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS_REQUIRE: "force", OMB_ASKPASS_URL: `http://127.0.0.1:${address.port}/${nonce}` };
  try {
    return await run({ ...env, GIT_ASKPASS: wrapper });
  } finally {
    try { unlinkSync(wrapper); } catch { /* best-effort */ }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function gitHubJson(token: string, path: string, init?: RequestInit, request = fetch): Promise<any> {
  const response = await request(`https://api.github.com${path}`, { ...init, headers: {
    accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28",
    ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers,
  }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}

export function createProductionCodingGitHost(config: CodingRunConfig, dependencies: Dependencies = {}): CodingGitHost {
  const appCredentials = createGitHubAppCredentialProvider({ installations: config.gitAppInstallations ?? {},
    ...(dependencies.request ? { request: dependencies.request } : {}) });
  const credentials = dependencies.credentials ?? appCredentials;
  const request = dependencies.gitHubRequest ?? dependencies.request ?? fetch;
  const git = dependencies.runGit ?? runGit;
  const tokenFor = async (credential: CodingGitCredential, repository: string) => {
    const token = await (dependencies.scopedToken ?? appCredentials.scopedToken)(credential, repository);
    if (!token) throw new Error("GitHub App installation credential unavailable for configured repository");
    return token;
  };
  const host: CodingGitHost = {
    credentials,
    async inspect(repository, gitRequest?: CodingGitRequest): Promise<RepositoryFacts> {
      const match = REPOSITORY.exec(repository);
      if (!match) throw new Error("GitHub repository identity is invalid");
      const grants = gitRequest ? config.gitDestinations?.[gitRequest.botId]?.filter((grant) =>
        grant.repository === repository && gitRequest.branch.startsWith(grant.branchPrefix))
        : Object.values(config.gitDestinations ?? {}).flat().filter((grant) => grant.repository === repository);
      if (!grants || grants.length !== 1 || grants[0]!.credential.kind !== "github-app") {
        throw new Error("GitHub repository has no unambiguous App destination credential");
      }
      const credential = grants[0]!.credential;
      const token = await tokenFor(credential, repository);
      const facts = await gitHubJson(token, `/repos/${repository}`, undefined, request);
      if (facts.full_name !== repository || typeof facts.default_branch !== "string" ||
        typeof facts.private !== "boolean") throw new Error("GitHub repository facts are incomplete");
      const protection = await gitHubJson(token, `/repos/${repository}/branches?per_page=100`, undefined, request);
      if (!Array.isArray(protection)) throw new Error("GitHub branch listing is malformed");
      const protectedBranches: string[] = [];
      for (const branch of protection) {
        if (typeof branch.name !== "string") throw new Error("GitHub branch listing is malformed");
        if (branch.protected === true) protectedBranches.push(branch.name);
      }
      const pullRequest = Number.isSafeInteger(gitRequest?.prNumber) && gitRequest!.prNumber! > 0
        ? await gitHubJson(token, `/repos/${repository}/pulls/${gitRequest!.prNumber}`, undefined, request) : undefined;
      const linked = pullRequest && { number: pullRequest.number, base: pullRequest.base?.ref,
        head: pullRequest.head?.ref, draft: pullRequest.draft };
      return { nameWithOwner: facts.full_name, visibility: facts.private ? "private" : "public",
        defaultBranch: facts.default_branch, protectedBranches, remoteUrls: [`https://github.com/${repository}.git`,
          `git@github.com:${repository}.git`], viewerPermission: "WRITE",
        ...(linked && Number.isSafeInteger(linked.number) && typeof linked.base === "string" &&
          typeof linked.head === "string" && typeof linked.draft === "boolean"
          ? { pullRequest: { number: linked.number, base: linked.base, head: linked.head, draft: linked.draft } } : {}) };
    },
    port: {
      async origin(workspace) { return git(["remote", "get-url", "origin"], workspace, process.env); },
      async branch(workspace) { return git(["branch", "--show-current"], workspace, process.env); },
      async createBranch(workspace, branch, base) {
        const current = await git(["branch", "--show-current"], workspace, process.env);
        if (current !== branch) {
          const existing = await git(["branch", "--list", branch], workspace, process.env);
          await git(existing ? ["switch", branch] : ["switch", "-c", branch], workspace, process.env);
        }
        await git(["branch", `--set-upstream-to=origin/${base}`, branch], workspace, process.env);
      },
      async head(workspace) { return git(["rev-parse", "HEAD"], workspace, process.env); },
      async outgoingAuthors(workspace, remote, branch) {
        if (await git(["branch", "--show-current"], workspace, process.env) !== branch ||
          await git(["remote", "get-url", "origin"], workspace, process.env) !== remote ||
          await git(["config", "--get", `branch.${branch}.remote`], workspace, process.env) !== "origin" ||
          await git(["config", "--get", `branch.${branch}.merge`], workspace, process.env) !== `refs/heads/${branch}`) {
          throw new Error("Git branch upstream changed during publication");
        }
        const output = await git(["log", `refs/remotes/origin/${branch}..HEAD`, "--format=%an%x00%ae"], workspace, process.env);
        return output ? output.split("\n").map((line) => { const [name, email] = line.split("\0"); return { name: name ?? "", email: email ?? "" }; }) : [];
      },
      async push(workspace, remote, revision, destination, credential, repository, options) {
        const setUpstream = options?.setUpstream === true;
        let source = revision;
        let pushRemote = remote;
        let branch = "";
        if (setUpstream) {
          branch = await git(["branch", "--show-current"], workspace, process.env);
          const head = await git(["rev-parse", "HEAD"], workspace, process.env);
          const origin = await git(["remote", "get-url", "origin"], workspace, process.env);
          if (!branch || destination !== `refs/heads/${branch}` || head !== revision || origin !== remote) {
            throw new Error("workspace branch or origin changed before upstream push");
          }
          source = branch;
          pushRemote = "origin";
        }
        const token = await tokenFor(credential, repository);
        await withToken(token, (env) => git(["-c", "url.https://github.com/.insteadOf=git@github.com:",
          "-c", "url.https://github.com/.insteadOf=ssh://git@github.com/", "push",
          ...(setUpstream ? ["--set-upstream"] : []), pushRemote, `${source}:${destination}`], workspace, env));
        if (setUpstream) {
          const upstreamRemote = await git(["config", "--get", `branch.${branch}.remote`], workspace, process.env);
          const upstreamBranch = await git(["config", "--get", `branch.${branch}.merge`], workspace, process.env);
          if (upstreamRemote !== "origin" || upstreamBranch !== destination) {
            throw new Error("coding workspace upstream does not match its pushed branch");
          }
          await git(["update-ref", `refs/remotes/origin/${branch}`, revision], workspace, process.env);
        }
      },
      async pullRequest(action, repository, base, head, credential, options) {
        const token = await tokenFor(credential, repository);
        const pulls = `/repos/${repository}/pulls`;
        if (action === "pr-open") {
          const query = new URLSearchParams({ state: "all", head: `evoclock:${head}`, base });
          const matches = await gitHubJson(token, `${pulls}?${query}`, undefined, request);
          if (!Array.isArray(matches)) throw new Error("Pull request lookup is malformed");
          const exact = matches.filter((pr: { base?: { ref?: string }; head?: { ref?: string; repo?: { full_name?: string } } }) =>
            pr.base?.ref === base && pr.head?.ref === head && pr.head?.repo?.full_name === repository);
          if (exact.length > 1) throw new Error("Pull request lookup is ambiguous");
          if (exact.length === 1) return;
          const created = await gitHubJson(token, pulls, { method: "POST", body: JSON.stringify({ title: `Changes for ${head}`,
            head, base, draft: true, body: "I completed the verified coding task. Please review these changes." }) }, request);
          if (created.base?.ref !== base || created.head?.ref !== head || created.head?.repo?.full_name !== repository ||
            created.draft !== true) throw new Error("Created pull request did not match the requested draft");
          return;
        }
        const pr = await gitHubJson(token, `${pulls}/${options.prNumber}`, undefined, request);
        if (pr.base?.ref !== base || pr.head?.ref !== head || pr.draft !== true)
          throw new Error("Pull request identity or draft state changed");
        if (action === "pr-ready") await gitHubJson(token, `${pulls}/${options.prNumber}/ready_for_review`,
          { method: "POST" }, request);
      },
    },
  };
  return host;
}
