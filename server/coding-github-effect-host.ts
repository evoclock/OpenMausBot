import type { CodingGitRequest } from "./coding-git-policy.ts";
import type { ForgeEffectInspector } from "./coding-effect-reconciliation.ts";
import type { EffectReconcileHost, EffectReceipt } from "./coding-effect-receipts.ts";

export function createCodingGithubEffectHost(input: {
  inspector: ForgeEffectInspector;
  resolve(receipt: EffectReceipt): Promise<Omit<CodingGitRequest, "action">>;
  gitAction(request: CodingGitRequest): Promise<"applied" | "owner-eligible">;
}): EffectReconcileHost {
  return {
    ...input.inspector,
    async applyMissing(receipt) {
      const effect = receipt.effect;
      if (effect.kind === "pr-comment") throw new Error("Comment effects cannot be replayed by the Git policy");
      const request = await input.resolve(receipt);
      if (request.repository !== effect.repository || request.branch !==
        (effect.kind === "branch-push" ? effect.ref : effect.head) ||
        (effect.kind === "pr-open" && request.base !== effect.base)) {
        throw new Error("Effect receipt differs from its workspace and run contract");
      }
      if (effect.kind === "branch-push") {
        const { execFileSync } = await import("node:child_process");
        const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: request.workspace,
          encoding: "utf8", timeout: 10_000 }).trim();
        if (revision !== effect.expectedSha) throw new Error("Workspace revision differs from recorded push");
      }
      const outcome = await input.gitAction({ ...request, action: effect.kind === "branch-push" ? "push" : "pr-open",
        ...(effect.kind === "pr-open" ? { draft: true } : {}) });
      if (outcome !== "applied") throw new Error("Git effect was not applied");
    },
  };
}
