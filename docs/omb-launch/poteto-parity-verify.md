# B) poteto end-behavior + recipe parity — VERIFY (READ-ONLY)
Generated 2026-11-05 ~18:28 Europe/London.

## Verdict: **GAPS** (host install stale — GitHub tip has parity; no package change needed → not NEEDS_RICHARD)

## Evidence
- OMB contract: `docs/pi-coding-readiness.md:3` "Every Pi turn requires the `poteto-mode-pi` skill in Pi's `get_commands` … accepts `skill:poteto-mode-pi`". Prompt: `server/coding-playbook-prompt.ts:12-13` emits `/skill:poteto-mode-pi` + "Use the Autonomous run playbook for one bounded unit". Playbook exists: `pi-poteto-mode-agents/skills/poteto-mode-pi/SKILL.md:516` "**Autonomous run.**".
- OMB Pi provider: `~/.openmausbot/config.json:127` `"agentDir": "/Users/julen/.pi/pi"`.
- That agentDir loads poteto from a **local path**: `~/.pi/pi/settings.json` packages include `"/Users/julen/pi-poteto-mode"` (not GitHub/npm).
- `~/pi-poteto-mode` HEAD **64fa5d9** (2026-10-19 "Update README.md"), **13 commits behind** origin/main **b726a68** (GitHub `ls-remote` confirms), and dirty (`M skills/how/WORKFLOW_BOUNDARIES.md`, untracked `.asgrep/`).
- Missing locally vs tip: 4 skills — `create-formal-verification-skill-pi`, `ketchup-video-pi`, `maintain-formal-verification-skill-pi`, `statechart-pi`; and `skills/poteto-mode-pi` diff HEAD..origin/main = 26 files, +2146/−117. Tip commits include "Restore complete workflows for version 0.1.1" (8a304a7), "Mark workflows as packaged since 0.1.1" (57af6f6).
- GitHub tip parity: `git ls-tree origin/main skills/` of pi-poteto-mode == `~/pi-poteto-mode-agents/skills` (identical set, sort-only diff). Agents repo `UPSTREAM.lock.json` pins pstack **0.15.36** per-skill sha256, status `instruction-port`. ⇒ the parity claim holds **on GitHub**, not on the host Pi OMB uses.
- `~/pi-poteto-mode-agents` local HEAD 8a49077 == its GitHub tip (`ls-remote` 8a4907758).
- `~/.pi/agent/settings.json` (default Pi dir) loads only `npm:@evoclock/pi-agentic-driver` with `"!skills/*-pi"` → no poteto there; irrelevant to OMB since agentDir=~/.pi/pi.
- Pi CLI `~/.local/bin/pi` 1.5.0. Not run: live `get_commands` probe (would need Pi RPC; skipped to stay read-only/no-turn).

## End-behavior
Cannot claim verified end-behavior: stale local skill means OMB coding turns today run the Oct-19 poteto-mode-pi, not the 0.1.1 workflows. Readiness check passes on name only (skill discovery ≠ content parity).

## Fix (needs Julen Accept; host change, no publish)
1. Either `git -C ~/pi-poteto-mode stash && pull --ff-only` (dirty file must be reviewed first), or switch `~/.pi/pi/settings.json` entry to the GitHub source (`git:github.com/evoclock/pi-poteto-mode@b726a68`) per t73u "GitHub only tonight"; npm `@evoclock/pi-poteto-mode` in the morning.
2. Then probe: `GET /api/pi/readiness?botId=<coding bot>` and one Pi `get_commands` listing `skill:poteto-mode-pi` + `skill:statechart-pi`.
3. Open Q: which of the two repos (pi-poteto-mode vs pi-poteto-mode-agents) is canonical? Both carry package name `@evoclock/pi-poteto-mode`.
