# Launchd coding-host — STAGED (no load)

Europe/London staging for t228u defaults. **Do not `launchctl bootstrap` / `enable` / `load` until Julen install Accept on the Flockmate widget.**

## Defaults locked (t228u)
1. Host = headless OMB server
2. Electron = client/off when host is on
3. Checkout = pinned tag (stage assumes `~/openmausbot-releases/0.2.0` — create/pin before load)
4. Herdr server under launchd too
5. Gate = after Ralph **DRAFT** (cleared by OpenMausBot #83) — still needs **install Accept** before KeepAlive load

## Artifacts
- `com.openmausbot.coding-host.plist`
- `com.openmausbot.herdr-server.plist`
- `dry-run.sh` — plutil lint + prints activate commands; never bootstraps

## Pre-load checklist (Accept-time)
1. Pin release: `mkdir -p ~/openmausbot-releases && git clone --depth 1 --branch <tag> git@github.com:evoclock/OpenMausBot.git ~/openmausbot-releases/<ver>` (or archive extract). Rewrite plist WorkingDirectory + script path if version ≠ 0.2.0.
2. Quit Electron OpenMausBot.app (single SQLite owner / lease).
3. Confirm Ralph #83 DRAFT still the gate you want (already cleared).
4. Run `./dry-run.sh` — must exit 0.
5. Only after Julen Accept: copy plists → `~/Library/LaunchAgents/` and `launchctl bootstrap gui/$(id -u) …`.

## Explicitly NOT done this stage
- No `launchctl load` / `bootstrap` / `kickstart`
- No copy into `~/Library/LaunchAgents/`
- No Electron quit
- No release checkout created yet (pin path is placeholder)
