import { createHash } from "node:crypto";
import { join } from "node:path";
import { createWorkerRoute, type WorkerHost } from "./inner-worker-route.ts";
import type { InnerLoopResult } from "./outer-runner.ts";
import { openOuterRunner } from "./outer-runner.ts";
import { createIterationContextCompactor } from "./iteration-context-compactor.ts";
import { CodingEffectReceipts, type EffectReconcileHost } from "./coding-effect-receipts.ts";
import type { RunSnapshot } from "./run-contract.ts";
import { startGithubCodingRun, startScheduledCodingRun, startWebhookCodingRun, type TriggerTemplate } from "./run-triggers.ts";

interface GithubRegistration {
  secret: string;
  template: TriggerTemplate;
}

export async function openCodingRunRuntime(options: {
  dataDir: string;
  restartLimit?: number;
  contextCarryMaxBytes?: number;
  workerHost: WorkerHost;
  routines: ReadonlyMap<string, TriggerTemplate>;
  github: ReadonlyMap<string, GithubRegistration>;
  webhooks?: ReadonlyMap<string, TriggerTemplate>;
  onTerminal?: (snapshot: RunSnapshot) => boolean | void;
  effectInspector?: EffectReconcileHost;
  driver?: {
    status(runId: string): Promise<{ state: string; steps: Array<{ id: string; requestKey: string;
      state: string; receipt?: { reference: string } }> } | null>;
    reconcile(runId: string, evidence: { stepId: string; requestKey: string;
      verified: boolean; reference?: string }): Promise<unknown>;
    invokeWorker(input: { requestId: string; goal: string; signal: AbortSignal;
      transport: { invoke(): Promise<{ result: InnerLoopResult; verified: true; reference: string }> } }):
      Promise<{ runId: string; state: string; result?: InnerLoopResult; step?: { receipt?: { reference: string } } }>;
    close(): Promise<void>;
  };
}) {
  const receipts = new CodingEffectReceipts(join(options.dataDir, "effect-receipts.sqlite"));
  const route = createWorkerRoute(options.workerHost, options.driver ? {
    async invoke(requestId, goal, signal, work) {
      const result = await options.driver!.invokeWorker({ requestId, goal, signal,
        transport: { async invoke() {
          const outcome = await work();
          if (outcome.kind === "blocked") throw new Error("inner invocation requires reconciliation");
          const [runId, sequence] = requestId.split(":");
          const iteration = Number(sequence);
          receipts.saveResult(runId!, iteration, requestId, outcome);
          const reference = `omb-result:${createHash("sha256").update(JSON.stringify(outcome)).digest("hex")}`;
          return { result: outcome, verified: true, reference };
        } },
      });
      if (result.state !== "finished") throw new Error(`durable worker ${result.state}; reconcile before retry`);
      if (result.result) return result.result;
      const [runId, sequence] = requestId.split(":");
      const saved = receipts.savedResult(runId!, Number(sequence), requestId);
      if (!saved || result.step?.receipt?.reference !==
        `omb-result:${createHash("sha256").update(JSON.stringify(saved)).digest("hex")}`) {
        throw new Error("durable worker result requires reconciliation");
      }
      return saved;
    },
  } : undefined);
  let runner: Awaited<ReturnType<typeof openOuterRunner>>;
  try {
    runner = await openOuterRunner(options.dataDir, { async invoke(contract, iteration, requestId, signal, remainingUsd, context) {
      const result = await route.invoke(contract, iteration, requestId, signal, remainingUsd, context);
      if (result.costUsd != null && Number.isFinite(result.costUsd) && result.costUsd >= 0) {
        receipts.saveResult(contract.id, iteration, requestId, result);
      }
      return result;
    } }, { onTerminal: options.onTerminal, restartLimit: options.restartLimit,
      contextCompactor: createIterationContextCompactor(options.contextCarryMaxBytes),
      ...(options.effectInspector ? { effectRecovery: { receipts, host: options.effectInspector,
        async recoverResult(contract, iteration, requestId) { return receipts.savedResult(contract.id, iteration, requestId); },
        async confirmInvocation(requestId, result) {
          if (!options.driver) return true;
          const runId = createHash("sha256").update(`worker:${requestId}`).digest("hex");
          const run = await options.driver.status(runId);
          const step = run?.steps[0];
          if (!step || run.steps.length !== 1) return false;
          const reference = `omb-result:${createHash("sha256").update(JSON.stringify(result)).digest("hex")}`;
          if (step.state === "finished") return step.receipt?.reference === reference;
          if (!["held", "intent"].includes(step.state) || run?.state === "cancelled") return false;
          await options.driver.reconcile(runId, { stepId: step.id, requestKey: step.requestKey,
            verified: true, reference });
          return true;
        },
      } } : {}),
    });
  } catch (error) { receipts.close(); throw error; }
  runner.resume();
  return {
    scheduled(run: { id: string; routineId: string; botId: string; scheduledFor: number;
      triggerSource?: string; status: string }) {
      const template = options.routines.get(run.routineId);
      return template ? startScheduledCodingRun(runner, run, template)
        : Promise.resolve({ status: "ignored" as const });
    },
    webhook(run: { id: string; routineId: string; botId: string; webhookId?: string;
      deliveryId?: string; triggerSource?: string; status: string }) {
      const template = run.webhookId && options.webhooks?.get(run.webhookId);
      return template && run.webhookId ? startWebhookCodingRun(runner, run, run.webhookId, template)
        : Promise.resolve({ status: "ignored" as const });
    },
    github(registrationId: string, input: { raw: Buffer; signature: string; deliveryId: string; event: string }) {
      const registration = options.github.get(registrationId);
      if (!registration) throw new Error("unknown coding webhook registration");
      return startGithubCodingRun(runner, { ...input, secret: registration.secret }, registration.template);
    },
    get: runner.get,
    report: runner.report,
    reportPending: runner.reportPending,
    cancel: runner.cancel,
    async close() { await runner.close(); await options.driver?.close(); receipts.close(); },
  };
}
