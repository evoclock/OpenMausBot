# Always-on coding host: design brief

The launch requires a coding host that continues to accept and settle work when the desktop application is not open. The existing session-status reporter only reports state; it does not execute coding turns.

## Proposed service

Run one long-lived OpenMausBot headless server under a launchd user agent with startup and restart behavior. The server owns routine scheduling, coding-run state, and recovery. Start Pi as a bounded child for each turn rather than keeping an unattended interactive session open. Keep credentials out of the service definition.

The service must run a pinned build from a dedicated installation, not a development worktree. Its working directory and data store must be stable across restarts. Decide how the desktop application connects so two processes never act as competing owners of the same data.

## Recovery and verification

A crash must not replay an uncertain outward write. The host should restart, reconcile observed effects where possible, and park ambiguous work for review. Verify service restart, interrupted-run handling, credential access, and an intentional clean stop. A per-minute status check is not a substitute for this test.

Crash-safe publication is an important prerequisite: see [the gap analysis](ralph-seams-gap.md). Playbook availability on the actual host must also pass [the parity checks](poteto-parity-verify.md).

## Decisions before implementation

- Choose the server deployment and version pin.
- Define how the desktop application avoids concurrent ownership of the coding data.
- Decide whether any supporting service needs independent restart handling.
- Establish the publication-recovery behavior required before unattended operation.

This is a design brief, not an installed service or a claim of reboot survival.
