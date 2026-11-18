#!/usr/bin/env bash
# Builds a fresh self-contained cloudsound_999.app and zips it with install notes:
#   dist/cloudsound_999-mac.zip   (send via AirDrop, Drive, email, …)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
STAGE="$ROOT/dist/cloudsound_999"
ZIP="$ROOT/dist/cloudsound_999-mac.zip"

rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE"
"$HERE/build_app.sh" "$STAGE" >/dev/null
cp "$HERE/READ ME FIRST.txt" "$STAGE/"
# ditto keeps permissions, the code signature and extended attributes intact
ditto -c -k --sequesterRsrc --keepParent "$STAGE" "$ZIP"
rm -rf "$STAGE"
echo "Created $ZIP ($(du -h "$ZIP" | cut -f1))"
