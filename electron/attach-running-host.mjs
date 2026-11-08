import { DESKTOP_PORTS } from "./desktop-ports.mjs";

export async function probeRunningHost({ fetchImpl = globalThis.fetch, ports = DESKTOP_PORTS } = {}) {
  for (const port of ports) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(350),
      });
      if (!response.ok) continue;
      const health = await response.json();
      if (health?.app !== "openmausbot" || (health.pid !== undefined &&
        (!Number.isSafeInteger(health.pid) || health.pid <= 0))) continue;
      return { port, origin: `http://127.0.0.1:${port}`, pid: health.pid };
    } catch {}
  }
  return null;
}

export async function choosePackagedHost({ companion, acquireLease, probe = probeRunningHost }) {
  if (companion) return { host: null, lease: acquireLease() };
  const host = await probe();
  return host ? { host, lease: null } : { host: null, lease: acquireLease() };
}
