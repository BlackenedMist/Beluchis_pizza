#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3101}"
LOG="${LOG:-/tmp/beluchis-kitchen.log}"
PIDFILE="${PIDFILE:-.beluchis-kitchen.pid}"

if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "Created .env from .env.example — check the PIN and website address, then run me again."
  exit 0
fi

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Kitchen bridge is already running (pid $(cat "$PIDFILE"))."
  echo "  Open : http://localhost:${PORT}/"
  echo "  Log  : $LOG"
  exit 0
fi

PORT="$PORT" setsid nohup node --env-file=.env server.mjs >"$LOG" 2>&1 &
PID=$!
echo "$PID" > "$PIDFILE"

for _ in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT}/api/status" >/dev/null 2>&1; then
    echo "Kitchen bridge is running (pid $PID)."
    echo "  Open : http://localhost:${PORT}/"
    echo "  Log  : $LOG"
    exit 0
  fi
  sleep 0.3
done

echo "Server did not become ready in time. Check the log: $LOG" >&2
exit 1