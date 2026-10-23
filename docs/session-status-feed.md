# Live session status feed

A durable record of what each active coding session is doing, fed by one
per-minute local job, plus a wake signal that only fires when something
changes. The per-minute push never starts a turn; the coordinator's existing
checkpoint reads the records on its own schedule and acts only when the feed
says there is something to act on.

The feed is a status record, not a scheduler and not a second timer. It reuses
the existing routine scheduler for its one wake path and the existing
`runStateSchema` from `server/run-contract.ts` for session states, so a session
report and a coding-run snapshot speak the same vocabulary.

## What a session reports

One JSON object per push, validated by `sessionStatusReportSchema` in
`server/session-status-feed.ts`:

| Field | Meaning |
| --- | --- |
| `sessionId` | Stable session or lease id: letters, digits, dash or underscore. |
| `reportId` | Stable per push, normally `sessionId:sequence`. A replay is a no-op. |
| `sequence` | Monotonic per session. An older sequence is refused as stale. |
| `state` | `queued`, `running`, `waiting`, `blocked`, `unverified`, `done`, `failed` or `cancelled`. |
| `phase`, `stepId` | Optional last committed step, for reading only. |
| `progressAt` | When the session last made real progress, in epoch milliseconds. |
| `reportedAt` | When the reporter ran, in epoch milliseconds. |
| `needsDecision`, `decision` | Set when the session is parked on a choice a person must make. |
| `prReady`, `prUrl` | Set when a draft pull request is ready for review. |
| `evidence` | Optional short lines the session wants carried to the coordinator. |

The feed keeps the newest record per session. `changes` on a record lists the
change kinds observed on that push.

## When it wakes the coordinator

Only four changes create a wake:

- **stall** — a `running` session has not reported progress for 15 minutes. One
  wake per stall episode; progress resuming and stalling again is a new episode.
- **decision** — `needsDecision` turns on, or the decision text changes.
- **completion** — the state becomes `done`, `failed` or `cancelled`.
- **pr-ready** — `prReady` turns on.

Everything else is a quiet heartbeat: the record updates and nothing wakes.
The first report for a session is context, not news, so it creates no wake.
A wake stays pending until it is acknowledged. A changed decision creates a
new wake even if an earlier decision is pending, so acknowledging the earlier
one cannot erase the new request. Repeated reports with the same decision do
not create wakes. Other changes of the same kind remain coalesced while pending.
The checkpoint reads the newest session record before acting. Acknowledging
is idempotent.

## Routes

All three are admin-only, like every new route until it is listed in
`CLIENT_ALLOW`.

| Route | Purpose |
| --- | --- |
| `POST /api/session-status/report` | Record one push. Requires `content-type: application/json`. Returns `accepted`, `duplicate`, `stale`, `changed` and `changes`. A quiet heartbeat returns `changed: false` and starts nothing. |
| `GET /api/session-status` | `{ sessions, wakes }`: newest record per session and the pending wakes, oldest first. This is what the checkpoint reads. |
| `POST /api/session-status/wake/ack` | `{ ids }` of the wakes the checkpoint acted on. Returns `acknowledged`. |

When a push produces new wakes, the server also starts one run of the routine
named by `sessionStatus.wakeRoutineId` in `config.json`, through the existing
`RoutineManager.runNow`. That is the only wake path; without the setting the
records and the `GET` route are the only signal, and the checkpoint's own
schedule is the only reader.

```json
{
  "sessionStatus": { "wakeRoutineId": "the-checkpoint-routine-id" }
}
```

Leaving `wakeRoutineId` unset is a supported state: the per-minute job still
records status and the checkpoint still sees pending wakes, it just is not
started early.

## Session status files

Each session writes one file, `<statusDir>/<sessionId>.json`, holding the
fields above except `sequence`, `reportId` and `reportedAt`. The reporter adds
those and posts the result. Files older than `OMB_STATUS_STALE_MINUTES`
(default 60) are skipped, so a finished session stops reporting without needing
to delete its file. Files over 64 KiB are skipped.

## Installing the per-minute reporter

The reporter is `scripts/session-status-report.mjs`. It runs on the machine
that hosts the sessions and reads `OMB_SESSION_STATUS_DIR` (default
`~/.openmausbot/session-status`). It posts to `OMB_URL` (default
`http://127.0.0.1:8799`) and sends `authorization: Bearer $OMB_STATUS_TOKEN`
when that variable is set. On the same machine as OpenMausBot, loopback trust
already allows the call, so no token is needed.

The launchd job is shipped as `deploy/launchd/com.openmausbot.session-status.plist`
and is deliberately not loaded by this repository. To install it:

1. Replace every `__PLACEHOLDER__` in the plist: the absolute `node` path, the
   repository root, the OpenMausBot URL, the status directory and a log
   directory.
2. Copy it to `~/Library/LaunchAgents/com.openmausbot.session-status.plist`.
3. Load it with `launchctl load ~/Library/LaunchAgents/com.openmausbot.session-status.plist`.
4. Confirm one heartbeat with
   `launchctl start com.openmausbot.session-status` and
   `curl http://127.0.0.1:8799/api/session-status`.

`StartInterval` is 60 seconds, `RunAtLoad` is false, and the job has no
`KeepAlive`: it is one timer, not a daemon. Do not add a second one for the
checkpoint; the checkpoint keeps its own schedule.

## The checkpoint's gate

A checkpoint turn can begin by reading the feed instead of deciding on its own:

```sh
curl -s http://127.0.0.1:8799/api/session-status
```

If `wakes` is empty, the checkpoint has nothing new: it holds and ends. If it
is not, the checkpoint reads `sessions` for context, acts on each wake, then
posts the ids it handled to `/api/session-status/wake/ack`. Acknowledging
before acting would let a later change look like the same one.

## Routine interval floor

OpenMausBot enforces a minimum routine interval on the server, not only in the
editor: `server/routines.ts` rejects an interval outside 5–1440 minutes at
line 483, and the HTTP and driver boundaries repeat the same floor in
`server/routine-requests.ts` (lines 149, 182 and 512) and
`server/drivers/agents-call-triggers.ts` (line 120). So a five-minute
checkpoint is the shortest interval routine the scheduler accepts, and the
per-minute status feed cannot be modelled as a routine.
