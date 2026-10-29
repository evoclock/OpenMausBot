import { accessSync, chmodSync, existsSync, mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, constants } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codingPiAgentDir } from "./pi-coding-session.ts";

function fixture() {
  const scratch = join(process.cwd(), ".omb-scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "pi-coding-session-"));
  const hostPi = join(root, "host", "harness", "bin", "pi");
  mkdirSync(join(root, "host", "harness", "bin"), { recursive: true });
  writeFileSync(hostPi, "#!/bin/sh\nexit 0\n");
  chmodSync(hostPi, 0o700);
  return { root, hostPi };
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
  });

  it("uses the host home installation even when Pi's profile env points elsewhere", () => {
    const { root, hostPi } = fixture();
    const savedHome = process.env.HOME;
    const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    const installed = join(root, ".pi", "pi", "harness", "bin", "pi");
    mkdirSync(join(root, ".pi", "pi", "harness", "bin"), { recursive: true });
    symlinkSync(hostPi, installed);
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

  it("refuses a pre-existing non-executable CLI instead of starting a broken turn", () => {
    const { root, hostPi } = fixture();
    const seededPi = join(root, "bots", "test-bot", "pi", "harness", "bin", "pi");
    mkdirSync(join(root, "bots", "test-bot", "pi", "harness", "bin"), { recursive: true });
    writeFileSync(seededPi, "not executable");
    expect(() => codingPiAgentDir(root, "test-bot", hostPi))
      .toThrow("Coding run denied: isolated Pi CLI is not executable");
  });
});
