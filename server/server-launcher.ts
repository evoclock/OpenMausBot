// Container entry: restarts the server in place on RESTART_EXIT_CODE, since a container restart cuts off a Caddy sharing its network.
import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { restartPolicy } from "./restart.ts";

export function superviseServer(start: () => ChildProcess, options: { signals?: Pick<NodeJS.Process, "on" | "off">; now?: () => number } = {}): Promise<number> {
  const signals = options.signals ?? process, now = options.now ?? Date.now;
  return new Promise((done) => {
    let child: ChildProcess, stopping = false;
    const policy = restartPolicy(now);
    const pass = (signal: NodeJS.Signals) => () => { stopping = true; child.kill(signal); };
    const onTerm = pass("SIGTERM"), onInt = pass("SIGINT");
    const finish = (code: number) => { signals.off("SIGTERM", onTerm); signals.off("SIGINT", onInt); done(code); };
    const run = () => {
      child = start();
      child.once("error", () => finish(1));
      child.once("exit", (code, signal) => {
        if (policy.again(code, stopping)) {
          console.log("OpenMausBot is starting again to finish installing a copy from the desktop app…");
          run();
          return;
        }
        finish(code ?? (stopping && (signal === "SIGTERM" || signal === "SIGINT") ? 0 : 1));
      });
    };
    signals.on("SIGTERM", onTerm);
    signals.on("SIGINT", onInt);
    run();
  });
}

/** Node names the entry by its real path, so compare real paths (a macOS temp folder is reached through a link). */
function isEntry(): boolean {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]!))).href; } catch { return false; }
}

if (isEntry()) {
  const server = join(dirname(fileURLToPath(import.meta.url)), "index.js");
  void superviseServer(() => spawn(process.execPath, [server], { stdio: "inherit" })).then((code) => { process.exitCode = code; });
}
