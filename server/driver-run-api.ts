const moduleName = "@evoclock/pi-agentic-driver/scripts/enforcement/durable_driver_pi.js";
const protocol = "agentic-driver.run.v1";
const unavailable = "installed driver-run API is unavailable: expected agentic-driver.run.v1 from @evoclock/pi-agentic-driver";

export async function requireDriverRunApi(): Promise<{
  openDurableDriver: (options: { directory: string }) => Promise<unknown>;
}> {
  let loaded: unknown;
  try {
    loaded = await import(moduleName);
  } catch {
    throw new Error(unavailable);
  }
  if (!loaded || typeof loaded !== "object" ||
    (loaded as Record<string, unknown>).DURABLE_DRIVER_PROTOCOL !== protocol ||
    typeof (loaded as Record<string, unknown>).openDurableDriver !== "function") {
    throw new Error(unavailable);
  }
  return { openDurableDriver: (loaded as {
    openDurableDriver: (options: { directory: string }) => Promise<unknown>;
  }).openDurableDriver };
}
