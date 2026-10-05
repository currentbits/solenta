# Sidebar split (issue #1447, round 6, pass T)

`src/components/Sidebar.tsx` is 3,328 lines on `fcc882b3`. PR #1453 already
moved the row components, icon, motion helpers, nav table and storage helpers
to `src/components/sidebar/`. What is left is one `Sidebar` component. This
plan maps its hooks and picks the extractions that cannot change behaviour.

## Ground rules

- React runs effects (and, separately, layout effects) in declaration order. A
  custom hook's effects run where the hook is called. So a hook may only take a
  **contiguous** run of hook calls, and is called exactly where that run was.
- Hook calls stay unconditional; their order and count do not change.
- Bodies are moved verbatim. Dependency arrays keep their meaning, refs stay
  refs, `useCallback`/`useMemo` stay where they were.
- New components are presentational. Every piece of state stays in `Sidebar`
  and is passed down, so `Sidebar`'s hook list does not shrink.
- DOM, class names, `data-*` and aria labels are unchanged. No CSS edits.
- `Sidebar`, `SettledRow`, `ThreadCard`, `displayWorkerTitle` and
  `statusPulseFor` stay importable from `Sidebar.tsx`.

## Effect order on main

`E` = `useEffect`, `L` = `useLayoutEffect`. Line numbers are on `fcc882b3`.

| # | Line | Kind | What |
|---|------|------|------|
| 1 | 430 | E (useEscapeClose) | Escape closes create/scope/filter menus |
| 2 | 442 | L | Insights menu: focus current/first item on open |
| 3 | 452 | E | Insights menu: outside mousedown closes it |
| 4 | 476 | E (useEscapeClose) | Escape closes the issue form |
| 5 | 482 | E (useEscapeClose) | Escape closes the remove-project confirm |
| 6 | 484 | L (useModalFocus) | Focus trap for the remove-project confirm |
| 7 | 589 | E | `mountedRef` lifecycle |
| 8 | 596 | E | 5s `now` tick |
| 9 | 640 | E | Debounced full-content search |
| 10 | 704 | E | Drop a stale project scope |
| 11 | 715 | E | Drop a stale tag filter |
| 12 | 723 | E | Reset the settled page size when filters change |
| 13 | 831 | E | Re-apply list motion on prefers-reduced-motion change |
| 14 | 839 | E | Reveal (scroll + flash) a new thread |
| 15 | 992 | L | List motion: detect bulk churn before paint |
| 16 | 1007 | E | List motion: re-enable after commit |
| 17 | 1024 | E | Sync `visibleIdsRef` / `selectAnchorRef` |
| 18 | 1093 | E | Global keyboard shortcuts (⌘1–9, ⌘J, ⌘N, ?) |

## State map by concern

Readers/writers name the code that reads or sets each piece of state.

**Saved views** — `savedViews`, `activeViewId`, `viewEditor` (386–395).
Written by `persistViews`, `persistActiveViewId`, `recallSavedView`,
`submitViewEditor`, `updateActiveView`, `deleteActiveView`, the escape handler.
Read by `currentCriteria`/`activeSavedView`/`viewModified`, the stale
scope/tag effects (10, 11), `filtersEngaged`, the filter bar.

**Search** — `query` (396), `searchResults`, `searchLoading` (583–584),
`searchGen`, `mountedRef` (586–587), effect 7, `trimmedQuery`, `searching`,
`runSearch`, effect 9 (617–653). Read by `displayThreads`, `searchHitIds`,
the list-motion effects (15, 16), `visibleIds`, `renderCard` (`contentMatch`).

**Filters / grouping / scope** — `statusFilter`, `providerFilter`,
`tagFilter`, `groupBy` (418–429), `projectScope` (485), `filtersOpen` (491),
`filterMenu` (414), `scopeMenuOpen` (412). Written by `applyCriteria`,
`setScope`, `apply*Filter`, `toggleProviderFilter`, `toggleFilterMenu`,
`toggleFilterBar`, effects 10 and 11. Read by `displayThreads`,
`currentCriteria`, `keptOutsideFilter`, the more-menu runners, the filter bar.

**Menus** — `createMenuOpen`, `basePicker` (407–411), `moreOpen`,
`moreHostRef`, `moreTriggerRef` (415–417), effects 1–3, `toggleMore`,
`closeMore`, `onMoreBlur`, `onMoreKeyDown`, `moreDestinations`.

**Issue form** — `importCliProvider`, `issueFormFor`, `issueRef`,
`issueError`, `issuePending`, `closeIssueForm`, effect 4 (464–476),
`openIssueForm`, `submitIssueForm`.

**Remove project** — `removeConfirmId` (413), `removePending`,
`closeRemoveConfirm`, `removeConfirmRef`, effects 5–6 (477–484), the confirm
dialog JSX.

**Shelves** — `workingOpen`, `snoozedOpen`, `settledOpen` (488–499),
`trashedOpen`, `purgeConfirmId`, `settledVisibleCount` (542–546), effect 12,
`toggleWorking/Snoozed/Settled`, the carve and visible-tail locals.

**Worker families** — `workerOpen` (500), `familyOpts`, the `*Families`
memos, `toggleFamily` (808).

**List motion** — `listAnimCtrls`, `listAnimSkip`, `prevRowIds`,
`applyListMotion`, `bindListAnimation` (503–541), effects 13, 15, 16. Also
written by `toggleFamily`. Order-sensitive: 15 must run before paint and 16
after it; 13 must stay ahead of 14–16.

**Derived rows** — `settleOpts` (554), `threadTitles` (565–582),
`projectById`, `liveById`, `waitStates` (603–615), `keepThreadIds`,
`displayThreads` (655–700), `knownTags` (712), `flat` through
`searchFamilies` (727–806), `settledTail` (885), `visible*Groups`,
`visibleIds` (906–990), `visibleIndex` (1013), `providerOptions`,
`providerNames` (1537–1566).

**Selection / keyboard** — `multiSelected`, `selectAnchor`, `batchFeedback`,
`cmdHeld`, `keyboardSheetOpen` (547–553), `visibleIdsRef`,
`selectAnchorRef`, `projectsRef`, `listMoveProjects`, effect 17,
`handleSelect`, `clearMulti`, `runBatchArchive`, `runBatchSettle`
(1019–1082), `createInTargetProject`, `handleBrandCreate`, effect 18
(1084–1164), `indexHintFor`.

**Misc** — `now` + effect 8 (tick), `updating` (update button), effect 14
(reveal).

## Candidates

### Custom hooks (contiguous runs only)

| Order | Hook | Lines | Effects inside | Risk |
|---|---|---|---|---|
| 1 | `useStableThreadTitles(threads)` | 565–582 | none | ref + memo only |
| 2 | `useProviderOptions(providers, threads)` | 1537–1566 | none | two memos |
| 3 | `useListAnimation()` | 503–541 | none | refs + two stable callbacks; returned refs are the same objects |
| 4 | `useSidebarRows(...)` | 727–806 | none | 15 memos, same deps |
| 5 | `useMoreMenuFocus(...)` | 442–463 | 2, 3 | both effects move together, called at 442 |
| 6 | `useThreadSearch(...)` | 617–653 | 9 | one effect; refs/setters passed in |
| 7 | `useSidebarShortcuts(...)` | 1093–1164 | 18 | one effect, last in the list |

Not extracted as hooks:

- Search state as a whole: `query` (396), `searchResults` (583), the refs
  (586) and effect 9 (640) are split by unrelated hooks (`now`, the menus,
  `projectById`…). Pulling them together would reorder hooks. Only the
  contiguous tail (617–653) moves.
- Effect 7 + effect 8 (589–601): `mountedRef` is search state but the tick is
  not; a hook spanning both would mix concerns for little gain.
- List motion effects 13, 15, 16 sit at three separate places between other
  effects. They stay inline next to the values they read.
- Selection (1013–1082) is contiguous, but it would take 11 parameters
  (state from 547–551, `visibleIds`, three props) for ~70 lines. Worth it only
  together with a state move, which this pass does not do.
- Effects 10–12 (704–725) are interleaved with `knownTags` and read saved-view
  state; tiny, leave them.

### Presentational components (no state of their own)

| Order | Component | JSX now | Props |
|---|---|---|---|
| 8 | `ScopeMenu` | scope menu `div[data-scope-menu]` | projects, three project callbacks, `setScope`, setters |
| 9 | `BatchBar` | both `[data-batch-bar]` blocks | counts, feedback, three handlers |
| 10 | `TrashedShelf` | `[data-trashed-shelf]` | rows, `now`, `trashedOpen`/`purgeConfirmId` + setters, restore/purge |
| 11 | `RemoveProjectConfirm` | remove-project dialog | project, threads, pending, `dialogRef`, handlers |
| 12 | `InsightsMenu` | the `[data-app-more]` host | refs, handlers, destinations |

`trashedOpen`, `purgeConfirmId`, `removePending` etc. stay in `Sidebar` and are
passed in, so no state moves. Wrapping JSX in a component adds a React
boundary but no DOM node; the element type at each spot is stable across
renders, so nothing remounts.

Left for later: the filter bar (≈400 lines, ~25 props across saved views and
four filter menus) and the create-thread menu (≈270 lines). Both are safe in
principle; they are large prop surfaces and deserve their own pass.

## Verification per extraction

typecheck, `npx vite build`, renderer suite TAP count (2701/2701), and a
pure-move check (`comm -23` of whitespace-stripped added vs removed lines,
listing only wiring). At the end: effect-order script (main vs branch, hooks
expanded) and pixel diffs of six sidebar states against main.
