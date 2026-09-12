#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3100}"
LOG="${LOG:-/tmp/beluchis.log}"
PIDFILE="${PIDFILE:-.beluchis.pid}"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Beluchis is already running (pid $(cat "$PIDFILE"))."
  echo "  Menu  : http://localhost:${PORT}/"
  echo "  Admin : http://localhost:${PORT}/admin"
  exit 0
fi

PORT="$PORT" setsid nohup node --env-file=.env server/index.mjs >"$LOG" 2>&1 &
PID=$!
echo "$PID" > "$PIDFILE"

for _ in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT}/api/stats" >/dev/null 2>&1; then
    echo "Beluchis is running (pid $PID)."
    echo "  Menu  : http://localhost:${PORT}/"
    echo "  Admin : http://localhost:${PORT}/admin"
    echo "  Log   : $LOG"
    exit 0
  fi
  sleep 0.3
done

echo "Server did not become ready in time. Check the log: $LOG" >&2
exit 1