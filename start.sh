#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
PORT=${PORT:-8000}
URL="http://localhost:$PORT"

if lsof -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "Port $PORT already in use — opening existing instance."
  open "$URL"
  exit 0
fi

echo "→ posture-check on $URL  (Ctrl+C to stop)"
( sleep 0.5 && open "$URL" ) &
exec python3 -m http.server "$PORT"
