#!/usr/bin/env bash
set -euo pipefail
CACHE="${CACHE:-$HOME/Library/Caches/solenta-speech-spike}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$CACHE/macos-metal/nemo-speech/bin/nemo-speech"
MODEL="$CACHE/nemotron-speech-streaming-en-0.6b.q8_0.gguf"
WAV="$CACHE/audio/phrase-16k.wav"
LONG="$CACHE/audio/long-16k.wav"
OUT="$CACHE/runs"
mkdir -p "$OUT"
PORT="${PORT:-18080}"
TOKEN="${TOKEN:-$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')}"
echo "$TOKEN" > "$OUT/token.txt"
echo "$PORT" > "$OUT/port.txt"

if [[ ! -x "$BIN" || ! -f "$MODEL" || ! -f "$WAV" ]]; then
  echo "missing binary/model/wav" >&2
  exit 1
fi

echo "=== serve ==="
"$BIN" serve \
  --host 127.0.0.1 --port "$PORT" --api-key "$TOKEN" --no-ui \
  --asr-model "$MODEL" --device metal \
  --read-timeout 600 --write-timeout 600 \
  >"$OUT/serve.log" 2>&1 &
echo $! > "$OUT/serve.pid"
pid=$(cat "$OUT/serve.pid")
echo "serve pid $pid port $PORT"

(
  while kill -0 "$pid" 2>/dev/null; do
    rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    echo "$(date +%s),${rss:-0}" >> "$OUT/rss.csv"
    sleep 1
  done
) &
echo $! > "$OUT/rss.pid"

echo "waiting for /ready"
for i in $(seq 1 180); do
  if python3 - <<PY
import urllib.request, sys
try:
    urllib.request.urlopen("http://127.0.0.1:${PORT}/ready", timeout=2)
except Exception:
    sys.exit(1)
PY
  then
    python3 - <<PY
import urllib.request
print(urllib.request.urlopen("http://127.0.0.1:${PORT}/ready", timeout=5).read().decode())
PY
    echo "ready after ${i}s"
    break
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "serve died" >&2
    tail -80 "$OUT/serve.log" >&2
    exit 1
  fi
  sleep 1
  if [[ "$i" -eq 180 ]]; then
    echo "ready timeout" >&2
    tail -80 "$OUT/serve.log" >&2
    exit 1
  fi
done

echo "=== live realtime phrase ==="
node "$ROOT/spike/speech/live-client.mjs" \
  --url "ws://127.0.0.1:${PORT}/v1/realtime" \
  --token "$TOKEN" \
  --wav "$WAV" \
  --pace realtime \
  --out "$OUT/live-phrase.json" | tee "$OUT/live-phrase.summary.json"

echo "=== rtf 300s max-pace ==="
node "$ROOT/spike/speech/live-client.mjs" \
  --url "ws://127.0.0.1:${PORT}/v1/realtime" \
  --token "$TOKEN" \
  --wav "$LONG" \
  --pace max \
  --loop-seconds 300 \
  --settle-ms 20000 \
  --out "$OUT/rtf-300.json" | tee "$OUT/rtf-300.summary.json"

python3 - <<PY
from pathlib import Path
p = Path("$OUT/rss.csv")
vals = []
for line in p.read_text().splitlines():
    parts = line.split(",")
    if len(parts) == 2 and parts[1].isdigit():
        vals.append(int(parts[1]))
kb = max(vals) if vals else 0
print(f"peak_rss_kb={kb} peak_rss_mb={kb/1024:.1f} samples={len(vals)}")
Path("$OUT/rss-peak.txt").write_text(f"{kb}\n")
PY
