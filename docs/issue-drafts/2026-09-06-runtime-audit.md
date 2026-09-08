# Provider session resume and orchestration auto-continue audit

2026-09-06, source at `6c7a6fbebb066942f7f5702084f1af1e0730319d`. Crew task t7.

Corrected 2026-09-06 after lead review of the first publication. Host issue-edit is unavailable; GitHub bodies of #950/#952 still need the same corrections applied on origin.

## Live incident

On the Codex lead, 2026-09-06 ~06:31Z, worker t5 finished. `flushOrchNotices` started a machine turn. Codex `exec resume` died in under a second:

```
thread-store conflict: thread 01a072f7-10e0-7fd2-b691-7d481327516f already has an active writer
Error: thread/resume failed … (code -32600)
```

Retry turn appeared. A second attempt one second later failed the same way. The user had to ask what the dump meant. Codex refused an exclusive writer (openai/codex#37403 / #37450). The holder of that writer is unknown from this incident. Solenta showed the refusal as a raw run error.

## Verified findings

1. Codex writer-lock stderr is not classified. `formatRunExitError` prefixes `Run error (exit 1):` and keeps the last eight stderr lines. `classifyClaudeResultError` only treats `No conversation found` as `sessionLost`. `classifyContextOverflow` and `classifyCliUpgrade` return null. A classifier must require explicit writer-conflict text (`thread-store conflict` / `already has an active writer`). Generic JSON-RPC `-32600` alone is not that class.
2. Worker-finished auto-continue resumes immediately. `flushOrchNotices` only skips when Solenta's `active` map still has the lead. Idle in Solenta is not the same as an accepted Codex resume. On an explicit writer-conflict rejection, park the notice; allow bounded/manual retry after the CLI accepts the session. Do not infer a live lock from a stored `lastError`. Do not delete or bypass locks. Overlay `CODEX_HOME` still shares `sessions/` and `thread-writer-locks/` with the source home via symlink. That is shared locking on shared session data, not a defect; unlinking locks while sessions stay shared would risk concurrent writers.
3. Retry turn is last-user-message, not last-failed-turn. After a failed fromNotice spawn the notice is already a user row, so Retry re-sends that notice as a human turn (`fromNotice` false) and immediately `exec resume`s again. After an undeliverable notice (budget/cap; event only, no user append) Retry re-sends the original user prompt, not the parked notice. Manual Retry must remain usable after a lock is actually released.

Run:

```sh
node --import=./test/support/disable-grok-mcp.mjs --experimental-strip-types docs/issue-drafts/2026-09-06-runtime-evidence.mjs
```

Exit 0. Temporary Store, fake Codex binary, and a throwaway overlay source. Did not spawn the real Codex CLI, did not kill Codex Desktop, did not delete `~/.codex/sessions`. The overlay symlink assertion documents shared locking; it is not evidence that the symlink is defective.

## Backlog reuse (do not recreate)

| Issue | Why not a duplicate |
| --- | --- |
| #406 | Agent-facing structured tool errors. This is a user-visible CLI resume failure. |
| #391 | Agent same-fix thrash with provider switch. This is UI Retry / auto-continue of a session lock. |
| #297 | Test/CI flake taxonomy. Not provider session resume. |
| #687 | Question cards vs fromNotice. Already preserves `pendingQuestion` on machine turns. Different card. |
| #554 | Eject to raw CLI is the right recovery hatch to reuse, not a classification of this error. |
| #927 | Codex MCP tool advertising. Same provider, different bug. |
| #795 / #799 | CLOSED argv bugs (`--sandbox` / `--search` on `exec resume`). Do not reopen. Resume argv is already correct. |
| #808 | CLOSED workflow phase resume. Slot `sessionId`, not interactive lead auto-continue. |

## What this audit did not file

- Other providers' session-resume failures. Not reproduced. Claude already has a `No conversation found` reset path. Grok/Kimi were not locked in this incident.
- Hypothesis that Retry after the live writer-lock re-sends the original user prompt. Invalidated for the spawn-fail path: `fromNotice` appends the notice as a user message before Codex starts.
- Hypothesis that unlinking overlay `thread-writer-locks/` while sharing sessions avoids Desktop contention. Invalidated: that bypasses mutual exclusion on shared session data.
- Hypothesis that merge conflict replay uses the repository default. Already invalidated by t6.
- Hypothesis that review acceptance is lost on orderly quit. Already invalidated by t6.

## Publication

First publication independently fetched OPEN with `plan:todo`. Lead review required body corrections on #950 and #952. Local payloads below match that review. Host `coder-threads` has `issue_create` / `issue_set_plan` / `issue_complete` / `issue_list` only: no issue-edit tool, so origin bodies are not yet patched.

- [#950 Do not auto-continue a Codex lead while another process holds the session writer](https://github.com/currentbits/solenta/issues/950)
- [#951 Retry turn after a failed machine-delivered notice re-sends the wrong prompt](https://github.com/currentbits/solenta/issues/951)
- [#952 Classify Codex thread-store writer conflicts instead of dumping opaque stderr](https://github.com/currentbits/solenta/issues/952)

Payloads: `2026-09-06-runtime-audit.json`. Receipt: `2026-09-06-runtime-publication.json`. t7 left open for the lead to verify.
