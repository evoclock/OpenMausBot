import { strict as assert } from "node:assert";
import { test } from "vitest";
import { createGitHubHostInspector, type GitHostInspector } from "./git-host-inspector.ts";

const sha = "a".repeat(40);
const repository = { full_name: "evoclock/OpenMausBot" };
const branch = { ref: "refs/heads/feature/work", object: { sha } };
const pr = { number: 7, state: "open", base: { ref: "main" },
  head: { ref: "feature/work", sha, repo: repository } };
const comment = { id: 123, body: "Work complete <!-- idempotency:run-1 -->" };
const response = (body: unknown, status = 200, link?: string) => new Response(JSON.stringify(body), {
  status, headers: link ? { link } : undefined,
});

type Reply = (url: URL) => Response | Promise<Response>;
function inspector(reply: Reply, maxPages?: number): GitHostInspector {
  return createGitHubHostInspector({ token: async () => "fixture-access", maxPages,
    request: (async (input, init) => {
      assert.equal(init?.method, "GET");
      assert.ok(init?.headers);
      assert.equal((init.headers as Record<string, string>).authorization, "Bearer fixture-access");
      return reply(new URL(String(input)));
    }) as typeof fetch });
}

const refInput = { owner: "evoclock", repo: "OpenMausBot", ref: "feature/work" };
const prInput = { owner: "evoclock", repo: "OpenMausBot", head: "feature/work", base: "main" };
const commentInput = { owner: "evoclock", repo: "OpenMausBot", issueNumber: 7,
  key: "<!-- idempotency:run-1 -->" };

test("branch identity and SHA are verified before reporting found or absent", async () => {
  const found = inspector((url) => url.pathname.endsWith("/git/ref/heads/feature/work")
    ? response(branch) : response(repository));
  assert.deepEqual(await found.getBranchRef(refInput), { kind: "found", sha });
  const absent = inspector((url) => url.pathname.endsWith("/git/ref/heads/feature/work")
    ? response({ message: "Not Found" }, 404) : response(repository));
  assert.deepEqual(await absent.getBranchRef(refInput), { kind: "absent" });
  const hidden = inspector(() => response({ message: "Not Found" }, 404));
  assert.equal((await hidden.getBranchRef(refInput)).kind, "inconclusive");
  const malformed = inspector((url) => url.pathname.includes("/git/ref/")
    ? response({ ...branch, object: { sha: "invalid" } }) : response(repository));
  assert.equal((await malformed.getBranchRef(refInput)).kind, "inconclusive");
});

test("exact PR matches and exact comment markers produce complete read results", async () => {
  const found = inspector((url) => {
    if (url.pathname.endsWith("/pulls")) {
      assert.equal(url.searchParams.get("state"), "all");
      assert.equal(url.searchParams.get("head"), "evoclock:feature/work");
      assert.equal(url.searchParams.get("base"), "main");
      return response([pr]);
    }
    return response([comment, { id: 124, body: "another action" }]);
  });
  assert.deepEqual(await found.findPullRequests(prInput), {
    kind: "found", prs: [{ number: 7, headSha: sha, state: "open" }],
  });
  assert.deepEqual(await found.findCommentsByIdempotencyKey(commentInput), { kind: "found", ids: [123] });
  const empty = inspector(() => response([]));
  assert.deepEqual(await empty.findPullRequests(prInput), { kind: "absent" });
  assert.deepEqual(await empty.findCommentsByIdempotencyKey(commentInput), { kind: "absent" });
});

test("HTTP errors, authentication failures, rate limits and truncated lists never claim absence", async () => {
  for (const status of [500, 401, 403, 404]) {
    const failed = inspector((url) => url.pathname === "/repos/evoclock/OpenMausBot"
      ? response(repository) : response({ message: "redacted" }, status));
    assert.equal((await failed.findPullRequests(prInput)).kind, "inconclusive");
    assert.equal((await failed.findCommentsByIdempotencyKey(commentInput)).kind, "inconclusive");
    if (status !== 404) assert.equal((await failed.getBranchRef(refInput)).kind, "inconclusive");
  }
  const truncated = inspector(() => response([pr], 200,
    '<https://api.github.com/repos/evoclock/OpenMausBot/pulls?page=2>; rel="next"'), 1);
  assert.equal((await truncated.findPullRequests(prInput)).kind, "inconclusive");
  const partial = inspector((url) => url.searchParams.get("page") === "1"
    ? response([comment], 200, '<https://api.github.com/next>; rel="next"')
    : response({ message: "failed" }, 500));
  assert.equal((await partial.findCommentsByIdempotencyKey(commentInput)).kind, "inconclusive");
  const badLink = inspector(() => response([], 200, 'rel="next"'));
  assert.equal((await badLink.findPullRequests(prInput)).kind, "inconclusive");
});

test("malformed rows and unsafe refs fail closed without a network request", async () => {
  const malformed = inspector(() => response([{ ...pr, head: { ...pr.head, sha: "bad" } }]));
  assert.equal((await malformed.findPullRequests(prInput)).kind, "inconclusive");
  const invalidComment = inspector(() => response([{ id: 123, body: null }]));
  assert.equal((await invalidComment.findCommentsByIdempotencyKey(commentInput)).kind, "inconclusive");
  const noCalls = inspector(() => { throw new Error("should not request"); });
  assert.equal((await noCalls.getBranchRef({ ...refInput, ref: "HEAD:main" })).kind, "inconclusive");
  assert.equal((await noCalls.getBranchRef({ ...refInput, ref: undefined as unknown as string })).kind, "inconclusive");
  assert.equal((await noCalls.findPullRequests({ ...prInput, head: "../other" })).kind, "inconclusive");
});
