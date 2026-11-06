# Coding playbook parity: investigation

Snapshot: 2026-11-05.

OpenMausBot's coding prompt requests `poteto-mode-pi`. The readiness check can confirm that a skill is discoverable, but discovery by name does not verify the installed content or a complete coding journey.

The investigation found version drift between a coding host's local skill checkout and the expected source revision. Updating that checkout is a host operation, not an OpenMausBot source change. A later source update alone cannot prove the active process loaded the new skill.

## Acceptance checks

1. Check the expected skill version on the host that runs coding turns.
2. Query `/api/pi/readiness` and list available Pi commands for the required skills.
3. Exercise one bounded coding turn and inspect its result and failure behavior.
4. Recheck these observations after the coding host restarts.

End-to-end parity remains open until those checks pass. This document does not claim a live provider or launchd qualification.
