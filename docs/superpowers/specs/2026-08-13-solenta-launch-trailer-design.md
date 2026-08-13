# Solenta launch trailer (X post)

Date: 2026-08-13
Status: approved in conversation, pending implementation plan

## 1. Job

A 32-second, 1:1 launch film for an X post announcing Solenta.

One claim: **one window, every agent.** Before is five terminals. After is Solenta. The audience already knows Claude Code, Codex, Kimi, Grok, and OpenCode. The new thing is they live in one macOS desktop.

This is not a feature tour, a YouTube demo, or a website hero. Features that do not serve the claim stay out of the cut (memory, spend caps, automations, SSH, web mode, activity feed).

## 2. Locked decisions

| Decision | Choice |
|---|---|
| Destination | X launch post |
| Aspect | 1:1, 1080×1080 |
| Duration | 32s (960 frames at 30 fps) |
| Structure | A: terminals collapse into one window |
| Capture | Hybrid: recreated open/collapse/end, real recordings for the three proof beats |
| Audio | Music bed + whoosh + click ticks. No voiceover. Mute-first. |
| Product name | Solenta (not Coder) |
| Device | Desktop Mac window only. No phone frames. |

## 3. Beat sheet

| Time | Frames | Source | Picture | Type |
|---|---|---|---|---|
| 0:00–0:03 | 0–89 | Recreated | Five overlapping terminal windows (`claude`, `codex`, `kimi`, `grok`, `opencode`). Cursors still moving. | **Five terminals.** |
| 0:03–0:06 | 90–179 | Recreated | The five windows slam into one macOS frame. Solenta chrome resolves (sidebar, thread, agents). | none |
| 0:06–0:13 | 180–389 | Real `sidebar.mp4` | Push into the left pane. Five threads, five providers, live status. Selection hops once. | **One window.** |
| 0:13–0:23 | 390–689 | Real `pipeline.mp4` | Center work log streaming. Right Agents panel settling (phases, tokens, Stop). | **Every agent.** |
| 0:23–0:28 | 690–839 | Real `pr.mp4` | Active thread badges a PR number and Done. Other four providers stay visible in the sidebar. | none |
| 0:28–0:32 | 840–959 | Recreated | Hollow diamond, **Solenta**, one line under. Hold for the loop. | **Desktop control for coding agents.** |

First frame (paused X thumbnail) is the terminal stack. Last frame (loop poster) is the wordmark.

## 4. Visual system

- Canvas: `#0a0d13`. The Solenta window sits in the square with ~64px of that field around it. Soft vignette. No browser chrome, no 3D laptop, no floating glass.
- After the collapse, the camera stays inside that window.
- Type: Inter. Titles 72–88px, weight 600, `#e8ecf4`. End line 28px `#8b95a8`. Accent `#3b82f6` on the diamond stroke and one end-card underline.
- No gradients on type, no glow text, no em dashes, no “AI” particle fields, no stock b-roll, no feature-count lower thirds.
- Motion: Remotion `interpolate` + `Easing.bezier(0.16, 1, 0.3, 1)`. Collapse is the only hero move (~18 frames, five rects scale/translate into the window, slight overshoot). Real footage Ken Burns at 2–4%. Titles fade 8 frames in, 6 out.
- CSS transitions, CSS animations, and Tailwind animate classes are forbidden (they will not render).

## 5. Architecture

A separate Remotion package at `trailer/`. It does not add Remotion to the Electron app’s `package.json`. It does not import renderer components (those are timed for an interactive app, not a 30 fps film).

```
trailer/
  package.json
  src/Root.tsx                 Composition Launch: 1080×1080, 30fps, 960 frames
  src/Launch.tsx               <Sequence> timeline matching §3
  src/scenes/Terminals.tsx     Recreated five-CLI stack
  src/scenes/Collapse.tsx      Slam into one window
  src/scenes/EndCard.tsx       Diamond + Solenta
  src/scenes/Footage.tsx       <Video> + Ken Burns + title overlay
  public/footage/              sidebar.mp4, pipeline.mp4, pr.mp4
  public/audio/                bed, whoosh, click
  public/icon.svg              copy of assets/icon.svg
```

Recreated scenes are React + Remotion. Terminal chrome uses the product palette and a mono stack (SF Mono / JetBrains Mono). The end card uses `public/icon.svg`.

Real scenes are files. Remotion must not restyle those pixels except scale/translate (Ken Burns) and a title overlay.

Each footage scene falls back to a labeled placeholder of the same duration if the mp4 is missing, so the recreate halves can be timed and still-rendered without blocking on capture.

## 6. Shot list (real recordings)

Record the **actual Solenta renderer** (Vite `devCoder` with staged demo data, or Electron with simulate). Same window, three clips.

| File | Length | Must show |
|---|---|---|
| `sidebar.mp4` | ~8s | Left pane. Five threads whose providers are Claude, Codex, Kimi, Grok, OpenCode. One click changes selection. |
| `pipeline.mp4` | ~12s | Center work log appending. Right Agents panel with phases settling, token sum, Stop. Motion, not a still. |
| `pr.mp4` | ~6s | The active thread gains a PR number badge and Done. The other four provider threads remain in the sidebar. |

Capture at a size that crops cleanly to 1:1 (prefer a square window, or 16:9 with the three panes centered so a center crop keeps sidebar + agents). No mouse-jiggle, no notifications, no personal paths that should not ship.

Staging the five-provider sidebar may require a short demo-data fixture in `src/devCoder.ts` / mock data. That fixture is in scope if the current mock cannot show five providers at once. No other product behavior changes.

## 7. Audio

- One music bed under the full 32s, ducked ~2 dB during the three title cards so type still “reads” as the beat.
- Whoosh on the collapse (frames 90–120).
- Click tick on the sidebar selection hop.
- Files in `public/audio/`, referenced with `staticFile()`. Prefer `@remotion/media` `<Audio>`.
- License must allow a public X post. Do not ship uncleared commercial tracks.

## 8. Copy (final)

- Five terminals.
- One window.
- Every agent.
- Solenta
- Desktop control for coding agents.

No other on-screen sentences. No voiceover script.

## 9. Checks

- Remotion Studio for the cut.
- Still frames before calling it done: `--frame=0` (thumbnail), `90` (collapse), `240` (sidebar), `540` (pipeline), `870` (end).
- Final render: `npx remotion render Launch out/solenta-launch.mp4`.
- No `test:renderer` / `test:electron` changes unless the demo-data fixture requires them.

## 10. Out of scope

- 16:9 or 9:16 cuts
- Voiceover, captions-as-transcript, burned-in X UI
- Rebuilding Solenta’s React tree inside Remotion
- Showing memory, spend, automations, SSH, web mode, or activity
- Landing-page embed, Product Hunt cut, or a longer demo
- Adding Remotion to the root Electron install
