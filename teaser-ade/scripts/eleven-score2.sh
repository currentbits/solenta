#!/bin/bash
# ElevenLabs music_v2 score for SolentaTeaser2, using a composition plan whose
# section lengths mirror the video's bar-grid cuts (bar 0 at 2.0s, 140 BPM):
#   0-2 intro | 2-8.86 pulse | 8.86-15.71 groove | 15.71-26 drive
#   26-29.43 breakdown (memory beat) | 29.43-36.29 peak | 36.29-40 outro
# Usage: ELEVENLABS_API_KEY=sk_... bash scripts/eleven-score2.sh [out.mp3]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/public/score2.mp3}"
: "${ELEVENLABS_API_KEY:?set ELEVENLABS_API_KEY}"

cat > /tmp/solenta-teaser2-music.json <<'JSON'
{
  "model_id": "music_v2",
  "composition_plan": {
    "positive_global_styles": [
      "minimal melodic techno",
      "sleek modern product film score",
      "deep pulsing analog synth bass",
      "tight crisp electronic drums",
      "futuristic and polished",
      "confident forward momentum",
      "140 bpm",
      "instrumental"
    ],
    "negative_global_styles": [
      "dubstep", "wobble bass", "cinematic braams", "epic orchestral trailer",
      "vocals", "lyrics", "choir", "cheesy EDM", "heavy distortion",
      "lo-fi", "rock guitars", "piano ballad"
    ],
    "sections": [
      {
        "section_name": "intro",
        "positive_local_styles": ["airy atmospheric pad", "soft rising shimmer", "quiet anticipation"],
        "negative_local_styles": ["drums", "bass"],
        "duration_ms": 3000,
        "lines": []
      },
      {
        "section_name": "pulse",
        "positive_local_styles": ["muted four-on-the-floor kick starts on a clean downbeat", "deep minimal synth bass pulse", "sparse restrained percussion"],
        "negative_local_styles": ["lead melody", "busy drums"],
        "duration_ms": 6857,
        "lines": []
      },
      {
        "section_name": "groove",
        "positive_local_styles": ["groove opens up", "crisp hi-hats", "hypnotic bass pulse", "subtle synth arpeggio enters"],
        "negative_local_styles": [],
        "duration_ms": 6857,
        "lines": []
      },
      {
        "section_name": "drive",
        "positive_local_styles": ["full driving groove", "bright analog arpeggio", "layered percussion", "steadily rising intensity"],
        "negative_local_styles": [],
        "duration_ms": 10286,
        "lines": []
      },
      {
        "section_name": "breakdown",
        "positive_local_styles": ["drums drop away", "warm suspended pad", "weightless and airy"],
        "negative_local_styles": ["kick drum", "percussion"],
        "duration_ms": 3429,
        "lines": []
      },
      {
        "section_name": "peak",
        "positive_local_styles": ["full groove slams back in", "euphoric analog lead", "maximum momentum", "hard clean downbeat"],
        "negative_local_styles": [],
        "duration_ms": 6857,
        "lines": []
      },
      {
        "section_name": "outro",
        "positive_local_styles": ["one clean final downbeat hit", "resolving warm chord", "long decay to silence"],
        "negative_local_styles": ["drums"],
        "duration_ms": 3714,
        "lines": []
      }
    ]
  }
}
JSON

# API minimum section length is 3000ms, so the plan is 41s with a 3s intro;
# trim the first second so the beat drop lands on the video's slam at 2.0s.
RAW=/tmp/solenta-teaser2-music-raw.mp3
curl -sS -X POST "https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/solenta-teaser2-music.json \
  -o "$RAW"

if head -c 3 "$RAW" | grep -q "ID3" || [ "$(head -c 2 "$RAW" | xxd -p)" = "fffb" ]; then
  ffmpeg -y -v error -ss 1.0 -t 40 -i "$RAW" -codec:a libmp3lame -b:a 192k "$OUT"
else
  cp "$RAW" "$OUT"
fi

python3 - <<PY
from pathlib import Path
p = Path("$OUT")
b = p.read_bytes()[:80]
if not (b.startswith(b"ID3") or b[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2")):
    raise SystemExit(p.read_text(errors="replace")[:600])
print("wrote", p, p.stat().st_size, "bytes")
PY
