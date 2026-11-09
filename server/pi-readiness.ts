import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawnCli } from "./procs.ts";

export type PiRole = "development" | "independent-review";

const pinnedPotetoFiles = [
  ["SKILL.md", "79a122bd37926b46eee5ed9f3c16289d21e95fee43002280ba4e72dd7c590647"],
  ["playbooks/bug-fix.md", "0b1cb873b8ffc08ff5050dee059f7ba322f9141a1447015f39f3e566bf8132f8"],
  ["../how/WORKFLOW_BOUNDARIES.md", "d151d7fcb9f5d29e16619b4399f86be1ff73760bc8824a13354ed0473d87a5e7"],
  ["../how/UPSTREAM_MAPPING.md", "03f0d6f6aecfc06415b411b7c95923a7c56b581a31d48d135c176f6d6788ef01"],
] as const;

export function loadPinnedPotetoRecipe(skillDir: string, rolesFilePath: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8")) {
  if (!isAbsolute(skillDir) || !isAbsolute(rolesFilePath)) throw new Error("Coding recipe needs absolute skill and roles paths");
  const files = pinnedPotetoFiles.map(([name, expected]) => {
    const text = read(resolve(skillDir, name));
    if (createHash("sha256").update(text).digest("hex") !== expected) {
      throw new Error(`Coding recipe ${name} hash mismatch`);
    }
    return { name, text, sha256: expected };
  });
  const rolesText = read(rolesFilePath);
  if (rolesText.length > 16_384) throw new Error("Coding recipe roles file is too large");
  const roles = parsePiRoles(rolesText);
  if (!roles.development || !roles["independent-review"] || roles.development === roles["independent-review"]) {
    throw new Error("Coding recipe requires distinct configured development and independent-review roles");
  }
  return { skillDir, files, rolesText, roles,
    rolesSha256: createHash("sha256").update(rolesText).digest("hex") };
}

export async function resolveCodingPiRecipe(codingRun: { potetoSkillDir?: string; rolesFilePath?: string } | undefined,
  options: { cli: string; env: NodeJS.ProcessEnv; cwd: string; agentDir?: string }) {
  const recipe = codingRun?.potetoSkillDir && codingRun.rolesFilePath
    ? loadPinnedPotetoRecipe(codingRun.potetoSkillDir, codingRun.rolesFilePath) : null;
  if (codingRun?.potetoSkillDir && !recipe) throw new Error("Coding run denied: pinned recipe roles are unavailable");
  if (!recipe) {
    const readiness = await checkPiReadiness({ ...options, skillOnly: true });
    if (!readiness.skill.ready) throw new Error(readiness.skill.action);
  }
  return recipe;
}

export type PiReadiness = {
  skill: { ready: boolean; action: string };
  roles: Record<PiRole, { ready: boolean; action: string }>;
};

type RpcReply = { command?: string; success?: boolean; data?: unknown };
export async function piRpcProbe(cli: string, env: NodeJS.ProcessEnv, cwd: string, command: string,
  selection?: { provider: string; modelId: string }, childArgs?: string[]): Promise<unknown> {
  return new Promise((resolveReply, reject) => {
    const child = spawnCli(cli, childArgs ? [...childArgs, "--no-session"] : ["--mode", "rpc", "--no-session"],
      { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let finished = false;
    const finish = (error?: Error, value?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolveReply(value);
    };
    const timer = setTimeout(() => finish(new Error("Pi readiness probe timed out")), 10_000);
    child.on("error", (error) => finish(error));
    child.on("exit", () => finish(new Error("Pi exited before answering the readiness probe")));
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 1024 * 1024) return finish(new Error("Pi readiness response too large"));
      let newline: number;
      while ((newline = output.indexOf("\n")) !== -1) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        let reply: RpcReply;
        try { reply = JSON.parse(line) as RpcReply; } catch { continue; }
        if (reply.command === command && reply.success === true) return finish(undefined, reply.data);
        if (reply.command === command && reply.success === false) return finish(new Error("Pi refused readiness probe"));
      }
    });
    child.stdin.write(`${JSON.stringify({ type: command, id: "readiness", ...selection })}\n`);
  });
}

export async function assertPinnedPiChild(cli: string, env: NodeJS.ProcessEnv, cwd: string,
  childArgs: string[], cleanup: () => void): Promise<void> {
  try {
    const data = await piRpcProbe(cli, env, cwd, "get_commands", undefined, childArgs) as {
      commands?: Array<{ name?: string; source?: string }> };
    const skills = data?.commands?.filter((entry) => entry.source === "skill");
    if (skills?.length !== 1 || skills[0]?.name !== "skill:poteto-mode-pi") {
      throw new Error("Coding run denied: pinned recipe is not the sole loaded skill in the child");
    }
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function piProjectRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function parsePiRoles(text: string): Record<PiRole, string | null> {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid role map");
  const { schema, roles } = raw as Record<string, unknown>;
  if (schema !== "pstack-model-roles.v1" || !roles || typeof roles !== "object" || Array.isArray(roles)) throw new Error("invalid role map");
  const map = roles as Record<string, unknown>;
  const parsed = {} as Record<PiRole, string | null>;
  for (const role of ["development", "independent-review"] as const) {
    const value = map[role];
    if (value !== null && (typeof value !== "string" || !/^[^\s/]+\/[^\s]+$/.test(value))) throw new Error(`invalid ${role} role`);
    parsed[role] = value;
  }
  return parsed;
}

export async function checkPiReadiness(options: {
  cli: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  agentDir?: string;
  skillOnly?: boolean;
  probe?: typeof piRpcProbe;
}): Promise<PiReadiness> {
  const { cli, env, cwd, agentDir, probe = piRpcProbe } = options;
  const result: PiReadiness = {
    skill: { ready: false, action: "Select a reviewed Pi agent directory containing poteto-mode-pi." },
    roles: {
      development: { ready: false, action: "Configure the development role in .pi/pstack-model-roles.v1.json." },
      "independent-review": { ready: false, action: "Configure the independent-review role in .pi/pstack-model-roles.v1.json." },
    },
  };
  const runtimeEnv = agentDir ? { ...env, PI_CODING_AGENT_DIR: resolve(agentDir) } : env;
  try {
    const data = await probe(cli, runtimeEnv, cwd, "get_commands") as { commands?: Array<{ name?: string; source?: string }> };
    if (data?.commands?.some((entry) => reportsPiSkill(entry, "poteto-mode-pi"))) {
      result.skill = { ready: true, action: "" };
    } else result.skill.action = "Pi did not load poteto-mode-pi. Check the selected agent directory and its reviewed skill package.";
  } catch {
    result.skill.action = "Pi skill probe failed. Check the Pi CLI and selected agent directory.";
  }
  if (options.skillOnly) return result;
  let roles: Record<PiRole, string | null>;
  try {
    const root = piProjectRoot(cwd);
    roles = parsePiRoles(readFileSync(resolve(root ?? cwd, ".pi/pstack-model-roles.v1.json"), "utf8"));
  } catch {
    return result;
  }
  try {
    const data = await probe(cli, runtimeEnv, cwd, "get_available_models") as { models?: Array<{ provider?: string; id?: string; modelId?: string }> };
    for (const role of ["development", "independent-review"] as const) {
      const selected = roles[role];
      if (selected && data?.models?.some((model) => `${model.provider}/${model.id ?? model.modelId}` === selected)) {
        const slash = selected.indexOf("/");
        try {
          await probe(cli, runtimeEnv, cwd, "set_model", { provider: selected.slice(0, slash), modelId: selected.slice(slash + 1) });
          result.roles[role] = { ready: true, action: "" };
        } catch {
          result.roles[role].action = `Pi could not select the ${role} model. Check its route and credentials.`;
        }
      } else if (selected) result.roles[role].action = `The ${role} model is unavailable in Pi. Check its route and credentials.`;
    }
  } catch {
    for (const role of ["development", "independent-review"] as const) {
      result.roles[role].action = "Pi model probe failed. Check the Pi CLI, route and credentials.";
    }
  }
  return result;
}

// Pi CLI 1.x with enableSkillCommands reports skill commands as `skill:<name>`.
function reportsPiSkill(entry: { name?: string; source?: string }, skill: string): boolean {
  if (entry.source !== "skill" || typeof entry.name !== "string") return false;
  const name = entry.name.startsWith("skill:") ? entry.name.slice("skill:".length) : entry.name;
  return name === skill;
}
