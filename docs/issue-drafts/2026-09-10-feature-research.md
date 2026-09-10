# Solenta feature research: T3 Code, Synara and Orca

Research date: 2026-09-10. Scope: useful feature improvements and remaining UX gaps, continuing the performance and terminal audit.

## Publication status

The six issues from the preceding audit are already on the Planboard: [#1181](https://github.com/currentbits/solenta/issues/1181), [#1182](https://github.com/currentbits/solenta/issues/1182), [#1183](https://github.com/currentbits/solenta/issues/1183), [#1184](https://github.com/currentbits/solenta/issues/1184), [#1185](https://github.com/currentbits/solenta/issues/1185) and [#1187](https://github.com/currentbits/solenta/issues/1187).

**The five new proposals are published.** A Grok worker created them through the host-side Planboard tools. Each issue was independently fetched and verified OPEN with `plan:todo`, including its evidence, scope and acceptance criteria:

| Draft | Published issue |
| --- | --- |
| Browser element context | [#1193](https://github.com/currentbits/solenta/issues/1193) |
| Browser snapshots and diagnostics | [#1191](https://github.com/currentbits/solenta/issues/1191) |
| Files pane previews | [#1194](https://github.com/currentbits/solenta/issues/1194) |
| Before-and-after image review | [#1192](https://github.com/currentbits/solenta/issues/1192) |
| Protection against accidental quit | [#1195](https://github.com/currentbits/solenta/issues/1195) |

**The six existing-issue amendments remain unpublished.** A second Grok worker verified the targets but found no edit/comment operation in its host-side issue tools. The lead's connected GitHub comment tool rejected the attempt with: `MCP tool call requires approval, but approval policy is never`. No replacement issues were created and the existing issue statuses were preserved.

When an authorized host-side amendment operation is available, recheck existing comments and append the six amendments below. Do not recreate the five published proposals. Do not mark proposed features done merely because their research is finished. Use coder-threads tools for Planboard writes; do not use gh for writes.

## Recommendation

Make everyday work easier to explain, inspect and review before adding another orchestration layer.

| Order | Work | Why |
| --- | --- | --- |
| 1 | Existing terminal correctness/lifecycle issues #1182 and #1183; then PTY #1184 and selection/search #1185 | Restore confidence in the terminal and make it useful for actual interactive work. |
| 2 | Quit guard; Files pane and #150 navigation | Protect active work and reduce switching between apps to inspect a referenced file. |
| 3 | Browser element context and bounded browser verification | Let users point to UI problems and let agents return inspectable evidence. |
| 4 | Image diffs, review batches #432/#278 and attention inbox #291 | Reduce the effort of checking results and finding work that needs a decision. |
| 5 | Account identity #453, verification records #244 and linked PRs #154 | Extend existing systems after the daily interaction gaps are addressed. |

Continue the measured performance work in #1181 and #1187 alongside this sequence. The order above is a product recommendation, not a benchmark result.

## What the comparison adds

- **T3 Code:** useful details in [keyboard behavior](https://raw.githubusercontent.com/pingdotgg/t3code/main/docs/user/keybindings.md), [provider identity](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-codex.md) and [linked PRs](https://raw.githubusercontent.com/pingdotgg/t3code/main/docs/user/source-control.md). Adopt the smallest interactions that fit Solenta's existing systems.
- **Synara:** [navigation between tasks and surfaces](https://www.trysynara.com/docs/features/organize) and [browser verification with semantic references and diagnostics](https://www.trysynara.com/docs/workflows/browser-verification). These address context switching and unreliable selector guessing.
- **Orca:** [live element context](https://www.onorca.dev/docs/browser/design-mode), [repository/image viewers](https://www.onorca.dev/docs/editing/viewers) and [batched review annotations](https://www.onorca.dev/docs/review/annotate-ai-diff). These improve how users describe and inspect visual changes.

Orca here means the product at onorca.dev, associated with stablyai/orca. This is a source/documentation comparison, not hands-on testing of the three products or a claim that they outperform Solenta.

## Evidence and deduplication

Local implementation was inspected at commit `9fc8645a2472e493a94c2e4c4c8a942974bff305`. Source links below are pinned to that revision; recheck against the implementation branch before coding. GitHub searches and issue fetches were used to distinguish new residual work from existing plans. Search results are not proof that no duplicate can exist.

Notable existing coverage:

| Area | Existing coverage | Decision |
| --- | --- | --- |
| Embedded browser | #155 is OPEN with plan:done; BrowserPane and preview actions exist | File only the explicit residual element-inspection and diagnostics scopes below. #155 already mentions annotations. |
| Navigation | #150 is OPEN with plan:todo | Amend it; do not file another command palette. |
| Diff comments | #432 and #278 are OPEN with plan:todo; inline comments already exist in ChangesPanel | Add persistent batches and revision-aware re-review to those issues. |
| Approval inbox | #291 is OPEN with plan:todo | Amend with concrete routing and stale-request behavior. |
| Provider instances | #453 is OPEN with plan:todo | Extend identity handling rather than duplicating the account model. |
| PR workspace and stacks | #154 and #240 are OPEN with plan:todo | Separate explicit links from later dependency automation. |
| Run artifacts | #244 is OPEN with plan:todo; artifact types and timeline exist | Add evidence metadata to the existing path. |
| Dev-server isolation | #250 is CLOSED with plan:done and has follow-up work | Do not refile port isolation based on an older checkout. |
| Setup and project actions | electron/projectCommands.js already supports setupCommand and quickActions | Do not copy a competitor's setup UI as a new missing feature. |
| Idle process reclamation | runner.js already caps warm Claude sessions at three and reaps them after 30 minutes | Do not add general agent hibernation just because Orca documents it. |

The browser's three-second status polling does not mean a fresh process scan every three seconds: the server discovery cache has a 30-second TTL. No new performance claim or ticket is based on confusing those intervals. This pass did not produce additional runtime performance measurements.

## New issue drafts

The five drafts below are retained as research provenance for the published issues above. All are `plan:todo`. Priority labels in titles are recommendations.

### Draft 1: P2: Select a browser element and attach precise UI context to the composer

**Outcome:** point at a broken button or spacing problem in the shared Browser pane and tell the agent what to change without describing its location.

**Evidence:** [Orca Design Mode](https://www.onorca.dev/docs/browser/design-mode) documents element selection with HTML, computed styles, a cropped screenshot and source location when available. Solenta's [src/components/BrowserPane.tsx:48](https://github.com/currentbits/solenta/blob/9fc8645a2472e493a94c2e4c4c8a942974bff305/src/components/BrowserPane.tsx#L48) offers screenshot attachment but no element picker. [electron/preview.js:160](https://github.com/currentbits/solenta/blob/9fc8645a2472e493a94c2e4c4c8a942974bff305/electron/preview.js#L160) reports URL/title/navigation state; click/type take CSS selectors.

**Smallest scope:** an opt-in Inspect toggle; hover highlight; click to select without activating the page; a bounded context chip containing page URL, element tag/role/name, selector hint, selected layout/style properties and screenshot crop. Let the user add a comment, then insert into the existing composer. No automatic send. Support one selected element first.

**Acceptance:**
- Selecting a submit button does not submit its form; Escape exits inspection.
- The attachment stays bound to the originating thread, page and capture time even if selection changes.
- Preview the exact content before send; exclude password fields, hidden input values, cookies, storage and tokens. Treat captured DOM as untrusted context.
- Cap DOM/style payload and image size. Report unsupported cross-origin frames or unavailable source locations honestly.
- Keyboard selection or an accessible alternative exists; narrow splits remain usable.
- A mounted interaction check covers select/cancel/send; a packaged Browser-pane check verifies the crop and coordinates.

**Scope boundary:** explicit residual follow-up to #155, which already mentions element annotations but is marked plan:done after the preview shipped. Keep that parent link; do not present this as a previously untracked idea. #460 covers drawing on a still screenshot; this is live element context. No computer-use toggle or desktop control.

### Draft 2: P2: Add bounded browser snapshots and diagnostics for reliable agent verification

**Outcome:** the agent can discover the current form controls and inspect actual browser failures instead of guessing selectors from a screenshot.

**Evidence:** [Synara browser verification](https://www.trysynara.com/docs/workflows/browser-verification) documents semantic snapshots with snapshot-bound element references, console/network metadata and viewport checks. In Solenta, [electron/preview.js:160](https://github.com/currentbits/solenta/blob/9fc8645a2472e493a94c2e4c4c8a942974bff305/electron/preview.js#L160) snapshot only returns navigation metadata; [electron/preview.js:305](https://github.com/currentbits/solenta/blob/9fc8645a2472e493a94c2e4c4c8a942974bff305/electron/preview.js#L305) click/type query CSS selectors. [electron/orchServer.js:1060](https://github.com/currentbits/solenta/blob/9fc8645a2472e493a94c2e4c4c8a942974bff305/electron/orchServer.js#L1060) exposes a short preview action list without semantic tree, logs or viewport controls.

**Scope in two implementation slices:** first add a bounded read-only semantic snapshot and bounded console/exception/request-failure metadata for the existing task-owned webview; then add snapshot-versioned action references and viewport presets. Retain existing selector calls for compatibility. Let the user inspect the same diagnostics panel.

**Acceptance:**
- Snapshot reports visible roles, names and states with strict count/byte/depth limits.
- References include a snapshot/document generation and cannot act on a replacement page after navigation.
- Logs are a bounded ring, cleaned up on unbind/destroy, with no duplicate event subscriptions.
- Network diagnostics expose status/timing/failure metadata, not headers or request/response bodies; remove credentials/query secrets.
- A local fixture containing a failed fetch, console error and invalid form produces accurate evidence.
- Resize is explicit and screenshot evidence records the actual viewport.
- A timeout after an action reports uncertain completion; callers must observe state before retrying a mutation.
- No cross-thread access, general filesystem access or arbitrary JavaScript evaluation API.

**Related:** extends #155. #244 should consume the resulting evidence; #267 is a separate signed-in external-browser bridge and is not required.

### Draft 3: P2: Replace the Files pane placeholder with worktree-aware read-only previews

**Outcome:** open a referenced source file, plan or image next to chat without leaving Solenta.

**Evidence:** [Synara navigation](https://www.trysynara.com/docs/features/organize) documents file search opening the task's docked file view. [Orca viewers](https://www.onorca.dev/docs/editing/viewers) documents rich repository previews. Solenta already declares a Files pane but marks it shipped:false in [src/paneLayout.ts:55](https://github.com/currentbits/solenta/blob/9fc8645a2472e493a94c2e4c4c8a942974bff305/src/paneLayout.ts#L55); [src/components/ThreadView.tsx:6373](https://github.com/currentbits/solenta/blob/9fc8645a2472e493a94c2e4c4c8a942974bff305/src/components/ThreadView.tsx#L6373) renders placeholders for remaining pane types. [src/useCoder.ts:2578](https://github.com/currentbits/solenta/blob/9fc8645a2472e493a94c2e4c4c8a942974bff305/src/useCoder.ts#L2578) sends workspace paths to the OS through shell.openPath.

**Smallest scope:** read-only Files pane for text, rendered Markdown and common raster images. Route transcript file references, file search and a lazy directory tree to this one surface. Preserve Open externally. Show relative path and owning worktree. Add PDF only after the basic path contract works; defer editing, notebook execution and a complete IDE.

**Acceptance:**
- The same relative path in two worktrees opens the correct content; switching threads drops stale responses.
- Resolve paths on the host using existing containment rules, including symlinks, never arbitrary renderer-provided absolute reads.
- File reads are async and size capped; large/binary/unsupported files show an explicit fallback.
- Read directories on expansion; do not recursively watch/index every worktree at boot.
- Render Markdown safely; no scripts in HTML/SVG or unrestricted file:// navigation.
- Preserve per-file scroll/selection while switching previews and reload changed content without jumping unexpectedly.
- Selected lines can be added to the composer with path and line range, preserving the draft.
- Cover deleted files, renamed paths, unreadable files, spaces and path escape attempts.

**Dependencies/dedup:** concrete remaining pane from #552; coordinate file lookup with #150 and path resolution with #492. This is not a new command-palette issue and does not replace external-editor launchers.

### Draft 4: P2: Show before-and-after image changes in Git review

**Outcome:** review an agent's changed screenshot, icon or image asset without accepting an opaque binary change.

**Evidence:** [Orca viewers](https://www.onorca.dev/docs/editing/viewers) documents side-by-side image diffs. Solenta's [src/components/ThreadView.tsx:3820](https://github.com/currentbits/solenta/blob/9fc8645a2472e493a94c2e4c4c8a942974bff305/src/components/ThreadView.tsx#L3820) renders textual patches or a no-textual-diff state; there is no image comparison in ChangesPanel.

**Smallest scope:** side-by-side old/new images for supported raster formats, with clear revision labels, dimensions, file sizes, zoom and checkerboard transparency. Use the exact comparison refs underlying the selected Git diff, not a guessed HEAD. Preserve existing staging and revert behavior. An overlay slider or perceptual scoring can wait.

**Acceptance:**
- Handle added, deleted, modified and renamed images; show the missing side clearly.
- Old bytes come from the selected Git ref/index and new bytes from the actual target side, including uncommitted edits.
- Thread/worktree switches cancel stale reads; filenames never become shell fragments.
- Bound decoded dimensions and transfer sizes; a large or unsupported file gets a useful fallback.
- SVG is either safely rasterized without scripts/network access or deferred.
- Viewing never edits files or the index. Staging still stages the selected file.
- Test deterministic fixture images and verify a real packaged comparison.

**Dedup:** no matching image-diff issue found in current repository searches. #39 is generated-image display and #460 is screenshot markup; neither provides Git before/after review.

### Draft 5: P1: Prevent accidental app quit from silently stopping active work

**Outcome:** an accidental quit shortcut does not terminate several active agents or terminal jobs without showing what will stop.

**Evidence:** [T3 keybindings](https://raw.githubusercontent.com/pingdotgg/t3code/main/docs/user/keybindings.md) documents hold/double-press quit behavior. Solenta's [electron/menu.js:47](https://github.com/currentbits/solenta/blob/9fc8645a2472e493a94c2e4c4c8a942974bff305/electron/menu.js#L47) uses native Quit; [electron/shutdown.js:104](https://github.com/currentbits/solenta/blob/9fc8645a2472e493a94c2e4c4c8a942974bff305/electron/shutdown.js#L104) starts shutdown immediately on before-quit. [electron/main.js:790](https://github.com/currentbits/solenta/blob/9fc8645a2472e493a94c2e4c4c8a942974bff305/electron/main.js#L790) then stops runs, and teardown kills terminals/dev servers. There is no active-work decision before cleanup begins.

**Smallest scope:** for an ordinary user-initiated quit with active runs, questions/approvals or managed terminal/server sessions, show a native dialog summarizing affected work: Cancel or Stop work and quit. No new custom hold-key state machine is necessary. Distinguish warm idle provider processes from active work. Give users a clear opt-out if repeated intentional quitting becomes friction.

**Acceptance:**
- Cancel leaves runs, pending requests, terminals and servers intact; it must happen before any cleanup.
- Confirm invokes the existing one-shot shutdown exactly once and persists state.
- An idle app with no managed background work quits normally.
- OS termination, SIGINT/SIGTERM and crash paths still perform bounded cleanup without waiting for a UI response.
- Planned updater relaunch is handled explicitly so it neither bypasses active-work policy nor gets stuck in recursive quit dialogs.
- Cover menu, shortcut and window-close behavior on supported platforms; macOS window close alone must retain existing semantics.

**Dedup:** #349 addresses recovery of approvals after restart, not prevention of unintended quit. This does not promise crash-proof continuation or restore arbitrary terminal jobs.

## Proposed amendments to existing issues

These are drafts for existing issues, not six additional tickets. Preserve their existing status until implementation actually starts.

### Amend #150: Prioritize recent task and pane switching, then file lookup

Target: [#150](https://github.com/currentbits/solenta/issues/150).

[Synara's navigation](https://www.trysynara.com/docs/features/organize) makes chats, terminals and files reachable from the keyboard. [T3's shortcut configuration](https://raw.githubusercontent.com/pingdotgg/t3code/main/docs/user/keybindings.md) separates terminal-focused bindings from app actions.

Scope the first delivery of #150 to recent tasks/panes and worktree-scoped filename lookup. Feed file results into the proposed Files pane. Preserve the current transcript-search flow; content search can follow using an existing bounded host search path. Avoid a new global index over every transcript and worktree.

Acceptance: deterministic recent order; keyboard selection; correct owning thread/worktree; restoration of pane focus; terminal input shortcuts stay local; asynchronous results cannot navigate a newly selected thread. Measure local MRU opening against a proposed 100 ms budget with 1,000 fixture threads. This is a target, not a measured result. Put remapping into the existing shortcut/settings surface only after the default actions work.

### Amend #432: Keep a batch of anchored review comments until the user submits it

Target: [#432](https://github.com/currentbits/solenta/issues/432).

[Orca's review annotations](https://www.onorca.dev/docs/review/annotate-ai-diff) and [Synara's PR workflow](https://www.trysynara.com/docs/workflows/pull-requests) make a collection of findings actionable together.

Solenta's ChangesPanel currently keeps one local comment draft and sends a formatted follow-up immediately; the local state resets on thread switch (src/components/ThreadView.tsx around lines 3500 and 3656). Extend #432 with a review tray backed by stable thread/file/hunk identities. Users should be able to collect several notes, edit/remove them, then submit one follow-up. Preserve notes across thread switches.

Acceptance: submitting twice cannot enqueue twice; cancellation preserves the batch; stale hunks show that their source revision changed; comments are not silently moved to unrelated lines. Coordinate with #278 by recording the reviewed commit and showing the next interdiff. Do not claim a finding is resolved just because a run ended. Reuse current inline commenting and diff parsing.

### Amend #291: Make the attention inbox the entry point for blocked work

Target: [#291](https://github.com/currentbits/solenta/issues/291).

[Orca notifications](https://www.onorca.dev/docs/notifications) retain activity and navigate back to the relevant workspace. For Solenta, prioritize pending permissions and questions before expanding notification history.

Use #291 for an actionable list grouped by owning thread, with the blocking reason, age and a direct jump to the relevant card. Coordinate background badges with #491. A failed verification can appear as an attention item, with different actions from a permission request.

Acceptance: count unresolved items accurately; replace or remove stale request IDs; revalidate the request at action time; opening a thread does not approve anything; keyboard users can reach the request. No blanket approve-all action. Prefer the existing push state and request identities over another polling loop or independent event database.

### Amend #453: Make provider identity explicit and keep credential contexts isolated

Target: [#453](https://github.com/currentbits/solenta/issues/453).

[T3's Codex provider documentation](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-codex.md) distinguishes isolated accounts from shared session homes. [Orca's account switching](https://www.onorca.dev/docs/agents/codex-hot-swap) describes account changes applying to new processes while running processes retain their original context.

Extend #453's named instances with a clear account/config label beside provider selection, and a visible identity for the currently running process. Show provider-reported allowance/reset data only when available and distinguish it from Solenta's own spend estimate.

Acceptance: changing the selected instance does not overwrite process-global credentials or alter a running process; reused sessions cannot silently cross account boundaries; unsupported identity/usage is shown as unavailable; switching is deliberate, with no automatic billing-account failover. Start with the existing per-instance configuration boundary, not a new secrets service.

### Amend #244: Attach verification evidence to the exact code and browser state tested

Target: [#244](https://github.com/currentbits/solenta/issues/244).

[Synara browser verification](https://www.trysynara.com/docs/workflows/browser-verification) associates inspection and screenshots with a task. Solenta already has run-artifact types and timeline plumbing, so #244 should extend those records.

A compact verification record should name the run, worktree, commit plus dirty-state indicator, command/exit result, and optional browser URL/viewport/screenshot. A later edit must make an earlier result visibly stale. When worktree content is dirty, a commit SHA alone is insufficient proof of what ran.

Acceptance: evidence remains linked to its producing run; screenshots carry capture time and actual viewport; failed and unavailable checks remain visible; deleting expired artifacts leaves understandable metadata; sensitive command output is not automatically published. Show one readable summary with expandable existing artifacts. Avoid a second artifact store or a new replay engine.

### Amend #154: Support explicit linked PRs before attempting stacked-PR automation

Target: [#154](https://github.com/currentbits/solenta/issues/154).

[T3 source control](https://raw.githubusercontent.com/pingdotgg/t3code/main/docs/user/source-control.md) supports explicit PR links and their independent states. Solenta's current thread shape has singular prNumber/prUrl fields (src/shared/ipc.ts around line 385).

Extend #154 with a small list of explicit linked PRs, per-link status and open/refresh/unlink actions, while preserving the primary PR used by current actions. Start with links on the project's GitHub host. Keep stack dependency operations in #240.

Acceptance: old singular records migrate without losing their primary link; linking a URL validates host/repository/number; refreshes are bounded and coalesced; one merged PR does not settle a thread with another linked PR still open; unlinking does not close or merge anything. Show the exact target before a write. Defer automatic stack rebasing and merge orchestration until the linked-PR model is reliable.

## Verification of this research

Code paths and current issue state were inspected; competitor claims link to their own documentation. Only this research document was added. No application behavior changed, no runtime performance gain is claimed, and no application test suite was needed for this documentation-only pass. Each proposal includes implementation acceptance checks so a later agent can verify behavior instead of treating competitor documentation as a specification.

## Follow-up pass: search, background work and recovery

Continued on 2026-09-10 at the same source revision. Three Grok workers cover background performance, failed-run/queue recovery, and publication of the lead's search finding. App implementation remains unchanged.

### Confirmed: filtering after the search cap hides valid results

Published and verified OPEN with plan:todo as [#1201](https://github.com/currentbits/solenta/issues/1201). The real Store.searchThreads sorts all matches and keeps 50 before Sidebar applies project/status/provider/tag filters. A fixture with 50 newer matching idle Claude threads in project A and one older matching failed Grok thread in project B tagged release reproduced false-empty results for each of the four filters. The active-thread carve-out cannot recover the discarded result either.

This is distinct from [#1122](https://github.com/currentbits/solenta/issues/1122), which addresses synchronous search and retained transcript memory, and [#919](https://github.com/currentbits/solenta/issues/919), which addresses request failures shown as empty results. Coordinate the fix with #1122: apply scope before the cap or paginate bounded results, rather than raising the cap or repeating synchronous scans.

The deterministic check used Store.prototype.searchThreads on an in-memory fixture and the real src/sidebarFilters.ts filterThreads. Every title matched, so getMessages was replaced by a throwing guard to prove no message reads were needed. It asserted one pre-cap match and zero post-cap matches for each filter. The check passed; this is function-level evidence, not desktop interaction testing.

### Ruled out or already tracked

- Search lowercasing/full-history hydration remains covered by #144/#1122. Search failure presentation is #919. No duplicate issues were filed for these.
- Basic timeline assembly did not justify a separate optimization ticket: buildTimeline with 1,100 messages, 500 work-log items and 100 artifacts measured 0.045 ms median and 0.140 ms p95 across 101 samples after 100 warmups. Output length was asserted on every sample. This measures synthetic function CPU only, excluding React, Markdown and DOM work; it does not establish that the whole transcript is fast. The known provenance bottleneck remains #1181.

### Recovery findings

- [#1202](https://github.com/currentbits/solenta/issues/1202), OPEN with plan:todo: failed edit-and-resubmit can leave the earlier conversation tail truncated and the edited prompt unavailable. The lead verified that useCoder.rewindAndResubmit calls threads.rewind before startRun, services.rewindThread truncates and saveNow persists the change, and ThreadView closes the confirmation on rejection. The proposal calls for recoverable rewind state and retaining the draft. This is source-confirmed; no live-run data-loss experiment was performed. Implementation must handle uncertain start completion and optional file restoration without rolling back a run that actually started.
- [#1203](https://github.com/currentbits/solenta/issues/1203), OPEN with plan:todo: propose parking queued follow-ups after failure or Stop, with an explicit action to resume. The lead verified that stopRun sets idle and calls notifyRunTerminal with stopped, and the queue drain guard excludes working/pending-plan states but not failed/stopped terminals. This is an intentional behavior-change proposal based on current source, not a claim that every queued recovery instruction is invalid. Keep an explicit Send now path, preserve the queue, and retain automatic continuation after successful completion. No live runner reproduction was performed.

### Confirmed: work logs still make the store envelope expensive

Published and verified OPEN with plan:todo as [#1204](https://github.com/currentbits/solenta/issues/1204). Message sharding is already implemented; workLogByThread still rides in the shared envelope. Store._flushAsync calls _serialize synchronously before asynchronous disk writes. One active thread can therefore force serialization of work logs belonging to every archived thread.

The worker reported approximately 50 ms and 38.5 MB for a synthetic 600-thread fixture at the 500-item per-thread cap. The lead independently exercised the real Store._serialize method with 600 threads and 500 distinct work-log rows per thread, using an identity secret helper and no filesystem writes. Across seven timed samples after one warmup, the median was 42.96 ms and the payload was 37,779,360 bytes. Replacing workLogByThread with an empty map reduced that fixture to 71 bytes and approximately 0.019 ms. The serialized result was parsed to assert that all 600 work-log collections were present.

These synthetic figures establish scaling, not the current live store's size or a measured app-wide frame delay. The issue calls for persisting only changed work logs while preserving archived history, lazy transcript loading and crash recovery. No new database or wholesale storage rewrite is prescribed.

This follow-up published four issues total: #1201, #1202, #1203 and #1204. The earlier six amendment drafts remain unpublished for the tool limitations recorded above.

### Pending correction to published #1203

The worker's final review confirmed that the published title/body overstate the evidence. Keep #1203 OPEN with plan:todo, but revise its framing before implementation. The remote issue has not been corrected: worker tools lack comment/update operations, and the connected GitHub comment operation was previously rejected under approval policy never. This correction is additional to the six earlier unpublished amendments.

**Suggested title:** P2: Add pause, review and resume controls for queued follow-ups after failure or Stop

**Replacement framing:** Auto-draining queued messages after failed/stopped terminals is current product behavior, not proof that every such continuation is wrong. A queued message may itself be a recovery instruction. The useful gap is explicit control over whether to retry the failed instruction, edit/send the queued follow-up, or leave it parked.

**Proposed scope:** preserve queued text and attachments when parked; expose Send now, Edit and Cancel; keep failed-turn retry distinct from sending the queue. Define how user Stop and CLI-classified cancellation affect continuation instead of assuming their intent is identical. A queued-strip Cancel removes only that queued message and must not stop the current run. Do not add a blanket block on all failures or reinterpret intentional absence of Retry after user Stop as a bug. Preserve successful completion, quota-wait/failover, plan approval and inbound-policy behavior.

**Acceptance:** test failure, user Stop, CLI cancellation, queue Cancel and successful completion separately. Each action must make its target clear, preserve unsent input, and avoid consuming a queued recovery instruction as part of Retry turn without an explicit choice. Source references and the source-only evidence limit in the original issue remain valid.

The final review also confirmed #1202's rollback gap: truncateFromMessage returns a count, not a retained snapshot; the boot backup and optional worktree checkpoint restoration do not provide rollback of a failed edit-and-resubmit.

## Third pass: review scale and attachment ownership

Continued on 2026-09-10. Worker candidates are reviewed before publication because the current issue tools cannot revise a published body. No application code changes are part of this pass.

### Reproduced: a screenshot from thread A enters thread B's composer

Published and verified OPEN with plan:todo as [#1206](https://github.com/currentbits/solenta/issues/1206); the remote body exactly matches the reviewed draft. The lead mounted the real ThreadView and Composer using the repository DOM harness, opened A's Browser pane and clicked Add screenshot. The preview capture completed, while onSaveAttachmentImage stayed pending. After switching A -> null/loading -> B, resolving the save caused an A screenshot.png attachment chip to appear in B's composer. The check asserted an empty attachment list before resolution, the wrong-thread chip afterward, and the B thread title; it exited 0 with no React console errors.

The cause is ThreadView's unowned incomingAttachments handoff after awaiting screenshot save. Clearing that state on a thread switch cannot guard a promise that completes later. Composer's attachment map is already keyed by thread, but it receives this incoming image in the new thread's context. The app-window capture callback writes the same unowned state after its own await; that sibling is source-confirmed and should use the same fix.

The issue calls for origin/request identity across both capture and save, preservation or explicit rejection of stale results, and a mounted parent-to-composer regression. This is an existing screenshot correctness bug, separate from #1193's proposed live element picker and #460's image markup. Evidence uses deferred API responses and synthetic image metadata; it does not claim native desktop capture testing.

### Reproduced: a large first diff hides later source-file hunks

Published and verified OPEN with plan:todo as [#1209](https://github.com/currentbits/solenta/issues/1209); the remote body exactly matches the reviewed draft. The lead independently exercised the real worktrees.diff service and reviewItinerary.parsePatch against a disposable Git repo containing a 10,000-line lockfile rewrite and one-line changes in two later source files. Full Git output was 1,078,272 bytes and parsed as three files. The service returned all three metadata rows but only 100,000 patch characters, so the actual parser returned the lockfile alone. Both small source-file patches were missing. Assertions passed and the temporary repo was removed.

The approved proposal retrieves bounded patches per selected file or otherwise allocates the preview budget per file. Keep truthful oversized-file states and bounded IPC/rendering; removing the global cap is not the fix. A separate worker candidate about mounting every hunk line was folded into this scope as a preview limit requirement, since no independent React/DOM performance measurement supported a second ticket. Parsing cost alone does not establish rendering cost.

### Reproduced: failed image paste has no visible error

Published and verified OPEN with plan:todo as [#1211](https://github.com/currentbits/solenta/issues/1211); the remote body exactly matches the reviewed draft. The lead mounted the real App, useCoder and Composer with fakeCoder, dispatched an image clipboard event and supplied a data URL through a simulated FileReader. When the host returned attachment:null, the paste was consumed but produced neither a chip nor an error alert. Changing the same callback to return a valid attachment made a subsequent paste produce its chip, providing a success control. Assertions passed without React console errors.

Composer ignores the null result and rejected save, while useCoder also converts save errors to null. The existing composer error strip can cover this path. The ticket calls for visible reader/save failures, useful host reasons where available, partial-success handling and thread ownership. It does not expand format support or upload limits. This is a mounted simulated-host reproduction, not a native oversized-clipboard experiment.

### Reproduced: queued images disappear when Cancel restores the text

Published and verified OPEN with plan:todo as [#1212](https://github.com/currentbits/solenta/issues/1212); the remote body exactly matches the reviewed draft. The mounted App/useCoder/Composer fixture had a working thread with a queued prompt and one image. The queue strip displayed no attachment chip. Cancel into an empty composer restored the text but no image; a separate threads.list read confirmed the host queue had cleared. Assertions passed without React console errors, and no live attachments were removed.

App forwards the queued prompt/items/error without attachment metadata and restores only text after cancellation. The proposal carries the existing attachment metadata into the queue strip and same-thread draft restoration. It must preserve an already nonempty draft and coordinate failed host cancellation with #1186/#1199. This is separate from #1203's proposed queue-drain policy; automatic drain and Send now already retain the host attachment payload.

This pass published four issues: #1206, #1209, #1211 and #1212. All four have independent reproductions, reviewed bodies and verified OPEN/plan:todo records. Grok workers published the issues through host-side Planboard tools. No application code or Git state changed. The six earlier amendments and the #1203 correction remain unpublished under the tool limitations recorded above.

## Fourth pass: useful workflows from current competitor sources

Continued on 2026-09-10 at Solenta revision 9fc8645. Three Grok workers review T3 Code, Synara and Orca independently, with lead review before publication. This remains research and planning, with no application implementation.

### Reproduced: quick-action output is unavailable after successful completion

Published and independently verified OPEN with plan:todo as [#1216](https://github.com/currentbits/solenta/issues/1216), with the exact reviewed body. [T3's runProjectScript](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/ChatView.tsx#L3703), inspected on 2026-09-10, opens a terminal for project actions. Solenta already has setup commands and named quick actions through completed #153. The useful residual is reading and reusing their output: projectCommands.runOne returns a bounded CommandRunResult.log, but eventText omits successful output and ThreadView.runHeaderCommand ignores the result. Failures retain only a short event tail.

The lead mounted the real ThreadView and called the real projectCommands.runCommand using an in-memory store and a simulated process result. A distinctive coverage output appeared in the returned successful result but neither saved event. The output was absent after clicking the action and after remounting with those events. All assertions passed with no React console errors. No live project command was executed. The runnable check is /tmp/solenta-command-output-evidence.mjs, using the existing renderer harness.

The proposed first delivery is a bounded expandable result with command, worktree, exit result, duration, Copy and Add to prompt. Preparing a draft must preserve existing text/attachments and origin identity. It does not require a live terminal redesign. Coordinate setup-specific logs with #396, interactive terminal work with #1184/#1185, and verification evidence with #244. Do not retain unbounded output in the shared store envelope.

### Synara: pin important messages

Published and independently verified OPEN with plan:todo as [#1217](https://github.com/currentbits/solenta/issues/1217), with the exact reviewed body. [Synara Organize](https://www.trysynara.com/docs/features/organize) documents message pins beside notes and markers for returning to transcript moments. Solenta has whole-thread pins, scratch notes and revealMessageId, but no per-message bookmark collection. The lead verified those source paths and searched existing issues for bookmark/message pin coverage.

The approved scope uses one small capped message-pin list, with optional labels and the existing reveal path. A stale/deleted message cannot silently redirect a bookmark. Source identity and notes-save state remain separate. This is a source/documentation feature proposal, not an implemented or benchmarked interaction.

### T3: selected quotes and files in question answers

Published and independently verified OPEN with plan:todo as [#1218](https://github.com/currentbits/solenta/issues/1218) and [#1219](https://github.com/currentbits/solenta/issues/1219), both with exact reviewed titles and bodies. [T3's composer documentation](https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md#quote-an-assistant-response) supports quoting a selected passage and returning to its source. Solenta's existing Reply captures the whole assistant message; wrapReplyContext already caps the quoted text. The first proposal reuses that reply chip/wrapper for selected visible text, preserves surrounding draft content and adds source navigation. It keeps whole-message Reply and avoids a second context store.

[T3's question attachment documentation](https://github.com/pingdotgg/t3code/blob/main/docs/user/question-attachments.md) describes files bound to individual answers and saved on the thread's execution environment. The lead fetched this file through the GitHub read tool after the web fetch failed. Solenta's QuestionPrompt currently emits text answers, with separate routes for blocking permission questions and persisted questions that become the next turn. The second proposal requires both adapters to be checked separately, accessible saved-file paths, upload gating, retryable drafts and explicit unsupported-channel behavior. It does not assume arbitrary binary fields can be added to a provider's permission response, or that a local path is accessible on a remote host.

These T3 proposals are source/documentation comparisons, not live T3 tests. Existing #381 whole-message Reply, #1190/#1171 question plumbing and #647/#687 question lifetime remain relevant dependencies.

### Reuse existing plans

Synara's provider handoffs, persistent goals, cached recaps, debug mode and exports are already represented by #237, #238, #239, #380 and #394. The lead fetched each and verified OPEN/plan:todo; none was refiled. These are existing plans, not claims that all five workflows are implemented. Solenta's setup/named actions and split-pane persistence already exist; Spaces were deliberately retired, so a competitor's Spaces UI is not a reason to revive them.

### Orca: independent Best of N candidates

Published and independently verified OPEN with plan:todo as [#1223](https://github.com/currentbits/solenta/issues/1223), with the exact reviewed title and body. [Orca's first three-agent session](https://www.onorca.dev/docs/first-session) puts each implementation in its own worktree. The lead traced Solenta's runBestOfN through App.handleForkOpen, useCoder.forkThread and services.forkThread: the race passes provider/model but not worktree:true, which the service requires to mark a user fork for lazy worktree creation. The relevant service was also checked against the current GitHub main file. This is source evidence of missing isolation in the launch contract, not a live concurrent-write or data-loss experiment.

The worker initially proposed changing every Fork/Handoff/Best of N path and starting from a live source branch. The lead narrowed that to Best of N implementation candidates, distinct worktrees and a shared captured committed revision. Start revision must remain separate from merge/PR destination. The proposal preserves explicit worktree:false research forks, Ask behavior and ordinary-fork semantics. Worktree creation failure must not fall back to the shared checkout.

Deduplication found #948 already CLOSED/plan:done with a merge comment for orchestration source snapshots. Reuse that contract rather than refiling source provenance or asserting that orchestration workers should always start from the default branch. #237 covers same-thread provider handoff, #187/#775 base selection, #281 candidate grading and #241/#344 plan/sketch races. The new scope is the existing Best of N launch integration.

[Orca worktrees](https://www.onorca.dev/docs/model/worktrees) also documents parent-workspace nesting, which is visual hierarchy rather than Git ancestry. Solenta already nests via handoffFrom. Config-file sharing remains #185/#396, and base selection already shipped under #187. [Orca session restore](https://www.onorca.dev/docs/model/session-restore) describes a daemon that owns running PTYs across app quit, but not host reboot. That is an architectural extension to consider with existing #245 headless work; it is not another quit-confirmation ticket or a small terminal view enhancement. None of these were refiled.

### Fourth-pass delivery order

| Order | Published issue | User benefit |
| --- | --- | --- |
| 1 | [#1223: Best of N isolation](https://github.com/currentbits/solenta/issues/1223) | Independent implementation candidates with an explicit common starting point. |
| 2 | [#1216: Quick-action results](https://github.com/currentbits/solenta/issues/1216) | Inspect successful output and carry evidence into a prompt. |
| 3 | [#1218: Selected quotations](https://github.com/currentbits/solenta/issues/1218) | Refer to the exact passage that needs attention. |
| 4 | [#1217: Message pins](https://github.com/currentbits/solenta/issues/1217) | Return to important decisions in long threads. |
| 5 | [#1219: Question attachments](https://github.com/currentbits/solenta/issues/1219) | Supply screenshots/logs alongside an answer, with verified adapter support. |

Grok workers published all five through host-side Planboard tools. The lead verified each full body, title, OPEN state and plan:todo label. This ordering is a product recommendation, not a measured estimate of implementation effort. Research is complete for this pass; app behavior is unchanged. Earlier unpublished amendments and the #1203 wording correction remain pending under the tool limitations recorded above.

## Fifth pass: RAM retention and task cleanup

User requested a focused memory, finished-agent cleanup and lifecycle edge-case audit. Grok workers checked retained Store/renderer/runner data and provider-process lifecycle; the lead checked peripheral resources and the optional transcript exporter. Baseline remains 9fc8645. This is research only. No live user process was stopped and no live thread, project, attachment or worktree was deleted.

### Reproduced: unbounded optional transcript-export queue

The real createSessionRecorder retains an unlimited queue while a single serial pump awaits memory-service requests. The runner adds final assistant/tool messages when a task finishes, so finished tasks can still contribute retained export work. The default HTTP timeout already exists at five seconds. A service that immediately reports unavailable is different from one that remains running but responds slowly or repeatedly times out.

The lead ran /tmp/solenta-session-queue-evidence.cjs with node --expose-gc. A deferred fake proxy plus 2,000 unique 32 KiB entries left 1,990 queued and ten in the in-flight batch, with exactly one request started. Forced-GC heap grew by 65,793,920 bytes; disposal and releasing the request reduced the delta to 51,808 bytes. The fast-service control eventually sent all 25 entries. This is synthetic stress evidence, not production RSS or expected savings for an ordinary user. No network service, live data or child process was used.

Published and independently verified OPEN plan:todo as [#1224](https://github.com/currentbits/solenta/issues/1224), with the exact reviewed title/body. The proposal adds fixed byte/count limits to this optional mirror, with a defined overflow policy and accounting cleanup. It preserves the authoritative Store conversation and never blocks agent completion. No new database or export framework is needed.

The control also exposed an existing flush timing edge: flush returned after 24 of 25 sends, with the final send completing on the next event-loop turn because pump started another batch while flush awaited the first. This is recorded as secondary source/test evidence; it has not been published as a separate issue or described as a desktop shutdown failure.

### Reproduced: previously visited transcripts remain in renderer RAM

Published and independently verified OPEN plan:todo as [#1225](https://github.com/currentbits/solenta/issues/1225), with the exact reviewed title/body. useCoder.detailCacheRef stores every selected ThreadDetail and never evicts an entry. Delete/project removal reconcile the visible selection but do not remove cached details. This differs from the localStorage boot snapshot, which retains only the last transcript.

The lead mounted the actual useCoder hook with a fake host that created forty distinct completed-thread details of 64 unique 16 KiB messages each. The host did not retain returned details. After selecting all forty, clearing selection and clearing localStorage, all forty WeakRef-observed details survived forced GC, with 41,763,688 bytes additional heap. Revisiting the first thread while its new API response was held painted its full cached content. The check passed without React console errors. Source in current main was also fetched and confirmed unchanged.

The runnable check is /tmp/solenta-detail-cache-evidence.mjs using node --expose-gc and the repository's existing renderer loaders. The proposal bounds the existing Map by recent usage and bytes, preserves the selected detail and useful fast switching, and evicts permanently removed IDs. It does not remove history or touch drafts. This measures synthetic hook retention, not native Electron RSS or main-process Store memory.

The worker's first draft combined fake main/renderer maps and claimed memory release from dropping lastPush/lastWorkflow. That estimate was not accepted: real lastPush message objects are shared with the Store, and dropping one reference does not prove that heap is reclaimed. Completed workflow fallback also has legitimate callers. Those maps remain source notes related to #89/#560, not a separately published P1 leak or a claim that deleted workflows can be revived.

### Reproduced: project removal skips idle-session retirement

The lead exercised real IPC_HANDLERS and a real disposable Store with simulated runner session handles. Single-thread deletion called disposeClaudeSession for its victim. Project removal deleted the remaining thread and project without calling that method, leaving the simulated warm handle registered. Source shows the same asymmetry: threads:delete calls retireAgent, projects:remove does not. The projects:remove handler was also fetched from current main and matches. The check /tmp/solenta-project-cleanup-evidence.cjs passed and removed its fixture.

Published and independently verified OPEN plan:todo as [#1227](https://github.com/currentbits/solenta/issues/1227), with the exact reviewed title/body. The P2 reuses existing disposal after successful project removal. Preserve the active-run guard and other projects' sessions. The existing maximum of three warm sessions and 30-minute timeout still bound this retention; the evidence does not establish unlimited process growth or quantify live CLI RSS.

### Reproduced: Stop during preparation still permits a later launch

The provider worker identified the shared first-turn bootstrap await before any provider inserts its active entry. The lead reproduced it with real createRunner, real temporary Store, a held bootstrapMemory callback and an injected generic launch function. While bootstrap waited, Store status was working but runner.isRunning was false. stopRun returned without stopping; releasing bootstrap then invoked the agent once and made isRunning true. No actual provider ran.

A second scenario invoked real services.deleteThread with the runner guard during the same await. Deletion succeeded, then releasing bootstrap caused the continuation to throw on the missing thread. This is API-level evidence, not a claim about Delete-menu visibility while a thread is working. Both scenarios passed in /tmp/solenta-prelaunch-stop-evidence.cjs and the fixtures were removed.

Published and independently verified OPEN plan:todo as [#1228](https://github.com/currentbits/solenta/issues/1228), with the exact reviewed title/body. The narrowed proposal gives pending launches a cancellable identity at the shared start boundary and checks it after async preparation. Stop and stopAll invalidate it; deletion guards account for preparation; late continuations cannot spawn or overwrite a newer run. Normal first-turn bootstrap and fail-open memory behavior stay intact.

The worker's broader proposal to stop all active providers when archiving was not published. Current orchestration tests deliberately permit archive-as-hide while work continues, so changing that policy is not a proven memory fix. Source concerns about quota timers and /btw ownership after lifecycle changes remain unproven follow-ups; they are not counted as reproduced leaks or new Planboard issues.

### Existing coverage and integration discrepancies

- Claude warm-session cleanup exists: maximum three idle sessions, a 30-minute reaper, and explicit retirement for several user lifecycle actions. Background subagents and in-flight work require separate treatment; generic hibernation is not a missing feature.
- Terminal ownership and permanent-removal cleanup remain [#1183](https://github.com/currentbits/solenta/issues/1183), OPEN plan:todo. Pane hide/show intentionally preserves a shell; permanent deletion must eventually release it.
- Work-log envelope serialization remains [#1204](https://github.com/currentbits/solenta/issues/1204), OPEN plan:todo. The previous synthetic measurement still applies; it is not a fresh full-transcript serialization defect.
- [#1147](https://github.com/currentbits/solenta/issues/1147) is CLOSED plan:done and its comment says devserver.stop was wired into stopRun and retireAgent. However, current main fetched on 2026-09-10 still shows ipc.retireAgent calling only disposeClaudeSession. The local checkout also lacks the documented calls. Keep the finding attached to #1147 rather than filing the same cleanup again.
- [#1122](https://github.com/currentbits/solenta/issues/1122) is CLOSED plan:done with a landed comment, correcting the earlier status recorded in this research. Current main fetched on 2026-09-10 still shows synchronous Store.searchThreads calling getMessages for content misses. This discrepancy needs integration reconciliation, not another search issue.
- A separate suggested-work chip covers tracing where the #1122/#1147 fixes landed and reconciling issue state with main. That integration task was not started by this audit.

### Fifth-pass priorities and validation

| Priority | Issue | Outcome |
| --- | --- | --- |
| First for run control | [#1228](https://github.com/currentbits/solenta/issues/1228) | Stop also cancels preparation before provider launch. |
| First for RAM | [#1225](https://github.com/currentbits/solenta/issues/1225) | Bound renderer memory retained by ordinary thread browsing. |
| Next for cleanup | [#1227](https://github.com/currentbits/solenta/issues/1227) | Release warm agent sessions after project removal. |
| Next for overload | [#1224](https://github.com/currentbits/solenta/issues/1224) | Bound optional transcript-export backlog when the sidecar is slow. |

These four were published by Grok through host Planboard tools and independently fetched: exact reviewed title/body, OPEN, plan:todo. The four lead reproductions passed against actual app modules with synthetic inputs. Feature tickets are implementation backlog; none was marked done. Application source and Git state were unchanged. Measurements describe separate synthetic fixtures and must not be added together as predicted real-world RAM savings.

### Late reproduced edge: app exit discards process-kill escalation

The provider worker's final follow-up identified the delayed killTree SIGKILL timer being discarded by explicit app exit. The lead independently reproduced this using the actual proc.js killTree and shutdown.js installShutdown/runAppCleanup in a disposable parent process, with a stub app.exit calling process.exit. Its owned detached child installed a SIGTERM handler before sending READY, then wrote a heartbeat every 50 ms. Cleanup scheduled killTree(child, 3000) and returned; the parent exited with code zero.

The lead waited 3.4 seconds, beyond the production escalation deadline, and observed the child heartbeat at 3,354 ms after parent exit. The outer fixture then SIGKILLed its own process group and removed its temporary directory. This corrects the weaker check of survival at 400/900 ms, which is still inside the intended three-second grace period and would not by itself prove failed escalation. /tmp/solenta-quit-escalation-evidence.cjs passed. These were disposable synthetic Node processes, not actual providers or user processes, and the test used a stub Electron app rather than native quit interaction.

Published and independently verified OPEN plan:todo as [#1232](https://github.com/currentbits/solenta/issues/1232), with the exact reviewed title/body. The proposal makes final process teardown await owned child exits or bounded escalation before app.exit, preserving prompt shutdown for cooperative children. Simply ref'ing the timer cannot defeat explicit process exit. Reuse process-group ownership and existing helpers, preserve simulator-finalization order and verify terminal/devserver timer siblings. This is separate from #1195's pre-cleanup quit confirmation and #1228's not-yet-spawned cancellation race.

The completed fifth pass therefore added five verified issues: #1224, #1225, #1227, #1228 and #1232. Prioritize #1225 for RAM and #1228/#1232 for dependable cancellation/cleanup. All five have passing lead reproductions, exact reviewed remote bodies and implementation status plan:todo.
