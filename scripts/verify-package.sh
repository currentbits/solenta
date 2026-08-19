#!/usr/bin/env bash
# verify-package.sh [bundle] — smoke-check a packaged .app (default
# out/Solenta.app; nightly builds are out/"Solenta Nightly".app).
# Invoked by package-app.sh (skip with --no-verify).
#
# Does NOT run --version: with Resources/app present and the binary renamed,
# Electron does not consume --version; the app boots against real userData.
# The isolated-userData boot probe is the real signal.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP="${1:-out/Solenta.app}"
# Binary is renamed Electron -> <bundle name> during packaging (app.isPackaged).
BIN="$APP/Contents/MacOS/$(basename "${APP%.app}")"
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

# Solenta Web (round 51): webBridge.js require("ws") must resolve in the
# packaged tree. Root node_modules is not shipped except explicit copies.
# cross-spawn is required at module load by agent.js / claude.js / etc.;
# missing it hangs boot (Electron dialog) and the /health probe times out.
APP_RES="$APP/Contents/Resources/app"
if [[ ! -f "$APP_RES/electron/webBridge.js" || ! -f "$APP_RES/electron/webServer.js" ]]; then
  echo "ERROR: packaged app missing electron/webBridge.js or webServer.js" >&2
  exit 1
fi
if [[ ! -d "$APP_RES/node_modules/ws" || ! -f "$APP_RES/node_modules/ws/package.json" ]]; then
  echo "ERROR: packaged app missing node_modules/ws (webBridge.js needs it)" >&2
  exit 1
fi
if [[ ! -d "$APP_RES/node_modules/cross-spawn" || ! -f "$APP_RES/node_modules/cross-spawn/package.json" ]]; then
  echo "ERROR: packaged app missing node_modules/cross-spawn (agent spawn needs it)" >&2
  exit 1
fi

# Install cleanup before any probe so the temp dir cannot leak.
TMP_USERDATA="$(mktemp -d "${TMPDIR:-/tmp}/solenta-pkg-verify.XXXXXX")"
ELECTRON_PID=""
# Kill the whole process group, not just the parent: the app's memory-server
# child (electron/memory-sup.js, detached:false) reparents to launchd the
# instant the parent dies, so a parent-then-`pgrep -P` sweep always finds
# nothing and leaks the server onto a temp db we then rm -rf (issue #99).
# `set -m` at launch gives the job its own pgid == ELECTRON_PID; the plain-pid
# kill is the fallback if that ever stops holding.
cleanup() {
  if [[ -n "${ELECTRON_PID}" ]]; then
    kill -TERM -"$ELECTRON_PID" 2>/dev/null || kill -TERM "$ELECTRON_PID" 2>/dev/null || true
    sleep 1
    kill -9 -"$ELECTRON_PID" 2>/dev/null || kill -9 "$ELECTRON_PID" 2>/dev/null || true
    wait "$ELECTRON_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_USERDATA"
}
trap cleanup EXIT

# Isolate the memory-server process from the user's real Application Support tree.
# memory-server resolves config via CODER_MEMORY_CONFIG ?? ~/Library/.../memory-server.json;
# on first create it also defaults dbPath under that real root. Pre-write a config whose
# dbPath lives under TMP_USERDATA, and force CODER_MEMORY_CONFIG to that file so the
# packaged probe cannot adopt or write the live db.
CONFIG_FILE="$TMP_USERDATA/memory-server.json"
DB_FILE="$TMP_USERDATA/memory.db"
# Random free-ish port in the same range the server uses (49500-49999).
PORT="$((49500 + RANDOM % 500))"
TOKEN="$(openssl rand -hex 32 2>/dev/null || node -p "require('crypto').randomBytes(32).toString('hex')")"
node -e '
  const fs = require("fs");
  const cfg = {
    port: Number(process.argv[1]),
    token: process.argv[2],
    dbPath: process.argv[3],
  };
  fs.writeFileSync(process.argv[4], JSON.stringify(cfg, null, 2));
' "$PORT" "$TOKEN" "$DB_FILE" "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE" 2>/dev/null || true
echo "verify: boot probe (userData=$TMP_USERDATA)"
echo "  isolated config: $CONFIG_FILE (port=$PORT dbPath=$DB_FILE)"

LOG="$TMP_USERDATA/boot.log"
# Headless-ish boot: real binary, temp userData only (never real userData).
# CODER_MEMORY_CONFIG forces the memory-server child (and any default-path reader)
# onto the isolated config; --user-data-dir keeps Electron userData in TMP too.
set +e
set -m  # job control: put the probe in its own process group so cleanup can kill the tree
ELECTRON_ENABLE_LOGGING=1 \
  CODER_MEMORY_CONFIG="$CONFIG_FILE" \
  SOLENTA_SKIP_USERDATA_MIGRATION=1 \
  "$BIN" --user-data-dir="$TMP_USERDATA" \
  >"$LOG" 2>&1 &
ELECTRON_PID=$!
set +m
set -e

# Assert the group kill in cleanup() has something to aim at. Loud now beats
# six orphaned memory-servers found two days later.
APP_PGID="$(ps -o pgid= -p "$ELECTRON_PID" 2>/dev/null | tr -d ' ')"
if [[ "$APP_PGID" != "$ELECTRON_PID" ]]; then
  echo "ERROR: boot probe is not its own process group leader (pid=$ELECTRON_PID pgid=${APP_PGID:-<none>})" >&2
  echo "  cleanup() would leak the memory-server child; check 'set -m' above" >&2
  exit 1
fi

# Wait up to 10s for the process to stay alive and for /health on the isolated port.
DEADLINE=$((SECONDS + 10))
while (( SECONDS < DEADLINE )); do
  if ! kill -0 "$ELECTRON_PID" 2>/dev/null; then
    echo "ERROR: packaged app exited during boot probe. Log:" >&2
    cat "$LOG" >&2 || true
    exit 1
  fi
  if curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! kill -0 "$ELECTRON_PID" 2>/dev/null; then
  echo "ERROR: packaged app exited during boot probe. Log:" >&2
  cat "$LOG" >&2 || true
  exit 1
fi
echo "  process alive (pid $ELECTRON_PID)"
echo "  memory-server.json present: $CONFIG_FILE"

# Wait until /health is reachable with ok:true (up to 10s more).
HEALTH_OK=0
HEALTH_DEADLINE=$((SECONDS + 10))
LAST_BODY=""
while (( SECONDS < HEALTH_DEADLINE )); do
  set +e
  LAST_BODY="$(curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null)"
  CURL_EC=$?
  set -e
  if [[ $CURL_EC -eq 0 && -n "$LAST_BODY" ]]; then
    if node -e '
      const h = JSON.parse(process.argv[1]);
      if (h.ok !== true) process.exit(2);
    ' "$LAST_BODY" 2>/dev/null; then
      HEALTH_OK=1
      break
    fi
  fi
  sleep 0.5
done

if [[ "$HEALTH_OK" -ne 1 ]]; then
  echo "ERROR: /health did not report ok:true within budget" >&2
  echo "  last body: ${LAST_BODY:-<empty>}" >&2
  echo "--- boot log ---" >&2
  cat "$LOG" >&2 || true
  exit 1
fi
echo "  /health ok:true"
echo "  health body (first): $LAST_BODY"

# Isolation hard-assert: the probe MUST have opened the isolated db under
# TMP_USERDATA. This would have caught the live-db writes a round ago.
# /health no longer echoes dbPath (it must not leak it), so ask the OS which
# file the server actually has open instead.
DB_HOLDERS="$(lsof -t -- "$DB_FILE" 2>/dev/null || true)"
if [[ ! -s "$DB_FILE" || -z "$DB_HOLDERS" ]]; then
  echo "ERROR: isolation broken — nothing has the isolated db open" >&2
  echo "  expected db: $DB_FILE ($([[ -s "$DB_FILE" ]] && echo present || echo missing/empty))" >&2
  echo "  holders: ${DB_HOLDERS:-<none>}" >&2
  echo "  health body: $LAST_BODY" >&2
  exit 1
fi
echo "  isolation ok: $DB_FILE open by pid(s) $(echo "$DB_HOLDERS" | tr '\n' ' ')"

# node -p inspect-colors numbers when FORCE_COLOR is set, which turns
# BEFORE_COUNT into "\e[33m0\e[39m" and Number() → NaN. Write a raw string.
BEFORE_COUNT="$(node -e 'const h=JSON.parse(process.argv[1]); const n=(h.vectors && typeof h.vectors.count==="number")?h.vectors.count:0; process.stdout.write(String(n))' "$LAST_BODY")"
echo "  BEFORE_COUNT=$BEFORE_COUNT"

# Seed one entry so fire-and-forget embed must import transformers, load the
# model (~25MB first-boot download possible), run inference, and write a vector.
# Poll until vectors.count > BEFORE_COUNT (delta form; empty isolated db → count>=1).
SEED_MARKER="pkg-verify-embed-$(date +%s)-$$"
set +e
STORE_BODY="$(curl -fsS --max-time 5 \
  -X POST "http://127.0.0.1:${PORT}/api/store" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "content-type: application/json" \
  -d "{\"type\":\"knowledge\",\"title\":\"Package verify embed probe\",\"body\":\"${SEED_MARKER} unique probe body for vector backfill\",\"force\":true}" \
  2>/dev/null)"
STORE_EC=$?
set -e
if [[ $STORE_EC -ne 0 || -z "$STORE_BODY" ]]; then
  echo "ERROR: POST /api/store failed (ec=$STORE_EC)" >&2
  echo "  body: ${STORE_BODY:-<empty>}" >&2
  echo "--- boot log ---" >&2
  cat "$LOG" >&2 || true
  exit 1
fi
echo "  POST /api/store -> $STORE_BODY"

COUNT_OK=0
# 180s budget: first-boot downloads ~25MB MiniLM weights into a FRESH temp
# userData every verify run, so this wait is network-bound each time; 30s
# flaked on a busy connection (release cut 2026-08-14).
COUNT_DEADLINE=$((SECONDS + 180))
while (( SECONDS < COUNT_DEADLINE )); do
  set +e
  LAST_BODY="$(curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null)"
  CURL_EC=$?
  set -e
  if [[ $CURL_EC -eq 0 && -n "$LAST_BODY" ]]; then
    if node -e '
      const h = JSON.parse(process.argv[1]);
      const before = Number(process.argv[2]);
      if (h.ok !== true) process.exit(2);
      if (!h.vectors || typeof h.vectors.count !== "number") process.exit(3);
      if (!(h.vectors.count > before)) process.exit(4);
    ' "$LAST_BODY" "$BEFORE_COUNT" 2>/dev/null; then
      COUNT_OK=1
      break
    fi
  fi
  sleep 0.5
done

if [[ "$COUNT_OK" -ne 1 ]]; then
  echo "ERROR: /health vectors.count did not increase above BEFORE_COUNT=$BEFORE_COUNT within 180s after store" >&2
  echo "  (first-boot model download ~25MB may need more time, or embed path is broken)" >&2
  echo "  last health body: ${LAST_BODY:-<empty>}" >&2
  echo "--- boot log ---" >&2
  cat "$LOG" >&2 || true
  exit 1
fi
AFTER_COUNT="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).vectors.count))' "$LAST_BODY")"
echo "  AFTER_COUNT=$AFTER_COUNT (was BEFORE_COUNT=$BEFORE_COUNT)"
echo "  /health vectors.count increased (embed path live)"
echo "  health body (post-seed): $LAST_BODY"

echo "verify: OK"
