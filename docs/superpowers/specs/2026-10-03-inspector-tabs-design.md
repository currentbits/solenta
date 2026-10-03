# Inspector tabs: performance and focus redesign

**Status:** Approved in conversation on 2026-10-03, section by section.
**Scope:** the right-hand inspector panel (`src/components/AgentsPanel.tsx`) and its four tabs: Environment (`git`), Agents, Memory and Skills. Also covers the Settings modal panes that receive moved items.

## Problems

1. **Too much in each tab.** Environment has 15 drag-reorderable cards. Skills has 3 view buttons, a Sync button and 11 filter chips above the list, plus an inline add form below it.
2. **Duplicates.** Several tab items repeat actions that exist elsewhere:
   - Fork and Hand off: thread header, sidebar menu.
   - Open in Finder/Editor: details card.
   - Repository: details card.
   - Sync: header `SyncPill`.
   - Model, Permission and Context: composer and header context ring.
   - The Pull requests link: sidebar.
3. **Configuration in a per-thread panel:**
   - Display checkboxes are global preferences.
   - Spotlight is per-project.
   - MCP servers, the skill catalog and import are global.
   - Code map and Config doctor are per-project tools.
4. **Unpolished.** Each tab has its own card, spacing and empty-state styles.
5. **Performance:**
   - **P1 (high).** Agents tab, crew lead. The crew-integration refresh effect (`AgentsPanel.tsx`, `AgentsContent`) depends on `summaries`. That is a new array on every 5 s poll, so `threads:crewIntegration` reruns on every poll and every `threads:changed`. In the main process it runs about 6 + 3×workers blocking git calls (`execFileSync` via `gitTry`), roughly 100–270 ms per call with 4 workers.
   - **P2 (high, #1398).** `threads:summaries` walks every thread and reads each last assistant message.
     - `RecapCard` fetches all rows to show one, and runs on nearly every thread selection.
     - The Agents team poll runs every 5 s whenever any thread in any project is working.
     - The cold call cost 2,880 ms on 1,846 rows. Warm calls still send about 0.5–0.7 MB over IPC.
   - **P3 (low/medium).** `memo(AgentsPanel)` never takes effect: App passes new inline arrows for `onIntegrateWorker`, `onVerifyLead` and `onLandLead` on every render.
   - **P4 (low).** The panel-level `LaneHeartbeat` duplicates the app-level `ClaimedLanesHeartbeat`. Each one writes the store every 15 s.

Not problems, so leave them alone:
- Tabs mount lazily. Only the active tab renders.
- Memory and Skills fetches are paged, debounced or lazy.
- Local servers polling is async, cached and skipped when the window is hidden.
- The Environment git reads are async.

## Delivery

Two PRs, in this order:

1. **Performance PR** (P1–P4). It is independent of the redesign and small, so it ships first.
2. **Redesign PR.** Tabs, Settings panes and the shared section component.

## Performance changes

- **P1:**
  - Key the crew-integration effect on `thread.id`, a derived `isLead` boolean and the crew roster key, not on `summaries`.
  - Debounce the `threads:changed` reload to 1 s.
  - Switch `electron/crewIntegration.js` from blocking `gitTry` to the existing async git helpers (`gitTryAsync` / `gitOutAsync`).
- **P2:**
  - `threads:summaries` accepts `{ threadIds?: string[] }`. It filters on store metadata before calling `getLastAssistantMessage` and caps `lastActivity.text` at 200 characters.
  - `RecapCard` passes its own id.
  - The Agents team view passes the lead, its direct crew children and the `handoffFrom` thread.
  - The 5 s team poll runs only while one of this crew's threads is working.
  - No argument keeps today's behavior for any other caller.
- **P3:** `useCallback` the three crew handlers in `App.tsx`, keyed on `selectedThreadId`.
- **P4:** remove the panel-level `LaneHeartbeat`. The app-level heartbeat covers the selected lane.

Tests:
- A crew-integration effect test asserts no reload on a summaries-only change.
- A `threads:summaries` scoping test asserts only the requested ids are read.
- The existing heartbeat tests stay green.

## Shared building blocks

- **`InspectorSection`.** One section component: title, optional count, optional collapse with a chevron, an optional right-aligned action slot, and children. It replaces the per-tab card wrappers (`EnvSection`, ad-hoc card divs) and the drag handles.
- **`InspectorBanner`.** A one-line notice with an optional action link, for review queue and drift notices.
- **Empty sections are not rendered.** Where a tab would be completely empty, it shows one short empty-state line.
- One spacing and type scale in a shared CSS module. The tab CSS modules shrink accordingly.

## Environment tab (`git`)

**Job:** the selected thread's workspace.

1. **Status header.** All per-thread:
   - Branch, ahead/behind, **Sync** (`gitFetch`) and **Pull** (`gitPull`; Pull exists nowhere else, so it stays).
   - "N changed files ›" opens the Git view (replaces the Changes card).
   - "#N open ›" opens the PR when the thread has one.
   - A one-line recap from the scoped summary.
   - Source-control and remote-project notices render as a single inline line, only when relevant.
2. **Run.** Dev server (script select, Start/Stop, state), Verification (command, Verify now, evidence log) and Local servers (list).
3. **Checkpoints.** Collapsed by default, with a count. Restore keeps its confirm dialog.
4. **Lanes.** Always present, but collapsed by default when the project has no claimed lanes (title shows the count, e.g. "Lanes 0"). Expanded by default when lanes exist. Claim, Preview, Restore and Recycle stay here. Not shown for remote projects (lanes are local-only today).

**Removed from the tab:**
- Fork / Hand off: header and sidebar.
- Open in Finder/Editor: details card.
- Repository: details card.
- Pull requests link: sidebar.
- The Changes card: becomes the header link.
- The footer row: merged into the status header.

**Moved:** Display → Settings → General; Spotlight → Settings → Git.

**Reordering:** drag-to-reorder and "Reset order" are removed, and the order is fixed. `src/envSectionOrder.ts` and its `coder.envSectionOrder` localStorage key are deleted. A stale key is ignored.

## Agents tab

**Job:** who is working on this thread, and their progress.

1. **Session line.** One line: provider · status · turns · cost. A second muted line shows input/output tokens.
   - Model and Permission are removed (the composer shows and edits them).
   - Context is removed (the header context ring shows it).
2. **Team.** Crew leads only. Worker rows (status, diff size, click to open) come first, with a "N done" toggle. Integrate, Verify and Land sit under the team.
3. **Tasks.** Then Subagents, if any.
4. **Hypotheses.** Collapsed by default, with a count.
5. **Workflows** keep their phase view, rendered inside `InspectorSection`.

## Memory tab

**Job:** this project's memories.

1. One toolbar row: search, type select, and a `+` button that opens the existing "Remember something" form in place.
2. When the maintenance queue is non-empty: `InspectorBanner` "N memories need review ›", which opens the existing review queue view.
3. **Memory list.** Title, type pill and age. Expand shows the body plus Edit and Delete. Paging is unchanged.
4. **Footer line.** Consolidation status (e.g. "Consolidated 2h ago").

**Moved:** Code map (`CodeMapCard`) and Config doctor (`ConfigDoctorCard`) → Settings → Memory, under a "Project tools" heading with a project picker. The picker defaults to the project of the selected thread when Settings opens, otherwise the first project. The existing server status stays at the top of that pane.

## Skills tab

**Job:** skills this thread can use.

1. One toolbar row: search, one **filter menu**, and **Manage ›**.
   - The filter menu covers source (User / Project / Catalog) and provider. It replaces the 11 chips.
   - Manage › opens Settings → Skills & MCP.
2. When skills have drifted: `InspectorBanner` "N skills out of sync · Sync ›". This replaces the always-visible Sync button.
3. **Installed list.** Name, description and scope badge. Expand shows providers, path and Remove.

**Moved to a new Settings → "Skills & MCP" pane:**
- Browse catalog (`CuratedSkillsSection`).
- MCP servers (`McpServersSection`, `CuratedMcpsSection`, `AddedMcpsSection`, `McpImportPreviewPanel`).
- Import from other tools (`HarnessImportSection`).
- Add skill (`AddSkillSection`: file, URL, manual).

These components move as-is. Only their container changes. The unused `settings` / `saveSettings` props on `SkillsTab` are removed.

## Settings changes

- **General:** a new "Display" group with the four `uiPrefs` checkboxes, reusing the same `uiPrefs` keys:
  - divergence compare
  - run duration
  - collapse large pastes
  - Vim motions
- **Git:** a Spotlight toggle per project (`project.spotlight`, the existing `setSpotlight` API) with a project picker.
- **Memory:** "Project tools", with the project picker, Code map and Config doctor.
- **New pane "Skills & MCP"** (`SettingsPane` value `skills`): the four moved sections above.
- Settings can be opened at a pane from the inspector: `onOpenSettings(pane)`, reusing the existing pane routing.

## Data flow and errors

- No IPC contract changes except the optional `threadIds` filter on `threads:summaries`. Moved components keep their existing props and API calls.
- Errors keep the existing in-component error lines. Banners hide when their data fails to load and never show a stale count.

## Testing

- **Renderer tests** for each tab: sections render in the fixed order; removed items are absent; banners show only with non-empty data; Manage › and the Memory tools route to the right Settings pane.
- **Settings tests:** the Display group toggles the same `uiPrefs` keys; Spotlight calls `setSpotlight`; the Skills & MCP pane renders the moved sections; the Memory project picker defaults to the current project.
- **Existing tests** covering moved components move with them, with updated selectors and no lost assertions.
- `npx vite build` before merge, because CSS modules are not exercised by the test suites.
- Screenshot pass of all four tabs and the new Settings panes in the dev renderer.

## Out of scope

- Merging tabs or changing their order or names.
- New features in moved components.
- The thread header and details card. They are only relied on as the home of the removed duplicates.
