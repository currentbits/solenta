# Grok preview lifecycle investigation

Investigated 2026-09-05, Solenta thread
`c46e23b2-a0e6-4b0e-bc38-7a93907bae21`. Only the Solenta project and the
three named threads were inspected. No live servers or windows were stopped.

## Finding

Grok 1.0.13's managed background tasks explain the ten-minute stalls.
The Skills worker launched Vite with `background: true, timeout: 0`, then
added a persistent `monitor`. The Electron worker's persistent preview was
also registered as a background task. Their native Grok session logs record
`turn_completed` with `stop_reason: end_turn`, followed exactly 600 seconds
later by `task_completed` with `explicitly_killed: true` and `signal: killed`.

Times below are UTC on 2026-09-05:

| Worker | Native turn completed | Background task killed / next Solenta turn starts |
| --- | --- | --- |
| Skills `f8f47707` | 13:52:57 | 14:02:57 |
| Skills `f8f47707` | 14:04:16 | 14:14:16 |
| Electron `d7498908` | 14:04:14 | 14:14:14 / 14:14:16 |

Sources: project-scoped `messages/<thread-id>.json` shards and these Grok
sessions' `updates.jsonl`, under the encoded `/Users/willem/code/coder` cwd:

- Skills: `01a071cf-ae5c-7763-b94e-5a9e05531d66`
- Electron: `01a071cf-ac2d-7c63-89b9-784eba164b0a`
- Lead Solenta thread: `16850eb0-beb6-42d6-a721-87da8047b4cb`

The next Skills turn reported that Vite had died. This agrees with Grok's
explicit task cleanup, rather than a preview surviving indefinitely while
Solenta merely misreported its status.

## Runner boundary and reproduction

`startClaudeRun` in `electron/runner.js` handles Grok's Messages-format
`result`: it clears the active slot and dispatches terminal notifications
and queued work immediately. `runClaude` in `electron/claude.js` does wait
for process `close` for its exit callback, but that callback is not needed
to complete a run which already emitted `result`.

The new `electron/test/grok.test.js` regression uses a fake CLI and a real,
self-expiring Node descendant inheriting both stdout and stderr. It proves:

1. A final-looking assistant reply does not finish an intentional running job.
2. A peer follow-up waits until the structured result arrives.
3. The follow-up then completes while the old CLI has exited and its
   descendant still prevents `close` by holding the pipes open.
4. The later `close` does not overwrite status or count usage again.

Thus inherited stdio alone does not explain the reported busy thread.
The evidence supports delayed Messages-format `result` during Grok's
background drain. The original raw stdout was not retained. A fresh live
probe using only `sleep 25` was attempted, but sandbox network policy
blocked Grok authentication/API access; live wire timing is not verified.

## Scoped mitigation

Grok's shared argument builder now adds `--rules` guidance for previews
intended to outlive a reply: prefer Solenta's dev-server tools, otherwise
detach the OS process with redirected stdio, check readiness for a bounded
time, and report PID/log. Avoid CLI-managed background jobs and monitors
solely to keep such previews alive. Explicit waiting/monitoring requests and
finite foreground/background work retain their normal semantics.

This is an agent-instruction mitigation, not a change to Grok's task manager
or proof that every model will follow it. The runner still requires a real
terminal result; no idle timeout, assistant-text heuristic, early resume,
or process-killing behavior was added. Live effectiveness remains unverified.

Run the local regression with:

```sh
npm run build --prefix core
node --test electron/test/grok.test.js
```

Validation here: 61 targeted Grok, Claude spawn, provider selection, and
reasoning-effort checks passed. The full Grok file initially had 11 passes
and two existing socket tests blocked by `listen EPERM` on localhost; those
two were excluded from the targeted run. Core compilation and
`git diff --check` passed. The requested host Planboard issue tools were
not exposed in this session, so no issue was created or updated.
