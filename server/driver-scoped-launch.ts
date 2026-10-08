// Entry point for a host-contained bot instance. The trusted host must pin
// this entrypoint; it owns run/assignment identity and the stdio broker. Running
// server/index.ts directly bypasses this scoped integration seam.
// Set the immutable runtime marker before loading the gate module: it
// snapshots launcher-owned settings at import time.
process.env.OMB_DRIVER_SCOPED_BOOT = "1";
const { DRIVER_SCOPED_GATE_CONFIG, requireDriverStartupGate } = await import("./driver-startup-gate.ts");

await requireDriverStartupGate(DRIVER_SCOPED_GATE_CONFIG);

// No server imports before the check: index.ts has startup side effects.
// It rechecks immediately before listen(), after its initialization phase.
await import("./index.ts");
