import { strict as assert } from "node:assert";
import { join } from "node:path";
import { test } from "vitest";
import { checkLiveConfig } from "./drill-live-worker.mjs";
import { SANDBOX, withSandboxGitToken } from "./drill-github-app.mjs";

const installation = { appId: 5424694, installationId: 174083987, privateKeyPath: "/synthetic/path",
  repositories: [SANDBOX], visibility: "private" };
const fixture = { destination: SANDBOX, host: "mac-mini", model: "openai-codex/gpt-6-sol", thinking: "low",
  worktree: join(process.cwd(), ".omb-scratch", "proof", "omb-e2e-loop-drill", "live", "checkout"),
  skillPath: "/synthetic/skill.md", baseRevision: "a".repeat(40),
  credentialReference: { kind: "github-app", reference: "sandbox-drill" },
  gitAppInstallations: { "sandbox-drill": installation }, botConfig: {
    originBotId: "owner", workerBotId: "worker", reviewerBotId: "reviewer",
    modelSelection: { instanceId: "pi", model: "openai-codex/gpt-6-sol" },
    maxIterations: 3, limits: { maxWallTimeMs: 600_000, maxSpendUsd: 2 },
  } };

test("live config refuses different destinations, installations, and inadequate limits before credentials", () => {
  assert.doesNotThrow(() => checkLiveConfig(fixture));
  assert.throws(() => checkLiveConfig({ ...fixture, destination: "evoclock/another" }), /refused/);
  assert.throws(() => checkLiveConfig({ ...fixture, gitAppInstallations: { "sandbox-drill": {
    ...installation, repositories: ["evoclock/another"] } } }), /refused/);
  assert.throws(() => checkLiveConfig({ ...fixture, botConfig: { ...fixture.botConfig, maxIterations: 1 } }), /refused/);
  assert.throws(() => checkLiveConfig({ ...fixture, worktree: "/workspace/another-repo" }), /refused/);
});

test("Git askpass keeps a synthetic token out of child environment", async () => {
  const token = "synthetic-test-only-token";
  await withSandboxGitToken(token, "/synthetic/askpass", async (env) => {
    assert.equal(env.GIT_ASKPASS, "/synthetic/askpass");
    assert.equal(Object.values(env).includes(token), false);
    const response = await fetch(env.OMB_ASKPASS_URL);
    assert.equal(await response.text(), token);
  });
});
