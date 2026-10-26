import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ProviderRegistry } from "./harness/registry.ts";
import { codingModelChain, DEFAULT_CODING_LOCAL_PROVIDERS } from "./automatic-recovery.ts";
import type { ToolScope } from "../shared/tool-scope.ts";
import { codingGitToolScope, createCodingGitRunPolicy, type CodingGitHost } from "./coding-git-policy.ts";
import type { CodingRunConfig } from "./coding-run-config.ts";
import { createProductionCodingGitHost } from "./coding-git-host.ts";
import { publishVerifiedCodingRun } from "./coding-git-publisher.ts";
import { CodingResultDelivery, codingResultStoreSink } from "./coding-result-delivery.ts";
import { openCodingRunRuntime } from "./coding-run-runtime.ts";
import { createCodingStartTurnPort } from "./coding-start-turn.ts";
import { CodingTreehouseWorkspace } from "./coding-treehouse-workspace.ts";
import { createCodingWorkerHost } from "./coding-worker-host.ts";
import { requireDriverRunApi } from "./driver-run-api.ts";
import type { IsolatedWorkspace } from "./inner-worker-route.ts";
import { RunContractStore, type RunSnapshot } from "./run-contract.ts";
import { scheduledCodingRunId, webhookCodingRunId, type TriggerTemplate } from "./run-triggers.ts";
import { flushUsageLedger, readUsage } from "./usage-ledger.ts";
import type { RoutineManager, RoutineRun } from "./routines.ts";
import type { Store } from "./store.ts";
import type { WebhookManager } from "./webhooks.ts";

export function codingTurnToolScope(config: CodingRunConfig | undefined, botId: string,
  existing: ToolScope | undefined): ToolScope | undefined {
  return config?.registrations.some((entry) => entry.workerBotId === botId || entry.reviewerBotId === botId)
    ? codingGitToolScope(existing) : existing;
}

export async function openProductionCodingRuntime(options: {
  config: CodingRunConfig;
  dataDir: string;
  store: Store;
  routines: RoutineManager;
  webhooks: Pick<WebhookManager, "list">;
  onTaskCreated?: (botId: string, threadId: string, requestId: string, workspace: IsolatedWorkspace) => void;
  driverKind: (botId: string) => string | undefined;
  registry: Pick<ProviderRegistry, "instances" | "access">;
  startTurn: (botId: string, text: string, input: { threadId: string; requestId: string;
    triggerSource: "schedule" | "webhook"; allowedFallbackModels: Array<{ instanceId: string; model: string }>;
    onTurnSettled: () => void; onDispatchError: (error: string) => void }) => Promise<void>;
  interrupt: (botId: string, threadId: string) => Promise<void>;
  gitHost?: CodingGitHost;
}) {
  const { config, dataDir, store, routines } = options;
  const gitHost = options.gitHost ?? createProductionCodingGitHost(config);
  const registrations = config.registrations;
  const modelChain = () => codingModelChain(options.registry.instances().map((instance) => ({
    instanceId: instance.instanceId, driverKind: instance.driverKind, enabled: instance.enabled,
    access: options.registry.access(instance.instanceId), models: instance.models,
  })), config.localModelProviders ?? DEFAULT_CODING_LOCAL_PROVIDERS)
    .map(({ instanceId, model }) => ({ instanceId, model }));
  const first = registrations[0];
  const repository = first?.repository;
  if (!repository || registrations.some((entry) => entry.repository !== repository ||
    entry.workerBotId !== first.workerBotId || entry.reviewerBotId !== first.reviewerBotId ||
    entry.developmentRole !== first.developmentRole || entry.reviewRole !== first.reviewRole ||
    entry.workerBotId === entry.reviewerBotId || entry.developmentRole === entry.reviewRole)) {
    throw new Error("coding registrations require one repository and distinct worker and reviewer routes");
  }
  const codingDir = join(dataDir, "coding-run");
  const driverDir = join(codingDir, "durable-driver");
  mkdirSync(driverDir, { recursive: true, mode: 0o700 });
  const { openDurableDriver } = await requireDriverRunApi();
  const driver = await openDurableDriver({ directory: realpathSync(driverDir) });
  if (typeof driver.invokeWorker !== "function" || typeof driver.status !== "function" ||
    typeof driver.reconcile !== "function") {
    await driver.close();
    throw new Error("installed driver lacks the durable worker transport");
  }
  const workspaceManager = new CodingTreehouseWorkspace({ repository, root: config.repositoryRoot, dataDir: codingDir });
  const runStore = new RunContractStore(join(codingDir, "runtime.db"));
  const delivery = new CodingResultDelivery(join(codingDir, "delivery.sqlite"), codingResultStoreSink(store));
  delivery.replay();
  const origins = new Map<string, { botId: string; threadId: string; runId: string }>();
  const workspacesByRun = new Map<string, IsolatedWorkspace>();
  const publishing = new Map<string, Promise<string>>();
  const publicationResults = new Map<string, string>();
  let reportPending = () => {};
  const templates = new Map<string, TriggerTemplate>();
  const webhookTemplates = new Map<string, TriggerTemplate>();
  const roles = new Map(registrations.map((entry) => [entry.repository, {
    development: entry.developmentRole, independentReview: entry.reviewRole,
    developmentBotId: entry.workerBotId, reviewerBotId: entry.reviewerBotId,
  }]));
  const routinesById = new Map(routines.listRoutines().map((routine) => [routine.id, routine]));
  const hooksById = new Map(options.webhooks.list().map((hook) => [hook.id, hook]));
  for (const entry of registrations) {
    if (templates.has(entry.routineId) || webhookTemplates.has(entry.routineId)) {
      throw new Error("duplicate coding trigger registration");
    }
    const routine = routinesById.get(entry.routineId);
    const hook = hooksById.get(entry.routineId);
    if (Boolean(routine) === Boolean(hook) || hook?.delivery === "post") {
      throw new Error("coding trigger registration requires one applied schedule or run webhook");
    }
    const botId = (routine ?? hook)!.botId;
    const botConfig = config.bots?.[botId];
    const limits = botConfig && {
      maxWallTimeMs: botConfig.maxWallTimeMs, modelAccess: "subscription" as const,
      allowedFallbackModels: [],
      allowedFallbackDataRoutes: botConfig.allowedFallbackDataRoutes,
    };
    const template: TriggerTemplate = {
      botId,
      repository: entry.repository, ref: entry.ref, repositoryClass: "agent-private",
      successCriteria: entry.successCriteria, checkCommand: entry.checkCommand,
      allowedEffects: ["edit", "commit", "push", "draft-pr"], authorisedExternalWrites: [],
      ...(limits ? { limits, ...(botConfig.maxIterations ? { maxIterations: botConfig.maxIterations } : {}) } : {}),
    };
    (hook ? webhookTemplates : templates).set(entry.routineId, template);
  }
  const originForRequest = (requestId: string) => {
    const source = requestId.startsWith("review:") ? requestId.slice(7) : requestId;
    const id = source.slice(0, 36);
    const live = origins.get(id);
    if (live) return live;
    const linked = runStore.routineLink(id);
    const run = linked && routines.listRuns().find((candidate) => candidate.id === linked.routineId);
    return run?.threadId ? { botId: run.botId, threadId: run.threadId, runId: run.id } : null;
  };
  const turn = createCodingStartTurnPort({
    store,
    onTaskCreated(botId, threadId, requestId, workspace) {
      const runId = requestId.slice(0, 36);
      workspacesByRun.set(runId, workspace);
      options.onTaskCreated?.(botId, threadId, requestId, workspace);
    },
    assertActiveRun(requestId) {
      const origin = originForRequest(requestId);
      const run = origin && routines.runForThread(origin.threadId);
      if (!run || run.id !== origin.runId || run.botId !== origin.botId || run.status !== "running" ||
        (run.triggerSource !== "schedule" && run.triggerSource !== "webhook")) {
        throw new Error("coding run has no active originating routine thread");
      }
      return;
    },
    driverKind: options.driverKind,
    modelChain,
    async costForThread(botId, threadId, since) {
      if (!Number.isSafeInteger(since) || since <= 0) return null;
      await flushUsageLedger(dataDir);
      const rows = readUsage(dataDir, { from: new Date(since), to: new Date() })
        .filter((row) => row.botId === botId && row.threadId === threadId);
      const turns = store.tasks(botId).find((task) => task.threadId === threadId)?.usage?.turns;
      if (!rows.length || !turns || rows.length !== turns || rows.some((row) =>
        row.costUsd === null || !Number.isFinite(row.costUsd) || row.costUsd < 0)) return null;
      return rows.reduce((sum, row) => sum + row.costUsd!, 0);
    },
    async startTurn(botId, text, input) {
      const origin = originForRequest(input.requestId);
      const run = origin && routines.runForThread(origin.threadId);
      const allowedFallbackModels = origin ? modelChain() : [];
      await options.startTurn(botId, text, { ...input, allowedFallbackModels,
        triggerSource: run?.triggerSource === "webhook" ? "webhook" : "schedule" });
    },
    interrupt: options.interrupt,
  });
  const host = createCodingWorkerHost({ roles, rolesFilePath: config.rolesFilePath, workspace: workspaceManager, turn,
    async verify(leased, revision) {
      try {
        execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], { cwd: leased.directory, timeout: 10_000 });
        execFileSync("git", ["diff", "--check", `${leased.base}...${revision}`], { cwd: leased.directory, timeout: 10_000 });
        return ["Review accepted; revision exists and diff has no whitespace errors"];
      } catch { return null; }
    },
  });
  const deliver = (snapshot: RunSnapshot): boolean => {
    if (snapshot.state !== "done" && snapshot.state !== "blocked" &&
      snapshot.state !== "failed" && snapshot.state !== "cancelled") return false;
    const linked = runStore.routineLink(snapshot.contract.id);
    const origin = origins.get(snapshot.contract.id);
    const routineRunId = linked?.routineId ?? origin?.runId;
    const run = routineRunId ? routines.listRuns().find((candidate) => candidate.id === routineRunId) : undefined;
    if (!run?.threadId) return false;
    runStore.linkRoutine(run.id, snapshot.contract.id);
    runStore.claimRoutineTerminal(snapshot.contract.id, snapshot);
    if (snapshot.state === "done" && !publicationResults.has(snapshot.contract.id)) {
      let publication = publishing.get(snapshot.contract.id);
      if (!publication) {
        const workspace = workspacesByRun.get(snapshot.contract.id) ?? workspaceManager.findForRun(snapshot.contract.id);
        if (!workspace) return false;
        const candidateBranch = `bot/coding-${snapshot.contract.id.slice(0, 12)}`;
        const hasDestination = (config.gitDestinations?.[snapshot.contract.botId] ?? []).some((grant) =>
          grant.repository === snapshot.contract.repository && candidateBranch.startsWith(grant.branchPrefix));
        publication = publishVerifiedCodingRun({ snapshot, workspace, hasDestination,
          createBranch: (directory, branch, base) => gitHost.port.createBranch(directory, branch, base), gitAction })
          .then((branch) => branch ? `Published draft branch ${branch}` : "No authorized Git destination was configured")
          .catch((error) => `Draft publication failed: ${error instanceof Error ? error.message : String(error)}`);
        publishing.set(snapshot.contract.id, publication);
        void publication.then((result) => {
          publicationResults.set(snapshot.contract.id, result);
          publishing.delete(snapshot.contract.id);
          reportPending();
        });
        return false;
      }
      return false;
    }
    const evidence = snapshot.evidence.filter((item) => item.trim()).join("\n");
    const detail = [evidence || "No result was reported.", publicationResults.get(snapshot.contract.id)]
      .filter((item): item is string => Boolean(item)).join("\n");
    routines.settleCodingRun(run.id, snapshot);
    const models = (snapshot.modelsUsed ?? []).map((item) => `iteration ${item.iteration}: ${item.instanceId}/${item.model}`).join("; ");
    return delivery.deliver({ runId: snapshot.contract.id, botId: run.botId,
      threadId: run.threadId, text: `Coding run ${snapshot.state}: ${models ? `Models: ${models}. ` : ""}${detail}` }) === "delivered";
  };
  let runtime: Awaited<ReturnType<typeof openCodingRunRuntime>>;
  try {
    runtime = await openCodingRunRuntime({ dataDir: codingDir, restartLimit: config.restartLimit,
      contextCarryMaxBytes: config.contextCarryMaxBytes, workerHost: host,
      routines: templates, webhooks: webhookTemplates, github: new Map(), onTerminal: deliver, driver });
  } catch (error) { await driver.close(); throw error; }
  reportPending = runtime.reportPending;
  for (const run of routines.listRuns()) {
    if (!run.threadId) continue;
    const id = run.triggerSource === "schedule" && templates.has(run.routineId)
      ? scheduledCodingRunId(run)
      : run.triggerSource === "webhook" && run.webhookId && run.deliveryId && webhookTemplates.has(run.webhookId)
        ? webhookCodingRunId(run.webhookId, run.deliveryId) : null;
    if (id && runtime.get(id)) runStore.linkRoutine(run.id, id);
  }
  runtime.reportPending();
  const gitAction = createCodingGitRunPolicy(config, runStore, gitHost);
  const dispatch = async (run: RoutineRun, botId: string, threadId: string) => {
    const id = run.triggerSource === "webhook" && run.webhookId && run.deliveryId
      ? webhookCodingRunId(run.webhookId, run.deliveryId) : scheduledCodingRunId(run);
    origins.set(id, { botId, threadId, runId: run.id });
    const result = run.triggerSource === "webhook" ? await runtime.webhook(run) : await runtime.scheduled(run);
    if (!("id" in result)) throw new Error("coding trigger did not match its registration");
    runStore.linkRoutine(run.id, result.id);
    runtime.reportPending();
    const current = runtime.get(result.id);
    if (current && ["done", "blocked", "failed", "cancelled"].includes(current.state)) deliver(current);
  };
  return {
    gitAction,
    registered(routineId: string) { return templates.has(routineId) || webhookTemplates.has(routineId); },
    start(run: RoutineRun, botId: string, threadId: string, triggerSource: "schedule" | "webhook") {
      if (triggerSource === "webhook" && (!run.webhookId || !run.deliveryId ||
        !webhookTemplates.has(run.webhookId) || !options.webhooks.list().some((hook) =>
          hook.id === run.webhookId && hook.enabled && hook.delivery !== "post"))) {
        throw new Error("coding webhook registration is not active");
      }
      return dispatch(run, botId, threadId);
    },
    async close() { await runtime.close(); delivery.close(); runStore.close(); workspaceManager.close(); },
  };
}
