#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PIDFILE="${PIDFILE:-.beluchis.pid}"

if [ ! -f "$PIDFILE" ]; then
  echo "No PID file ($PIDFILE) found — nothing to stop."
  exit 0
fi

PID="$(cat "$PIDFILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  # Give it a moment, then force-kill if still alive.
  for _ in $(seq 1 20); do
    if ! kill -0 "$PID" 2>/dev/null; then
      rm -f "$PIDFILE"
      echo "Beluchis stopped (pid $PID)."
      exit 0
    fi
    sleep 0.2
  done
  kill -9 "$PID" 2>/dev/null || true
fi

rm -f "$PIDFILE"
echo "Beluchis stopped (pid $PID)."