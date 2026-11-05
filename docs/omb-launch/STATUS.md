# OMB launch chase — five items (4 open + 1 final parked)

Updated: 2026-11-05 ~18:42 Europe/London · Driver: Launch Driver · OMB · Ship: Gilfoyle · poteto ff b726a68; Item 5 PARKED

**Parity bar:** OMB coding replacement = items 1–4 (incl. launchd REQUIRED). **Full fleet automation parity** also needs Item 5 tracker cadence → OMB after Julen confirms OMB works as planned (Julen HARD ~18:41).

## 1. Step 9 / Item I re-fire — MERGED

| | |
|---|---|
| Status | **MERGED** — Tip CI full green → undraft+merge (Julen Accept FM t185s812) |
| PR | https://github.com/evoclock/pi-agentic-driver-agents/pull/120 |
| Merged | 2026-11-05T18:37:13Z · SHA `cc7bac96c4e6551d67f692fa139e69457b2700c6` |
| Evidence | `~/openmausbot/.omb-scratch/item-i-evidence/i-90-step9/` |

## 2. Ralph production settlement — RATIFIED / FIRE chasing

| | |
|---|---|
| Status | **FIRE chasing READY** — Accept FM t191s840 + t203s889 |
| Fire | w1J:p1Z `omb-ralph-i91` · OMB slot5 `feat/ralph-crash-safe-publish` — WT dirty expanding (coding-production/git-host/publisher/receipts); still @ base `9021adb93` no commit/PR |
| Dig | [ralph-seams-gap.md](./ralph-seams-gap.md) |
| Evidence | `~/openmausbot/.omb-scratch/item-i-evidence/ralph-i91/` |
| Target | ONE DRAFT PR on evoclock/OpenMausBot (effectInspector + crash-safe publish) |

## 3. poteto-mode Pi parity — ff DONE / readiness BLOCKED

| | |
|---|---|
| Status | GitHub ff **DONE** → `b726a68`; readiness **BLOCKED** (OMB app not up) |
| Accept | FM voice ~18:35 + t203s889 |
| Dig | [poteto-parity-verify.md](./poteto-parity-verify.md) |
| HEAD | `b726a68d7561e1bb7ec0cf1d24f397949112a506` == origin/main |
| Evidence | `~/openmausbot/.omb-scratch/item-i-evidence/poteto-t203s889/RESULT.md` |
| Next | Start OMB host → `GET /api/pi/readiness` + Pi `get_commands` (skill:poteto-mode-pi + skill:statechart-pi); npm morning |

## 4. Always-on Pi under launchd — REQUIRED launch asset

| | |
|---|---|
| Status | **REQUIRED + PROCEED** — HARD ~18:35; Accept t203s889 (brief Qs / Ralph-first gate) |
| Dig/brief | [launchd-always-on-brief.md](./launchd-always-on-brief.md) |
| Julen | Accept t203s889 proceed; brief Qs may still need answers for build shape |
| Gate | Prefer Ralph crash-safe publication landed first (brief risk) |
| Done when | `com.openmausbot.coding-host` (or accepted equivalent) KeepAlive under launchd; coding host not session-status-only |


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

- `docs/omb-launch/` DRAFT PR on evoclock/OpenMausBot — Gilfoyle shipping (include this STATUS + digs)
- pad #119 HOLD

## Next

1. Ralph I-91 → READY DRAFT URL (WT dirty expanding)
2. Bring OMB app up → poteto readiness + get_commands verify
3. Launchd build after brief Qs (Q5 Ralph-first=yes) / Ralph DRAFT
4. After 1–4 DONE + Julen “OMB works as planned”: Item 5 tracker cadence → OMB (PARKED; ≠ npm)
