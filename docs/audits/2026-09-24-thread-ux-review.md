# Thread UX implementation review

Plan: [#1342](https://github.com/currentbits/solenta/issues/1342). Reviewed together in an isolated checkout. Worker branches are not landed yet.

Recommended landing order:

| Order | Branch | Reviewed tip | Result |
| --- | --- | --- | --- |
| 1 | `coder/fork-this-is-a-persisetent-issue-when-us-2f12a9` | `74a9cbdc` | Shared title normalization stops repeated Fork prefixes. Workers use the assigned job. Summary rows identify real workers. |
| 2 | `coder/fork-this-is-a-persisetent-issue-when-us-d1232d` | `2cc43d00` | Collapsed worker families, compact rows, nested attention, manual forks kept independent, selected-worker visibility, short list motion and static waiting/completion indicators. |
| 3 | `coder/fork-this-is-a-persisetent-issue-when-us-6040b7` | `8c36fdd2` | Header Workers button opens existing Team/Integration; persistent parent navigation; worker and project boundaries shared with the inspector. |

Validation:

- Combined build and typecheck passed.
- Combined renderer suite: 2,566 passed, zero failed.
- Naming/orchestration electron checks: 175 passed, one unrelated SSH command assertion failed. The same assertion fails on the unchanged base. Summary checks: nine passed.
- Real Electron fixture screenshots inspected with six workers, a nested input request and an independent fork. Browser assertions passed for collapsed/expanded rows, single counting of input requests, compact height, static waiting, parent links and collapse retaining the selected worker.
- Browser motion assertions passed: pointer disclosure animates, keyboard disclosure snaps, and insertion of 45 rows skips animation.
- No new dependencies. No live project data was used for the browser fixture. This was not a packaged-app or live-provider acceptance run.

Landing destination: the existing `codex/thread-worker-ux` branch in the project checkout. Keep plan #1342 open until the selected landing action is complete.
