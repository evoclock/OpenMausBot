import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codingPiAgentDir } from "./pi-coding-session.ts";

function fixture(options: { catalog?: boolean; auth?: boolean } = {}) {
  const scratch = join(process.cwd(), ".omb-scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "pi-coding-session-"));
  const hostDir = join(root, "host");
  const hostPi = join(hostDir, "harness", "bin", "pi");
  const hostModels = join(hostDir, "models-store.json");
  const hostAuth = join(hostDir, "auth.json");
  mkdirSync(join(hostDir, "harness", "bin"), { recursive: true });
  writeFileSync(hostPi, "#!/bin/sh\nexit 0\n");
  chmodSync(hostPi, 0o700);
  if (options.catalog !== false) writeFileSync(hostModels, JSON.stringify({ providers: { "openai-codex": { models: [{ id: "gpt-6-sol" }] } } }));
  if (options.auth !== false) writeFileSync(hostAuth, JSON.stringify({ "openai-codex": { type: "oauth" } }));
  return { root, hostPi, hostModels, hostAuth };
}

describe("isolated coding Pi agent directory", () => {
  it("links an executable host CLI before a coding turn and remains idempotent", () => {
    const { root, hostPi } = fixture();
    const agentDir = codingPiAgentDir(root, "test-bot", hostPi);
    const seededPi = join(agentDir, "harness", "bin", "pi");
    expect(realpathSync(seededPi)).toBe(hostPi);
    expect(() => accessSync(seededPi, constants.X_OK)).not.toThrow();
    expect(codingPiAgentDir(root, "test-bot", hostPi)).toBe(agentDir);
    expect(realpathSync(seededPi)).toBe(hostPi);
    const sessions = join(agentDir, "sessions");
    expect(statSync(sessions).isDirectory()).toBe(true);
    expect(statSync(sessions).mode & 0o777).toBe(0o700);
  });

  it("links the host model catalog and authentication into the isolated profile", () => {
    const { root, hostPi, hostModels, hostAuth } = fixture();
    const agentDir = codingPiAgentDir(root, "test-bot", hostPi);
    const catalog = join(agentDir, "models-store.json");
    const auth = join(agentDir, "auth.json");
    expect(lstatSync(catalog).isSymbolicLink()).toBe(true);
    expect(realpathSync(catalog)).toBe(hostModels);
    expect(statSync(catalog).size).toBeGreaterThan(2);
    expect(JSON.parse(readFileSync(catalog, "utf8")).providers["openai-codex"].models[0].id).toBe("gpt-6-sol");
    expect(lstatSync(auth).isSymbolicLink()).toBe(true);
    expect(realpathSync(auth)).toBe(hostAuth);
    expect(codingPiAgentDir(root, "test-bot", hostPi)).toBe(agentDir);
  });

  it("fails preparation when the host model catalog is missing", () => {
    const { root, hostPi } = fixture({ catalog: false });
    expect(() => codingPiAgentDir(root, "test-bot", hostPi))
      .toThrow("Coding run denied: host Pi model catalog is unavailable");
    expect(existsSync(join(root, "bots", "test-bot", "pi", "auth.json"))).toBe(false);
  });

  it("fails preparation when host authentication is missing", () => {
    const { root, hostPi } = fixture({ auth: false });
    expect(() => codingPiAgentDir(root, "test-bot", hostPi))
      .toThrow("Coding run denied: host Pi authentication is unavailable");
    expect(existsSync(join(root, "bots", "test-bot", "pi", "models-store.json"))).toBe(false);
  });

  it("refuses an existing isolated authentication stub", () => {
    const { root, hostPi } = fixture();
    const agentDir = join(root, "bots", "test-bot", "pi");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), "{}");
    expect(() => codingPiAgentDir(root, "test-bot", hostPi))
      .toThrow("Coding run denied: isolated Pi authentication is not linked to the host");
  });

  it("uses the host home installation even when Pi's profile env points elsewhere", () => {
    const { root, hostPi, hostModels, hostAuth } = fixture();
    const savedHome = process.env.HOME;
    const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    const installed = join(root, ".pi", "pi", "harness", "bin", "pi");
    mkdirSync(join(root, ".pi", "pi", "harness", "bin"), { recursive: true });
    symlinkSync(hostPi, installed);
    symlinkSync(hostModels, join(root, ".pi", "pi", "models-store.json"));
    symlinkSync(hostAuth, join(root, ".pi", "pi", "auth.json"));
    try {
      process.env.HOME = root;
      process.env.PI_CODING_AGENT_DIR = join(root, "other-profile");
      const agentDir = codingPiAgentDir(root, "test-bot");
      expect(realpathSync(join(agentDir, "harness", "bin", "pi"))).toBe(hostPi);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    }
  });

  it("fails preparation clearly when the host CLI is missing", () => {
    const { root } = fixture();
    expect(() => codingPiAgentDir(root, "test-bot", join(root, "missing", "pi")))
      .toThrow("Coding run denied: host Pi CLI is unavailable");
  });

  it("rejects redirected harness directories before writing outside the agent profile", () => {
    const { root, hostPi } = fixture();
    const external = join(root, "external");
    mkdirSync(external);
    const agentDir = join(root, "bots", "test-bot", "pi");
    mkdirSync(agentDir, { recursive: true });
    symlinkSync(external, join(agentDir, "harness"));
    expect(() => codingPiAgentDir(root, "test-bot", hostPi)).toThrow("Coding run denied: Pi harness is redirected");
    expect(existsSync(join(external, "bin"))).toBe(false);
  });

  it("refuses a redirected session directory before creating sessions outside the profile", () => {
    const { root, hostPi } = fixture();
    const external = join(root, "external");
    mkdirSync(external);
    const originalMode = statSync(external).mode & 0o777;
    const agentDir = join(root, "bots", "test-bot", "pi");
    mkdirSync(agentDir, { recursive: true });
    symlinkSync(external, join(agentDir, "sessions"));
    expect(() => codingPiAgentDir(root, "test-bot", hostPi)).toThrow("Coding run denied: Pi sessions are redirected");
    expect(statSync(external).mode & 0o777).toBe(originalMode);
  });

  it("refuses a pre-existing non-executable CLI instead of starting a broken turn", () => {
    const { root, hostPi } = fixture();
    const seededPi = join(root, "bots", "test-bot", "pi", "harness", "bin", "pi");
    mkdirSync(join(root, "bots", "test-bot", "pi", "harness", "bin"), { recursive: true });
    writeFileSync(seededPi, "not executable");
    expect(() => codingPiAgentDir(root, "test-bot", hostPi))
      .toThrow("Coding run denied: isolated Pi CLI is not executable");
  });
});
