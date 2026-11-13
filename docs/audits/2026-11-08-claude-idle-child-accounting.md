# Claude idle background-child accounting audit

Audit issue: [#1959](https://github.com/currentbits/solenta/issues/1959). Baseline: `24119d5fc6f5ed438e3e78c991e8fc2f1ed7c703` (origin/main, 2026-11-08). This deliverable contains evidence and a proposed design; production accounting is unchanged.

## Finding

Idle child measurements are discarded by the active-query boundary. They remain absent on orderly quit/reload if no later summary arrives. Subsequent warm results can recover reported USD and, if sufficiently complete, model/token totals. Aggregate recovery does not reconstruct the observed child's identity. This proves an accounting retention gap for the exercised frames, **not an amount of production spend lost**.

The local branch was switched to this main baseline before reproducing; earlier unrelated branch commits are excluded.

## Scope and deduplication

- Read [#1956](https://github.com/currentbits/solenta/pull/1956), including its diff and explicit idle-child exclusion. Its active-run batch remains completed.
- Read closed [#1945](https://github.com/currentbits/solenta/issues/1945): interrupted active queries and per-model attribution overlap conceptually, but the shipped observer is run-local.
- Checked existing usage and Claude/background issue searches, including closed [#1522](https://github.com/currentbits/solenta/issues/1522) (child progress routing) and [#1443](https://github.com/currentbits/solenta/issues/1443) (idle session lifetime). Those paths keep progress/session lifetime working; they do not retain these measurements. No separate idle-accounting issue was found before #1959 was created.
- No paid turns, live credentials, private hosts, live user store, or external transcript scanner were used. Only committed test captures and explicit synthetic frames were read.

## Source boundary

At this revision there is no literal `idleSide` variable. The equivalent path is the `!guard()` branch in [`runner-provider-claude.js`](../../electron/runner-provider-claude.js#L759):

1. `usageMeasurements = createClaudeUsage()` lives inside `startClaudeRun` (line 173).
2. `ingestTaskNotifications` and `ingestSubagentEvent` run before the active guard (lines 754–757).
3. `!guard()` sends the existing idle permission error, then returns (lines 759–769).
4. `usageMeasurements.observe` runs only after that return (line 773).
5. `recordMeasuredUsage` updates thread totals, daily spend and model buckets; it always increments turns (lines 666–694). It cannot be reused directly for idle updates.
6. [`claude-usage.js`](../../electron/claude-usage.js#L61) clears message/current-parent maps at every `finish`. It keeps cumulative model/USD baselines on the handle, but source rows do not retain message IDs.
7. A kept-alive session's dispatch is rebound on query reuse (lines 1556–1594, 1626). [`runner-claude-sessions.js`](../../electron/runner-claude-sessions.js#L54) removes session ownership before idle disposal and disables its dispatch. Stop flushes accepted active usage before setting `stopping` and killing (`runner.js:2819`). These boundaries must remain effective.

## Reproduction

Run from the repository root:

```sh
node node_modules/typescript/bin/tsc -p core/tsconfig.json
node docs/audits/claude-idle-child-accounting.cjs
```

The standalone characterization harness re-execs with an allowlisted environment, a fresh HOME/userData/temp store, and PATH containing only Node and system tools. It uses the real runner, NDJSON transport, accounting helper and Store. A local fake CLI emits frames when a fixture control file changes; a final supported `task_progress` frame provides a processing barrier. Warm cases assert one process was reused. Stop/replacement cases wait for the old process to exit after flushing deliberately late frames.

The committed `claude-2.1.283-steer.ndjson` capture confirms two native results use cumulative USD/modelUsage (20 input, 2,025 output, final USD 0.0326415). It contains no child frames. Child schedules below are **synthetic supported protocol shapes**, not a newly observed provider capture or evidence about how often a particular Claude version emits them. They use the `parent_tool_use_id`, `message_start`, `message_delta`, `assistant.message.usage`, Agent launch and task-progress shapes already consumed by the code. Native warm fields follow the captured result shape. Sparse warm summaries intentionally exercise omitted coverage; they do not assert every CLI emits sparse summaries.

Synthetic counts, chosen only to make overlap visible:

| Contribution | Input | Output | Cache read | Cache write |
| --- | ---: | ---: | ---: | ---: |
| First root query | 10 | 2 | 0 | 0 |
| Idle child | 7 | 3 | 11 | 2 |
| Next root query | 4 | 1 | 0 | 0 |
| Session total | 21 | 6 | 11 | 2 |

First native USD is 0.01; the final cumulative USD is 0.03. No child dollar value is inferred from token counts.

| Case | Observed result on unchanged main |
| --- | --- |
| Same child frames delivered during an active query | Child 7/3/cache 11+2 retained once, with parent ID and observed model. Repeated/sparse snapshots do not add again. |
| Frames delivered while idle; then quit/reload | Progress changes; usage stays at first-root input 10, with no child model cell. Saved/reloaded usage retains the omission. Foreground remains done and messages unchanged. |
| Sparse warm result: next-root usage and native cumulative USD only | USD/spend recovers to 0.03. Input is 14, not 21; child tokens/model cell/source remain absent. |
| Idle native result, then fully cumulative warm result | Idle native result does not update USD (still 0.01). Warm result recovers USD 0.03 and input 21, with no child source. This is a conditional delivery schedule, not a captured idle result. |
| Full cumulative warm modelUsage, distinct child model | Input 21/output 6/cache 11+2 and USD 0.03 recovered, including child-model bucket. No source retains the child parent ID. Reload matches. |
| Full cumulative warm modelUsage, same root/child model | Same numeric recovery; model totals cannot separate child from root. No child source. Reload matches. |
| Ignored idle child replayed twice during next query | Source and 7 child input recovered once by that query's observer; total input 21. Recovery depends on replay. |
| Idle permission request | Existing “No active turn in Solenta” error; no permission/question card or foreground revival. |
| Late child/result after Stop | Accepted root measurements remain at input 14; late 999-token / USD 9 frames do not charge or revive the stopped run. |
| Late frames from replaced idle process | Replacement's own 10 input / USD 0.01 counts normally (thread total 20 / USD 0.02); late old-process values do not charge it. |
| Bare observer moved across flush boundaries (helper control) | One 7-token child repeated across `finish(null)` produces 14 input. Moving the observer alone does not solve session deduplication. |

Validation: Node **22.23.2**, **12 passed, 0 failed**, including the captured control and helper counterexample. The macOS runner attempted its standard local egress-proxy listener, denied with `EPERM` by the tool sandbox; all fake-CLI accounting cases completed. The fixture does not need that listener or network access. These are characterization assertions of current behavior, kept outside automatic regression suites so the retention defect is not made a permanent product contract.

## Smallest proposed accounting path

Keep the change within the existing Claude session, usage helper and Store seams. No new service, transcript import, UI card, background query or provider request is needed. Keep the noninteractive/Grok path run-local.

### One collector per actual process

Add a session accounting object to the existing `claudeSessions` entry. Its epoch is a locally generated process-generation ID, distinct from a Claude session ID (a resumed conversation/new process must start a new native-counter baseline). Construct it at spawn, preserve it on dispatch rebind, and seal it at disposal/exit. Share the existing `lastModelUsage`, `lastTotalCostUsd` and unknown-coverage state with this collector; do not create competing native-dollar baselines.

Observe interactive frames once at the session callback, independently of foreground dispatch. Root messages require the current active Claude query and its run identity. Child messages can be accepted between queries only while that exact session/handle owns the thread. Keep observed parent IDs even if the launch cannot be correlated; do not invent a root owner or substitute the picker model. Register Agent/Task tool IDs and their originating run when their launches are observed, independently of the capped UI subagent rows.

Acceptance requires all of: session-map entry identity and handle match; live, unsealed epoch; thread still exists and has the captured provider/account identity; and no stop/revocation in progress. A different active provider/run must not borrow the old callback's ownership. Reject post-Stop and replaced-process frames even if they have valid-looking usage or session IDs. Validate session identity before any new accounting write.

Only accounting receives this extra route. Existing dispatch, result settlement, ACK handling, task-progress ingestion, permission-error response and question/permission cards keep their current behavior. An idle result may reconcile accounting only; it cannot call the foreground result handler, clear a newer run, send a completion notice, or add a turn.

### Retain identity and deduplicate across flushes

Maintain one numeric high-water record per `(epoch, parentToolUseId, messageId)` and advisor iteration identity, with `kind`, original observed model, optional originating run, measured fields and the last committed values. Sparse snapshots take field maxima; absent is distinct from zero. A delta without a known message start remains uncorrelated instead of borrowing another parent's message. Sources persisted for reconciliation must include message IDs; today's source shape drops them.

Flushing consumes pending deltas, **not** these identity/watermark records. A repeated snapshot after settle/reuse emits zero; an increase from output 3 to 5 emits 2. Preserve raw root/child sources separately from native model-summary remainders. A native aggregate remainder has confirmed model/amount but unknown root/child ownership; never label it as the current root simply because it arrived during that query. A late model name can enrich the same source, not add its tokens again. Existing unknown-model overlap handling remains necessary.

Reuse the current cumulative native reconciliation rules, now against all accepted session measurements. Subtract already-committed coverage, not just the last query's observations. Native `total_cost_usd`, including zero, stays authoritative over per-model `costUSD`; inconsistent model costs leave an unattributed remainder. A lower/stale summary cannot erase measurements or reset an epoch. Deduplicate result UUID/index when provided and retain the observation boundary a native report covers, so replay of an old result cannot mark newer idle tokens as priced. Missing native fields remain unavailable; no guessed child dollars.

### Persist a session contribution idempotently

Flush accepted idle deltas promptly on the existing save cadence and synchronously before task completion, reuse, Stop, idle reap, process exit or quit. Revoke ownership before kill; flush only pre-revocation accepted data, once. Background accounting updates have `turns: 0`, do not enter another run's `runUsage`/receipt/wasted-spend attribution, and do not update context occupancy or the last foreground model from a child.

The append-only `recordUsage` interface alone is insufficient for late coverage. If idle tokens are first stored as unpriced and a later SDK total covers them, merely appending native USD leaves the old `unpricedTokens` eligible for fallback pricing **on top of** the SDK dollars. Add a narrow idempotent Store checkpoint for this session's contribution: keyed by epoch, retain the last committed day/provider/model contributions and source metadata, and replace only that contribution by its new computed target. Apply the difference atomically to thread usage, daily/model/thread buckets, spend and unpriced coverage; zero native USD must also remove covered fallback eligibility. Do not permit arbitrary negative usage through general `recordUsage`.

Persist checkpoint and aggregate changes in the same logical Store update. The current Store writes `usageThreadsByDay` to `usage-threads.json` separately from envelope usage/spend (`store.js:1249`); one `saveNow()` is not a cross-file transaction. Co-locate the authoritative session checkpoint/contribution with its commit generation and make side-file projections recoverable from that contribution if generations differ after a crash. Reapplying the same checkpoint must be a no-op, including after reload; do not claim crash idempotence from an in-memory watermark alone. Late enrichment can transfer only this contribution's model/coverage metadata, without rewriting unrelated or legacy rows. Retain observed day attribution across midnight; allocate unassignable native residuals to report day as unattributed instead of guessing a historical child/day split. Sealed epochs keep their final contribution/source evidence; active watermark state can be compacted to IDs and numeric maxima (no transcript contents). Replay history within a live process cannot be evicted arbitrarily without losing the dedup guarantee.

### Implementation review gates

Expected production scope: `runner-provider-claude.js`, `runner-claude-sessions.js`, `claude-usage.js`, a narrow session-checkpoint method in `store-usage-methods.js` plus normalization only if its persisted schema requires it. No permission/question UI changes. Convert the audit cases into desired-behavior regressions as the implementation lands.

Required additional checks for that implementation:

- Child after root settlement and after child task completion; multiple interleaved parents and identical message IDs under different parents; unknown models/advisors; replay across multiple flushes and same-model root/child overlap.
- USD/model summaries before and after idle observations, duplicate/older summaries, explicit zero, missing USD, contradictory model USD, partial model fields and backward counters. Provider totals and raw sources must remain separately inspectable.
- Fallback price before/after late SDK coverage, including zero: no double pricing. Check day/provider/model/thread totals, turns, spend and persisted restart idempotence, including midnight and legacy cells.
- Stop, quit, reaper, key/account/provider change, removed thread, replacement process and queued kill-time frames. Commit accepted pre-stop observations exactly once; reject post-revocation frames. Verify active-query partial accounting still passes unchanged.
- Idle child updates must not revive foreground work, add turns, steal root context/model identity, alter ACK/settlement behavior, or open/answer permission/question cards differently.

This design has not been implemented or performance-tested. The main risks are late coverage correction, persistent per-source watermark size on very long warm sessions, aggregate/source overlap, and process-generation ownership. A guard-only patch would leave these unresolved.
