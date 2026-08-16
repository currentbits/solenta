# Cross-project read reach

Issue #109, second half. The first half shipped in PR #111 (`a12bd26`): a
thread can no longer spawn workers in another project's repo. That fix
deliberately deferred the other thing the issue asked for — "go look at how
project X does this" — until the leak fix had been lived with. This is that
piece.

Standing ruling, unchanged: **a run must never write to a second repo.** This
design only adds reading.

## What is actually true today

The starting assumption for a feature like this is that there is a sandbox to
open. There is not.

Solenta passes no sandbox or approval flags to any provider. Checked against
`electron/providers.js`:

- **grok** (`:275`) — headless `-p` has no prompt channel at all, so asking
  modes are mapped to grok's non-prompting `auto`. Tools run unprompted.
- **kimi** (`:475`) — `-p` cannot combine with `-y`/`--auto`; prompt mode runs
  tools unprompted regardless and the permission mode is ignored.
- **opencode** (`:393`) — `run --format json`, no permission flag emitted.
- **codex** (`:199`) — `exec --json --skip-git-repo-check`. Confined only by
  codex's own default sandbox, which Solenta never overrides.
- **claude** (`:117`) — the only one with a permission channel
  (`--permission-prompt-tool stdio`), routed to the UI at `runner.js:1667`.

So on four of five providers an agent can already read *and write* anywhere on
disk. This feature grants no capability that is not already there. What it adds
is: the agent being **told** which other checkouts exist and that they are
read-only, and — on claude, the one provider that stops to ask — reads under
those roots not costing a click per file.

`--add-dir` is the wrong instrument and is not used: it makes a directory a
full workspace directory, which grants writes there.

## Design

### 1. Thread field

`readProjectIds: string[]`, default `[]`, added to the thread shape in
`createThread` (`electron/services.js:294`).

A new `threads:setReadProjects` IPC handler alongside the other `threads:set*`
handlers (`electron/ipc.js:260`–`301`), calling a services function that:

- rejects ids with no project in the store,
- rejects the thread's own `projectId`,
- dedupes,
- broadcasts `threads:changed` like its siblings.

A helper `readRootsFor(store, thread)` resolves the ids to
`[{ name, path }]` for consumers. It filters, at read time rather than by
migration:

- ids whose project has since been deleted,
- projects with a `remoteHost` — their checkout is not on this disk, and the
  claude auto-allow below reasons about local paths only.

Read-time filtering means deleting a project cannot leave a thread pointing at
a root that no longer exists.

### 2. What the agent is told

`selfIdNoteFor` (`electron/services.js:511`) currently emits one sentence,
gated on the `coder-threads` MCP server being registered — with no thread
tools in the run, thread ids are noise.

That gate is wrong for read roots, which matter whether or not the
orchestrator is running. So the note splits into two independently gated
parts:

- the existing thread-id sentence, gated on `coder-threads` as today;
- a read-roots sentence, emitted whenever `readRootsFor` returns a non-empty
  list.

The read-roots sentence names each project and its absolute path, and states
that they are readable and must not be written to, edited, built in, or
touched with state-changing git commands. The existing "threads in other
projects are off limits" clause stays exactly where it is, in the thread-id
sentence: thread reach and file reach are separate permissions, and granting
one must not read as granting the other.

On grok, kimi and opencode this sentence is the entire mechanism. It is
instruction, not enforcement, and gets a `ponytail:` comment naming that
ceiling, next to the equivalent one on `assertSameProject`
(`electron/orchServer.js:220`).

### 3. Claude auto-allow

A pure helper — `autoAllowRead(toolName, input, roots)` — lives in a new CJS
module `electron/readReach.js`, testable without spawning anything. (Not
`core/`: that package is the TypeScript workflow engine, built to `core/dist`
and reached through a dynamic import; every pure main-process helper in this
codebase — `links.js`, `pathEnv.js` — is a plain CJS module next to its
caller.) It returns true only when **both** hold:

- `toolName` is one of `Read`, `Grep`, `Glob`, `NotebookRead`;
- every path-shaped input value (`file_path`, `path`, `notebook_path`)
  resolves under one of the roots.

Absent or empty roots return false. A tool with no path input returns false —
an unanchored `Grep` runs against the run's own cwd and needs no grant.

The `can_use_tool` branch (`electron/runner.js:1667`) consults it before
queueing a prompt and, on a hit, responds `allow` immediately: no
`pendingPermissions` entry, no `awaitingInput` flip, no UI noise. The tool call
still appears in the timeline as a normal `tool_use` message, so the read is
visible after the fact.

Everything else — `Edit`, `Write`, `Bash`, unrecognised tools — prompts exactly
as it does today. A write into the other repo therefore remains a decision the
user is shown and makes.

Path containment is `path.resolve` plus a separator-anchored prefix match. No
`realpath`: a symlink inside a root pointing out of it reads as inside. That is
a deliberate shortcut with a `ponytail:` comment naming `realpath` as the
upgrade path if it ever matters.

### 4. UI

A "Read access" submenu in the thread overflow menu
(`src/components/ThreadView.tsx:2246`), built the same way as the handoff
provider submenu directly above it (`:2136`): the workspace's other local
projects, each a checkmark toggle, one IPC call per toggle. Remote-host
projects are omitted from the list — `readRootsFor` drops them anyway, so a
disabled row would only be noise.

The overflow menu button is already disabled while a run is working, so no
extra guard is needed against changing reach mid-run.

Nothing else in the UI changes. Diff, commit, PR, worktree state and the
sidebar stay keyed on the owning project, because writes still only ever land
there. This is the same answer #109's three open questions already received
from the guard work: nothing changes.

## Tests

- **Pure** (`electron/test/read-reach.test.js`): `autoAllowRead` matrix — read tool inside a root; read
  tool outside every root; a `..` escape that resolves outside; `Edit` and
  `Bash` inside a root; empty roots; tool with no path input.
- **Services**: `readRootsFor` drops unknown ids, the thread's own project and
  remote projects; the note contains each root's path and the read-only
  wording; the note's thread-id half stays gated on `coder-threads`.
- **Fork**: a fork inherits `readProjectIds` from its source, alongside
  `permissionMode`.
- **IPC**: `threads:setReadProjects` rejects an unknown id and the thread's own
  projectId.

## Out of scope

- Cross-project **writes** in any form. Unchanged ruling.
- Worktrees or branches in a second repo.
- Grouping diff/commit/PR views by project — nothing writes elsewhere, so
  there is nothing to group.
- Classifying read-shaped `Bash` (`git log`, `cat`, `rg`) for auto-allow. Those
  prompt. A command classifier is a known-fragile thing to get right and can be
  added later if the prompts prove annoying in practice.
- Reach into remote-host projects.
- Any attempt to enforce read-only on grok, kimi or opencode. Not possible
  without a permission channel those CLIs do not have.
