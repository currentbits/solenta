# Splitting `createRunner` (electron/runner.js), design note

Issue #1447, round 2, pass G. This note is input for the next refactor round. It contains no code.

Line numbers are for `electron/runner.js` on branch `coder/refactor-g-lift-createrunner-helpers-spl-ad7272`
(main `6763da60` plus the helpers lift in this pass). With that lift, the file is 9,162 lines and
`createRunner` runs from 752 to 9144 (about 8,390 lines, 112 inner functions). The data comes from
a babel scope analysis (`@babel/traverse` bindings: each reference and assignment is attributed to
the top-level inner function that contains it). Rerun the analysis before you trust a line number.

## 0. What round 2 already did

A function was "closure-free" if it references no binding in createRunner's scope. Of the 123 inner
functions, 11 qualified. They moved verbatim to `electron/runnerHelpers.js`, together with
`PLAN_TRUNCATE`: `shouldRecordSession`, `noticePrompt`, `formatQueuedPrompt`, `firstChanged`,
`planText`, `questionInfo`, `replyCodexJsonRpc`, `replyCodexJsonRpcError`,
`cancelCodexServerRequests`, `sanitizeAttachments` and `attachmentPromptSection`. The other 112 all
touch `store`, `active`, or another stateful function. That makes it a closure problem, not a
helper problem.

## 1. Closure state map

### Injected through `opts` (752–776)

| Binding | Holds | Read by |
|---|---|---|
| `store` | the Store (threads, messages, settings) | 83 of 112 functions; effectively everything |
| `core` | the workflow engine API | pushDetail, finishSuccessSim, startSimulatedRun, startWorkflowRun, retryWorkflowAgent, toWorkflowView |
| `pushFn` | renderer push channel | pushDetail, pushThreadsChanged, materializePendingWorktree, startWorkflowRun, retryWorkflowAgent |
| `tickMs`, `setIntervalFn`, `clearIntervalFn` | simulate-provider clock seams | startSimulatedRun, clearRun |
| `userDataPath` | app data dir | 16 functions (session recorder, every start*Run, notifyRunTerminal, markRunFailed, worktree, ask/btw) |
| `getMemStatus` | memory server status | sessionRecorder, notifyRunTerminal |
| `askComplete`, `searchMemory`, `bootstrapMemory` | Ask-mode seams (#392, #710) | startAskRun, startBtw, startRun (bootstrap) |
| `runAgentFn` / `runCodexFn` | spawn seams | startGenericRun / startCodexRun |
| `inspectCodexWriterLockFn`, `killWriterLockPidFn` | writer-lock seams | markRunFailed |
| `getIosSimulator` | late-resolved simulator | sweepCrew, notifySimulatorRunTerminal |
| `nowFn` (776) | injectable clock (#346) | startRun, heartbeatActiveLanes |

All of these are written once and never reassigned (the analysis found no `constantViolations` on any
createRunner binding). Every piece of mutable state is a Map or Set, mutated in place.

### Owned state (Maps, Sets, timers)

| Line | Binding | Holds | Read/written by |
|---|---|---|---|
| 781 | `active` | `threadId → run entry` (`{kind, runId, handle, stopping, pendingPermissions, ackTimer, flushStream, sessionId, …}`); a `kind:"preparing"` placeholder is set at 8490 and upgraded in place by `claimPreparingRun` (3418) | 38 functions: every start*Run, stop*/clearRun, permissions, verify, notices, watchdogs, the public queries |
| 784 | `ciWorkflowSignOffs` | host-only CI sign-off per thread | getPendingPermission, respondPermission, requestCiWorkflowSignOff, startRun |
| 791 | `planPromptHandled` | threads whose live ExitPlanMode was answered (#707) | respondPermission, maybePersistPlanApproval |
| 797 | `btwActive` | in-flight `/btw` cards (#471) | startBtw, cancelBtw, promoteBtw, listActiveBtwCount, stopAll |
| 801 | `otel` | OTel span emitter (#280) | noteToolSpan, notifyRunTerminal, startClaudeRun, failWorktreeSetup, dispatchOrchCommand, startAskRun, startRun, flushTranscripts |
| 812 | `toolStartedAt` | `runId:toolId → start ms` | noteToolSpan, appendMessage, clearRun |
| 843 | `claudeSessions` | kept-alive interactive Claude CLIs (#8) | disposeClaudeSession, retireClaudeSession, scheduleClaudeIdleReap, startClaudeRun, stopAll |
| 847/851/855 | `CLAUDE_IDLE_REAP_MS`, `CLAUDE_ACK_MS`, `CLAUDE_IDLE_MAX` | keep-alive tuning | scheduleClaudeIdleReap / startClaudeRun |
| 897 | `SUBAGENT_ROWS_MAX` | cap | addSubagentRow |
| 1065 | `lastWorkflowByThread` | last workflow view per thread | flushOrchNotices, runVerifyGate, pushDetail, refreshDetail, settleCancelledLaunch, retryWorkflowAgent, stopRun, getActiveWorkflow |
| 1073 | `lastPushByThread` | push throttle timestamps | pushDetail |
| 1076 | `sessionRecorder` | shared session history writer | recordSessionOnAppend, recordSessionAtTerminal, stopAll, flushTranscripts |
| 1167 | `orchNotices` | queued orchestration notices per orchestrator | enqueueNotice, flushOrchNotices, stopCrew |
| 1176 | `autoTurns` | threads whose current turn was started by a notice | flushOrchNotices, startRun, isAutoTurn |
| 1179 | `recentlyReleasedCodex` | Codex writer release times | noteCodexRelease, parkCodexFromNotice, stopAll |
| 1181 | `codexReleaseFlush` | pending flush timers after a Codex release | cancelCodexReleaseFlush, scheduleCodexReleaseFlush, stopAll |
| 1183 | `codexParkNotified` | orchestrators already told a Codex run is parked | flushOrchNotices, stopAll |
| 2930 | `quotaTimers` | quota-wake / failover-resume timers | cancelQuotaWake, scheduleFailoverResume, scheduleQuotaWake, stopAll |
| 9089 | `stallTimer` | native setInterval (15 s) running checkStalls + heartbeatActiveLanes | stopAll, the unref at 9101 |

Boot side effects: the loop at 9038 calls `sweepCrew` for every orchestrator worker, and line 9103 calls `refreshAllQuotaWaits()` to re-arm persisted quota waits.

### The hub functions

Almost every seam calls these. Whatever gets extracted receives them; they stay put until the end:

- `pushDetail` (2187, 36 callers), `pushThreadsChanged` (2779, 39 callers), `refreshDetail` (2790), `stampLastEvent` (2172)
- `appendMessage` (2866, 33 callers), `noteToolSpan` (818)
- work-log steps: `beginWorkLogStep` (2819), `completeWorkLogStep` (2836), `appendDoneWorkLog` (2847), `savePlanSteps` (2801), `persistToolImages` (2919)
- run lifecycle: `clearRun` (3309), `launchWasCancelled` (3352), `settleCancelledLaunch` (3365), `abortIfCancelled` (3407), `claimPreparingRun` (3418), `stampPreparingSteps` (3426), `lastAssistantText` (2155), `markRunFailed` (2960), `notifyRunTerminal` (1921)

## 2. Extraction mechanism

There is already a precedent: `startWorkflowRun` (8558) and `retryWorkflowAgent` (8589) pass a deps
object (`store, core, pushFn, active, clearRun, pushDetail, …`) into `workflow.js`. Generalise it as
follows.

- Each seam becomes a flat `electron/runner-<seam>.js`, exporting `create<Seam>(ctx)`. Not a
  `electron/runner/` folder: package-app.sh and package-cross.sh copy only `electron/*.js`, so files
  in a subdirectory would be missing from the packaged app (step 1 found this). The factory returns
  the seam's functions and owns the seam's Maps.
- createRunner builds one `ctx` object (the opts bindings, `active`, and the hub functions) and adds
  each seam's returned functions to it.
- Inside a factory, destructure eager deps at the top (`const { store, pushDetail } = ctx`) so that
  function bodies move verbatim. Cycles (`startRun` is called by flushOrchNotices, runVerifyGate,
  drainQueued, fireFailoverResume, fireQuotaWake, resumeQuotaWait and dispatchOrchCommand) must use
  late lookup (`ctx.startRun(...)`) because `startRun` is defined after them. That is the only body
  edit allowed in a move PR.
- The public return object (9106) and `module.exports` stay identical, so `ipc.js`, `main.js`,
  `scripts/acceptance.js` and the roughly 87 electron test files that call `createRunner` do not change.
- One seam per PR. Each PR must pass the full electron suite plus `npm run typecheck`.

## 3. Seams, boundaries, order

The order runs from leaves to the hub. "Owns" means the seam's Maps move into its module. "Receives"
means it gets them from ctx.

| # | Seam → module | Functions (lines) | Owns | Receives | Risk |
|---|---|---|---|---|---|
| 1 | Watchdogs → `runner-watchdogs.js` | checkStalls 9048, heartbeatActiveLanes 9076, the `stallTimer` setup 9088–9101 | `stallTimer` (hand stopAll a `dispose()`) | active, store, nowFn, pushDetail, pushThreadsChanged, appendMessage | Low. Pure readers of `active`. Keep the unref and the "never break the runner" try/catch exactly as they are. |
| 2 | Ask / btw → `runner-ask-runs.js` | startAskRun 7690, startBtw 7877, cancelBtw 8012, promoteBtw 8036, listActiveBtwCount 8863 | `btwActive` | askComplete, searchMemory, bootstrapMemory, active, otel, hub | Low. Already isolated from `active` by design (#471). |
| 3 | Worktree setup + orch commands → `runner-turn-setup.js` | materializePendingWorktree 7496, failWorktreeSetup 7524, dispatchOrchCommand 7576 | none | pushFn, userDataPath, otel, hub, `ctx.startRun` (late) | Low. 160 lines. |
| 4 | Subagent rows → `runner-subagents.js` | subagentRows 899 … finishRunningSubagents 1023 (7 functions) | `SUBAGENT_ROWS_MAX` | store, pushDetail, pushThreadsChanged | Low. |
| 5 | Session recording → `runner-session-recording.js` | sessionBaseFields 1085, recordSessionOnAppend 1103, recordSessionAtTerminal 1130 | `sessionRecorder` (expose it for stopAll/flushTranscripts) | store, userDataPath, getMemStatus | Low. Call order inside appendMessage must not change. |
| 6 | Claude keep-alive → `runner-claude-sessions.js` | disposeClaudeSession 858, retireClaudeSession 879, scheduleClaudeIdleReap 1037 | `claudeSessions`, the `CLAUDE_*` constants | store, finishRunningSubagents | Low–medium. `CLAUDE_ACK_MS` is read by startClaudeRun, so export it. Needs a test first (see §4). |
| 7 | Verify gate → `runner-verify-gate.js` | shouldVerify 1524, worktreeHeadSha 1540, lastRunIdFor 1553, nextVerifyAttempt 1568, settleVerifyCrash 1593, runVerifyGate 1616, plus the turn-end trio afterFailedTurn 1425, afterSuccessfulTurn 1454, finishSuccessfulTurn 1582 | none | active, lastWorkflowByThread, hub, `ctx.startRun`, queueOrchNotice/flushOrchNotices, sweepDoneWorkers, maybeDrainQueued | Medium. The turn-end trio interleaves with notices (8) and queue drain, so move it together with the gate. |
| 8 | Quota / failover → `runner-quota-wait.js` | cancelQuotaWake 2932, lastUserOnThread 2939, tryQuotaFailover 3042 … resumeQuotaWait 3227, refreshQuotaWait 8883, refreshAllQuotaWaits 8901 | `quotaTimers` | store, active, appendMessage, pushDetail, `ctx.startRun` | Medium. Timers fire later, so stopAll must still cancel them through the module's `cancelAll`, and the boot `refreshAllQuotaWaits()` (9103) must still run after the module is built. markRunFailed (2960) stays in the hub and calls into this module. |
| 9 | Orchestration notices + crew → `runner-orch-notices.js` | 1185–1418 (cancelCodexReleaseFlush … flushOrchNotices), sweepCrew 1768, sweepDoneWorkers 1843, stopCrew 8626, isAutoTurn 8879 | `orchNotices`, `autoTurns`, `recentlyReleasedCodex`, `codexReleaseFlush`, `codexParkNotified` | active, lastWorkflowByThread, getIosSimulator, hub, `ctx.startRun` | Medium–high. Five Maps, timer-driven Codex park/release timing, and startRun re-entry. noteCodexRelease is called from clearRun (hub). The boot sweep loop (9038) must still run after the module is built. |
| 10 | Permissions / questions → `runner-permissions.js` | getPendingPermission 2270, pendingPlanAsPermission 2313, handleCodexServerRequest 2341, respondCodexPermission 2432, respondPermission 2474, askUser 2614, requestCiWorkflowSignOff 2647, clearQuestion 2670, maybePersistPlanApproval 2689, respondPersistedPlan 2739 | `ciWorkflowSignOffs`, `planPromptHandled` | active (reads/writes `entry.pendingPermissions`, `entry.handle`), hub, maybeDrainQueued | High. The `active` entry shape is an implicit contract with every provider run. `ciWorkflowSignOffs` is security-relevant (it must fail closed). pushDetail calls getPendingPermission, which creates a cycle back into the hub, so pass it through ctx late. |
| 11 | Provider runs → `runner-provider-<id>.js`, one PR each | startMuseRun 7045 (444 lines), startOpencodeRun 6033 (471), startKimiRun 5497 (527), startCursorRun 6513 (524), startCodexRun 4905 (580), startGenericRun 3531 + startSimulatedRun 3434 + notePhaseEvents 3258 + finishSuccessSim 3285, then startClaudeRun 3741 (1,154) last | none (Claude uses the claudeSessions module) | the same ~18 hub functions for every provider, plus provider-specific pieces (handleCodexServerRequest, askUser, subagents, claudeSessions) | Medium per provider. This is the biggest payoff: about 4,200 lines. Each body moves verbatim behind `const {…} = ctx`. Claude goes last because it has the most dependencies (askUser, subagents, keep-alive, ACK timer). |
| — | What stays in runner.js | opts, `active`, `lastWorkflowByThread`, `lastPushByThread`, `toolStartedAt`, `otel`, the hub functions, notifyRunTerminal, drainQueued/maybeDrainQueued/appendInbound, startRun (dispatcher, 8055), startWorkflowRun/retryWorkflowAgent, steerRun, stopRun, stopAll, the public queries, and the return object | | | Target size about 1,800 lines. |

Why this order: steps 1–6 never call `startRun` and own disjoint state, so each is a mechanical move
with no cycles and lets the `ctx` mechanism prove itself cheaply. Steps 7–9 introduce late-bound
`ctx.startRun`. Step 10 touches the `active` entry contract. Step 11 is long but repetitive once the
ctx is stable, and steps 1–10 shrink the dependency list each provider body needs. Steps 1–6 can run
as parallel workers if each commits the shared `ctx` construction first (workers start from
committed HEAD). Steps 7–11 should land one after another, because they all edit the ctx wiring.

## 4. Test coverage per seam

Everything runs through `createRunner` with a real Store and fake provider binaries
(`electron/test/support/fakeBin.js`). No inner function has a unit test today, so the suite is
behavioural and slow (about 3 min). That is fine for verbatim moves.

| Seam | Covering tests (electron/test) | Thin spots |
|---|---|---|
| Watchdogs | stall-watchdog, merge-queue-heartbeat, merge-queue-watchdog | `CODER_STALL_MS` only in stall-watchdog |
| Ask / btw | ask-runner, btw-runner, web-integration | promoteBtw has only a single test path |
| Worktree setup / orch commands | worktree-setup-fail, worktree-cleanup, orch-commands, cli-commands-runner, fork-handoff | none obvious |
| Subagents | claude.test (task notifications), cursor.test (noteCursorSubagent), 12 files mention subagents | `SUBAGENT_ROWS_MAX` cap is untested |
| Session recording | session-record, memory-record, remove-project-sessions | |
| Claude keep-alive | claude-eject-keepalive (#979), claude.test, claude-self-archive | **No test of the 30-min idle reap or the `CLAUDE_IDLE_MAX = 3` LRU eviction.** Add one (inject a shorter window the way `CLAUDE_ACK_MS` is read at arm time) before step 6. |
| Verify gate | verify-gate | Single file. The verify-then-retry `startRun` re-entry path is covered only there. |
| Quota / failover | quota-wait-runner, plus failover cases across 6 files | |
| Notices / crew | crew-notices, crew-seam, orchestrator-threads, orch-merge, codex-eject, codex-eject-stop, codex-writer-lock | `sweepCrew` boot sweep and `isAutoTurn` each appear in one file. Codex park/release timing relies on real timers. |
| Permissions | codex-approvals-runner, codex-appserver-approvals, workflow-permission, guardrails-runner, teach-runner | **Plan persistence (#707) and `ciWorkflowSignOffs` are covered by only 2 files each.** Add a sign-off fail-closed test before step 10. |
| Provider runs | one or more files per provider: claude*, codex*, kimi*, opencode*, cursor*, muse*, grok*, plus *-guardrail-remote, reasoning-effort, context-usage, budget-spend | Generic `pushDetail` throttle (`lastPushByThread`, PUSH_THROTTLE_MS) is only covered by runner.test "generic onChunk throttle (#640)" |
| Run lifecycle / stop | absolute-stop, stop-during-prepare, quit-sigkill, queued-drain, rewind, runner.test | `drainQueued` only in queued-drain |

Gate for every step: the full `npm run test:electron` (CI-like env) plus `npm run typecheck`, run
before and after the change. Rerun any failing file on its own before blaming the move (known load
flakes: provider-usage, web-integration reconnect, memory-sup subtests).
