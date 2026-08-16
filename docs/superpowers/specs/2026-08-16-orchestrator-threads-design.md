# Orchestrator threads design

Approved 2026-08-16.

## What it is

A third thread mode. Today a thread is either plain (runs in the project
checkout) or a worktree thread (runs in its own `coder/<slug>-<id>` worktree).
Both do the work themselves.

An **orchestrator thread** does not. Its first prompt is forked to a worker
thread — which gets the worktree and does the work — and the orchestrator
supervises. No LLM judgement is involved in that first hop: the fork is
deterministic, so the orchestrator burns no tokens deciding to delegate.

From the second prompt on it is an ordinary orchestrator thread: the LLM runs,
holds the coder-threads tools, and can fork more workers, relay with
`thread_send`, or answer directly.

## Behaviour

1. Create an orchestrator thread. Nothing runs; no worktree is created.
2. Send a prompt. The runner forks a worker (own worktree + branch), starts the
   worker's run with that prompt verbatim, and writes to the orchestrator's
   transcript: the user message, plus an event line naming the worker. The
   orchestrator itself does not spawn a CLI.
3. The worker finishes. The existing `orchNotices` path wakes the orchestrator
   with `[orchestration] …` — the LLM takes over from here.
4. Later prompts run the orchestrator's LLM normally.

**Orchestrator threads never hold a worktree of their own.** The worker holds
it. `orchestrate` therefore wins over `worktree` and over the `defaultWorktree`
setting, so there is no third combination to reason about.

## Backend

`pendingFork: true` on the thread — a lazy flag consumed at first run, exactly
mirroring `pendingWorktree`.

`runner.startRun` gains one branch, placed straight after the thread lookup and
before the provider/binary/worktree gates (those belong to the run that will
actually happen — the worker's):

```
if (thread.pendingFork) → fork, dispatch to the worker, clear the flag, return
```

The fork body is what `orchServer.thread_fork` already does: `forkThread(store,
{ threadId })`, then `updateThread(fork.id, { orchWorker: true, pendingWorktree:
true })` when `canHostWorktree(project)`, then `runner.startRun({ threadId:
fork.id, prompt })`. Extract that into one shared helper so the MCP tool and the
runner cannot drift apart. The forked worker has no `pendingFork` of its own, so
there is no recursion.

`orchWorker` + `handoffFrom` are what the wake-up, budget-ceiling, crew-sweep,
and auto-archive machinery already key on, so all of it applies unchanged —
including the per-orchestration budget cap.

Failure: if the worker's `startRun` throws (missing CLI, budget), the call
rejects and the composer shows the error. `pendingFork` stays set so the next
prompt retries. Same contract as a failed lazy worktree.

## IPC & settings

- `threads.create(input)` accepts `orchestrate?: boolean`; true sets
  `pendingFork` and ignores `worktree`. Remote projects reject it, like
  worktrees.
- `SettingsInfo.defaultOrchestrate: boolean` — plain "New thread" creates an
  orchestrator thread. Normalized like `defaultWorktree`: absent or junk →
  false. When both defaults are on, `defaultOrchestrate` wins.
- `devCoder` mirrors both.

## Renderer

- **Sidebar.** The caret menu drops its `defaultWorktree` conditional and always
  lists the three explicit modes: *New worktree thread*, *New orchestrator
  thread*, *New plain thread*. The plain "New thread" button keeps following the
  settings default.
- **Settings.** A `defaultOrchestrate` checkbox beside the existing worktree
  one.
- **Planboard.** A second native `<select>` in the board header — *Start as:
  Default / Plain / Worktree / Orchestrator* — feeding the existing **Start
  task** path, which today calls `createThread(issue.title, projectId)` with no
  mode. Board-level, not per card: no menu code, no per-card duplication.

## Tests

`electron/test/`, matching the existing runner/store test style:

- First run on a `pendingFork` thread creates a worker with `orchWorker` and
  `handoffFrom`, starts the worker's run with the prompt, and spawns no CLI for
  the orchestrator.
- The flag clears: the second prompt runs the orchestrator normally.
- A failed worker dispatch leaves `pendingFork` set.
- `defaultOrchestrate` normalization (absent/junk → false, boolean kept,
  persists), alongside the existing `defaultWorktree` cases.

## Skipped (YAGNI)

Per-project orchestrate defaults; picking the worker's provider at creation
time; fanning one prompt out to N workers; an orchestrator badge in the sidebar
(the worker rows already show the crew).
