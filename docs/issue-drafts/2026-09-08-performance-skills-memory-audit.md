# Performance, Skills and Memory audit

Source: `6c7a6fbe`, 2026-09-08. No app source changes. Publication delegated to the requested Grok worker. The four finding owners (electron/skills.js, electron/store.js, src/components/SkillsTab.tsx, src/components/MemoryTab.tsx) were compared with GitHub main and matched exactly. Before screenshots are stored alongside this audit as 2026-09-08-skills-before.png and 2026-09-08-memory-before.png.

## Avoid quadratic registry reads and duplicate disk scans when opening Skills

Priority: P1. Performance defect verified at 6c7a6fbe on 2026-09-08.

### Evidence
Opening Skills calls reloadAll: listSkills and listSkillCatalog both scan all user skill directories. listCatalog calls listSkills again. Each managed provider copy calls resolveManagedProvenance -> lookupInstall -> readRegistry, which reads, parses and sanitizes the entire registry. With N managed skills and P provider copies, registry processing grows approximately with P*N², then runs twice. The IPC handler being async does not move its synchronous filesystem work off Electron's main thread.

Disposable fixture, real production functions, three provider copies per skill:

| Skills | Registry reads per paired load | SKILL.md reads | Synchronous elapsed |
| --- | --- | --- | --- |
| 100 | 600 | 600 | 72 ms |
| 300 | 1,800 | 1,800 | 350 ms |
| 600 | 3,600 | 3,600 | 1,160 ms |

A separate read-only scan of the local skills directories returned 62 rows and took 39 ms for the paired load without registry provenance lookup. This is a smaller baseline, not evidence of a current 1.16-second user stall. Timings are one-machine diagnostics; operation counts are deterministic.

### Smallest useful fix
- Read and validate the app-owned registry once per inventory scan and reuse that snapshot for all marker lookups. Keep marker/name/catalog provenance validation intact.
- Derive installed catalog status from the same inventory used by Skills, or coalesce the paired reads. Avoid rescanning every provider for static catalog metadata.
- Reuse parsed metadata for aliases of the same physical SKILL.md within a scan, preserving symlink and dangling-link behavior.
- If remaining cold I/O exceeds the interaction budget, move inventory scanning off the main event loop. Benchmark first; a permanent watcher framework is not required.
- Refresh correctly after add/remove/sync/import and project changes. Avoid an indefinitely stale global cache.

### Acceptance
Instrument the same 600-skill fixture: registry reads are O(1) per inventory, not per provider copy; a paired Skills/catalog load does not duplicate a full inventory. Target at least 80% less elapsed time versus the paired baseline on the same machine, with no main-thread task over 50 ms during tab opening. Report actual before/after p50/p95 and event-loop delay instead of claiming a universal speedup. Verify provenance, sync drift, imported plugins, external edits after refresh, symlinks and project read-only rows still work.

Runnable current-behavior evidence in the audit checkout: `node docs/issue-drafts/2026-09-08-performance-skills-memory-evidence.cjs` (exit 0). It creates/removes synthetic directories and asserts registry/skill read counts; it does not modify live skills.

Sources: [inventory](https://github.com/currentbits/solenta/blob/6c7a6fbebb066942f7f5702084f1af1e0730319d/electron/skills.js#L349), [provenance](https://github.com/currentbits/solenta/blob/6c7a6fbebb066942f7f5702084f1af1e0730319d/electron/skills.js#L293), [registry](https://github.com/currentbits/solenta/blob/6c7a6fbebb066942f7f5702084f1af1e0730319d/electron/skillRegistry.js#L32), [catalog](https://github.com/currentbits/solenta/blob/6c7a6fbebb066942f7f5702084f1af1e0730319d/electron/skillCatalog.js#L38), [tab load](https://github.com/currentbits/solenta/blob/6c7a6fbebb066942f7f5702084f1af1e0730319d/src/components/SkillsTab.tsx#L258).

Separate from #695 provider path correctness and #728 CSS flattening. No app implementation in this audit.

## Keep sidebar content search off the main thread and out of the transcript hydration cache

Priority: P1. Performance defect verified at 6c7a6fbe on 2026-09-08.

### Evidence
After 250 ms of typing a query of at least two characters, Sidebar calls threads.search. Store.searchThreads synchronously loops over every thread, including archived ones. For each title/notes miss it calls getMessages, which reads/parses its shard and retains the entire transcript in _messagesHydrated. A search that finds nothing therefore defeats lazy transcript loading for the entire history. Clearing search does not release those arrays. Limiting output to 50 results happens only after the full scan.

A disposable on-disk fixture with 100 archived threads and approximately 100 MB of transcript data, using the real Store implementation and a warm OS file cache, measured:
- 0 hydrated transcripts before search, 100 afterward.
- 75 ms synchronous search duration.
- 100 MiB additional retained JS heap after forced GC.

This is a synthetic scaling measurement, not a live-store size claim or end-to-end desktop profile. Both cold reads and larger histories can cost more. Moving only disk writes async (#225) or initial hydration lazy (#639) does not address this call path.

### Smallest useful fix
Search persisted shards through a bounded background path that does not populate the main process's transcript cache. Include current unsaved messages in the result so active turns remain searchable. Preserve title/notes matching, archived results, case-insensitive substring semantics, descending updatedAt order and the 50-result cap. Coalesce or cancel superseded searches; renderer generation guards alone do not prevent obsolete backend scans. Avoid a new search service unless a measured workload requires it.

### Acceptance
Repeat the fixture and show that search does not hydrate all archived transcripts in the main Store or retain history-sized heap after completion. Keep the main loop responsive (target no task over 50 ms) while searching. Cover rapid query replacement, no-match, archived matches, current unsaved content, deleted threads and restart persistence. Report search response time, main-loop p95/p99 and retained heap separately. A corrupt shard must not be rewritten by a read-only search.

Runnable evidence in the audit checkout: `node --expose-gc docs/issue-drafts/2026-09-08-search-performance-evidence.cjs` (exit 0). It builds disposable shards, asserts hydration growth, and deletes the fixture.

Sources: [sidebar debounce](https://github.com/currentbits/solenta/blob/6c7a6fbebb066942f7f5702084f1af1e0730319d/src/components/Sidebar.tsx#L1583), [full scan](https://github.com/currentbits/solenta/blob/6c7a6fbebb066942f7f5702084f1af1e0730319d/electron/store.js#L3154), [retained hydration](https://github.com/currentbits/solenta/blob/6c7a6fbebb066942f7f5702084f1af1e0730319d/electron/store.js#L1862), [IPC handler](https://github.com/currentbits/solenta/blob/6c7a6fbebb066942f7f5702084f1af1e0730319d/electron/ipc.js#L486).

Separate from #486 find-in-current-transcript UI and #939 saved sidebar filters. Preserve the already-shipped per-thread storage and lazy boot.

## Make Skills a searchable installed library with separate catalog and MCP setup

Priority: P2. Interaction/layout proposal based on source review and rendering current source in an isolated Electron window with devCoder fixtures (1440x1000, approximately 380px panel).

### Problem
Opening Skills starts with built-in MCP servers, curated MCP servers, added MCPs and the Add MCP form. Only then come curated skills, added skills, project skills and Add skill. In the rendered fixture the first installed skill is below the initial viewport even though the fixture has just two added skills. There is no library search or provider/source filter. Every installed row carries provider fraction, token count, drift and Remove controls, making larger libraries hard to scan. The long single scroll mixes daily inspection with installation and infrastructure setup.

### Proposed behavior
- Default to an Installed skills view with a sticky compact toolbar: search, visible/total count, Add skill.
- Add lightweight provider and source filters (user/project/catalog origin) over the existing inventory. Preserve project read-only status and accurate provider coverage.
- Put Browse catalog and MCP servers in clearly named secondary views/disclosures; show built-in servers compactly. Keep current import file, GitHub preview, manual authoring and trust/replace flows reachable from Add.
- Use compact flat rows: name, short description and meaningful status. Expand a selected row for full provider coverage, source, token estimate and destructive actions. Keep Sync visible when drift exists and explain which providers are missing.
- Preserve search, filters and scroll when moving between library and catalog or returning to the tab. Do not keep running hidden requests merely to preserve view state.
- Separate loading, empty-library, no-results and error/retry states. Project switches must not display late results from the previous project.

### Acceptance
With 200 skills, find one by case-insensitive name or description without scrolling. Provider/source filters compose, show honest counts and clear independently. Installed rows and Add are visible immediately at panel widths 320/380/480px; no horizontal overflow at 125% UI scale. Keyboard users can search, expand, inspect providers and perform the existing install/remove-confirm flows with visible focus. Import previews retain cancellation/cleanup and executable-code trust requirements. Existing theme variables and flat styling remain.

Sources: [section order](https://github.com/currentbits/solenta/blob/6c7a6fbebb066942f7f5702084f1af1e0730319d/src/components/SkillsTab.tsx#L715), [rows and forms](https://github.com/currentbits/solenta/blob/6c7a6fbebb066942f7f5702084f1af1e0730319d/src/components/SkillsSections.tsx), [panel mount](https://github.com/currentbits/solenta/blob/6c7a6fbebb066942f7f5702084f1af1e0730319d/src/components/AgentsPanel.tsx#L3263), [styles](https://github.com/currentbits/solenta/blob/6c7a6fbebb066942f7f5702084f1af1e0730319d/src/components/SkillsTab.module.css).

#728 explicitly excludes layout/functionality, so this complements its CSS contract. #695 owns provider path fixes. Backend duplicate scanning is a separate performance issue from this interaction work. This is not a marketplace rebuild, rebrand or new dependency request.

## Put memories first and support browsing beyond the latest 20 entries

Priority: P2. Interaction/layout proposal based on source review and rendering current source in an isolated Electron window with devCoder fixtures.

### Problem
Memory has a search toolbar, but Code map, Config doctor and Review queue render above the actual memories and mount/load eagerly. The fixture's small map and doctor push the Memories heading to about 445px from the top at 1440x1000; larger maps and queues consume more of the narrow sidebar. The list always requests RECENT_LIMIT=20, shows entries.length as its count, has no type filter or load-more control, and requires a known search phrase to reach older entries. One- or two-character queries leave prior results visible without explaining the minimum three-character search length. Project paths repeat on each row despite project scope already being shown above.

### Proposed behavior
- Keep scope, search, type filter and Add memory at the top; show memory results immediately beneath them.
- Use concise flat rows with title, type and age; reveal body, citations, source and edit/delete-confirm actions on expansion. Show the project once in the toolbar unless a row's scope differs.
- Move Code map and Config doctor behind named secondary disclosures. Keep unresolved-review count visible as a compact action; open the review queue on demand. Load detailed secondary data on first use and allow refresh.
- Expose type filtering through the existing server support (recent already accepts type), extending the proxy/IPC types as needed. Add bounded pagination/load-more for older memories; label loaded count honestly rather than implying that 20 is the entire collection.
- Keep scope, query, selected type and scroll when returning to the tab. Preserve edit drafts during unrelated UI navigation; require an explicit discard where a scope change would abandon text.
- Explain the search minimum or safely support short queries. Distinguish no matches from empty memory, offline server and failed loading, each with an appropriate recovery action.

### Acceptance
With more than 100 project memories, browse to the oldest without guessing its words, filter conventions/strategies/knowledge/tasks across the dataset, and search without scrolling past maintenance tools. Pagination must have deterministic ordering, no duplicate/missing rows and correct project scoping. Expanding/collapsing or retrying a card retains the existing edit/delete state guarantees. Opening the tab does not start hidden map/lint/maintenance detail work. Rapid project changes ignore stale responses. Verify keyboard focus, visible loading/error states, no horizontal overflow at 320/380/480px panel widths and 125% scale.

Sources: [mount order](https://github.com/currentbits/solenta/blob/6c7a6fbebb066942f7f5702084f1af1e0730319d/src/components/MemoryTab.tsx#L934), [recent/search behavior](https://github.com/currentbits/solenta/blob/6c7a6fbebb066942f7f5702084f1af1e0730319d/src/components/MemoryTab.tsx#L646), [server type support](https://github.com/currentbits/solenta/blob/6c7a6fbebb066942f7f5702084f1af1e0730319d/memory-server/src/memory.js#L1496), [HTTP adapter](https://github.com/currentbits/solenta/blob/6c7a6fbebb066942f7f5702084f1af1e0730319d/memory-server/src/index.js#L475).

Complements #728, which excludes layout/functionality. #299 owns governance/suggestions/certification; #719 owns automatic review resolution. This issue is memory browsing and progressive disclosure, not changes to ranking, automatic writes, publication policy or project-key canonicalization.
