#!/usr/bin/env bash
# Builds a release of cloudsound_999 into dist/release-<version>/:
#   cloudsound_999-<v>.dmg          disk image: drag the app to Applications
#   cloudsound_999-<v>-mac.zip      the same app as a zip (AirDrop / email friendly)
#   cloudsound_999-<v>-source.zip   source, for running with ./run.sh on any OS with Python
#   SHA256SUMS.txt                  checksums for all of the above
#   RELEASE_NOTES.md                this version's notes from CHANGELOG.md
# The app is ad-hoc signed, not notarized (that needs a paid Apple Developer account),
# so recipients approve it once in System Settings → Privacy & Security → Open Anyway.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
V="$(tr -d '[:space:]' < "$ROOT/VERSION")"
NAME="cloudsound_999"
OUT="$ROOT/dist/release-$V"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

rm -rf "$OUT"; mkdir -p "$OUT"

# 1. the app
APPDIR="$WORK/app"; mkdir -p "$APPDIR"
"$HERE/build_app.sh" "$APPDIR" >/dev/null
APP="$APPDIR/$NAME.app"
codesign --verify --deep "$APP"

# 2. disk image: app + Applications shortcut + read-me
DMGSRC="$WORK/dmg"; mkdir -p "$DMGSRC"
ditto "$APP" "$DMGSRC/$NAME.app"
ln -s /Applications "$DMGSRC/Applications"
cp "$HERE/READ ME FIRST.txt" "$DMGSRC/"
hdiutil create -quiet -volname "$NAME $V" -srcfolder "$DMGSRC" -fs HFS+ -format UDZO -imagekey zlib-level=9 \
  -ov "$OUT/$NAME-$V.dmg"

# 3. zip of the app + read-me
ZIPSRC="$WORK/zip/$NAME"; mkdir -p "$ZIPSRC"
ditto "$APP" "$ZIPSRC/$NAME.app"
cp "$HERE/READ ME FIRST.txt" "$ZIPSRC/"
(cd "$WORK/zip" && ditto -c -k --sequesterRsrc --keepParent "$NAME" "$OUT/$NAME-$V-mac.zip")

# 4. source zip (no virtualenvs, runtime state, logs or build output)
SRCSTAGE="$WORK/src/$NAME-$V"; mkdir -p "$SRCSTAGE"
rsync -a --exclude '.venv' --exclude '.state' --exclude 'server.log' --exclude '__pycache__' \
  --exclude 'dist' --exclude '.DS_Store' --exclude '.git' "$ROOT/" "$SRCSTAGE/"
(cd "$WORK/src" && zip -qr -X "$OUT/$NAME-$V-source.zip" "$NAME-$V")

# 5. notes + checksums
awk -v v="$V" '$0 ~ "^## " v {p=1; print; next} /^## / && p {exit} p' "$ROOT/CHANGELOG.md" > "$OUT/RELEASE_NOTES.md"
[ -s "$OUT/RELEASE_NOTES.md" ] || { echo "CHANGELOG.md has no '## $V' section" >&2; exit 1; }
(cd "$OUT" && shasum -a 256 "$NAME-$V.dmg" "$NAME-$V-mac.zip" "$NAME-$V-source.zip" > SHA256SUMS.txt)

echo "Release $V → $OUT"
(cd "$OUT" && ls -lh | awk 'NR>1 {print "  " $5 "\t" $9}')
