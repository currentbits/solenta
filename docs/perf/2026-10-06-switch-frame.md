# Big-thread switch frame (#1475)

PM3 left the switch to the largest thread at ~147 ms, all in one ~135 ms frame. This round profiles that frame and removes most of it.

## Method

- **Bundle:** a production React build (`vite build --mode perf`, so `NODE_ENV=production`), served by `vite preview`. Because #1486 drops devCoder from `MODE=production`, a scratch patch (not committed) did three things:
  - forced `devBuild.isDev()` to true;
  - loaded the real `fae77a0b` transcript (3.3 MB, 1,055 messages, read-only copy of its shard) into devCoder's `thread-2`;
  - seeded `thread-4` with a small 24-message, 74 KB thread.
- **Driver:** headless Chromium (npx-cached Playwright 1.63), 1440×900. No Electron, no copy of the data dir.
- **Switch time:** from the sidebar click to the first frame where the target's last message is in the DOM and the old thread's is not.
- **Longest frame:** the largest rAF gap within 1 s of the click. LoAF entries were also recorded.
- **Full window:** the time until the mounted message count stops changing.
- **Runs:** each is the median of 5.
  - "Re-switch" happens after both threads were opened once.
  - "First open" is the first open after a page reload, with a cold markdown cache.
- **Attribution:** CDP CPU profiles at 100 µs sampling, mapped through the build's sourcemaps. The mean of 5 profiles was bucketed by the first matching frame up the stack.

This harness runs faster than the real app: there is no 2,000-row sidebar, no IPC, and no Electron. Its "before" is 55–60 ms against PM3's 147 ms. Compare the ratios, not the absolute numbers.

## Frame breakdown, before (`8b4bcc71`)

| | Re-switch (≈75 ms busy) | First open (≈113 ms busy) |
|---|---|---|
| Markdown parse (micromark/mdast/hast → JSX) | **32.7** | **50.6** |
| Stick-to-bottom pin (`scrollHeight` read, i.e. the layout of the new window) | 10.0 | 12.9 |
| React reconcile/commit | 7.8 | 10.1 |
| GC | 6.5 | 12.1 |
| Style/layout/paint outside JS | 6.5 | 12.1 |
| Path links (`findPathRefs`, `PathText`) | 4.0 | 5.4 |
| Provenance/annotations | 2.1 | 2.6 |
| devCoder clone (stands in for IPC) | 1.7 | 2.2 |
| Timeline build/collapse, localStorage, boot snapshot | <0.5 | <0.5 |

The tail window of this thread holds two 34–36 KB answers far above the fold. Each one is a ~20 ms parse, while the screen itself shows a 3.7 KB answer and tool groups. Provenance and the detail-cache `setItem` (PM2's 48 ms and 17 ms) are no longer in the frame.

## Changes

1. **`c4ca6c72` Parsed-markdown LRU.** react-markdown's `Markdown()` is a pure function of the text, so its element tree is cached (400k chars total) and mounted again on the next switch. The live tail of a streaming reply isn't cached.
2. **`e0f85612` Tail first.** The first render of a thread mounts the last 8k chars of message text.
   - After paint, the deferred answers are parsed into the cache, one per `requestIdleCallback` (100 ms timeout). The rest of the window then mounts in a `startTransition`.
   - If the tail doesn't fill the pane, everything mounts before paint, so nothing visibly grows.
   - `useStickToBottom` pins before paint when entries mount above a stuck view.
   - Show earlier and jump-to-message mount the full window at once.

Tried and dropped: `content-visibility: auto` on transcript entries gave no measurable change, because the collapsed tool groups are cheap to lay out. It would also make scroll-up jump, because the body sets `overflow-anchor: none`.

## Results (median of 5, ms)

| | Before | Cache only | Both |
|---|---|---|---|
| Big re-switch | 55 (frame 53, LoAF 53) | 27 (frame 27) | **11** (frame 19, full window at 93) |
| Big first open | 78 (frame 73, LoAF 73) | 70 (frame 66) | **16** (frame 22, full window at 103) |
| Small switch | 11.6 (frame 17) | 10.7 (frame 17) | **7.5** (frame 17) |

- **Long frames:** none over 24 ms in any run after the change, against one 53–101 ms LoAF per big switch before.
- **Pin:** the gap to the bottom is 0 px, both in the switch frame and after the full window mounts.
- **Variance:** an earlier "before" session measured 60 / 106 ms for big re-switch / first open.

After the change, the remaining ~25 ms of re-switch work is:
- pin layout 8.7 ms;
- React 4.8 ms;
- paint 4.3 ms;
- path links 3.9 ms;
- GC 2.3 ms.

The deferred full-window commit is a ~19–22 ms frame.

## Risks

- **Memory:** the cache keeps up to 400k chars of parsed element trees. Heap use wasn't measured.
- **The ~100 ms before the full window mounts:** answers above the 8k tail are not in the DOM yet. That affects find-in-page and an immediate scroll-up. The Show earlier count is higher during that time; clicking it mounts the full window.
- **Small threads:** threads over 8k chars also go tail first. That costs one extra render after paint, with no measured cost.
- **Electron timing:** `requestIdleCallback` timing in Electron under load is untested. The 100 ms timeout bounds it.
- **Re-measure:** the real app should be re-measured in PM3's Electron setup to confirm the gain against 147 ms.
