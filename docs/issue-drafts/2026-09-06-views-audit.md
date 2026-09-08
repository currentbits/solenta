# View usability audit, 2026-09-06

Reviewed at `6c7a6fbebb066942f7f5702084f1af1e0730319d`.

The biggest improvement is to make each view a useful starting point for work: show its scope, let the user inspect a row, and bring them back to the same place. More dashboard widgets would not address these gaps.

## Recommended changes

| View or flow | Current friction | Proposed behavior | Priority |
| --- | --- | --- | --- |
| Board/report → thread → board/report | Opening a thread unmounts the source view; local choices reset and there is no source-aware return action. | Back to [view], restoring project, sort/filter/range and the originating row. Session-only state is sufficient. | First navigation improvement |
| Activity and Digest | A failed load is rendered as “nothing happened”. Activity refresh erases previous rows. Digest allows Mark reviewed after an initial load failure. | Distinct error, empty and stale states; keep successful data on refresh failure; disable acknowledgement without a loaded digest. | P1 bug |
| Activity and Kanban | They inherit a project scope but do not name it in the header or provide an in-view scope control. Empty results are especially ambiguous. | Project selector with All projects, scope-aware empty copy and Show all projects. | P2 |
| Planboard | Users can sort but cannot search a loaded backlog by title/number. | Native search, matching across columns, visible/total counts, clear query, distinct no-match state. | P2 |
| Usage | Thread breakdown identifies expensive work but titles are plain table cells. | Open the source thread by stable ID, then return to the same report controls. Explain deleted transcripts without removing their historical usage. | P2 |

For delivery, fix the false-empty bug first. Then implement return navigation, followed by visible scope. Search and Usage drilldown can land independently, with drilldown reusing the return behavior.

## What to retain

The division introduced in #425 is deliberate: daily work stays in the left navigation; workspace reports and schedules live in Pulse. Pulse already has descriptions and active destinations. Rebuilding navigation or renaming every view would introduce churn without resolving the observed failures.

Insights already has the error behavior Activity and Digest need: initial errors are explicit, and refresh errors preserve the existing list. Use that local pattern.

Usage already has Model / Day / Project / Thread breakdowns and unreported/unmetered caveats from #556. The new proposal connects the existing thread rows to their work; it does not add another chart.

Planboard already follows sidebar scope (#597), and Activity/Kanban already filter correctly when opened (#598). The gap is visible, editable scope within the view.

## Existing work to use rather than duplicate

- Automations: use #937 for in-place editing and #938 for opening recent run transcripts. These directly improve the usefulness of that view.
- Sidebar: use #939 for named filter sets; do not create another saved-filter proposal.
- Review workflows: keep the return-navigation proposal distinct from review itinerary #421.
- Appearance: #728/#729 cover surface styling and explicitly exclude functionality. This audit proposes workflow changes rather than another blanket border/color pass.
- Planboard completeness: #655 covers fetching the full backlog; local search must operate on that complete result, not hide missing pages.

## Evidence and limitations

Read App's view selection/rendering, Sidebar destinations, AgentsPanel Pulse navigation and the center view components. Searched GitHub titles and bodies for overlapping navigation, view-state, project-scope, Usage, Activity, Digest and Planboard work; checked relevant issue bodies before drafting.

Mounted the actual React components with the existing DOM harness. Confirmed:
1. Activity refresh rejection removes previously loaded rows and shows the ordinary empty message.
2. Digest initial rejection shows “Nothing ran while you were away.” and leaves Mark reviewed enabled.
3. Planboard sort resets from number-asc to updated on remount; App's conditional rendering supplies the corresponding unmount path.
4. A project-scoped empty Activity/Kanban has neither the project name in its header nor an in-view Project selector.
5. Planboard has no mounted search input; source review confirms no issue-query state.

Run:
```sh
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types docs/issue-drafts/2026-09-06-views-evidence.mjs
```
Exit 0. These assertions describe current behavior, not a new application regression suite.

This was a source and mounted-interaction audit. The preview pane was unavailable and starting Vite was denied by the sandbox's port-binding restrictions; no live desktop screenshot, pixel-layout validation or user study is claimed. Scroll/focus restoration and narrow-pane layouts need browser verification when implemented.

## Publication

Published via the existing Grok worker's host coder-threads tools because this Codex session still omits issue_create/issue_list. Independently fetched all five GitHub issues and confirmed each is OPEN with plan:todo:

- [#942 Return to the source view with state and position](https://github.com/currentbits/solenta/issues/942)
- [#943 Distinguish Activity/Digest errors from empty results](https://github.com/currentbits/solenta/issues/943)
- [#944 Visible, editable Activity/Kanban project scope](https://github.com/currentbits/solenta/issues/944)
- [#945 Planboard title/number search](https://github.com/currentbits/solenta/issues/945)
- [#946 Usage thread drilldown](https://github.com/currentbits/solenta/issues/946)

Payloads and publication receipt: `2026-09-06-views-audit.json` and `2026-09-06-views-publication.json`. No duplicates were created. Completion of this research task does not complete implementation.
