import { readFileSync } from "node:fs";
import { runHostCheck } from "./coding-host-check.ts";
import { loadPinnedPotetoRecipe, parsePiRoles } from "./pi-readiness.ts";
import type { RunContractInput } from "./run-contract.ts";
import type { IsolatedWorkspace, WorkerHost, WorkerRoles } from "./inner-worker-route.ts";
import { applyEmbeddedCardInWorkspace } from "./coding-filled-card-apply.ts";
import { codingWorkspaceBranch } from "./coding-treehouse-workspace.ts";

export interface CodingTurnResult {
  revision: string;
  sessionFile?: string;
  evidence: string[];
  accepted?: boolean;
  blocked?: boolean;
  costUsd: number | null;
  modelUsed?: { instanceId: string; model: string };
  modelsUsed?: Array<{ instanceId: string; model: string }>;
}

export interface CodingTurnPort {
  /** Implementation must call the server's startTurn, not a driver adapter directly. */
  run(input: { botId: string; workspace: IsolatedWorkspace; role: string; prompt: string;
    requestId: string; signal: AbortSignal }): Promise<CodingTurnResult>;
}

export function createCodingWorkerHost(options: {
  rolesFilePath?: string;
  roles: ReadonlyMap<string, WorkerRoles & { developmentBotId: string; reviewerBotId: string;
    potetoSkillDir?: string; checkTimeoutMs?: number }>;
  workspace: { acquire(contract: RunContractInput, requestId: string): Promise<IsolatedWorkspace>;
    release(leaseId: string, reason: string): Promise<void> };
  turn: CodingTurnPort;
  verify: (workspace: IsolatedWorkspace, revision: string, criteria: string[], signal: AbortSignal) => Promise<string[] | null>;
}): WorkerHost {
  const requests = new Map<string, { botId: string; repository: string }>();
  const leases = new Map<string, string>();
  return {
    async roles(repository) {
      const config = options.roles.get(repository);
      if (!config || !config.developmentBotId || !config.reviewerBotId ||
        config.developmentBotId === config.reviewerBotId || !options.rolesFilePath) return null;
      try {
        const roles = config.potetoSkillDir
          ? loadPinnedPotetoRecipe(config.potetoSkillDir, options.rolesFilePath).roles
          : parsePiRoles(readFileSync(options.rolesFilePath, "utf8"));
        if (!roles.development || !roles["independent-review"] ||
          config.development !== roles.development || config.independentReview !== roles["independent-review"]) return null;
        return { development: roles.development, independentReview: roles["independent-review"] };
      } catch { return null; }
    },
    async acquire(contract, requestId) {
      const workspace = await options.workspace.acquire(contract, requestId);
      if (workspace.repository !== contract.repository || workspace.baseBranch !== contract.ref ||
        workspace.branch !== codingWorkspaceBranch(requestId)) {
        throw new Error("workspace does not match coding contract");
      }
      requests.set(requestId, { botId: contract.botId, repository: contract.repository });
      leases.set(workspace.leaseId, requestId);
      return workspace;
    },
    async release(leaseId, reason) { await options.workspace.release(leaseId, reason); },
    async runPlaybook(workspace, role, goal, requestId, signal) {
      const request = requests.get(requestId);
      const config = request && options.roles.get(request.repository);
      if (!request || !config || !(await this.roles(request.repository)) || config.development !== role || !config.developmentBotId) {
        throw new Error("coding worker role is not configured for this run");
      }
      const recipe = config.potetoSkillDir && options.rolesFilePath
        ? loadPinnedPotetoRecipe(config.potetoSkillDir, options.rolesFilePath) : null;
      const applied = applyEmbeddedCardInWorkspace(workspace.directory, goal);
      const instruction = applied
        ? "Host already wrote the BEGIN_CARD…END_CARD body into TASKS.md (## Consolidation phase). Verify the Class|Path classification table is present. Commit only TASKS.md. Do not paraphrase or rewrite that section."
        : "";
      const prompt = [goal, instruction, ...(recipe ? [
        ...recipe.files.slice(1).map((file) => `Pinned ${file.name} (sha256 ${file.sha256}):\n${file.text}`),
        `Configured roles (sha256 ${recipe.rolesSha256}):\n${recipe.rolesText}`,
        "Return POTETO_STEPS as JSON with bug-fix steps 1–6. Mark host-owned delegation and PR opening as skip with a reason; never mark autonomous-run or fan-out as done.",
      ] : [])].filter(Boolean).join("\n\n");
      const result = await options.turn.run({ botId: config.developmentBotId, workspace, role: "development", prompt, requestId, signal });
      const steps = result.evidence.join("\n").match(/POTETO_STEPS:\s*(\{[^\n]+\})/);
      let stepEvidenceOk = !recipe;
      if (recipe && steps) {
        try {
          const rows = JSON.parse(steps[1]!) as Record<string, string>;
          stepEvidenceOk = ["1", "2", "4", "5"].every((step) => rows[step] === "done") &&
            ["3", "6"].every((step) => rows[step]?.startsWith("skip: ")) &&
            Object.keys(rows).every((step) => /^[1-6]$/.test(step));
        } catch { stepEvidenceOk = false; }
      }
      return { revision: result.revision, evidence: result.evidence, sessionFile: result.sessionFile, costUsd: result.costUsd,
        stepEvidenceOk, progress: Boolean(result.revision && result.evidence.length), modelUsed: result.modelUsed,
        ...(result.blocked ? { blocked: true } : {}), ...(result.modelsUsed ? { modelsUsed: result.modelsUsed } : {}) };
    },
    async runHostCheck(workspace, command, revision) {
      return runHostCheck({ command, cwd: workspace.directory, revision,
        timeoutMs: options.roles.get(workspace.repository)?.checkTimeoutMs });
    },
    async review(workspace, role, revision, signal, goal) {
      const config = options.roles.get(workspace.repository);
      if (!config || !(await this.roles(workspace.repository)) || config.independentReview !== role || !config.reviewerBotId) {
        throw new Error("independent reviewer is not configured");
      }
      const requestId = leases.get(workspace.leaseId);
      if (!requestId) throw new Error("review has no originating coding request");
      const recipe = config.potetoSkillDir && options.rolesFilePath
        ? loadPinnedPotetoRecipe(config.potetoSkillDir, options.rolesFilePath) : null;
      const brief = `Review revision ${revision}.${goal?.trim() ? `\n\nStated goal for this coding run:\n${goal.trim()}` : ""}\nInspect its committed patch with coding_command {"command":"diff","revision":"${revision}"}; the command field accepts only one fixed verb, not Git arguments. Report whether it meets the stated goal and include ACCEPT ${revision} only if verified.`;
      const prompt = recipe ? `/skill:poteto-mode-pi ${brief}\n\n${recipe.files.slice(1).map((file) => `Pinned ${file.name} (sha256 ${file.sha256}):\n${file.text}`).join("\n\n")}\n\nConfigured roles (sha256 ${recipe.rolesSha256}):\n${recipe.rolesText}` : brief;
      const result = await options.turn.run({ botId: config.reviewerBotId, workspace, role: "review",
        prompt,
        requestId: `review:${requestId}:${revision}`, signal });
      return { revision: result.revision, evidence: result.evidence, costUsd: result.costUsd,
        accepted: result.accepted === true && result.revision === revision && result.evidence.length > 0,
        modelUsed: result.modelUsed, ...(result.blocked ? { blocked: true } : {}),
        ...(result.modelsUsed ? { modelsUsed: result.modelsUsed } : {}) };
    },
    verifyRevision: options.verify,
  };
}
