import type { HostCheckRecord, RunContractInput } from "./run-contract.ts";
import { codingPlaybookPrompt } from "./coding-playbook-prompt.ts";
import type { InnerLoop, InnerLoopResult } from "./outer-runner.ts";
import { execFileSync } from "node:child_process";

export interface WorkerRoles {
  development: string;
  independentReview: string;
}

export interface IsolatedWorkspace {
  repository: string;
  directory: string;
  branch: string;
  baseBranch: string;
  base: string;
  leaseId: string;
}

export interface WorkerReport {
  revision: string;
  evidence: string[];
  progress: boolean;
  costUsd?: number | null;
  modelUsed?: { instanceId: string; model: string };
}

export interface ReviewReport {
  revision: string;
  accepted: boolean;
  evidence: string[];
  costUsd?: number | null;
  modelUsed?: { instanceId: string; model: string };
}

export interface WorkerHost {
  roles(repository: string): Promise<WorkerRoles | null>;
  /** acquire must be idempotent per requestId: outer-loop replay must return the same workspace and lease. */
  acquire(contract: RunContractInput, requestId: string): Promise<IsolatedWorkspace>;
  release(leaseId: string, reason: string): Promise<void>;
  runPlaybook(workspace: IsolatedWorkspace, role: string, goal: string, requestId: string, signal: AbortSignal): Promise<WorkerReport>;
  review(workspace: IsolatedWorkspace, role: string, revision: string, signal: AbortSignal): Promise<ReviewReport>;
  verifyWithPstack(workspace: IsolatedWorkspace, revision: string, criteria: string[], signal: AbortSignal): Promise<string[] | null>;
  runHostCheck(workspace: IsolatedWorkspace, command: string[], revision: string): Promise<HostCheckRecord>;
}

export function createWorkerRoute(host: WorkerHost, durable?: {
  invoke(requestId: string, goal: string, signal: AbortSignal,
    work: () => Promise<InnerLoopResult>): Promise<InnerLoopResult>;
}): InnerLoop {
  return {
    async invoke(contract, _iteration, requestId, signal, remainingUsd, context): Promise<InnerLoopResult> {
      const spendRequired = contract.limits?.modelAccess !== "subscription" && contract.limits?.modelAccess !== "local";
      const prior = context?.previous;
      const carry = prior ? context?.compactor?.compact(context.history ?? [prior]) ??
        `Previous iteration ${prior.iteration} verdict: ${prior.verdict}\nEvidence:\n${prior.evidence.join("\n")}` : "";
      const goal = `Iteration ${context?.iteration ?? _iteration}\n${codingPlaybookPrompt(contract, spendRequired ? remainingUsd ?? contract.limits?.maxSpendUsd : undefined)}${carry ? `\n${carry}` : ""}`;
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
      const modelsUsed: Array<{ instanceId: string; model: string }> = [];
      const charge = (cost: number | null | undefined): boolean => {
        if (cost === null || cost === undefined || !Number.isFinite(cost) || cost < 0) {
          if (spendRequired) { spentUsd = null; return false; }
          return true;
        }
        spentUsd = (spentUsd ?? 0) + cost;
        return !spendRequired || spentUsd < (remainingUsd ?? contract.limits?.maxSpendUsd ?? 0);
      };
      const blocked = (reason: string, detail?: string): InnerLoopResult => {
        releaseReason = reason;
        blockedEvidence = detail ? [reason, detail] : [reason];
        return { kind: "blocked", evidence: blockedEvidence, costUsd: spentUsd, ...(modelsUsed.length ? { modelsUsed } : {}) };
      };
      try {
        if (workspace.repository !== contract.repository || workspace.baseBranch !== contract.ref ||
          !workspace.branch || !workspace.base || !workspace.directory || !workspace.leaseId) {
          return blocked("isolated workspace does not match the run contract");
        }
        const workspaceGoal = `${goal}\nTreehouse workspace is already leased at ${workspace.directory} on ${workspace.branch}. Work only there. Use read, write, edit, and coding_command for scoped files, checks, add, and commit. Git push and draft PR are handled by the host after verification. Do not acquire another workspace or call GitHub tools.`;
        const report = await host.runPlaybook(workspace, roles.development, workspaceGoal, requestId, signal);
        if (report.modelUsed) modelsUsed.push(report.modelUsed);
        if (!charge(report.costUsd)) return blocked(spentUsd === null
          ? "coding run spend is uncertain; owner review required" : "spend ceiling reached before review");
        if (signal.aborted) return blocked("worker interrupted; reconcile outward effects");
        if (!report.revision || !report.progress) {
          let dirty = "";
          try {
            dirty = execFileSync("git", ["status", "--porcelain"], {
              cwd: workspace.directory, encoding: "utf8", timeout: 30_000,
            }).trim();
          } catch { /* treat as clean */ }
          if (dirty) {
            retainLease = true;
            return {
              kind: "progress",
              evidence: [...report.evidence, "worker left uncommitted changes; continue"],
              costUsd: spentUsd,
              ...(modelsUsed.length ? { modelsUsed } : {}),
            };
          }
          return blocked("worker made no verified progress");
        }
        const review = await host.review(workspace, roles.independentReview, report.revision, signal);
        if (review.modelUsed) modelsUsed.push(review.modelUsed);
        if (!charge(review.costUsd)) return blocked(spentUsd === null
          ? "coding run spend is uncertain; owner review required" : "spend ceiling reached after review");
        if (signal.aborted) return blocked("review interrupted; reconcile outward effects");
        if (review.revision !== report.revision || !review.accepted || !review.evidence.some((item) => item.trim())) {
          retainLease = true;
          return { kind: "progress", evidence: [...report.evidence, ...review.evidence], costUsd: spentUsd,
            ...(modelsUsed.length ? { modelsUsed } : {}) };
        }
        const verified = await host.verifyWithPstack(workspace, report.revision, contract.successCriteria, signal);
        if (signal.aborted) return blocked("verification interrupted; reconcile outward effects");
        retainLease = true;
        if (!verified?.some((item) => item.trim())) {
          return { kind: "progress", evidence: [...report.evidence, ...review.evidence], costUsd: spentUsd,
            ...(modelsUsed.length ? { modelsUsed } : {}) };
        }
        if (!contract.checkCommand) return { kind: "blocked", evidence: [...report.evidence, "run contract has no host check command"], costUsd: spentUsd };
        const hostCheck = await host.runHostCheck(workspace, contract.checkCommand, report.revision);
        if (hostCheck.exitCode !== 0 || hostCheck.commitSha !== report.revision) {
          return { kind: "blocked", evidence: [...report.evidence, ...verified, "host check failed"], hostCheck, costUsd: spentUsd };
        }
        return { kind: "verified", evidence: [...report.evidence, ...review.evidence, ...verified], hostCheck, costUsd: spentUsd,
          ...(modelsUsed.length ? { modelsUsed } : {}) };
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
