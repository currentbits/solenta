# Teleport: move a live thread between this Mac and a remote host (#1702)

Slice 1: Claude only, local → remote, idle threads only, plus Teleport back.
Done when a thread started locally continues its Claude session on the
remote with the same branch, uncommitted diff, model and effort.

## Transport

Reuse Remote Connections (`electron/remoteConnections.js`): the same
`readRemoteToken` prepare step, SSH tunnel with `StrictHostKeyChecking=yes`,
and web token. No window is opened. The local main process opens a short
tunnel, authenticates on `/ws`, makes one `invoke`, and closes. The thread
then lives in the remote Solenta's own store, so it keeps running with the
laptop lid closed. (Rebinding to an ssh-wrapped `remoteHost` project would
not: the laptop still drives the run.)

Targets are the saved connections the Connections pane keeps in renderer
localStorage (`coder.remoteConnections`). Desktop only.

## Payload (both directions)

```
{
  version: 1,
  provider: "claude",
  originSlug,            // owner/repo of `origin`
  branch,                // thread branch
  head,                  // sha of HEAD
  bundle,                // base64 `git bundle create - HEAD --not --remotes=origin`, or "" when origin has HEAD
  patch,                 // base64 `git diff --cached --binary HEAD` via a temp index after `add -A`
  sessionId, session,    // Claude jsonl text, "" when the thread has no session yet
  thread: { title, model, reasoningEffort, permissionMode, baseBranch },
  messages,              // Solenta transcript, verbatim
  ignored,               // ignored paths that stay behind (informational)
}
```

Nothing is pushed to origin. Payload capped at 50 MB.

## Q1 What moves

The native Claude jsonl. Sender: `findClaudeSessionFile` against the
thread's Claude home (provider-instance aware). Receiver writes
`<claude home>/projects/<encodeClaudeProjectDir(realpath(worktree))>/<sessionId>.jsonl`
and rewrites each line's top-level `cwd` to the new worktree. Other
providers (#1817) send no session (`sessionId: null`, `session: ""`); the
receiving thread gets `replayContext: true`, so its first turn replays the
transcript. Same on the way back. Queued prompts (`thread.queued`) travel
both ways.

## Q2 Git state

Bundle of the commits origin lacks, plus a binary patch of uncommitted and
untracked non-ignored files. Receiver: `git fetch origin`, `git bundle
verify`, fetch the bundle head into `refs/heads/<branch>`, create the
worktree through `setupWorktree`'s `retainedBranch` path, `git apply` the
patch. Gitignored files stay where they are and are listed in the result.

## Q3 Refusals

- Run active without `stop: true` (the menu offers "Stop and teleport to…",
  which stops the run and waits up to 30 s for idle), or quota-wait.
- Queued prompts with files attached (the files are paths on this disk).
- Thread has no worktree (it would mutate the project checkout).
- Thread already teleported away.
- Remote too old (no `threads:teleportIn` channel, or it only reads v1
  payloads: v2 adds `provider`, `originUrl`, `queued`; v1 is still read).
- Remote has no project whose origin slug matches and the payload has no
  `originUrl` (v1). With one, the remote clones origin beside its most
  recently added local project (else `~/code`) and adds it.
- The thread's provider is not available on the remote (or locally, for
  Teleport back).
- Effort not honoured for the model on the remote (model id copied
  exactly; skipped for providers without efforts).
- Branch exists on the receiving side and the incoming head does not
  fast-forward it.
- Bundle prerequisites missing after fetching origin.
- Payload over the cap.

## Q4 Thread record

Two stores, so the remote gets a new thread (same title, messages, model,
effort, permission mode, sessionId, branch) tagged
`teleportedFrom: { threadId }`. The local thread is kept and marked
`teleportedTo: { host, remotePort, label, threadId, at }`; `startRun`
refuses while it is set and the thread view shows a banner with
Teleport back. `handoffFrom` is not used: crew and merge code read it as
lead/worker ownership.

## Teleport back

Local invokes `threads:teleportOut { threadId }` on the remote (same
refusals). The remote builds and returns the payload without changing
anything. Local applies it to the original thread: refuse if the local
worktree changed since it left (the snapshot tree is kept in
`teleportedTo.tree`), fast-forward the branch to the incoming head (refuse
if not a fast-forward), reset the worktree to that head, apply the patch,
overwrite the jsonl, replace messages, clear `teleportedTo`. Only then does
local invoke `threads:setArchived` on the remote. If that last call fails,
the remote copy stays visible there; nothing is lost. If the remote thread
is gone, Teleport back unlocks the local copy as it was when it left.

Sending sets `teleportedTo { pending: true }` before the invoke so no run
starts mid-transfer; a failed send clears it, and boot clears any pending
flag a quit left behind. Big replies sit over the web bridge's 4 MiB push
buffer limit while they drain, so pushes skip that socket until the reply
is flushed instead of terminating it.

## Code

- `electron/teleport.js`: `packThread`, `applyPayload`, `relocateClaudeSession`,
  refusal checks. Pure fs/git; no Electron.
- `electron/remoteConnections.js`: `invokeRemote(input, channel, args)` —
  tunnel + auth + one invoke, no window. `spawnTunnel` is shared with
  `openRemoteConnection`.
- IPC: `threads:teleportIn`, `threads:teleportOut` (host side, any
  transport with full scope); `threads:teleport`, `threads:teleportBack`
  (desktop only, drive the above).
- Runner: refuse `startRun` while `teleportedTo` is set.
- Renderer: "Teleport to…" thread menu entry listing saved connections
  (`src/remoteHosts.ts`); composer status strip with Teleport back on a
  teleported thread.

## Tests

- Pack/apply round trip against real temp repos (bare origin + two clones):
  committed-not-pushed commits, modified, deleted, and untracked files,
  ignored files left behind.
- jsonl relocation rewrites `cwd` and lands under the encoded dir.
- Each refusal.
- Transport with a fake invoke. `prepareHostCommand` is never run on the
  dev Mac.
