# Main-process performance on real data — 2026-10-05 (#1475, PM1)

This is a measurement only; no product code changed. The build was `origin/main` at `a665aa32`, with Electron 0.23.0 from the dev tree run with `CODER_PROD=1`, against an APFS clone of the live data dir:
- a 5.9 MB `coder-store.json` holding 2,097 threads (2,003 not trashed) and 15 projects;
- 2,099 message shards totalling 788 MB, the largest 3.6 MB;
- 2,097 work-log shards.

## Ranked findings

| # | Cost (median of 3–5 runs) | How measured | User-visible effect | Fix proposal | Expected gain |
|---|---|---|---|---|---|
| 1 | **Streaming rewrites the whole 5.9 MB envelope on every flush.** 99 envelope writes per 30 s of one stream add up to **571 MiB (19 MiB/s, ≈67 GiB per streaming hour)**, against 0.63 MiB of actual message-shard writes. Each flush costs 17.7 ms of synchronous `stringifyStore` on the main thread, 1.75 s of CPU per 30 s. Envelope flushes account for **≈92% of the main process's JS busy time while streaming** (3.3 of 3.6 s). | fs monkeypatch byte counts, a timed wrapper on `Store._serialize`, CPU profile `stream30` | Constant SSD wear. Main-thread jank: event-loop p99 is 27 ms while streaming vs 13 ms idle. Every extra streaming thread or larger store makes it worse, because cost scales with total thread count, not activity. | (a) Track envelope-dirty separately from shard-dirty, so a flush that only appended messages skips the envelope. (b) Throttle envelope flushes to ≥2 s while shards keep the 250 ms debounce. (c) Move `threads[].hypotheses` (1.15 MB) and `threads[].suggestions` (1.06 MB) to per-thread shards, and move `usageThreadsByDay` (780 KB) out of the envelope. | (b)+(c): the envelope shrinks to ≈2.8 MiB, and writes go from 19 MiB/s to ≈1.4 MiB/s (−93%). Serialize goes from 17.7 ms per flush to ≈9 ms, running ≤0.5×/s. |
| 2 | **#1398 is only partly fixed.** #1424 scoped `threads:summaries` to the selected project, but the solenta project holds 1,179 of the 2,003 threads. The first fetch per session still **reads 1,166 full transcripts (463 MiB) synchronously in 2.07 s** (2.06–2.14) to extract one line each. Warm repeats take 10 ms because of the `_lastAssistantByThread` memo. | IPC timing, plus fs read accounting during the call | Opening the Agents panel freezes the whole main process for ~2 s: no IPC replies, no stream rendering. It recurs per thread whenever a thread's message list changes. | Persist a `lastActivity` snippet on the thread row whenever an assistant message is appended (cheap, already in memory). Failing that, read only the tail of the shard (`fs.read` of the last 64 KB) asynchronously. Optionally scope the call to the crew family (`threadIds`) instead of the whole project. | 2.07 s → ≈10 ms. Removes a 463 MiB read. |
| 3 | **The login-shell PATH capture blocks boot for 0.71 s** (705–747 ms, 5 runs). `enrichProcessPath` runs `$SHELL -lic` through `execFileSync` at module top level in `main.js`, before `app.whenReady` and before the window exists. | Direct timing of `captureLoginPath` with the real HOME and environment. The rc cost itself, `zsh -ilc` alone, is 0.70 s. | First paint is delayed by ~0.7 s on every launch, on top of the 1.16 s boot below. The size depends on the user's rc; this machine's is typical of oh-my-zsh/nvm setups. | Cache the last captured PATH in userData and apply it synchronously. Re-capture with async `execFile` after first paint, and await it only before the first provider spawn. | Roughly −0.7 s to first paint, about 38% of real boot. |
| 4 | **Synchronous git spawns in IPC handlers.** `projects:list` calls `execFileSync git rev-parse` once per project to build the icon cache key: **138 ms at boot** (14 projects) and **168 ms again** whenever the 60 s TTL has lapsed. That happens on each run start and thread create (`projects:list` ×2). `git:listBranches` runs 2–4 sync git calls (`fallbackDefaultBranchName` + `for-each-ref`), **~37 ms per call**; listBranches accounted for 296 ms of the first 2.5 s. Boot-profile `spawn` self time: 450 ms. | CPU profile (`spawn` self time; inclusive `defaultGitCommonDir` and `gitTry`), IPC timing | `projects:list` sits on the boot critical path between renderer load (725 ms) and `threads:list` (935 ms). Every 60 s+ gap followed by a run start freezes the main thread for ~170 ms. | Key the icon cache on `path.resolve(root)` and resolve the common dir lazily with the async `gitOutAsync`. Switch `listBranches` to the async default-branch helper next to it in `worktrees-branches.js`. | −140 ms on the boot critical path; no >30 ms main-thread stalls from these handlers. |
| 5 | **Fan-out in `files:resolve`.** Restoring one 240 KB thread at boot issues **424 separate `files:resolve` IPCs** (131 ms main thread). Each path does a linear `store.getThread` (12 µs avg, 19 µs worst, at 2,097 threads) plus a sync `existsSync`. | IPC counts at boot, CPU profile (`resolveThreadRoot` 78 ms self) | 131 ms of main-thread work on every thread open, competing with the first render. | Renderer: batch `useResolvedMap` requests per microtask, and dedupe in-flight paths in `PathLinkProvider`. Main: resolve the thread root once per call, not per path, and index `getThread` with a `Map`. | 424 IPCs → 1–3; ≈131 ms → <10 ms. |
| 6 | **The message cache never shrinks.** Each opened thread's hydrated messages stay in `_messagesHydrated` for the session. Opening the 10 largest threads (2.6–3.6 MB shards) took heap from 29 to 71 MB after GC, and it didn't fall 30 s later. RSS went 179 → 231 MB. | `process.memoryUsage()` after a forced GC, plus store cache introspection | Modest today: +4.2 MB of heap per large thread visited. Grows without bound in long sessions that browse many threads. | Keep an LRU over `_messagesHydrated` for non-running threads (e.g. 8 threads or 32 MB), and drop to the lazy/raw form on eviction. | Heap capped at ~30 MB above baseline. |
| 7 | **Each `threads:changed` push sends the full 2.6 MB list** (2,003 rows, archived included). The main-process send costs 5.3 ms; the renderer pays the structured-clone decode. It's rare: 2 pushes per run (start and end), plus each pin, archive or rename. | Push wrapper (bytes, `send` timing) | Small per event. Scales with total threads, not visible ones. | Push only changed rows (`thread:updated` already exists), or exclude archived rows unless the archive view is open. | −2.6 MB per status change. |
| 8 | **Store load at boot:** 131 ms wall and 192 ms CPU warm (377 ms cold). It eagerly reads all 2,097 work-log shards (2.1 MB, sync), which is by design per `_adoptWorkLogs`. | `Store` constructor timing, fs reads | Part of the 1.16 s boot. Fine for now. | Only if boot work resumes: load work logs lazily for non-running threads. | −60 to −250 ms. |

**Real costs: 1–5.** Number 6 is a slow leak worth capping. **7 and 8 are fine for now.**

**Fine, not worth work:**
- Idle CPU: **50 ms of main-process JS per 30 s**. `process.cpuUsage` shows 1.6 s per 30 s, but that is Chromium's browser-process threads, not JS.
- Idle timers:
  - the runner stall watchdog fires every 15 s at 2.4 ms per fire;
  - the PR-state refresher fires once at 30 s, then every 5 min; with no remotes or authenticated gh it spawns nothing;
  - the renderer polls `mergeQueue:listLanes` once per second, at 0.04 ms per call.
- Per-delta streaming pushes: `thread:updated` is throttled to 5/s (150 pushes per 30 s, 1.7 KB each, 0.03 ms to send).
- Linear `getThread` while streaming: 778 calls per 30 s ≈ 9 ms total.
- Opening the largest thread: 44 ms round trip for 3.6 MB (20 ms warm).
- `crewIntegration`: 155 ms, async git.
- The simulate provider's 700 ms ticker: 23 ms per 30 s. Its flushes still rewrite the envelope 17× per 30 s (98 MiB).

## Method

Everything ran from a worktree build launched by a scratch wrapper (`/tmp/perf/`, not committed):
- **Launch:** `env -i` with no inherited `CODER_*` variables or tokens, a scratch `HOME`, and `NODE_OPTIONS=--require hook.js`.
- **Data:** the hook calls `app.setPath("userData", clone)` before `main.js` loads.
- **Safety:**
  - Every fs write outside `/tmp` throws and is logged; zero fired.
  - A `git` shim allows only read-only subcommands (with `GIT_OPTIONAL_LOCKS=0`), and writes only inside the scratch repo.
  - `gh` is stubbed out.
  - Runs are refused for any project other than the scratch repo.
  - Disabled: worktree sweep, retention, wedged-lane watchdog, automations, autodispatch, post-merge, memory consolidation and iOS simulator recovery.
  - The memory and orch server configs were removed from the clone, so each got its own port and DB.
- **Instrumentation:**
  - `ipcMain.handle` and `webContents.send` are wrapped to record count, duration and JSON payload size.
  - fs read and write calls are wrapped to record bytes per category.
  - Timers are wrapped to record call site, interval, fires and callback time.
  - `inspector` runs CPU profiles at a 250 µs sampling interval.
  - Memory is sampled with `process.memoryUsage()` after a forced `gc()`.
  - Store counters cover `getThread`, `save`, `_flushAsync`, and timed `_serialize` / `_snapshotDirtyShards`.
- **Streaming:**
  - A fake `claude` binary replays realistic stream-json: about 40 `text_delta` events per second, a full assistant message every 1.8 s, and a Bash tool call with its result every 2 s, for 32 s.
  - It runs on a fresh thread in a scratch git repo, through the real `claude-stream` path.
  - The simulate-provider ticker (`CODER_SIMULATE=1`) was measured separately.
- **Agents panel:** I called the same three IPCs the panel makes: `threads:summaries({projectId})`, `crewTasks` and `crewIntegration`. I chose the largest project and its most recent thread. Unscoped summaries were measured for comparison.
- **Repetitions:** boot 5× in a boot-only mode, and the full scenario 3×. Medians are reported with the range in brackets.

**Caveats:**
- Boot numbers use a scratch HOME, so the login-shell capture took 14 ms there. Finding 3 measures it separately with the real HOME.
- The git shim adds ~1.7 ms per git spawn (14.8 vs 13.1 ms on `/usr/bin/git`). The shim execs `/opt/homebrew/bin/git` (7.4 ms per `rev-parse`), the binary the real app resolves.
- The window ran fully transparent and non-focusable, with background throttling disabled.
- Instrumentation overhead in the profiles is under 15 ms per 30 s; `hook.js` frames are listed separately.

## Raw numbers

### 1. Boot timeline (warm, ms since process start, median [min–max] of 5)

| Mark | Median | Range |
|---|---|---|
| preload hook (Electron init) | 105 | 101–108 |
| `main.js` require start → end | 183 → 220 | — |
| `app` ready | 258 | 257–271 |
| window created | 332 | 329–342 |
| Store constructor start → end | 413 → 544 | 404–420 → 536–552 |
| `boot:ready` push | 568 | 559–575 |
| renderer `did-finish-load` | 725 | 720–731 |
| `projects:list` call → answered | 782 → 920 | (138 ms, sync git) |
| `threads:list` answered | 935 | 932–956 (7 ms, **2.6 MB**) |
| `threads:get` (restored thread) answered | 946 | 943–968 |
| `git:listBranches` answered | 1120 | 1119–1148 |
| **sidebar rows painted** | **1163** | **1159–1190** |

- Main-process CPU to that point: 1,090–1,110 ms. The Store constructor alone: 192 ms CPU.
- **Add ~710 ms** for the real login-shell PATH capture (finding 3). Real warm boot on this machine is ≈1.87 s to sidebar rows.
- The first, cold run (fresh clone, cold page cache, `/usr/bin/git`) reached sidebar rows at 2.39 s, with `projects:list` at 632 ms and the store at 377 ms.

Top functions in the boot CPU profile (warm; 2.56 s window, 1.11 s busy):

| Self ms | Function |
|---|---|
| 450 | `spawn` (native): sync git from `projects:list` and `listBranches` |
| 78 | `resolveThreadRoot` (`ipc-shared.js:51`), via `files:resolve` |
| 64 | `readFileUtf8`: 2,097 work-log shards + envelope + module sources |
| 64 | `View` (window creation) |
| 51 | `wrapSafe` (module compile) |
| 14 | `splitMessagesByThread` (`jsonEnvelope.js`) |
| 12 | `sweepCrew` (`runner-orch-notices.js`) |

| Inclusive ms | Path |
|---|---|
| 296 | `git:listBranches` → `fallbackDefaultBranchName` → `gitTry` (`execFileSync`) |
| 140 | `projects:list` → `presentProject` → `iconDataUrlFor` → `cacheKey` → `defaultGitCommonDir` (`execFileSync`) |
| 131 | `files:resolve` → `resolveAllowedShellPath` (424 calls) |
| 128 | `loadStore` → `Store` → `_load`; `_adoptWorkLogs` dominates when cold (265 ms) |

Boot I/O:
- read: the 5.9 MB envelope, 2,097 work-log shards (2.1 MB), 1 message shard (240 KB), and 466 module files (4.5 MB);
- written: 2.5 KB in total (secrets audit, MCP configs).

### 2. IPC

**Boot invokes:**

| Channel | Count | Payload |
|---|---|---|
| `threads:list` | 1 | 2.68 MB |
| `threads:get` | 1 | 248 KB |
| `projects:list` | 1 | 21 KB |
| `providers:list` | 1 | 46 KB |
| `files:resolve` | **424** | 149 KB total |
| `mergeQueue:listLanes` | 14 | — |

Everything else was under 2 KB.

**Idle (30 s):** pushes: none. Invokes: `mergeQueue:listLanes` ×30, 1 ms total. Nothing else.

**One stream (30 s):**

| Channel | Count | Total | Each | Main-process send |
|---|---|---|---|---|
| `thread:updated` push | 150 | 262 KB | ≤2.1 KB | 5.1 ms total |
| `threads:changed` push | 2 | 5.2 MB | 2.6 MB | 5.3 ms each |
| `projects:list` invoke | 2 | — | 21 KB | — |
| `mergeQueue:listLanes` invoke | 30 | — | — | — |

The renderer issued no `threads:get` polls; detail rides `thread:updated`.

**Simulate run (30 s):** 18 `thread:updated` (50 KB) and 2 `threads:changed` (5.2 MB).

**Agents panel** (largest project, 1,179 threads, median of 3):

| Call | Rows | Payload | Time | Disk read |
|---|---|---|---|---|
| `threads:summaries({projectId})`, cold | 1,169 | 566 KB | **2,068 ms** [2,056–2,140] | **1,166 shards, 463 MiB** |
| same, warm | 1,169 | 566 KB | 10 ms | 0 |
| `threads:summaries()` unscoped, after the scoped call | 2,003 | 980 KB | 1,372 ms | 826 more shards, 285 MiB |
| `threads:crewTasks` | — | <1 KB | 0.7 ms | 0 |
| `threads:crewIntegration` | — | 15 KB | 155 ms [146–178] | 0 (async git) |

`threads:summaries` reads through `_readShardFile` (`readFileSync`), so the 2 s is a main-thread freeze.

### 3. Main-process CPU

| Phase (30 s) | Process CPU | JS busy (profile) | Loop delay p99 / max | Top JS |
|---|---|---|---|---|
| idle | 1,624 ms [1,513–1,664] | **50 ms** | 13 / 17 ms | inspector 32 ms, `refreshPrStates` 4 ms, `listLanes` 1 ms |
| one stream | 6,049 ms [5,843–6,057] | **3,622 ms** | 27 / 30 ms [30–48] | `stringifyStore` 1,669, `utf8Write` 687, anonymous (flush `writeTmp`) 889, `rename` 71, claude `onEvent` 41, `pushDetail` 41 |
| simulate ticker | 2,282 ms [2,268–2,311] | 698 ms | 16 / 30 ms | `stringifyStore` 294, `utf8Write` 118 |

Timers that fire while idle (30 s window, plus those created at boot):

| Interval | Site | Cost |
|---|---|---|
| 15 s | `runner-watchdogs.js:86`: `checkStalls` + `heartbeatActiveLanes` | 2.4 ms per fire |
| 30 s once, then 5 min | `worktrees-pr.js:1305/1312`: PR-state refresher | 1.2 ms (spawns nothing here) |
| 15 s once | `main.js:799` orphan sweep, `main.js:822` artifact cleanup | — (sweep stubbed for safety) |
| 2 s once | `services-settings.js:430` | — |
| 60 s / 5 min / 60 s / 24 h / 30 min | automations, autodispatch, post-merge, memory consolidate, wedged-lane watchdog | stubbed for safety, not measured |

While streaming:

| Timer | Fires per 30 s | Callback time |
|---|---|---|
| `store.js:1227` flush debounce (250 ms) | 98 | 1,805 ms |
| `runner-provider-claude.js:156` partial push (250 ms) | 98 | 39 ms |

### 4. Memory (after forced GC, median of 3)

| Point | heapUsed MB | RSS MB | Hydrated threads / messages |
|---|---|---|---|
| after boot | 29.4 | 264 | 1 / 133 |
| after 30 s idle | 29.1 | 179 | 1 / 133 |
| after opening the 10 largest threads | 71.4 | 231 | 11 / 10,525 |
| 30 s later | 71.4 | 231 | unchanged |
| after summaries (2,003 `lastAssistant` memos) | 76.0 | 240 | unchanged |
| after stream + simulate runs | 75.4 | 257 | 13 / 10,556 |

The raw and lazy message caches (`_messagesRaw`, `_messagesLazy`) stayed empty, so the transcripts held in memory are the hydrated arrays only. Each open of a 2.6–3.6 MB shard added 3.3–5.4 MB of heap. Round trip: 30–44 ms cold, 14–21 ms warm.

### 5. Disk I/O while streaming (30 s, median of 3)

| Target | Writes | Bytes |
|---|---|---|
| `coder-store.json` envelope (tmp + fsync + rename) | 99 | **571 MiB** |
| message shard (streaming thread) | 99 | 0.63 MiB |
| work-log shards | 2 | 0.6 KB |

`Store.save()` was called 150×, giving 99 flushes, each `_serialize`-ing the full envelope: 598 MB of JSON stringified in total, 17.7 ms per flush. With the simulate ticker: 17 envelope writes (98 MiB) per 30 s.

Envelope composition (5,902 KB):

| Key | Size | Notes |
|---|---|---|
| `threads` | 4,692 KB | `hypotheses` 1,152 KB and `suggestions` 1,062 KB of it |
| `usageThreadsByDay` | 780 KB | — |
| `usageByThread` | 326 KB | — |
| `tasksByCrew` | 64 KB | — |
| everything else | <40 KB | — |

### 6. #1398 status

#1424 landed the projectId scope (`services-threads.js:1101`), and AgentsPanel passes `{ projectId }` (`AgentsPanel.tsx:2116`). The problem remains for the dominant project, though. The scoped cold call still reads 1,166 of 2,099 transcripts (463 MiB, 2.07 s, synchronously) to take the first line of each thread's last assistant message. See finding 2 for the fix. Recommendation: keep #1398 open, or file a follow-up.
