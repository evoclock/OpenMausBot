import { createWorkerRoute, type WorkerHost } from "./inner-worker-route.ts";
import { openOuterRunner } from "./outer-runner.ts";
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
  onTerminal?: (snapshot: RunSnapshot) => void;
}) {
  const runner = await openOuterRunner(options.dataDir, createWorkerRoute(options.workerHost),
    { onTerminal: options.onTerminal });
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
    close: runner.close,
  };
}
