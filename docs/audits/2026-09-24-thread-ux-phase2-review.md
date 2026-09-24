# Thread UX phase two review

Plan: [#1350](https://github.com/currentbits/solenta/issues/1350). Both Grok branches were reviewed together in an isolated checkout, then merged with user approval into `codex/thread-worker-ux`.

Landed in this order: transcript `0e7d46a9`, navigation and draft retention `2e0dd711`.

| Order | Branch | Reviewed tip | Result |
| --- | --- | --- | --- |
| 1 | `coder/fork-this-is-a-persisetent-issue-when-us-3a2dd7` | `0f51e000` | Routine machine-origin worker completions become compact disclosures. Full original text remains available. Successful work awaiting a merge/PR decision says so in its summary. |
| 2 | `coder/fork-this-is-a-persisetent-issue-when-us-5d3f27` | `9f8d011d` | Labeled Threads, Planboard and Review navigation, with secondary destinations under More. Existing routes, scope and return behavior remain. Unsent composer text, attachments and paste cards survive route changes in memory. |

The transcript recognizes known completion formats only when `fromNotice` is present. Human lookalikes, unknown formats, failures, undeliverable notices, inbound messages and attachments remain in their existing presentation. Request/failure phrases receive conservative checks; this is not a general natural-language classifier. The original message is retained even when folded. Verbose mode and search reveal expose it, and history loading does not replay entrance motion.

Navigation reuses the existing PR list for Review and existing handlers for Activity, Kanban, Automations, Usage, Fleet, Insights and Digest. The thread header's Views menu still controls split panes. The transcript unmounts when another destination opens; draft retention does not keep hidden listeners and effects active. Draft retention lasts for the renderer session, not an application restart.

Validation:

- Combined build and typecheck passed. All 2,591 renderer tests passed before the final menu Tab fix. After that small fix, all 162 affected navigation/sidebar/drawer checks and typecheck passed.
- All 15 changed files in the combined checkout match the two reviewed worker tips byte for byte.
- After landing, all 15 files still match the reviewed tips. The destination build/typecheck and 284 targeted transcript, navigation, sidebar, drawer and composer-attachment checks passed.
- Real Electron fixtures passed native Space followed by pointer activation, More menu End/Tab/Shift+Tab/Escape, focus return, narrow drawer navigation, label fitting, and no horizontal page overflow. The narrow run enabled and verified reduced motion.
- Dark and light screenshots were inspected. Routine updates are compact, failed and unknown updates remain visible, and the original notice text can be expanded. Keyboard disclosure does not animate.
- Composer regression covers text, file attachments and large paste cards across unmount/remount, thread isolation, and successful-send clearing without resurrection. Pending content is not written to localStorage.
- No new dependencies, backend schema changes, live project data, or provider runs were required. This is source and isolated renderer verification, not packaged-app acceptance.

Review fixes included conservative action detection, strict stock-footer matching, native disclosure activation, quiet inline notice actions, menu keyboard exit, and composer retention without a hidden transcript.

Both phase-two changes are merged into the project checkout, and the worker worktrees have been cleaned up. This does not publish a release or install a packaged app.
