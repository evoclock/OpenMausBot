import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ApprovalMode } from "../shared/approval-mode.ts";
import type { Store } from "./store.ts";
import type { CodingTurnPort, CodingTurnResult } from "./coding-worker-host.ts";

interface CodingStartTurnOptions {
  store: Pick<Store, "bot" | "tasks" | "createTask" | "patchTask" | "messagesFor">;
  approvalMode: (requestId: string) => ApprovalMode;
  /** The server's normal turn entry, not ProviderInstance.adapter.sendTurn. */
  startTurn: (botId: string, text: string, options: { threadId: string; requestId: string;
    onTurnSettled: () => void; onDispatchError: (error: string) => void }) => Promise<void>;
  interrupt: (botId: string, threadId: string) => Promise<void>;
  driverKind: (botId: string) => string | undefined;
}

function revision(directory: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8", timeout: 10_000 }).trim();
}

export function createCodingStartTurnPort(options: CodingStartTurnOptions): CodingTurnPort {
  return {
    async run({ botId, workspace, role, prompt, requestId, signal }): Promise<CodingTurnResult> {
      if (signal.aborted) throw new Error("coding turn cancelled");
      if (options.driverKind(botId) !== "piAgent" || !options.store.bot(botId)) {
        throw new Error("coding role requires a configured Pi bot");
      }
      const approvalMode = options.approvalMode(requestId);
      const title = `Coding ${createHash("sha256").update(requestId).digest("hex")}`;
      const existing = options.store.tasks(botId).filter((task) => task.title === title);
      if (existing.length > 1) throw new Error("ambiguous coding turn task");
      if (existing.length && existing[0]?.cwd !== workspace.directory) throw new Error("coding task workspace changed");
      if (existing.length && options.store.messagesFor(existing[0]!.threadId).some((message) => message.role === "bot" && message.turnTerminal)) {
        throw new Error("coding turn already completed; reconcile its effects before replay");
      }
      if (existing.length) throw new Error("coding turn may have started; reconcile before replay");
      const task = options.store.createTask(botId, title, false, undefined, undefined,
        "ask", undefined, workspace.directory);
      if (!task) throw new Error("coding turn task could not be created");
      if (!options.store.patchTask(botId, task.threadId, { cwd: workspace.directory, approvalMode })) {
        throw new Error("coding turn permission could not be pinned");
      }
      const before = revision(workspace.directory);
      let settle!: () => void;
      let fail!: (error: Error) => void;
      const finished = new Promise<void>((resolve, reject) => { settle = resolve; fail = reject; });
      const abort = () => { void options.interrupt(botId, task.threadId).finally(() => fail(new Error("coding turn cancelled"))); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await options.startTurn(botId, prompt, { threadId: task.threadId, requestId, onTurnSettled: settle,
          onDispatchError: (error) => fail(new Error(error)) });
        await finished;
        if (signal.aborted) throw new Error("coding turn cancelled");
        const messages = options.store.messagesFor(task.threadId);
        const answer = messages.findLast((message) => message.role === "bot" && message.kind === "text" && message.turnTerminal);
        if (!answer?.text || answer.turnSucceeded === false) throw new Error("coding turn produced no completed answer");
        const after = revision(workspace.directory);
        return { revision: after === before && role !== "review" ? "" : after,
          evidence: [answer.text], accepted: role === "review" && answer.text.includes(`ACCEPT ${after}`) };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
