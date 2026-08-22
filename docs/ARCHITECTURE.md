# Architecture

Solenta is an Electron desktop app: main owns agents and disk, the renderer is a
React UI, and preload exposes a typed `window.coder` API. The contract lives in
`src/shared/ipc.ts` (channel names mirror method paths: `threads:list`,
`runs:start`, push events `threads:changed` / `thread:updated`).

## Process split

| Layer | Path | Role |
|-------|------|------|
| Main | `electron/main.js` | Window, Store, Runner, memory supervisor, IPC registration |
| IPC | `electron/ipc.js` | `ipcMain.handle` bridges to services / runner / git / memory proxy |
| Preload | `electron/preload.js` | Context-isolated `window.coder` (invoke + subscribe) |
| Services | `electron/services.js` | Projects, threads, providers, settings, spend gate, worktree wrappers |
| Renderer | `src/` | React app (`App.tsx` → Sidebar, ThreadView, AgentsPanel) |
| Dev fixtures | `src/devCoder.ts` | Seeded `CoderApi` for browser-only Vite + demo captures |
| Hook | `src/useCoder.ts` | State, subscriptions, error banners |

`CODER_PROD=1` or packaged builds load `dist/`; otherwise main points at the Vite
dev server. `npm run dev` starts both halves (`scripts/dev.js`), so dev exercises
the real main process; `npm run dev:browser` is the Electron-less demo, and it is
fixtures all the way down.

## Provider registry

`electron/providers.js` is data-driven. Each entry has `id`, `name`, `binEnv`,
`defaultBin`, `supportsResume`, `models[]`, `kind`, and `buildArgs(...)`.

**Kinds** (parsed / spawned in `electron/runner.js` + adapters):

- `claude-stream`: `electron/claude.js` (stream-json tool events, session resume)
- `codex-json`: `electron/codex.js`
- `kimi-stream`: `electron/kimi.js` (cwd-scoped continue via sentinel session id)
- `text`: generic stdout agent (`electron/agent.js`) for Grok / OpenCode
- `simulate`: fakes single-turn runs only (`startSimulatedRun`); Build workflows reject it

Empty `models` means free-form model ids (composer Custom… + CLI `-m` / `--model`).
Non-empty lists are membership-checked on `threads.setProvider`.

Binary resolution: env override (`CODER_*_BIN`) then `which` / path existence.

## Runner identity guard

`electron/runner.js` keeps `active: Map<threadId, { runId, … }>`. Every
`onChunk` / `onDone` / `onError` re-reads the map and no-ops unless
`e.runId ===` the closed-over run id. Stops and late exits of a prior run cannot
mutate a newer run. Work log steps and messages carry `runId` so the renderer
(`src/timeline.ts`) can group one Work Log card per run.

## Workflow engine

- Spec / pure engine: `core/` (`@coder/core`, built to `core/dist`)
- Electron orchestration: `electron/workflow.js` (phases, real one-shot agent
  calls, dossier tool messages, `ThreadDetail.workflow` progress)
- Templates: store-backed list + builtin `standard` ("Plan and Verify"); CRUD via
  `workflows:*` IPC; UI in `src/components/WorkflowsModal.tsx`

## Worktrees

`electron/worktrees.js`: `setupWorktree`, `mergeWorktree`, `removeWorktree`
(dirty / unmerged branch guards), `diff`, `push`. Thread fields
`worktreePath` / `branch` are updated through services. Thread delete refuses
while a worktree still exists.

Turn checkpoints (`coder-checkpoint: turn N`) are listed `--first-parent`: a
merged worker branch carries its own checkpoints, and restoring one would
hard-reset this thread onto the fork's tree. Numbering counts checkpoint
*commits*, not turns — a turn that changes nothing skips a number — so anything
mapping messages to files must select by commit time, never by turn N.

**Fail-closed isolation** (issue #511). A thread with `pendingWorktree` or
a bound `worktreePath` must not run in the project checkout.
`setupWorktree` throws `Failed to create worktree:\n` plus verbatim git
stderr (`gitFailureText` prefers `err.stderr`; never first-line-only).
`prepareThreadWorktree` = `clearMissingWorktree` + `ensureWorktree`. A
folder gone from disk re-arms `pendingWorktree` so the next turn
rematerializes. `runner.startRun` / `startWorkflowRun` catch setup
failure, record user + event + status failed + `lastError` (Retry-turn
attaches), and throw so fork / drainQueued know the agent never started.
Zero children spawn. `workflow.js` throws if the folder is gone rather
than using `project.path`.

**Retention and GC** (issues #316 / #559 / #601 / #563). Per-project
`worktreeRetention` defaults to 10 settled worktrees (0 = keep everything)
and is persisted on every project so `enforceRetention` actually runs.
The boot sweep is delayed 15s and unref'd; `enforceRetention` scans with
`skipSizes: true` so launch does not `du`-walk every worktree. Candidates
are picked by activity time, not size. Dirty trees and unmerged branches
are never deleted — directories only, commits survive. Archive / merge
call `scheduleRetention` so a GC failure cannot fail the user-facing
action.

**Forge probe** (issue #608, `electron/sourceControl.js`). Settings →
Source Control probes each known forge CLI up front (present, version,
signed-in-as) so git actions do not have to parse stderr after a failed
push/PR. Cached until Rescan or a mid-session auth miss. The renderer
(`src/sourceControl.ts` `forgeReadiness`) disables Create PR / checks /
merge when GitHub is not ready.

**PR-size cap** (issue #402). `createPr` in `electron/worktrees.js` refuses
an oversize diff **before** push or `gh pr create`. Cap is
`settings.prDiffCapLines` (default `DEFAULT_PR_DIFF_CAP_LINES` 400;
absent/junk heals to 400; explicit null disables). Count is additions +
deletions vs the base branch (`git diff --numstat base...branch`,
`parseNumstat`); binary files (`-\t-\tpath`) add no lines but still
count as files. A numstat failure returns null and **fails open** — a
stat hiccup must not block creation. `allowOversize: true` is the
explicit human override. The error prefix `PR_TOO_LARGE_PREFIX`
(`"PR too large"`) is the renderer contract: `src/prUi.ts` duplicates
the string (the two processes share no module) so
`isPrTooLargeMessage` can offer `splitPrPrompt` (restack into a chain
of smaller PRs) vs Create anyway. Pinned by
`electron/test/pr-size-cap.test.js`.

Planboard review-load (`src/planboard.ts` `reviewLoad`) is the same
bottleneck measured the other way: open non-draft PRs vs
`REVIEW_LOAD_BUSY_PRS` 4 / `REVIEW_LOAD_BUSY_LINES` 1200 (three
cap-sized PRs) and `REVIEW_LOAD_OVERLOADED_PRS` 7 /
`REVIEW_LOAD_OVERLOADED_LINES` 2400. Drafts do not count.

## Post-merge verification

One-shot delayed re-check after a thread's PR merges (issue #420).
`electron/postmerge.js`; renderer labels in `src/verifyCard.ts`
(`formatPostMergeLine`). Not a user-visible Automation — those mint
agent turns on a cadence.

Armed by `onThreadPrState` when `prState` becomes MERGED **and** the
thread has a `verifyCommand` **and** no existing `postMergeVerify`
blob. Default delay `DEFAULT_DELAY_MS` 24h (`CODER_POSTMERGE_DELAY_MS`
in tests). Persistence is `ThreadInfo.postMergeVerify` +
`issueNumber`. Status: scheduled / running / passed / failed /
skipped. A crash mid-check leaves `"running"`; `normalizePostMerge`
and `duePostMergeChecks` heal it to scheduled-due
(`STALE_RUNNING_MS` 15 min). The minute ticker
(`startPostMergeScheduler`, 60s) is started from `electron/main.js`.

The check runs in a detached worktree at the merged default branch
(`prepareMergedCheckout`: fetch best-effort, then origin/HEAD →
origin/main → origin/master → HEAD). Remote projects skip. A pass
appends an event via `setMessages` (does not bump `updatedAt`). A
fail spawns a fixer thread (`spawnFixThread`, `pendingWorktree: true`,
`handoffFrom` the source, prompt from `verify.js` `buildFixPrompt`)
and best-effort reopens the planboard issue (`issues.reopenIssue`).
The fixer thread is the durable action if reopen throws.

## Rewind (edit and resubmit)

`threads.rewind` (issue #254) truncates the transcript at a past user message,
clears `sessionId` and sets `replayContext`: a CLI session cannot be rewound, so
the next turn starts fresh and `buildHandoffPrefix` seeds it with a digest of
the thread's own retained tail (same builder as fork hand-off, source = self —
never via `handoffFrom`, which drives crew sweeps and the OTel ancestor walk).
Rewind starts no run; the renderer follows with the ordinary `runs.start`, which
appends the edited text. Usage / spend is never rewritten. `restoreFiles`
additionally hard-resets the worktree to the newest checkpoint at or before the
edited message.

## Memory

| Piece | Path |
|-------|------|
| Server | `memory-server/src/` (HTTP + MCP, SQLite/FTS5, bearer token) |
| Supervisor | `electron/memory-sup.js`: adopt existing `/health` or spawn; never kill an adopted process |
| Proxy | `electron/memory-proxy.js`: renderer `memory:*` IPC → HTTP with config from userData |
| MCP inject | When healthy, Claude argv gains `--mcp-config` pointing at `mcp-coder-memory.json` |
| Citations | Entries store `file`/`thread`/`commit` evidence. When `project` is a live worktree, bootstrap/search/get verify file excerpts and invalidate contradictions (#395) |

Config file (env `CODER_MEMORY_CONFIG` or default under Application Support/coder):
`{ port, token, dbPath }`. MCP handshake document shape:

```json
{
  "mcpServers": {
    "coder-memory": {
      "type": "http",
      "url": "http://127.0.0.1:<port>/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

`GET /health` is open; other routes and MCP require the bearer token.

**Provenance** (issue #404, `src/provenance.ts`). Every assistant
message is classified by where its content could have come from: repo
paths (Read/Edit/Grep/… tools or backticked paths in the text), shared
memory (`memory_*` / `session_*` tools, including
`mcp__coder-memory__…` prefixes), or GitHub issue/PR refs (`#404`,
`gh issue`/`gh pr`, github.com URLs). Those three tiers are
addressable. A substantive message with no addressable source is the
case the feature exists for (model prior knowledge). Short chatter is
never tagged: `PRIOR_MIN_CHARS` 240. Cap per tier `MAX_REFS` 6.
`messageProvenance` scans back to the previous user message so chip
order matches tool order. `provenanceVisible` is always true when
grounded, otherwise only when the trimmed text is long enough.

**Agent-config doctor** (issue #412, `electron/configDoctor.js`). Lints
`AGENTS.md` / `CLAUDE.md` (and siblings in `ROOT_FILE_NAMES`, plus
one-level `packages/*/AGENTS.md|CLAUDE.md`) against Anthropic's
six-axis 100-point rubric (`AXIS_MAX`: commands 20, architecture 20,
patterns 15, conciseness 15, currency 15, actionability 15). Grades
A≥90 / B≥70 / C≥50 / D≥30 / else F. Deterministic — no LLM. Scoring
is heuristic; generation is a template over memory entries
(`convention` + `strategy` always, `knowledge` only when
importance ≥ 3 or it has citations; caps 20 / 10 / 15). IPC:
`projects:lintAgentConfig` / `previewAgentConfig` /
`writeAgentConfig` (`services.lintAgentConfig` etc.). UI is
`ConfigDoctorCard` in `src/components/MemoryTab.tsx`. Writes only
`AGENTS.md` / `CLAUDE.md` / `GEMINI.md` (`WRITEABLE_BASENAMES`);
`assertWriteableRel` refuses `..` and paths outside the project.
Default write set is always `AGENTS.md`, plus `CLAUDE.md` when it
already exists or the repo has no instruction file yet. Generated
files carry `<!-- generated-by: solenta-config-doctor -->`. Local
checkout only (`requireLocalProject`).

## Code index

Shared per-repo symbol map (issue #377, `electron/codeindex.js`). One
index per repo, keyed on the project's **main checkout**, read by every
thread including worktrees — worktrees do not get their own index. On
disk it is JSON, not sqlite: `userData/codeindex/<first 16 of
sha1(repoRoot)>.json` (`indexPathFor`), `INDEX_VERSION` 1 (an older
file is treated as absent). Write is tmp-then-rename.

Refresh is fire-and-forget from the dispatch path (`maybeRefreshIndex`),
debounced per repo to `REFRESH_MIN_INTERVAL_MS` 60s, never throws,
inert when `CODER_CODEINDEX_DISABLE=1`. Incremental: a file whose
`mtimeMs` and `size` still match keeps its symbols. Caps: `MAX_FILES`
20_000, `MAX_FILE_BYTES` 512 KiB, `MAX_SYMBOLS_PER_FILE` 60. Rank is
how many of the last 300 commits touched the path (`touchCounts`).
`readIndex` is synchronous and cached on file mtime+size so the
dispatch path never scans the repo.

The standing note (`services.codeIndexNoteFor`) is appended to every
dispatched prompt, never stored in the transcript. Empty when there is
no index, `fileCount < MIN_FILES_FOR_NOTE` (20), or the disable env is
set. Whole-note cap `CODEINDEX_NOTE_MAX` 3500 chars.

## Store

`electron/store.js` persists JSON under Electron userData. Shape:

```
projects[], threads[],
messagesByThread{}, workLogByThread{}, usageByThread{},
workflowTemplates[], spendByDay{ "YYYY-MM-DD": number },
usageByDay{ "YYYY-MM-DD": { provider: { model: { costUsd, inputTokens,
            outputTokens, turns } } } },
settings: { dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null,
            autoSettleAfterDays: number | null, mcpServers[],
            defaultWorktree: boolean, defaultOrchestrate: boolean,
            updateChannel: "prod" | "nightly" | null, notifications: boolean,
            quotaWaitAutoResume: boolean, prDiffCapLines: number | null,
            otel: { endpoint, headers, claudeMetrics } }
```

`defaultOrchestrate` wins over `defaultWorktree` when `useCoder.createThread`
resolves the defaults — an orchestrator never holds a worktree itself, its
worker does — and `threads:create` applies the same precedence on the options.
Explicit `worktree` / `orchestrate` options override the defaults; both modes
are local-only, so remote projects always get plain threads.

Spaces (#568) are retired: leftover `spaceId` is dropped on load and never
persisted; `listSpaces` / create / update throw. The `spaces` key stays on
disk so old files still parse.

`updateThread` does not bump `updatedAt` unless the caller opts in (sidebar age
must reflect real activity). Interrupted "working" threads are recovered on load.

Transcripts are capped per thread (1000 messages / 500 work-log items, plus
overflow slack; oldest dropped, an event marker notes the gap) so the
single-blob stringify stays bounded. Debounced `save()` flushes write
tmp-then-rename off the event loop; `saveNow()` stays synchronous for
exit/shutdown/tests.

## Spend

Usage deltas from provider result events call `store.recordSpend`.
`app:status` returns `spendTodayUsd` (local day) + memory health.
`assertUnderDailyBudget` rejects `runs:start` / workflow start when
`spendTodayUsd >= dailyBudgetUsd`. Retention: spend buckets older than 90 days
are pruned.

Per-orchestration ceiling (issue #67): `orchestrationBudgetUsd` caps one
orchestrator's crew — its own turns plus direct `orchWorker` forks, summed
from `usageByThread.costUsd` (`services.orchestrationSpend`). Enforced by
`assertUnderOrchestrationBudget` in `flushOrchNotices` only: a crew at the cap
has its next wake-up refused and lands failed with the reason via the #34
surfacing path, while user-sent turns (Retry after raising the cap) still run.
Nested crews are not rolled up; each worker that fans out is its own
orchestrator.

## Quota wait

Provider usage-limit parking (issue #462), distinct from Solenta's own
budget cap and from model failover. Parsing and park/wake live in
`electron/quotaWait.js`; `src/quotaWait.ts` is the renderer clock
(`isQuotaWaitStatus`, `formatQuotaWaitLabel` — same local calendar
rules as snooze).

`decideQuotaWait` parks only on a quota-like error that carries a
parseable reset clock (`kind: "reset"`). Exhausted balance with no clock
is a hard fail — do not retry-storm. Solenta's own messages
(`OWN_BUDGET_RE`: daily budget / orchestration budget / crew auto-turn
cap / spend cap) never park. Waits longer than `MAX_WAIT_MS` (8 days)
are treated as a parse bug. Wake-once: `quotaWaitResumed` blocks a
second park. `startRun` stamps that flag from
`input.fromQuotaWait === true`, so a human send re-arms parking; only
the auto-resume (and banner `resumeQuotaWait`) consume the one-shot.

Default on: `settings.quotaWaitAutoResume` is true unless an explicit
false is on disk; per-thread `quotaWaitAutoResume` true/false/null
overrides (`quotaWaitEnabled`). `runner.markRunFailed` is the seam —
the first `threads:changed` never flashes Failed. Wake is
`scheduleQuotaWake` (`until + 2s`, min 1s) → `fireQuotaWake` which
re-sends the last user message with `fromQuotaWait: true`. Banner
`resumeQuotaWait` is the same one-shot. `working` and `quota-wait`
never auto-settle.

## Fleet analytics

Issue #375. Solenta launches every session and sees every commit, so the
"which agent is actually better for MY codebase" question is answerable from
ground truth rather than inference.

| Piece | Path |
|-------|------|
| Collector | `electron/fleet.js` → `fleet:evidence` (facts only) |
| Rollup | `src/fleet.ts` `summarizeFleet` (pure: evidence + range + now) |
| View | `src/components/FleetView.tsx` (`FleetReport` is a pure presenter) |
| Seam test | `electron/test/fleet-seam.test.js` — real collector into real rollup |

Evidence: `gh pr list --state all` (with `reviews`, via `listPrsRaw` so the
unknown-field fallback is not re-implemented), joined to threads by head
branch. **A PR with no matching branch is a HUMAN PR and is kept** — it is
the baseline the review tax divides by. Line durability uses the squash-merge
shape: the merge commit is found by `(#N)` in the subject on the default
branch, `git show --numstat` gives lines added and `git blame HEAD` counts
how many are still there. Blame is capped (`BLAME_COMMIT_CAP`) and the
shortfall is reported in `notes`, which the view renders — silent truncation
would read as full coverage.

Definitions that are deliberate, not incidental:

- **Merge rate** = merged / (merged + closed-unmerged). Open PRs are out of
  the denominator: an open PR is not a decision, and counting it as a failure
  would make a fleet look worse the faster it ships.
- **Close-without-merge** is reported *beside* merge rate, not as its shame.
  A superseded or duplicate fix closing unmerged is the system working.
- **Cost per MERGED PR**, not per token — `null` when nothing merged.
- **Durability** only counts threads past the 14-day window. Nothing
  measurable yet renders "not enough history", never "0% durable".
- **Review tax** = median agent open→first-review over median human. Median,
  because one PR reviewed three weeks later would swallow a mean.

### Felt vs actual (issue #401)

The perception gap has two halves that meet only in the rollup. The **felt**
half is a one-tap estimate asked once when a run completes
(`FeltEstimateCard` in `ThreadView.tsx`, buckets from
`FELT_ESTIMATE_BUCKETS_MS`), persisted as `ThreadInfo.feltEstimate`
(`{kind:"saved",savedMs,at}` or `{kind:"declined",at}`) via
`threads:setFeltEstimate` — never bumps `updatedAt`, clamped to
`FELT_ESTIMATE_MAX_MS`, decline recorded so the card never nags twice. The
**actual** half is the fleet evidence the collector already had (wall clock,
agent-active); the collector copies the estimate out as
`FleetThread.feltSavedMs` and `summarizeFleet` sums both sides over the
estimated threads into `FleetSummary.perception`. Ratios are `null`, never
`Infinity`, when the clock side is 0 — a ratio against nothing would read as
a verdict the data cannot support.

`null` and `0` mean different things everywhere in this feature, and the view
renders them differently.

## Observability

Solenta drives claude/codex/kimi/grok from the outside, so it is the only place
a cross-provider trace tree exists. Issue #280 makes that tree exportable.

| Piece | Path |
|-------|------|
| Exporter | `electron/otel.js`: OTLP/HTTP **JSON** POST to `<endpoint>/v1/traces`, batched like `session-record.js` |
| Emission | `electron/runner.js`: `startRun` opens, `notifyRunTerminal` closes, `appendMessage` + `noteToolSpan` bracket tool calls |
| Clustering | `electron/failuremodes.js` → `insights:failureModes` → `src/components/InsightsView.tsx` |

No `@opentelemetry/*` dependency: OTLP/JSON is a stable documented encoding, so
the exporter is a batched `fetch` of a plain object. Ids are **derived**, never
stored — `traceId` from the ROOT thread (walking `handoffFrom`), so an
orchestrator and its whole forked crew share one trace; `spanId` from the run id,
and tool span ids from `runId:toolId`. A restart mid-thread keeps the same trace.

Attributes follow the OTel GenAI conventions: `gen_ai.operation.name`,
`gen_ai.provider.name`, `gen_ai.agent.id` (provider + profile),
`gen_ai.request.model`, `gen_ai.usage.*`, and `session.id` = the **thread** id.

Claude Code's native metrics are not received, they are redirected:
`otel.claudeEnv()` returns `CLAUDE_CODE_ENABLE_TELEMETRY` +
`OTEL_EXPORTER_OTLP_*` pointed at the same collector, spread into the spawn via
`claude.js` `envExtra`. Because that is env-only it joins the warm-CLI reuse key
in `startClaudeRun` — otherwise a process spawned before the toggle would mask it.

Everything is inert while `settings.otel.endpoint` is null: nothing buffered, no
request made, no exception path into a run.

`insights:failureModes` clusters errored/stalled/retried threads by a
**normalized** error signature (paths, ids, numbers, quotes redacted) and ranks
by count then recency. Deterministic and computed on demand — no LLM, no stored
state, no scheduler.

## Hypothesis ledger

Agents write what they tried, and how it turned out, via the
`hypothesis_record` MCP tool. The ledger is never inferred from the
transcript. Entries live on the thread (`ThreadInfo.hypotheses`, newest-last,
capped) and `hypothesisNoteFor` injects the invalidated ones into the next
dispatch so a later agent, or a best-of-N fork, does not re-tread a dead end.

## Agent teams: shared task list and peer messaging

Issue #277. A **crew** is the thread at the top of the `handoffFrom` chain plus
every `orchWorker` under it (`services.crewRootOf`, cycle- and depth-guarded).
That root id keys one shared task list in `store.tasksByCrew`, so every worker
of one orchestration self-claims from the same list instead of waiting for the
lead to hand out work.

| Piece | Path |
|-------|------|
| Data layer | `electron/services.js`: `addCrewTasks` / `listCrewTasks` / `claimCrewTask` / `completeCrewTask` / `releaseCrewTasks` |
| Agent surface | `electron/orchServer.js`: `task_add`, `task_list`, `task_claim`, `task_complete`, `task_release`, `peer_send` |
| Delivery | `electron/runner.js`: `deliverNotice({ threadId, line })` |
| UI | `threads:crewTasks` → `src/components/AgentsPanel.tsx` |

**Dependency auto-unblocking is derived, never stored.** `blocked` is computed
from `needs` on every read, so completing a task opens its dependents with no
second write that could go stale; `completeCrewTask` returns exactly the tasks
that just became claimable and that list wakes the crew root. An unknown id in
`needs` is rejected at `task_add` — a typo must not block a task forever.

**Peer messaging reuses the orchestrator wake-up queue.** `deliverNotice` is
`flushOrchNotices` generalized: one queue, one delivery rule (idle thread runs
immediately, a busy one flushes at its own terminal). Worker-finished lines
still get the `[orchestration]` prefix; a caller-prefixed line (`[peer from …]`,
`[crew] finished t2 …`) keeps its own. So a backend worker sends the frontend
worker an API contract directly, without a round trip through the lead.

**Hand-offs are artifacts, not chat history.** Worktrees of one repo share a git
object store, so the durable hand-off is: commit `contract.md` on your branch,
put a `branch:path` ref in the task note or peer message, and the peer reads it
with `git show <branch>:<path>`. That convention lives in the coder-threads
MCP instructions — there is deliberately no artifact registry.

**Loop guardrails.** Three, all refusals rather than advice:

- `CREW_TASK_ATTEMPT_CAP` (3) — a fourth claim of the same task is refused and
  the crew has to escalate. `attempts[]` records who tried and the outcome each
  gave back.
- `services.crewTaskNoteFor` rides every dispatch of a thread holding a task and,
  when that task was attempted before or the thread's last run failed, forces a
  "what failed / am I repeating myself" answer *before* the retry.
- `CREW_AUTO_TURN_CAP` (25) — consecutive machine-delivered turns on one thread.
  Refused through the same undeliverable path as the orchestration budget gate
  (event + `failed` + `lastError`), and any user-sent turn resets the counter.

A failed run releases the thread's claims (`afterFailedTurn`) with the error as
the outcome, so a crashed worker never leaves a task stranded.

## coder-threads MCP

In-main orchestrator MCP server (`electron/orchServer.js`, name
`coder-threads`). Loopback HTTP on 127.0.0.1 with a bearer token at
`<userData>/orch-server.json`, same pattern as the memory server. Fails
soft: invalid config, missing SDK, or an unbindable port logs once and
the app continues without thread tools. Folded into every provider's MCP
injection alongside `coder-memory`. Built-ins are untouched by the user
MCP sync.

Every mutating tool takes `projectId` and rejects a thread outside it.
The standing note at the end of a dispatched prompt states the calling
thread's own ids so the agent does not guess from a title.

Host tools wrap the same actions as the sidebar / header:

| Tool | Action |
|------|--------|
| `threads_list` / `thread_status` | roster + last assistant line |
| `thread_fork` / `thread_send` | start a worker / continue one |
| `thread_archive` / `thread_settle` / `thread_stop` / `thread_rename` | sidebar lifecycle |
| `thread_merge` | squash the worker onto the caller's tree, then delete its worktree |
| `thread_pr` | push the worker branch and open a PR; leave the worktree for review |
| `work_suggest` | out-of-scope finding → one-click chip (`thread.suggestions`) |
| `hypothesis_record` / `spec_submit` / `teach_review` | mode-specific |
| `task_*` / `peer_send` | crew task list and peer messaging (above) |

`thread_merge` and `thread_pr` need `approved:true` on a user-started
turn (`assertUserApproved`), whether the target is the project's
default branch or the lead's own worktree — landing a worker is always
the user's call, and the question comes from the thread they are
talking to. A machine-delivered worker-finished notice cannot
self-approve. With several workers finished the lead asks once, names
the order, and merges in that order inside the answering turn. The one
unasked merge left is a *worker* that is itself a lead folding its
sub-crew onto its own branch; that branch is still gated upstream.
`work_suggest` never starts the work; the chip is Start a
thread / File on the planboard / Dismiss (`SuggestedWorkStrip` in
`ThreadView.tsx`).

## Orchestration commands

Issue #338. Three named compositions of machinery that already exists, behind
a one-word entry point, so multi-provider work is invoked instead of
choreographed by hand.

| Command | Workers | Shape |
|---------|---------|-------|
| `/handoff [@provider] <task>` | 1 | plan here, implement on a fresh model |
| `/advisor [@provider] <question>` | 1 | one read-only second opinion, reported back |
| `/committee [@a] [@b] <problem>` | 2 | contrasting models converge adversarially |

| Piece | Path |
|-------|------|
| Rules + prompts (pure) | `electron/orchcommands.js` |
| Dispatch | `electron/runner.js` `dispatchOrchCommand`, intercepted in `startRun` |
| Menu | `src/slashCommands.ts` + `src/components/Composer.tsx` |

**Orchestration is intercepted in the runner, not the renderer.** The
composer menu inserts `/handoff` `/advisor` `/committee` as text, so those
commands also work from an agent, a notice or the CLI path. The cheap
`/`-prefix test keeps the provider probe off the ordinary send path, and
`fromNotice` turns are never parsed — a worker quoting the command back
would otherwise fan out again.

Issue #472 grew the same `/` popup into the CLI verb palette
(`/compact`, `/rewind`, `/usage`, `/model`, …). Those verbs run existing
UI immediately and never become a prompt. Unknown `/foo` still goes to
the model. `/btw` stays insert-only so the send path intercepts it as a
side question (issue #471). `/goal` stays insert-only until its ticket
lands.

Issue #606 adds the underlying CLI's invocable skills and custom
commands to the same palette (`electron/cliCommands.js`
`listPaletteCommands` / `expandInvocableCommand`). Listing is for the
composer; expansion is for the runner: the transcript keeps the raw
`/name`, the CLI sees the expanded body. A name Solenta already owns
stays ours. Orchestration verbs never expand as skills even if a
`SKILL.md` exists. Skill-dir scanning follows the same symlink-farm
rule as `skills.scanSkillDir`.

**Defaults contrast on purpose.** Without `@provider` arguments the workers
are picked from the installed set *excluding the caller's own provider*.
Same-model agents are low-variance and make the same bad call systemically;
the multi-provider roster is the antidote, so the default must not collapse
to one model.

**Only `/handoff` gets a worktree.** A worker worktree branches from the
default branch, and a second opinion on the default branch is not a second
opinion on the work in progress — so `/advisor` and `/committee` run in the
project checkout and are pointed at the caller's checkout in their prompt.
They are read-only by contract, not by sandbox.

**Committee convergence runs between the members, not through the lead.**
Each member gets its peers' thread ids and argues via `peer_send` (the crew
messaging above), capped at three rounds and by `CREW_AUTO_TURN_CAP`. The
lead is woken by the ordinary worker-finished notices with what they agreed
on — there is no new state on the lead thread and nothing to clear.

A worker that fails to start is dropped as an orphan; peers that already
started keep running, and the lead's event message says which never went out.
Only an empty fan-out throws.

## Ask mode

Read-only repo Q&A (issue #392). Prompt + completion live in
`electron/ask.js`; `services.startAsk` / `stopAsk` own the thread flag;
the runner owns the turn. Same split as `orchcommands.js`.

`startRun` intercepts `thread.ask === true` **before** orchestration
commands, `assertUnderDailyBudget`, and worktree materialization, so a
`/advisor` on an Ask thread is just a question and a leftover
`pendingWorktree` cannot touch the disk. `startAsk` is idempotent, drops
`pendingWorktree`, and clears teach (the personas conflict); an already-
created worktree stays on disk unused. A fork of an Ask thread stays Ask
(`forkThread` refuses to arm a worktree). `startAskRun` also stamps
`pendingWorktree: false` and skips `notifyRunTerminal` (no checkpoint,
no spend).

The turn never starts a CLI tool loop. `completeAsk` tries `fm` first
(free, on-device, `ASK_TIMEOUT_MS` 90s), then the thread's provider in
print-mode (`buildAskArgs`: Claude `-p --max-turns 1` so a missed "no
tools" instruction cannot start a loop; no MCP, no session), then
`retrievalFallback` from the code map + memory. Print-mode spawn uses
`cwd: undefined`. Caps: `ASK_PROMPT_LIMIT` 80_000, `ASK_MAX_OUTPUT`
256 KiB, `MEMORY_HITS` 8. `askNoteFor` is the standing note if the
intercept is missed — empty when Ask is off.

## Side questions (`/btw`)

Issue #471. A mid-turn question that does **not** pause, steer, or queue
behind the live turn. Distinct from #156 (steer) and #468 (queued follow-up).

`/btw <question>` in the composer, or ⌥Enter on a plain draft, opens a
card on the **same** thread. The main run keeps going. Completions reuse
Ask mode (`completeAsk`: fm → print-mode → retrieval), with the parent
transcript digest as prefix. No worktree, no tools, no daily budget, no
transcript messages.

| Piece | Path |
|-------|------|
| Parse (renderer) | `src/btw.ts` `parseBtwCommand` — intercepts in `useCoder.startRun` **before** the busy-queue path |
| Parse + prompt (main) | `electron/btw.js` |
| Cards | `services.addBtw` / `finishBtw` / `dismissBtw` / `promoteBtw` on `thread.btw` |
| In-flight | `runner.startBtw` — a map separate from `active`, so `stopRun` does not kill them |
| UI | `BtwSideCard` in `ThreadView.tsx` |

The renderer intercept is load-bearing: while a run is `working`, a
normal send calls `threads.setQueued`. `/btw` must not. The runner
re-parses `startRun` before the "already active" throw as defense in
depth (IPC `runs.start`, idle send). `fromNotice` is skipped so a worker
quoting `/btw` cannot open a card on itself.

Dismiss drops the card (and kills an in-flight complete). Promote queues
the question via `setQueued` (then it is #468) and drops the card.
Caps: 3 in flight, 8 cards kept, 4000-char question. Running cards
become `error: Interrupted` on store load — the helper is gone after a
crash.

## Spec mode

Optional per-thread gate (issue #269): the agent writes `requirements.md`,
`design.md`, then `tasks.md` into `<worktree>/.solenta/specs/<slug>/`, and a
human approves each before the next opens. State is
`ThreadInfo.spec { slug, stage, awaitingApproval }`; the stage machine lives in
`electron/services.js` (`startSpec` / `stopSpec` / `submitSpec` / `reviewSpec`),
`specNoteFor` rides every dispatch until stage `build` or `stopSpec` clears
`thread.spec`, the agent submits with the `spec_submit` MCP tool, and
approving in the SpecCard advances the stage and starts the next run. Exit
spec mode (header or SpecCard) drops `thread.spec` without approving remaining
stages (issue #500). The gate is procedural, not sandboxed.

Once `tasks.md` is approved (stage `build`), Dispatch and Converge are
available (issue #537). Parser: `electron/specTasks.js` `parseTasksMd`.
Format is GitHub-style checkboxes; every other line is ignored:

```
- [ ] 1. Title (`src/foo.ts`) — req 1
- [ ] 2. Title (`src/bar.ts`) — req 2 — needs: 1
- [x] T3: Already done — needs: 1, 2
```

Ids are a leading `1.` / `1)` / `#1` / `T1:` token (`normalizeTaskId`:
`T1`, `t1`, `#1`, and `1` are the same id). A line with no id gets the
next unused 1-based number. `needs:` is a comma/space list of those
ids. Checked boxes (`[x]`) are done. Duplicate ids, self-needs, unknown
needs, and cycles (`taskWaves`) are errors — `dispatchSpec` refuses a
file with `parsed.errors.length > 0`. Waves are every remaining open
task whose still-open dependencies are already in a previous wave.

`services.dispatchSpec` (IPC `threads:dispatchSpec`) reads the artifact,
syncs checkboxes into the crew-task list (`syncSpecCrewFromParsed`:
match by title, add missing, complete already-ticked), and returns the
current claimable wave (`status === "open" && !blocked`). Services
never start runs. `ipc.js` then `forkSpecWave` (one `orchWorker` per
wave entry, `claimCrewTask`, `specDispatchPrompt`) and `startRun`s
each. A second click does not re-add existing titles. An empty wave is
not an error — `reason` explains blocked-on-deps vs nothing open.

`convergeSpec` (IPC `threads:convergeSpec`) starts a run on the spec
thread with `specConvergePrompt`: read the three artifacts plus the
repo, **append** missing checkboxes, do not implement, do not rewrite
or reorder, do not `spec_submit`. Also build-stage only.

## Renderer notes

- Composer model pill: always shown. Empty `models` → Default + Custom… (inline
  input, Enter commits, Escape cancels). Non-empty → Default + list only.
- setProvider validation lives in `electron/services.js` only. `src/devCoder.ts`
  assigns what the picker sends: it is a fixture, not a second contract.
- Permission card (issue #509, `electron/permissionCommand.js`): a proposed
  shell command is an editable field. Approving sends the edited command,
  never the original. Non-command tools keep the JSON preview.

## Pane workspace

Nested split-tree layout for the thread center pane (issue #552,
`src/paneLayout.ts`, `src/components/PaneWorkspace.tsx`). Binary tree,
two orientations; not a docking framework. Persistence is UI chrome
(`localStorage` `coder.paneLayout.<threadId>`), not store state.

`PANE_TYPES`: chat, diff, terminal, browser, files, tasks, subagent.
Shipped: **chat** (the transcript) and **diff** (Git — `ChangesPanel`).
The rest open a placeholder that reserves a slot. The header **Views**
menu opens / focuses a type; Environment “Open Git”, the next-git
Commit action, and `/review` call `onViewChanges`, which hydrates a
diff leaf (`hydratePaneLayout(..., { openDiff: true })`). This is the
first pane type toward #552; it is not the 520px overlay and not an
AgentsPanel tab (the right-rail Git tab is Environment cards, and
“Open Git” from there opens this pane).

## Build SHA mismatch

After `downloadUpdate` swaps the on-disk bundle, a reload can load the
new renderer into the old preload. `src/buildMismatch.ts`
`isBuildMismatch` compares compile-time `__BUILD_SHA__` with
`app.status().build.sha`; either side unstamped (dev tree, test fake)
is not a mismatch. On mismatch `App.tsx` mounts only
`BuildMismatchScreen` (Restart → `applyUpdate`) — the rest of the app
must not mount underneath (issue #538).

## Divergence

Opt-in compare of two runs of the same task (`src/divergence.ts`).
The header card (`data-divergence-card` in `ThreadView.tsx`) is
hidden unless `useDivergenceCardEnabled()` is on.

Both display prefs live in `src/uiPrefs.ts` (`makeFlagPref`) and are
toggled from the Environment tab (`DisplayPrefsCard` in
`AgentsPanel.tsx`): `coder.divergenceCard` for this card and
`coder.runDuration` for the "1m 45s" segment in the assistant message
footer at the end of a run (`durationByRunId` in `ThreadView.tsx`).
Both default **off** — only an explicit `"on"` enables them. Module
state is the source of truth, so a toggle still works when localStorage
does not persist; localStorage carries it across launches. The
collapsible "Worked for" run headers are unaffected.

Comparison is tool steps only (`extractSteps`): assistant prose always
differs across models, so including it would make every Claude-vs-Codex
pair "diverge at step 1". Fields in report order:
`DIVERGENCE_FIELDS` = type, name, input, output, decision. A length gap
is a verdict only when the shorter run has finished (`pending: true`
otherwise). Peers (`sameTaskPeers`): a fork compares with its source
and sibling forks (same `handoffFrom`); a source compares with its
children. Same-thread completed runs that called a tool are labeled
Run 1….

## Sidebar ordering and settle model

The sidebar follows the t3code (pingdotgg/t3code, MIT) sidebar behavior as a
model. No t3code code is vendored; the rules are reimplemented in
`src/sidebarGroups.ts` / `src/threadSettle.ts` / `src/threadSnooze.ts` /
`src/components/Sidebar.tsx`. The one third-party package this uses is
`@formkit/auto-animate` (MIT).

The live list is T3-flat: `Sidebar.tsx` calls `buildFlatSidebar`, not
`partitionSidebar`. Every card carries its own project slug
(`data-card-slug`); there are no project group headers.
`scopeProjectId` (localStorage `sidebar:projectScope`) filters every
section ("All projects" = null). `partitionSidebar` still exists as a
helper — `{ attentionThreads, later: { snoozed, settled, archived } }`
with precedence archived > snoozed > pinned-stays-active > settled —
and tests cover it; the UI does not call it. There is no
`data-later-shelf` and no `data-pinned-section`.

- **Static order**: activity NEVER reorders a row. A row moves only at a
  lifecycle transition (create, settle, unsettle, pin, snooze, archive).
  `updatedAt` is bumped per streamed message for unread dots and age
  labels and must never be used as an active-list sort key.
- **Partition precedence** (`buildFlatSidebar`, first match wins):
  archived → snoozed → pinned → settled → active. Same as
  `partitionSidebar` except pinned is its own top block.
  `effectiveSnoozed` (a live `snoozedUntil`) beats a pin; `isPinned`
  beats `effectiveSettled`.
- **Pinned block**: oldest `pinnedAt` first (`comparePinnedOldestFirst`).
  Rendered as full cards (`data-pinned`, `data-pin-flag`, ", pinned" in
  `aria-label`). A `data-pinned-divider` follows when the block is
  non-empty.
- **Active list**: `createdAt` desc (legacy NaN `createdAt` falls back to
  `updatedAt`), then `attachForks` so `handoffFrom` children sit under
  their source (`data-nested`). Search bypasses shelves and renders a
  flat hit list.
- **Snoozed shelf**: wake-soonest (`compareSnoozedWakeSoonest`). Collapsed
  by default; expand persists in `sidebar:snoozedOpen`. Toggle is
  `data-snoozed-shelf-toggle`. Snooze is visibility only
  (`ThreadInfo.snoozedUntil`); it never touches the agent. A thread
  wakes early when it raises its hand (`awaitingInput`, or a
  `failed`/`done` `updatedAt` newer than `snoozedAt`). Timer wakes are
  client-derived.
- **Settled shelf**: settled newest (`compareSettledNewestFirst` via
  `resolveSettledTimestamp`) then archived (`updatedAt` desc) as one
  paged tail (`SETTLED_TAIL_INITIAL_COUNT` 10; each "Show more" adds
  `SETTLED_TAIL_PAGE_COUNT` 25, `data-settled-more`). Collapsed by
  default; expand persists in `sidebar:settledOpen`. Toggle is
  `data-settled-shelf-toggle`. Archived slim rows carry `data-archived`
  and `data-unarchive-btn`. The retired key
  `coder.sidebar.settledCollapsed` is unused.
- **Settle resolution** (`effectiveSettled`): `working` and `quota-wait`
  never settle; a finite `pinnedAt` never auto-settles; explicit
  `settledOverride` (`"settled"` / `"active"`) wins; CLOSED always
  settles; MERGED settles when `autoSettleOnMerge` is not false (store
  default true); OPEN PR blocks; otherwise the inactivity window
  (`settings.autoSettleAfterDays`, default `AUTO_SETTLE_AFTER_DAYS` = 3;
  null disables the inactivity path).
- **Animation**: `auto-animate` (150ms ease-out) on `data-sidebar-list`;
  rows key as `${id}:card` on the inbox vs `${id}:slim` on shelves so a
  settle move cross-fades instead of sliding. The open thread and a
  `revealThreadId` target are carved out of a collapsed shelf so they
  never vanish.
- **New-thread reveal**: creation sets `revealThreadId` in `App.tsx`; the
  sidebar scrolls `[data-thread-card="<id>"]` into view and flashes a
  highlight. The global "+" names its target project
  ("New thread in \<slug\>"). Create options (worktree / orchestrator /
  plain / teach / ask / from-issue) live on the header caret, not as
  per-project clusters in the list.
- **Native thread-actions menu** (issues #592 / #594): right-click or ⋯
  calls `showContextMenu` (`src/contextMenu.ts`) — Electron
  `Menu.popup` when the preload bridge is present, otherwise a
  `position:fixed` portal. Items from `buildThreadActionMenuItems`
  (snooze as a parent with children, pin, fork / handoff, rename, mute,
  settle). Never an in-card overlay inside the sidebar scroller.
- **Project icons** (`electron/projectIcon.js`): user override, then a
  checked-in `solenta.json` / `t3.json` `iconPath`, then well-known
  favicon / app-icon files, then `<link rel="icon">`. Cached per
  git-common-dir so worktrees of the same repo share the main
  checkout's answer. `iconUrl` is never persisted.
- **Nested workers**: `attachForks` puts `handoffFrom` children under
  their source (`data-nested`). Running in-agent subagents render as
  up to three name rows under the wait row (issue #542); a click falls
  through to the parent thread.
