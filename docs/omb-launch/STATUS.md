# Launch status

Snapshot: 2026-11-05. This page records verified outcomes and open work; it is not a live monitor.

| Area | Status | Next check |
|---|---|---|
| Scheduled coding | Complete | The related change (#120) was merged as `cc7bac96c4e6551d67f692fa139e69457b2700c6`. |
| Crash-safe settlement | Open | Review restart reconciliation and draft publication; see [gap analysis](ralph-seams-gap.md). |
| Playbook parity | Open | Verify skill discovery and real coding behavior on the active host; see [investigation](poteto-parity-verify.md). |
| Always-on coding host | Required, open | Settle the [host design](launchd-always-on-brief.md), then verify crash and restart behavior. |
| Recurring tracker work | Deferred | Start only after the coding launch is complete and works as planned. |

The always-on host is a launch requirement, not an optional monitoring feature. A status reporter alone cannot execute coding work. Merge and package release are separate decisions.
