# OMB launch checklist (four items)

Driver: Launch Driver · OMB (`bdceec02-2aba-4fbf-822a-6ae737ef4b77`)
Ship: Gilfoyle (`399f27aa-f587-4d7e-ac6d-8ddd09708bb6`)

**HARD:** Item 4 (always-on Pi under launchd) is a **required** launch asset before OMB counts as a Grok Bot replacement (Julen ~18:35 Europe/London via Flockmate).

Mark DONE only with evidence pointer (PR, RESULT.md path, or Julen Accept id).

## [x] 1. Step 9 / Item I once.at repeatability — CLOSED roadmap

- [x] Prep + FIRE + READY DRAFT https://github.com/evoclock/pi-agentic-driver-agents/pull/120
- [ ] Undraft+merge when Tip CI green (Julen Accept FM t185s812)
- Evidence: `~/openmausbot/.omb-scratch/item-i-evidence/i-90-step9/`

## [ ] 2. Ralph production settlement seams — RATIFIED FIRE

- [x] Gap dig: [ralph-seams-gap.md](./ralph-seams-gap.md)
- [x] Julen RATIFY Accept FM t191s840
- [ ] READY DRAFT PR on evoclock/OpenMausBot (effectInspector + crash-safe publish)
- Evidence: `~/openmausbot/.omb-scratch/item-i-evidence/ralph-i91/`

## [ ] 3. poteto-mode recipe/playbook Pi parity + end-behavior

- [x] Dig: [poteto-parity-verify.md](./poteto-parity-verify.md) — host stale; GitHub tip OK
- [x] Julen Accept poteto (FM voice ~18:35)
- [ ] Host refresh (GitHub tonight / npm morning) + readiness probe

## [ ] 4. Always-on Pi under launchd (coding host) — REQUIRED

- [x] Design brief: [launchd-always-on-brief.md](./launchd-always-on-brief.md)
- [x] Julen HARD: required launch asset (not optional)
- [x] Julen Accept launch (FM voice ~18:35)
- [ ] Answer/resolve brief open Qs as needed
- [ ] Install KeepAlive coding-host LaunchAgent (not session-status-only)
- [ ] Prove host survives reboot / crash restart without owner babysitting

## Done / not in this chase

- Host app evoclock 0.2.0 (`app-update.yml` owner evoclock)
- Closed non-interactive coding profile (#43)
