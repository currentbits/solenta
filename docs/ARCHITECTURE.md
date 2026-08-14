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
| Dev mock | `src/devCoder.ts` | In-browser `CoderApi` for Vite without Electron |
| Hook | `src/useCoder.ts` | State, subscriptions, error banners |

`CODER_PROD=1` or packaged builds load `dist/`; otherwise main points at the Vite
dev server.

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
settings: { dailyBudgetUsd: number | null }
```

`updateThread` does not bump `updatedAt` unless the caller opts in (sidebar age
must reflect real activity). Interrupted "working" threads are recovered on load.

## Spend

Usage deltas from provider result events call `store.recordSpend`.
`app:status` returns `spendTodayUsd` (local day) + memory health.
`assertUnderDailyBudget` rejects `runs:start` / workflow start when
`spendTodayUsd >= dailyBudgetUsd`. Retention: spend buckets older than 90 days
are pruned.

## Renderer notes

- Composer model pill: always shown. Empty `models` → Default + Custom… (inline
  input, Enter commits, Escape cancels). Non-empty → Default + list only.
- Dev validation for setProvider mirrors the contract in `src/devCoder.ts`.

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
