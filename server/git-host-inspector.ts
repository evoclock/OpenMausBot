export interface GitHostInspector {
  getBranchRef(input: { owner: string; repo: string; ref: string }): Promise<
    { kind: "found"; sha: string } | { kind: "absent" } | { kind: "inconclusive"; reason: string }
  >;
  findPullRequests(input: { owner: string; repo: string; head: string; base: string }): Promise<
    { kind: "found"; prs: Array<{ number: number; headSha: string; state: "open" | "closed" }> }
    | { kind: "absent" } | { kind: "inconclusive"; reason: string }
  >;
  findCommentsByIdempotencyKey(input: { owner: string; repo: string; issueNumber: number; key: string }): Promise<
    { kind: "found"; ids: number[] } | { kind: "absent" } | { kind: "inconclusive"; reason: string }
  >;
}

type Inconclusive = { kind: "inconclusive"; reason: string };
type ReadResult = { kind: "ok"; body: unknown; next: boolean } | { kind: "missing" } | Inconclusive;
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REF = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
const inconclusive = (reason: string): Inconclusive => ({ kind: "inconclusive", reason });

function validRepository(owner: string, repo: string): boolean {
  return typeof owner === "string" && typeof repo === "string" &&
    NAME.test(owner) && NAME.test(repo) && owner.length <= 100 && repo.length <= 100;
}

function validRef(ref: string): boolean {
  return typeof ref === "string" && REF.test(ref) && ref.length <= 160 &&
    !ref.includes("..") && !ref.includes("//") &&
    !ref.endsWith("/") && !ref.endsWith(".lock") && !ref.startsWith("refs/");
}

/** A complete page scan is required before reporting absence; no token or remote body is exposed. */
export function createGitHubHostInspector(options: {
  token(): Promise<string>;
  request?: typeof fetch;
  maxPages?: number;
}): GitHostInspector {
  const maxPages = options.maxPages ?? 20;
  const request = options.request ?? globalThis.fetch;
  const read = async (path: string, missingAllowed = false): Promise<ReadResult> => {
    try {
      const token = await options.token();
      if (!token) return inconclusive("credential unavailable");
      const response = await request(`https://api.github.com${path}`, {
        method: "GET", headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28" }, signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404 && missingAllowed) return { kind: "missing" };
      if (!response.ok) return inconclusive(`GitHub read returned HTTP ${response.status}`);
      const link = response.headers.get("link") ?? "";
      if (link && !/^(?:\s*<[^>]+>;\s*rel="(?:next|prev|first|last)"\s*,?\s*)+$/.test(link)) {
        return inconclusive("pagination metadata is incomplete");
      }
      return { kind: "ok", body: await response.json(), next: /rel="next"/.test(link) };
    } catch {
      return inconclusive("GitHub read failed");
    }
  };
  const pages = async (path: string): Promise<{ kind: "ok"; rows: unknown[] } | Inconclusive> => {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) return inconclusive("page limit is invalid");
    const rows: unknown[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const result = await read(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (result.kind !== "ok") return inconclusive(result.kind === "missing" ? "GitHub read missing" : result.reason);
      if (!Array.isArray(result.body)) return inconclusive("GitHub list response is malformed");
      rows.push(...result.body);
      if (!result.next) return { kind: "ok", rows };
    }
    return inconclusive("GitHub pagination limit reached");
  };
  const prefix = (owner: string, repo: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return {
    async getBranchRef({ owner, repo, ref }) {
      if (!validRepository(owner, repo) || !validRef(ref)) return inconclusive("repository or branch is invalid");
      const base = prefix(owner, repo);
      const repository = await read(base);
      if (repository.kind !== "ok" || !repository.body || typeof repository.body !== "object" ||
        (repository.body as { full_name?: unknown }).full_name !== `${owner}/${repo}`) {
        return inconclusive("repository access is unverified");
      }
      const branch = await read(`${base}/git/ref/heads/${ref.split("/").map(encodeURIComponent).join("/")}`, true);
      if (branch.kind === "missing") return { kind: "absent" };
      if (branch.kind !== "ok") return branch;
      const value = branch.body as { ref?: unknown; object?: { sha?: unknown } } | null;
      if (!value || value.ref !== `refs/heads/${ref}` || typeof value.object?.sha !== "string" ||
        !SHA.test(value.object.sha)) return inconclusive("branch response is malformed");
      return { kind: "found", sha: value.object.sha };
    },
    async findPullRequests({ owner, repo, head, base }) {
      if (!validRepository(owner, repo) || !validRef(head) || !validRef(base)) return inconclusive("pull request query is invalid");
      const query = new URLSearchParams({ state: "all", head: `${owner}:${head}`, base });
      const result = await pages(`${prefix(owner, repo)}/pulls?${query}`);
      if (result.kind !== "ok") return result;
      const prs: Array<{ number: number; headSha: string; state: "open" | "closed" }> = [];
      for (const raw of result.rows) {
        const pr = raw as { number?: unknown; state?: unknown; base?: { ref?: unknown }; head?: {
          ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } } } | null;
        if (!pr || !Number.isSafeInteger(pr.number) || (pr.number as number) <= 0 ||
          (pr.state !== "open" && pr.state !== "closed") || pr.base?.ref !== base ||
          pr.head?.ref !== head || pr.head.repo?.full_name !== `${owner}/${repo}` ||
          typeof pr.head.sha !== "string" || !SHA.test(pr.head.sha)) return inconclusive("pull request response is malformed");
        prs.push({ number: pr.number as number, headSha: pr.head.sha, state: pr.state });
      }
      return prs.length ? { kind: "found", prs } : { kind: "absent" };
    },
    async findCommentsByIdempotencyKey({ owner, repo, issueNumber, key }) {
      if (!validRepository(owner, repo) || !Number.isSafeInteger(issueNumber) || issueNumber <= 0 ||
        !key || key.length > 256) return inconclusive("comment query is invalid");
      const result = await pages(`${prefix(owner, repo)}/issues/${issueNumber}/comments`);
      if (result.kind !== "ok") return result;
      const ids: number[] = [];
      for (const raw of result.rows) {
        const comment = raw as { id?: unknown; body?: unknown } | null;
        if (!comment || !Number.isSafeInteger(comment.id) || (comment.id as number) <= 0 ||
          typeof comment.body !== "string") return inconclusive("comment response is malformed");
        if (comment.body.includes(key)) ids.push(comment.id as number);
      }
      return ids.length ? { kind: "found", ids } : { kind: "absent" };
    },
  };
}
