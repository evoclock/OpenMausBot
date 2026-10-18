import type { RunContract } from "./run-contract.ts";
import type { InnerLoop, InnerLoopResult } from "./outer-runner.ts";

export interface WorkerRoles {
  development: string;
  independentReview: string;
}

export interface IsolatedWorkspace {
  repository: string;
  directory: string;
  branch: string;
  base: string;
  leaseId: string;
}

export interface WorkerReport {
  revision: string;
  evidence: string[];
  progress: boolean;
}

export interface ReviewReport {
  revision: string;
  accepted: boolean;
  evidence: string[];
}

export interface WorkerHost {
  roles(repository: string): Promise<WorkerRoles | null>;
  acquire(contract: RunContract, requestId: string): Promise<IsolatedWorkspace>;
  runPlaybook(workspace: IsolatedWorkspace, role: string, goal: string, requestId: string, signal: AbortSignal): Promise<WorkerReport>;
  review(workspace: IsolatedWorkspace, role: string, revision: string, signal: AbortSignal): Promise<ReviewReport>;
  verifyWithPstack(workspace: IsolatedWorkspace, revision: string, criteria: string[], signal: AbortSignal): Promise<string[] | null>;
}

export function createWorkerRoute(host: WorkerHost): InnerLoop {
  return {
    async invoke(contract, _iteration, requestId, signal): Promise<InnerLoopResult> {
      if (signal.aborted) return { kind: "blocked", evidence: ["run cancelled"] };
      if (contract.repositoryClass !== "agent-private") return { kind: "blocked", evidence: ["external repository requires a separate verified route"] };
      const roles = await host.roles(contract.repository);
      if (!roles?.development || !roles.independentReview || roles.development === roles.independentReview) {
        return { kind: "blocked", evidence: ["distinct worker and reviewer routes are unavailable"] };
      }
      const workspace = await host.acquire(contract, requestId);
      if (workspace.repository !== contract.repository || workspace.branch !== contract.ref ||
        !workspace.base || !workspace.directory || !workspace.leaseId) {
        return { kind: "blocked", evidence: ["isolated workspace does not match the run contract"] };
      }
      const report = await host.runPlaybook(workspace, roles.development,
        contract.successCriteria.join("\n"), requestId, signal);
      if (signal.aborted) return { kind: "blocked", evidence: ["worker interrupted; reconcile outward effects"] };
      if (!report.revision || !report.progress) return { kind: "blocked", evidence: ["worker made no verified progress"] };
      const review = await host.review(workspace, roles.independentReview, report.revision, signal);
      if (signal.aborted) return { kind: "blocked", evidence: ["review interrupted; reconcile outward effects"] };
      if (review.revision !== report.revision || !review.accepted || !review.evidence.some((item) => item.trim())) {
        return { kind: "progress", evidence: [...report.evidence, ...review.evidence] };
      }
      const verified = await host.verifyWithPstack(workspace, report.revision, contract.successCriteria, signal);
      if (signal.aborted) return { kind: "blocked", evidence: ["verification interrupted; reconcile outward effects"] };
      if (!verified?.some((item) => item.trim())) return { kind: "progress", evidence: [...report.evidence, ...review.evidence] };
      return { kind: "verified", evidence: [...report.evidence, ...review.evidence, ...verified] };
    },
  };
}
