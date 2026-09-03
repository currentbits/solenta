# Solenta Session Blocker Issue Drafts

These issues were found while planning live speech-to-text in Solenta thread
`15ff9829-4446-44ad-92a2-c4e14e991e05` on 2026-09-03. Each section is ready
to paste into a separate issue in `currentbits/solenta`.

## Issue 1: Explicit Grok worker forks are impossible when approval policy is `never`

**Labels:** `plan:todo`

### Problem

A user explicitly requested that Grok workers build a plan and later required
that implementation be performed only by Grok workers. The same-project
`coder-threads` fork was still rejected because the session approval policy was
`never`.

The relevant request was equivalent to:

```json
{
  "tool": "mcp__coder_threads__thread_fork",
  "projectId": "bdfb084e-f13d-4968-83eb-5bc85b5dd515",
  "threadId": "15ff9829-4446-44ad-92a2-c4e14e991e05",
  "pool": "grok",
  "worktree": false,
  "prompt": "Read-only planning review for Solenta speech-to-text"
}
```

Result:

```text
MCP tool call requires approval, but approval policy is never
```

The failure repeated after the user explicitly confirmed the Grok-only
constraint. `task_add` and `hypothesis_record` were rejected for the same
reason. `thread_fork` has no `approved` argument, so there is no callable
recovery path inside the session.

### Fallback evidence

The installed Grok CLI was also tried as a read-only fallback:

```text
grok 1.0.13 (5e9a58528b76) [stable]
```

Its normal home directory was not writable:

```text
Couldn't create session: Permission denied.
code: FS_PERMISSION_DENIED
detail: Operation not permitted (os error 1)
```

Pointing `GROK_HOME` at `/private/tmp` allowed session creation, while keeping
authentication/config paths read-only. Inference then retried and failed on:

```text
request error: error sending request for url
(https://cli-chat-proxy.grok.com/v1/responses)
```

This leaves no usable Grok-worker route: the first-party orchestrator requires
an approval the policy cannot provide, and the local CLI cannot reach its
backend from the sandbox.

### Impact

- Explicit user requests for orchestration cannot be fulfilled.
- A Grok-only implementation constraint makes the task permanently blocked.
- The agent may waste time retrying tools or building unreliable CLI
  workarounds.
- The shared task list and hypothesis ledger cannot be maintained even though
  the prompt requires them.

### Expected behavior

For same-project, non-destructive worker creation, one of these must hold:

1. an explicit user request in the current turn authorizes `thread_fork`; or
2. Solenta exposes a user-visible approval action that remains usable when the
   general session policy is `never`; or
3. the tool is omitted and the prompt states up front that orchestration is
   unavailable.

The system must not advertise a required tool and then reject it through an
approval state that has no transition.

### Suggested fix direction

- Classify same-project `thread_fork` as an in-scope operation when the current
  user turn explicitly asks for Grok workers.
- Keep cross-project guards and merge/PR approval requirements unchanged.
- If policy still blocks the fork, return an actionable error naming the
  exact UI/session change required.
- Apply the same capability check to crew task and hypothesis tools so the
  prompt does not require unreachable bookkeeping.

### Acceptance criteria

- With `approval policy = never`, an unrequested worker fork remains denied.
- With the same policy and an explicit current-turn request to use Grok
  workers, a same-project `thread_fork(pool="grok")` starts successfully, or
  Solenta presents a usable user approval action.
- The worker is created in the supplied project and cannot cross the
  `projectId` boundary.
- `task_add` and `hypothesis_record` are usable whenever the orchestrated run
  they describe is usable.
- A blocked fork fails immediately with one actionable resolution; it does not
  invite retries that can never succeed.

---

## Issue 2: Managed worktrees cannot run `git add` or `git commit` because their Git metadata is read-only

**Labels:** `plan:todo`

### Problem

The managed worktree itself is writable, but its `.git` file points to linked
worktree metadata beneath the primary checkout:

```text
cwd:
/Users/willem/Library/Application Support/Solenta/worktrees/15ff9829-4446-44ad-92a2-c4e14e991e05

.git:
gitdir: /Users/willem/code/coder/.git/worktrees/15ff9829-4446-44ad-92a2-c4e14e991e05

git rev-parse --git-common-dir:
/Users/willem/code/coder/.git
```

The sandbox grants write access to the visible worktree but only read access to
its `.git` entry. Git needs narrow write access to the resolved gitdir and
common object/ref storage.

Attempting to commit the approved design specification failed at the first
write:

```text
fatal: Unable to create
'/Users/willem/code/coder/.git/worktrees/15ff9829-4446-44ad-92a2-c4e14e991e05/index.lock':
Operation not permitted
```

Solenta later created an automatic `coder-checkpoint` outside the agent
sandbox. That preserves the diff, but it does not satisfy workflows that
require the agent to make a named commit, hand a commit to another worker, or
finish a branch deliberately.

### Impact

- Agents can edit code but cannot stage or commit it.
- Skills that require a design/spec commit cannot complete their workflow.
- Worker-to-worker handoffs using `git show <branch>:<path>` are blocked.
- Normal branch completion, merge preparation, and commit verification cannot
  be performed by the session that authored the change.
- The error appears late, after useful work has already been produced.

### Expected behavior

A managed worktree must support ordinary Git operations for its own branch
without granting write access to another worktree or to unrelated files in the
primary checkout.

### Suggested fix direction

- Resolve the worktree's `gitdir` and `git-common-dir` before constructing the
  sandbox profile.
- Grant the minimum Git write paths needed for this worktree's index, locks,
  refs/logs, and object creation.
- Prefer a narrow Git-operation broker if granting common object-store access
  directly would make the sandbox boundary too broad.
- Preflight the permission during session startup and report a named degraded
  mode before edits begin.

### Acceptance criteria

- Start an agent in a Solenta-managed linked worktree.
- Create one file, then run `git add`, `git commit`, and `git status` from the
  agent session.
- The commit succeeds and the worktree becomes clean.
- The agent can read its resulting commit with `git show`.
- The sandbox still prevents mutation of another worktree's index, HEAD, and
  worktree-specific refs.
- An integration test uses a real linked-worktree `.git` pointer; testing only
  a standalone repository is insufficient.

---

## Issue 3: Planboard requires `gh`, but managed sessions cannot authenticate or reach GitHub

**Labels:** `plan:todo`

**Related:** #608, which proposes up-front forge readiness detection. This
issue covers the stronger runtime contradiction where Planboard instructions
require GitHub writes from a session that has no usable GitHub path.

### Problem

The thread prompt requires multi-step plans to be created and maintained as
GitHub issues using `gh`. Both authentication and connectivity failed inside
the managed session.

Before reauthentication:

```text
github.com
  X Failed to log in to github.com account currentbits (default)
  - Active account: true
  - The token in default is invalid.
```

The user then reauthenticated and asked for another attempt. The managed
session still reported the same invalid token. A direct API probe separated
the network failure from the higher-level command:

```text
$ gh api user --jq .login
error connecting to api.github.com
check your internet connection or https://githubstatus.com
```

Environment details:

```text
gh version 2.97.0 (2026-07-31)
repository: currentbits/solenta
```

The GitHub connector could search issues and found #608, proving a read route
exists elsewhere in the product. Connector issue creation was nevertheless
rejected with:

```text
MCP tool call requires approval, but approval policy is never
```

Therefore neither mandated route can write: `gh` has no network/auth visibility
and the connector has an impossible approval requirement.

### Impact

- Agents cannot create or update the Planboard issues the prompt requires.
- Duplicate checks cannot be performed through the required `gh` route.
- Reauthenticating in the host is not reflected reliably in the running
  session.
- Authentication failures and sandbox network denial are conflated, sending
  users toward repeated logins that cannot fix connectivity.
- Planning work cannot be recorded on the board even after explicit user
  approval.

### Expected behavior

When Planboard instructions are injected, Solenta must provide one working,
authorized path to the repository:

1. allow the sandboxed `gh` process to reach `api.github.com` and see refreshed
   credentials; or
2. expose a first-party issue writer that is usable after an explicit user
   request under the active permission policy.

If neither is available, omit the Planboard mandate and show a preflight error
before work begins.

### Suggested fix direction

- Extend #608's forge preflight to report four states separately: CLI missing,
  authentication invalid, network blocked, and ready.
- Run the preflight in the same execution environment and sandbox as the agent,
  not only in the desktop host.
- Refresh or remount `gh` credentials when the user reauthenticates, or clearly
  require a new session if credentials are snapshotted.
- Allow only the GitHub endpoints needed by configured repository operations
  when a Planboard workflow is active.
- Make issue creation idempotent by searching exact titles before writes.

### Acceptance criteria

- In a managed Planboard session, `gh auth status` identifies the active
  account without exposing tokens.
- `gh issue list`, label creation, issue creation, issue editing, and issue
  closing work against the bound repository.
- Reauthentication becomes visible to the session, or the UI explicitly says
  that a new session is required.
- A network-denied session reports `network blocked`, not `token invalid`.
- If `gh` is unavailable, an explicitly approved first-party issue writer can
  perform the same Planboard operations.
- No GitHub access is granted to repositories outside the project selected by
  the current thread.

