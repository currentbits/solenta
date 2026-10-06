# Renderer heap growth in Electron (#1475)

Follow-up to `2026-10-06-end-to-end.md` §5 and `2026-10-06-renderer-heap.md`. PM3's six-stream soak into the open big thread raised the renderer JS heap 40.8 → 52.7 MB and RSS 295 → 416 MB peak in Electron, while headless Chromium grew ~1.5 MB. This run repeats the soak in Electron on `fd43e867` (main with #1489 and #1490), takes heap snapshots and memory dumps, and extends it to 30 streams.

## Conclusion

- **The unbounded growth is the transcript tail window losing its stick-to-bottom pin.** Once it is lost, the window never trims again. Every streamed answer then stays mounted: +5.7k DOM nodes, +3.6 MB JS heap, +6 MB Oilpan and ~+11 MB physical footprint per stream, for the rest of the session. One 30-stream run reached 154 MB heap, 175k nodes and a 482 MB footprint.
  - The cause is a race between a trim's scrollTop clamp and the next streamed push; see `2026-10-06-window-trim.md` for the browser reproduction.
  - It's fixed in #1491 (thread adb0e3), which this run measured in Electron.
  - Base builds lost the pin in 2 of 3 Electron soaks (streams 10 and ~23). The #1491 build kept it in 2 of 2 (60 streams).
- **Fixed here:** when a window start falls past the end of the timeline, it now resets through `tailWindowStart` instead of to the last 120 entries. When the store's retention cap drops ~100 messages from the front, an unpinned or scrolled-up window start lands past the shorter timeline. The count-only reset then mounted +48k nodes in one push (base control, stream 23).
- **Everything else that grows is bounded and settles by stream 3–6:**
  - the first-push transcript copy (transient);
  - the markdown parse cache (at its 400k-char budget);
  - V8 code tier-up;
  - the streamed text itself (~0.03 MB per answer).

  With the pin held, the JS heap is flat at 39–46 MB from stream 6 to 30, and the physical footprint is flat at 141–149 MB.
- **PM3's "+12 MB" was stream 0 → 3 with the pin held.** It's the full-transcript first push (one extra ~4 MB transcript copy, released by stream 6), plus the parse cache filling (+2.6 MB), plus code (+0.9 MB, then +2.5 MB by stream 6). None of it grows past stream 6.
- **RSS (ps) isn't the number to watch.** It counts PartitionAlloc pages that were freed but are still mapped (resident, not dirty), and it swings ±150 MB from sample to sample. The physical footprint (vmmap, what Activity Monitor shows) is flat when pinned.

## Curves (30 streams, no heap snapshots, GC forced before each sample)

BEFORE is `fd43e867`. AFTER is `494add3a` (this branch) plus #1491's `useStickToBottom` patch.

| After stream | 0 | 3 | 6 | 9 | 10 | 12 | 18 | 23 | 24 | 30 |
|---|---|---|---|---|---|---|---|---|---|---|
| BEFORE JS heap MB | 26.2 | 39.9 | 43.6 | 44.3 | 47.9 | 55.1 | 74.3 | 123.3 | 127.8 | 153.6 |
| BEFORE DOM nodes | 15.5 k | 12.1 k | 12.0 k | 12.0 k | 17.7 k | 29.1 k | 63.2 k | 134.8 k | 140.4 k | 174.6 k |
| BEFORE Blink GC (Oilpan) MB | 27 | 30 | 29 | 28 | 34 | 44 | 78 | 162 | 170 | 218 |
| BEFORE malloc MB | 59 | 47 | 46 | 45 | 49 | 49 | 61 | 75 | 77 | 94 |
| BEFORE ps RSS MB | 249 | 291 | 358 | 362 | 369 | 388 | 465 | 526 | 542 | 622 |
| BEFORE physical footprint MB | 133 | 145 | 148 | | | 165 | 222 | | 382 | 482 |
| AFTER JS heap MB | 26.2 | 39.5 | 43.6 | 45.7 | 45.8 | 46.0 | 46.4 | 45.7 | 45.4 | 46.5 |
| AFTER DOM nodes | 15.5 k | 12.4 k | 12.4 k | 13.7 k | 13.7 k | 13.7 k | 13.5 k | 13.4 k | 13.4 k | 13.4 k |
| AFTER Blink GC (Oilpan) MB | 28 | 28 | 29 | 31 | 31 | 30 | 30 | 30 | 30 | 30 |
| AFTER malloc MB | 59 | 47 | 45 | 46 | 46 | 45 | 48 | 46 | 46 | 44 |
| AFTER ps RSS MB | 250 | 290 | 407 | 398 | 398 | 398 | 282 | 250 | 250 | 365 |
| AFTER physical footprint MB | 131 | 147 | 141 | | | 145 | 149 | | 148 | 148 |

- **BEFORE** loses the pin at stream 10. From then on DOM rises by exactly one answer per stream. At stream 23 the store's retention cap (1,000 + 100 slack) drops the head of the thread, and the unpinned window resets to 120 entries: +48k nodes at once.
- **AFTER** crosses the same cap drop at stream 23 without moving.
- The snapshot runs agree:
  - BEFORE with snapshots held the pin until stream 23, with heap flat at 40–41 MB from stream 3 to 22.
  - AFTER with snapshots was flat at 38.5–39.5 MB from stream 6 to 30, gaining +0.48 MB in the snapshots from stream 12 to 30, all of it streamed text and code.

**What the footprint is made of** (BEFORE, stream 30, vmmap dirty):
- Memory Tag 255 (V8 + Oilpan pages): 353 MB, against 52 MB at stream 0. That matches memory-infra's v8 159 MB plus blink_gc 218 MB.
- Tag 253 (PartitionAlloc: malloc and Blink buffers): 93 MB, against 68 MB at stream 0.
- The macOS malloc zone holds 0.3 MB.

So the unbounded footprint is the JS and DOM objects of the mounted transcript, not native or GPU memory. The GPU process stayed at 101–127 MB in every run.

## Retainers (heap snapshots at streams 0/3/6/12/24, base build, pin held)

The diffs use dominator trees and retained sizes. Matching objects by snapshot ID undercounts, because V8 reuses an ID when a new object lands at a dead object's address, so constructor deltas and dominators are the reliable view.

| Retainer | Size | Bounded? | Action |
|---|---|---|---|
| Mounted transcript window (fibers, DOM, Oilpan) after the pin is lost | +3.6 MB heap, +5.7k nodes, +6 MB Oilpan per stream | **No** | Pin: #1491. Past-the-end reset: fixed here (`clampWindowStart`) |
| Second transcript copy after the first `thread:updated` of a session. `runner.pushDetail` has no previous push to diff against, so it sends the whole detail (4.15 MB), and the renderer builds a fresh object graph | 4.15 MB exclusive at stream 3 | Yes: released by stream 6 | None; noted below |
| Stale `ThreadDetail`s pinned by memoized children. Their onChange/onClick closures keep an old App render's V8 context, which holds `detail`: the sidebar search input, the composer textarea, the agents scrim | Boot-restored thread `aa8795e4` (1,102 msgs) and the stream-0 copy of `fae77a0b`, pinned all session. Mostly shared with the live transcript and `threadDetailCache` | Yes: one per memoized holder | None; noted below |
| Markdown parse cache (`Markdown.tsx` `parsed`) | 0.16 → 2.8 → 3.9 → 3.3 → 3.2 MB (s0/3/6/12/24); ~12 entries at the 400k-char budget, ~8 whole answers | Yes, by design (#1475) | Stays |
| V8 compiled code | +0.9 MB (s0→3), +2.5 MB (s3→6), −0.4 MB (s12→24) | Settles | None |
| Streamed answer text in `detail.messages` | ~47k chars per answer; the store caps the thread at 1,100 messages | Yes | Is the transcript |
| `thread:updated` / `threads:changed` payloads (2,453 pushes, 90 MB over 24 streams) | None retained; no payload-sized string in any snapshot | n/a | None |
| contextBridge (`window.coder`) | No growth in the native, closure or proxy constructor deltas | n/a | None |
| Boot snapshot (`coder.bootSnapshot.v1`, 1.2 M chars) | Not in the heap after boot; the only strings over 200 KB are the 2 MB bundle source and Playwright's injected script | n/a | None |
| Detached DOM | 134 nodes at every sample (#1490's observer fix holds) | Yes | None |
| localStorage (`site_storage`) | 8.8 → 10.9 MB over 30 streams: `coder.threadDetail.v1` mirrors the growing thread | Yes: 4 M-char cap per key | None |

## Measurement artifacts

- **Heap snapshots inflate malloc.** Each of the first snapshots adds ~45 MB to the renderer's malloc partition (59 → 144 MB), and it never comes back. Footprint is ~70 MB higher in snapshot runs (217 vs 148 MB at stream 30, AFTER). The curves above therefore come from separate runs without snapshots.
- **ps RSS swings ±150 MB** between consecutive samples, from freed PartitionAlloc pages that are still mapped. PM3's "peak 416 / 360 MB" is that noise; use the footprint instead.

## Method

Scratch scripts are in `/tmp/perf5/` (not committed). The harness is PM3's, ported:

**Builds.**
- `git archive` exports into `/tmp/perf5/{base,fix,names}` with APFS-cloned `node_modules`, `core` built and `npx vite build`, launched with `CODER_PROD=1`.
- `names` is an unminified build (`--minify false`), used only to read closure locations.
- `fix` is this branch's HEAD plus #1491's `useStickToBottom.ts` patch, applied in the `/tmp` tree only.

**Data.**
- PM3's frozen, sanitized snapshot (`worktrees/` empty, no server-port JSONs), with every live-dir path rewritten to `/tmp/perf5/data`: 81 in the store, 78 in `.bak`.
- A fresh `cp -Rc` per session. A trial launch adds the scratch project `/tmp/perf5-proj` through IPC, and `fae77a0b` (3.3 MB, 1,055 msgs) is moved into it, so the run guard allows streams.

**Launch.**
- `env -i`, `HOME=/tmp/perf5/home`, `SHELL=/nonexistent`, `PATH` = shims plus system dirs, no inherited `CODER_*`.
- `NODE_OPTIONS=--require hook.js`. The hook does all of the following:
  - sets `userData` to the clone;
  - stubs the sweepers, automations, autodispatch, post-merge, memory consolidation and iOS recover;
  - throws on fs writes outside `/tmp`;
  - refuses runner `start*` / `resume*` / `retry*` / `steer*` / `promote*` outside the scratch project;
  - re-prepends the git/gh shims after the pathEnv wrappers, with a 500 ms watchdog.
- The git shim is read-only outside `/tmp/perf5-proj`, and `gh` is refused.
- CDP on :9393. `lib.connect()` refuses any port owner not running from `/tmp/perf5/{base,fix,names}`. Scripts exit with `process.exit`.

**Sampling** (`soak5.js`), after each stream: PM2's generic-provider markdown agent, ~47k chars per answer over 25 s, sampled at 29 s.
- `HeapProfiler.collectGarbage` ×3;
- `Runtime.getHeapUsage` and `Memory.getDOMCounters`;
- a Chromium memory-infra dump over a browser CDP session, giving the renderer's v8, blink_gc, malloc, partition_alloc, cc and site_storage;
- ps RSS of the renderer PID the hook recorded;
- `vmmap -summary` of that PID at fixed streams;
- heap snapshots at 0/3/6/12/24 (base) and 0/3/6/12/30 (fix), in separate runs from the curves.

**Analysis.** `hs.js` (constructor diffs and Cooper–Harvey–Kennedy dominators), `loc.js` (the snapshot's closure locations mapped onto the bundle) and `mdcache.js`.

## Leak check

The baseline before the first launch covered the 13 git repos the live store references: 755 refs, 55 worktrees, no `recovered/*`. All of it was re-checked after each of the 18 launches.

**Result: no leak from the clones.**
- No `recovered/*` appeared.
- The clones attempted no git writes (both shim logs are empty).
- No fs write was blocked, and no run was refused.

Five changes did show up during the session. Each was attributed to live activity in the real app:
- 15 launches were clean outright.
- `names-pin1`: `adb0e3`'s plain commit `7df7ed7a`, accepted by `attribute.sh`.
- One check halted on new worktree `/private/tmp/trwt`. It was created at 14:13:50, before the 14:14:16 launch, as an orchestrator's verify merge of `adb0e3`. In the same check, `/tmp/mainwt` moved to main, and the branch commits were my own `494add3a` and `adb0e3`'s `2aa43510`.
- The next check halted on `refs/remotes/origin/…-adb0e3`. That was pushed at 14:14:55, before the 14:15:29 launch (PR #1491). In the same check, botpoc `coder/continue-building-443a5b` got `coder-checkpoint: turn 16`, a plain commit by the live thread.

The halted launches were trial launches. Each was rerun from a fresh clone after attribution. The attributions are in `/tmp/perf5/leak/attributed.txt`.

## Not addressed

- **The first `thread:updated` per thread per session is the full transcript.** On a capped thread every cap drop is too. That's one 4 MB IPC and one extra transcript object graph in the renderer, transient.
- **Memoized children keep stale App-render closure contexts,** and with them old `ThreadDetail`s, including a thread you have left. Both are bounded, and both cost ~4 MB per copy on a 3.3 MB thread.
- **A retention-cap drop shifts every timeline index.** A reader who is scrolled up keeps a start index that now points ~100 entries later, so the content being read can jump.
