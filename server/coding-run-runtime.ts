import { createWorkerRoute, type WorkerHost } from "./inner-worker-route.ts";
import { openOuterRunner } from "./outer-runner.ts";
import { startGithubCodingRun, startScheduledCodingRun, type TriggerTemplate } from "./run-triggers.ts";

interface GithubRegistration {
  secret: string;
  template: TriggerTemplate;
}

export async function openCodingRunRuntime(options: {
  dataDir: string;
  workerHost: WorkerHost;
  routines: ReadonlyMap<string, TriggerTemplate>;
  github: ReadonlyMap<string, GithubRegistration>;
}) {
  const runner = await openOuterRunner(options.dataDir, createWorkerRoute(options.workerHost));
  runner.resume();
  return {
    scheduled(run: { id: string; routineId: string; botId: string; scheduledFor: number;
      triggerSource?: string; status: string }) {
      const template = options.routines.get(run.routineId);
      return template ? startScheduledCodingRun(runner, run, template)
        : Promise.resolve({ status: "ignored" as const });
    },
    github(registrationId: string, input: { raw: Buffer; signature: string; deliveryId: string; event: string }) {
      const registration = options.github.get(registrationId);
      if (!registration) throw new Error("unknown coding webhook registration");
      return startGithubCodingRun(runner, { ...input, secret: registration.secret }, registration.template);
    },
    get: runner.get,
    close: runner.close,
  };
}
