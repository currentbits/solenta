# November 15 candidate implementation

Tracking: [#2032](https://github.com/currentbits/solenta/issues/2032). Implements the six candidates in the [research refresh](2026-11-15-synara-t3.md). The separate [T3 theming report](2026-11-15-t3-theming.md) is research only.

| Candidate | Result | Scope and limits |
| --- | --- | --- |
| PATH recovery | Failed login-shell captures retry in the background every 30 seconds, up to ten retries. Success stops retrying. | Existing fallback/cache stays usable. Shutdown and re-prime invalidate late results. Successful probes remain cached for the launch. |
| Terminal resize | A refused `{ok:false}` or rejected resize retries once; newer sizes and disposed panes invalidate older retries. Reconnect resends the current grid even if unchanged. | No unbounded retry loop. A second failure still needs a later resize/reconnect. |
| Claude plans | A Claude-only, always-loaded `update_plan` tool updates existing `planSteps`. It validates 1–12 short steps and requires the owning bound thread and current active run ID. | Native `TodoWrite` remains supported. Interrupted/open steps are not silently completed. Explicit policy ask/deny rules still apply; default permission fallback allows this local checklist update. |
| Skill delivery | Explicit mid-sentence, punctuation-adjacent and multiple `/skill`/`$skill` references load installed invocable skills, including other providers' skill roots. User steers use the same expansion. | Existing leading command substitution is preserved. Provider-native names take precedence. Fenced/inline code, blockquotes, agent notices, inbound messages and idle-compaction requests are not interpreted as user skill invocation. Extra skill bodies are bounded; truncation points to the full file. |
| Safe terminal replay | Trimming records ANSI sequence state. Fresh emulators skip a cut sequence through later chunks, while existing live output keeps its raw offsets. Saved logs and restarted sessions begin with a safe suffix. | Replayed input suppression from #2022 remains. Legacy logs already written without boundary information cannot reconstruct their lost prefix. Both package scripts include the shared parser. |
| Folder recovery | A failed navigation retains the previous readable listing, displays the error and listing location, and keeps sibling/Up navigation usable. | Saved listings are scoped to browse connection, environment and cwd, and stale replies remain cancelled. Users can still edit the requested path directly. |

## Validation

- 389 backend regression tests passed with inherited `CODER_*` variables removed and provider CLIs excluded from PATH. Covers Claude/Codex/OpenCode/Cursor/Kimi/Grok, governance/permissions, orchestration MCP, package dependencies, and command/skill dispatch.
- 55 additional focused backend tests cover PATH recovery, terminal lifecycle/PTY behavior and ANSI trim/replay persistence.
- 56 renderer tests cover terminal behavior, folder recovery/host isolation, and path matching/navigation.
- Typecheck, IPC preload synchronization, production build, and both package-script syntax/copy filters passed. The actual Electron Node runtime loaded the shared parser successfully.
- Live Claude Code **2.1.322**, **Sonnet 5.5**, used the production MCP endpoint in an isolated fixture twice and completed the checklist. Active-run ownership and stale/malformed updates were exercised separately through the real runner with a fake provider. This does not claim a full packaged-app visual test or that every model will voluntarily maintain a checklist.

No release/nightly was cut as part of this implementation. Full packaged macOS/Linux/Windows qualification and exhaustive ANSI emulation coverage remain outside these focused checks.
