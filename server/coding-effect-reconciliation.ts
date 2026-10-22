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

export interface ForgeEffectInspector {
  branch(repository: string, ref: string): Promise<{ sha: string } | null>;
  pullRequests(repository: string, head: string): Promise<{ complete: boolean; items: Array<{ head: string; base: string; number: number }> }>;
  comments(repository: string, pullNumber: number): Promise<{ complete: boolean; bodies: string[] }>;
}

export type EffectObservation = { status: "present" | "missing" | "inconclusive"; evidence: string };

export async function observeCodingEffect(inspector: ForgeEffectInspector, input: CodingEffect): Promise<EffectObservation> {
  const effect = codingEffectSchema.parse(input);
  try {
    if (effect.kind === "branch-push") {
      const branch = await inspector.branch(effect.repository, effect.ref);
      if (!branch) return { status: "missing", evidence: "branch does not exist" };
      if (!sha.safeParse(branch.sha).success) return { status: "inconclusive", evidence: "branch revision is invalid" };
      return branch.sha === effect.expectedSha
        ? { status: "present", evidence: `branch matches ${branch.sha}` }
        : { status: "inconclusive", evidence: `branch has different revision ${branch.sha}` };
    }
    if (effect.kind === "pr-open") {
      const result = await inspector.pullRequests(effect.repository, effect.head);
      if (!result.complete || result.items.some((pr) => pr.head !== effect.head || !Number.isSafeInteger(pr.number) || pr.number <= 0)) {
        return { status: "inconclusive", evidence: "pull request listing is incomplete or inconsistent" };
      }
      const matches = result.items.filter((pr) => pr.base === effect.base);
      if (matches.length === 1 && result.items.length === 1) {
        return { status: "present", evidence: `pull request ${matches[0]!.number} matches head and base` };
      }
      if (result.items.length > 0) return { status: "inconclusive", evidence: "pull request match is ambiguous or partial" };
      return { status: "missing", evidence: "no pull request has this head" };
    }
    const result = await inspector.comments(effect.repository, effect.pullNumber);
    if (!result.complete) return { status: "inconclusive", evidence: "comment listing is incomplete" };
    const marker = `<!-- omb-effect:${effect.key} -->`;
    const matches = result.bodies.filter((body) => body.includes(marker));
    if (matches.length === 1) return { status: "present", evidence: "one comment matches the recorded key" };
    return matches.length > 1
      ? { status: "inconclusive", evidence: "more than one comment matches the recorded key" }
      : { status: "missing", evidence: "no comment matches the recorded key" };
  } catch {
    return { status: "inconclusive", evidence: "forge inspection failed" };
  }
}
