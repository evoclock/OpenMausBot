import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute } from "node:path";

export const SANDBOX = "evoclock/omb-drill-sandbox";

export async function mintSandboxToken(config, fetcher = fetch) {
  if (config.destination !== SANDBOX || config.credentialReference?.kind !== "github-app")
    throw new Error("sandbox destination or credential kind refused");
  const { keyPath, appId, installationId } = config.credentialReference;
  if (!isAbsolute(keyPath) || !Number.isSafeInteger(appId) || appId <= 0 ||
    !Number.isSafeInteger(installationId) || installationId <= 0) throw new Error("invalid GitHub App reference");
  const stat = statSync(keyPath);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())
    throw new Error("GitHub App key must be an owner-only regular file");
  const now = Math.floor(Date.now() / 1000);
  const encode = (part) => Buffer.from(JSON.stringify(part)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 30, exp: now + 540, iss: String(appId) })}`;
  const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), createPrivateKey(readFileSync(keyPath))).toString("base64url")}`;
  const response = await fetcher(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST", headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28" },
    body: JSON.stringify({ repositories: ["omb-drill-sandbox"], permissions: { contents: "write", pull_requests: "write" } }),
  });
  if (!response.ok) throw new Error("GitHub App installation token request refused");
  const data = await response.json();
  if (typeof data.token !== "string" || data.token.length < 20 ||
    !Array.isArray(data.repositories) || data.repositories.length !== 1 ||
    data.repositories[0]?.full_name !== SANDBOX || data.permissions?.contents !== "write" ||
    data.permissions?.pull_requests !== "write" || Date.parse(data.expires_at) < Date.now() + 60_000)
    throw new Error("GitHub App token scope or lifetime does not match sandbox");
  return data.token;
}

export async function withSandboxGitToken(token, askpassPath, fn) {
  const nonce = randomBytes(32).toString("hex");
  // The token stays in this process; Git's askpass child receives it through a loopback-only response.
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== `/${nonce}` || req.socket.remoteAddress !== "127.0.0.1") {
      res.writeHead(404).end(); return;
    }
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end(token);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("askpass listener missing");
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: askpassPath, OMB_ASKPASS_URL: `http://127.0.0.1:${address.port}/${nonce}` };
  try { return await fn(env); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

export function runGit(args, cwd, env, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, signal, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let error = "";
    child.stdout.on("data", (chunk) => { out += chunk; if (out.length > 1_000_000) child.kill(); });
    child.stderr.on("data", (chunk) => { error += chunk; if (error.length > 1_000_000) child.kill(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`Git operation failed (${args[0]}): ${code}`)));
  });
}
