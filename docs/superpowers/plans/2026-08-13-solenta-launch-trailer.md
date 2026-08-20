# Solenta X Launch Trailer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a 32-second 1080×1080 Remotion film at `trailer/` that opens on five terminals, slams into Solenta, proves the real UI with three recordings, and ends on the wordmark.

**Architecture:** Separate Remotion package. Recreated scenes (terminals, collapse, end card) are React + `interpolate`. Proof beats are `<Video>` files captured from the real Vite renderer. A `VITE_TRAILER=1` seed in `devCoder.ts` assigns the five providers and keeps the working-thread workflow ticking so the recordings show motion. Remotion never imports `src/` components.

**Tech Stack:** Remotion 4, React 19, `@remotion/media`, `@remotion/google-fonts`, `@remotion/sfx`, Electron offscreen capture, ffmpeg, Node test runner.

## Global Constraints

- Composition: `Launch`, 1080×1080, 30 fps, 960 frames (32s).
- Product name is Solenta. Copy is exactly: `Five terminals.` / `One window.` / `Every agent.` / `Solenta` / `Desktop control for coding agents.`
- No em dashes. No voiceover. No phone frames. No CSS/Tailwind animations.
- Motion: `interpolate` + `Easing.bezier(0.16, 1, 0.3, 1)`. Collapse is the only hero move (~18 frames). Footage Ken Burns 2–4%.
- Palette: bg `#0a0d13`, text `#e8ecf4`, muted `#8b95a8`, blue `#3b82f6`.
- Titles: Inter 600, 72–88px, ≥80px from sides, ≥100px from top/bottom.
- Do not add Remotion to the root Electron `package.json`.
- Do not change product behavior unless `import.meta.env.VITE_TRAILER === "1"`.
- Music must be original or clearly licensed for a public X post.

## File map

- Create: `trailer/` Remotion app (see Task 1)
- Create: `trailer/src/beats.ts` timeline constants
- Create: `trailer/src/beats.test.ts`
- Create: `trailer/src/theme.ts` colors, copy, easing
- Create: `trailer/src/fonts.ts` Inter load
- Create: `trailer/src/TitleCard.tsx`
- Create: `trailer/src/scenes/Terminals.tsx`
- Create: `trailer/src/scenes/Collapse.tsx`
- Create: `trailer/src/scenes/EndCard.tsx`
- Create: `trailer/src/scenes/Footage.tsx`
- Create: `trailer/src/Launch.tsx`
- Create: `trailer/src/Root.tsx` (replace scaffold)
- Create: `scripts/capture-trailer.js`
- Create: `trailer/public/icon.svg` (copy of `assets/icon.svg`)
- Create: `trailer/public/audio/bed.wav` (generated)
- Create: `trailer/public/footage/{sidebar,pipeline,pr}.mp4` (captured)
- Modify: `src/devCoder.ts` trailer seed only
- Modify: `.gitignore` (`trailer/out`, `trailer/node_modules`)
- Test: `trailer/src/beats.test.ts` plus existing `test/devCoder*.test.ts` if the seed is touched

---

### Task 1: Scaffold Remotion + timeline constants

**Files:**
- Create: `trailer/` via official scaffold
- Create: `trailer/src/beats.ts`
- Create: `trailer/src/beats.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces: `BEATS`, `FPS`, `WIDTH`, `HEIGHT`, `TOTAL_FRAMES`, `BeatName`

- [ ] **Step 1: Write the failing test**

Create `trailer/src/beats.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BEATS, TOTAL_FRAMES } from "./beats.ts";

describe("beats", () => {
  it("sums to 960 frames", () => {
    const sum = Object.values(BEATS).reduce((n, b) => n + b.durationInFrames, 0);
    assert.equal(sum, 960);
    assert.equal(TOTAL_FRAMES, 960);
  });

  it("starts each beat where the previous ends", () => {
    let cursor = 0;
    for (const beat of Object.values(BEATS)) {
      assert.equal(beat.from, cursor);
      cursor += beat.durationInFrames;
    }
    assert.equal(cursor, 960);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd trailer && node --experimental-strip-types --test src/beats.test.ts`
Expected: FAIL, cannot find `./beats.ts`

- [ ] **Step 3: Scaffold and implement constants**

```bash
cd "$(git rev-parse --show-toplevel)"
npx create-video@latest --yes --blank --no-tailwind trailer
```

If the scaffold names the folder differently, move it to `trailer/`. Then write `trailer/src/beats.ts`:

```ts
export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1080;
export const TOTAL_FRAMES = 960;

export type BeatName =
  | "terminals"
  | "collapse"
  | "sidebar"
  | "pipeline"
  | "pr"
  | "end";

export type Beat = {
  name: BeatName;
  from: number;
  durationInFrames: number;
};

export const BEATS: Record<BeatName, Beat> = {
  terminals: { name: "terminals", from: 0, durationInFrames: 90 },
  collapse: { name: "collapse", from: 90, durationInFrames: 90 },
  sidebar: { name: "sidebar", from: 180, durationInFrames: 210 },
  pipeline: { name: "pipeline", from: 390, durationInFrames: 300 },
  pr: { name: "pr", from: 690, durationInFrames: 150 },
  end: { name: "end", from: 840, durationInFrames: 120 },
};
```

Append to `.gitignore` if missing:

```
trailer/node_modules/
trailer/out/
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd trailer && node --experimental-strip-types --test src/beats.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add .gitignore trailer/package.json trailer/package-lock.json trailer/tsconfig.json trailer/remotion.config.ts trailer/src/beats.ts trailer/src/beats.test.ts trailer/src/index.ts
git commit -m "feat(trailer): scaffold remotion and lock the 32s beat sheet"
```

---

### Task 2: Theme, fonts, title card

**Files:**
- Create: `trailer/src/theme.ts`
- Create: `trailer/src/fonts.ts`
- Create: `trailer/src/TitleCard.tsx`

**Interfaces:**
- Consumes: nothing
- Produces: `colors`, `COPY`, `EASE`, `fontFamily` from `loadFont`, `<TitleCard text />`

- [ ] **Step 1: Install font package**

```bash
cd trailer && npx remotion add @remotion/google-fonts
```

- [ ] **Step 2: Write theme + fonts + title**

`trailer/src/theme.ts`:

```ts
export const colors = {
  bg: "#0a0d13",
  text: "#e8ecf4",
  muted: "#8b95a8",
  blue: "#3b82f6",
  card: "#171d29",
  border: "#2a3242",
  terminal: "#0c1018",
};

export const COPY = {
  terminals: "Five terminals.",
  window: "One window.",
  agents: "Every agent.",
  name: "Solenta",
  tag: "Desktop control for coding agents.",
} as const;

export const EASE = [0.16, 1, 0.3, 1] as const;
```

`trailer/src/fonts.ts`:

```ts
import { loadFont } from "@remotion/google-fonts/Inter";

export const { fontFamily } = loadFont("normal", {
  weights: ["500", "600", "700"],
  subsets: ["latin"],
});
```

`trailer/src/TitleCard.tsx`:

```tsx
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { fontFamily } from "./fonts";
import { colors, EASE } from "./theme";

export const TitleCard: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 8, 9999, 10000], [0, 1, 1, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(...EASE),
  });
  const fadeOut = interpolate(frame, [0, 1], [1, 1]);
  const hold = interpolate(frame, [0, 10000], [1, 1]);
  const out = interpolate(frame, [Math.max(0, 10000)], [1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  void fadeOut;
  void hold;
  void out;
  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 120,
        opacity,
      }}
    >
      <div
        style={{
          fontFamily,
          fontSize: 80,
          fontWeight: 600,
          color: colors.text,
          letterSpacing: "-0.03em",
          textAlign: "center",
          textShadow: "0 8px 40px rgba(0,0,0,0.65)",
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};
```

Replace the stub fade-out with a real end fade: the parent Sequence duration is known, so fade 8 in / 6 out using `useVideoConfig()` duration:

```tsx
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { fontFamily } from "./fonts";
import { colors, EASE } from "./theme";

export const TitleCard: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fadeIn = interpolate(frame, [0, 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(...EASE),
  });
  const fadeOut = interpolate(
    frame,
    [durationInFrames - 6, durationInFrames],
    [1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );
  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 120,
        opacity: fadeIn * fadeOut,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          fontFamily,
          fontSize: 80,
          fontWeight: 600,
          color: colors.text,
          letterSpacing: "-0.03em",
          textAlign: "center",
          textShadow: "0 8px 40px rgba(0,0,0,0.65)",
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};
```

Use this second `TitleCard` implementation, not the stub.

- [ ] **Step 3: Commit**

```bash
git add trailer/src/theme.ts trailer/src/fonts.ts trailer/src/TitleCard.tsx trailer/package.json trailer/package-lock.json
git commit -m "feat(trailer): product palette, Inter, and title card"
```

---

### Task 3: Recreated scenes (terminals, collapse, end card)

**Files:**
- Create: `trailer/src/scenes/Terminals.tsx`
- Create: `trailer/src/scenes/Collapse.tsx`
- Create: `trailer/src/scenes/EndCard.tsx`
- Create: `trailer/public/icon.svg` (copy `assets/icon.svg`)

**Interfaces:**
- Consumes: `colors`, `COPY`, `EASE`, `fontFamily`, `TitleCard`
- Produces: `<Terminals />`, `<Collapse />`, `<EndCard />`

- [ ] **Step 1: Copy the icon**

```bash
cp assets/icon.svg trailer/public/icon.svg
```

- [ ] **Step 2: Write Terminals.tsx**

Five overlapping terminal windows. Local-frame cursor blink. Title `Five terminals.`

Agents in this order, top-left to bottom-right: `claude`, `codex`, `kimi`, `grok`, `opencode`.

Each window: 620×360, `#0c1018` fill, `#2a3242` 1px border, 10px radius, 28px traffic-light title bar, SF Mono 22px body (`$ claude` etc plus two dim log lines). Positions (px from a 1080 canvas):

```
claude    left 40  top 80
codex     left 280 top 200
kimi      left 140 top 360
grok      left 420 top 480
opencode  left 80  top 620
```

Cursor opacity: `frame % 20 < 12 ? 1 : 0.15`.

- [ ] **Step 3: Write Collapse.tsx**

Same five rects. Over 18 frames they interpolate `left/top/width/height` into a single centered window 952×952 (64px inset). Slight overshoot via `Easing.bezier(0.16, 1, 0.3, 1)`. After frame 18, draw a three-pane chrome inside the window (300 / flex / 380 scaled into 952) using empty panels in product colors so the smash reads as Solenta, not a blank card.

- [ ] **Step 4: Write EndCard.tsx**

Centered column (`flex`, `gap: 28`, `justifyContent: center`): `<Img src={staticFile("icon.svg")} />` 180px, then `Solenta` 88px 600, then a 64×2 `#3b82f6` underline, then the tag 28px `#8b95a8`. Fade in 12 frames.

- [ ] **Step 5: Still-check the recreate halves**

After Task 4 wires Root, render:

```bash
cd trailer
npx remotion still Launch --frame=0 --scale=0.25 out/still-0.png
npx remotion still Launch --frame=90 --scale=0.25 out/still-90.png
npx remotion still Launch --frame=870 --scale=0.25 out/still-870.png
```

Expected: exit 0. Frame 0 is the terminal stack. Frame 90 is mid-collapse. Frame 870 is the wordmark.

- [ ] **Step 6: Commit**

```bash
git add trailer/src/scenes trailer/public/icon.svg
git commit -m "feat(trailer): recreate terminals, collapse, and end card"
```

---

### Task 4: Footage scene, Launch timeline, audio

**Files:**
- Create: `trailer/src/scenes/Footage.tsx`
- Create: `trailer/src/Launch.tsx`
- Create: `trailer/src/mediaExists.ts`
- Modify: `trailer/src/Root.tsx`
- Create: `trailer/public/audio/bed.wav`

**Interfaces:**
- Consumes: `BEATS`, `TitleCard`, scene components
- Produces: `<Launch />` composition, `mediaExists(path)` used by Footage

- [ ] **Step 1: Write mediaExists + Footage**

`trailer/src/mediaExists.ts`:

```ts
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function mediaExists(publicRel: string): boolean {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return existsSync(path.join(here, "..", "public", publicRel));
}
```

`Footage.tsx`: if `mediaExists(\`footage/${name}.mp4\`)` is false, render a `#171d29` panel with the filename in muted type. If true, `<Video src={staticFile(...)} muted />` with `objectFit: "cover"` and `objectPosition` (`left center` for sidebar/pr, `center center` for pipeline). Ken Burns: scale 1.00 → 1.03 over the sequence via inline `interpolate` on `scale`. Overlay `<TitleCard />` when `title` is set. Always `volume={0}` / `muted`.

- [ ] **Step 2: Write Launch.tsx**

```tsx
<AbsoluteFill style={{ background: colors.bg }}>
  <Sequence premountFor={30} from={BEATS.terminals.from} durationInFrames={BEATS.terminals.durationInFrames}>
    <Terminals />
  </Sequence>
  <Sequence premountFor={30} from={BEATS.collapse.from} durationInFrames={BEATS.collapse.durationInFrames}>
    <Collapse />
  </Sequence>
  <Sequence premountFor={30} from={BEATS.sidebar.from} durationInFrames={BEATS.sidebar.durationInFrames}>
    <Footage name="sidebar" objectPosition="left center" title={COPY.window} />
  </Sequence>
  <Sequence premountFor={30} from={BEATS.pipeline.from} durationInFrames={BEATS.pipeline.durationInFrames}>
    <Footage name="pipeline" objectPosition="center center" title={COPY.agents} />
  </Sequence>
  <Sequence premountFor={30} from={BEATS.pr.from} durationInFrames={BEATS.pr.durationInFrames}>
    <Footage name="pr" objectPosition="left center" />
  </Sequence>
  <Sequence premountFor={30} from={BEATS.end.from} durationInFrames={BEATS.end.durationInFrames}>
    <EndCard />
  </Sequence>
  <Audio src={staticFile("audio/bed.wav")} volume={(f) => titleDuck(f)} />
  <Sequence from={90} durationInFrames={30} layout="none">
    <Audio src="https://remotion.media/whoosh.wav" volume={0.45} />
  </Sequence>
  <Sequence from={240} durationInFrames={15} layout="none">
    <Audio src="https://remotion.media/mouse-click.wav" volume={0.35} />
  </Sequence>
</AbsoluteFill>
```

`titleDuck(f)`: 0.55 during frames 0–89, 180–389, 390–689; 0.75 elsewhere; fade 0→0.75 over first 12 frames and 0.75→0 over last 20.

Install `@remotion/media` if the scaffold did not: `npx remotion add @remotion/media`.

Root.tsx:

```tsx
import { Composition } from "remotion";
import { Launch } from "./Launch";
import { FPS, HEIGHT, TOTAL_FRAMES, WIDTH } from "./beats";

export const RemotionRoot = () => (
  <Composition
    id="Launch"
    component={Launch}
    durationInFrames={TOTAL_FRAMES}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
  />
);
```

- [ ] **Step 3: Generate an original 32s bed**

```bash
mkdir -p trailer/public/audio
ffmpeg -y \
  -f lavfi -i "sine=frequency=55:sample_rate=44100:duration=32" \
  -f lavfi -i "sine=frequency=82.4:sample_rate=44100:duration=32" \
  -f lavfi -i "sine=frequency=110:sample_rate=44100:duration=32" \
  -filter_complex "[0]volume=0.18[a];[1]volume=0.07,tremolo=f=0.25:d=0.4[b];[2]volume=0.05,lowpass=f=300[c];[a][b][c]amix=inputs=3:normalize=0,afade=t=in:st=0:d=0.5,afade=t=out:st=30:d=2" \
  trailer/public/audio/bed.wav
```

This is original (generated), safe to post.

- [ ] **Step 4: Still placeholders**

```bash
cd trailer
npx remotion still Launch --frame=240 --scale=0.25 out/still-240.png
npx remotion still Launch --frame=540 --scale=0.25 out/still-540.png
```

Expected: exit 0. Frames show the labeled placeholder until Task 6 drops real mp4s.

- [ ] **Step 5: Commit**

```bash
git add trailer/src trailer/public/audio/bed.wav
git commit -m "feat(trailer): launch timeline, footage fallback, and audio bed"
```

---

### Task 5: Trailer-only demo seed

**Files:**
- Modify: `src/devCoder.ts` (`seedThreads`, `seedDetail`, `DEV_PROVIDERS` grok.available, run-state `kind`)
- Test: existing renderer tests that construct `devCoder`

**Interfaces:**
- Consumes: `import.meta.env.VITE_TRAILER`
- Produces: when `VITE_TRAILER === "1"`: five threads mapped Claude / Codex / Kimi / Grok / OpenCode; grok `available: true`; thread-1 still runs the simulate workflow ticker so the pipeline shot moves

- [ ] **Step 1: Run the current renderer tests (baseline)**

```bash
npm run test:renderer
```

Expected: pass (current baseline). Do not proceed if red.

- [ ] **Step 2: Add the trailer gate**

Near the top of `src/devCoder.ts` (after imports):

```ts
const TRAILER = import.meta.env.VITE_TRAILER === "1";
const TRAILER_PROVIDERS = ["claude", "codex", "kimi", "grok", "opencode"] as const;
```

In `DEV_PROVIDERS`, when building the grok entry, set `available: TRAILER ? true : false` (today it is hardcoded `false`).

In `seedThreads`, replace the provider ternary:

```ts
provider: TRAILER
  ? TRAILER_PROVIDERS[index] ?? "claude"
  : isSimulate
    ? "simulate"
    : index % 3 === 0
      ? "codex"
      : "claude",
```

In `seedDetail`, keep default behavior. When `TRAILER` and `thread.id === mockData.activeThreadId`, force `workflow: seedWorkflowMidRun()` and usage as the simulate usage so the Agents panel is populated even though the row says Claude Code.

Where run-state `kind` is assigned (`t.provider === "simulate" ? "simulate" : "session"`), use:

```ts
kind:
  t.provider === "simulate" ||
  (TRAILER && t.id === mockData.activeThreadId)
    ? "simulate"
    : "session",
```

Do not change any other seed (pin, snooze, unread).

- [ ] **Step 3: Re-run renderer tests**

```bash
npm run test:renderer
```

Expected: same pass count as Step 1. `VITE_TRAILER` is unset in tests.

- [ ] **Step 4: Commit**

```bash
git add src/devCoder.ts
git commit -m "feat: trailer seed shows five providers without changing default mock"
```

---

### Task 6: Capture the three real clips

**Files:**
- Create: `scripts/capture-trailer.js`
- Create: `trailer/public/footage/sidebar.mp4`
- Create: `trailer/public/footage/pipeline.mp4`
- Create: `trailer/public/footage/pr.mp4`

**Interfaces:**
- Consumes: Vite on `:5173` with `VITE_TRAILER=1`
- Produces: three H.264 mp4s, 1680×1050, 30 fps

- [ ] **Step 1: Write `scripts/capture-trailer.js`**

Electron offscreen window 1680×1050 (three panes stay visible; 1080px wide would trip the 900px single-pane container). Load `http://127.0.0.1:5173`, wait 4s, remove `[data-web-token-gate]`.

Shots, in order:

1. `sidebar` — 8.0s. After 1.5s, click the second visible `[data-thread-id]` (or the thread-2 button). Capture 240 JPEG frames at ~30 fps via `capturePage`.
2. `pipeline` — 12.0s. Click thread-1 first so the working simulate workflow is on screen. Capture 360 frames.
3. `pr` — 6.0s. Stay on thread-1 (already has PR 842). If a Done/PR badge is already visible, hold. Capture 180 frames.

Write frames to `os.tmpdir()/solenta-trailer/<shot>/0001.jpg`. Then:

```
ffmpeg -y -framerate 30 -i %04d.jpg -c:v libx264 -pix_fmt yuv420p -crf 18 trailer/public/footage/<shot>.mp4
```

Exit non-zero if any shot writes fewer than 80% of expected frames.

If thread rows do not have `data-thread-id`, click by visible title text via `document.evaluate` / `querySelector` on the sidebar. Inspect `Sidebar.tsx` and use whatever selector already exists (`data-thread`, button title, etc.) rather than adding product attributes unless none exist.

- [ ] **Step 2: Record**

```bash
VITE_TRAILER=1 npx vite --port 5173 --strictPort
# in another shell, after vite prints Local:
npx electron scripts/capture-trailer.js
```

Expected: three mp4s under `trailer/public/footage/`, each playable (`ffprobe` shows h264, duration within 1s of target).

- [ ] **Step 3: Re-still the footage beats**

```bash
cd trailer
npx remotion still Launch --frame=240 --scale=0.25 out/still-240.png
npx remotion still Launch --frame=540 --scale=0.25 out/still-540.png
npx remotion still Launch --frame=780 --scale=0.25 out/still-780.png
```

Expected: real Solenta UI, not the placeholder panel.

- [ ] **Step 4: Commit**

```bash
git add scripts/capture-trailer.js trailer/public/footage/*.mp4
git commit -m "feat(trailer): capture real Solenta proof beats"
```

---

### Task 7: Final render and visual check

**Files:**
- Create: `trailer/out/solenta-launch.mp4` (gitignored)
- Modify: none required

**Interfaces:**
- Consumes: complete Launch composition
- Produces: 32s 1080×1080 mp4

- [ ] **Step 1: Render**

```bash
cd trailer
npx remotion render Launch out/solenta-launch.mp4
```

Expected: exit 0. `ffprobe` reports ~32s, 1080x1080, audio present.

- [ ] **Step 2: Inspect stills at the spec frames**

Frames 0, 90, 240, 540, 870. Confirm:
- 0: five terminals + “Five terminals.”
- 90: collapse in motion
- 240: real sidebar, five providers, “One window.”
- 540: real pipeline, “Every agent.”
- 870: diamond + Solenta + tag

If a frame fails the read (type too small, crop cuts a pane, placeholder still showing), fix that scene and re-render. Do not claim done from Studio alone.

- [ ] **Step 3: Commit any scene fixes**

```bash
git add trailer/src
git commit -m "fix(trailer): correct frames that failed the still check"
```

Only if something changed. If the render was clean, skip.

---

## Self-review (spec coverage)

| Spec section | Task |
|---|---|
| 32s / 1080 / 30 / 960 | Task 1 |
| Beat sheet timings + copy | Tasks 1, 2, 4 |
| Visual system / motion / no CSS anim | Tasks 2–4 |
| `trailer/` package, no root Remotion | Task 1 |
| Recreated terminals / collapse / end | Task 3 |
| Footage + placeholder | Task 4 |
| Audio bed, whoosh, click, ducking | Task 4 |
| Five-provider seed, no default-mock change | Task 5 |
| Three real recordings 1680×1050 | Task 6 |
| Still frames + final render | Task 7 |
| Out of scope (16:9, VO, memory, etc.) | not implemented |

No TBD. Names (`BEATS`, `COPY`, `TRAILER`, `Launch`) are consistent across tasks.
