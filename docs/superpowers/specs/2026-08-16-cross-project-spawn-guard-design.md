# Cross-project spawn guard

Issue #109, reframed. Filed as "let a thread act in another project"; the real
finding is that a thread *already* acts in another project, by accident, with
no guard rail. The user's ruling: a run must never write to a second repo.

## The incident

A thread in another project, 2026-08-16 12:48–13:10. An agent working in
that second checkout called `thread_fork({threadId: "260be2c1"})`
— a thread belonging to **Solenta**. Two grok workers spawned on git worktrees
of the wrong repo. Told off, it repeated the mistake four minutes later with
`9fafc689`, guessing from the title "changelog and website". Cleanup cost two
deleted branches and a removed worktree.

The agent's own diagnosis:

> "I have no way to see which project a thread belongs to — `threads_list`
> returns id, title, provider, status, nothing about the workspace — so every
> fork I make is a guess, and guessing is exactly what caused this."

Three leaked worker threads survive in the store, archived.

## Root cause

`thread_fork(threadId)` takes its source thread as an **argument**. There is no
caller identity anywhere in `electron/orchServer.js`: one workspace-wide bearer
token, stateless HTTP (`sessionIdGenerator: undefined`). So the server cannot
know who is calling, and the caller must name a thread.

Naming one is necessarily a guess, because:

- the agent is never told its **own** thread id, and
- `threads_list` does not say which **project** any thread belongs to.

Everything downstream is already correct when the caller passes its own thread
id: the fork lands in the caller's project, the digest is the caller's own
context, the wake-up notice returns to the caller. The entire bug is that the
agent cannot know its own id.

`thread_send` has the same hole — it starts a run on any threadId with no check.

## Design

Three changes. No new feature, no UI change, no schema change. Because each
thread stays bound to exactly one project, the diff/commit/PR/worktree views
are untouched, which answers all three of issue #109's open questions with
"nothing changes".

### 1. `threads_list` reports the project

`electron/orchServer.js` — each row gains `projectId` and `projectName`. This
is the field whose absence the agent named as the reason it guessed.

### 2. Every run learns its own identity

`electron/services.js` gains `selfIdNoteFor(thread, project)`, a sibling of the
existing `planboardNoteFor`: a short CLI-only note, never stored in the
transcript, appended at the single prompt finalization point
(`electron/runner.js`, `dispatchPrompt`).

```
[Thread] You are thread <id> in project "<name>" (projectId <id>), checked out
at <cwd>. Pass this threadId and projectId to coder-threads tools; never guess
another thread's id.
```

It rides every dispatch, like the planboard note, so it survives context
compaction and resumed sessions rather than being a first-turn-only fact.

### 3. `thread_fork` and `thread_send` require a stated `projectId`

Both gain a required `projectId` param. The server compares it to the target
thread's `projectId` and throws, naming both projects, when they differ.

Change 2 makes stating it free; the assert converts a wrong guess from two grok
workers on the wrong repo into a loud error. A same-project fork of a sibling
thread still works — the assert only blocks crossing a project boundary.

`thread_send` gets the same guard even though the incident used `thread_fork`:
one guard, both callers.

## Known ceiling

The assert is a **self-declared claim, not proof**. A caller that states a
projectId matching the thread it names passes, whatever project it actually
runs in.

Real caller identity would need a per-run bearer token mapped to a threadId.
Rejected as too expensive for this failure: claude and codex take per-run MCP
config, but grok and kimi register the server globally
(`grok mcp add … -s user`, `~/.kimi-code/mcp.json`), so a per-run token cannot
reach them without racy global config rewrites — and the incident's workers
were grok.

This failure mode is a confused agent, not a malicious one, and confusion is
exactly what a stated assertion catches. Upgrade to per-run tokens only if an
adversarial caller ever matters. Marked with a `ponytail:` comment in the code.

## Check

`electron/test/orch-server.test.js` already drives the handlers spawn-free via
the exported `createToolHandlers`. Added: a fork with a foreign `projectId`
throws and starts no run; a fork with the matching one succeeds.

`thread_status` is deliberately left unguarded: it is read-only and cannot
start anything, and `threads_list` already exposes every thread's title across
projects. A required param there would cost callers something and buy no safety.

The note is emitted only while `coder-threads` is registered — with no thread
tools in the run there is nothing to pass the ids to. This keeps it out of
every prompt in test and orchestrator-down runs, matching `planboardNoteFor`'s
GitHub-origin gate.

## Out of scope

- Cross-project **writes** in any form (user: "It should not ever do that").
- Read-only reach into another project ("go look at how X does this"). Deferred
  until the leak fix has been lived with.
- Purging the three leaked worker threads — cosmetic, user's call.
