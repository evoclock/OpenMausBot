import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { ApprovalMode } from "../shared/approval-mode.ts";
import type { CodingRunConfig } from "./coding-run-config.ts";
import { CodingResultDelivery, codingResultStoreSink } from "./coding-result-delivery.ts";
import { openCodingRunRuntime } from "./coding-run-runtime.ts";
import { createCodingStartTurnPort } from "./coding-start-turn.ts";
import { CodingTreehouseWorkspace } from "./coding-treehouse-workspace.ts";
import { createCodingWorkerHost } from "./coding-worker-host.ts";
import { RunContractStore, type RunSnapshot } from "./run-contract.ts";
import { scheduledCodingRunId, type TriggerTemplate } from "./run-triggers.ts";
import type { RoutineManager, RoutineRun } from "./routines.ts";
import type { Store } from "./store.ts";

export async function openProductionCodingRuntime(options: {
  config: CodingRunConfig;
  dataDir: string;
  store: Store;
  routines: RoutineManager;
  sourceApprovalMode: (botId: string, threadId: string) => ApprovalMode;
  driverKind: (botId: string) => string | undefined;
  startTurn: (botId: string, text: string, input: { threadId: string;
    onTurnSettled: () => void; onDispatchError: (error: string) => void }) => Promise<void>;
  interrupt: (botId: string, threadId: string) => Promise<void>;
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
  const roles = new Map(registrations.map((entry) => [entry.repository, {
    development: entry.developmentRole, independentReview: entry.reviewRole,
    developmentBotId: entry.workerBotId, reviewerBotId: entry.reviewerBotId,
  }]));
  for (const entry of registrations) {
    if (templates.has(entry.routineId)) throw new Error("duplicate coding routine registration");
    templates.set(entry.routineId, {
      botId: routines.listRoutines().find((routine) => routine.id === entry.routineId)?.botId ?? "",
      repository: entry.repository, ref: entry.ref, repositoryClass: "agent-private",
      successCriteria: entry.successCriteria, allowedEffects: ["edit", "commit"], authorisedExternalWrites: [],
    });
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
        run.triggerSource !== "schedule") throw new Error("coding run has no active originating routine thread");
      return options.sourceApprovalMode(origin.botId, origin.threadId);
    },
    driverKind: options.driverKind, startTurn: options.startTurn, interrupt: options.interrupt,
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
    const linked = runStore.routineLink(snapshot.contract.id);
    const origin = origins.get(snapshot.contract.id);
    const routineRunId = linked?.routineId ?? origin?.runId;
    const run = routineRunId ? routines.listRuns().find((candidate) => candidate.id === routineRunId) : undefined;
    if (!run?.threadId) return false;
    runStore.linkRoutine(run.id, snapshot.contract.id);
    const evidence = snapshot.evidence.filter((item) => item.trim()).join("\n");
    const text = `Coding run ${snapshot.state}: ${evidence || "No result was reported."}`;
    if (delivery.deliver({ runId: snapshot.contract.id, botId: run.botId,
      threadId: run.threadId, text }) !== "delivered") return false;
    const event = { eventId: `coding-result:${snapshot.contract.id}`, provider: "coding",
      threadId: run.threadId, createdAt: new Date().toISOString() };
    if (snapshot.state === "done") {
      routines.handleRuntimeEvent({ ...event, type: "item.completed", itemType: "assistant_text", text });
    } else {
      routines.handleRuntimeEvent({ ...event, type: "runtime.error", message: text });
    }
    routines.handleRuntimeEvent({ ...event, type: "turn.completed", ok: snapshot.state === "done",
      stopReason: snapshot.state === "done" ? "end_turn" : snapshot.state });
    return true;
  };
  const runtime = await openCodingRunRuntime({ dataDir: codingDir, workerHost: host,
    routines: templates, github: new Map(), onTerminal: deliver });
  for (const run of routines.listRuns()) {
    if (run.triggerSource !== "schedule" || !run.threadId || !templates.has(run.routineId)) continue;
    const id = scheduledCodingRunId(run);
    if (runtime.get(id)) runStore.linkRoutine(run.id, id);
  }
  runtime.reportPending();
  return {
    registered(routineId: string) { return templates.has(routineId); },
    async scheduled(run: RoutineRun, botId: string, threadId: string) {
      origins.set(scheduledCodingRunId(run), { botId, threadId, runId: run.id });
      const result = await runtime.scheduled(run);
      if ("id" in result && result.id) {
        runStore.linkRoutine(run.id, result.id);
        runtime.reportPending();
        const current = runtime.get(result.id);
        if (current && ["done", "blocked", "failed", "cancelled"].includes(current.state)) deliver(current);
      }
    },
    async close() { await runtime.close(); delivery.close(); runStore.close(); workspace.close(); },
  };
}
