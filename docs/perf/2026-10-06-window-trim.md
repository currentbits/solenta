# Transcript window stops trimming mid-soak (#1475)

Follow-up to `2026-10-06-renderer-heap.md` ("Intermittent pin loss"): in 2 of ~10 dev-server soaks the open transcript's tail window never trimmed again, and DOM climbed ~2k nodes per streamed answer, the pre-#1482 shape.

It is an app bug, not a harness artifact.

## Reproduction

Vite dev server plus headless Chromium (npx-cached playwright), with `main` + #1489 + #1490. The real big thread (fae77a0b, 1,055 messages) was seeded from a `/tmp` copy into devCoder, then streamed 180-character pushes into one answer. The harness patched the served `useStickToBottom.ts` to log every `stickToBottom` flip, and a capture-phase scroll listener logged the last scroll events and pins. A run counts as failed when the view ends more than 80 px from the bottom, which means it stopped following the stream.

The original 6 × 250-push soak trims only a few times per run, so it reproduces rarely: 2 of 13 runs on the first tries, then 0 of 12. Each trim is one chance for the race, so the rate matrix uses 30 short streams (40 pushes each). The 12 runs mix push intervals of 16 and 30 ms, 4× CPU throttling, a 900×600 window, a synthetic seed, and a switch away and back mid-stream.

| | Runs that lost the pin | `stickToBottom` flips |
|---|---|---|
| Before | **9 / 24** | 9, each a single scroll 97–156 px from the bottom |
| After | **0 / 24** | 0 |

## Root cause

Every flip had the same trace:

```
pin       st 28783  sh 29476            ← ResizeObserver pin, stuck
scrollev  st 28783  sh 29476  first=b036…
scrollev  st 15136  sh 16000  first=ed091…   → stickToBottom = false (distance 171)
```

1. A streamed push pushes the window over `TRANSCRIPT_CHAR_BUDGET`, so the render advances `windowStart` and the oldest entry unmounts (`first` changes, scrollHeight drops ~13k px).
2. With `overflow-anchor: none`, the next layout **clamps** scrollTop to the shorter body. A clamp is a scroll, so the browser queues a scroll event for the following frame.
3. Before that event is dispatched, the next push commits and grows the streaming answer by a few lines.
4. `onBodyScroll` measures the distance at dispatch time (171 px > `STICK_BOTTOM_PX`) and takes the clamp for the user scrolling up. `pinning` doesn't cover it, because the clamp is not one of our pins.
5. Unstuck, the render stops advancing the window (`stickToBottom.current ? Math.max(…) : windowStart`), and the ResizeObserver stops pinning. Nothing re-sticks without a user scroll, so the window grows for the rest of the session.

Ruled out by the traces: the #607 forceStick path, #1489's tail-first fill-in, and ResizeObserver pins. Every pin's scroll event landed inside its `pinning` window. Reading `stickToBottom.current` during render is only one render stale, so on its own it can't stop trimming for good.

## Fix

`useStickToBottom`: when `start` advances while stuck, `onBodyScroll` ignores scroll events for two frames. The clamp happens in the next frame's layout, and its event is dispatched in the frame after, before that frame's rAF callbacks. The ResizeObserver then pins as usual. The fix adds no layout read: a trim can come with any streamed push, and #1489's "one layout read per tail-only phase" test still holds. A user scroll-up within those two frames is dropped, and the next scroll event unsticks.

An earlier version forced layout in the effect so the clamp would happen inside a `pinning` window. That broke #1489's no-layout-read-per-push test, so it was dropped.

## Regression test

`test/threadView.test.tsx`, "stays stuck when a trim's scrollTop clamp lands after the tail grew". It holds rAF callbacks until a simulated frame runs, then appends to trigger a trim. It clamps scrollTop, grows the tail 200 px, and dispatches the clamp's scroll event. It then asserts that the next append still trims. It fails on the old hook.
