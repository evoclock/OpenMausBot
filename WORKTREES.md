# CI worktree notes

- The Mac agent's system Python is 3.15, not 3.12. Buildkite checks now select an existing uv-managed 3.12 interpreter and fail early if it is missing. The host preflight also checks git and gh, so missing tools fail before lengthy test setup. The local host check and Python policy tests passed with 3.12.13.
- Hosted Linux test shards lacked browser libraries and could not complete a fake-engine install. All eight PR test shards now run on the Mac queue, with explicit timeouts. The local pipeline check confirms unique shard indexes and timeouts on every step; the next Buildkite result is still pending.
- A dependency audit failed when the base audit returned an invalid response. The latest dependency check passed without changing the lockfile or masking audit errors.
- Two CI tests still read a workflow removed during the cutover. They now inspect the active pipeline and remaining workflows; the targeted tests pass without Docker.
- Cloud sync used the Mac's low free-space reading, which blocked its fixture upload. The isolated server fixture now reports stable synthetic capacity; all three cloud-sync tests pass.
- Two tests used wall-clock-sensitive startup assertions under load. The coordination test now waits for the bot's observable idle-and-waiting state; the command-server budget test advances both the clock and timers. Both targeted tests pass locally.
