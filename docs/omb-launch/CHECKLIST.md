# OMB launch checklist (five items)

Driver: Launch Driver · OMB (`bdceec02-2aba-4fbf-822a-6ae737ef4b77`)
Ship: Gilfoyle (`399f27aa-f587-4d7e-ac6d-8ddd09708bb6`)

**HARD:** Item 4 (always-on Pi under launchd) is a **required** launch asset before OMB counts as a Grok Bot replacement (Julen ~18:35 Europe/London via Flockmate).

**HARD:** Item 5 (tracker cadence → OMB) is the **final** launch step — only after items 1–4 and Julen confirms OMB works as planned (Julen ~18:41 Europe/London via Flockmate).

**Accept FM t203s889 (2026-11-05 ~18:39):** ALL THREE — Ralph keep READY chase · poteto GitHub refresh + Pi parity verify tonight · always-on launchd REQUIRED proceed (brief Qs / Ralph-first gate).

**Accept FM t228u (2026-11-05 ~18:51):** poteto prove OK · launchd Q1–4 = defaults (headless OMB · Electron client/off · pinned tag · Herdr too · Ralph-first) · #82 wait Tip CI green then undraft+merge ask · Item 5 stays PARKED.

**HARD Item 5 FINAL (Julen voice ~18:41 via Flockmate):** Tracker cadence → OMB only after items 1–4 DONE + Julen confirms “OMB works as planned”; cite `~/project-planning/strands/omb-tracker-routines.md`.


## Ordering (HARD — Julen ~18:41 Europe/London via Flockmate)

1. Items **1–4** — coding / GrokBot-replacement launch bar (Step 9, Ralph, poteto, always-on launchd).
2. Item **5** — tracker cadence → OMB routines (FINAL ops step). Only after 1–4 **and** Julen confirms “OMB works as planned.” **Not** the same moment as npm publish.
3. **Ship / release gate (npm publish of pi-agentic-driver stack)** — **SEPARATE**. Blocked on pad `#137` / `#119` READY + Flockmate clear. Does not gate Item 5; Item 5 does not wait on npm; coding once.at does not wait on npm.

Mark DONE only with evidence pointer (PR, RESULT.md path, or Julen Accept id).

## [x] 1. Step 9 / Item I once.at repeatability — CLOSED roadmap

- [x] Prep + FIRE + READY DRAFT https://github.com/evoclock/pi-agentic-driver-agents/pull/120
- [x] Undraft+merge Tip CI green (Julen Accept FM t185s812) — MERGED 2026-11-05T18:37:13Z
- Evidence: `~/openmausbot/.omb-scratch/item-i-evidence/i-90-step9/`

## [ ] 2. Ralph production settlement seams — READY DRAFT #83

- [x] Gap dig: [ralph-seams-gap.md](./ralph-seams-gap.md)
- [x] Julen RATIFY Accept FM t191s840 + t203s889 (keep READY chase)
- [x] READY DRAFT https://github.com/evoclock/OpenMausBot/pull/83 (`a516c1fee`)
- [ ] Tip CI green → Julen undraft+merge
- Evidence: `~/openmausbot/.omb-scratch/item-i-evidence/ralph-i91/`

## [ ] 3. poteto-mode recipe/playbook Pi parity + end-behavior — PROBE ACCEPTED / PARITY OPEN

- [x] Dig: [poteto-parity-verify.md](./poteto-parity-verify.md)
- [x] Julen Accept poteto (FM voice ~18:35 + t203s889)
- [x] Host GitHub ff → `b726a68` — evidence `~/openmausbot/.omb-scratch/item-i-evidence/poteto-t203s889/RESULT.md`
- [x] Probe skill GREEN (Accept FM t228u **probe only**) — evidence same RESULT.md
- [ ] Item 3 parity OPEN — roles RED need `.pi/pstack-model-roles.v1.json` + end-behavior; probe ≠ closed
- [ ] npm morning `@evoclock/pi-poteto-mode`


## [ ] 4. Always-on Pi under launchd (coding host) — REQUIRED

- [x] Design brief: [launchd-always-on-brief.md](./launchd-always-on-brief.md)
- [x] Julen HARD: required launch asset (not optional)
- [x] Julen Accept launch (FM voice ~18:35 + t203s889 PROCEED)
- [x] Brief Q1–4 answered = defaults (Accept FM t228u): headless OMB · Electron client/off · pinned tag · Herdr under launchd too · Ralph-first
- [ ] Install KeepAlive `com.openmausbot.coding-host` (+ Herdr) LaunchAgent — Ralph #83 DRAFT cleared gate; design→install NOW
- [ ] Prove host survives reboot / crash restart without owner babysitting


## [ ] 5. Tracker cadence → OMB (FINAL step) — PARKED

- **SEPARATE** from npm/ship gate (`#137`/`#119`) — neither waits on the other

- [ ] Gate: items 1–4 DONE **and** Julen confirms “OMB works as planned”
- [ ] Copy Flockmate `flock-master-day-sync` + `crew-progress-watch` shape into OpenMausBot routines on local compute (Qwen)
- [ ] Same `~/flock-master` hooks / `publish.sh` path; no separate mergeable-PR chat poll
- Cite: `~/project-planning/strands/omb-tracker-routines.md` (parked 2026-10-25; Julen HARD via Flockmate ~18:41 Europe/London)
- Division: OMB local = high-freq cache/update + Herdr/Pi; Grok/Flockmate = external connectors

## Done / not in this chase

- Host app evoclock 0.2.0 (`app-update.yml` owner evoclock)
- Closed non-interactive coding profile (#43)
