import { z } from "zod";

const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const ref = z.string().min(1).max(255);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const key = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export const codingEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch-push"), repository, ref, expectedSha: sha }).strict(),
  z.object({ kind: z.literal("pr-open"), repository, head: ref, base: ref }).strict(),
  z.object({ kind: z.literal("pr-comment"), repository, pullNumber: z.number().int().positive(), key }).strict(),
]);
export type CodingEffect = z.infer<typeof codingEffectSchema>;

type Inconclusive = { kind: "inconclusive"; reason: string };
export interface ForgeEffectInspector {
  getBranchRef(input: { owner: string; repo: string; ref: string }): Promise<
    { kind: "found"; sha: string } | { kind: "absent" } | Inconclusive>;
  findPullRequests(input: { owner: string; repo: string; head: string; base: string }): Promise<
    { kind: "found"; prs: Array<{ number: number; headSha: string; state: string }> } | { kind: "absent" } | Inconclusive>;
  findCommentsByIdempotencyKey(input: { owner: string; repo: string; issueNumber: number; key: string }): Promise<
    { kind: "found"; ids: number[] } | { kind: "absent" } | Inconclusive>;
}

export type EffectObservation = { status: "present" | "missing" | "inconclusive"; evidence: string };

export async function observeCodingEffect(inspector: ForgeEffectInspector, input: CodingEffect): Promise<EffectObservation> {
  const effect = codingEffectSchema.parse(input);
  const [owner, repo] = effect.repository.split("/") as [string, string];
  try {
    if (effect.kind === "branch-push") {
      const result = await inspector.getBranchRef({ owner, repo, ref: effect.ref });
      if (result.kind === "absent") return { status: "missing", evidence: "branch does not exist" };
      if (result.kind === "inconclusive" || !sha.safeParse(result.sha).success) {
        return { status: "inconclusive", evidence: "branch revision could not be verified" };
      }
      return result.sha === effect.expectedSha
        ? { status: "present", evidence: `branch matches ${result.sha}` }
        : { status: "inconclusive", evidence: `branch has different revision ${result.sha}` };
    }
    if (effect.kind === "pr-open") {
      const result = await inspector.findPullRequests({ owner, repo, head: effect.head, base: effect.base });
      if (result.kind === "absent") return { status: "missing", evidence: "no pull request matches head and base" };
      if (result.kind === "inconclusive" || result.prs.length !== 1 ||
        !Number.isSafeInteger(result.prs[0]?.number) || result.prs[0]!.number <= 0 ||
        !sha.safeParse(result.prs[0]?.headSha).success) {
        return { status: "inconclusive", evidence: "pull request match is ambiguous or incomplete" };
      }
      return { status: "present", evidence: `pull request ${result.prs[0]!.number} matches head and base` };
    }
    const result = await inspector.findCommentsByIdempotencyKey({ owner, repo,
      issueNumber: effect.pullNumber, key: effect.key });
    if (result.kind === "absent") return { status: "missing", evidence: "no comment matches the recorded key" };
    if (result.kind === "inconclusive" || result.ids.length !== 1 ||
      !Number.isSafeInteger(result.ids[0]) || result.ids[0]! <= 0) {
      return { status: "inconclusive", evidence: "comment match is ambiguous or incomplete" };
    }
    return { status: "present", evidence: `comment ${result.ids[0]} matches the recorded key` };
  } catch {
    return { status: "inconclusive", evidence: "forge inspection failed" };
  }
}
