# OMB launch chase — four open items

Updated: 2026-11-05 ~18:36 Europe/London · Driver: Launch Driver · OMB (`bdceec02-2aba-4fbf-822a-6ae737ef4b77`) · Ship: Gilfoyle

**Parity bar:** OMB counts as Grok Bot replacement only when all four items below are done, including **always-on Pi under launchd** (Julen HARD ~18:35 via Flockmate — required, not optional).

## 1. Step 9 / Item I re-fire — CLOSED (roadmap)

| | |
|---|---|
| Status | **CLOSED** — Julen t179s783 + DRAFT #120 |
| Draft PR | https://github.com/evoclock/pi-agentic-driver-agents/pull/120 |
| Head | `9138d86` |
| Merge | Julen Accept undraft+merge when Tip CI green (FM t185s812) — Gilfoyle chasing; Tip CI re-run may still be in flight |
| Evidence | `~/openmausbot/.omb-scratch/item-i-evidence/i-90-step9/` |

## 2. Ralph production settlement — RATIFIED / FIRE chasing

| | |
|---|---|
| Status | **RATIFY** Julen Accept FM t191s840 — chase READY DRAFT |
| Fire | w1J:p1Z `omb-ralph-i91` · OMB slot5 `feat/ralph-crash-safe-publish` @ `9021adb93` |
| Dig | [ralph-seams-gap.md](./ralph-seams-gap.md) |
| Evidence | `~/openmausbot/.omb-scratch/item-i-evidence/ralph-i91/` |
| Target | ONE DRAFT PR on evoclock/OpenMausBot (effectInspector + crash-safe publish) |

## 3. poteto-mode Pi parity — ACCEPTED (host refresh)

| | |
|---|---|
| Status | Julen Accept (FM voice ~18:35: accepted poteto) — execute host refresh |
| Dig | [poteto-parity-verify.md](./poteto-parity-verify.md) |
| Fix | GitHub-only tonight (t73u): point/ff `~/pi-poteto-mode` to tip `b726a68`; npm morning |
| Not | NEEDS_RICHARD |
| Verify | `/api/pi/readiness` + `get_commands` after refresh |

## 4. Always-on Pi under launchd — REQUIRED launch asset

| | |
|---|---|
| Status | **REQUIRED** before OMB = Grok Bot replacement (Julen HARD ~18:35) |
| Dig/brief | [launchd-always-on-brief.md](./launchd-always-on-brief.md) |
| Julen | Accepted launch (FM voice); brief Qs may still need answers for build shape |
| Gate | Prefer Ralph crash-safe publication landed first (brief risk) |
| Done when | `com.openmausbot.coding-host` (or accepted equivalent) KeepAlive under launchd; coding host not session-status-only |

## Parallel

- `docs/omb-launch/` DRAFT PR on evoclock/OpenMausBot — Gilfoyle shipping (include this STATUS + digs)
- pad #119 HOLD

## Next

1. Ralph I-91 → READY DRAFT URL
2. #120 Tip CI green → undraft+merge
3. Poteto host refresh + readiness probe
4. Launchd build after brief Qs / Ralph gate
