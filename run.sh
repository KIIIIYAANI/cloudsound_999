#!/usr/bin/env bash
# cloudsound_999 launcher: ./run.sh   (set PORT=xxxx to change the port, NO_BROWSER=1 to skip opening it)
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-9990}"
# The Mac app keeps the virtualenv in the user's data folder (the .app bundle may be read-only).
VENV="${CS999_VENV:-$PWD/.venv}"

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then echo "python3 not found. Install it with: brew install python" >&2; exit 1; fi

if [ ! -x "$VENV/bin/python" ]; then
  echo "• creating virtualenv ($VENV)…"
  "$PY" -m venv "$VENV"
fi
if ! "$VENV/bin/python" -c "import fastapi, uvicorn" 2>/dev/null; then
  echo "• installing Python dependencies…"
  "$VENV/bin/pip" install -q -r requirements.txt
fi

for tool in yt-dlp ffmpeg; do
  if ! command -v "$tool" >/dev/null 2>&1 && [ ! -x "/opt/homebrew/bin/$tool" ] && [ ! -x "/usr/local/bin/$tool" ]; then
    echo "! $tool not found — install with: brew install $tool   (the app will show this too)"
  fi
done

URL="http://127.0.0.1:$PORT"
echo "• cloudsound_999 → $URL   (Ctrl+C to stop)"
if [ -z "${NO_BROWSER:-}" ] && command -v open >/dev/null; then (sleep 1.2; open "$URL") & fi
exec "$VENV/bin/python" -m uvicorn server:app --host 127.0.0.1 --port "$PORT" --log-level warning --timeout-graceful-shutdown 3
