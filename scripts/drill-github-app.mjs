import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

export const SANDBOX = "evoclock/omb-drill-sandbox";

export async function withSandboxGitToken(token, askpassPath, fn) {
  const nonce = randomBytes(32).toString("hex");
  // The installation token stays in this process; the Git askpass child receives it through loopback.
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
