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
}

export async function requireDriverRunApi(moduleSpecifier = moduleName): Promise<DriverRunApi> {
  let loaded: unknown;
  try {
    loaded = await import(moduleSpecifier);
  } catch {
    throw new Error(unavailable);
  }
  if (!loaded || typeof loaded !== "object" ||
    (loaded as Record<string, unknown>).DURABLE_DRIVER_PROTOCOL !== protocol ||
    typeof (loaded as Record<string, unknown>).openDurableDriver !== "function") {
    throw new Error(unavailable);
  }
  return { openDurableDriver: (loaded as {
    openDurableDriver: (options: { directory: string }) => Promise<InstalledWorkerDriver>;
  }).openDurableDriver };
}
