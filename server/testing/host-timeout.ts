// Windows CI runs this suite 1.4-1.5x slower than Linux, so every test and hook timeout doubles there
// (vite.config.ts scales the defaults; explicit timeouts use hostTimeout()). Linux and macOS stay strict.
export const HOST_TIMEOUT_FACTOR = process.platform === "win32" ? 2 : 1;

export function hostTimeout(ms: number): number {
  return ms * HOST_TIMEOUT_FACTOR;
}
