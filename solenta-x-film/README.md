# Solenta film for X

A new 48-second trailer, 1600 × 1000 at 30 fps. Revised with fresh captures of the installed Nightly renderer, a full-frame opening, dark charcoal, restrained blue accents, the official Solenta logo, an original score, and captions for mute playback.

**Final video:** `out/solenta-x-trailer.mp4`  
**This review version:** `out/solenta-x-trailer-v3.mp4` (identical video, distinct filename)  
**Poster:** `out/solenta-poster.png`  
**Playback:** `out/index.html`

## Reproduce

Run from this directory, with the parent Solenta dependencies installed, `ffmpeg` / `ffprobe` on PATH, and the installed Nightly at `../out/Solenta Nightly.app/Contents/Resources/app`. Set `SOLENTA_FILM_APP` to another packaged app's Resources/app directory when needed. Its source revision must exist in the parent Git repository:

```sh
npm ci
npm run capture
npm run score
npm run lint
npm run render
npm run check
```

`npm run dev` opens Remotion Studio. `npm run preview:frames` renders the nine scene review frames.

## What is real

The UI plates are new 2x Electron captures of the **installed Solenta Nightly 0.19.0 distribution, revision `769984bf`**. The packaged JavaScript and CSS are loaded unchanged. This matters because the working checkout differs substantially from the installed build. The capture script uses the matching revision's demo API and the installed provider registry. `public/captures/provenance.json` records the build revision and hashes of the renderer, CSS, and every captured image. The video does not draw replacement interface controls or alter UI styling.

The repository, prompts, worker status, memories and diff are fresh **demonstration data**, supplied through an isolated in-memory API. They are not recordings of a real agent executing the example task. No personal sessions are read or altered. Each worker has a distinct example worktree. A separate hidden Electron renderer captures the views without desktop screen capture or attaching to the running app. A 2880 × 1600 render at 2x zoom preserves the app's 1440 × 800 layout with sharper pixels; the capture script asserts those layout dimensions.

Nothing was read or copied from the previous trailer / teaser projects. No previous footage, screenshots or soundtrack were reused. The official product logo is copied unchanged from `../assets/icon.svg`, as requested in the revision; it appears throughout, with larger placements in the opening and closing. The typography uses system Helvetica. `scripts/score.mjs` synthesizes the entire original stereo score with no samples, external music or voice cloning.

## Story

| Time | Message | Product evidence |
| --- | --- | --- |
| 0–3.6 | Your coding agents in one workspace | Entire installed app view, straight and uncropped |
| 3.6–7.2 | Shared context, less starting over | Continuous app overview |
| 7.2–12 | Open a repo and describe the task | Real composer, fresh prompt |
| 12–18 | Choose your agent | Real model picker, current provider registry |
| 18–25.2 | Share project memory | Real Memory tab with an expanded entry |
| 25.2–32.4 | Work in parallel | Real Agents team view |
| 32.4–39.6 | Review, check, and merge | Real Git review pane |
| 39.6–43.2 | Carry context forward | Shared-memory message |
| 43.2–48 | Try Solenta | solenta.app |

Feature claims were checked against the current repository README and owning source. The export uses H.264, yuv420p and stereo AAC, stays under the standard X duration and size limits, and uses 30 fps. Upload limits checked against [X video help](https://help.x.com/en/using-x/x-videos). Nothing is posted automatically.

`npm run check` verifies the installed renderer/CSS hashes, capture provenance and resolution, encoded streams, duration, frame count, size, complete decode, exact logo asset, and dark background across every frame. `out/validation.json` records the result. Visual review covers every scene; the original audio was measured at −18.1 dB mean and −2.4 dB peak before AAC encoding.

Earlier exports are preserved as `out/solenta-x-trailer-v1.mp4` (bright) and `out/solenta-x-trailer-v2.mp4` (dark, previous UI captures). The corrected video uses the main filename above.
