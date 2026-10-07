// Entry point for a future native-contained bot instance. The trusted host
// must pin this entrypoint, assignment identity, and mounted broker socket;
// running server/index.ts directly bypasses this offline integration seam.
import { requireDriverStartupGate } from "./driver-startup-gate.ts";

await requireDriverStartupGate({
  socketPath: process.env.OMB_DRIVER_GATE_SOCKET ?? "",
  assignmentId: process.env.OMB_DRIVER_ASSIGNMENT_ID ?? "",
});

// No server imports before the check: index.ts has startup side effects and
// begins draining queued sends, routines and delegations after listen().
await import("./index.ts");
