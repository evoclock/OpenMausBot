# Coding-run crash drill

## Watching a coding loop

The Activity panel shows a read-only Loop watch section for the selected bot.
`GET /api/bots/:botId/loop-status` returns up to 20 recent runs for a visible
bot, with state, iteration, spent and remaining budgets, the last persisted
iteration verdict, and up to 10 recent durable iteration receipts per run.
Unknown spend and unavailable limits display as unknown rather than an
estimated remaining budget. An absent coding-run database returns an empty list.
The receipts are the currently available history; a separate detailed loop
ledger is not yet integrated. This endpoint cannot start, steer or stop a run.


Run the local fixture with `node scripts/drill-coding-run.mjs --fixture`. It creates an
isolated server home, local bare Git destination and fake Pi process. The fake
GitHub identity is confined to the fixture; the local bare repository receives
all pushes. The script sends SIGKILL to the server while the reviewer turn is
pending after one worker commit, restarts the server and checks the original
prepared receipt, blocked run, unchanged revision, two initial turns and one
owner report. No replay or review acceptance is claimed. The worker revision
is copied to a `draft/` ref in the fixture; this is not a GitHub pull request.
The machine-readable result is `.omb-scratch/proof/omb-drill/report.json`.
A CI-safe test exercises the same path in `server/coding-production.e2e.test.ts`.

The real sandbox drill is **not** part of this PR. The chosen private destination
is `evoclock/omb-drill-sandbox`; it already exists. Do not create a repository.
Run the live drill only after this harness merges with green checks. On the Mac
mini, use a separate Treehouse-managed worktree under Julen's user; do not use
a separate macOS account. Record the approved host, exact destination,
credential **reference** (never its value), worktree, bot IDs, model selection,
low thinking setting, max iterations, and the per-origin-bot wall-clock and
spend limits in a private config. For example, the model selection for this
drill is `gpt-6-sol` with low thinking, not a fallback inferred by the harness.
The chosen wall-clock limit is a config value, not a fixed duration.

The local script refuses `--live` even with a complete config: the live run
waits for this harness PR to merge with green checks and must not be simulated
as completed. After an authorized run, `--audit-sandbox CONFIG`
requires the exact expected revisions between the recorded base and sandbox
head, and checks the author **and committer** of every sandbox commit,
including merge commits, against `evoclock <52983349+evoclock@users.noreply.github.com>`.
A squash replacement of an expected revision fails the ancestry check. The
audit refuses a destination other than the chosen sandbox, or a mismatched
host or origin. Inspect GitHub's sandbox pull requests as well: the audit of local Git history alone cannot certify
that a remote PR was draft or that no remote-only merge occurred.

A mid-iteration crash is intentionally terminal blocked. Effect reconciliation
for a safe resume is a separate decision for Julen, not a change to the
outer-runner safety rule.
