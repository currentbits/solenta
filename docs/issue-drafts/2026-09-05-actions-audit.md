# Thread actions audit, 2026-09-05

Source: `6c7a6fbe`. Three reproduced findings; published through Grok as #934–#936; independently verified open with plan:todo. Research task t3 complete. No application source changes.

Checked related #147, #194 and #421 and searched terminal, notes and review persistence issues for overlap. No matching defect found. The suspected transcript-fetch race was left out because its production event ordering was not proven. Review acceptance's initial normal-quit hypothesis was corrected: desktop cleanup calls saveNow; the actual issue is missing persistence while the app remains open.

Evidence command (exit 0, three CONFIRMED assertions):

```sh
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types docs/issue-drafts/2026-09-05-actions-reproduce.mjs
```

## 1. Overlapping terminal reads duplicate scrollback on slow connections

**Priority: P2.** Reproduced at commit `6c7a6fbe` on 2026-09-05.

TerminalPane can append the same output multiple times when a read takes longer than its 250 ms polling interval. This makes test/log output unreliable even when replies arrive in order.

### Reproduction
1. Mount the actual TerminalPane with a running session and cursor 0.
2. Fire two 250 ms polling ticks before resolving the first read.
3. Both read requests carry since=0.
4. Return the first snapshot as text="first\\n", cursor=6, reset=false.
5. Return the second as text="first\\nsecond\\n", cursor=13, reset=false.
6. The pane renders "first\\nfirst\\nsecond\\n", although the shell produced each line once.

The audit drives the real polling callback deterministically and uses fake transport replies matching electron/terminal.js toState's delta contract. This models read latency over 250 ms; no response reordering is needed.

### Cause
src/components/TerminalPane.tsx:85 uses setInterval without an in-flight guard. Each request reads cursorRef before the previous reply advances it. applyState always appends state.text for reset=false; it does not reconcile overlapping cursor ranges. Command writes also return deltas and share this consumer, so read/write overlap should be covered by the fix.

### Acceptance
- Each output byte/line appears once when reads overlap or read/write replies overlap.
- Cursor never regresses when an older reply arrives.
- Preserve reset handling and trimmed-buffer recovery.
- Add delayed-reply coverage alongside the existing sequential cursor tests.

Related #147 introduced the terminal; this is a concrete delta-consumption bug.
Sources: [TerminalPane polling](https://github.com/currentbits/solenta/blob/6c7a6fbe/src/components/TerminalPane.tsx#L85), [delta contract](https://github.com/currentbits/solenta/blob/6c7a6fbe/electron/terminal.js#L132).

### Runnable audit evidence
Local artifact: `docs/issue-drafts/2026-09-05-actions-reproduce.mjs`.
```sh
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types docs/issue-drafts/2026-09-05-actions-reproduce.mjs
```
Exited 0 with three CONFIRMED assertions against actual app modules. The assertions demonstrate existing defects, not implemented fixes. Artifact currently exists in the audit checkout; the reproduction above stands alone.

Requested disposition: separate Planboard issue, `plan:todo`.

## 2. Failed thread-notes saves discard the edited text when the editor is reopened

**Priority: P1.** Reproduced at commit `6c7a6fbe` on 2026-09-05.

Closing thread notes discards the user's edit when persistence fails. The app shows an error, but reopening the editor restores only the old saved note.

### Reproduction
1. Open a thread with notes="Original saved note" in the real App.
2. Make api.threads.setNotes reject with "Notes save rejected".
3. Open Thread notes and type "Important unsaved investigation notes".
4. Click the notes button again to save/close.
5. The editor closes and the error appears.
6. Reopen notes: the textarea contains "Original saved note"; the edited text is gone. The host still has only the original.

Confirmed through actual App, ThreadView and useCoder with a rejecting fakeCoder method.

### Cause
ThreadView.closeNotes clears the editing state and calls onSetNotes without awaiting success. App.handleSetNotes drops the returned promise; useCoder.setNotes catches the error without returning failure. toggleNotes always initializes the draft from thread.notes, overwriting the failed edit. The outgoing-thread autosave path also uses fire-and-forget delivery.

### Acceptance
- Preserve failed note edits and provide a retry.
- Close/discard only on confirmed save or explicit cancellation.
- Keep any failed draft associated with its source thread across navigation.
- Test actual App save rejection, reopen and retry; retain the existing successful blur and thread-switch behavior.

Related #194 introduced scratch notes. Separate from #921 composer drafts and #926 queued-prompt edits, which use different state and persistence paths.
Sources: [closeNotes](https://github.com/currentbits/solenta/blob/6c7a6fbe/src/components/ThreadView.tsx#L5688), [App callback](https://github.com/currentbits/solenta/blob/6c7a6fbe/src/App.tsx#L579), [setNotes](https://github.com/currentbits/solenta/blob/6c7a6fbe/src/useCoder.ts#L2047).

### Runnable audit evidence
Local artifact: `docs/issue-drafts/2026-09-05-actions-reproduce.mjs`.
```sh
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types docs/issue-drafts/2026-09-05-actions-reproduce.mjs
```
Exited 0 with three CONFIRMED assertions against actual app modules. The assertions demonstrate existing defects, not implemented fixes. Artifact currently exists in the audit checkout; the reproduction above stands alone.

Requested disposition: separate Planboard issue, `plan:todo`.

## 3. Review acceptance updates never schedule persistence and can remain unsaved indefinitely

**Priority: P2.** Reproduced at commit `6c7a6fbe` on 2026-09-05.

Checking a reviewed hunk reports success and updates memory, but does not mark the Store dirty or schedule a disk write. Review progress can remain absent from disk indefinitely while the app is otherwise idle.

### Reproduction
1. Create a thread in a real temporary Store and saveNow, leaving _dirty=false and no timer.
2. Invoke the real IPC_HANDLERS["git:setReviewAccepted"] with hashes=["reviewed-hunk"].
3. Its returned thread contains reviewAcceptedHunks=["reviewed-hunk"].
4. The Store still has _dirty=false and _timer=null.
5. Read the persisted envelope: the acceptance is absent. Calling the Store's conditional _flushOnExit also does nothing.

The actual desktop shutdown path calls runner.stopAll, which unconditionally saveNow's the store. Therefore orderly desktop quit DOES save this change. The defect is missing normal persistence and an unbounded crash-loss window until another mutation saves or orderly shutdown happens.

### Cause
electron/ipc.js:1251 returns setReviewAccepted directly. electron/reviewItinerary.js:242 calls store.updateThread only. updateThread mutates memory but deliberately does not save. Neither this handler nor its IPC wrapper schedules persistence. The existing review-itinerary test checks only the returned object.

### Acceptance
- Successful review acceptance changes schedule ordinary Store persistence.
- Reloading the Store after the normal flush restores the accepted hunks without requiring an unrelated edit or app quit.
- Cover both checking and unchecking a hunk through the IPC handler and real Store.
- Keep normalization/deduplication and the normal debounced write behavior.

Related #421 introduced the review itinerary; this is a missing durability call in its acceptance write path.
Sources: [IPC handler](https://github.com/currentbits/solenta/blob/6c7a6fbe/electron/ipc.js#L1251), [setter](https://github.com/currentbits/solenta/blob/6c7a6fbe/electron/reviewItinerary.js#L242), [Store mutation](https://github.com/currentbits/solenta/blob/6c7a6fbe/electron/store.js#L3101).

### Runnable audit evidence
Local artifact: `docs/issue-drafts/2026-09-05-actions-reproduce.mjs`.
```sh
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types docs/issue-drafts/2026-09-05-actions-reproduce.mjs
```
Exited 0 with three CONFIRMED assertions against actual app modules. The assertions demonstrate existing defects, not implemented fixes. Artifact currently exists in the audit checkout; the reproduction above stands alone.

Requested disposition: separate Planboard issue, `plan:todo`.

