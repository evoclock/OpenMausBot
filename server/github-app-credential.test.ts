import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jwtVerify } from "jose";
import { test } from "vitest";
import { createCodingGitPolicy, type CodingGitPort } from "./coding-git-policy.ts";
import { codingGitAppInstallationSchema } from "./coding-run-config.ts";
import { createGitHubAppCredentialProvider } from "./github-app-credential.ts";

const repository = "evoclock/OpenMausBot";
const credential = { kind: "github-app" as const, reference: "review-installation" };
const time = Date.parse("2026-10-22T12:00:00Z");
const tokenBody = { token: "test-generated-placeholder", expires_at: "2026-10-22T12:10:00Z",
  repositories: [{ full_name: repository }], permissions: { contents: "write", pull_requests: "write" } };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fixture(keyType: "pkcs1" | "pkcs8" = "pkcs8") {
  const cache = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "github-app-fixture-"));
  const path = join(dir, "throwaway.pem");
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(path, pair.privateKey.export({ type: keyType, format: "pem" }), { mode: 0o600 });
  const installation = { appId: 123, installationId: 456, privateKeyPath: path,
    repositories: [repository], visibility: "private" as const };
  let mint = tokenBody;
  let mintStatus = 201;
  let repoFacts = { full_name: repository, visibility: "private", permissions: { push: true } };
  let repoStatus = 200;
  const calls: string[] = [];
  const request = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method}:${url.pathname}`);
    if (url.pathname.startsWith("/app/installations/")) {
      assert.equal(url.pathname, "/app/installations/456/access_tokens");
      assert.ok(init?.headers);
      const jwt = (init.headers as Record<string, string>).authorization.replace("Bearer ", "");
      await jwtVerify(jwt, pair.publicKey, { issuer: "123", algorithms: ["RS256"], currentDate: new Date(time) });
      assert.deepEqual(JSON.parse(String(init?.body)), { repositories: ["OpenMausBot"],
        permissions: { contents: "write", pull_requests: "write" } });
      return response(mint, mintStatus);
    }
    assert.equal(url.pathname, "/repos/evoclock/OpenMausBot");
    assert.ok(init?.headers);
    assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${tokenBody.token}`);
    return response(repoFacts, repoStatus);
  }) as typeof fetch;
  const provider = () => createGitHubAppCredentialProvider({ installations: { "review-installation": installation }, request,
    now: () => time });
  return { dir, installation, calls, provider, setMint(next: typeof tokenBody, status = 201) { mint = next; mintStatus = status; },
    setRepo(next: typeof repoFacts, status = 200) { repoFacts = next; repoStatus = status; } };
}

test("App config selects an installation explicitly without embedding key material", () => {
  const f = fixture();
  assert.equal(codingGitAppInstallationSchema.safeParse(f.installation).success, true);
  assert.equal(codingGitAppInstallationSchema.safeParse({ ...f.installation, privateKeyPath: "relative.pem" }).success, false);
  assert.equal(codingGitAppInstallationSchema.safeParse({ ...f.installation, token: "not allowed" }).success, false);
});

test.each(["pkcs1", "pkcs8"] as const)("a throwaway %s RSA key mints a fresh repo-scoped token per decision", async (keyType) => {
  const f = fixture(keyType);
  f.setRepo({ full_name: repository, visibility: "private", permissions: { push: false } });
  assert.equal(await f.provider().canWrite(credential, repository), true);
  assert.equal(await f.provider().scopedToken(credential, repository), tokenBody.token);
  assert.equal(await f.provider().scopedToken(credential, "evoclock/Other"), null);
  assert.deepEqual(f.calls, ["POST:/app/installations/456/access_tokens", "GET:/repos/evoclock/OpenMausBot",
    "POST:/app/installations/456/access_tokens", "GET:/repos/evoclock/OpenMausBot"]);
});

test("credential failures expose only stable, non-secret reason codes", async () => {
  const f = fixture();
  f.setMint(tokenBody, 401);
  assert.deepEqual(await f.provider().scopedTokenResult(credential, repository), { token: null, failure: "mint-status-401" });
  f.setMint({ ...tokenBody, permissions: { contents: "read", pull_requests: "write" } });
  assert.deepEqual(await f.provider().scopedTokenResult(credential, repository), { token: null, failure: "permissions-missing-contents" });
  f.setMint(tokenBody);
  f.setRepo({ full_name: repository, visibility: "private", permissions: { push: true } }, 404);
  assert.deepEqual(await f.provider().scopedTokenResult(credential, repository), { token: null, failure: "repo-lookup-404" });
  f.setRepo({ full_name: repository, visibility: "public", permissions: { push: true } });
  assert.deepEqual(await f.provider().scopedTokenResult(credential, repository), { token: null, failure: "visibility-mismatch" });
  writeFileSync(f.installation.privateKeyPath, "not a private key", { mode: 0o600 });
  const parseFailure = await f.provider().scopedTokenResult(credential, repository);
  assert.deepEqual(parseFailure, { token: null, failure: "key-parse" });
  assert.equal(JSON.stringify(parseFailure).includes("not a private key"), false);
});

test("missing keys, repo mismatch, authorization failures and narrowed scopes refuse", async () => {
  const f = fixture();
  assert.equal(await f.provider().canWrite({ ...credential, reference: "unknown" }, repository), false);
  assert.equal(await f.provider().canWrite(credential, "evoclock/Other"), false);
  assert.equal(f.calls.length, 0);
  const missingKey = createGitHubAppCredentialProvider({ installations: {
    "review-installation": { ...f.installation, privateKeyPath: join(f.dir, "missing.pem") },
  }, request: (async () => { throw new Error("unexpected network call"); }) as typeof fetch });
  assert.equal(await missingKey.canWrite(credential, repository), false);
  chmodSync(f.installation.privateKeyPath, 0o644);
  assert.equal(await f.provider().canWrite(credential, repository), false);
  chmodSync(f.installation.privateKeyPath, 0o600);
  f.setMint(tokenBody, 401);
  assert.equal(await f.provider().canWrite(credential, repository), false);
  f.setMint({ ...tokenBody, repositories: [{ full_name: "evoclock/Other" }] });
  assert.equal(await f.provider().canWrite(credential, repository), false);
  f.setMint({ ...tokenBody, expires_at: "2026-10-22T11:00:00Z" });
  assert.equal(await f.provider().canWrite(credential, repository), false);
  f.setMint({ ...tokenBody, expires_at: "not-a-date" });
  assert.equal(await f.provider().canWrite(credential, repository), false);
  f.setMint(tokenBody);
  f.setRepo({ full_name: repository, visibility: "public", permissions: { push: true } });
  assert.equal(await f.provider().canWrite(credential, repository), false);
  f.setRepo({ full_name: repository, visibility: "private", permissions: { push: false } });
  assert.equal(await f.provider().canWrite(credential, repository), true);
});

test("App credential does not override verified evoclock authorship or allow squash", async () => {
  const f = fixture();
  let pushes = 0;
  let authors = [{ name: "github[bot]", email: "bot@users.noreply.github.com" }];
  const port: CodingGitPort = {
    async origin() { return "git@github.com:evoclock/OpenMausBot.git"; },
    async branch() { return "bot/work"; }, async head() { return "a".repeat(40); },
    async outgoingAuthors() { return authors; },
    async push() { pushes++; }, async pullRequest() { pushes++; }, async recordOwnerMerge() { pushes++; },
  };
  const policy = createCodingGitPolicy({ destinations: { worker: [{ repository, branchPrefix: "bot/", credential }] },
    async inspect() { return { nameWithOwner: repository, visibility: "private", defaultBranch: "main",
      protectedBranches: ["main"], remoteUrls: ["git@github.com:evoclock/OpenMausBot.git"], viewerPermission: "WRITE",
      pullRequest: { number: 7, base: "main", head: "bot/work", draft: true, checksGreen: true } } as const; },
    credentials: f.provider(), port });
  const input = { botId: "worker", repository, workspace: "fixture", branch: "bot/work" };
  await assert.rejects(policy({ ...input, action: "push" }), /verified Git author/);
  authors = [{ name: "evoclock", email: "52983349+evoclock@users.noreply.github.com" }];
  await assert.rejects(policy({ ...input, action: "pr-merge", base: "main", prNumber: 7,
    runId: "run-1", unblockReason: "This unblocks further development", mergeMethod: "squash" }), /squash/);
  assert.equal(pushes, 0);
});
