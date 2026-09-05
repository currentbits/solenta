#!/usr/bin/env bash
PID=$1
URL=http://127.0.0.1:5173/?view=usage
up() { curl -fsS -o /dev/null --max-time 5 "$URL"; }

until up; do
  kill -0 "$PID" 2>/dev/null || { echo "FAILED: preview pid $PID exited before listen"; exit 1; }
  sleep 2
done
echo "ACTION_REQUIRED: $URL is up"

while :; do
  sleep 5
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "FAILED: preview pid $PID exited"
    exit 1
  fi
  up || echo "ACTION_REQUIRED: $URL is down"
done
