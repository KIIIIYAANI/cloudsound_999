#!/usr/bin/env bash
# Builds the native cloudsound_999.app: a Swift/WebKit window (no browser needed) that
# starts and stops the bundled local server itself. Universal binary (Apple Silicon + Intel).
#
# The app carries its own copy of the code (Contents/Resources/cloudsound_999). Each user's
# settings, queue, Python virtualenv and log live in ~/Library/Application Support/cloudsound_999,
# so the .app can be copied to other Macs (see make_share_zip.sh).
#
# Usage: macapp/build_app.sh [destination folder]     (default: ~/Applications)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "$HERE/.." && pwd)"
DEST="${1:-$HOME/Applications}"
APP="$DEST/cloudsound_999.app"
VERSION="$(tr -d '[:space:]' < "$SRC/VERSION")"
MIN_OS="12.0"
mkdir -p "$DEST"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. compile the native shell for both architectures
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos$MIN_OS" -framework Cocoa -framework WebKit \
    "$HERE/main.swift" -o "$WORK/cloudsound_999-$arch"
done
lipo -create "$WORK/cloudsound_999-arm64" "$WORK/cloudsound_999-x86_64" -output "$WORK/cloudsound_999"

# 2. assemble the bundle
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$WORK/cloudsound_999" "$APP/Contents/MacOS/cloudsound_999"

CODE="$APP/Contents/Resources/cloudsound_999"
mkdir -p "$CODE"
rsync -a --exclude '.venv' --exclude '.state' --exclude 'server.log' --exclude '__pycache__' \
  --exclude 'macapp' --exclude 'dist' --exclude '.gitignore' --exclude '.DS_Store' --exclude '.git' --exclude 'docs' --exclude 'store' --exclude 'win' --exclude 'tests' --exclude '.github' --exclude 'run.bat' --exclude '.gitattributes' "$SRC/" "$CODE/"
chmod +x "$CODE/run.sh"

# 3. icon
python3 "$HERE/make_icon.py" "$WORK/icon_1024.png"
ICONSET="$WORK/AppIcon.iconset"; mkdir "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/icon_1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$WORK/icon_1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# 4. Info.plist
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>cloudsound_999</string>
  <key>CFBundleDisplayName</key><string>cloudsound_999</string>
  <key>CFBundleIdentifier</key><string>local.cloudsound999</string>
  <key>CFBundleExecutable</key><string>cloudsound_999</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>$MIN_OS</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.music</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Only download audio you have the rights to.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <!-- drop links on the Dock icon: web URLs, .webloc / .url shortcut files and text -->
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>Web link</string>
    <key>CFBundleURLSchemes</key><array><string>http</string><string>https</string></array>
  </dict></array>
  <key>CFBundleDocumentTypes</key><array><dict>
    <key>CFBundleTypeName</key><string>Web link</string>
    <key>CFBundleTypeRole</key><string>Viewer</string>
    <key>LSHandlerRank</key><string>Alternate</string>
    <key>LSItemContentTypes</key><array>
      <string>com.apple.web-internet-location</string><string>public.url</string>
      <string>com.microsoft.internet-shortcut</string><string>public.plain-text</string>
    </array>
  </dict></array>
  <key>NSServices</key><array><dict>
    <key>NSMenuItem</key><dict><key>default</key><string>Add to cloudsound_999 Queue</string></dict>
    <key>NSMessage</key><string>addLinks</string>
    <key>NSPortName</key><string>cloudsound_999</string>
    <key>NSRequiredContext</key><dict/>
    <key>NSSendTypes</key><array><string>public.utf8-plain-text</string><string>public.url</string></array>
  </dict></array>
</dict></plist>
EOF

touch "$APP"
codesign --force --deep -s - "$APP" 2>/dev/null || true   # ad-hoc signature (not notarized)
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true
/System/Library/CoreServices/pbs -update 2>/dev/null || true   # refresh the Services menu
echo "Built $APP ($(lipo -archs "$APP/Contents/MacOS/cloudsound_999"))"
