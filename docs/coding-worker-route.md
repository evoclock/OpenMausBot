# Coding worker and reviewer route

The worker route calls the existing pstack playbook and asks a distinct reviewer to inspect its revision. Only pstack's acceptance result together with reviewer evidence can produce a verified outcome. Missing role selection, workspace mismatch, interrupted work, or an external repository blocks the default route. No fixed model identity appears in the code or repository; the host must read and verify the private project role map in the actual bot repository.

`WorkerHost` is a boundary for the trusted host to supply a verified private repository, scoped token, isolated Treehouse lease, Pi worker and reviewer, and verification. The production host acquires a Treehouse workspace and invokes the existing server turn path for the configured worker and reviewer bots; this route module itself does not spawn panes or authorize a write. The host must validate the repository's actual visibility and permissions independently of the run contract. It must reconcile interrupted commits and pushes before a retry. A blocked attempt releases its lease, even after the worker made progress or the reviewer responded; the host reconciles outward effects before retry. A same-requestId re-acquire after release returns the same workspace and released lease identity, not a fresh active lease; a reconciled retry needs a new requestId. A progressing or verified attempt retains its workspace until the owner merges or closes the PR. Only then return or prune that lease. Reviewer output is evidence, not permission.

The role-readiness check still gates configured roles. Production turns require priced usage receipts for both worker and reviewer; an unknown cost prevents review or later work, and spending the remaining ceiling stops the run. The isolated composed-server fixture covers the actual server-turn path, not a simultaneous multi-worker capacity claim.

## Destination-aware Git control

The operator sets `codingRuns.gitDestinations[botId]` to entries with an exact
`evoclock/repository` name, a lowercase branch prefix, optional expected
visibility, and one credential choice. A choice names either a per-repository fine-grained token
reference, a group name in `codingRuns.gitCredentialGroups`, or a GitHub App
installation reference. A group declares its token reference, public or private
scope, and exact repository names. There is no default choice. References are
names, not token values; no token belongs in `config.json`.

The host policy takes fresh repository facts and a credential-provider decision
for each action. It checks the actual remote, visibility, write permission,
protected base, current branch, outgoing commit authors and exact push ref.
It refuses unconfigured or uncertain facts, force pushes, main/default/protected
branch pushes, releases and publication. New PRs are drafts; updates and
mark-ready actions are allowed only for a verified PR number, base and head.
A private merge can be recorded as eligible only when every check for that
exact PR passes and its run record has a reason that states what
further development it unblocks. `RunContractStore.recordOwnerMerge` persists
that reason once for a verified run and rejects a changed record. Squash and
public merges refuse. Only Julen executes merges.

Coding *turns* use a closed profile rather than inheriting the bot's chat permissions.
It permits native read, write and edit within the leased worktree and one bounded
`coding_command` tool: Git status, whitespace diff, explicit-path add and commit
on the leased branch, or the pipeline's typecheck, lint and test commands with
timeouts. It does not expose a shell, MCP executor or question tool. Pi loads
only the server's extension for these turns. An unexpected dialog or denied tool
stops the turn and records one denial in the session-status feed. Interactive
chat turns, including chat with the same bot, retain their normal permissions.
The composed-server fixture checks the actual turn dispatch and no-card boundary. Until an owner-configured
credential provider, repository inspector and host Git port are connected,
the production runtime's `gitAction` refuses every request. Once those trusted
inputs are supplied, `gitAction` binds configured destinations to the run's
merge-reason receipt; it does not expose a shell or public merge endpoint. This is a
fail-closed limitation, not an implicit permission for an agent to use another
shell or a claim of operating-system containment against untrusted extensions.
The local bare-repository test exercises the checked host port without a real
credential or remote forge.

### Read-only host inspection and installation grants

`GitHostInspector` exposes branch refs, matching PRs and comments containing an
exact idempotency marker. A complete empty read returns `absent`; authentication
failures, rate limits, malformed responses and unfinished pagination return
`inconclusive`. The GitHub implementation makes GET requests only and takes its
access token from the trusted host on each call. It is not enabled by default.

An explicit `github-app` destination reference can select
`codingRuns.gitAppInstallations[reference]`. Each entry declares the app and
installation IDs, an absolute private-key path, exact repositories and optional
visibility. The provider reads that path at action time, mints a repository-
scoped installation token, and verifies write permission and visibility without
caching the token. Missing paths, invalid keys and missing repository coverage
refuse. `server/testing/github-app-installation.example.json` contains
placeholders, not usable credentials. Tests generate a disposable signing key
and simulate GitHub responses; no live App or production Git transport is
connected. Host push and PR actions still refuse until a trusted host port is
configured. Commit authorship and merge limits remain enforced by the existing
Git policy for every credential choice.
