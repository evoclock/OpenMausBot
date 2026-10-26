import { createHash } from "node:crypto";
import { join } from "node:path";
import { createWorkerRoute, type WorkerHost } from "./inner-worker-route.ts";
import { openOuterRunner } from "./outer-runner.ts";
import { createIterationContextCompactor } from "./iteration-context-compactor.ts";
import { CodingEffectReceipts, type EffectReconcileHost } from "./coding-effect-receipts.ts";
import type { InstalledWorkerDriver } from "./driver-run-api.ts";
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
  driver?: InstalledWorkerDriver;
  loadDriver?: () => Promise<InstalledWorkerDriver>;
}) {
  const receipts = new CodingEffectReceipts(join(options.dataDir, "effect-receipts.sqlite"));
  let driver = options.driver;
  let driverPromise: Promise<InstalledWorkerDriver> | undefined;
  const resolveDriver = (): Promise<InstalledWorkerDriver> => {
    if (driver) return Promise.resolve(driver);
    if (!options.loadDriver) return Promise.reject(new Error("durable worker driver is unavailable"));
    driverPromise ??= options.loadDriver().then(async (loaded) => {
      if (typeof loaded.invokeWorker !== "function" || typeof loaded.status !== "function" ||
        typeof loaded.reconcile !== "function" || typeof loaded.close !== "function") {
        await loaded.close();
        throw new Error("installed driver lacks the durable worker transport");
      }
      driver = loaded;
      return loaded;
    }).catch((error) => {
      driverPromise = undefined;
      throw error;
    });
    return driverPromise;
  };
  const route = createWorkerRoute(options.workerHost, options.driver || options.loadDriver ? {
    async invoke(requestId, goal, signal, work) {
      let activeDriver: InstalledWorkerDriver;
      try { activeDriver = await resolveDriver(); }
      catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { kind: "blocked", evidence: [`durable worker driver unavailable: ${detail}`], costUsd: 0 };
      }
      const result = await activeDriver.invokeWorker({ requestId, goal, signal,
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
          if (!options.driver && !options.loadDriver) return true;
          const activeDriver = await resolveDriver();
          const runId = createHash("sha256").update(`worker:${requestId}`).digest("hex");
          const run = await activeDriver.status(runId);
          const step = run?.steps[0];
          if (!step || run.steps.length !== 1) return false;
          const reference = `omb-result:${createHash("sha256").update(JSON.stringify(result)).digest("hex")}`;
          if (step.state === "finished") return step.receipt?.reference === reference;
          if (!["held", "intent"].includes(step.state) || run?.state === "cancelled") return false;
          await activeDriver.reconcile(runId, { stepId: step.id, requestKey: step.requestKey,
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
    async close() {
      await runner.close();
      const activeDriver = driver ?? (driverPromise ? await driverPromise.catch(() => undefined) : undefined);
      await activeDriver?.close();
      receipts.close();
    },
  };
}
