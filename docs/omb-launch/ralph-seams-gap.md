# Crash-safe settlement: gap analysis

Snapshot: 2026-11-05, based on the OpenMausBot source at `9021adb93`.

## Existing seams

- `server/coding-worker-host.ts` composes workspace acquisition, a coding turn, review, and verification.
- `server/coding-effect-receipts.ts` stores prepared and confirmed effects and offers reconciliation.
- `server/coding-effect-reconciliation.ts` can observe Git branch pushes and pull requests.
- `server/outer-runner.ts` parks uncertain interrupted work when recovery cannot establish the outcome. This is safer than replaying an outward write.

## Gaps

- Production wiring in `server/coding-production.ts` does not pass an effect inspector to the run runtime. Restart reconciliation therefore lacks the observation path it needs.
- Draft publication in `server/coding-git-publisher.ts` runs after the coding result, without preparing and confirming receipts around each outward write. A crash between a push and opening a pull request can leave an uncertain partial publication.
- Publication state is held in memory. A process restart needs a durable account of which publication step completed.
- Existing documentation on the coding seams should be checked against the current implementation before it is used as a launch contract.

## Proposed verification

Give publication a durable effect identity, prepare it before each outward write, observe its actual destination after a crash, and confirm only the observed outcome. An inconclusive observation must remain blocked. A fixture should interrupt the flow between branch push and draft creation, restart the service, and prove that the missing step occurs once without repeating an uncertain write. This is a proposal, not a completed fix.
