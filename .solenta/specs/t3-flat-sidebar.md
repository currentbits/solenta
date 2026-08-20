# T3 flat sidebar — implementation contract

Goal: make Solenta's sidebar structurally match T3 Code's sidebar
(github.com/pingdotgg/t3code, reference clone at /tmp/t3code-ref,
`apps/web/src/components/Sidebar.tsx`). The previous attempt (#567) flattened
rows but kept project group headers, per-project create clusters, and a merged
"Later" shelf — none of which exist in T3. This redo removes them.

Both workers code against THIS file. Do not invent selectors or structure not
listed here. Where this spec and existing code disagree, this spec wins.

## Layout (top to bottom)

1. **Brand row** — unchanged (brand mark, app name, nightly chip). The
   `headerAdd` + button MOVES out of this row (into the search row).
2. **Search row** — existing search input, PLUS on its right a `New thread`
   icon button (`data-new-thread`, square-pen style icon) and a small caret
   button (`data-new-thread-caret`) opening the create-type menu
   (`data-new-thread-menu`) with the EXISTING items and selectors:
   `data-create-worktree-thread`, `data-create-orchestrator-thread`,
   `data-create-plain-thread`, `data-create-teach-thread`,
   `data-create-ask-thread`, plus a new `data-create-from-issue` item that
   opens the existing GitHub-issue form (selectors `data-issue-form`,
   `data-issue-input`, `data-issue-create`, `data-issue-cancel`,
   `data-issue-error` keep working, rendered directly under the header, not
   per project). All create actions target the SCOPED project when a scope is
   set, else the active thread's project, else the first project (existing
   `createTargetProject` logic). Remote projects: hide worktree-only items
   (existing rule).
3. **Scope row** (T3's project dropdown) — a full-width menu button
   (`data-scope-trigger`) showing the current scope: "All projects" or the
   scoped project's slug. Menu (`data-scope-menu`) lists "All projects"
   (`data-scope-item="all"`) then every project (`data-scope-item=<projectId>`,
   slug text). Each project row carries a gear icon (`data-scope-edit=<id>` →
   existing `onEditProject`) and an X (`data-project-remove=<id>` → existing
   remove-confirm dialog, selectors unchanged). On its right, outside the
   menu, a `New project` icon button (`data-new-project` → existing
   `onAddProject`). Scope persists in localStorage key
   `sidebar:projectScope`. Scope is ONLY a filter — `buildFlatSidebar`'s
   third arg. Search searches all projects regardless of scope.
4. **View nav** — Activity / Kanban / Planboard collapse from three
   full-width rows into ONE row of three icon buttons with tooltips. Keep
   `data-view-nav="activity|kanban|planboard"` and `data-active`.
5. **Thread list** — one flat scrollable list, NO project group headers, NO
   "Projects" section header, NO collapse-all, NO per-group Show-more cap:
   - **Pinned cards** (`flat.pinned`), then a thin divider
     (`data-pinned-divider`, 1px `--border-soft`) — only when pinned > 0.
     No header text; the pin glyph on each card carries the meaning.
   - **Active cards** (`flat.active`).
   - **Snoozed shelf** — only when snoozed > 0. Header button
     (`data-snoozed-shelf-toggle`, `aria-expanded`): text `Snoozed` when open,
     `Snoozed (N)` when collapsed, 11px medium in `--blue`; then a 1px
     hairline rule (flex-1, blue at ~20% alpha) and a chevron that rotates
     when open. Rows are slim snoozed rows.
   - **Settled shelf** — same pattern, muted: `data-settled-shelf-toggle`,
     text `Settled` / `Settled (N)` in `--text-dim`, hairline `--border-soft`.
     Rows: settled first (slim), then archived (slim, dimmer,
     `data-archived`), paged: initial 10, then a `Show N more` row
     (`data-settled-more`) revealing +25 per click (reuse existing
     settledVisibleCount state). N in the header counts settled + archived.
   - Shelf expand state persists in localStorage
     (`sidebar:snoozedOpen`, `sidebar:settledOpen`), default collapsed.
   - Carve-out: the open thread never vanishes — if it lives on a collapsed
     shelf (or past the page cap) render just that row under the shelf header
     (logic already in `flatVisibleThreadIds`).
6. **Footer** — unchanged (whatever currently renders below the list: batch
   bar, add-project empty state, toasts, keyboard sheet).

## Data source

`src/sidebarGroups.ts` (already committed on branch
`coder/so-i-asked-to-make-the-sidebar-with-the--8dea3d`, commit 042c926):

```ts
buildFlatSidebar(threads, settleOpts, scopeProjectId | null): FlatSidebar
// { pinned, active, snoozed, settled, archived }
```

Keyboard order: `flatVisibleThreadIds({ flat, snoozedOpen, settledOpen,
settledVisibleCount, selectedThreadId })` from `src/sidebarSelection.ts`.
⌘1-9 / ⌘J / ⌘K / index hints / shift-range / meta-toggle multi-select keep
their existing behavior, driven by this list. In search mode the visible ids
are simply the rendered hit order.

`buildSidebarGroups`, `partitionSidebar`, `visibleAttentionCount`,
`GROUP_ATTENTION_CAP`, `buildVisibleThreadIds` stay exported (other callers /
old tests); the Sidebar component itself must stop using them.

## Card anatomy (the heart — copy T3, not the old Solenta card)

A card (`data-thread-card=<id>`) is THREE lines, total height ≈ 64px,
padding 7px 10px, radius `--radius-sm`. Root keeps the existing state attrs:
`data-active`, `data-multi`, `data-unread`, `data-pinned`, `data-nested`
(forks keep the existing indent+elbow treatment), plus the existing
stretch-select button (`cardSelect` pattern: content pointer-events none,
interactive children re-enable — keep this a11y structure exactly).

- **Line 1** (11px): project slug in `--text-muted` (`data-card-slug`) —
  every card carries it, this replaces group headers; pin glyph (10px,
  existing `data-pin-flag`) when pinned. Right-aligned slot:
  - at rest: the **status label** (`data-status-label`) or, when statusless,
    the relative age (existing `formatRelativeAge`).
  - on hover / focus-visible (and while the snooze menu is open): the slot
    cross-fades to quick actions: snooze button (`data-snooze-btn=<id>`,
    clock icon, opens the EXISTING snooze presets menu — selectors
    `data-snooze-menu`, `data-snooze-preset`, `data-snooze-clear` unchanged),
    settle check (`data-settle-btn=<id>`, disabled while working — existing
    rule), and the existing overflow `data-more-btn=<id>` menu (fork /
    handoff / rename / mute / settle items keep their selectors:
    `data-fork-btn`, `data-handoff-provider`, `data-rename-thread`,
    `data-mute-toggle`, `data-settle-item`). Pin/unpin moves INTO the
    overflow menu as `data-pin-item=<id>` (the old always-hovering
    `data-pin-btn` is retired).
- **Line 2** (13px, weight 500, `--text`): title, one line, truncate.
  Double-click renames (existing input, `data-thread-title-input`). Unread
  keeps the existing sr-only "unread" + `data-unread` styling hook.
- **Line 3** (11px, `--text-muted`): branch name truncating (`data-card-branch`,
  omit the line's left part when branch is null), PR link `#N`
  (`data-pr-badge`, `thread.prUrl`, real `<a>`, stopPropagation), conflict
  forecast marker (existing ConflictForecastBadge, restyle to a plain 11px
  text/icon, no pill), right-aligned provider name (`data-card-provider`,
  e.g. "claude", `--text-dim`). If branch, PR, forecast and provider are all
  absent the line may collapse.
- **Wait row** (#42) stays as an optional extra line below line 3
  (`data-wait-row`, existing behavior).

Status label mapping (text label + color, NO dot, NO pill — derive from the
existing `statusDotFor`/`baseStatusDot` logic, keep its precedence and
tooltips as `title`):
- working: `Working <elapsed>` in `--blue` (elapsed from existing 5s tick;
  keep the existing spoken/aria text). Non-active working cards render the
  label at 75% opacity. No pulse animation.
- working + awaitingInput: `Waiting` in `--amber`.
- stalled: `Stalled` in `--amber`.
- quota-wait: `Quota` in `--amber`.
- failed: `Failed` in `--danger`.
- unread done: `Done` in `--green`.
- otherwise: no label → relative age in `--text-dim`.

In-flight cards (working, not active, not selected) get whole-row opacity
0.7, restored on hover (T3's recede rule).

## Slim row anatomy (shelves)

`data-slim-row=<id>`, height 32px, single line, radius `--radius-sm`:
title (13px, weight 400, `--text-muted`, truncate) then slug (11px,
`--text-dim`) then right slot: time — snoozed rows show the wake countdown
(existing `formatSnoozeWakeLabel`) in `--blue`; settled rows the wrap-up age;
archived rows the age, row at further-reduced opacity. Hover swaps the time
for the row's one action: wake (`data-wake-btn`), un-settle / keep-active
(`data-unsettle-btn`), or unarchive (`data-unarchive-btn`). Rows are
selectable and multi-selectable like cards. Dimmed at rest, restored on
hover (existing SettledRow/SnoozedRow behavior — keep their components,
restyle).

## Search

Existing behavior (title + content match, debounce, "in messages" tag,
archived hits inline) renders as the flat list of cards with `data-card-slug`
visible — no group headers. Keep `data-thread-card` on hits, keep
`inMessagesTag` as an 11px text suffix, keep "No threads match" / "Searching…"
states.

## CSS rules (Sidebar.module.css rewrite)

- Exactly TWO font sizes: 13px and 11px. Three weights max: 400/500/600.
- Tokens only — no hex, no raw rgba except alpha variants of tokens via
  color-mix (or the existing *-soft tokens). Delete the old pill/badge zoo.
- Row surfaces: transparent at rest; hover `--card-hover`; active
  (`data-active`) `--card`; multi-selected `--blue-soft` outline or bg.
- Keep: focus-visible rings (`--focus-ring`), reduced-motion guards,
  sr-only class, auto-animate hook (`attachListAnimation`) on the ONE list.
- The file should shrink dramatically. Delete dead classes; do not keep
  unreferenced CSS.

## Deletions (retired selectors — tests must drop them)

`data-projects-section`, `data-group-chevron`, per-group `data-create-menu*`
(the create menu moves to the header, item selectors survive),
`data-project-edit` (replaced by `data-scope-edit`), group header/count/
summary styles, `data-later-shelf` + "Later ·" header, `data-pin-btn`,
GROUP cap "Show more" per group. `SubagentRows`, spend meter, and anything
else Sidebar.tsx no longer references gets deleted with it.

## Invariants (do not break)

- Activity never reorders rows (createdAt sort; `buildFlatSidebar` handles).
- The open thread never disappears (carve-outs above).
- No nested interactive controls inside the select button (keep the
  cardSelect overlay structure).
- Keyboard: ⌘1-9, ⌘J/K wrap, ⌘N / ⌘⇧N (`handleBrandCreate` semantics
  unchanged), `?` sheet, Escape closes menus. `isShortcutBlocked` rules.
- Batch bar (multi-select archive/settle + feedback) unchanged, selectors
  unchanged.
- aria-labels keep speaking state (unread / pinned / status) on the select
  button; shelf toggles keep `aria-expanded`.
- Props of `Sidebar` do NOT change (App.tsx must not need edits).

## Verification

`npm run test:renderer` (node:test, NOT vitest) from the repo root; the two
logic files also run standalone:
`node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/sidebarGroups.test.ts test/sidebarSelection.test.ts`.
`npx tsc --noEmit` must pass. Worktrees need
`ln -sfn /Users/willem/code/coder/node_modules node_modules` and the same for
`core/node_modules` before tests run.
