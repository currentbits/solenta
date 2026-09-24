# Thread UX phase three review

Plan: [#1351](https://github.com/currentbits/solenta/issues/1351). Two Grok branches were reviewed together against `3c7bc8a3` in an isolated checkout. They are ready for a user landing decision and are not merged.

| Order | Branch | Reviewed tip | Result |
| --- | --- | --- | --- |
| 1 | `coder/fork-this-is-a-persisetent-issue-when-us-86925b` | `51b18bd5` | Desktop sidebar resize with a persisted width, pointer cancellation, keyboard steps and reset. |
| 2 | `coder/fork-this-is-a-persisetent-issue-when-us-1a648c` | `fccbcc80` | One Options entry for workflows and Best of N, using the existing execution handlers and guards. |

The sidebar defaults to 300px and accepts 280–480px. Opening the agents panel or shrinking the window caps its displayed width without discarding a wider saved preference. The narrow drawer keeps its existing width. Arrow keys resize, Shift takes larger steps, and Enter or double-click resets. Escape, pointer cancellation, lost capture, blur and unmount clean up a drag.

Options can open before a prompt is entered. Workflow selection does not execute it; Build and Best of N retain their prompt, availability and busy guards. Model, permission, Queue/Steer and Send controls remain visible. Options closes on thread, Ask-mode and busy transitions. The workflow editor returns focus to Options. The panel fits the viewport and scrolls; no new animation, dependency or backend setting was added.

Validation:

- Initial combined build/typecheck and all 2,615 renderer tests passed.
- After the review fixes, the combined build/typecheck and 264 affected sidebar, composer, Best of N, drawer, agents and transcript checks passed.
- All nine changed files in the combined checkout match the reviewed worker tips byte for byte. `git diff --check` passed.
- An isolated Electron fixture passed native pointer commit and Escape cancellation, keyboard step/coarse step/reset, agents-panel fit and keyboard cap, and width persistence after reload.
- Native Options checks passed Space/Tab/Escape, focus return after workflow editing, selecting a workflow without execution, explicit workflow execution, narrow drawer sizing and draft retention through Review and back.
- Dark and light screenshots were inspected at desktop and narrow widths. Options also fits a 380×640 viewport. Reduced motion was enabled and checked in a separate native run.
- All fixtures used synthetic project/thread data and fake execution handlers. This is source and renderer verification, not packaged-app acceptance.

Review fixes: keyboard growth now stops at the visible fit cap, reset keys are discoverable on the separator, Best of N has a visible section label, and workflow-editor close restores the Options trigger.

This covers the resizing portion of [#358](https://github.com/currentbits/solenta/issues/358). An icons-only collapsed sidebar remains outside this phase. No release or installation is part of this landing decision.
