#!/usr/bin/env bash
set -euo pipefail
command -v sfw >/dev/null
command -v pnpm >/dev/null
command -v uv >/dev/null
uv python find --managed-python --no-python-downloads 3.12 >/dev/null
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'
test "$(pnpm --version)" = 10.33.0
