#!/usr/bin/env bash
# verify-package.sh — smoke-check a packaged out/Coder.app.
# Invoked by package-app.sh (skip with --no-verify).
#
# Does NOT run --version: with Resources/app present and the binary renamed,
# Electron does not consume --version; the app boots against real userData.
# The 6s isolated-userData boot probe is the real signal.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP="out/Coder.app"
# Binary is renamed Electron -> Coder during packaging (app.isPackaged).
BIN="$APP/Contents/MacOS/Coder"
if [[ ! -f "$BIN" && -f "$APP/Contents/MacOS/Electron" ]]; then
  BIN="$APP/Contents/MacOS/Electron"
fi

if [[ ! -x "$BIN" ]]; then
  if [[ -f "$BIN" ]]; then
    chmod +x "$BIN"
  else
    echo "ERROR: packaged binary missing: $BIN" >&2
    exit 1
  fi
fi

# Install cleanup before any probe so the temp dir cannot leak.
TMP_USERDATA="$(mktemp -d "${TMPDIR:-/tmp}/coder-pkg-verify.XXXXXX")"
ELECTRON_PID=""
cleanup() {
  if [[ -n "${ELECTRON_PID}" ]] && kill -0 "$ELECTRON_PID" 2>/dev/null; then
    kill "$ELECTRON_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$ELECTRON_PID" 2>/dev/null || true
    wait "$ELECTRON_PID" 2>/dev/null || true
  fi
  if [[ -n "${ELECTRON_PID}" ]]; then
    for cpid in $(pgrep -P "$ELECTRON_PID" 2>/dev/null || true); do
      kill -9 "$cpid" 2>/dev/null || true
    done
  fi
  rm -rf "$TMP_USERDATA"
}
trap cleanup EXIT

LOG="$TMP_USERDATA/boot.log"
echo "verify: 6s boot probe (userData=$TMP_USERDATA)"
# Headless-ish boot: real binary, temp userData only (never real userData).
# ELECTRON_RUN_AS_NODE must not be set; we want the real app.
set +e
ELECTRON_ENABLE_LOGGING=1 \
  "$BIN" --user-data-dir="$TMP_USERDATA" \
  >"$LOG" 2>&1 &
ELECTRON_PID=$!
set -e

sleep 6

if ! kill -0 "$ELECTRON_PID" 2>/dev/null; then
  echo "ERROR: packaged app exited within 6s. Log:" >&2
  cat "$LOG" >&2 || true
  exit 1
fi
echo "  process alive (pid $ELECTRON_PID)"

# Memory-server config under temp userData, or a literal "continuing without memory" log.
CONFIG_HIT=0
if find "$TMP_USERDATA" -name 'memory-server.json' 2>/dev/null | grep -q .; then
  CONFIG_HIT=1
  echo "  memory-server.json present under userData"
elif grep -q 'continuing without memory' "$LOG" 2>/dev/null; then
  CONFIG_HIT=1
  echo "  continuing without memory log present"
fi

if [[ "$CONFIG_HIT" -eq 0 ]]; then
  echo "ERROR: no memory-server config under userData and no continuing-without-memory log" >&2
  echo "--- boot log ---" >&2
  cat "$LOG" >&2 || true
  echo "--- userData tree ---" >&2
  find "$TMP_USERDATA" -maxdepth 3 2>/dev/null >&2 || true
  exit 1
fi

echo "verify: OK"
