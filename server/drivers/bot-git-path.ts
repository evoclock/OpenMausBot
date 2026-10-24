import { accessSync, constants, mkdirSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { writeFileAtomicIfChanged } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import { augmentedPath } from "../env-path.ts";

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

export function botGitPath(path = augmentedPath(), dataDir = DATA_DIR): string {
  if (process.platform === "win32") return path;
  const bin = join(dataDir, "bot-git-bin");
  let git: string | undefined;
  for (const directory of path.split(delimiter)) {
    if (!directory || directory === bin) continue;
    try {
      const candidate = realpathSync(join(directory, "git"));
      accessSync(candidate, constants.X_OK);
      if (candidate !== join(bin, "git")) { git = candidate; break; }
    } catch { /* A PATH directory can disappear between calls. */ }
  }
  if (!git) throw new Error("Git is unavailable for this bot run; cannot install the checkout guard");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const script = `#!/bin/sh
set -eu
real_git=${quote(git)}
verb=
following=
expect_value=0
for word in "$@"; do
  if [ "$expect_value" -eq 1 ]; then expect_value=0; continue; fi
  if [ -n "$verb" ]; then following=$word; break; fi
  case "$word" in
    -C|-c|--git-dir|--work-tree|--namespace|--config-env) expect_value=1 ;;
    --) continue ;;
    -*) continue ;;
    *) verb=$word ;;
  esac
done
case "$verb" in
  clone|init) printf '%s\\n' 'Lease a Treehouse slot from the registered repository root; do not create an ad hoc checkout.' >&2; exit 1 ;;
  worktree) if [ "$following" = add ]; then printf '%s\\n' 'Lease a Treehouse slot from the registered repository root; do not create an ad hoc worktree.' >&2; exit 1; fi ;;
esac
exec "$real_git" "$@"
`;
  // The executable is fixed at creation time: an inherited PATH cannot redirect the delegate to this shim.
  writeFileAtomicIfChanged(join(bin, "git"), script, { mode: 0o700, durable: false });
  return `${bin}${delimiter}${path}`;
}
