import { readFileSync } from "node:fs";
import { runHostCheck } from "./coding-host-check.ts";
import { parsePiRoles } from "./pi-readiness.ts";
import type { RunContractInput } from "./run-contract.ts";
import type { IsolatedWorkspace, WorkerHost, WorkerRoles } from "./inner-worker-route.ts";

export interface CodingTurnResult {
  revision: string;
  evidence: string[];
  accepted?: boolean;
  costUsd: number | null;
  modelUsed?: { instanceId: string; model: string };
}

export interface CodingTurnPort {
  /** Implementation must call the server's startTurn, not a driver adapter directly. */
  run(input: { botId: string; workspace: IsolatedWorkspace; role: string; prompt: string;
    requestId: string; signal: AbortSignal }): Promise<CodingTurnResult>;
}

export function createCodingWorkerHost(options: {
  rolesFilePath?: string;
  roles: ReadonlyMap<string, WorkerRoles & { developmentBotId: string; reviewerBotId: string }>;
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
        const roles = parsePiRoles(readFileSync(options.rolesFilePath, "utf8"));
        if (!roles.development || !roles["independent-review"] ||
          config.development !== roles.development || config.independentReview !== roles["independent-review"]) return null;
        return { development: roles.development, independentReview: roles["independent-review"] };
      } catch { return null; }
    },
    async acquire(contract, requestId) {
      const workspace = await options.workspace.acquire(contract, requestId);
      if (workspace.repository !== contract.repository || workspace.branch !== contract.ref) {
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
      const result = await options.turn.run({ botId: config.developmentBotId, workspace, role: "development", prompt: goal, requestId, signal });
      return { revision: result.revision, evidence: result.evidence, costUsd: result.costUsd,
        progress: Boolean(result.revision && result.evidence.length), modelUsed: result.modelUsed };
    },
    async runHostCheck(workspace, command, revision) {
      return runHostCheck({ command, cwd: workspace.directory, revision });
    },
    async review(workspace, role, revision, signal) {
      const config = options.roles.get(workspace.repository);
      if (!config || !(await this.roles(workspace.repository)) || config.independentReview !== role || !config.reviewerBotId) {
        throw new Error("independent reviewer is not configured");
      }
      const requestId = leases.get(workspace.leaseId);
      if (!requestId) throw new Error("review has no originating coding request");
      const result = await options.turn.run({ botId: config.reviewerBotId, workspace, role: "review",
        prompt: `Review revision ${revision}. Report whether it meets the stated goal.`,
        requestId: `review:${requestId}:${revision}`, signal });
      return { revision: result.revision, evidence: result.evidence, costUsd: result.costUsd,
        accepted: result.accepted === true && result.revision === revision && result.evidence.length > 0,
        modelUsed: result.modelUsed };
    },
    verifyWithPstack: options.verify,
  };
}
