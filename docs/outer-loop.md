# Outer coding run loop

The run pattern adapts Geoffrey Huntley's [Ralph loop](https://ghuntley.com/ralph/): make one attempt, preserve progress, then start a fresh attempt against the same goal until completion or a stop. The Pi Ralph loop and Cursor `/loop` informed the iteration and stop behavior; no source was copied.

`openOuterRunner` stores a Pi Durable task in a SQLite harness. Each task drives a separately supplied inner-loop adapter. That adapter must run the existing pstack playbook and return its verification result; the outer loop does not duplicate pstack's checks. A progress result starts another iteration. A verified result with evidence ends the run. A blocked result stops it. No time, spend, or iteration budget is enforced. A status view reports the persisted contract and state.

The adapter is not wired to a live bot yet. Neither a stored repository classification nor a model verdict authorizes a write: the host must verify destination visibility, token scope, exact per-run external authorization and owner-held effects before it executes anything. This module neither starts agents nor pushes code.

Pi Durable stores task checkpoints. The inner invocation has an outward-effect boundary: after the run enters `running`, an interrupted attempt is parked as `blocked` on recovery. It is never automatically replayed. A future reconciliation step must inspect the external state before resuming. Pi Durable's single-storage-owner rule requires one harness owner per database; do not open competing runner processes on the same file. The crash fixture exits during the invocation and confirms recovery parks the run without invoking the adapter again.
