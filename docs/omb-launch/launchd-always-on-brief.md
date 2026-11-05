# C) Always-on Pi under launchd — design brief (NOT implemented)
Generated 2026-11-05 ~18:28 Europe/London.

## Survey
- Only OMB plist: `deploy/launchd/com.openmausbot.session-status.plist` — `StartInterval 60`, `RunAtLoad false`, runs `scripts/session-status-report.mjs` (a per-minute status push; `docs/session-status-feed.md`: "never starts a turn"). → status watcher, not a host.
- `server/service-unit.ts:74-93` renders a launchd agent with RunAtLoad+KeepAlive for `openmausbot serve` (`docs/self-hosting.md:287` "restarts it if it stops"); requires a global install, not npx cache.
- `electron/server-supervisor.mjs` supervises the server inside the desktop app (dies with the app).
- Host precedent: `~/Library/LaunchAgents/com.julen.dsf41-tunnel.plist` = `KeepAlive true, RunAtLoad true, ThrottleInterval 10`. No OMB/Pi/Herdr LaunchAgent installed today; `herdr server` (pid 1277) runs outside launchd.
- No OMB server process running at survey time (`pgrep`), though `~/.openmausbot/openmausbot-server.lease` exists.

## Proposal
**What stays up:** the OMB headless server (`node --experimental-strip-types server/index.ts` from a pinned checkout, or `openmausbot serve`) — it owns the outer runner, routines, webhook ingress and Pi Durable harness (single storage owner, outer-loop.md:15). Pi itself stays per-turn (RPC child spawned by the piAgent driver with `agentDir=~/.pi/pi`); do NOT keep a bare `pi` REPL alive — nothing would feed it work.

**Plist `com.openmausbot.coding-host`** (LaunchAgent, user julen, so Keychain/codex OAuth work):
- `RunAtLoad true`; `KeepAlive {SuccessfulExit:false, Crashed:true}` (clean exit = intentional stop); `ThrottleInterval 30`; `ProcessType Standard`; `ExitTimeOut 60` (lets abort/park finish).
- `WorkingDirectory` = dedicated release checkout (not `~/openmausbot` dev tree, not a Treehouse slot).
- `EnvironmentVariables`: PATH incl. `~/.local/bin` (pi), `/opt/homebrew/bin` (herdr, gh), DATA_DIR; no secrets inline (config.json already holds a key — consider moving to Keychain).
- Logs `~/Library/Logs/openmausbot/coding-host.{out,err}.log`.
- Optional companion: keep `herdr server` under its own KeepAlive plist so Treehouse/Herdr lease handoff survives reboot.

**Treehouse/Herdr handoff:** host acquires slots via existing `server/coding-treehouse-workspace.ts` lease table; on restart, outer recovery parks interrupted `running` runs as `blocked` (no replay) — lease release goes through `onCancel`/reconcile, never auto-release. Herdr panes remain attended-only; the launchd host never arms once.at.

**Failure/restart:** crash → launchd restart after throttle → `openOuterRunner` reopens harness (backs up pre-1.4.0 db) → `restartLimit` (default 5) guard → interrupted invocations parked → `reportPending()` delivers owner reports. Crash-loop: rely on `restartLimit` + ThrottleInterval; add a health check consumer via session-status feed stall wake.

**Difference vs session-status watcher:** watcher is a 60s one-shot reporter (StartInterval, no turns, read-only). Coding host is a long-lived daemon that *executes* scheduled/webhook coding runs with outward effects.

## Risks
- Unattended crash during publication is not crash-safe today (see A: no receipts on push/pr-open, no effectInspector) → every crash needs manual reconcile. Land A first.
- Single-owner SQLite: Electron app + launchd host would both open `coding-runs.sqlite` → must enforce one (lease file exists; confirm it blocks).
- Stale poteto install (see B) would run unattended with old playbook.
- Driver unpinned (loaded from ~/.pi npm dir) → silent upgrade changes behaviour.
- Codex subscription token refresh while unattended; Mac sleep (`caffeinate`/pmset).
- `codingRuns` config not found in `~/.openmausbot/config.json` → host would serve chat but run no coding until configured.

## Open questions for Julen Accept
1. Host = headless OMB server (proposed) or a Pi-specific daemon in pi-agentic-driver?
2. Electron app off when launchd host is on, or app connects to host as client?
3. Which checkout/version does launchd run (pinned tag vs Treehouse)?
4. Herdr server under launchd too?
5. Gate: land A (crash-safe publication) before enabling KeepAlive host?
