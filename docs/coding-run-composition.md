# Coding run composition

The opt-in coding-run runtime joins the existing outer task, trigger adapters, and worker/reviewer seam. It starts no run without a caller-supplied host and explicit trigger registration. A fixture drives one scheduled occurrence and one signed CI event through the full composition, then checks worker, reviewer and pstack-verification ordering and delivery deduplication.

The production server does not instantiate this runtime yet. A trusted host must supply verified private repository visibility and token scope, a registered Pi skill/profile, real Herdr and Treehouse worker transport, and cleanup after merge or close. GitHub secrets must come from private service configuration. Until those dependencies and an isolated server fixture exist, this composition is not an unattended coding feature.
