import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { ApprovalMode } from "../shared/approval-mode.ts";
import type { ToolScope } from "../shared/tool-scope.ts";
import { codingGitToolScope, createCodingGitRunPolicy, type CodingGitHost, type CodingGitRequest } from "./coding-git-policy.ts";
import type { CodingRunConfig } from "./coding-run-config.ts";
import { CodingResultDelivery, codingResultStoreSink } from "./coding-result-delivery.ts";
import { openCodingRunRuntime } from "./coding-run-runtime.ts";
import { createCodingStartTurnPort } from "./coding-start-turn.ts";
import { CodingTreehouseWorkspace } from "./coding-treehouse-workspace.ts";
import { createCodingWorkerHost } from "./coding-worker-host.ts";
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
  sourceApprovalMode: (botId: string, threadId: string) => ApprovalMode;
  driverKind: (botId: string) => string | undefined;
  startTurn: (botId: string, text: string, input: { threadId: string; requestId: string;
    triggerSource: "schedule" | "webhook"; allowedFallbackModels: Array<{ instanceId: string; model: string }>;
    onTurnSettled: () => void; onDispatchError: (error: string) => void }) => Promise<void>;
  interrupt: (botId: string, threadId: string) => Promise<void>;
  gitHost?: CodingGitHost;
}) {
  const { config, dataDir, store, routines } = options;
  const registrations = config.registrations;
  const first = registrations[0];
  const repository = first?.repository;
  if (!repository || registrations.some((entry) => entry.repository !== repository ||
    entry.workerBotId !== first.workerBotId || entry.reviewerBotId !== first.reviewerBotId ||
    entry.developmentRole !== first.developmentRole || entry.reviewRole !== first.reviewRole ||
    entry.workerBotId === entry.reviewerBotId || entry.developmentRole === entry.reviewRole)) {
    throw new Error("coding registrations require one repository and distinct worker and reviewer routes");
  }
  const codingDir = join(dataDir, "coding-run");
  const workspace = new CodingTreehouseWorkspace({ repository, root: config.repositoryRoot, dataDir: codingDir });
  const runStore = new RunContractStore(join(codingDir, "runtime.db"));
  const delivery = new CodingResultDelivery(join(codingDir, "delivery.sqlite"), codingResultStoreSink(store));
  delivery.replay();
  const origins = new Map<string, { botId: string; threadId: string; runId: string }>();
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
      maxWallTimeMs: botConfig.maxWallTimeMs, maxSpendUsd: botConfig.maxSpendUsd,
      allowedFallbackModels: botConfig.allowedFallbackModels,
      allowedFallbackDataRoutes: botConfig.allowedFallbackDataRoutes,
    };
    const template: TriggerTemplate = {
      botId,
      repository: entry.repository, ref: entry.ref, repositoryClass: "agent-private",
      successCriteria: entry.successCriteria, allowedEffects: ["edit", "commit"], authorisedExternalWrites: [],
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
    approvalMode(requestId) {
      const origin = originForRequest(requestId);
      const run = origin && routines.runForThread(origin.threadId);
      if (!run || run.id !== origin.runId || run.botId !== origin.botId || run.status !== "running" ||
        (run.triggerSource !== "schedule" && run.triggerSource !== "webhook")) {
        throw new Error("coding run has no active originating routine thread");
      }
      return run.triggerSource === "webhook" ? "ask" : options.sourceApprovalMode(origin.botId, origin.threadId);
    },
    driverKind: options.driverKind,
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
      const request = input.requestId.startsWith("review:") ? input.requestId.slice(7) : input.requestId;
      const allowedFallbackModels = origin ? runStore.get(request.slice(0, 36))
        ?.contract.limits?.allowedFallbackModels ?? [] : [];
      await options.startTurn(botId, text, { ...input, allowedFallbackModels,
        triggerSource: run?.triggerSource === "webhook" ? "webhook" : "schedule" });
    },
    interrupt: options.interrupt,
  });
  const host = createCodingWorkerHost({ roles, workspace, turn,
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
    const evidence = snapshot.evidence.filter((item) => item.trim()).join("\n");
    const detail = evidence || "No result was reported.";
    routines.settleCodingRun(run.id, snapshot);
    return delivery.deliver({ runId: snapshot.contract.id, botId: run.botId,
      threadId: run.threadId, text: `Coding run ${snapshot.state}: ${detail}` }) === "delivered";
  };
  const runtime = await openCodingRunRuntime({ dataDir: codingDir, restartLimit: config.restartLimit, workerHost: host,
    routines: templates, webhooks: webhookTemplates, github: new Map(), onTerminal: deliver });
  for (const run of routines.listRuns()) {
    if (!run.threadId) continue;
    const id = run.triggerSource === "schedule" && templates.has(run.routineId)
      ? scheduledCodingRunId(run)
      : run.triggerSource === "webhook" && run.webhookId && run.deliveryId && webhookTemplates.has(run.webhookId)
        ? webhookCodingRunId(run.webhookId, run.deliveryId) : null;
    if (id && runtime.get(id)) runStore.linkRoutine(run.id, id);
  }
  runtime.reportPending();
  const gitAction = options.gitHost ? createCodingGitRunPolicy(config, runStore, options.gitHost)
    : async (_request: CodingGitRequest): Promise<"applied" | "owner-eligible"> => {
      throw new Error("Git destination refused: no credential provider and checked host Git port are configured");
    };
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
    async close() { await runtime.close(); delivery.close(); runStore.close(); workspace.close(); },
  };
}
