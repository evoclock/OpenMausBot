import type { RunContractInput } from "./run-contract.ts";
import type { IsolatedWorkspace, WorkerHost, WorkerRoles } from "./inner-worker-route.ts";

export interface CodingTurnResult {
  revision: string;
  evidence: string[];
  accepted?: boolean;
}

export interface CodingTurnPort {
  /** Implementation must call the server's startTurn, not a driver adapter directly. */
  run(input: { botId: string; workspace: IsolatedWorkspace; role: string; prompt: string;
    requestId: string; signal: AbortSignal }): Promise<CodingTurnResult>;
}

export function createCodingWorkerHost(options: {
  roles: ReadonlyMap<string, WorkerRoles & { developmentBotId: string; reviewerBotId: string }>;
  workspace: { acquire(contract: RunContractInput, requestId: string): Promise<IsolatedWorkspace>;
    release(leaseId: string, reason: string): Promise<void> };
  turn: CodingTurnPort;
  verify: (workspace: IsolatedWorkspace, revision: string, criteria: string[], signal: AbortSignal) => Promise<string[] | null>;
}): WorkerHost {
  const requests = new Map<string, { botId: string; repository: string }>();
  return {
    async roles(repository) {
      const config = options.roles.get(repository);
      if (!config || !config.developmentBotId || !config.reviewerBotId ||
        config.developmentBotId === config.reviewerBotId) return null;
      return { development: config.development, independentReview: config.independentReview };
    },
    async acquire(contract, requestId) {
      const workspace = await options.workspace.acquire(contract, requestId);
      if (workspace.repository !== contract.repository || workspace.branch !== contract.ref) {
        throw new Error("workspace does not match coding contract");
      }
      requests.set(requestId, { botId: contract.botId, repository: contract.repository });
      return workspace;
    },
    async release(leaseId, reason) { await options.workspace.release(leaseId, reason); },
    async runPlaybook(workspace, role, goal, requestId, signal) {
      const request = requests.get(requestId);
      const config = request && options.roles.get(request.repository);
      if (!request || !config || config.development !== role || !config.developmentBotId) {
        throw new Error("coding worker role is not configured for this run");
      }
      const result = await options.turn.run({ botId: config.developmentBotId, workspace, role, prompt: goal, requestId, signal });
      return { revision: result.revision, evidence: result.evidence, progress: Boolean(result.revision && result.evidence.length) };
    },
    async review(workspace, role, revision, signal) {
      const config = options.roles.get(workspace.repository);
      if (!config || config.independentReview !== role || !config.reviewerBotId) {
        throw new Error("independent reviewer is not configured");
      }
      const result = await options.turn.run({ botId: config.reviewerBotId, workspace, role,
        prompt: `Review revision ${revision}. Report whether it meets the stated goal.`, requestId: `review:${revision}`, signal });
      return { revision: result.revision, evidence: result.evidence,
        accepted: result.accepted === true && result.revision === revision && result.evidence.length > 0 };
    },
    verifyWithPstack: options.verify,
  };
}
