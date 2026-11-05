# A) Ralph production settlement — seams gap (READ-ONLY dig)
Generated 2026-11-05 ~18:28 Europe/London. SoT = evoclock/OpenMausBot `main` tip **9021adb93** (`git ls-remote` confirmed; Treehouse slot 4 `~/.treehouse/openmausbot-f7333a/4/openmausbot` is checked out at it). Note `~/openmausbot` local main is 1fde0b95c, **137 behind** — do not read it as SoT.

## What exists
| Seam | Evidence | State |
|---|---|---|
| WorkerHost composition | `server/coding-worker-host.ts:26-94` `createCodingWorkerHost` — roles check vs `.pi/pstack-model-roles.v1.json` (L37-47), contract-matched workspace acquire (L48-57), dev turn `runPlaybook` (L59-73), independent `review` requiring `ACCEPT <rev>` (L77-91), `verifyWithPstack` | **Real impl** (seams-map row "`WorkerHost` is currently an interface", `docs/loops-seams-map.md:12`, is stale) |
| Production wiring | `server/coding-production.ts:263` `openCodingRunRuntime({... workerHost: host, ... loadDriver, onCancel})` | Wired — but **no `effectInspector` passed** |
| Driver transport | `server/coding-run-runtime.ts:51-80` invokes `driver.invokeWorker`, `receipts.saveResult(...)` (L66), hash reference `omb-result:<sha256>`; `server/driver-run-api.ts:6-31` loads `@evoclock/pi-agentic-driver` from `~/.pi/{pi,agent}/npm` or git path | Wired; driver is NOT a package.json dep (only `@earendil-works/pi-durable: 1.4.0`, package.json:98) — loaded from host Pi install |
| Effect receipts | `server/coding-effect-receipts.ts:16-89` SQLite `PRAGMA synchronous=FULL`, `prepare/confirm/list`, `saveResult/savedResult` | Implemented |
| Reconciliation | `server/coding-effect-reconciliation.ts` forge observe (branch-push / pr-open / pr-comment); `reconcilePreparedEffects` (`coding-effect-receipts.ts:96-124`) | Implemented + unit tests |
| Outer recovery path | `server/outer-runner.ts:87-121` uses `options.effectRecovery` → `reconcilePreparedEffects` → `confirmInvocation`; else parks `blocked` "driver reconciliation failed; owner review required" | Implemented, **conditional on effectRecovery** |
| effectRecovery plumbing | `coding-run-runtime.ts:92` `...(options.effectInspector ? { effectRecovery: {...} } : {})` | Off unless inspector supplied |

## Stub / TODO / gaps (blocking unattended production)
1. **No production `EffectReconcileHost`.** `rg effectInspector server` → only `coding-run-runtime.ts:27,92`; `coding-production.ts:263-267` omits it. So after any crash mid-`running`, recovery always parks `blocked` (docs/outer-loop.md:15 "Without a configured recovery host, the original fail-closed block remains in force"). Safe, but every crash = owner manual reconcile → not unattended.
2. **Outward writes bypass receipts.** Publication happens in `onTerminal` *after* `done`: `coding-production.ts:~225-241` → `publishVerifiedCodingRun` (`server/coding-git-publisher.ts:18-22`: `createBranch` → `gitAction push` → `gitAction pr-open draft`). `rg "receipts.prepare"` finds **no caller** in non-test server code. Push/PR are therefore not crash-safe: a crash between push and pr-open leaves no prepared receipt; restart cannot know what happened. Publication result is held in in-memory maps (`publishing`, `publicationResults`) — lost on restart.
3. **Receipts keyed to (runId, iteration)**, but publication is post-terminal, outside any iteration → schema has no slot for "publication" effects (would need e.g. sequence = final iteration or a dedicated `publish` key).
4. **Driver not pinned** — docs/outer-loop.md:9 & loops-seams-map.md:37 "package is not yet published or pinned, so this branch must remain draft"; runtime loads whatever is in `~/.pi/agent/npm/node_modules/@evoclock/pi-agentic-driver/` (present on Mac). Version drift risk; probe fails closed.
5. **Config**: `rg codingRuns ~/.openmausbot/config.json` → no match. Unattended runs require `codingRuns.bots[originBotId]` (outer-loop.md:5). Either config lives elsewhere or production attachment is not enabled on this host — verify before Step 9 re-fire relies on it.
6. Docs drift: `docs/loops-seams-map.md:12,16` still say WorkerHost is an interface and "no effect reconciliation" — stale vs code; fix in same PR.
7. Two-DB non-atomic (`runtime.db` + `coding-runs.sqlite` + `effect-receipts.sqlite`), loops-seams-map.md:33 — handled by park-on-mismatch (outer-runner.ts:142-143). OK.

## Proposed next card (one PR, draft, owner merges)
**"Crash-safe draft publication via effect receipts + production GitHub EffectReconcileHost"**
- Add `server/coding-github-effect-host.ts`: `ForgeEffectInspector` (GET ref / list PRs by head+base / list comments by key) + `applyMissing` delegating to existing `createCodingGitRunPolicy` gitAction (no new write path).
- In `publishVerifiedCodingRun`: `receipts.prepare(runId, seq, "push", {kind:"branch-push", expectedSha})` before push, `confirm` after observe; same for `pr-open`. Persist publication result (replace in-memory maps) so `reportPending` survives restart.
- Pass `effectInspector` in `coding-production.ts:263`.
- Test: crash fixture kills between push and pr-open → restart observes branch present, PR missing → applyMissing pr-open once → confirmed; inconclusive → blocked. Update loops-seams-map.md rows 12/16.
- Out of scope: driver npm pin (separate, needs published package).
