#!/bin/bash
# Swap in an ElevenLabs music_v2 instrumental once the key has Music API access.
# Usage: ELEVENLABS_API_KEY=sk_... bash scripts/eleven-score.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/score.mp3"
: "${ELEVENLABS_API_KEY:?set ELEVENLABS_API_KEY}"

PROMPT='Action-packed 25-second cinematic trailer score for a dark developer-tool product launch. INSTRUMENTAL ONLY, no vocals, no choir, no lyrics. Hybrid industrial cinematic trailer: deep sub-bass, tight cinematic drums, metallic percussion, dark analog synth pulse, 140 BPM. Hard hits at 0.0s, 2.0s, 6.0s, 10.0s, 14.5s, 18.5s and 23.0s. Final punch at 23s, clean decay to silence at 25s. Dark, expensive, aggressive, precise. No pop, no piano ballad, no cheesy EDM drop.'

BODY=$(python3 -c 'import json,os; print(json.dumps({"prompt":os.environ["PROMPT"],"music_length_ms":25000,"model_id":"music_v2","force_instrumental":True}))')
PROMPT="$PROMPT" python3 - <<'PY' > /tmp/solenta-teaser-music.json
import json, os
print(json.dumps({
  "prompt": os.environ["PROMPT"],
  "music_length_ms": 25000,
  "model_id": "music_v2",
  "force_instrumental": True,
}))
PY

curl -sS -X POST "https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/solenta-teaser-music.json \
  -o "$OUT"

python3 - <<PY
from pathlib import Path
p = Path("$OUT")
b = p.read_bytes()[:80]
if not (b.startswith(b"ID3") or b[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2")):
    raise SystemExit(p.read_text(errors="replace")[:600])
print("wrote", p, p.stat().st_size, "bytes")
PY
