# OMB launch chase — five items (4 open + 1 final parked)

Updated: 2026-11-05 ~18:58 Europe/London · launchd plists STAGED (no load); #83/#82 Tip CI pending; #119 HOLD

**Parity bar:** OMB coding replacement = items 1–4 (incl. launchd REQUIRED). **Full fleet automation parity** also needs Item 5 tracker cadence → OMB after Julen confirms OMB works as planned (Julen HARD ~18:41).

## 1. Step 9 / Item I re-fire — MERGED

| | |
|---|---|
| Status | **MERGED** — Tip CI full green → undraft+merge (Julen Accept FM t185s812) |
| PR | https://github.com/evoclock/pi-agentic-driver-agents/pull/120 |
| Merged | 2026-11-05T18:37:13Z · SHA `cc7bac96c4e6551d67f692fa139e69457b2700c6` |
| Evidence | `~/openmausbot/.omb-scratch/item-i-evidence/i-90-step9/` |

## 2. Ralph production settlement — READY DRAFT

| | |
|---|---|
| Status | **READY DRAFT** — Accept FM t191s840 + t203s889 |
| Draft PR | https://github.com/evoclock/OpenMausBot/pull/83 |
| Head | `a516c1fee` · `feat/ralph-crash-safe-publish` |
| Dig | [ralph-seams-gap.md](./ralph-seams-gap.md) |
| Evidence | `~/openmausbot/.omb-scratch/item-i-evidence/ralph-i91/` |
| Next | Tip CI green → Julen undraft+merge Accept |


## 3. poteto-mode Pi parity — PROBE ACCEPTED / PARITY OPEN

| | |
|---|---|
| Status | **PROBE ACCEPTED** (FM t228u CORRECTION) — skill GREEN on `:8799`; **Item 3 still OPEN** |
| Blocking for parity | roles development + independent-review **RED** — need `.pi/pstack-model-roles.v1.json` (blocking, not optional) |
| Accept | t203s889 ff · t228u **probe** only (not full parity close) |
| Dig | [poteto-parity-verify.md](./poteto-parity-verify.md) |
| HEAD | `b726a68d7561e1bb7ec0cf1d24f397949112a506` == origin/main |
| Evidence | `~/openmausbot/.omb-scratch/item-i-evidence/poteto-t203s889/RESULT.md` |
| Left | roles file + end-behavior until readiness roles green; npm morning `@evoclock/pi-poteto-mode` |


## 4. Always-on Pi under launchd — REQUIRED · Ralph-first CLEARED · install pending Julen Accept

| | |
|---|---|
| Status | **Ralph-first CLEARED** — Q5 = install AFTER Ralph **DRAFT** (t228u); #83 DRAFT up → gate open |
| Dig/brief | [launchd-always-on-brief.md](./launchd-always-on-brief.md) |
| Defaults (t228u) | Q1 headless OMB · Q2 Electron client/off · Q3 pinned tag · Q4 Herdr under launchd too · Q5 after DRAFT |
| Blocker | Julen **install Accept** (Flockmate widget live) |
| Staged | `~/openmausbot/.omb-scratch/launchd-stage/` (+ `docs/omb-launch/launchd-stage/`) — plutil OK; **no bootstrap** |
| Done when | `com.openmausbot.coding-host` (+ Herdr) KeepAlive under launchd; coding host not session-status-only |


## 5. Tracker cadence → OMB — FINAL step (PARKED)

| | |
|---|---|
| Status | **PARKED** until items 1–4 DONE **and** Julen confirms “OMB works as planned” |
| Work | Copy Flockmate `flock-master-day-sync` + `crew-progress-watch` into OMB routines (local Qwen) |
| Cite | `~/project-planning/strands/omb-tracker-routines.md` |
| Julen | HARD ~18:41 Europe/London via Flockmate — final checklist step; do not wire early |
| Updated | 2026-11-05 ~18:41 Europe/London |


## Ship / release gate (npm) — SEPARATE from Item 5

| | |
|---|---|
| Status | HOLD until pad `#137` / `#119` READY + Flockmate clear |
| Relation | **Not** Item 5. Tracker cadence does not wait on npm; npm does not wait on tracker cadence. |
| Julen | Clarified ~18:41 Europe/London via Flockmate |

## Parallel

- `docs/omb-launch/` DRAFT https://github.com/evoclock/OpenMausBot/pull/82 (`docs/omb-launch-coordinator` @ tip) — pr-wording PASS; Tip CI tests pending → **wait full green**, then ask Julen undraft+merge (t228u). Do not merge yet.
- pad #119 HOLD (deprioritized)

## Next

1. Ralph #83 Tip CI green → Julen undraft+merge Accept
2. Launchd KeepAlive — plists staged; pending Julen install Accept before bootstrap
3. #82 Tip CI green → Julen undraft+merge Accept
4. Poteto Item 3 OPEN — roles RED → `.pi/pstack-model-roles.v1.json`
5. Item 5 stays PARKED until 1–4 + “OMB works as planned”
