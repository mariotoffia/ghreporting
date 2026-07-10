#!/usr/bin/env bash
# scripts/make-app.sh — wrap the compiled binary (dist/ghreporting) in a
# double-clickable dist/GH Reporting.app. No signing/notarization (ADR 0010):
# first launch is right-click → Open. Run by `make package-app` after `make package`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/dist/ghreporting"
APP="$ROOT/dist/GH Reporting.app"
MACOS="$APP/Contents/MacOS"

[ -f "$BIN" ] || { echo "missing $BIN — run 'make package' first" >&2; exit 1; }

rm -rf "$APP"
mkdir -p "$MACOS"
cp "$BIN" "$MACOS/ghreporting"

# The bundle's executable: start the server, open the browser once, then wait so
# the app stays alive (and thus killable from the Dock/Force-Quit) for its lifetime.
cat > "$MACOS/launcher" <<'LAUNCHER'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
GHR_PACKAGED=1 "$DIR/ghreporting" &
sleep 1 && open "http://localhost:8787"
wait
LAUNCHER
chmod +x "$MACOS/launcher" "$MACOS/ghreporting"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIdentifier</key><string>se.toffia.ghreporting</string>
  <key>CFBundleName</key><string>GH Reporting</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# Self-smoke: the three files that make the bundle launchable must all exist.
test -f "$MACOS/ghreporting"
test -f "$MACOS/launcher"
test -f "$APP/Contents/Info.plist"
echo "built $APP"
