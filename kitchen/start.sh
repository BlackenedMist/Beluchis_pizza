#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

LOG="${LOG:-/tmp/beluchis-kitchen.log}"
PIDFILE="${PIDFILE:-.beluchis-kitchen.pid}"
PORT="${PORT:-3101}"

if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "Created .env from .env.example — edit SOURCE_BASE_URL, SOURCE_PIN and PRINTER_HOST, then run me again."
  exit 0
fi

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Kitchen printer daemon is already running (pid $(cat "$PIDFILE"))."
  echo "  Health: http://localhost:${PORT}/health"
  echo "  Log   : $LOG"
  exit 0
fi

setsid nohup node --env-file=.env index.mjs >"$LOG" 2>&1 &
PID=$!
echo "$PID" > "$PIDFILE"

for _ in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    echo "Kitchen printer daemon is running (pid $PID)."
    echo "  Health: http://localhost:${PORT}/health"
    echo "  Log   : $LOG"
    exit 0
  fi
  sleep 0.3
done

echo "Daemon did not become ready in time. Check the log: $LOG" >&2
exit 1