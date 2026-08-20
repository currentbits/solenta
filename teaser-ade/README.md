# Solenta ADE teaser

25s digital-twin teaser of the live Solenta UI. New Remotion project. Does not reuse any prior trailer.

```bash
npm i
python3 scripts/make-score.py
npx remotion render SolentaTeaser out/solenta-teaser.mp4
```

Plates in `public/plates/` were captured from `VITE_TRAILER=1 npm run dev:browser` via `scripts/capture-screenshot.js`.

## Teaser 2

40s cut with the Pulse tab (usage, fleet, insights), memory, planboard and git beats. The score is assembled from GarageBand's Electro House Apple Loops (128 BPM, C minor); video cuts sit on the bar grid.

```bash
python3 scripts/make-score2.py
npx remotion render SolentaTeaser2 out/solenta-teaser-2.mp4
```

`scripts/eleven-score2.sh` generates an ElevenLabs music_v2 score with a
section plan matched to the same timeline — it needs a paid-plan key
(the Music API rejects free-tier keys). After generating, re-render.

If you have a paid ElevenLabs key with Music API access:

```bash
ELEVENLABS_API_KEY=sk_... bash scripts/eleven-score.sh
npx remotion render SolentaTeaser out/solenta-teaser.mp4
```
