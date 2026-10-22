import { join } from "node:path";
import { createWorkerRoute, type WorkerHost } from "./inner-worker-route.ts";
import { openOuterRunner } from "./outer-runner.ts";
import { CodingEffectReceipts, type EffectReconcileHost } from "./coding-effect-receipts.ts";
import type { RunSnapshot } from "./run-contract.ts";
import { startGithubCodingRun, startScheduledCodingRun, startWebhookCodingRun, type TriggerTemplate } from "./run-triggers.ts";

interface GithubRegistration {
  secret: string;
  template: TriggerTemplate;
}

export async function openCodingRunRuntime(options: {
  dataDir: string;
  workerHost: WorkerHost;
  routines: ReadonlyMap<string, TriggerTemplate>;
  github: ReadonlyMap<string, GithubRegistration>;
  webhooks?: ReadonlyMap<string, TriggerTemplate>;
  onTerminal?: (snapshot: RunSnapshot) => boolean | void;
  effectInspector?: EffectReconcileHost;
}) {
  const receipts = new CodingEffectReceipts(join(options.dataDir, "effect-receipts.sqlite"));
  const route = createWorkerRoute(options.workerHost);
  let runner: Awaited<ReturnType<typeof openOuterRunner>>;
  try {
    runner = await openOuterRunner(options.dataDir, { async invoke(contract, iteration, requestId, signal, remainingUsd) {
      const result = await route.invoke(contract, iteration, requestId, signal, remainingUsd);
      if (result.costUsd != null && Number.isFinite(result.costUsd) && result.costUsd >= 0) {
        receipts.saveResult(contract.id, iteration, requestId, result);
      }
      return result;
    } }, { onTerminal: options.onTerminal,
      ...(options.effectInspector ? { effectRecovery: { receipts, host: options.effectInspector,
        async recoverResult(contract, iteration, requestId) { return receipts.savedResult(contract.id, iteration, requestId); },
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
    async close() { try { await runner.close(); } finally { receipts.close(); } },
  };
}
