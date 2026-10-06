# Renderer heap growth during a streaming soak (#1475)

Follow-up to `2026-10-06-end-to-end.md` §5: after #1482 the open transcript's DOM stays flat (~13k nodes) across a six-stream soak, but the JS heap still went 40.8 → 52.7 MB.

## Method

- **Bundle:** a development-mode build with production React: `NODE_ENV=production vite build --mode development` with `import.meta.env.DEV` forced on, so devCoder stays in. It ran in headless Chromium (playwright 1.63). No Electron was launched and the live data dir wasn't touched.
- **Seed:** the real 3.3 MB, 1,055-message thread `fae77a0b`, read from PM3's frozen snapshot and injected into devCoder.
- **Streams:** each answer is ~38 KB of PM2's markdown parts. It's pushed as real `thread:updated` patches (`messagesFrom` tails) through the renderer's own listener, 80 pushes per answer.
- **Sampling:** `HeapProfiler.collectGarbage` ×3, then `Runtime.getHeapUsage`, `Memory.getDOMCounters`, and heap snapshots at streams 0/6/12 (also 0/3/6). Snapshots were diffed by constructor, by stable node id, and by "retained only through X" reachability.

## Retainers

| Retainer | Growth | Bounded? | Action |
|---|---|---|---|
| `IntersectionObserver` (auto-animate `observePosition`, created from its debounced `updatePos` timer after the row left the DOM), root = `document.documentElement`, kept by Blink's `IntersectionObserverController`. It pins the detached sidebar card / shelf / shelf toggle and its listeners. | +1 observer, +38 DOM nodes, +5 listeners per stream; 4–5 per status flip in the dev server | **No.** It lives for the whole session, one per status change. | **Fixed** (`skipDetachedObserve`): every leaked observer was created on an already-detached target (14/14), so `observe()` skips detached targets. |
| V8 compiled code (`InstructionStream`, `TrustedByteArray`, `Code`) | ~1.1 MB s3→s6, ~1.6 MB s6→s12, in steps (tier-up) | Settles | None |
| Streamed answer strings in `detail.messages` | ~38 KB per answer | Is the transcript | None |
| `threadDetailCache` | 0 during the soak (it replaces the open entry) | Yes: 8 entries / 8 M chars | Stays |
| `provenance.ts` `toolRefCache` / `messageCache` | 0 | WeakMaps keyed by message objects | Stays |
| `MarkdownChunk` memo / `markdownParses` | 0 (a counter only) | Freed with unmount | Stays |
| PathLinks `cacheRef` | 0 here (the soak repeats the same paths) | Per distinct path string; small | Stays |
| Fiber alternates, `patchSeqRef` | 0 | Yes | Stays |
| `PerformanceMeasure` (Blink user-timing buffer) | ~3 MB per stream | **No, but React development builds only** (React 19.2 performance tracks); the production bundle has no `performance.measure` | None: it affects `npm run dev` sessions only |

## Numbers (12 streams, real thread, production React)

| After stream | 0 | 3 | 6 | 9 | 12 |
|---|---|---|---|---|---|
| BEFORE heap MB | 26.96 | 28.40 | 29.78 | 31.59 | 31.87 |
| AFTER heap MB | 22.68 | 24.09 | 25.44 | 27.23 | 27.48 |
| BEFORE DOM nodes / listeners | 6,669 / 294 | 10,569 / 1,104 | 10,683 / 1,119 | 10,797 / 1,134 | 10,911 / 1,149 |
| AFTER DOM nodes / listeners | 6,669 / 294 | 10,455 / 1,089 | 10,455 / 1,089 | 10,455 / 1,089 | 10,455 / 1,089 |
| live `IntersectionObserver`s, BEFORE → AFTER (s0 / s12) | 12 / 24 → 12 / 12 | | | | |

- **Stream-0 gap:** the 4.3 MB lower AFTER heap at stream 0 is a harness artifact: devCoder's backend map held an extra copy of the seed in that run. It is not credited to the fix.
- **Heap after stream 8:** it grows +0.08–0.15 MB per stream, which is the answer text, counted twice (devCoder's backend copy plus the renderer's).
- **DOM:** stream 0 → 3 is the tail window filling to `TRANSCRIPT_CHAR_BUDGET`, then it is flat.

## Not reproduced / risks

- **Electron's +12 MB:** the end-to-end run's +12 MB at streams 2–3 doesn't reproduce in the browser, where the same window fill costs ~1.5 MB. The paths I couldn't exercise without launching Electron are the preload bridge, real runner patches and a 2,000-row thread list. The leaked observers retain only ~0.3 MB per 12 streams here; with the real sidebar each detached row is bigger.
- **Renderer RSS** (295 → 416 MB) is Chromium allocator, layout and GPU memory, not JS heap. PM2's `vmmap` already showed a malloc zone of only 21 MB.
- **Intermittent pin loss:** in 2 of ~10 dev-server runs, the transcript window never trimmed: nodes climbed ~2k per stream, exactly the pre-#1482 shape. The likely cause is the stick-to-bottom pin being lost (`useStickToBottom` / `ThreadView` window start). It is not addressed here.
- **Prototype patch:** the fix patches `IntersectionObserver.prototype.observe` app-wide. auto-animate is the only user. A future user that observes an element before inserting it would silently get no callbacks.
