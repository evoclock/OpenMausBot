#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "== plutil lint =="
plutil -lint "$DIR/com.openmausbot.coding-host.plist"
plutil -lint "$DIR/com.openmausbot.herdr-server.plist"
echo
echo "== pin path check (expected missing until Accept) =="
PIN=$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$DIR/com.openmausbot.coding-host.plist")
if [[ -d "$PIN" ]]; then
  echo "PIN OK: $PIN"
else
  echo "PIN MISSING (expected pre-Accept): $PIN"
fi
echo
echo "== would activate AFTER Julen Accept (NOT run) =="
UID_NUM=$(id -u)
cat <<ACT
mkdir -p "$HOME/Library/Logs/openmausbot" "$HOME/Library/LaunchAgents"
# 1) create pinned checkout at WorkingDirectory
# 2) quit Electron OpenMausBot.app
cp "$DIR/com.openmausbot.herdr-server.plist" "$HOME/Library/LaunchAgents/"
cp "$DIR/com.openmausbot.coding-host.plist" "$HOME/Library/LaunchAgents/"
launchctl bootstrap "gui/$UID_NUM" "$HOME/Library/LaunchAgents/com.openmausbot.herdr-server.plist"
launchctl bootstrap "gui/$UID_NUM" "$HOME/Library/LaunchAgents/com.openmausbot.coding-host.plist"
launchctl print "gui/$UID_NUM/com.openmausbot.herdr-server" | head
launchctl print "gui/$UID_NUM/com.openmausbot.coding-host" | head
ACT
echo
echo "== currently loaded? (read-only) =="
launchctl print "gui/$UID_NUM/com.openmausbot.coding-host" 2>&1 | head -5 || true
launchctl print "gui/$UID_NUM/com.openmausbot.herdr-server" 2>&1 | head -5 || true
launchctl print "gui/$UID_NUM/com.openmausbot.serve" 2>&1 | head -5 || true
echo
echo "DRY-RUN OK — nothing bootstrapped."
