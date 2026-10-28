import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import type { Message, Store } from "./store.ts";
import type { CodingTurnPort, CodingTurnResult } from "./coding-worker-host.ts";
import type { IsolatedWorkspace } from "./inner-worker-route.ts";
import { DEFAULT_RETRY_LOOP_MIN, retryLoop } from "./sentinel/detectors/retry-loop.ts";
import type { SentinelRecord } from "./sentinel/types.ts";
import { failedTurnCause } from "../shared/failed-turn.ts";

interface CodingStartTurnOptions {
  dataDir?: string;
  store: Pick<Store, "bot" | "tasks" | "createTask" | "patchTask" | "messagesFor"> &
    Partial<Pick<Store, "switchTaskModel" | "projectBotForTask">>;
  assertActiveRun: (requestId: string) => void;
  onTaskCreated?: (botId: string, threadId: string, requestId: string, workspace: IsolatedWorkspace) => void;
  /** The server's normal turn entry, not ProviderInstance.adapter.sendTurn. */
  startTurn: (botId: string, text: string, options: { threadId: string; requestId: string;
    onTurnSettled: () => void; onDispatchError: (error: string) => void;
    onTurnStalled?: (released: Promise<void>) => void }) => Promise<void>;
  interrupt: (botId: string, threadId: string) => Promise<void>;
  driverKind: (botId: string) => string | undefined;
  modelChain?: (botId: string) => Array<{ instanceId: string; model: string }>;
  costForThread: (botId: string, threadId: string, since: number) => Promise<number | null>;
}

// TODO: Share this OMB-local stuck-turn detector when Pi exposes a stable API.
const STUCK_TURN_CHASE = "One bounded chase after a stalled turn, an explicit BLOCKED: response, or a repeated failed-tool loop. Inspect the current isolated workspace and continue the original goal without repeating completed work or retrying denied actions. If the blocker remains, return BLOCKED: followed by the reason.";

function hasRetryLoop(threadId: string, messages: readonly Message[], turnId: string | undefined): boolean {
  if (!turnId) return false;
  const records = messages.flatMap((message): SentinelRecord[] =>
    message.role === "bot" && message.kind === "activity" && message.turnId === turnId && message.tool?.ok === false
      ? [{ type: "tool", id: message.id, threadId, turnId, at: message.at,
        tool: message.tool.name, ok: false, text: message.tool.output ?? message.tool.summary ?? "" }]
      : []);
  return retryLoop.detect(records, { queueWaitMs: 0, costUsd: 0, retryLoopMin: DEFAULT_RETRY_LOOP_MIN, now: 0 }).length > 0;
}

function revision(directory: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8", timeout: 10_000 }).trim();
}

export function createCodingStartTurnPort(options: CodingStartTurnOptions): CodingTurnPort {
  return {
    async run({ botId, workspace, role, prompt, requestId, signal }): Promise<CodingTurnResult> {
      if (signal.aborted) throw new Error("coding turn cancelled");
      if ((!options.modelChain && options.driverKind(botId) !== "piAgent") || !options.store.bot(botId)) {
        throw new Error("coding role requires a configured Pi bot");
      }
      const chain = options.modelChain?.(botId);
      const digest = createHash("sha256").update(requestId).digest("hex");
      const before = revision(workspace.directory);
      const attempts: Array<{ threadId: string; createdAt: number; modelUsed?: { instanceId: string; model: string } }> = [];
      const costUsd = async () => {
        const costs = await Promise.all(attempts.map((attempt) =>
          options.costForThread(botId, attempt.threadId, attempt.createdAt)));
        return costs.every((cost): cost is number => cost !== null && Number.isFinite(cost) && cost >= 0)
          ? costs.reduce((total, cost) => total + cost, 0) : null;
      };
      const modelUsage = () => {
        const modelsUsed = attempts.flatMap((attempt) => attempt.modelUsed ? [attempt.modelUsed] : []);
        const modelUsed = modelsUsed.at(-1);
        return { ...(modelUsed ? { modelUsed } : {}), ...(modelsUsed.length ? { modelsUsed } : {}) };
      };
      const blockedResult = async (detail: string): Promise<CodingTurnResult> => ({
        revision: "", evidence: [detail], blocked: true, costUsd: await costUsd(), ...modelUsage(),
      });
      for (let chase = 0; chase < 2; chase++) {
        let stalled = false;
        let stallRelease: Promise<void> | undefined;
        let abort: (() => void) | undefined;
        try {
          if (signal.aborted) throw new Error("coding turn cancelled");
          options.assertActiveRun(requestId);
          const title = `Coding ${digest}${chase === 0 ? "" : " chase"}`;
          const existing = options.store.tasks(botId).filter((task) => task.title === title);
          if (existing.length > 1) throw new Error("ambiguous coding turn task");
          if (existing.length && existing[0]?.cwd !== workspace.directory) throw new Error("coding task workspace changed");
          if (existing.length && options.store.messagesFor(existing[0]!.threadId).some((message) => message.role === "bot" && message.turnTerminal)) {
            throw new Error("coding turn already completed; reconcile its effects before replay");
          }
          if (existing.length) throw new Error("coding turn may have started; reconcile before replay");
          const task = options.store.createTask(botId, title, false, undefined, undefined,
            "full", undefined, workspace.directory);
          if (!task) throw new Error("coding turn task could not be created");
          if (!options.store.patchTask(botId, task.threadId, { cwd: workspace.directory, approvalMode: "full" })) {
            throw new Error("coding turn permission could not be pinned");
          }
          if (chain && (!chain.length || !options.store.switchTaskModel?.(botId, task.threadId, chain[0]!, false, false))) {
            throw new Error("coding run has no allowed subscription or local model; owner review required");
          }
          options.onTaskCreated?.(botId, task.threadId, requestId, workspace);
          const attempt: typeof attempts[number] = { threadId: task.threadId, createdAt: task.createdAt,
            ...(chain ? { modelUsed: options.store.projectBotForTask?.(botId, task.threadId)?.modelSelection } : {}) };
          attempts.push(attempt);
          let settle!: () => void;
          let fail!: (error: Error) => void;
          const finished = new Promise<void>((resolve, reject) => { settle = resolve; fail = reject; });
          abort = () => { void options.interrupt(botId, task.threadId).finally(() => fail(new Error("coding turn cancelled"))); };
          signal.addEventListener("abort", abort, { once: true });
          await options.startTurn(botId, chase === 0 ? prompt : `${STUCK_TURN_CHASE}\n\nOriginal goal:\n${prompt}`, {
            threadId: task.threadId, requestId, onTurnSettled: settle,
            onDispatchError: (error) => fail(new Error(error)),
            onTurnStalled(released) { stalled = true; stallRelease = released; },
          });
          await finished;
          if (signal.aborted) throw new Error("coding turn cancelled");
          if (chain) attempt.modelUsed = options.store.projectBotForTask?.(botId, task.threadId)?.modelSelection;
          const messages = options.store.messagesFor(task.threadId);
          const answer = messages.findLast((message) =>
            message.role === "bot" && message.kind === "text" && message.turnTerminal);
          const turnId = answer?.turnId ?? messages.findLast((message) => message.role === "bot" && message.turnId)?.turnId;
          const looping = hasRetryLoop(task.threadId, messages, turnId);
          const blocked = answer?.text?.trimStart().startsWith("BLOCKED:") === true;
          // With no answer, the turn's failure sits on its digest or error activity, not on a text message.
          const successful = answer ? answer.turnSucceeded !== false
            : !messages.some((message) => message.role === "bot" && message.turnSucceeded === false);
          const failure = answer ? null : messages.map((message) => message.role === "bot" && message.kind === "activity" &&
            message.tool?.ok === false ? failedTurnCause(message.tool.name) : null).findLast((cause) => cause);
          if (answer?.text && successful && !blocked && !stalled && !looping) {
            const after = revision(workspace.directory);
            const profile = options.dataDir && realpathSync(join(options.dataDir, "bots", botId, "pi"));
            const cursors = options.store.tasks(botId).find((entry) => entry.threadId === task.threadId)?.resumeCursors;
            const paths = Object.values(cursors ?? {}).filter((value): value is string => typeof value === "string");
            const sessionFile = paths.find((path) => {
              try {
                const resolved = realpathSync(path);
                return profile && resolved.startsWith(profile + sep) && statSync(resolved).isFile() && statSync(resolved).size > 0;
              } catch { return false; }
            });
            if (options.dataDir && !sessionFile) throw new Error("coding turn has no durable Pi session file");
            return { revision: after === before && role !== "review" ? "" : after,
              ...(sessionFile ? { sessionFile } : {}),
              evidence: [...(chase ? ["The first coding turn needed one bounded chase."] : []), answer.text],
              accepted: role === "review" && answer.text.includes(`ACCEPT ${after}`),
              costUsd: await costUsd(), ...modelUsage() };
          }
          if (chase === 0 && (stalled || blocked || looping)) {
            if (stallRelease) await stallRelease;
            if (signal.aborted) throw new Error("coding turn cancelled");
            continue;
          }
          if (chase === 0) throw new Error((successful
            ? "coding turn produced no completed answer" : "coding turn did not complete successfully") +
            (failure ? `: ${failure}` : ""));
          const detail = answer?.text?.trim() || (stalled ? "the Pi turn stalled again" :
            successful ? "the Pi turn produced no completed answer" : "the Pi turn did not complete successfully") +
            (failure ? `: ${failure}` : "");
          return await blockedResult(`BLOCKED after one stuck-turn chase: ${detail}`);
        } catch (error) {
          if (chase === 0) throw error;
          const detail = error instanceof Error ? error.message : String(error);
          return await blockedResult(`BLOCKED after one stuck-turn chase: ${detail}`);
        } finally {
          if (abort) signal.removeEventListener("abort", abort);
        }
      }
      return await blockedResult("BLOCKED after one stuck-turn chase: no completed answer");
    },
  };
}
