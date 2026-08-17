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
            otel: { endpoint, headers, claudeMetrics } }
```

`defaultOrchestrate` wins over `defaultWorktree` when `useCoder.createThread`
resolves the defaults — an orchestrator never holds a worktree itself, its
worker does — and `threads:create` applies the same precedence on the options.
Explicit `worktree` / `orchestrate` options override the defaults; both modes
are local-only, so remote projects always get plain threads.

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

## Spec mode

Optional per-thread gate (issue #269): the agent writes `requirements.md`,
`design.md`, then `tasks.md` into `<worktree>/.solenta/specs/<slug>/`, and a
human approves each before the next opens. State is
`ThreadInfo.spec { slug, stage, awaitingApproval }`; the stage machine lives in
`electron/services.js` (`startSpec` / `submitSpec` / `reviewSpec`),
`specNoteFor` rides every dispatch until stage `build`, the agent submits with
the `spec_submit` MCP tool, and approving in the SpecCard advances the stage
and starts the next run. The gate is procedural, not sandboxed.

## Renderer notes

- Composer model pill: always shown. Empty `models` → Default + Custom… (inline
  input, Enter commits, Escape cancels). Non-empty → Default + list only.
- setProvider validation lives in `electron/services.js` only. `src/devCoder.ts`
  assigns what the picker sends: it is a fixture, not a second contract.

## Sidebar ordering and settle model

The sidebar follows the t3code (pingdotgg/t3code, MIT) sidebar behavior as a
model. No t3code code is vendored; the rules are reimplemented in
`src/sidebarGroups.ts` / `src/threadSettle.ts` / `src/components/Sidebar.tsx`.
The one third-party package this uses is `@formkit/auto-animate` (MIT).

- **Static order**: threads within a project group, and the groups themselves,
  sort by `createdAt` (newest first). Activity NEVER reorders the list; a row
  moves only at a lifecycle transition (create, settle, unsettle, pin, snooze,
  archive). `updatedAt` is bumped per streamed message for unread dots and age
  labels and must never be used as a sidebar sort key.
- **Partition precedence**: snoozed → pinned → settled → attention
  (`partitionSidebar`). Settle resolution in `effectiveSettled`: working and
  pinned never settle, explicit override wins, MERGED/CLOSED PR settles, OPEN
  PR blocks, otherwise inactivity window (`AUTO_SETTLE_AFTER_DAYS`, default 3).
- **Settled tail**: one global section, expanded by default (collapse persists
  in `coder.sidebar.settledCollapsed`), paged 10 + "Show 25 more".
- **Animation**: `auto-animate` (150ms ease-out) per list container; rows key
  as `${id}:card` in groups vs `${id}:slim` on shelves so a settle move
  cross-fades instead of sliding.
- **New-thread reveal**: creation sets `revealThreadId` in `App.tsx`; the
  sidebar expands the target project group, scrolls the card into view, and
  flashes a highlight. The global "+" names its target project
  ("New thread in \<slug\>").
