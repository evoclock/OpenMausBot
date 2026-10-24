import { lstat, readFile } from "node:fs/promises";
import { importPKCS8, SignJWT } from "jose";
import type { CodingGitCredentialProvider } from "./coding-git-policy.ts";
import type { CodingGitAppInstallation, CodingGitCredential } from "./coding-run-config.ts";

const REPOSITORY = /^evoclock\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A new installation token is minted per decision; neither the key nor the token is retained. */
export function createGitHubAppCredentialProvider(options: {
  installations: Readonly<Record<string, CodingGitAppInstallation>>;
  request?: typeof fetch;
  now?: () => number;
}): CodingGitCredentialProvider & { scopedToken(credential: CodingGitCredential, repository: string): Promise<string | null> } {
  const request = options.request ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const scopedToken = async (credential: CodingGitCredential, repository: string): Promise<string | null> => {
      if (credential.kind !== "github-app" || !REPOSITORY.test(repository) ||
        !Object.hasOwn(options.installations, credential.reference)) return null;
      const installation = options.installations[credential.reference];
      if (!installation || !Number.isSafeInteger(installation.appId) || installation.appId <= 0 ||
        !Number.isSafeInteger(installation.installationId) || installation.installationId <= 0 ||
        !Array.isArray(installation.repositories) || !installation.repositories.includes(repository) ||
        !installation.privateKeyPath?.startsWith("/")) return null;
      try {
        const file = await lstat(installation.privateKeyPath);
        if (!file.isFile() || (file.mode & 0o077) !== 0) return null;
        const privateKey = await readFile(installation.privateKeyPath, "utf8");
        const signingKey = await importPKCS8(privateKey, "RS256");
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
        if (created.status !== 201) return null;
        const tokenBody = await created.json() as { token?: unknown; expires_at?: unknown;
          repositories?: Array<{ full_name?: unknown }>; permissions?: { contents?: unknown; pull_requests?: unknown } };
        const expiresAt = typeof tokenBody.expires_at === "string" ? Date.parse(tokenBody.expires_at) : NaN;
        if (typeof tokenBody.token !== "string" || !tokenBody.token ||
          !Number.isFinite(expiresAt) || expiresAt <= now() ||
          !Array.isArray(tokenBody.repositories) || tokenBody.repositories.length !== 1 ||
          tokenBody.repositories[0]?.full_name !== repository ||
          tokenBody.permissions?.contents !== "write" || tokenBody.permissions.pull_requests !== "write") return null;
        const result = await request(`https://api.github.com/repos/${owner}/${repo}`, {
          method: "GET", headers: { accept: "application/vnd.github+json", authorization: `Bearer ${tokenBody.token}`,
            "x-github-api-version": "2022-11-28" }, signal: AbortSignal.timeout(15_000),
        });
        if (!result.ok) return null;
        const facts = await result.json() as { full_name?: unknown; visibility?: unknown;
          permissions?: { push?: unknown } };
        return facts.full_name === repository && facts.permissions?.push === true &&
          (installation.visibility === undefined || facts.visibility === installation.visibility) ? tokenBody.token : null;
      } catch {
        return null;
      }
  };
  return { scopedToken, async canWrite(credential, repository) {
    return (await scopedToken(credential, repository)) !== null;
  } };
}
