import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { checkLiveConfig } from "./drill-live-worker.mjs";
import { mintSandboxToken, SANDBOX, withSandboxGitToken } from "./drill-github-app.mjs";

const fixture = { destination: SANDBOX, host: "mac-mini", model: "openai-codex/gpt-6-sol", thinking: "low",
  worktree: join(process.cwd(), ".omb-scratch", "proof", "omb-e2e-loop-drill", "live", "checkout"),
  baseRevision: "a".repeat(40), skillPath: "/synthetic/skill.md", credentialReference: { kind: "github-app", keyPath: "/synthetic/path",
    appId: 5424694, installationId: 174083987 }, botConfig: {
    originBotId: "owner", workerBotId: "worker", reviewerBotId: "reviewer",
    modelSelection: { instanceId: "pi", model: "openai-codex/gpt-6-sol" },
    maxIterations: 3, limits: { maxWallTimeMs: 600_000, maxSpendUsd: 2 },
  } };

test("live config refuses different destinations and inadequate limits without reaching credentials", () => {
  assert.doesNotThrow(() => checkLiveConfig(fixture));
  assert.throws(() => checkLiveConfig({ ...fixture, destination: "evoclock/another" }), /refused/);
  assert.throws(() => checkLiveConfig({ ...fixture, botConfig: { ...fixture.botConfig, maxIterations: 1 } }), /refused/);
  assert.throws(() => checkLiveConfig({ ...fixture, worktree: "/workspace/another-repo" }), /refused/);
});

test("GitHub App credential requests only one repository and refuses mismatched token scope", async () => {
  const scratch = join(process.cwd(), ".omb-scratch", "proof", "omb-e2e-loop-ci");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "app-auth-"));
  const keyPath = join(dir, "synthetic.pem");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const config = { ...fixture, credentialReference: { ...fixture.credentialReference, keyPath } };
  let calls = 0;
  const scoped = async (url, request) => {
    calls++;
    assert.equal(url, "https://api.github.com/app/installations/174083987/access_tokens");
    assert.deepEqual(JSON.parse(request.body), { repositories: ["omb-drill-sandbox"],
      permissions: { contents: "write", pull_requests: "write" } });
    return { ok: true, async json() { return { token: "synthetic-installation-token", expires_at: new Date(Date.now() + 120_000).toISOString(),
      permissions: { contents: "write", pull_requests: "write" }, repositories: [{ full_name: SANDBOX }] }; } };
  };
  assert.equal(await mintSandboxToken(config, scoped), "synthetic-installation-token");
  assert.equal(calls, 1);
  await assert.rejects(mintSandboxToken({ ...config, destination: "evoclock/another" }, scoped), /refused/);
  assert.equal(calls, 1);
  await assert.rejects(mintSandboxToken(config, async () => ({ ok: true, async json() {
    return { token: "synthetic-installation-token", expires_at: new Date(Date.now() + 120_000).toISOString(),
      permissions: { contents: "write", pull_requests: "write" }, repositories: [{ full_name: "evoclock/another" }] };
  } })), /scope/);
});

test("Git askpass keeps the synthetic token out of child environment", async () => {
  const token = "synthetic-test-only-token";
  await withSandboxGitToken(token, "/synthetic/askpass", async (env) => {
    assert.equal(env.GIT_ASKPASS, "/synthetic/askpass");
    assert.equal(Object.values(env).includes(token), false);
    const response = await fetch(env.OMB_ASKPASS_URL);
    assert.equal(await response.text(), token);
  });
});
