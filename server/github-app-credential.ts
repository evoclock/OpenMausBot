import { lstat, readFile } from "node:fs/promises";
import { createPrivateKey } from "node:crypto";
import { SignJWT } from "jose";
import type { CodingGitCredentialProvider } from "./coding-git-policy.ts";
import type { CodingGitAppInstallation, CodingGitCredential } from "./coding-run-config.ts";

const REPOSITORY = /^evoclock\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A new installation token is minted per decision; neither the key nor the token is retained. */
export type GitHubAppCredentialFailure =
  | "invalid-credential"
  | "key-mode"
  | "key-parse"
  | `mint-status-${number}`
  | `permissions-missing-${string}`
  | `repo-lookup-${number}`
  | "repository-mismatch"
  | "push-permission-missing"
  | "visibility-mismatch"
  | `exception-${string}`;

type CredentialResult = { token: string; failure: null } | { token: null; failure: GitHubAppCredentialFailure };

export function createGitHubAppCredentialProvider(options: {
  installations: Readonly<Record<string, CodingGitAppInstallation>>;
  request?: typeof fetch;
  now?: () => number;
}): CodingGitCredentialProvider & {
  scopedToken(credential: CodingGitCredential, repository: string): Promise<string | null>;
  scopedTokenResult(credential: CodingGitCredential, repository: string): Promise<CredentialResult>;
} {
  const request = options.request ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const scopedTokenResult = async (credential: CodingGitCredential, repository: string): Promise<CredentialResult> => {
      if (credential.kind !== "github-app" || !REPOSITORY.test(repository) ||
        !Object.hasOwn(options.installations, credential.reference)) return { token: null, failure: "invalid-credential" };
      const installation = options.installations[credential.reference];
      if (!installation || !Number.isSafeInteger(installation.appId) || installation.appId <= 0 ||
        !Number.isSafeInteger(installation.installationId) || installation.installationId <= 0 ||
        !Array.isArray(installation.repositories) || !installation.repositories.includes(repository) ||
        !installation.privateKeyPath?.startsWith("/")) return { token: null, failure: "invalid-credential" };
      try {
        const file = await lstat(installation.privateKeyPath);
        if (!file.isFile() || (file.mode & 0o077) !== 0) return { token: null, failure: "key-mode" };
        const privateKey = await readFile(installation.privateKeyPath, "utf8");
        let signingKey;
        try {
          signingKey = createPrivateKey(privateKey);
        } catch {
          return { token: null, failure: "key-parse" };
        }
        const seconds = Math.floor(now() / 1000);
        const jwt = await new SignJWT({}).setProtectedHeader({ alg: "RS256" })
          .setIssuer(String(installation.appId)).setIssuedAt(seconds - 60)
          .setExpirationTime(seconds + 540).sign(signingKey);
        const [owner, repo] = repository.split("/");
        const created = await request(`https://api.github.com/app/installations/${installation.installationId}/access_tokens`, {
          method: "POST", headers: { accept: "application/vnd.github+json", authorization: `Bearer ${jwt}`,
            "content-type": "application/json", "x-github-api-version": "2022-11-28" },
          body: JSON.stringify({ repositories: [repo], permissions: { contents: "write", pull_requests: "write" } }),
          signal: AbortSignal.timeout(15_000),
        });
        if (created.status !== 201) return { token: null, failure: `mint-status-${created.status}` };
        const tokenBody = await created.json() as { token?: unknown; expires_at?: unknown;
          repositories?: Array<{ full_name?: unknown }>; permissions?: { contents?: unknown; pull_requests?: unknown } };
        const expiresAt = typeof tokenBody.expires_at === "string" ? Date.parse(tokenBody.expires_at) : NaN;
        const missingPermissions = (["contents", "pull_requests"] as const).filter((permission) =>
          tokenBody.permissions?.[permission] !== "write");
        if (missingPermissions.length) return { token: null, failure: `permissions-missing-${missingPermissions.join(",")}` };
        if (typeof tokenBody.token !== "string" || !tokenBody.token ||
          !Number.isFinite(expiresAt) || expiresAt <= now() ||
          !Array.isArray(tokenBody.repositories) || tokenBody.repositories.length !== 1 ||
          tokenBody.repositories[0]?.full_name !== repository) return { token: null, failure: "repository-mismatch" };
        const result = await request(`https://api.github.com/repos/${owner}/${repo}`, {
          method: "GET", headers: { accept: "application/vnd.github+json", authorization: `Bearer ${tokenBody.token}`,
            "x-github-api-version": "2022-11-28" }, signal: AbortSignal.timeout(15_000),
        });
        if (!result.ok) return { token: null, failure: `repo-lookup-${result.status}` };
        const facts = await result.json() as { full_name?: unknown; visibility?: unknown;
          permissions?: { push?: unknown } };
        if (facts.full_name !== repository) return { token: null, failure: "repository-mismatch" };
        if (installation.visibility !== undefined && facts.visibility !== installation.visibility)
          return { token: null, failure: "visibility-mismatch" };
        return { token: tokenBody.token, failure: null };
      } catch (error) {
        const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : "Error";
        return { token: null, failure: `exception-${name}` };
      }
  };
  const scopedToken = async (credential: CodingGitCredential, repository: string) =>
    (await scopedTokenResult(credential, repository)).token;
  return { scopedToken, scopedTokenResult, async canWrite(credential, repository) {
    return (await scopedToken(credential, repository)) !== null;
  } };
}
