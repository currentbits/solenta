# Solenta ADE teaser

25s digital-twin teaser of the live Solenta UI. New Remotion project. Does not reuse any prior trailer.

```bash
npm i
python3 scripts/make-score.py
npx remotion render SolentaTeaser out/solenta-teaser.mp4
```

Plates in `public/plates/` were captured from `VITE_TRAILER=1 npm run dev:browser` via `scripts/capture-screenshot.js`.

If you have a paid ElevenLabs key with Music API access:

```bash
ELEVENLABS_API_KEY=sk_... bash scripts/eleven-score.sh
npx remotion render SolentaTeaser out/solenta-teaser.mp4
```
