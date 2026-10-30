import type { CodingGitRequest } from "./coding-git-policy.ts";
import type { IsolatedWorkspace } from "./inner-worker-route.ts";
import type { RunSnapshot } from "./run-contract.ts";

export async function publishVerifiedCodingRun(input: {
  snapshot: RunSnapshot;
  workspace: IsolatedWorkspace;
  createBranch(workspace: string, branch: string, base: string): Promise<void>;
  hasDestination: boolean;
  gitAction(request: CodingGitRequest): Promise<"applied" | "owner-eligible">;
}): Promise<string | null> {
  const { snapshot, workspace } = input;
  if (snapshot.state !== "done" || snapshot.hostCheck?.commitSha === workspace.base ||
    !input.hasDestination || !snapshot.evidence.some((line) => line.trim()) ||
    !snapshot.contract.allowedEffects.includes("push") || !snapshot.contract.allowedEffects.includes("draft-pr") ||
    workspace.repository !== snapshot.contract.repository || workspace.baseBranch !== snapshot.contract.ref) return null;
  const branch = `bot/coding-${snapshot.contract.id.slice(0, 12)}`;
  await input.createBranch(workspace.directory, branch, snapshot.contract.ref);
  const common = { botId: snapshot.contract.botId, repository: snapshot.contract.repository,
    workspace: workspace.directory, branch, base: snapshot.contract.ref };
  await input.gitAction({ ...common, action: "push" });
  await input.gitAction({ ...common, action: "pr-open", draft: true });
  return branch;
}
