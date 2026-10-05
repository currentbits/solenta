# ThreadView split: hook map and extraction plan (#1447 round 4, pass J)

`src/components/ThreadView.tsx` is 5,042 lines at `origin/main` 6763da60. The
sibling components already live in `src/components/thread/` (#1449). What is
left is the `ThreadView` component itself: hooks from line 794 to 2566, then the
early returns and roughly 2,400 lines of JSX. This note maps every hook, groups
the hooks into concerns, and sets the order for extracting them.

Line numbers refer to 6763da60.

## Ordering rules this plan relies on

- Effects run in declaration order, and layout effects run in their own
  declaration order, within one commit. A custom hook's effects run where the
  hook is **called**. An extraction therefore moves a **contiguous** run of hooks
  and calls the new hook at the exact spot the run occupied. The component's
  effect sequence stays the same.
- `useState`, `useRef`, `useMemo` and `useCallback` schedule nothing. Moving one
  of them changes only its slot index. That index is stable across renders,
  because every call is unconditional, so the move cannot change behaviour. The
  only hazard is reading a binding in the render body (a dependency array, a
  derived value or render-phase code) before its new declaration, which would
  be a TDZ error. Each extraction below checks for that.
- Plain closures, such as `writeQueuedItems` and `onBodyScroll`, are not hooks.
  They are recreated on every render, and a hook that returns them recreates
  them on every render too, so their identity behaviour is unchanged.

## State map

R = read, W = write. "Switch fx" is the thread-switch reset effect at 2104,
which is keyed on `detail?.thread.id`.

### A. Transcript scroll / stick-to-bottom (#607, #408, #83)
| Hook | Line | R | W |
|---|---|---|---|
| `bodyRef` | 794 | reveal layout fx 1166, pins 2424-2565, JSX `ref` | — |
| `stickToBottom` ref | 797 | pinIfStuck | switch fx 2114, showEarlier, pin layout fx, reveal-msg layout fx 2502, onBodyScroll, `handleJumpPin` 2716 |
| `forceStick` ref | 804 | pinIfStuck, onBodyScroll | pinIfStuck, showEarlier, pin layout fx, reveal-msg layout fx, onBodyScroll, `handleJumpPin` |
| `pinning` ref | 805 | onBodyScroll | pinIfStuck (+ rAF) |
| `prevLayoutThreadId`, `seenThread`, `prevPermReq` refs | 806-808 | pin layout fx | pin layout fx |
| `pendingPrepend` ref | 1066 | prepend layout fx | showEarlier, prepend layout fx |
| `pinIfStuckRef` | 2441 | ResizeObserver fx | render |
| layout fx: restore scroll after prepend | 2452 | `start` | `el.scrollTop` |
| layout fx: pin before paint | 2466 | thread id, permission request | refs, scrollTop |
| layout fx: reveal message (`data-message-id`) | 2502 | `revealTargetId`, `start`, `timeline.length` | refs, scrollTop |
| fx: ResizeObserver | 2527 | `timeline`, `start`, permission, `isWorking` | via pinIfStuckRef |

The JSX consumes `onBodyScroll` (3967) and `showEarlier` (4025/4031).
`handleJumpPin` (after the early returns) writes both refs.

### B. Transcript window and stream-in gating (render-phase state)
`windowThreadId`/`windowStart` (1062), `revealIndex` memo, the render-phase
`setWindowStart`/`setJumpMessageId` block (1085), `seenEntryKeys`/
`seenEntryThread`/`prevTimelineStart` refs (1132) with their render-phase
seeding, the layout fx that marks entries seen (1155), and the layout fx
`scrollIntoView` for `[data-msg]` (1166). These are setState-during-render
blocks, interleaved with the `displayTimeline` and `transcriptView` hooks.

### C. Transcript annotations (pure memos)
`showRunDuration` (`useRunDurationEnabled`), `focusTurns`,
`hiddenFocusActivity`, `focusTurnByFirstId`, `durationByRunId`,
`headerByMessageId`, `provenanceById`, `latestWorkLogRunId`,
`latestRunningToolId`, `latestThinkingId`, `runningToolSummary` and the derived
`thinkingLive`/`streamingMessageId`/`stalledAt`/`workingLabel`: lines
1176-1314, contiguous. These read `detail`, `timeline`, `summaryMode`,
`isWorking`, `expandedFocusTurns` and `runningAgents`, and write nothing.

### D. Failure anchors (pure memos)
`retrySend`, `retryEventId`, `workflowRetryAgentId`, `overflowEventId`,
`upgradeEventId`, `writerLockEventId` and `retryTitle`: lines 1479-1543,
contiguous, reading `detail` only. `handleRetry` and the event-card JSX
consume them.

### E. Queued follow-ups (#364, #780, #926, #1144)
State and refs 819-827 plus the reset fx 831 (deps: thread id,
`queuedPrompt == null`). `queuedItems` (1318) is derived from props.
`writeQueuedItems`, `closeQueuedEdit`, `persistQueuedEdit` and `saveQueuedEdit`
(1320-1406) are plain closures. The switch fx does not touch this state. Only
the queued strip JSX consumes it (4428-4682).

### F. Notes (#935) and message pins
Notes state and refs (841-855), pin state and refs (856-872, with
`currentThreadIdRef`), `persistNotes`/`persistPins` and their helpers
(1969-2102), and the pin closures after the early returns (2691-2724). **The
switch fx flushes the outgoing notes draft and rehydrates pins**, so both
concerns are welded to that effect.

### G. Thread-switch reset fx (2104)
This one effect resets state from A, E's neighbours, F, H, I, J and K. Splitting
it would turn one effect into several, which changes effect structure and is
not a pure move.

### H. Header: menu, details card, git attention
`menuRef`/`menuOpen`/`detailsRef`/`detailsOpen`/`deleteConfirm`/`renaming`/
`renameDraft`/`renamingRef` (810-817). The outside-click fx for the menu
(2328), `closeMenu` + Escape, the outside-click fx for details (2348),
`closeDetails`, and `prRequest` (2357, bumped by the header split button and
fed to `NextGitActionButton`, which runs the #1419 PR status lookup itself via
`onPrStatus`). `headerBehind` state + fx (2360-2380, #1411), `detailsGit`
state + fx (2381-2410), the ring-warn fx that opens details (2412), and Escape
for details/restore plus modal focus (2415-2422). `syncRefreshNonce` (913) is
bumped by `onPushed`.

### I. Pane layout
`layoutThreadId`/`layout`/`focusedId` (992-1004, render-phase rehydrate),
`browserPaneOpen` and the `wasBrowserPaneOpen` bump of the screenshot
generation (1005-1010), the save fx (2176), the `changesOpen` fx (2182), and
`applyLayout`, `handlePaneChange`, `handleOpenPane`, `terminalLeaf`,
`handleToggleTerminal` and `handleResetLayout` (2194-2235).

### J. Screenshots: AppSnap and browser hand-off (#1206)
`incomingHandoff` (963), the `screenshotHandoffGen`/`ThreadId` refs and their
render-phase bump (969-974), snap state (985-991), and `openAppSnap`, the
live-handoff closures, `attachBrowserScreenshot`, `captureAppSnap`, the
double-Option hotkey fx, and Escape plus modal focus (1792-1896).

### K. Rewind / restore and run stats
`restore*`, `rewind*` and `runStatList` state (878-895).
`handleRequestResubmit`/`handleRewindConfirm`/`handleRewindCancel` + Escape
and focus (1572-1619), `handleSlashRewind` (1621), `refreshRunStats` + the run
stats fx (2237-2276), `barByMessageId`, `handleRestoreConfirm`.
`handleSlashRewind`'s dependency array reads `runStatList` during render at
1646.

### L. Misc
The command/expanded-groups/quota/context reset fx (931). The CLI slash
commands state (923) + fetch fx (939-962). `replyByThread` + `storeReply`/
`handleReply`/`handleCiteSelection`. The ⌘⇧C cite fx (1744-1783). The
copy-flash cleanup fx (2320). The turn-diff reset fx (882).

## Candidate hooks

| Hook | Moves | Inputs | Outputs → consumers |
|---|---|---|---|
| `useRetryAnchors` | D, 1479-1543 | `detail` | 7 values → `handleRetry`, event-card JSX, retry button title |
| `useTranscriptAnnotations` | C, 1176-1314 | `detail`, `timeline`, `summaryMode`, `isWorking`, `expandedFocusTurns`, `runningAgents` | focus/duration/header/provenance maps, latest ids, `streamingMessageId`, `stalledAt`, `workingLabel` → message list JSX, composer status |
| `useCliCommands` | 923 + fx 939-962 | `onListCliCommands`, project path, `threadId`, provider | `cliCommands` → Composer |
| `useCiteShortcut` | fx 1744-1783 | `detail?.messages` (as `messages`), `storeReply` | none |
| `useHeaderGitStatus` | 2358-2410 | thread id/status, `detailsOpen`, `gitSyncInfo`, `onFetchDiff`, `syncRefreshNonce` | `headerBehind`, `detailsGit` → header attention dot, details card |
| `useQueuedEdit` | E: 819-840 + 1318-1406 | thread id, `queuedPrompt`, `queuedItemsProp`, `onEditQueued`, `onCancelQueued` | state, setters and closures → queued strip JSX |
| `usePaneLayoutActions` | I: 2176-2235 | layout state + setters, `changesOpen`, `changesNonce`, `onPanesNeedRoom`, `onCloseChanges`, `onViewChanges` | `handlePaneChange`, `handleOpenPane`, `terminalLeaf`, `handleToggleTerminal`, `handleResetLayout` → workspace/header JSX |
| `useAppSnap` | J: 1792-1896 | snap state + setters, hand-off refs, `setIncomingHandoff`, the three IPC callbacks, `isArchived` | `attachBrowserScreenshot`, `captureAppSnap` → BrowserPane, snap dialog |
| `useStickToBottom` | A: refs 797-808 and 1066, block 2424-2565 (minus `openClickedImage`) | `bodyRef`, `detail`, `timeline`, `isWorking`, `start`, `revealTargetId`, `setWindowStart` | `stickToBottom`, `forceStick`, `showEarlier`, `onBodyScroll` |

## Extraction order (low risk first)

1. **`useRetryAnchors`**: pure memos, one input. Risk: none beyond typing.
2. **`useTranscriptAnnotations`**: pure memos plus one store hook
   (`useRunDurationEnabled`), contiguous. Risk: a missed output. Typecheck
   catches it.
3. **`useCliCommands`**: moves the `useState` from 923 down to 939. The fx at
   931 between them does not touch `cliCommands`, and the only render-time
   read is in the JSX, so there is no TDZ. Risk: low.
4. **`useCiteShortcut`**: one effect, called at its slot. Risk: low.
5. **`useHeaderGitStatus`**: owns both states, and nothing outside writes
   them. The two effects stay between the details outside-click fx and the
   ring-warn fx. Risk: low.
6. **`useQueuedEdit`**: called at 819. Its reset fx stays the first effect in
   the component. The closures move up from 1320 and `queuedItems` moves up
   from 1318. The closures run only from event handlers, and `queuedItems` is
   a pure function of props. Risk: low to medium, because it has the most
   outputs.
7. **`usePaneLayoutActions`**: the state stays in the component (the
   render-phase rehydrate and `browserPaneOpen` need it early). The block is
   contiguous, and both effects keep their slot between the switch fx and the
   run-stats fx. The `changesOpen` fx's deliberately partial dependency list
   is kept as is. Risk: low to medium.
8. **`useAppSnap`**: contiguous; the hotkey fx, `useEscapeClose` and
   `useModalFocus` keep their slots. The state and refs stay in the component,
   because the render-phase generation bumps (971, 1007) and the switch fx
   need them. Risk: medium, because it has many inputs.
9. **`useStickToBottom`**: the block 2424-2565 is contiguous apart from
   `openClickedImage`, which is not a hook and stays in the component. The
   hook is called where `pinIfStuck` was, so the three layout effects and the
   ResizeObserver fx keep their order. They are still the last effects in the
   component, after `useModalFocus` (2419). The hook owns the six scroll refs
   plus `pendingPrepend`. `useRef` has no timing, and the only outside readers
   are the switch fx closure (which runs after render, so no TDZ) and
   `handleJumpPin` (after the call site). Risk: medium, and the order is the
   most delicate. Verified by the #607 thread-switch screenshot and the
   threadView suite.

## Left in place, and why

- **B (window/seen keys)**: the render-phase `setState` calls are interleaved
  with `displayTimeline`, `useTranscriptViewMode` and the two layout effects.
  Moving them changes which values exist at each render-phase step.
- **F (notes, pins)** and **G (switch fx)**: the switch fx writes into every
  concern and calls `persistNotes`. Extracting notes or pins needs that effect
  split, which is a behaviour-level change and outside this pass.
- **H menu/details popovers**: the state is reset by the switch fx and
  consumed throughout the header JSX, so a hook would only take state in and
  hand two callbacks back. Their git half is extracted (step 5).
- **K (rewind, restore, run stats)**: `handleSlashRewind`'s dependency array
  reads `runStatList` during render at 1646, before the run-stats block. The
  rewind callbacks feed `handleSlashRewind` and the switch fx. Moving either
  block means reordering declarations across other concerns.
- **L reset fx 931, copy-flash cleanup**: these are one-liners tied to state
  that is used everywhere. Extracting them gains nothing.
