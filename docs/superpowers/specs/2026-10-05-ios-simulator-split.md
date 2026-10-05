# Splitting `createIOSSimulatorService` (electron/ios-simulator.js)

Issue #1447, pass V. Line numbers are for `electron/ios-simulator.js` on main `39fe3fac` (3,244 lines;
`createIOSSimulatorService` runs from 559 to 3235, about 2,680 lines, 112 inner functions). The data
comes from a babel scope analysis (`@babel/traverse`): each reference to and assignment of a factory
binding is attributed to the inner function that contains it. Rerun it before you trust a line number.

The seam convention is the one in the header of `electron/runner-watchdogs.js`: flat
`electron/ios-simulator-<seam>.js` files, each exporting `create<Seam>(ctx)`, one `ctx` built in the
factory, eager destructuring only of what exists at factory time, no `require("./ios-simulator.js")`.

## 1. Closure state map

### Injected through the options object (559–587)

All are written once and never reassigned.

| Binding | Read by |
|---|---|
| `store` | resolveThread, resolveExecutionRoot |
| `platform` | resolveThread |
| `processAdapter` | selectedDeveloperDirectory, discoverRaw, prepareAppBundle, boot, detach, finishRelease, install, launch, openUrl, captureScreenshot, runRecordingFinalization, startRecording, recoveredProcessMatches, recoveredHelperProcessMatches, shutdownRecoveredDevice |
| `artifactStore` | discardStagedArtifactBestEffort, captureScreenshot, runRecordingFinalization, startRecording |
| `prepareThreadWorktree`, `broadcast` | resolveExecutionRoot; `broadcast` also publishSimulatorChanged |
| `fsApi` | readPreferences, syncParentDirectory, atomicWriteJson, removeJournal, resolveExecutionRoot, validateBundleWithinRoot, prepareAppBundle, recordedVideoSize, pollRecordingSize, readLeaseJournalRecord, quarantineJournalLocked, removeJournalStrict, resolveRecoveryTempPath, removeRecoveredTempFile |
| `randomUUID` | atomicWriteJson, startRecording, quarantineJournalLocked |
| `now` | touchLeaseActivityBestEffort, attach, takeover, boot, clearRecordingJournalBestEffort, startRecording, quarantineJournalLocked |
| `logger` | logJournalWarning |
| `setTimer`, `clearTimer` | waitForHelperReady, helperRpcWithSession, clearRecordingTimers, scheduleRecordingPoll, waitForRecordingClose, startRecording, delay |
| `signalPid` | killRecording, signalRecoveredPid |
| `streamBroker`, `getStreamBroker` | currentStreamBroker |
| `spawnHelper`, `sandboxProfilePath` | startHelper; `sandboxProfilePath` also recoveredHelperProcessMatches |
| `recordingStagingRoot`, `toolchain`, `userDataPath`, `worktreeBase` | construction only (below) |

### Derived consts (588–612), computed once at construction

| Binding | Read by |
|---|---|
| `resolvedUserDataPath` | the consts below |
| `resolvedWorktreeBase` | resolveExecutionRoot |
| `preferencesFile` | selectedDeveloperDirectory, validateAndPersistDeveloperDirectory |
| `leaseJournalFile` | writeJournal, removeJournal, readLeaseJournalRecord, quarantineJournalLocked, removeJournalStrict |
| `stagingRoot` | resolveRecoveryTempPath |
| `resolvedToolchain` | discoverToolchains, fingerprintToolchain, ensureHelper, startHelper |

### Mutable state (`let`, reassigned)

This is the part that decides where the split has to stop. None of these are Maps mutated in place; each
is a scalar `let` that functions reassign. A function that reads or writes one cannot move to another
module without rewriting every reference into `state.x` or `ctx.x`, so it does not move verbatim.

| Line | Binding | Read | Written |
|---|---|---|---|
| 613 | `lease` | leasePresent, isActiveLease, currentLeaseSnapshot, assertOwnedLease, helperSessionWritable, publishSimulatorChanged, getStatus, install, launch, openUrl, captureScreenshot, finishRelease, recover | touchLeaseActivityBestEffort, persistHelperIdentity, clearHelperIdentityBestEffort, startHelper (reads), attach, takeover, restoreBootIntentIfCurrent, boot, detach, revokeAndRelease, clearRecordingJournalBestEffort, startRecording |
| 614 | `lastGeneration` | | nextGeneration, recover |
| 615 | `mutationTail` | | mutate (only) |
| 617 | `recording` | revokeAndRelease, onRunTerminal, finalizeIfRecorderClosed, finalizeRecordingForOwnershipChange, stopRecording, recover | finalizeRecording, startRecording |
| 619 | `finishedRecording` | stopRecording | releaseFinishedRecording, finalizeRecording, startRecording |
| 624 | `shutdownPromise` | | shutdown (only) |
| 626 | `helper` | helperConnectionState, helperCapsForSnapshot, helperSessionWritable, assertHelperSession, persistHelperIdentity, onHelperExit, withHelper, startHelperBestEffort, streamInfo, retryStream | stopHelper, startHelper |
| 783 | `journalTail` | | enqueueJournalOp (only) |

`journalTail` and `mutationTail` each have exactly one owner, so they can move with it.

### Timers

The factory owns no long-lived timer. Every timer is per call and is cleared by the code that set it:
the helper ready and RPC timeouts (waitForHelperReady, helperRpcWithSession), the recording poll and
auto-stop (stored on the recording context, cleared by clearRecordingTimers), the finalize wait
(waitForRecordingClose) and `delay`. So no seam needs a `dispose()`. App teardown is `shutdown()`,
which stays in ios-simulator.js.

### Construction order

At creation the factory only validates `userDataPath`, computes the derived consts, builds the
toolchain when none is injected, and initializes the `let`s (`journalTail` last, at 783). It starts
no timer and replays no journal: `recover()` is called by main.js after construction. The split keeps
that sequence. Seam factories run after the derived consts and the `let`s, and the only thing a seam
factory initializes is `journalTail = Promise.resolve()`.

## 2. Closure-free inner functions (lift first)

These reference no factory binding: `cloneLease`, `leaseSnapshot`, `callProcess`,
`disconnectedHelperState`, `mapHelperError`, `onHelperControl`, `helperDisconnected`,
`failHelperWaiters`, `requireCoord`, `viewerStreamInfoFromSession`, `releaseSummary`,
`normalizeRunId`, `recordingFailed`, `recordingFinalizeFailed`, `noActiveRecording`,
`createRecordingContext`, `interruptRecording`, `isTrustedSimctlPath`, `isTrustedRecorderPrefix`,
`recoverySummary` (20). They move to module scope with only their indentation changed.

## 3. Seams and extraction order, low risk first

| # | Module | Moves | Owns | Takes from ctx |
|---|---|---|---|---|
| 0 | `ios-simulator-parse.js` | the module-level parsers, validators, error type and their constants (15–557) | — | (plain module) |
| 1 | `ios-simulator-journal.js` | readPreferences, syncParentDirectory, atomicWriteJson, writePreferences, enqueueJournalOp, writeJournal, removeJournal, readLeaseJournalRecord, quarantineJournalLocked, quarantineJournal, removeJournalStrict | `journalTail` | fsApi, randomUUID, now, leaseJournalFile |
| 2 | `ios-simulator-devices.js` | selectedDeveloperDirectory, discoverRaw, discoverDevices, discoverCapabilities, validate(AndPersist)DeveloperDirectory, getCapabilities, selectDeveloperDirectory, listDevices, discoverToolchains, fingerprintToolchain, ensureHelper | — | processAdapter, preferencesFile, resolvedToolchain, resolveThread, helperCapsForSnapshot, readPreferences, writePreferences |
| 3 | `ios-simulator-app-bundle.js` | resolveExecutionRoot, validateBundleWithinRoot, prepareAppBundle | — | store, prepareThreadWorktree, resolvedWorktreeBase, broadcast, fsApi, processAdapter, resolveThread, selectedDeveloperDirectory |
| 4 | `ios-simulator-recovery.js` | the recovery helpers 2669–2881 (temp path, process matching, signalling, device shutdown, summaries) | — | fsApi, stagingRoot, processAdapter, sandboxProfilePath, signalPid, delay, selectedDeveloperDirectory, quarantineJournal, writeJournal |
| 5 | `ios-simulator-recording.js` | the recorder I/O: timers, size poll, kill, close wait, runRecordingFinalization, beginFinalization, observeRecordingClose | — | setTimer, clearTimer, fsApi, signalPid, artifactStore, processAdapter, callProcess, discardStagedArtifactBestEffort, clearRecordingJournalBestEffort, finalizeRecording, finalizeIfRecorderClosed |
| 6 | `ios-simulator-helper.js` | helper session I/O: currentStreamBroker, disconnectHelperSession, waitForHelperReady, helperRpcWithSession | — | streamBroker, getStreamBroker, setTimer, clearTimer, helperSessionWritable |
| 7 | `ios-simulator-input.js` | tap, swipe, typeText, pressButton, sendInput, accessibility, scrollTo | — | mutate, withHelper, assertHelperSession, touchLeaseActivityBestEffort, delay, helperRpcWithSession |

Each row is one commit. A seam's cross-seam inputs come only from rows above it, so every eager
destructure is satisfied when the factory runs. Where a seam calls back into ios-simulator.js
(`finalizeRecording`, `helperSessionWritable`, `resolveThread`, …), the target is a hoisted function
declaration of the factory, which exists before `ctx` is built.

Module-level helpers and constants used by one seam only move into that seam's file. Helpers shared
with ios-simulator.js (`callProcess`, `delay`, …) go through `ctx`.

## 4. Where it stops

What remains in ios-simulator.js is the lease state machine: every function that reads or writes
`lease`, `helper`, `recording`, `finishedRecording` or `lastGeneration` (attach, takeover, boot,
detach, revokeAndRelease/finishRelease, install/launch/openUrl/captureScreenshot, start/stopRecording,
finalizeRecording, the helper lifecycle, recover, streamInfo/retryStream, getStatus). Splitting that
needs the `let`s turned into a shared state object, which rewrites roughly 150 references. That is a
behaviour-sensitive rewrite (takeover relies on reassigning `lease` synchronously before its first
await), not a verbatim move, so it is out of scope for this pass.

## 5. Checks per commit

- `module.exports` keys of ios-simulator.js and the keys of the object `createIOSSimulatorService`
  returns, compared against main by script.
- Pure-move check: trimmed removed lines against trimmed added lines; only the unmatched lines
  (requires, the factory header, ctx, destructures, exports) are listed.
- Eager-destructure check: every key a seam destructures from `ctx` is on `ctx` at that seam's call.
- `ios-simulator*` tests and the other simulator tests alone, then the full electron suite and
  typecheck.

## 6. Pass V2 result

All seven rows of section 3 landed, one commit each, in table order. `ios-simulator.js` went from
2,781 to 1,697 lines. What is left is exactly the section 4 lease state machine plus the small
helpers it shares with the seams (`resolveThread`, `mutate`, `delay`, `logJournalWarning`, the
`helper*`/`lease*` predicates, `discardStagedArtifactBestEffort`, `clearRecordingJournalBestEffort`,
`finalizeRecording`, `finalizeIfRecorderClosed`). The pass stops there, as section 4 says.

| # | Module | Lines |
|---|---|---|
| 1 | `ios-simulator-journal.js` | 209 |
| 2 | `ios-simulator-devices.js` | 153 |
| 3 | `ios-simulator-app-bundle.js` | 165 |
| 4 | `ios-simulator-recovery.js` | 257 |
| 5 | `ios-simulator-recording.js` | 269 |
| 6 | `ios-simulator-helper.js` | 135 |
| 7 | `ios-simulator-input.js` | 278 |

Where the result differs from the table above:

- No seam reads or writes a factory `let`, so no ctx getter/setter was needed. `journalTail` moved
  into `createJournal` with its only owner and is still initialized right after the other `let`s.
- `runRecordingFinalization` is also returned by `createRecording`: `finalizeRecording` stays (it
  retires `recording`/`finishedRecording`) and calls it.
- `callProcess`, `recordingFailed`, `helperDisconnected` and `recoverySummary` are module-level
  helpers shared with ios-simulator.js, so they go through ctx. Helpers used by one seam only
  (`requireCoord`, `interruptRecording`, `recordingFinalizeFailed`, `isTrustedRecorderPrefix`,
  `isTrustedSimctlPath`) and their constants moved into that seam.
- Pure parse.js imports and `ios-simulator-protocol.js` are required directly by the seams.

The checks for each commit were the ones in section 5, plus a free-identifier and unused-binding scan
of every file. The scan caught the `runRecordingFinalization` back-reference before the tests did.
