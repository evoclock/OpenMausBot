import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPiReadiness, parsePiRoles, piProjectRoot, piRpcProbe } from "./pi-readiness.ts";

const fixtures: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-readiness-"));
  fixtures.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "skills", "poteto-mode-pi"), { recursive: true });
  writeFileSync(join(agentDir, "skills", "poteto-mode-pi", "SKILL.md"), "---\nname: poteto-mode-pi\ndescription: Fixture skill\n---\n");
  mkdirSync(join(root, ".pi"));
  return { root, agentDir };
}
afterEach(async () => {
  const { rmSync } = await import("node:fs");
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const roles = { schema: "pstack-model-roles.v1", roles: { development: "fixture/dev", "independent-review": "fixture/review" } };

describe("Pi readiness", () => {
  it("validates exact distinct role identities without exposing choices", () => {
    expect(parsePiRoles(JSON.stringify(roles))).toEqual(roles.roles);
    expect(() => parsePiRoles(JSON.stringify({ ...roles, roles: { ...roles.roles, "independent-review": "fixture/dev" } }))).toThrow();
    expect(() => parsePiRoles(JSON.stringify({ ...roles, roles: { development: "auto", "independent-review": null } }))).toThrow();
  });

  it("checks an isolated agent directory and uses a fake Pi probe", async () => {
    const { root, agentDir } = fixture();
    writeFileSync(join(root, ".pi", "pstack-model-roles.v1.json"), JSON.stringify(roles));
    const calls: string[] = [];
    const result = await checkPiReadiness({ cli: "fake-pi", env: {}, cwd: root, agentDir,
      probe: async (_cli, env, cwd, command, selection) => {
        expect(env.PI_CODING_AGENT_DIR).toBe(agentDir);
        expect(cwd).toBe(root);
        calls.push(command);
        if (command === "set_model") {
          expect(selection?.provider).toBe("fixture");
          expect(["dev", "review"]).toContain(selection?.modelId);
          return {};
        }
        return command === "get_commands"
          ? { commands: [{ name: "poteto-mode-pi", source: "skill" }] }
          : { models: [{ provider: "fixture", id: "dev" }, { provider: "fixture", id: "review" }] };
      },
    });
    expect(calls).toEqual(["get_commands", "get_available_models", "set_model", "set_model"]);
    expect(result.skill.ready).toBe(true);
    expect(result.roles.development.ready).toBe(true);
    expect(result.roles["independent-review"].ready).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fixture/dev");
  });

  it("reads role data from the repository root for a nested bot working folder", async () => {
    const { root, agentDir } = fixture();
    const nested = join(root, "work", "nested");
    mkdirSync(join(root, ".git"));
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, ".pi", "pstack-model-roles.v1.json"), JSON.stringify(roles));
    expect(piProjectRoot(nested)).toBe(root);
    const result = await checkPiReadiness({ cli: "fake-pi", env: {}, cwd: nested, agentDir,
      probe: async (_cli, _env, _cwd, command) => command === "get_commands"
        ? { commands: [{ name: "poteto-mode-pi", source: "skill" }] }
        : { models: [{ provider: "fixture", id: "dev" }, { provider: "fixture", id: "review" }] },
    });
    expect(result.roles.development.ready).toBe(true);
  });

  it.each(["poteto-mode-pi", "skill:poteto-mode-pi"])("treats get_commands skill %s as loaded", async (name) => {
    const { root, agentDir } = fixture();
    const result = await checkPiReadiness({ cli: "fake-pi", env: {}, cwd: root, agentDir, skillOnly: true,
      probe: async () => ({ commands: [{ name, source: "skill" }, { name: "other", source: "extension" }] }),
    });
    expect(result.skill.ready).toBe(true);
    expect(result.skill.action).toBe("");
  });

  it("ignores a prefixed name from another source and a different skill", async () => {
    const { root, agentDir } = fixture();
    for (const commands of [
      [{ name: "skill:poteto-mode-pi", source: "prompt" }],
      [{ name: "poteto-mode-pi", source: "extension" }],
      [{ name: "skill:other", source: "skill" }],
      [{ name: "skill:poteto-mode-pi-extra", source: "skill" }],
    ]) {
      const result = await checkPiReadiness({ cli: "fake-pi", env: {}, cwd: root, agentDir, skillOnly: true,
        probe: async () => ({ commands }),
      });
      expect(result.skill.ready).toBe(false);
      expect(result.skill.action).toContain("did not load");
    }
  });

  it.each(["poteto-mode-pi", "skill:poteto-mode-pi"])("exchanges RPC frames when the fake CLI reports %s", async (name) => {
    const { root, agentDir } = fixture();
    const cli = join(root, "fake-pi");
    const reported = JSON.stringify(name);
    writeFileSync(cli, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst path = require('node:path');\nprocess.stdin.on('data', chunk => {\n  const request = JSON.parse(chunk.toString());\n  const loaded = fs.existsSync(path.join(process.env.PI_CODING_AGENT_DIR, 'skills', 'poteto-mode-pi', 'SKILL.md'));\n  const commands = loaded ? [{name:${reported}, source:'skill'}] : [];\n  console.log(JSON.stringify({type:'response', command: request.type, success:true, data:{commands}}));\n});\n`);
    chmodSync(cli, 0o700);
    const result = await checkPiReadiness({ cli, env: { PATH: process.env.PATH }, cwd: root, agentDir, probe: piRpcProbe });
    expect(result.skill.ready).toBe(true);
    expect(result.roles.development.ready).toBe(false);
  });

  it("shows missing skill and role file as owner actions without requiring a real home", async () => {
    const { root, agentDir } = fixture();
    const result = await checkPiReadiness({ cli: "fake-pi", env: {}, cwd: root, agentDir,
      probe: async () => ({ commands: [] }),
    });
    expect(result.skill.ready).toBe(false);
    expect(result.skill.action).toContain("did not load");
    expect(result.roles.development.action).toContain(".pi/pstack-model-roles.v1.json");
  });
});
