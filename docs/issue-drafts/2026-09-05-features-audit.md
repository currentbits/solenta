# Feature and workflow opportunities, 2026-09-05

Four feature proposals plus one reproduced bug. No implementation changes. Published through Grok as #937–#941. Independently verified all five open with plan:todo. Research task t4 is complete.

Recommended sequence: prevent duplicate schedule creation; expose automation editing; add recent-run links; saved views; recently deleted threads. The first two reuse the same form, but remain separate issues because one fixes accidental recurring work and the other adds editing.

## Published issues

- [#937: Edit existing automations in place using the existing update API](https://github.com/currentbits/solenta/issues/937)
- [#938: Show recent runs and open their transcripts from each automation](https://github.com/currentbits/solenta/issues/938)
- [#939: Save named sidebar filter views for recurring triage](https://github.com/currentbits/solenta/issues/939)
- [#940: Recently deleted threads with Undo and a bounded restore window](https://github.com/currentbits/solenta/issues/940)
- [#941: Repeated Add automation while creation is pending creates duplicate enabled schedules](https://github.com/currentbits/solenta/issues/941)

## Evidence and limits

- App source inspected at `6c7a6fbe`; existing backend editing exercised with a real temporary Store.
- Actual AutomationsView repeated-submit check created two enabled rows. It is an isolated audit fixture, not a live automation.
- The four features are product hypotheses grounded in source-visible workflow gaps. No user demand, conversion lift or time savings is claimed as measured.
- Backlog checked: #553/#789 filters/tags, #159 spaces, #160 circuit breaker, #242 triggers, #275 bundles, #285 repeat, #286 caps, #323 digest, #388 templates/dry run, #149/#252 checkpoints, #932 paused-run retention, #933 corruption. No exact duplicates found; publisher rechecks before creation.
- References: [Linear Custom Views](https://linear.app/docs/custom-views), [Linear deletion and restore](https://linear.app/docs/delete-archive-issues), [GitHub Actions run history](https://docs.github.com/en/actions/how-tos/monitor-workflows/view-workflow-run-history?tool=webui). These demonstrate interaction patterns, not Solenta adoption evidence.

Runnable evidence:

```sh
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types docs/issue-drafts/2026-09-05-features-evidence.mjs
```

Exit 0: one CONFIRMED defect and one VERIFIED reuse path.

## 1. Edit existing automations in place using the existing update API

**Feature proposal. Priority: P2. Estimated scope: Small.** Researched at `6c7a6fbe` on 2026-09-05.

### User outcome
After an automation produces an unhelpful result, revise its prompt or model and keep its identity, schedule and associated runs. Today the automation list offers On/Off, Run now and Delete, but no edit action.

### Evidence in the app
AutomationsView.tsx has only a creation form and those three row actions. The existing onUpdate prop is used only for enabled. services.updateAutomation already accepts partial automation fields, validates them, preserves id, and keeps nextRunAt unchanged unless preset/hour changes. A runnable service check confirmed changing prompt/model preserves id and nextRunAt.

### Smallest useful scope
- An Edit action opens the existing form populated from the selected automation.
- Edit name, prompt, provider/model and the existing schedule controls.
- Save through automations.update; preserve enabled and other untouched fields.
- Keep the project fixed in the first version so existing run history stays coherent.
- Show the current prompt when inspecting an automation, even before editing.

### Acceptance
- Editing creates no additional automation and keeps prior run links.
- Prompt/model-only changes preserve the next scheduled time.
- Schedule changes show the recalculated next run.
- Failed save retains edits and exposes retry; Cancel makes no mutation.
- A pending save cannot be submitted twice.

### Boundaries and value
This removes the delete/recreate workaround using an existing backend capability. No cron editor, revisions system, template marketplace or automatic prompt rewriting. #388 covers templates/dry-run lifecycle; #275 covers parameterized bundles; #285 creates an automation from a thread. None supplies this list-row edit flow.

Sources: [AutomationsView](https://github.com/currentbits/solenta/blob/6c7a6fbe/src/components/AutomationsView.tsx#L327), [updateAutomation](https://github.com/currentbits/solenta/blob/6c7a6fbe/electron/services.js#L4568).

Requested disposition: separate Planboard issue, `plan:todo`. Feature proposals are scoped options for later implementation, not claims of shipped behavior.

## 2. Show recent runs and open their transcripts from each automation

**Feature proposal. Priority: P2. Estimated scope: Small–medium.** Researched at `6c7a6fbe` on 2026-09-05.

### User outcome
Answer “What did this automation do last time, and where is the result?” from its row. Open the run transcript directly to inspect the result or failure.

### Evidence in the app
AutomationsView receives AutomationInfo only; rows display schedule, next time, model and one lastError. It has no run list or onSelectThread callback. runAutomation already creates a distinct thread with automationId, so a run's status and transcript exist on the host. ThreadInfo does not currently declare that linkage; expose a small typed query/result rather than inferring runs from titles.

### Smallest useful scope
- Show Latest run with status and Open thread.
- Expand Recent runs to list up to the existing retention limit, newest first, with start time and actual thread status.
- Distinguish working, failed, quota-wait and completed using existing states.
- Say “Recent retained runs”; show a missing-history state when older runs were pruned.
- Use the existing Run now action for a fresh run with current configuration. Do not label it “replay” of an older configuration.

### Acceptance
- Runs from another automation or project never appear, including identical names.
- Clicking a row opens the exact existing thread; viewing history starts no run.
- Run now's created thread is discoverable while it is working.
- Renaming/editing an automation keeps its run association.
- A quota-wait run is shown as paused, not completed.
- Data source stays bounded and handles deleted/pruned threads honestly.

### Boundaries and reference
Reuse retained threads; no parallel execution database, log viewer, analytics dashboard or new retention policy. #323 is a cross-app morning digest; #160 is a failure circuit breaker; #286 is budget enforcement; #932 protects paused runs from retention. This issue is direct inspection from an automation.

GitHub Actions provides a useful pattern of selecting a workflow and opening its run details: [official run-history documentation](https://docs.github.com/en/actions/how-tos/monitor-workflows/view-workflow-run-history?tool=webui). The proposed Solenta need is inferred from the missing navigation and existing run data, not measured user demand.

Sources: [automation rows](https://github.com/currentbits/solenta/blob/6c7a6fbe/src/components/AutomationsView.tsx#L280), [run-thread linkage](https://github.com/currentbits/solenta/blob/6c7a6fbe/electron/automations.js#L139), [AutomationInfo](https://github.com/currentbits/solenta/blob/6c7a6fbe/src/shared/ipc.ts#L2069).

Requested disposition: separate Planboard issue, `plan:todo`. Feature proposals are scoped options for later implementation, not claims of shipped behavior.

## 3. Save named sidebar filter views for recurring triage

**Feature proposal. Priority: P2. Estimated scope: Small–medium.** Researched at `6c7a6fbe` on 2026-09-05.

### User outcome
Switch between “Failed Codex threads” and “Release-tagged threads” with one selection, instead of rebuilding status, provider, project and tag filters each time.

### Evidence in the app
Sidebar already has statusFilter, providerFilter, tagFilter, projectScope and groupBy, plus search. It persists the current settings under separate localStorage keys. There is no named collection or save/recall UI. Existing filtering should be reused.

### Smallest useful scope
- Save the current filter combination with a name.
- Recall, rename, update and delete views from one compact menu.
- Store only filter criteria and optional query, not a snapshot of thread IDs or message text.
- Clearly display the active view and mark it modified when filters change.
- Keep current unsaved filtering fully usable; a saved view is optional.

### Acceptance
- Two saved combinations can be recalled independently after app relaunch.
- New matching threads appear automatically; stale snapshots cannot hide them.
- Apply all criteria together using the existing filter semantics.
- Keep the existing selected-thread exception visible and explained.
- A removed project/tag/provider produces an explicit unavailable/empty state rather than broadening the view silently.
- Removing a saved view affects no threads.

### Boundaries and reference
A local preference feature first. No sharing service, subscriptions, query language or nested boolean builder. #553 supplies filters/grouping; #789 supplies tags; #159 concerns project spaces. This adds reusable named combinations rather than another grouping model.

Linear documents saved, reusable filtered views: [official Custom Views documentation](https://linear.app/docs/custom-views). This is a reference pattern; utility for Solenta is a product hypothesis grounded in its existing multi-filter workflow.

Source: [Sidebar filter state](https://github.com/currentbits/solenta/blob/6c7a6fbe/src/components/Sidebar.tsx#L1467).

Requested disposition: separate Planboard issue, `plan:todo`. Feature proposals are scoped options for later implementation, not claims of shipped behavior.

## 4. Recently deleted threads with Undo and a bounded restore window

**Feature proposal. Priority: P2. Estimated scope: Medium.** Researched at `6c7a6fbe` on 2026-09-05.

### User outcome
Recover an accidentally deleted conversation, including its notes and attachments, without editing store files or recovering a backup.

### Evidence in the app
services.deleteThread guards active runs/worktrees, then immediately purgeThread's the row and all per-thread data, saves synchronously, and schedules image/artifact cleanup. There is archive/unarchive, but no recoverable deletion state or restore endpoint. Once Delete is confirmed, the app offers no undo.

### Smallest useful scope
- Manual thread deletion moves eligible threads to Recently deleted for seven days.
- Show an immediate Undo action and a small restore list with expiry.
- Retain the thread's transcript, notes and references needed to recover attachments/artifacts during that window.
- Restore the same identity and history without starting a run.
- Explicit Permanently delete is available with clear confirmation; expiry uses the existing purge/cleanup machinery.

### Acceptance
- Undo and later Restore recover a manually deleted thread across app restart.
- Trashed threads are excluded from sidebar/search, scheduling, queued-message delivery and orchestration dispatch.
- Existing active-run/worktree deletion guards remain.
- Restoring never auto-runs queued work or an expired quota timer; restored work is idle and requires explicit resume.
- Image/artifact cleanup does not remove data referenced by an unexpired trashed thread.
- Expiry and explicit purge reclaim data once, including after restart.
- An unavailable parent project is explained; restoration cannot silently attach a thread to another project.

### Boundaries and reference
First version covers manual deletion of individual eligible threads. Automated retention, project removal, filesystem/worktree recovery and trash search are separate decisions; do not silently change them. This is not backup, corruption repair (#933), checkpoint rewind (#149/#252), or the paused-run retention fix (#932).

Linear uses Undo plus a Recently deleted area for accidental issue deletion: [official deletion/restore documentation](https://linear.app/docs/delete-archive-issues). Solenta's proposed seven-day window is a bounded local-product choice, not a claim about Linear's retention period.

Sources: [manual deletion](https://github.com/currentbits/solenta/blob/6c7a6fbe/electron/services.js#L3734), [shared purge](https://github.com/currentbits/solenta/blob/6c7a6fbe/electron/services.js#L3721).

Requested disposition: separate Planboard issue, `plan:todo`. Feature proposals are scoped options for later implementation, not claims of shipped behavior.

## 5. Repeated Add automation while creation is pending creates duplicate enabled schedules

**Reproduced bug. Priority: P1. Estimated scope: Small.** Researched at `6c7a6fbe` on 2026-09-05.

### Problem
The Add automation button remains usable while creation is pending. Repeating the click sends the same form twice, creating two enabled automations that will both execute the prompt on schedule.

### Reproduction
1. Mount the actual AutomationsView with a real temporary Store-backed onCreate.
2. Have onCreate call services.addAutomation, then hold its completion promise (models a pending transport/list refresh).
3. Fill a valid name and prompt.
4. Click Add automation twice before the first callback completes.
5. Store now contains two enabled rows with different IDs and identical prompt/schedule.

Confirmed by the runnable artifact below; no live schedules or user data were changed.

### Cause
AutomationsView.submit validates then awaits onCreate without a synchronous pending guard. There is no submission state on the form/button, and the form is cleared only after the await. services.addAutomation correctly creates a new UUID on each call.

### Acceptance
- A pending submission from one form cannot be started twice by click or Enter.
- Show the pending state and allow a subsequent intentional create once finished.
- Failure keeps the typed form and exposes an error/retry.
- Do not globally deduplicate matching prompts: users may intentionally create similar automations.
- Add a deferred-create regression test asserting only one host row/request.

Related #85 handles Run now rejection; this is the creation form. Distinct from #928 transport coalescing and #931 weekly scheduling.

Source: [AutomationsView.submit](https://github.com/currentbits/solenta/blob/6c7a6fbe/src/components/AutomationsView.tsx#L105).

### Runnable evidence
Local audit artifact, asserting current buggy behavior:
```sh
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types docs/issue-drafts/2026-09-05-features-evidence.mjs
```
Exit 0. Also verifies that updateAutomation already supports the proposed in-place editing. Artifact is currently in the audit checkout; steps above are self-contained.

Requested disposition: separate Planboard issue, `plan:todo`. Feature proposals are scoped options for later implementation, not claims of shipped behavior.

