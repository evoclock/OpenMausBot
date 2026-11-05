# Technical investigations

These investigations identify work still needed for launch. They do not claim that a design is implemented or verified.

| Area | Investigation | Main finding |
|---|---|---|
| Crash-safe settlement | [Effect recovery and publication](ralph-seams-gap.md) | Prepared effects can be recorded, but production publication and recovery need an end-to-end path. |
| Playbook parity | [Discovery and behavior](poteto-parity-verify.md) | A skill name in discovery does not prove the installed playbook matches the expected version. |
| Always-on host | [Service design](launchd-always-on-brief.md) | The coding service needs a single storage owner and restart verification. |
