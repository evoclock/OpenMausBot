#!/usr/bin/env bash
set -euo pipefail
mode="${1:?Choose wording, review, author or dependencies}"
pr="${BUILDKITE_PULL_REQUEST:-false}"
if [[ "$pr" == false || -z "$pr" ]]; then
  echo "NOTICE: $mode is PR-only; skipping this non-PR build"
  exit 0
fi
[[ "$pr" =~ ^[0-9]+$ ]] || { echo 'Invalid PR number' >&2; exit 1; }
if [[ -z "${GH_TOKEN:-}" ]]; then
  GH_TOKEN="$(buildkite-agent secret get GH_TOKEN)" || {
    echo "ERROR: Buildkite GH_TOKEN is unavailable for $mode" >&2
    exit 1
  }
  [[ -n "$GH_TOKEN" ]] || { echo 'ERROR: Buildkite GH_TOKEN is empty' >&2; exit 1; }
  export GH_TOKEN
fi
repo=evoclock/OpenMausBot
python="$(uv python find --managed-python --no-python-downloads 3.12)"
scratch="$PWD/.omb-scratch/buildkite/${BUILDKITE_BUILD_ID:-local}-${mode}"
test ! -e "$scratch"
mkdir -p "$scratch"
gh api "repos/$repo/pulls/$pr" > "$scratch/pr.json"
base_sha="$("$python" -c 'import json,sys; print(json.load(open(sys.argv[1]))["base"]["sha"])' "$scratch/pr.json")"
git fetch --quiet origin "$base_sha"
case "$mode" in
  wording)
    base=.github/tools/pr-wording
    if ! git cat-file -e "$base_sha:$base/pr_wording_lint.py" 2>/dev/null; then
      echo 'NOTICE: PR wording tool is absent on the PR base; bootstrap check skipped'
      exit 0
    fi
    mkdir -p "$scratch/pr-wording"
    for name in pr_wording_lint.py pr_wording_rules.json; do
      git show "$base_sha:$base/$name" > "$scratch/pr-wording/$name"
    done
    "$python" -c 'import json,sys; p=json.load(open(sys.argv[1])); json.dump({"pull_request":{"title":p["title"],"body":p["body"]}},open(sys.argv[2],"w"))' "$scratch/pr.json" "$scratch/event.json"
    args=(--event "$scratch/event.json")
    if git cat-file -e "$base_sha:.github/pr-wording.json" 2>/dev/null; then
      git show "$base_sha:.github/pr-wording.json" > "$scratch/pr-wording.json"
      args+=(--config "$scratch/pr-wording.json")
    fi
    "$python" "$scratch/pr-wording/pr_wording_lint.py" "${args[@]}"
    ;;
  review)
    if ! git cat-file -e "$base_sha:.github/tools/pr_review_gate.js" 2>/dev/null; then
      echo 'NOTICE: PR review gate is absent on the PR base; bootstrap check skipped'
      exit 0
    fi
    git show "$base_sha:.github/tools/pr_review_gate.js" > "$scratch/pr_review_gate.js"
    node "$scratch/pr_review_gate.js" --repo "$repo" --pr "$pr"
    ;;
  author)
    if [[ -z "${ALLOWED_COMMIT_EMAILS:-}" ]]; then
      echo 'NOTICE: ALLOWED_COMMIT_EMAILS is unset; author check is informational'
      exit 0
    fi
    gh api --paginate "repos/$repo/pulls/$pr/commits?per_page=100" --jq '.[] | [.sha, .commit.author.email, .commit.committer.email] | @json' |
      node --input-type=module -e '
        let input = "";
        for await (const chunk of process.stdin) input += chunk;
        const allowed = new Set(process.env.ALLOWED_COMMIT_EMAILS.split(",").map(x => x.trim().toLowerCase()).filter(Boolean));
        if (!allowed.size) throw new Error("No allowed commit emails");
        const rows = input.trim().split("\n").filter(Boolean).map(JSON.parse);
        if (!rows.length) throw new Error("No PR commits returned");
        for (const [sha, author, committer] of rows) {
          if (!allowed.has(String(author ?? "").toLowerCase()) || !allowed.has(String(committer ?? "").toLowerCase())) {
            console.error(`Commit ${sha} has an unexpected author or committer`);
            process.exitCode = 1;
          }
        }'
    ;;
  dependencies)
    status=0
    pnpm audit --audit-level high --prod --json > "$scratch/current.json" || status=$?
    ((status <= 1)) || exit "$status"
    git show "$base_sha:pnpm-lock.yaml" > "$scratch/pnpm-lock.yaml"
    status=0
    (cd "$scratch" && pnpm audit --audit-level high --prod --json) > "$scratch/base.json" || status=$?
    ((status <= 1)) || exit "$status"
    node --input-type=module - "$scratch/current.json" "$scratch/base.json" <<'NODE'
import { readFileSync } from 'node:fs';
const findings = (path) => {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  if (!report?.advisories) throw new Error('Invalid audit output');
  return Object.values(report.advisories).filter(a => ['high', 'critical'].includes(a.severity))
    .flatMap(a => (a.findings || []).flatMap(f => (f.paths || []).map(p => JSON.stringify([a.id, a.module_name, f.version, p]))));
};
const known = new Set(findings(process.argv[3]));
const unexpected = findings(process.argv[2]).filter(item => !known.has(item));
if (unexpected.length) console.error(`New high or critical production advisories: ${unexpected.length}`);
process.exitCode = unexpected.length ? 1 : 0;
NODE
    ;;
  *) echo "Unknown check: $mode" >&2; exit 2 ;;
esac
