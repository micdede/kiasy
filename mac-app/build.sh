#!/usr/bin/env bash
# Baut Jarvis.app aus dem Swift Package
set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="Jarvis"
BUILD_DIR=".build/release"
APP_BUNDLE="build/${APP_NAME}.app"

echo "→ Kompiliere Swift Package (Release)…"
swift build -c release

echo "→ Baue .app-Bundle…"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

cp "$BUILD_DIR/${APP_NAME}" "$APP_BUNDLE/Contents/MacOS/${APP_NAME}"
cp "Resources/Info.plist" "$APP_BUNDLE/Contents/Info.plist"

# Ad-hoc Code-Signatur (reicht für lokalen Gebrauch)
codesign --force --deep --sign - "$APP_BUNDLE"

echo ""
echo "✓ Fertig: $APP_BUNDLE"
echo ""
echo "Starten:        open $APP_BUNDLE"
echo "Installieren:   cp -r $APP_BUNDLE /Applications/"
