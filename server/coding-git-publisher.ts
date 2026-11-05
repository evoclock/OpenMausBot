import { CodingEffectReceipts, reconcilePreparedEffects, type EffectReconcileHost } from "./coding-effect-receipts.ts";
import type { IsolatedWorkspace } from "./inner-worker-route.ts";
import type { RunSnapshot } from "./run-contract.ts";

export async function publishVerifiedCodingRun(input: {
  snapshot: RunSnapshot;
  workspace: IsolatedWorkspace;
  createBranch(workspace: string, branch: string, base: string): Promise<void>;
  hasDestination: boolean;
  receipts: CodingEffectReceipts;
  effectHost: EffectReconcileHost;
  head(workspace: string): Promise<string>;
}): Promise<string | null> {
  const { snapshot, workspace } = input;
  if (snapshot.state !== "done" || snapshot.hostCheck?.commitSha === workspace.base ||
    !input.hasDestination || !snapshot.evidence.some((line) => line.trim()) ||
    !snapshot.contract.allowedEffects.includes("push") || !snapshot.contract.allowedEffects.includes("draft-pr") ||
    workspace.repository !== snapshot.contract.repository || workspace.baseBranch !== snapshot.contract.ref) return null;
  const branch = `bot/coding-${snapshot.contract.id.slice(0, 12)}`;
  await input.createBranch(workspace.directory, branch, snapshot.contract.ref);
  const sequence = snapshot.iteration + 1;
  const expectedSha = await input.head(workspace.directory);
  input.receipts.prepare(snapshot.contract.id, sequence, "push", { kind: "branch-push",
    repository: snapshot.contract.repository, ref: branch, expectedSha });
  const push = await reconcilePreparedEffects(input.receipts, input.effectHost, snapshot.contract.id, sequence);
  if (push.status !== "reconciled") throw new Error(push.evidence.join("; "));
  input.receipts.prepare(snapshot.contract.id, sequence, "pr-open", { kind: "pr-open",
    repository: snapshot.contract.repository, head: branch, base: snapshot.contract.ref });
  const pull = await reconcilePreparedEffects(input.receipts, input.effectHost, snapshot.contract.id, sequence);
  if (pull.status !== "reconciled") throw new Error(pull.evidence.join("; "));
  return branch;
}
