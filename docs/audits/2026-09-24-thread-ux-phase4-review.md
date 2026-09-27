# Thread UX phase four review

Plan: [#1352](https://github.com/currentbits/solenta/issues/1352). The Grok branch `coder/fork-this-is-a-persisetent-issue-when-us-f2f260` was reviewed at `aaf96e780c22d9f2e6abaa3515958c344ada3a7a` against `38770cb8`, then merged with user approval into `codex/thread-worker-ux` as `1b80fd03`.

The inspector remembers manual tab choices per project and thread or route for the renderer session. Collapsing it still unmounts its contents. Returning to a thread restores its choice; streams and late workflow details do not override a manual selection. Without a choice, crew/workflow threads default to Agents, ordinary threads and Review to Environment, and operational destinations to Pulse. Opening Workers explicitly selects Agents once. The existing collapsed-by-default preference remains in control of visibility.

The five existing tabs now expose tablist, tab and tabpanel semantics, one tab stop, and Left/Right/Home/End navigation. Keyboard selection keeps the active tab visible. No new dependency, persisted preference, hidden mounted panel, animation or inspector content was added.

Validation:

- Reproduced the base defects in an isolated Electron fixture: Memory was lost after collapse, a previous Workers action forced Agents on an unrelated thread, and a Usage roundtrip replaced Memory with Pulse.
- All 2,625 renderer tests passed at `f0500402`. After the final project-scope correction, the production build/typecheck and 96 targeted inspector, drawer, team, environment, resize and integration checks passed.
- All four changed files in the isolated checkout match the final worker tip byte for byte. `git diff --check` passed and the worker working tree is clean.
- After landing, all four files still match the reviewed tip. The destination production build/typecheck and all 96 targeted checks passed. The worker worktree was cleaned up.
- Final native Electron runs passed at 1680×1050 in dark mode and 680×1050 in light mode with reduced motion explicitly asserted. Checks cover context defaults, stream updates, collapse/reopen, Workers intent, route roundtrips, synthetic project isolation, native keyboard selection, ARIA relationships, selected-tab visibility and panel scrolling. Screenshots were inspected at both sizes.
- Fixtures use synthetic projects and threads with fake handlers. No live project transcripts were inspected, and this is not packaged-app acceptance or a release.

Review corrections: handle the Workers button's forwarded click event, avoid a stale focus request when Home selects the already active tab, and key choices to the project the inspector actually displays rather than an independently scoped board. The final regression exercises differing board and inspector projects and confirms choices stay with the inspector project.

Merged locally. No release has been published or installed.
