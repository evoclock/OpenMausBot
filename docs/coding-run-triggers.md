# Coding run trigger boundary

OpenMausBot already schedules cron routines and records webhook deliveries. `startScheduledCodingRun` accepts a persisted scheduled `RoutineRun` after that scheduler marks it running. `startGithubCodingRun` accepts raw GitHub PR and CI event bodies and checks their SHA-256 HMAC before parsing them. Both derive a stable run ID from the persisted occurrence or delivery ID, and return an existing run instead of starting it again after a duplicate callback.

Only owner-configured **private agent repository** templates may start unattended. This boundary rejects external/public templates and external-write grants. The host must independently verify repository visibility, the exact token scope and approved template ownership; a template's `repositoryClass` is data, not proof. Keep the webhook secret outside Git and pass the original raw bytes and `X-Hub-Signature-256` header. Ordinary webhook capability URLs are not a substitute for GitHub HMAC verification.

These adapters are not yet attached to the live routine scheduler or webhook ingress. Do not open an unauthenticated HTTP endpoint or claim scheduled coding runs work end-to-end until the worker route and server wiring have fixture coverage. Existing routine retry and delivery handling remain unchanged.
