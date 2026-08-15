# Solenta launch trailer

32s, 1920×1080 Remotion film for the X launch post.

```bash
cd trailer
npm i
npm run dev          # Remotion Studio
npx remotion render Launch out/solenta-launch.mp4
```

Recapture the three real-UI beats (requires Vite with the trailer seed):

```bash
# from repo root
VITE_TRAILER=1 npm run dev:browser   # in the repo root
npx electron scripts/capture-trailer.js
```

Composition `Launch` is 960 frames at 30 fps. Spec: `docs/superpowers/specs/2026-08-13-solenta-launch-trailer-design.md`.
