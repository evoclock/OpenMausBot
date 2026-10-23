# CI

## Buildkite checks

`.buildkite/pipeline.yml` runs all portable checks on the self-hosted `mac-mini`
queue. Each step has a timeout and priority `-1`, so other pipelines get the
shared agents first. `.buildkite/host.sh` checks the tools and pinned runtime
before installation. Dependencies are installed through Socket Firewall.

Every build runs typecheck, lint, the policy tests, the public scan, and the
docs typecheck, lint, and build. PRs run eight Vitest shards and the dependency,
author, wording, and review checks. Main builds run four Vitest shards. The
pipeline reports the 20 slowest PR tests after the shards finish, even if a
shard fails. A canceled shard is not a passing test result.

The dependency check compares production audit findings with the PR base. The
PR wording and review checks read the base branch's policy code; they do not
trust a PR's edits to those checks. The CI workflow tests verify queue,
priority, timeouts, shard coverage, and the remaining GitHub workflows.

## GitHub-only jobs

`.github/workflows/release.yml` packages macOS, Linux, and Windows installers
and publishes GitHub releases from version tags. Publishing requires GitHub
release permissions and the target platform for each installer.

`.github/workflows/browser-vendor-windows.yml` builds a reviewed Windows
browser candidate with a Linux cross-compiler and verifies its cold start and
restart on Windows. The Mac queue has neither that Linux toolchain nor a
Windows runtime. This workflow produces a candidate artifact, not a release.

After the cutover merges, the required checks on main must switch from the old
GitHub checks to `buildkite/openmausbot-ci`. Do not change branch protection
before the merge. A failed or canceled Buildkite build is not evidence that
those checks passed.
