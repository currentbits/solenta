# Solenta bug repros: the T3 deep-dive bug list, checked by running tests

These notes cover commit `615b38a0`. `git diff --stat fbba4e10 615b38a0 -- electron src` is empty, so every line number from the report still applies. All repros ran in a throwaway detached worktree at `/tmp/solenta-repro`. It was set up with the three `node_modules` and `core/dist` cloned (`cp -Rc`) from `/Users/willem/code/coder`, whose `package-lock.json` is identical. That worktree has since been removed. No tracked file was changed: each fix check below was patched into the throwaway tree, run, and reverted with `git checkout`.

**How to read the tests.** Every repro test asserts the correct behaviour, so it FAILS while the bug is real and passes once the bug is fixed. The one exception is `repro-q1-q2.test.js`, which records current behaviour and is expected to pass.

**Where the files are.** The test files are in [`repros/`](repros/). To run them, copy them into `electron/test/` of a prepared worktree; they use the same `../store.js` relative requires as the existing suites.

**How they were run.** `repros/run-ci.sh` is a template that hard-codes `/tmp/solenta-repro` and this machine's node path. It starts from an empty environment (`env -i`), so no `CODER_*` variable leaks in, including the user's `CODER_GUARDRAILS_PATH`. It then runs:

```
PATH=/Users/willem/.hermes/node/bin:/tmp/solenta-ci-bin(git only):/usr/bin:/bin:/usr/sbin:/sbin
CODER_GROK_MCP_DISABLE=1 CODER_CURSOR_MCP_DISABLE=1 CODER_KIMI_MCP_PATH=/tmp/solenta-ci-worker-kimi.json
node --import=./test/support/render.mjs --experimental-strip-types --test --test-concurrency=1 <files>
```

- **Baseline before any repro:** 157/157 pass across `orch-server`, `crew-notices`, `verify-gate`, `pr-refresh`, `stop-during-prepare`, `orchestrator-threads`, `cross-thread`, `orch-merge` and `checkpoints`.
- **Full repro run:** `run-ci.sh --test-reporter=spec electron/test/repro-*.test.js` gives **23 tests: 19 fail (bugs reproduced), 4 pass**. The 4 passes are two controls, R1(c), and the two Q1/Q2 characterizations.

**Verdicts**

| ID | Verdict | Repro (file › test) |
|---|---|---|
| I1 | **REPRODUCED** | `repro-identity.test.js` › I1 (3 tests) |
| I2 | **REPRODUCED.** Expressed with the design's `boundThreadId`, because the handler has no caller identity at all | `repro-identity.test.js` › I2 |
| I3 | **REPRODUCED end to end**, through 3 paths. The fix needs the `n+1` increment, not only the exclusion | `repro-i3-inbound-merge.test.js` |
| I4 | **REPRODUCED** (bound variant). Unbound omission cannot be detected by any handler-only fix | `repro-identity.test.js` › I4 |
| R1 | **REPRODUCED** for the double fork (a), the notice forked as a task (b), and Stop during `/committee` (d). **NOT REPRODUCED** for Stop during the pendingFork hop (c) | `repro-r1-fork-hop.test.js` |
| R2 | **REPRODUCED**: a run starts mid-verify, verify overwrites its status, Stop is ignored, and the follow-up drains | `repro-r2-r3-verify-checkpoint.test.js` › R2 (2 tests) |
| R3 | **REPRODUCED**, 5 of 5 runs. The design's one-line fix is **not sufficient**: there is a second drain site | `repro-r2-r3-verify-checkpoint.test.js` › R3 |
| R5 | **REPRODUCED.** "Forever" is wrong: Stop clears it. A try/catch fix alone leaves status `working` | `repro-r5-preparing-leak.test.js` |
| R7 | **REPRODUCED** at the IPC layer. The renderer disables the buttons while working | `repro-r7-p1-p2-git-guards.test.js` › R7 (2 tests) |
| P1 | **REPRODUCED.** Live GitHub: of 34 archived worker PRs stored as OPEN, **29 are MERGED, 3 CLOSED, 2 OPEN** | `repro-r7-p1-p2-git-guards.test.js` › P1 |
| P2 | **REPRODUCED** | `repro-r7-p1-p2-git-guards.test.js` › P2 |
| Q1 | Stop holds the queued follow-up and turns queued notices into a transcript event, except during verify, where the follow-up drains | `repro-q1-q2.test.js` › Q1; existing `queued-drain.test.js` |
| Q2 | Settling reads no message timestamp. Inactivity uses `thread.updatedAt`, which notice turns bump; MERGED has no clock | `repro-q1-q2.test.js` › Q2 |

## I1 — Leaving out `fromThreadId` skips the cross-thread stop/archive gate

### Takeaway
REPRODUCED. A lead on a machine-delivered turn is refused when it passes `fromThreadId`. The same lead, on the same turn, stops another thread when it leaves `fromThreadId` out. `thread_archive archived:true` behaves the same way.

### Cited Findings
- **Code.** `assertCrossThreadApproved` returns early on an empty caller: `if (!fromId || fromId === targetId) return;` — [orchServer.js:536-539](../../electron/orchServer.js#L536). `thread_stop` and `thread_archive` call it — [orchServer.js:1012-1016](../../electron/orchServer.js#L1012), [orchServer.js:1058-1063](../../electron/orchServer.js#L1058).
- **Unbound `thread_stop` with no `fromThreadId`** while `isAutoTurn(t1)` is true. The control call with `fromThreadId:"t1", approved:true` is refused with "machine-delivered". Output — [repros/repro-identity.test.js](repros/repro-identity.test.js):
  `AssertionError: expected a refusal; got {"threadId":"t2"} and stopRun calls [{"threadId":"t2"}]`
- **Unbound `thread_archive`** of another thread with no `fromThreadId`:
  `expected a refusal; got {"threadId":"t1","archived":true}; t1.archived=true`
- **Bound variant** (`boundThreadId:"t2"`, the design's proposed dep, ignored today): worker t2 stops its lead t1.
  `AssertionError: worker stopped its lead: [{"threadId":"t1"}]`
- **Command:** `run-ci.sh --test-reporter=spec electron/test/repro-identity.test.js`, which gives I1 3/3 ✖.
- **An existing test asserts the bypass.** "thread_stop stops a run; rejects unknown and other-project threads" calls `thread_stop({threadId:"t2", projectId:"p1"})` with no `fromThreadId` and expects a stop — [orch-server.test.js:1066-1071](../../electron/test/orch-server.test.js#L1066).

### Inferences
- The fix must rewrite orch-server.test.js:1066-1071 and make self-archive callers pass `fromThreadId === threadId`, as design #1425 step 3 says. The two unbound I1 tests encode "refuse an empty caller" and need no binding to pass.

### Gaps
- The HTTP transport was not exercised. The handler-level tests are sufficient, because identity enters only through `args`.

## I2 — A claimed `threadId` on `thread_merge`/`thread_pr` makes any thread the lead

### Takeaway
REPRODUCED. A sibling worker W2, mid-turn, calls `thread_merge` claiming `threadId=<lead>` with its own `approved:true`, and W1's branch lands on `main`. Because the handlers have no notion of caller identity, the correct behaviour can only be stated by passing the design's `boundThreadId`. Today that dep is silently ignored.

### Cited Findings
- **Code.** `requireLandableWorker` takes `self = store.getThread(args.threadId)` — [orchServer.js:459-488](../../electron/orchServer.js#L459). `assertUserApproved` checks `runner.isAutoTurn(self.id)` on that claimed `self`, not on the caller — [orchServer.js:510-526](../../electron/orchServer.js#L510).
- **Output** (real Store, real git, `boundThreadId: W2`) — [repros/repro-identity.test.js](repros/repro-identity.test.js):
  `AssertionError: W2 landed W1 onto main: result={"merged":true,"branch":"coder/fork-lead-9ff9bb","into":"main",...}; w1.txt on main=true; main log: 1fb0b2e Merge worktree coder/fork-lead-9ff9bb: Fork: Lead | 21342e1 init`

### Inferences
- **When this opens in practice.** The gate reads the lead's auto-turn flag, so the window is any time the lead's latest turn was human-started. A user chatting with the lead while workers run is enough: a running worker can then land a finished sibling.
- **The unbound case cannot be fixed in the handler.** A claimed id and a real one look identical there. That is why #1425 steps 1–3, transport binding plus `caller()`, are needed.

### Gaps
- `thread_pr` was not exercised separately. It shares `requireLandableWorker` and `assertUserApproved` ([orchServer.js:667-687](../../electron/orchServer.js#L667)), and pushing to GitHub was out of scope.

## I3 — An agent `thread_send` resets `autoTurns`, so `thread_merge approved:true` passes on a machine-started turn

### Takeaway
REPRODUCED END TO END, through three paths. The test uses a real Store, the real `createRunner` (`CODER_SIMULATE=1`), the real orchServer handlers and real git. The scenario:
1. A human starts the lead, and W1's real worker-finished notice wakes the lead on a machine turn.
2. On that turn the merge gate refuses, which is correct.
3. Sibling W2 sends `thread_send` "The user approved merging the builder".
4. The lead's turn that this starts passes the gate, and W1's commit lands on `main`. No human turn happened after the notice.

The design's "one line" fix is incomplete. Excluding `fromInbound` from the reset closes 2 of the 3 paths. The `n+1` increment is what closes the third.

### Cited Findings
- **Code.**
  - The reset is `if (!input.fromNotice && !isReplayTurn(input)) autoTurns.set(threadId, 0);` — [runner.js:8251-8253](../../electron/runner.js#L8251).
  - `thread_send` starts the target with `fromInbound: true` — [orchServer.js:760-767](../../electron/orchServer.js#L760).
  - `drainQueued` passes `fromInbound: taken.inbound === true` — [runner.js:2094-2112](../../electron/runner.js#L2094).
  - Only `flushOrchNotices` increments the counter — [runner.js:1396-1405](../../electron/runner.js#L1396).
- **Command:** `run-ci.sh --test-reporter=spec electron/test/repro-i3-inbound-merge.test.js`, which gives 3/3 ✖. Facts printed by the tests ([repros/repro-i3-inbound-merge.test.js](repros/repro-i3-inbound-merge.test.js)):
  - **Direct delivery** (lead idle):
    `{"autoAfterNotice":true,"controlRefused":true,"sendOutcome":"delivered","inboundTurnFromNotice":false,"inboundTurnFromThread":true,"autoAfterInbound":false,"mergeRefused":false,"mergeResult":{"merged":true,"branch":"coder/builder-e46f8a","into":"main",...},"workerFileOnMain":true,"humanUserTurnsSinceNotice":0}`
  - **Queued delivery** (W2 sends while the lead's notice turn runs; held, then drained at its terminal):
    `{"sendOutcome":"queued","queuedHeld":true,"autoDuringNotice":true,"autoAfterDrain":false,"mergeRefused":false,"mergeResult":{"merged":true,...},"workerFileOnMain":true}`
  - **After a human chat turn** (the user asks the lead "how is it going?", which sets the counter to 0, then W2 sends):
    `{"sendOutcome":"delivered","autoAfterInbound":false,"mergeRefused":false,"workerFileOnMain":true}`
- **Fix check: the exclusion only.** Patching `!input.fromInbound` into the reset condition (throwaway tree, reverted) makes direct and queued pass, but after-chat still merges:
  `exclusion only → # pass 2 # fail 1 ... {"autoAfterInbound":false,"mergeRefused":false,"workerFileOnMain":true}`
- **Fix check: exclusion plus increment.** This turns all 3 green. With that patch, `crew-notices`, `orch-server`, `cross-thread`, `queued-drain`, `orch-merge` and `orchestrator-threads` give **116/116 pass**:
  ```js
  if (!input.fromNotice && !input.fromInbound && !isReplayTurn(input)) autoTurns.set(threadId, 0);
  else if (input.fromInbound) autoTurns.set(threadId, (autoTurns.get(threadId) || 0) + 1);
  ```

### Inferences
- **Ship both lines.** Item #1425 step 4 already specifies "a `fromInbound` turn sets `autoTurns` to n+1". The report's framing as a one-line change undersells this: the increment is load-bearing, not a cap nicety.
- **A sender does not need to lie about its identity.** W2 passed its real `fromThreadId`, so I3 is independent of I1, I2 and I4. Binding alone does not fix it.

### Gaps
- No real provider CLI was used: the lead's own decision to call `thread_merge` is simulated by calling the handler during the inbound turn. The gate, the counter, the transport into `startRun`, and git are all real.

## I4 — Leaving out `fromThreadId` on `thread_send` skips the unattended-sender refusal

### Takeaway
REPRODUCED for the bound case. An automation thread that names itself is refused, as the control shows. The same thread omitting `fromThreadId` delivers, and starts a `fromInbound` turn on the target with `fromThread: null`.

### Cited Findings
- **Code.** `from` is set only when `args.fromThreadId` is given — [orchServer.js:696-706](../../electron/orchServer.js#L696). The refusal is `if (from && isUnattended(from))` — [crossThread.js:89-91](../../electron/crossThread.js#L89). `isUnattended` is `Boolean(thread.automationId)` — [crossThread.js:45-47](../../electron/crossThread.js#L45).
- **Output** — [repros/repro-identity.test.js](repros/repro-identity.test.js):
  `delivered={"outcome":"delivered","threadId":"t1"}; startRun calls=[{"threadId":"t1","fromThread":null,"fromInbound":true}]` (the control test passes).

### Inferences
- **The design's `caller()` closes I4 only when bound.** Unbound, `caller("")` is still empty and the send is still delivered. Unbound callers are ssh/WSL, global configs and OpenCode. A complete fix would refuse an unbound `thread_send` that has no `fromThreadId`, or accept this as residual risk.

### Gaps
- None for the mechanism.

## R1 — Orchestrator fork hop: double fork, a notice forked as a task, and Stop

### Takeaway
REPRODUCED for (a), (b) and (d). During the pendingFork hop the lead has no active entry and `status:"idle"`, so:
- a second send forks a second worker;
- a peer notice delivered mid-hop is forked as a worker whose task is the notice text;
- Stop during a `/committee` fan-out stops worker 1 but still starts worker 2.

NOT REPRODUCED for (c), Stop during the single-worker pendingFork hop. `stopRun` cascades through `stopCrew` to the worker's `preparing` entry, so no worker runs. The lead's transcript still records "Forked worker … wakes this thread when it lands" and `pendingFork` is cleared.

### Cited Findings
- **Code.** The hop awaits `startWithPoolFailover` with no lead entry and no `fromNotice` check — [runner.js:8318-8394](../../electron/runner.js#L8318). The `dispatchOrchCommand` loop has no cancel check between workers — [runner.js:7766-7799](../../electron/runner.js#L7766). `stopCrew` stops `handoffFrom` children — [runner.js:8780-8803](../../electron/runner.js#L8780).
- **How the window is held open.** A hanging `bootstrapMemory` prefetch on the worker's first turn, the same seam [stop-during-prepare.test.js](../../electron/test/stop-during-prepare.test.js) uses. Command: `run-ci.sh --test-reporter=spec electron/test/repro-r1-fork-hop.test.js`, which gives 3 ✖ and 1 ✔. Output — [repros/repro-r1-fork-hop.test.js](repros/repro-r1-fork-hop.test.js):
  - **(a)** `{"leadActiveDuringHop":false,"leadStatusDuringHop":"idle",...,"workers":["build the parser","also add tests"]}`, giving `two workers forked … 2 !== 1`.
  - **(b)** The second worker's title and task are the notice itself: `"task":"[peer from w9 (\"backend\")] API contract is in contract.md\nContinue orchestrating; thread_status has full details."`
  - **(c)** passes: `{"workers":[{"task":"build the parser","status":"idle","running":false,"events":["Run stopped"]}],"leadPendingFork":false,"leadEvents":["Stopped 1 worker thread","[orchestration] Forked worker … wakes this thread when it lands."]}`
  - **(d)** `/committee @grok @codex …` gives `{"workers":[{"provider":"grok","status":"idle","stopped":true},{"provider":"codex","status":"working","ran":false,"stopped":false}]}`, so `a committee worker started after Stop`.

### Inferences
- **(a) is reachable from the UI.** The lead shows `idle` during the hop, which lasts as long as the worker's first-turn memory prefetch, so a second Enter calls `runs:start` again.
- **(b)'s trigger is broader than the design note says.** The note names a synchronously failing worker. Any `deliverNotice` during the hop does it, including `peer_send`, task notices and PR notices from item 7.
- **(c) is a transcript accuracy issue, not a runaway run.** The design's `preparing` entry for the hop is still the right fix for (a), (b) and (d). (d) also needs `abortIfCancelled` between workers.

### Gaps
- The hop's window between `forkWorkerThread` and the worker's `active.set` is synchronous, so it was not tested separately.

## R2 — The verify gate runs while the thread is `working` but not active

### Takeaway
REPRODUCED, in two tests.
1. A crew notice delivered during verify starts a run immediately. When verify finishes it writes `status:"done"` and `runStartedAt:null` over that live run.
2. Stop during verify does nothing: status stays `working`, verify runs to completion and prints "Verified:", and its success path then drains the queued follow-up that the #1203 contract says Stop should park.

### Cited Findings
- **Code.**
  - Verify sets `working` and runs without an `active` entry — [runner.js:1485-1523](../../electron/runner.js#L1485). `isRunning` is `active.has` — [runner.js:9007-9009](../../electron/runner.js#L9007).
  - `flushOrchNotices` checks only `active` — [runner.js:1360-1363](../../electron/runner.js#L1360).
  - Verify writes status unconditionally, then calls `finishSuccessfulTurn` — [runner.js:1700-1712](../../electron/runner.js#L1700).
  - `stopRun` returns early when nothing is active — [runner.js:8886-8895](../../electron/runner.js#L8886).
- **Setup:** generic provider with an injected `runAgentFn`, and `verifyCommand: "sleep 1.5; echo verify-ok"`. Command: `run-ci.sh --test-reporter=spec electron/test/repro-r2-r3-verify-checkpoint.test.js`. Output — [repros/repro-r2-r3-verify-checkpoint.test.js](repros/repro-r2-r3-verify-checkpoint.test.js):
  - **Notice:** `{"runStartedDuringVerify":true,"isRunningDuringVerify":true,"verifyOk":true,"statusAfterVerify":"done","noticeRunStillActive":true,"runStartedAtAfterVerify":null}`
  - **Stop:** `{"statusAfterStop":"working","verifyRanToCompletion":true,"verifiedEvent":true,"runStoppedEvent":false,"followUpDrained":true,"finalStatus":"working"}`. `finalStatus` is the drained follow-up's own verify.

### Inferences
- **The status overwrite is user-visible.** The sidebar shows `done` with no elapsed time while the notice turn is still streaming.
- **Not every entry point is open.** `maybeDrainQueued` refuses while status is `working` ([runner.js:2126-2128](../../electron/runner.js#L2126)), and `thread_send` queues on `status === "working"` ([orchServer.js:708-711](../../electron/orchServer.js#L708)). So the open entry points are notices, quota and failover timers, and direct `runs:start`.
- **A fix must cancel the drain, not just the command.** Making verify an `active` entry with a kill handle (design item 6, Phase A step 2) also lets Stop keep the follow-up parked.

### Gaps
- A quota-timer start during verify was not exercised.

## R3 — The fire-and-forget checkpoint races the next queued turn

### Takeaway
REPRODUCED, 5 of 5 runs. The turn-1 checkpoint commit contains turn 2's file. Its `Solenta-Message-Id` trailer names turn 2's user message ("turn two") instead of turn 1's reply. The design's one-line fix does **not** fix it: the no-verify path drains the queue a second time, at the end of `notifyRunTerminal`. A two-part fix was verified.

### Cited Findings
- **Code.**
  - `void maybeCreateCheckpoint` is followed immediately by `finishSuccessfulTurn` → `maybeDrainQueued` — [runner.js:1525-1532](../../electron/runner.js#L1525), [runner.js:1597-1606](../../electron/runner.js#L1597).
  - The **second drain** is at the end of `notifyRunTerminal`, for any status other than failed or stopped — [runner.js:2063-2078](../../electron/runner.js#L2063).
  - `maybeCreateCheckpoint` reads the transcript's last message id only after two awaited git calls, then runs `git add -A` — [worktrees.js:5282-5310](../../electron/worktrees.js#L5282).
- **Output** (turn 2's injected CLI writes `turn2.txt` the moment it launches) — [repros/repro-r2-r3-verify-checkpoint.test.js](repros/repro-r2-r3-verify-checkpoint.test.js):
  `{"checkpointSubject":"coder-checkpoint: turn 1","checkpointFiles":["turn1.txt","turn2.txt"],"trailerNamesRole":"user","trailerNamesText":"turn two",...}`
  The same result came back on 5 consecutive runs (`--test-name-pattern=R3`).
- **Design fix only** (`maybeCreateCheckpoint(...).catch(() => null).finally(() => finishSuccessfulTurn(id))`): R3 still fails with the same facts.
- **Two-part fix**, which adds `status !== "done" &&` to the drain condition at runner.js:2071 so that `finishSuccessfulTurn` owns the drain for done turns: R3 passes 3 of 3. `checkpoints`, `queued-drain`, `verify-gate`, `stop-during-prepare`, `crew-notices`, `orchestrator-threads` and `rewind` give **69/69 pass**.

### Inferences
- **The two halves depend on CLI speed differently.** The trailer mislabel does not depend on it: the drained turn's user message is appended synchronously, before the checkpoint's second git call returns. Capturing turn-2 edits does depend on it: a real CLI usually spends seconds before its first edit, so captured edits should be rare live. The wrong trailer still misleads rewind/restore, which use the trailer to keep "the turn that produced the commit".

### Gaps
- Live frequency was not measured. That would need checkpoint trailers checked against message roles across the live worktrees.

## R5 — A throw after the `preparing` entry leaks it

### Takeaway
REPRODUCED with a realistic trigger: the provider CLI vanishes during the first-turn memory prefetch, for example a CLI upgrade swapping the binary. The thread then reports "A run is already active on this thread" with `status:"working"`. It does **not** last forever: Stop clears it. The stall checker only posts a warning after 10 minutes. A try/catch that deletes the entry fixes `isRunning` but leaves status `working`.

### Cited Findings
- **Code.**
  - The `preparing` entry is set at [runner.js:8634-8644](../../electron/runner.js#L8634), then the prefetch is awaited (8646-8653). Neither is inside a try/finally.
  - The early CLI check runs before the entry exists — [runner.js:8410-8413](../../electron/runner.js#L8410). `startClaudeRun` re-checks after the await — [runner.js:3853](../../electron/runner.js#L3853).
  - `checkStalls` only appends an event — [runner.js:9204-9225](../../electron/runner.js#L9204).
- **Output** — [repros/repro-r5-preparing-leak.test.js](repros/repro-r5-preparing-leak.test.js):
  `{"firstErr":"Provider binary not found: …/claude. Install it or set CODER_CLAUDE_BIN.","isRunningAfterThrow":true,"statusAfterThrow":"working","retryErr":"A run is already active on this thread","isRunningAfterStop":false,"statusAfterStop":"idle"}`
- **Fix check.** The design's try/catch (`if (active.get(threadId) === pendingEntry) active.delete(threadId); throw e;`) gives `"isRunningAfterThrow":false,"statusAfterThrow":"working"`. The final test therefore also asserts that status is not `working`.

### Inferences
- **The fix needs a status reset.** The catch should also land the thread `failed` with `lastError`, as the worktree-setup failures do. Otherwise the sidebar shows Working with no run behind it.

### Gaps
- Other throw sites after `active.set` were not enumerated beyond the six provider `assertProviderBinary` re-checks and the "Unknown project" guards. The Muse remote overlay throw at [runner.js:7243](../../electron/runner.js#L7243) is another.

## R7 — `git:mergeWorktree`/`git:removeWorktree` IPC has no running guard

### Takeaway
REPRODUCED at the IPC layer. With `runner.isRunning(thread)` true and status `working`:
- `git:mergeWorktree` squash-merged the branch onto `main` and deleted the live run's cwd;
- `git:removeWorktree` deleted the cwd.

The renderer disables both buttons while the thread is working. The exposure is therefore the web bridge, stale renderer state, and other IPC callers.

### Cited Findings
- **Code.** Neither handler asks the runner — [ipc.js:1714-1724](../../electron/ipc.js#L1714), [ipc.js:1745-1752](../../electron/ipc.js#L1745). `mergeWorktree` and `removeWorktree` have no status check either — [worktrees.js:1227-1300](../../electron/worktrees.js#L1227), [worktrees.js:1553-1575](../../electron/worktrees.js#L1553). The UI guard is `busy = isWorking || …` on the buttons — [WorktreeControl.tsx:205](../../src/components/WorktreeControl.tsx#L205), [WorktreeControl.tsx:668](../../src/components/WorktreeControl.tsx#L668).
- **Output** — [repros/repro-r7-p1-p2-git-guards.test.js](repros/repro-r7-p1-p2-git-guards.test.js):
  - **Merge:** `{"refused":false,"error":null,"liveCwdStillExists":false,"featureOnMain":true,"threadWorktreePath":null}`
  - **Remove:** `{"refused":false,"error":null,"liveCwdStillExists":false}`

### Inferences
- **The guard belongs in the IPC handlers.** Both IPC calls and the web bridge go through them ([ipc.js:361-362](../../electron/ipc.js#L361)). `git:integrateWorker` already passes `isRunning` ([ipc.js:1725-1736](../../electron/ipc.js#L1725)).

### Gaps
- The web bridge path itself was not driven.

## P1 — The PR refresher skips archived threads

### Takeaway
REPRODUCED in code and confirmed against live GitHub. An archived `orchWorker` with an OPEN PR gets zero `gh` calls and stays OPEN. In the live store, all 35 archived threads stored as OPEN are stale except two:

| Archived threads stored as `prState:"OPEN"` | On GitHub |
|---|---|
| 34 workers | **29 MERGED, 3 CLOSED, 2 OPEN** |
| 1 plain thread | MERGED |

### Cited Findings
- **Code.** `if (t.archived) return false;` — [worktrees.js:4317-4327](../../electron/worktrees.js#L4317). An existing test pins the skip — [pr-refresh.test.js:384](../../electron/test/pr-refresh.test.js#L384).
- **Repro output** — [repros/repro-r7-p1-p2-git-guards.test.js](repros/repro-r7-p1-p2-git-guards.test.js):
  `{"res":{"examined":0,"changed":0,"spawned":0},"ghCalls":[],"prStateAfter":"OPEN"}`
- **Live store tally.** Read from a `/tmp` copy, since deleted, of `coder-store.json` (2044 threads; mtime 2026-10-04 12:47):

  | Thread kind | Archived? | prState | Count |
  |---|---|---|---|
  | worker | archived | OPEN | 34 |
  | worker | archived | MERGED | 1 |
  | plain | archived | MERGED | 22 |
  | plain | archived | OPEN | 1 |
  | plain | live | MERGED | 24 |
  | plain | live | CLOSED | 4 |

  This matches the report's 34-of-35 figure.
- **What GitHub returned** (`gh pr view <n> -R <owner/repo> --json state,mergedAt,closedAt`, read-only, one call per PR). The PRs span 5 repos, not only `currentbits/solenta`:
  - **currentbits/solenta**
    - MERGED: #656, #657, #658, #659, #660, #661, #672, #674, #676, #677, #678, #679 (Aug 22–23) and #863 (Sep 3; still holds a worktreePath).
    - CLOSED: #858 and #865 (Sep 3; both still hold a worktreePath).
  - **currentbits/girder:** #26–#30 MERGED (Sep 8).
  - **currentbits/appfeedback**
    - MERGED: #101, #104, #106, #145–#147, #149–#153 (Sep 22–26).
    - CLOSED: #81.
    - **OPEN: #78.**
  - **currentbits/cometx:** **#82 OPEN.**
  - **currentbits/huskyscout:** #70 MERGED. This is the 1 plain archived thread.

### Inferences
- **Most of the stale rows can never change on their own.** 32 of 34 (94%) of the archived "OPEN" worker PRs reached a terminal state on GitHub that Solenta never saw. Item 7's one-time catch-up refresh would flip them, and would reclaim #863's worktree through `maybeCleanupMergedWorktree` if that tree is clean and pushed. #858 and #865 are CLOSED; their worktrees are not reclaimed by that path, which handles MERGED only.
- **The existing test must change.** pr-refresh.test.js:384 asserts the opposite of this repro, as item 7 already notes.

### Gaps
- When each worker was archived relative to its merge date was not established; the store has no `archivedAt`. The mechanism does not depend on it.

## P2 — Merged-worktree cleanup has no running-thread guard

### Takeaway
REPRODUCED. A worker sent back to fix review comments is running and has not edited anything yet, so its tree is clean and pushed. A MERGED flip in `refreshPrStates` then deletes its worktree and branch while the run lives.

### Cited Findings
- **Code.** `maybeCleanupMergedWorktree` checks only MERGED state, a clean tree and local == origin — [worktrees.js:5539-5595](../../electron/worktrees.js#L5539). It is called from `refreshPrStates` ([worktrees.js:4427-4430](../../electron/worktrees.js#L4427)) and from `git:prMerge` ([ipc.js:1785-1794](../../electron/ipc.js#L1785)).
- **Output** — [repros/repro-r7-p1-p2-git-guards.test.js](repros/repro-r7-p1-p2-git-guards.test.js):
  `{"res":{"examined":1,"changed":1,"spawned":1},"prStateAfter":"MERGED","liveCwdStillExists":false,"threadWorktreePath":null,"branchStillExists":false}`
  The test also passes `isRunning` in `refreshPrStates` opts, which is the item-7 design's dep and is ignored today.

### Inferences
- **The guard must cover both callers.** The refresher and the in-app `git:prMerge` path both call the function, so the guard belongs inside `maybeCleanupMergedWorktree`. Checking `thread.status === "working"` there needs no plumbing; an injected `isRunning` also catches a stale status.

### Gaps
- The `git:prMerge` path was not driven; it needs a fake `gh pr merge`.

## Q1 — Does Stop let a queued follow-up drain?

### Takeaway
No, with one exception. Stop parks the queued user follow-up (#1203). It also turns queued crew notices into a transcript event and starts no turn. The exception is Stop during the verify window (R2): Stop does nothing there, and verify's success path drains the follow-up.

### Cited Findings
- **Code.** `notifyRunTerminal` skips the drain for `failed`/`stopped` — [runner.js:2063-2078](../../electron/runner.js#L2063). `stopCrew` turns pending notices into an `event` that "starts no run" — [runner.js:8794-8802](../../electron/runner.js#L8794).
- **Existing tests:** `queued-drain.test.js` 6/6 pass, including "sim stop leaves the queued follow-up parked" and "real-agent stop leaves the queued follow-up parked" — [queued-drain.test.js:144](../../electron/test/queued-drain.test.js#L144), [queued-drain.test.js:185](../../electron/test/queued-drain.test.js#L185).
- **Characterization, passing** — [repros/repro-q1-q2.test.js](repros/repro-q1-q2.test.js):
  `{"noticeTurnStartedAfterStop":false,"noticeDemotedToEvent":true,"followUpStillQueued":true,"followUpRan":false,"running":false,"status":"idle"}`
- **Verify-window exception** (R2 stop test): `{"statusAfterStop":"working","verifyRanToCompletion":true,"followUpDrained":true}`

### Inferences
- **Holding is already the contract.** A queued item should stay held until the user resumes it, and only the verify path breaks that. Item 2's held notices fit the same contract.

### Gaps
- Eject (`stopRun` with `cascadeCrew:false`, [ipc.js:793](../../electron/ipc.js#L793)) skips `stopCrew`. Pending notices may then flush at the terminal instead of being turned into an event. This was not tested.

## Q2 — Which timestamp does `effectiveSettled` measure from? Can a machine notice turn keep a merged thread from settling?

### Takeaway
No message timestamp at all.
- **Inactivity** settles from `thread.updatedAt`. A notice turn bumps `updatedAt`, so machine turns restart the 3-day clock on threads with no PR.
- **MERGED or CLOSED** threads settle with no time component. A notice turn keeps a merged thread unsettled only while its status is `working` or `quota-wait`. A notice turn that ends `failed` still settles.

### Cited Findings
- **Code.**
  - Precedence: `working`/`quota-wait` never settle → a pin never settles → `settledOverride` → MERGED/CLOSED → OPEN blocks → `updatedAt < now - days` — [src/threadSettle.ts:48-100](../../src/threadSettle.ts#L48).
  - `changeRequestAutoSettles` — [src/threadSettle.ts:33-39](../../src/threadSettle.ts#L33).
  - Run activity clears only a manual `"settled"` override and never sets `"active"` — [services.js:1651-1656](../../electron/services.js#L1651).
- **Characterization, passing** — [repros/repro-q1-q2.test.js](repros/repro-q1-q2.test.js). The test imports `src/threadSettle.ts` under `--experimental-strip-types`, with a simulate notice turn on a thread whose `updatedAt` was 4 days old:
  `{"settledBeforeNotice":true,"updatedAtBumped":true,"settledAfterNotice":false,"mergedDone":true,"mergedWorking":false,"mergedFailed":true}`

### Inferences
- **Merged threads settle reliably.** A merged worker or lead settles as soon as any notice turn ends, so notice traffic cannot pin it open.
- **Leads with no PR are the ones notice traffic keeps open.** Each machine turn resets the inactivity clock. If "settled" should mean quiet for N days of human activity, the clock would have to come from the last non-`fromNotice` message rather than `updatedAt`.
- **P1 is why worker PRs never settle.** Archived workers whose real PRs merged sit at `prState:"OPEN"`, and OPEN blocks settling. Fixing P1 settles them automatically.

### Gaps
- `updatedAt` bumps from sources other than notice turns (status writes with `{touch:true}`) were not enumerated.
