import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const moduleName = "@evoclock/pi-agentic-driver/scripts/enforcement/durable_driver_pi.js";
const protocol = "agentic-driver.run.v1";
const unavailable = "installed driver-run API is unavailable: expected agentic-driver.run.v1 from @evoclock/pi-agentic-driver";

export interface InstalledWorkerDriver {
  status(runId: string): Promise<{ state: string; steps: Array<{ id: string; requestKey: string;
    state: string; receipt?: { reference: string } }> } | null>;
  resume(runId: string): Promise<{ state: string; steps: Array<{ id: string; requestKey: string; state: string }> }>;
  reconcile(runId: string, evidence: { stepId: string; requestKey: string; verified: boolean; reference?: string }): Promise<unknown>;
  invokeWorker(input: { requestId: string; goal: string; signal: AbortSignal;
    transport: { invoke(): Promise<{ result: import("./outer-runner.ts").InnerLoopResult; verified: true; reference: string }> } }):
    Promise<{ runId: string; state: string; result?: import("./outer-runner.ts").InnerLoopResult;
      step?: { receipt?: { reference: string } } }>;
  close(): Promise<void>;
}

export interface DriverRunApi {
  openDurableDriver: (options: { directory: string }) => Promise<InstalledWorkerDriver>;
  path: string;
  version: string;
}

export async function requireDriverRunApi(moduleSpecifier = moduleName,
  configuredRoot = process.env.OMB_INSTALLED_DRIVER_ROOT, _home = homedir()): Promise<DriverRunApi> {
  if (!configuredRoot && process.env.NODE_ENV === "test" && moduleSpecifier !== moduleName) {
    const loaded = await import(moduleSpecifier) as Record<string, unknown>;
    if (loaded.DURABLE_DRIVER_PROTOCOL !== protocol || typeof loaded.openDurableDriver !== "function") throw new Error(unavailable);
    return { openDurableDriver: loaded.openDurableDriver as DriverRunApi["openDurableDriver"], path: moduleSpecifier, version: "test-fixture" };
  }
  if (!configuredRoot || !isAbsolute(configuredRoot)) throw new Error(`${unavailable}; configure one absolute driver root`);
  const root = await realpath(configuredRoot);
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: string; version?: string };
  if (packageJson.name !== "@evoclock/pi-agentic-driver" || !/^\d+\.\d+\.\d+$/.test(packageJson.version ?? "")) {
    throw new Error(`${unavailable}; installed package identity or version is invalid`);
  }
  const [major, minor, patch] = packageJson.version!.split(".").map(Number);
  if (major! < 3 || (major === 3 && (minor! < 1 || (minor === 1 && patch! < 7)))) {
    throw new Error("installed driver is older than required 3.1.7; no fallback root is allowed");
  }
  const entry = join(root, "scripts", "enforcement", "durable_driver_pi.js");
  const loaded = await import(pathToFileURL(entry).href) as Record<string, unknown>;
  if (loaded.DURABLE_DRIVER_PROTOCOL !== protocol || typeof loaded.openDurableDriver !== "function") throw new Error(unavailable);
  return { openDurableDriver: loaded.openDurableDriver as DriverRunApi["openDurableDriver"], path: entry, version: packageJson.version! };
}
