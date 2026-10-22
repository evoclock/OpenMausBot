import type { RunContractInput } from "./run-contract.ts";
import { codingPlaybookPrompt } from "./coding-playbook-prompt.ts";
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
  costUsd?: number | null;
}

export interface ReviewReport {
  revision: string;
  accepted: boolean;
  evidence: string[];
  costUsd?: number | null;
}

export interface WorkerHost {
  roles(repository: string): Promise<WorkerRoles | null>;
  /** acquire must be idempotent per requestId: outer-loop replay must return the same workspace and lease. */
  acquire(contract: RunContractInput, requestId: string): Promise<IsolatedWorkspace>;
  release(leaseId: string, reason: string): Promise<void>;
  runPlaybook(workspace: IsolatedWorkspace, role: string, goal: string, requestId: string, signal: AbortSignal): Promise<WorkerReport>;
  review(workspace: IsolatedWorkspace, role: string, revision: string, signal: AbortSignal): Promise<ReviewReport>;
  verifyWithPstack(workspace: IsolatedWorkspace, revision: string, criteria: string[], signal: AbortSignal): Promise<string[] | null>;
}

export function createWorkerRoute(host: WorkerHost, durable?: {
  invoke(requestId: string, goal: string, signal: AbortSignal,
    work: () => Promise<InnerLoopResult>): Promise<InnerLoopResult>;
}): InnerLoop {
  return {
    async invoke(contract, _iteration, requestId, signal, remainingUsd, context): Promise<InnerLoopResult> {
      const prior = context?.previous;
      const carry = prior ? context?.compactor?.compact(prior) ??
        `Previous iteration ${prior.iteration} verdict: ${prior.verdict}\nEvidence:\n${prior.evidence.join("\n")}` : "";
      const goal = `Iteration ${context?.iteration ?? _iteration}\n${codingPlaybookPrompt(contract, remainingUsd ?? contract.limits?.maxSpendUsd ?? 0)}${carry ? `\n${carry}` : ""}`;
      const work = async (): Promise<InnerLoopResult> => {
      if (signal.aborted) return { kind: "blocked", evidence: ["run cancelled"], costUsd: 0 };
      if (contract.repositoryClass !== "agent-private") return { kind: "blocked", evidence: ["external repository requires a separate verified route"], costUsd: 0 };
      const roles = await host.roles(contract.repository);
      if (!roles?.development || !roles.independentReview || roles.development === roles.independentReview) {
        return { kind: "blocked", evidence: ["distinct worker and reviewer routes are unavailable"], costUsd: 0 };
      }
      const workspace = await host.acquire(contract, requestId);
      let releaseReason = "worker route failed; reconcile outward effects";
      let retainLease = false;
      let blockedEvidence: string[] = [];
      let spentUsd: number | null = 0;
      const charge = (cost: number | null | undefined): boolean => {
        if (cost === null || cost === undefined || !Number.isFinite(cost) || cost < 0) {
          spentUsd = null;
          return false;
        }
        spentUsd = (spentUsd ?? 0) + cost;
        return spentUsd < (remainingUsd ?? contract.limits?.maxSpendUsd ?? 0);
      };
      const blocked = (reason: string, detail?: string): InnerLoopResult => {
        releaseReason = reason;
        blockedEvidence = detail ? [reason, detail] : [reason];
        return { kind: "blocked", evidence: blockedEvidence, costUsd: spentUsd };
      };
      try {
        if (workspace.repository !== contract.repository || workspace.branch !== contract.ref ||
          !workspace.base || !workspace.directory || !workspace.leaseId) {
          return blocked("isolated workspace does not match the run contract");
        }
        const report = await host.runPlaybook(workspace, roles.development, goal, requestId, signal);
        if (!charge(report.costUsd)) return blocked(spentUsd === null
          ? "coding run spend is uncertain; owner review required" : "spend ceiling reached before review");
        if (signal.aborted) return blocked("worker interrupted; reconcile outward effects");
        if (!report.revision || !report.progress) return blocked("worker made no verified progress");
        const review = await host.review(workspace, roles.independentReview, report.revision, signal);
        if (!charge(review.costUsd)) return blocked(spentUsd === null
          ? "coding run spend is uncertain; owner review required" : "spend ceiling reached after review");
        if (signal.aborted) return blocked("review interrupted; reconcile outward effects");
        if (review.revision !== report.revision || !review.accepted || !review.evidence.some((item) => item.trim())) {
          retainLease = true;
          return { kind: "progress", evidence: [...report.evidence, ...review.evidence], costUsd: spentUsd };
        }
        const verified = await host.verifyWithPstack(workspace, report.revision, contract.successCriteria, signal);
        if (signal.aborted) return blocked("verification interrupted; reconcile outward effects");
        retainLease = true;
        if (!verified?.some((item) => item.trim())) {
          return { kind: "progress", evidence: [...report.evidence, ...review.evidence], costUsd: spentUsd };
        }
        return { kind: "verified", evidence: [...report.evidence, ...review.evidence, ...verified], costUsd: spentUsd };
      } catch (error) {
        return blocked("worker route failed; reconcile outward effects",
          error instanceof Error ? error.message : String(error));
      } finally {
        if (!retainLease && workspace.leaseId) {
          try {
            await host.release(workspace.leaseId, releaseReason);
          } catch (error) {
            blockedEvidence.push(`lease release failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      };
      return durable ? durable.invoke(requestId, goal, signal, work) : work();
    },
  };
}
