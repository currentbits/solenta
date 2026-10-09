# Solenta implementation designs for adoption items 5–9 (T3 Code Orchestrator V2 comparison)

Scope: concrete, implementable designs for items 5–9 of "Prioritized adoption plan" in `reports/T3 Code orchestrator for Solenta.md` (lines 211–304), checked against the code at checkout `fbba4e10` (2026-10-04). Citations are repo-relative `path:line` links into the checkout `/Users/willem/Library/Application Support/Solenta/worktrees/fae77a0b-5c8a-4a21-ba4f-b07f933538ed`. Live-store numbers come from a read-only copy of `~/Library/Application Support/Solenta/coder-store.json` plus its `messages/` shards, cloned to `/tmp/solenta-scan/` on 2026-10-04. Nothing was written to the live store. External CLI facts come from running `claude --help` (Claude Code 2.1.283) and `codex app-server generate-json-schema` (codex-cli 0.159.2) locally; both are cited as "local CLI".

Four corrections to the earlier report and baseline change the plan:
- Item 6's "failover re-entry (`onFailover` → `startRun`)" does not exist. `onFailover` only appends an event ([electron/runner.js:8354-8360](electron/runner.js#L8354)), and pool retries call `startRun` sequentially after the previous attempt rejects ([electron/subagentPool.js:363-395](electron/subagentPool.js#L363)).
- Item 1 (bind caller thread identity) is not implemented. Nothing in `electron/orchServer.js` or `electron/memory-sup.js` matches `boundThreadId` or `threadId=`. Item 5 can ship without it, but it inherits the "claimed `fromThreadId`" weakness.
- The pairing `steer` capability never calls `steerRun`. `task_send` throws "Task is still running" on a live task ([electron/pairing.js:612-631](electron/pairing.js#L612)). Today the only live-steer caller is the renderer IPC `runs:steer`.
- Item 7 is mostly built already. A background refresher polls PR state every 5 minutes, reclaims the worktree on merge and derives settle-on-merge in the renderer. It never sees worker PRs, though, because it skips archived threads and the runner archives finished workers.

## Item 5 — Lead steering via `thread_send mode:"steer"`

### Takeaway
The steer primitive works for Claude (stdin NDJSON) and Codex (`turn/steer` JSON-RPC). It is reachable only from the UI. Adding `mode:"steer"` to `thread_send` is about 60–90 lines plus tests:
- Check the target is the caller's direct worker, its policy is `accept`, its provider declares `supportsSteer` and it is not stalled on a permission prompt.
- Call `steerRun` with attribution.
- Fall back to today's hold-until-idle queue, with a reason.

Live data shows almost no demand yet. Over the store's lifetime, 3 of 274 `thread_send` calls hit a running Claude worker, and 399 of 493 workers ran on Grok, which cannot be steered. **Revised size: S. Priority: low.**

### Cited Findings
**How `steerRun` works today**
- Entry point: [electron/runner.js:8805-8851](electron/runner.js#L8805). It needs a live `active` entry that is not `stopping` (8819-8822), a provider with `supportsSteer === true` (8823-8828) and a `handle.send` function (8829-8831).
- It awaits `handle.send(prompt + attachments)`. A falsy result throws "Live process is not accepting input" (8833-8838).
- It then appends a `user` row on the current `runId` with `{ steer: true }` and no `fromThread` (8839-8847), saves, and pushes the detail (8848-8849).
- `appendMessage` already accepts `extra.fromThread` and `extra.steer` ([electron/runner.js:2967-2990](electron/runner.js#L2967)).

**Per provider**
- Claude: `send` is `sendUser`, which writes `{type:"user", message:{role:"user", content}}` to stdin ([electron/claude.js:231-239](electron/claude.js#L231)). `writeLine` returns false once stdin is destroyed or the process has finished ([electron/claude.js:168-178](electron/claude.js#L168)). Only provider id `claude` runs interactively ([electron/runner.js:4176](electron/runner.js#L4176)). Grok shares `claude-stream` but is non-interactive ([electron/runner.js:4930](electron/runner.js#L4930)), so it has no steer.
- Codex: the app-server handle's `send` issues `turn/steer {threadId, expectedTurnId, input}`. It returns false before the turn has started, or once the turn has settled or is stopping ([electron/codex-appserver.js:590-607](electron/codex-appserver.js#L590); doc at 332-345). The test "steerRun before turn/start returns no steer row" covers the first case ([electron/test/codex.test.js:1161](electron/test/codex.test.js#L1161)).
- Flags: `supportsSteer` is documented at [electron/providers.js:74](electron/providers.js#L74) and set only on claude (251) and codex (353). The codex entry's comment says "Do not fake steer by kill+resume. Queue remains idle follow-up" ([electron/providers.js:349-352](electron/providers.js#L349)).

**Who can call it**
- IPC `runs:steer` → `ctx.runner.steerRun(input)` ([electron/ipc.js:1526-1527](electron/ipc.js#L1526)), used by the composer's queue/steer toggle ([src/uiPrefs.ts:196-214](src/uiPrefs.ts#L196)).
- On "no live run" or "not accepting input", the renderer falls back to `setQueued` ([src/useCoder.ts:1806-1835](src/useCoder.ts#L1806)).
- Pairing: `steer` is a declared capability ([electron/pairing.js:28](electron/pairing.js#L28)), but `task_send` refuses running tasks and only calls `startRun` ([electron/pairing.js:612-631](electron/pairing.js#L612)).

**How `thread_send` queues today**
- Handler: [electron/orchServer.js:689-777](electron/orchServer.js#L689).
  - "Running" means `runner.isRunning(id) || status === "working"` (708-711).
  - `decideCrossThreadSend` decides (712-716).
  - `holdInbound()` calls `setQueued(..., {inbound:true, posted:true})` and `runner.appendInbound` (738-753).
  - An "already active" race from `startRun` also lands in `holdInbound` (760-775).
- Policies are `accept` / `queue-only` / `refuse`, normalized at [electron/crossThread.js:11-26](electron/crossThread.js#L11). `queue-only` or running returns `queued` ([electron/crossThread.js:109-117](electron/crossThread.js#L109)).
- Held messages drain at idle: `maybeDrainQueued` → `drainQueued` → `startRun({fromQueue:true, fromInbound})`, re-checking the inbound policy ([electron/runner.js:2094-2149](electron/runner.js#L2094)). `appendInbound` writes the inbound card at once ([electron/runner.js:2157-2172](electron/runner.js#L2157)).
- Schema today: `threadId`, `projectId`, `prompt`, optional `fromThreadId` ([electron/orchServer.js:1344-1362](electron/orchServer.js#L1344)). The description says "Mid-run sends are held, not injected" (1352-1353), and INSTRUCTIONS repeat it ([electron/orchServer.js:89-94](electron/orchServer.js#L89)). The stale permission-stall polling advice is at [electron/orchServer.js:99-101](electron/orchServer.js#L99).

**Crew relationship**
- `crewRootOf` walks to the crew ROOT, up to `CREW_ROOT_HOPS` ([electron/services.js:2717-2731](electron/services.js#L2717)).
- The landing and refresh tools use the DIRECT parent check `String(worker.handoffFrom) === String(self.id)` ([electron/orchServer.js:459-487](electron/orchServer.js#L459), [electron/orchServer.js:1134-1145](electron/orchServer.js#L1134)).

**Renderer attribution**
- A row with `fromThread` renders as the inbound card and returns early ([src/components/ThreadView.tsx:1372-1401](src/components/ThreadView.tsx#L1372)).
- The "Steered" label is only painted in the plain user bubble ([src/components/ThreadView.tsx:1491-1495](src/components/ThreadView.tsx#L1491)).
- `workerActivity` already excludes `fromThread || steer` rows from routine summaries ([src/workerActivity.ts:246-250](src/workerActivity.ts#L246)).

**Run ending mid-steer**
- Claude finalizes on the `result` event and calls `clearRun` synchronously ([electron/runner.js:4584-4600](electron/runner.js#L4584), 4753; `clearRun` at [electron/runner.js:3412-3435](electron/runner.js#L3412)). After that, `steerRun` throws "No live run to steer".
- Claude `send` is synchronous, so there is no await between the `active` check and the write.
- Codex `send` is a promise. A turn that settles during the await makes the row land on a just-finished `runId`.

**Live-store demand** (read-only copy)
- 274 `thread_send` tool calls. 254 predate outcome reporting (output is only `{threadId}`), 12 were `delivered` and 3 `queued`. All 3 queued sends went to the caller's own Claude workers.
- 5 errors were "A run is already active", all between 2026-08-17 and 08-19. 3 of them hit the caller's own Grok workers.
- orchWorkers by provider: grok 399, cursor 47, claude 43, kimi 4, codex 0. Last 30 days: grok 125, cursor 45, claude 43.

**Test harness**
- `orch-server.test.js` drives handlers with a fake runner exposing `startRun`, `isRunning` and `appendInbound` ([electron/test/orch-server.test.js:149-172](electron/test/orch-server.test.js#L149)).
- Steer has real-adapter tests: [electron/test/claude.test.js:2494](electron/test/claude.test.js#L2494) and [electron/test/codex.test.js:1130](electron/test/codex.test.js#L1130).

### Inferences
**Design**

1. **Schema** ([electron/orchServer.js:1354-1359](electron/orchServer.js#L1354)):
   - Add `mode: z.enum(["queue","steer"]).optional()`. Default `queue`, so today's behaviour is unchanged.
   - Rewrite the description at 1347-1353 to: "mode:"steer" injects into YOUR OWN running Claude/Codex worker's live turn; otherwise it is held as with queue and the reason is returned."
   - Add a new outcome `"steered"`. Only agents parse outcomes, so there is no renderer contract to break.

2. **Handler** ([electron/orchServer.js:689-777](electron/orchServer.js#L689)). After the existing undeliverable/refused return (718-727), insert this branch:
   ```js
   if (args.mode === "steer" && running) {
     const why = steerRefusal(thread, from);          // null when steerable
     if (!why) {
       try {
         const { runId } = await runner.steerRun({ threadId: thread.id,
           prompt: cliPrompt, displayPrompt: display, fromThread: fromMeta });
         return { outcome: "steered", threadId: thread.id, runId };
       } catch (err) {
         if (!/no live run|not accepting input|cannot steer/i.test(String(err && err.message))) throw err;
         holdInbound(); return { outcome: "queued", threadId: thread.id, reason: "run ended before the steer landed" };
       }
     }
     holdInbound(); return { outcome: "queued", threadId: thread.id, reason: why };
   }
   ```
   `steerRefusal` returns the first matching reason:
   - `!from` → "steer needs fromThreadId (your own id)".
   - `!(thread.orchWorker && String(thread.handoffFrom) === String(from.id))` → "not your worker".
   - `normalizeInboundPolicy(thread.crossThreadInbound) !== "accept"` → "inbound policy queue-only".
   - `getProvider(resolveProvider(thread))?.supportsSteer !== true` → "<provider> cannot steer".
   - `thread.awaitingInput === true` → "worker is waiting on a user permission prompt".
   
   A steer on an idle target falls through to the normal `delivered` path, so a lead never needs to know the target's state.

3. **Direct parent, not `crewRootOf`.** `crewRootOf` returns the root ([electron/services.js:2717-2731](electron/services.js#L2717)), which would let a root steer a grandchild past its sub-lead. The direct `handoffFrom` check matches `requireLandableWorker` and `refresh_worker_snapshot`.

4. **`steerRun` change** ([electron/runner.js:8812-8851](electron/runner.js#L8812)), about 6 lines:
   - Accept optional `displayPrompt` and `fromThread`.
   - Send the attributed `prompt` to the CLI, so the worker sees `[from thread <id> ("title")]` ([electron/crossThread.js:33-40](electron/crossThread.js#L33)).
   - Append `displayPrompt ?? prompt` with `{ steer: true, fromThread }`.
   - The UI path is unchanged because it passes neither field.

5. **Renderer:** about 3 lines.
   - In the inbound-card branch ([src/components/ThreadView.tsx:1381-1397](src/components/ThreadView.tsx#L1381)), render the existing `styles.steerLabel` "Steered" when `message.steer` is set.
   - Update the `steer` doc comment in [src/shared/ipc.ts:1207-1211](src/shared/ipc.ts#L1207).
   - No new IPC.

6. **INSTRUCTIONS** ([electron/orchServer.js:89-101](electron/orchServer.js#L89)):
   - Replace "Mid-run sends are held, not injected." with the steer rule.
   - Replace the "check thread_status for awaitingInput" polling advice with: "the user sees a blocked worker in the sidebar and answers it; tell them what it waits on".
   - Afterwards, update the `thread-send-mid-run` memory note, which is stale.

7. **Not added:** no kill-and-resume fallback. The provider comment forbids it ([electron/providers.js:349-352](electron/providers.js#L349)), and killing a Grok worker loses uncommitted work.

**Back-compat**
- `mode` is optional with the old default.
- Old agents never send it.
- The `queued` outcome gains an optional `reason`, as `undeliverable` and `refused` already have.

**Tests** (no new infra)
- `electron/test/orch-server.test.js`, adding `steerRun` and `getProvider` to the fake runner:
  - steer to own running Claude worker → `steered` with the fromThread payload;
  - non-worker → queued "not your worker";
  - queue-only policy → queued;
  - grok target → queued "cannot steer";
  - `awaitingInput` → queued;
  - steerRun throws "No live run" → queued plus held inbound;
  - idle target → `delivered`.
- `electron/test/claude.test.js` (next to 2494): steer with `fromThread` writes the attributed line and the row carries both `steer` and `fromThread`.
- Renderer test: an inbound card with `steer:true` shows `data-steer-label`.

**Risks**
1. Caller identity is still claimed until item 1 lands: any same-project thread can claim to be the lead. This is no worse than today's `delivered` path, which can already start turns on idle workers.
2. A Claude steer written after the CLI emitted `result`, but before Node processed it, starts a new CLI turn that has no active run, and its output is dropped. This window is shared with the UI steer (#156) and is not new. The phantom-result handling ([electron/runner.js:4589-4598](electron/runner.js#L4589)) covers the leftover result on the next turn.
3. A Codex steer can attach its row to a run that settled during the `await`. This is cosmetic.

**Revised size:** S, about 60–90 changed lines plus about 120 test lines. It depends on item 1 only for trust, not mechanics.

**Value:** low today. About 20% of recent workers are Claude, none are Codex, and the live data shows 3 steerable mid-run sends in seven weeks. Leads may avoid mid-run sends because INSTRUCTIONS say they are held, so this undercounts latent demand.

### Gaps
- I did not verify what Claude Code does with a stdin user message that arrives while a `can_use_tool` control request is pending. The design sidesteps it by refusing steer when `awaitingInput` is set.
- Whether leads would steer more once told they can is unmeasurable from the store.

## Item 6 — Per-thread lifecycle lock

### Takeaway
A run-long per-thread lock would deadlock Solenta. A running thread calls `thread_stop` on itself, and `thread_merge` onto its own tree, over MCP, and Stop must preempt a live run. A *transition* lock is safe, but on the main `startRun` path it adds almost nothing: there are zero `await`s between the `active.has` check (runner.js:8229) and the `preparing` entry (8644). The races that actually exist are elsewhere:
1. the orchestrator fork hop, which can double-fork;
2. the verify window, where status is `working` but the thread has no `active` entry;
3. a fire-and-forget checkpoint racing the next queued turn;
4. rewind/restore await gaps;
5. a leaked `preparing` entry on a synchronous throw;
6. Codex `preparing` entries invisible to the writer check (cross-thread, so no per-thread lock can fix it);
7. two merge/remove IPCs with no running guard.

The failover re-entry premise does not hold: `onFailover` only appends an event.

**Revised design: about 7 targeted fixes first (S), then a small keyed lock wrapping only startRun, stopRun and rewind/restore (S). Revised size: M overall, but most of the value lands in the first S.**

### Cited Findings
**Method**
- A full call-site pass over `electron/*.js` for startRun, stopRun/stopCrew, steerRun, drainQueued, flushOrchNotices, afterSuccessfulTurn/runVerifyGate, mergeWorktree/mergeInto, maybeCreateCheckpoint, restoreCheckpoint/rewindThread and startWithPoolFailover.
- Load-bearing lines were re-read and verified by hand: 3634-3640, 5128-5134, 8884-8896, 1700-1712, 1224-1228, ipc.js:1712-1720, services.js:4130-4215 and worktrees.js:5450-5510.

**Call-site table** ("re-enter?" asks whether the caller is already inside a lifecycle function for the same thread. "Lock?" is the verdict for a transition lock.)

| Caller (file:line) | → Function | Can it re-enter the same key? | Awaited? | Lock needed? |
|---|---|---|---|---|
| `flushOrchNotices` [runner.js:1405](electron/runner.js#L1405) inside `Promise.resolve().then` (1395) | startRun(self or lead) | Yes. flush is reached from terminals (1971, 1452, 1601), `queueOrchNotice` (1338, parent key), `deliverNotice` (1290), the Codex release timer (1206) and stopRun (8994) | No (F&F, `.catch` 1407) | Only through startRun. flush itself must stay unlocked; its `active.has` check (1363) is advisory |
| verify fix turn [runner.js:1730](electron/runner.js#L1730) | startRun(self) | Yes: verify IIFE (1506-1523) ← afterSuccessfulTurn ← terminal (1954) or sim (3409) | No (F&F) | Through startRun |
| `drainQueued` [runner.js:2103](electron/runner.js#L2103) ← `maybeDrainQueued` 2148 ← 1606, 2077, 2603, 2879 | startRun(self) | Yes. `void drainQueued` (2148) | drainQueued awaits it, but nobody awaits drainQueued | Through startRun. drainQueued must stay unlocked |
| `fireFailoverResume` [runner.js:3235](electron/runner.js#L3235) (setTimeout 3206 ← `tryQuotaFailover` 3200 ← `markRunFailed` 3094) | startRun(self) | No: timer, top-level | Yes, inside the timer | Through startRun |
| `fireQuotaWake` [runner.js:3297](electron/runner.js#L3297); `resumeQuotaWait` 3345 ← ipc.js:1539 | startRun(self) | No | Yes | Through startRun |
| `dispatchOrchCommand` [runner.js:7774](electron/runner.js#L7774) inside startRun(lead) (8282) → `startWithPoolFailover` | startRun(worker), one at a time (loop 7766-7799) | Different key (new forks) | Yes | Takes the worker key. Order is lead → worker; acyclic |
| pendingFork hop [runner.js:8346](electron/runner.js#L8346) inside startRun(lead) | startRun(worker) via pool | Different key | Yes | Same as above |
| pool retry [subagentPool.js:363-395](electron/subagentPool.js#L363) | startRun(worker) again | Same key, but only after the previous attempt **rejected**: sequential, not nested | Yes | No nesting. `onFailover` (runner.js:8354-8360) only appends an event and never calls startRun |
| `thread_fork` [orchServer.js:443](electron/orchServer.js#L443) | startRun(fresh fork) via pool | No | Yes | Fork's key, never contended |
| `thread_send` [orchServer.js:761](electron/orchServer.js#L761) | startRun(target) | Target ≠ caller when `fromThreadId` is set (703-705); a self-send is queued (crossThread.js:109) | Yes; "already active" is caught and queued (770-773) | Target's key |
| ipc.js:1524 `runs:start` (also reachable via the web bridge), 883, 897, 912, 965 (spec/teach) | startRun | No | Yes | Through startRun |
| pairing.js:598, 628 (guard 622-625), 779 | startRun | No | Yes | Through startRun |
| autodispatch.js:35, automations.js:179, memory-consolidate.js:393, postmerge.js:481 | startRun(fresh thread) | No | Yes | Never contended |
| `stopCrew` [runner.js:8790](electron/runner.js#L8790) inside stopRun(parent) 8867 | stopRun(child, seen) | Different key, **except on a handoffFrom cycle or self-loop**: `seen` is checked inside stopCrew (8781), after a locked stopRun has already acquired the key | Yes, depth-first | The public entry locks; recursion must go through an unlocked inner function |
| ipc.js:1536 `runs:stop`; pairing.js:652; ipc.js:793 (eject, `cascadeCrew:false`) | stopRun | No | Yes | Yes (short) |
| `thread_stop` [orchServer.js:1058-1063](electron/orchServer.js#L1058) | stopRun, possibly on the caller itself (self-stop skips the gate at 539) | The caller's own run is live | Yes | Transition lock only. **A run-long lock deadlocks here** |
| main.js:915, beachball.js:222 | `stopAll` (synchronous) | No | — | Bypass |
| ipc.js:1527 `runs:steer` (and item 5's thread_send) | steerRun 8812 | No | Yes | Optional. Fix the stale-runId append instead (below) |
| [runner.js:1510](electron/runner.js#L1510) (verify path) | `maybeCreateCheckpoint` (worktrees.js:5282, 5 awaited git calls) | Same thread, after the terminal | Yes, inside the IIFE | Part of the verify "run" (below) |
| [runner.js:1528](electron/runner.js#L1528) (no-verify path) | `maybeCreateCheckpoint` | Same thread | **No (`void`)**. `finishSuccessfulTurn` → `maybeDrainQueued` runs at once (1532, 1606) | **Race.** Await it instead |
| worktrees.js:5487 inside restoreCheckpoint | `maybeCreateCheckpoint` | Same key, nested | Yes | Must stay unlocked |
| ipc.js:701 → `rewindThread` [services.js:4130](electron/services.js#L4130) / undo 4091 | truncate, null sessionId (4190-4194), `restoreCheckpoint` (4210) | Guard 4140-4142, then awaits at 4165, 4199, 4210 | Yes | **Lock the IPC entry.** The inner restore call stays unlocked |
| ipc.js:1895 → `restoreCheckpoint` [worktrees.js:5450](electron/worktrees.js#L5450) | `reset --hard` (5489), null sessionId (5507) | Guard 5456, then awaits at 5474, 5487, 5489, 5504 | Yes | Lock the IPC entry |
| ipc.js:1715 `git:mergeWorktree` → mergeWorktree (worktrees.js:1227) | squash merge (synchronous) | — | — | **No running guard at all** ([electron/ipc.js:1714-1720](electron/ipc.js#L1714)). Needs an `isRunning`/`working` guard, not a lock |
| ipc.js:1745 `git:removeWorktree` | removeWorktree (1553) | — | — | No running guard; same fix |
| `thread_merge` [orchServer.js:627](electron/orchServer.js#L627) (worker key; writes the caller's tree) | mergeWorktree (synchronous) | Guard 479-486, with no await before 627 | — | No. Synchronous, so atomic |
| crewIntegration.js:292 ← ipc.js:1726 | mergeWorktree into the lead's tree | Guards 261, 264 | — | No (synchronous) |
| `flushOrchNotices`, `queueOrchNotice`, `deliverNotice`, `notifyRunTerminal`, `drainQueued` | — | — | — | **Leave unlocked.** Every same-key re-entry is fire-and-forget |

**Existing race guards**
- "Already active" checks: [runner.js:8229-8231](electron/runner.js#L8229), flush 1363, stopRun 8887. There is no existing lock, and no `pendingStarts`/`starting` set.
- The `runId` identity re-check `!e || e.stopping || e.runId !== runId` appears in every provider's callbacks (for example [runner.js:4779](electron/runner.js#L4779)).
- `abortIfCancelled` runs after the startRun await (8655) and before every spawn.
- **#1228** (`aa9b2e46` "Honor Stop while a run is preparing to launch (#1228) (#1269)"): the `kind:"preparing"` entry with a `stopping` kill handle ([runner.js:8634-8644](electron/runner.js#L8634)), plus `launchWasCancelled`, `settleCancelledLaunch`, `claimPreparingRun` (for example [runner.js:5131-5134](electron/runner.js#L5131)) and `electron/test/stop-during-prepare.test.js`.
- **#1265** (`f6c9323a`): `codexSessionHeld` ([runner.js:1221-1232](electron/runner.js#L1221)), the startRun writer guard (8240-8249), `parkCodexFromNotice` in flush (1241-1260, 1369-1387) and the release-delay timer (1195-1213).
- #1383: a self-archiving Claude turn defers its own kill ([electron/orchServer.js:370-376](electron/orchServer.js#L370)).
- A failed drain puts the prompt back with the error ([runner.js:2113-2122](electron/runner.js#L2113)). A failed flush marks the thread `failed` only when it is not active (1415-1426).

**Async gaps and verified races**

- **R1, orchestrator fork hop (double fork).**
  - The pendingFork branch awaits `startWithPoolFailover` ([runner.js:8346-8361](electron/runner.js#L8346)) and clears `pendingFork` only at 8390-8394. During the await the lead has **no `active` entry**.
  - So a second startRun(lead) passes 8229 and forks again. Stop on the lead does nothing to it (stopRun returns early when not active, [runner.js:8887-8895](electron/runner.js#L8887)).
  - A worker that fails synchronously drives `afterFailedTurn` → `queueOrchNotice` → `flushOrchNotices(lead)`. That schedules startRun(lead, fromNotice) in a microtask while `pendingFork` is still true, so **the notice text itself gets forked as a worker task**. The branch does not check `fromNotice` ([runner.js:8318](electron/runner.js#L8318)).
  - `dispatchOrchCommand` has the same shape: an awaited loop over workers with no cancel check ([runner.js:7766-7799](electron/runner.js#L7766)).
- **R2, verify window.**
  - `afterSuccessfulTurn` sets `status:"working"` ([runner.js:1496-1500](electron/runner.js#L1496)), then awaits the checkpoint, the head sha and the verify command (1506-1516). It never registers in `active`.
  - startRun (8229) and flush (1363) check only `active`, so a user turn, a notice or a quota timer can start a run mid-verify.
  - Verify then writes `status:"done"`/`"failed"` unconditionally over that run ([runner.js:1707-1711](electron/runner.js#L1707)) and calls `finishSuccessfulTurn`.
  - Stop cannot cancel verify, because there is no entry or handle (stopRun returns at 8887-8895).
- **R3, checkpoint versus next turn.** The no-verify path fires `void maybeCreateCheckpoint` ([runner.js:1526-1532](electron/runner.js#L1526)) and immediately calls `finishSuccessfulTurn`, which drains the queued follow-up into a new run. That run's CLI writes into the same worktree while `git add -A`/`commit` (worktrees.js:5282 onward, 5 awaits) is in flight. The checkpoint can capture the next turn's partial edits under the previous turn's `Solenta-Message-Id`.
- **R4, rewind/restore.**
  - `rewindThread` guards at [services.js:4140-4142](electron/services.js#L4140), then awaits (4165, 4199, 4210) around the transcript truncation and `sessionId: null` (4192).
  - `restoreCheckpoint` guards at [worktrees.js:5456](electron/worktrees.js#L5456), then awaits (5474, 5487) before `reset --hard` (5489) and `sessionId: null` (5507).
  - The renderer runs rewind then start as two IPCs ([src/useCoder.ts:1915-1933](src/useCoder.ts#L1915)). A notice or drain run can slip in between, and the best-effort undo is then refused.
- **R5, leaked `preparing` entry.** Nothing after `active.set(threadId, pendingEntry)` (8644) is wrapped in try/finally ([runner.js:8644-8704](electron/runner.js#L8644)). A synchronous throw in a `start*Run`, for example `startGenericRun`'s "Unknown project" ([runner.js:3638-3640](electron/runner.js#L3638)), leaves the thread reporting "already active" until someone stops it.
- **R6, Codex writer check blind to `preparing` (cross-thread).** `codexSessionHeld` skips any entry whose `kind !== "codex"` ([runner.js:1226](electron/runner.js#L1226)). The `codex` kind is claimed only at [runner.js:5131-5134](electron/runner.js#L5131), after the `prefetchBootstrapNote` await (8646). Two threads sharing a Codex sessionId can both pass the guard at 8240, which is the #1265 failure mode. A per-thread lock cannot fix this; it is a cross-key invariant.
- **R7, unguarded merge/remove IPC.** `git:mergeWorktree` calls `mergeWorktree` without checking the runner ([electron/ipc.js:1714-1720](electron/ipc.js#L1714)). `git:removeWorktree` (1745) is the same. In contrast, `thread_merge` and crew integration check `isRunning` first.
- **R8, steerRun stale runId.** It awaits `send` (8833), then appends with the `entry.runId` it read before the await (8839-8847).

### Inferences
**Design**

**Phase A — targeted fixes (S, about 80–120 lines, no lock):**
1. **R1:** in the pendingFork branch and in `dispatchOrchCommand`:
   - register the same `preparing` entry used at 8634-8644 for the lead before the await;
   - delete it in `finally` only if it is still this hop's entry;
   - call `abortIfCancelled` between workers;
   - guard the branch with `thread.pendingFork && !input.fromNotice`.
   
   This closes the double fork and the notice-as-task fork, and makes Stop on a forking lead effective. Whether an inbound `thread_send` should also skip the hop (`!input.fromInbound`) is a product choice. Today it is forked like a user prompt.
2. **R2:** make verify a first-class `active` entry, `{kind:"verify", runId: <new>, stopping:false, handle:{kill}}`. `kill` aborts `runVerifyCommand`'s child. Then:
   - startRun throws "already active", so thread_send, drain and the renderer queue as they do for runs;
   - flush holds;
   - Stop cancels verify;
   - `runVerifyGate` re-checks `active.get(id)?.runId === verifyRunId` before writing status (1707-1711) and clears the entry in `finally`.
   
   This is the same `runId` discipline the providers already use. Do **not** hold a lock for minutes.
3. **R3:** `maybeCreateCheckpoint(store, id).catch(() => null).finally(() => finishSuccessfulTurn(id))` at 1526-1532. One line. It costs a checkpoint's git latency (tens of ms) before the follow-up starts.
4. **R5:** wrap 8644-8704 in `try { … } catch (e) { if (active.get(threadId) === pendingEntry) active.delete(threadId); throw e; }`.
5. **R6:** in `codexSessionHeld`, also treat `entry.kind === "preparing"` as a holder when `resolveProvider(store.getThread(id)) === "codex"` and that thread's `sessionId` matches. Two lines.
6. **R7:** in `git:mergeWorktree` and `git:removeWorktree`, refuse when `ctx.runner.isRunning(threadId) || thread.status === "working"`, reusing the `requireLandableWorker` wording.
7. **R8:** in steerRun, re-read `active.get(threadId)` after the await and append with that `runId`. If it is gone, append with `runId: null`.

**Phase B — keyed lock (S, about 25 lines plus wiring):**
```js
// ponytail: one promise chain per thread; never held across a run or verify.
const tails = new Map();
function withThreadLock(id, fn) {
  const prev = tails.get(id) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  tails.set(id, tail);
  tail.then(() => { if (tails.get(id) === tail) tails.delete(id); });
  return run;
}
```
- **Wrap, by renaming the inner function and rebinding the closure name** so internal callers (1405, 1730, 2103, 3235, 3297, 3345, 7779, 8351) go through it:
  - `startRun = (i) => withThreadLock(i.threadId, () => startRunInner(i))`;
  - the public `stopRun`, where `stopCrew` recursion calls `stopRunInner`, fixing the cycle deadlock;
  - the IPC entries for `rewindThread`, `undoRewindThread` and `restoreCheckpoint`, whose inner `restoreCheckpoint` call at services.js:4210 stays unlocked.
- **Never wrap:** flush, queue/deliverNotice, `notifyRunTerminal`, `drainQueued`, `maybeCreateCheckpoint`, verify, `stopAll`, `steerRun`, `thread_merge`.
- **Rule** (V2's): never `await` another same-key lifecycle function inside a locked section. Cross-thread work is lead → worker only.
- **Stop must not queue behind a long start.** `stopRun` first sets `stopping` on any `preparing` entry (the #1228 fast path, 8634-8642) *before* awaiting the lock.
- **Semantics for callers are unchanged.** A second startRun still ends in "A run is already active", just after the first transition settles instead of racing it.
- **What it buys over Phase A:** rewind/restore versus notice/drain/start become ordered rather than "guard, then hope", and any future await added between 8229 and 8644 stays safe.

**Deadlock review of Phase B**
- Failover: sequential retries after rejection, so safe.
- pendingFork/dispatch: lead lock → worker lock, acyclic, so safe.
- afterSuccessfulTurn → flush → startRun(self): fire-and-forget, so it queues safely.
- MCP self-calls (`thread_stop` self, `thread_merge` own tree): safe because the lock is released once startRun returns at spawn.
- stopCrew cycles: safe via `stopRunInner`.

**Tests** (existing infra; the item 4 replay harness is not required)
- `electron/test/stop-during-prepare.test.js`:
  - Stop during a pendingFork hop aborts the remaining workers;
  - a synchronous throw after `preparing` leaves no `active` entry.
- `electron/test/orchestrator-threads.test.js`:
  - two concurrent sends on a `pendingFork` lead create one worker;
  - a fromNotice turn never forks.
- `electron/test/verify-gate.test.js`:
  - startRun during verify throws "already active" and the follow-up stays queued;
  - Stop cancels verify;
  - verify does not overwrite a newer run.
- `electron/test/checkpoints.test.js`: a queued follow-up starts only after the checkpoint commit exists.
- `electron/test/codex-writer-lock.test.js`: a second thread sharing a sessionId is refused while the first is `preparing`.
- A unit test for `withThreadLock`: ordering, error isolation, map cleanup.
- An ipc test: `git:mergeWorktree` is refused for a working thread.

**Risks**
1. The R2 change alters what users see: during verify, sends now show as queued, which matches the status already shown.
2. R3 adds a short delay before follow-ups.
3. Phase B's rebinding of `startRun` must cover the export at runner.js:9263 too. Grep for `startRun(` after the change.
4. A lock never fixes git-level hazards. `mergeInto` stashes and `reset --hard`s the caller's live tree while the caller's CLI may be mid-turn (worktrees.js:1355-1538 per the audit). That stays a documented hazard of `thread_merge` onto a running lead's own tree.

**Revised size:** M overall. Phase A is S and fixes the 7 concrete races; Phase B is S. The "M, after 4" sizing still holds, but the dependency on item 4 is soft. Do Phase A before items 5 and 7, because both add new lifecycle entry points (steer, PR notices).

### Gaps
- Verified by reading only. None of R1–R8 was reproduced live, and the live store carries no evidence of R1 (item 9 found 0 identical worker pairs within 5 s).
- I did not measure how often R3 (a checkpoint absorbing the next turn's edits) has happened. That would need a diff of checkpoint commits against message timing per worktree.
- `mergeQueue.js` `integrateNext`/`promote` call `mergeWorktree` without a running guard but have no in-tree callers. Their status as live code was not established.

## Item 7 — PR-watch wake-ups

### Takeaway
Most of item 7 already exists in `electron/worktrees.js`:
- an async, serialized, latched 5-minute PR refresher (`refreshPrStates` / `createPrStateRefresher`);
- host-side `gh` with the user's own auth;
- check and mergeability parsers;
- immediate worktree reclaim on MERGED;
- a post-merge re-verify hook;
- renderer-derived settle-on-merge.

It is blind to the case item 7 targets. 34 of the 35 worker PRs in the live store sit `archived` with `prState: "OPEN"`, because `sweepCrew` archives finished workers and `isPrRefreshCandidate` skips archived threads.

The design is therefore an extension of the refresher, not of `autodispatch.js`:
1. Arm a `prWatch` record in `thread_pr`.
2. Poll armed threads, archived or not, with `mergeable,reviewDecision,statusCheckRollup`.
3. Diff against the persisted last state.
4. Deliver one notice per bad transition to the worker's lead through `runner.deliverNotice`.

**Revised size: S–M (about 150–220 lines plus tests), down from M.**

### Cited Findings
**The existing refresher**
- `refreshPrStates` ([electron/worktrees.js:4350-4453](electron/worktrees.js#L4350)):
  - takes candidates from `isPrRefreshCandidate`;
  - per thread: `resolveThreadGit` → GitHub-origin check → `gh pr view <n> --json number,url,state` → persist only on change;
  - on MERGED, calls `maybeCleanupMergedWorktree` and `postmerge.onThreadPrState` (4427-4437);
  - does one save and one `threads:changed` push at the end;
  - never throws.
- `isPrRefreshCandidate` skips archived threads and terminal MERGED/CLOSED ([electron/worktrees.js:4317-4327](electron/worktrees.js#L4317); `TERMINAL_PR_STATES` at 203).
- `createPrStateRefresher` has a boolean latch, a startup pass and an interval ([electron/worktrees.js:4473-4547](electron/worktrees.js#L4473)). It is wired in main with `intervalMs: 5*60*1000` and `startupDelayMs: 30_000` ([electron/main.js:779-790](electron/main.js#L779)).

**gh runs host-side**
- `ghTryAsync` runs `execFile(gh)` in the main process with `process.env` plus `GH_PROMPT_DISABLED=1`, under a hard timeout ([electron/worktrees.js:2810-2853](electron/worktrees.js#L2810)). It uses the host user's gh auth, so the sandboxed-session gh auth blocker does not apply.
- The background timeout is `PR_REFRESH_TIMEOUT_MS = 8_000` ([electron/worktrees.js:137](electron/worktrees.js#L137)).

**Existing parsers**
- `PR_JSON_ENRICHED` includes `mergeable` ([electron/worktrees.js:2982-2984](electron/worktrees.js#L2982)).
- `prStatus` persists `prMergeable` ([electron/worktrees.js:3737-3784](electron/worktrees.js#L3737)).
- `normalizeCheckBucket` maps check states to `pass/fail/pending/skipping/cancel` ([electron/worktrees.js:3800-3820](electron/worktrees.js#L3800)), and `rollupPrChecks` counts them (3921-3935).
- `prChecks` already runs `gh pr checks <n> --json name,state,bucket,link`, with a text fallback and auth/no-PR reasons ([electron/worktrees.js:3974-4060](electron/worktrees.js#L3974)).
- `ThreadInfo.prMergeable` exists ([src/shared/ipc.ts:674-680](src/shared/ipc.ts#L674)).

**How `thread_pr` records PR info**
- `thread_pr` → `createPr({ threadId: worker.id })` ([electron/orchServer.js:667-687](electron/orchServer.js#L667)). It persists `prNumber/prUrl/prState` on the WORKER thread ([electron/worktrees.js:4610-4683](electron/worktrees.js#L4610)).
- The worktree survives on purpose so review fixes can be sent back (comment at [electron/orchServer.js:659-666](electron/orchServer.js#L659)).

**Workers get archived**
- `sweepCrew` sets `archived: true` on finished workers once no crew member is running ([electron/runner.js:1784-1820](electron/runner.js#L1784), the write at 1818).
- A test pins the skip: "archived thread is skipped even with OPEN pr" ([electron/test/pr-refresh.test.js:384](electron/test/pr-refresh.test.js#L384)).

**Settle and retention**
- Settle-on-merge is derived, not stored. `changeRequestAutoSettles`: CLOSED always settles, MERGED settles when `autoSettleOnMerge` is on, and the default is true ([src/threadSettle.ts:33-39](src/threadSettle.ts#L33)). `effectiveSettled` applies it unless a pin or override wins ([src/threadSettle.ts:48-81](src/threadSettle.ts#L48)). The live store's settings contain `autoSettleOnMerge`.
- `maybeCleanupMergedWorktree` removes the worktree and `branch -D` only when the tree is clean and local HEAD equals `origin/<branch>` ([electron/worktrees.js:5539-5595](electron/worktrees.js#L5539)). It does **not** ask the runner whether the thread is running.

**autodispatch is the wrong host**
- It is a per-project opt-in (`project.autoDispatch === true`) issue dispatcher on the same 5-minute cadence, with no PR concept ([electron/autodispatch.js:3-4](electron/autodispatch.js#L3), 64-104).

**Notice path**
- `deliverNotice({threadId, line})` enqueues and flushes, and never throws ([electron/runner.js:1282-1294](electron/runner.js#L1282)).
- `flushOrchNotices` applies the orchestration budget and the 25-turn auto-turn cap, and holds while the lead runs ([electron/runner.js:1360-1434](electron/runner.js#L1360)).
- `orchServer` already calls `runner.deliverNotice` for tasks and peers ([electron/orchServer.js:965-971](electron/orchServer.js#L965), 1008).

**Existing PR UI**
- Sidebar PR link chip `#N` ([src/components/Sidebar.tsx:1408-1418](src/components/Sidebar.tsx#L1408)).
- AgentsPanel PR label `#N <state>` ([src/components/AgentsPanel.tsx:1567-1582](src/components/AgentsPanel.tsx#L1567)).
- `PrWorkspacePanel` / `PrListView` components exist.
- No check-rollup badge on rows. I found no "#363" reference in `docs/` or `git log`.

**Live store** (read-only copy, 2041 threads)
- 86 threads carry `prNumber`: 35 orchWorker and 51 plain.
- Worker PRs: 34 `archived/OPEN`, 1 `archived/MERGED`.
- Plain PRs: 24 live/MERGED, 22 archived/MERGED, 4 live/CLOSED, 1 archived/OPEN.
- 35 archived+OPEN threads are invisible to the refresher; 3 of them still hold a `worktreePath`.
- `prMergeable`: null on 84, UNKNOWN on 2.

### Inferences
**Design**

1. **Arm.** In `thread_pr`, after `createPr` resolves ([electron/orchServer.js:678-686](electron/orchServer.js#L678)), write `prWatch: { armedAt: Date.now(), notify: String(self.id), last: null }` on the worker. `notify` is the lead to wake.
   - Shape on `ThreadInfo` (main-only field; add it to the `listRow` detail-only strip list):
     ```ts
     prWatch?: { armedAt: number; notify: string;
                 last: { state, mergeable, review, failing: string[] } | null }
     ```
   - A UI-created PR on a plain thread is not armed (see risk 2).

2. **Candidates** ([electron/worktrees.js:4317-4327](electron/worktrees.js#L4317)): change `if (t.archived) return false;` to `if (t.archived && !t.prWatch) return false;`.
   - Also let the 35 historical archived/OPEN rows get one plain state refresh, without notices, so they reach terminal state and drop out. About 35 serialized `gh` calls once.
   - Update the test at [electron/test/pr-refresh.test.js:384](electron/test/pr-refresh.test.js#L384) to cover armed versus unarmed.

3. **Fetch.** For armed threads only, run `gh pr view <n> --json number,url,state,mergeable,reviewDecision,statusCheckRollup`.
   - On an unknown-field error, fall back to `number,url,state` with the existing `isUnknownJsonField`.
   - Derive `failing` = names of rollup items whose `normalizeCheckBucket(conclusion || state || status) === "fail"`. This needs one `gh` call, not the two that `prChecks` makes.
   - Unarmed threads keep the minimal field set and cost.

4. **Diff → signal.** Compare against `prWatch.last` and emit at most one line per thread per pass, only on entering a state:
   - `MERGED` → "merged"; `CLOSED` → "closed";
   - `mergeable === "CONFLICTING"` → "conflicts";
   - `reviewDecision === "CHANGES_REQUESTED"` → "changes requested";
   - a non-empty `failing` whose set differs from last → "checks failed: a, b".
   
   `last === null` (first observation) records state only; it notifies only for a bad state.

5. **Notify.** Add an optional `opts.notify(threadId, line)` to `refreshPrStates` and `createPrStateRefresher`. In [electron/main.js:784-790](electron/main.js#L784), pass `(id, line) => runner.deliverNotice({ threadId: id, line })`.
   - Skip when the lead is missing, trashed or archived.
   - Line format: `[pr] Worker <id> ("title") PR #N <signal>. <url>. Send the worker the fix with thread_send; merging stays with the user.` Merged/closed lines omit the fix advice.
   - The `[pr]` prefix keeps `noticePrompt` from adding `[orchestration]` ([electron/runner.js:1348-1352](electron/runner.js#L1348)).
   - Budget and the auto-turn cap apply unchanged.
   - Persist `prWatch.last` after notifying, inside the same pass's single `store.save()`.

6. **Settle and reclaim.** The settle side needs no new code: MERGED already settles in the renderer, and `maybeCleanupMergedWorktree` reclaims at once. Add one guard there: skip when `opts.isRunning?.(threadId)`, injected from `runner.isRunning`. Otherwise a worker fixing review comments when the PR merges, with a momentarily clean and pushed tree, loses its cwd mid-run.
   - Keep the existing retention sweeper (`createRetentionSweeper`, [electron/main.js:839](electron/main.js#L839)) as the backstop.

7. **Merging stays human.** No `gh pr merge` from agents. The existing `mergePr` stays behind the UI.

**Back-compat**
- `prWatch` is additive. Unarmed threads behave exactly as today, except the one-time catch-up refresh of archived OPEN rows.
- No IPC changes. Optionally, show a red dot on the Sidebar PR chip when `prWatch.last.failing.length > 0` (about 10 lines in [src/components/Sidebar.tsx:1408-1418](src/components/Sidebar.tsx#L1408)). This is not required for the wake-up.

**Tests** (extend `electron/test/pr-refresh.test.js`; its `ghTryAsyncFn` injection and fake-gh harness already exist)
- Armed archived worker is polled with the rich fields.
- Pass → fail transition notifies once; the same failure on the next pass does not.
- `CHANGES_REQUESTED` and `CONFLICTING` notify.
- MERGED notifies, then cleans up; with `isRunning` true there is no cleanup.
- Unarmed thread never notifies.
- Lead archived → no notify.
- Unknown-field fallback keeps working.
- `orch-merge.test.js`: `thread_pr` arms `prWatch` with `notify = self.id`.

**Risks**
1. Notices stay in the in-memory `orchNotices` Map until item 2 lands. Because `prWatch.last` is persisted after delivery, a crash between enqueue and flush loses that one wake-up but never duplicates it. A transition that happens while the app is down is still detected on the first pass after boot.
2. Plain UI PRs are deliberately not armed. Waking an agent on a user's own thread to fix CI starts a machine turn nobody asked for. Add an explicit per-thread "Watch PR" toggle when someone wants it.
3. Each armed PR adds one heavier `gh` call per 5 minutes. With 35 worker PRs over seven weeks, the load is negligible.
4. `statusCheckRollup` mixes CheckRun (`conclusion`) and StatusContext (`state`) shapes. Hence the `conclusion || state || status` fallback through the existing normalizer.

**Revised size:** S–M, about 150–220 lines plus about 150 test lines. It depends softly on item 2 (durable notices) and not on item 3.

### Gaps
- I could not check whether the 34 "OPEN" archived worker PRs are actually merged on GitHub. No network or gh calls were made, by constraint.
- The `statusCheckRollup` JSON shape was not verified against the local gh version.
- Issue #363 (PR-status sidebar icon) was not found in the local repo or docs. Its intended scope is unknown.

## Item 8 — Native same-provider forks, recorded `handoff`, paged `thread_read`

### Takeaway
No fork path preserves a provider session today. Every fork sets `sessionId: null` and gets a 12-message / 12,000-character tail digest prepended to its first CLI prompt.

Both providers that matter can fork natively:
- Claude Code 2.1.283 has `--resume <id> --fork-session`.
- Codex app-server 0.159.2 has `thread/fork {threadId, cwd, lastTurnId, …}`.

The plain fork must stay a digest, because `/compact` and the context ring rely on it meaning "fresh context". Native fork is therefore a new opt-in entry, recorded in a `handoff` field.

`thread_read` is a small, separate win. Native fork applies to few forks: 54 of 564 historical plain forks were same-provider Claude or Codex. **Revised size: M, splittable as 8a (`handoff` + `thread_read`, S) and 8b (native fork, S–M).**

### Cited Findings
**Fork creation**
- `forkThread(store, {threadId, provider?, model?, worktree?, title?})` creates the thread ([electron/services.js:1286-1382](electron/services.js#L1286)). It then patches `{provider, model, permissionMode, handoffFrom: source.id, sessionId: null}` (1336-1344). It sets `pendingWorktree` only for `worktree === true` (1366-1378).
- `forkWorkerThread` adds `orchWorker`, `poolAlias`, `pendingWorktree` and the lead snapshot ([electron/services.js:1403-1466](electron/services.js#L1403)).

**The digest**
- `buildHandoffPrefix` returns `""` when the thread already has a `sessionId` ([electron/services.js:1209-1213](electron/services.js#L1209)).
- It digests `handoffFrom`, or the thread itself under `replayContext` (1214-1220), wrapped as `[Hand-off context …] … [End context]`. Caps: 2,000 characters per message, 12 messages, 12,000 total ([electron/services.js:960-963](electron/services.js#L960)).
- It is computed in `startRun` before the user row is appended ([electron/runner.js:8434-8446](electron/runner.js#L8434)). It is prepended to the CLI prompt only ([electron/runner.js:8600-8603](electron/runner.js#L8600)) and never stored.
- Workers get it too: the INSTRUCTIONS say "only a truncated digest" ([electron/orchServer.js:69-72](electron/orchServer.js#L69)).

**User-fork entry points**
- `threads:fork` IPC ([electron/ipc.js:695-699](electron/ipc.js#L695)) ← `useCoder.forkThread`, which forwards provider, model and worktree ([src/useCoder.ts:1708-1749](src/useCoder.ts#L1708)).
- Callers:
  - `handleRowFork` / `handleForkOpen` ([src/App.tsx:1042-1055](src/App.tsx#L1042));
  - Sidebar `fork` / `handoff:<provider>`;
  - the AgentsPanel ForkCard;
  - `/fork`, `/compact` and the context-ring button via `handleForkFresh`, which is disabled while working ([src/components/ThreadView.tsx:5426-5429](src/components/ThreadView.tsx#L5426));
  - `@provider` delegation and Best-of-N.

**The `/compact` constraint**
- The context-recovery spec says `forkThread` "creates a same-provider thread with a fresh CLI session" plus a bounded digest. It also says `/compact` "invokes the same plain `onFork()` callback used by `/fork`" ([docs/superpowers/specs/2026-08-25-context-recovery-design.md:17-21](docs/superpowers/specs/2026-08-25-context-recovery-design.md#L17), 80-87).

**Sessions**
- `thread.sessionId` is passed straight to Claude `buildArgs` ([electron/runner.js:4165-4172](electron/runner.js#L4165)), which emits `--resume <id>` ([electron/providers.js:327-328](electron/providers.js#L327)).
- `sessionIdForResume` gates resume on ejected threads and a pinned model ([electron/providers.js:1612-1627](electron/providers.js#L1612)).
- Store `updateThread` drops `sessionId` when `worktreePath` changes, unless the same patch sets `sessionId` ([electron/store.js:3747-3757](electron/store.js#L3747)). The comment: "CLI sessions are per-cwd … --resume then dies with … No conversation found".
- Claude Code 2.1.219+ falls back to listing the cwd's git worktrees to find a session `.jsonl` ([electron/cli-sessions.js:30-37](electron/cli-sessions.js#L30)).

**Codex**
- The app-server path calls `thread/resume` (with `thread/read` and parent fallbacks) when `sessionId` is set, and `thread/start` otherwise ([electron/codex-appserver.js:485-552](electron/codex-appserver.js#L485)). Nothing calls `thread/fork`.
- The local CLI schema (`v2/ThreadForkParams.json`, codex-cli 0.159.2):
  - requires `threadId`;
  - accepts `cwd`, `model`, `excludeTurns` and `lastTurnId` ("Optional last turn id to fork through, inclusive. … turns after `last_turn_id` are omitted from the fork").

**Claude**
- `claude --help` (2.1.283) lists `--fork-session`: "When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)". No message-level resume flag appears in the help output.

**Issue #158**
- No reference in `docs/` or `git log`. The `--grep=158` hits are unrelated SHAs.
- No "fork from here" action exists on messages. `MessageBlock` offers edit/resubmit (rewind), reply, cite and pin.

**Reading history**
- `store.getMessages(id)` returns the full array with no paging ([electron/store.js:2856-2859](electron/store.js#L2856)).
- `thread_status` returns only the first line of the last reply, and checks the project only when one is claimed ([electron/orchServer.js:779-827](electron/orchServer.js#L779), the guard at 784-785).
- Pairing has no transcript read.

**Types**
- `ThreadInfo.handoffFrom` doc is stale: it says "last assistant message", but the digest is a 12-message tail ([src/shared/ipc.ts:554-561](src/shared/ipc.ts#L554)).
- No `handoff` field exists.

**Live store**
- 564 plain forks: 533 same-provider, of which 54 are Claude or Codex. 15 plain forks hold a `worktreePath`.

### Inferences
**Design**

**8a. `handoff` record and `thread_read` (S)**
- **Field:**
  ```ts
  handoff?: { strategy: "digest" | "native"; sourceThreadId: string; sourceSessionId?: string;
              chars?: number; fallback?: string }
  ```
  `forkThread` writes `{strategy:"digest", sourceThreadId}` in its patch (1336-1344). `startRun` records `chars: prefix.length` when the prefix is non-empty, in the same block as [electron/runner.js:8437-8446](electron/runner.js#L8437). This makes handoffs "recorded artifacts".
- **Renderer:** the "Forked from" banner ([src/components/ThreadView.tsx:6814-6819](src/components/ThreadView.tsx#L6814)) can append "· recent history (N chars)" or "· full session". Fix the `handoffFrom` doc.
- **`thread_read` MCP tool** (orchServer.js, about 60 lines):
  - Input: `{threadId, projectId, before?: int, limit?: 1..50 = 20}`.
  - Output: `{total, messages:[{index,id,role,createdAt,text,truncated,fromThread?}], nextBefore}`.
  - Returns user and assistant rows only. Tool and event rows are excluded so tool output and secrets are not echoed. `text` is clipped at 4,000 characters.
  - Guard with `requireOwnThread` ([electron/orchServer.js:357-364](electron/orchServer.js#L357)). `projectId` is required; unlike `thread_status`, the guard is not optional.
  - Paging is index-based over `getMessages()`. The store caps retention at 1,000 messages, so index paging is stable enough. Note the oldest rows can be dropped between pages.
- **Digest pointer:** add one footer line in `buildHandoffPrefix`: `Older history: thread_read threadId=<source> before=<firstDigestedIndex>`. Update INSTRUCTIONS [electron/orchServer.js:69-72](electron/orchServer.js#L69).

**8b. Native fork (S–M)**
1. **providers.js:** add `supportsNativeFork: true` on claude (around 246) and codex (around 347). Extend Claude `buildArgs` to `({ sessionId, forkFromSessionId, … })`: `if (!sessionId && forkFromSessionId) args.push("--resume", forkFromSessionId, "--fork-session")`.
2. **forkThread:** new input `native?: boolean`. Native applies only when all of these hold:
   - `native === true`;
   - same provider;
   - the provider has `supportsNativeFork`;
   - `source.sessionId` is set;
   - the source is not live (the IPC handler checks `runner.isRunning(source.id)`);
   - `!worktree`.
   
   It then patches `handoff:{strategy:"native", sourceThreadId, sourceSessionId: source.sessionId}`, and `sessionId` stays null. Otherwise it is silently a digest fork, with `handoff.fallback` saying why.
3. **No digest:** `buildHandoffPrefix` returns `""` when `thread.handoff?.strategy === "native" && !thread.sessionId`.
4. **Claude run:** at [electron/runner.js:4165-4172](electron/runner.js#L4165), pass `forkFromSessionId` when the thread has no `sessionId` and a native handoff. The `result` event's `session_id` becomes the fork's own `sessionId` through the existing capture ([electron/runner.js:4606-4611](electron/runner.js#L4606)).
5. **Codex run:** pass `forkFrom` into `runCodexAppServerTurn`. In the `else` at [electron/codex-appserver.js:549-551](electron/codex-appserver.js#L549), `thread = (await client.send("thread/fork", { threadId: forkFrom, excludeTurns: true, ...tparams })).thread`. `tparams` carries the fork's `cwd`.
6. **Failure fallback:** if a native-start run fails before any output (e.g. "No conversation found"), set `handoff = {...handoff, strategy:"digest", fallback: reason}`. The next Retry uses the digest. One flip, no loop.
7. **UI:** add opt-in entries only:
   - Sidebar menu "Fork with full session" next to `fork` ([src/components/Sidebar.tsx:1002-1004](src/components/Sidebar.tsx#L1002));
   - AgentsPanel ForkCard;
   - `useCoder.forkThread` forwards `native`.
   
   `/fork`, `/compact`, the ring, `@provider`, Best-of-N and all worker forks stay digest. Native fork must never back `/compact`, because it would carry the full context.
8. **Reconciling #158** ("fork from a specific message, preserving provider session"):
   - 8b delivers the "preserving provider session" half for whole-session forks.
   - "From a specific message" is natively possible only on Codex (`lastTurnId`). That needs Solenta messages to record the Codex turn id, which I found no evidence they do.
   - Claude 2.1.283 exposes no message-level fork flag, so Claude fork-from-message stays rewind-plus-digest.
   - Record this split on #158 rather than closing it.

**Back-compat**
- `handoff` is optional. Old forks have no record and keep working via `handoffFrom`.
- `native` defaults to false.
- The store's sessionId-drop rule is untouched, because native forks read `handoff.sourceSessionId`, not `sessionId`.

**Tests**
- `electron/test/fork-handoff.test.js`:
  - native fork sets `handoff`, keeps `sessionId:null`, and `buildHandoffPrefix` is `""`;
  - each gate falls back to digest with a `fallback` reason;
  - `chars` is recorded.
- Provider args test: Claude `buildArgs` emits `--resume S --fork-session` only when `sessionId` is absent.
- `electron/test/codex-appserver.test.js`: a fake client receives `thread/fork` with `threadId` and `cwd`.
- `orch-server.test.js`: `thread_read` paging, role filter, clipping, and cross-project rejection.

**Risks**
1. Cross-cwd Claude resume relies on the CLI's worktree fallback ([electron/cli-sessions.js:30-37](electron/cli-sessions.js#L30)). This is the reason to gate `!worktree` at first.
2. Forking a Codex session another Solenta child holds may hit writer-lock rules (#1265). Gating on an idle source mitigates it.
3. A native fork inherits a near-full context, so it may compact at once. That is the user's explicit choice.
4. Grok, the dominant provider, gets nothing. No fork flag is known for its CLI.
5. `thread_read` widens agent read access within a project. It is project-scoped like every other tool and does not return tool output.

**Revised size:** M overall. 8a is about 120 lines plus tests; 8b is about 150–200 lines plus tests. Item 8 is still the lowest-priority item.

### Gaps
- Not verified live: whether `claude --resume <id> --fork-session` from the project checkout finds a session recorded under a sibling worktree's cwd.
- Not verified: whether Codex `thread/fork` on an idle rollout interacts with `codexWriterLock`.
- Whether Solenta stores Codex turn ids per message, which #158's message-level fork needs, was not established.
- I could not see issue #158's GitHub text. There is no local copy, and network was out of scope.

## Item 9 — Idempotency receipts on `thread_fork` / `thread_send`

### Takeaway
**No-go.** Across 493 orchWorkers under 247 leads, there are zero sibling pairs with an identical first prompt created within 5 seconds. Only one pair exists at any gap: 60 seconds apart, and it was a deliberate re-fork after the first worker died on a corrupt Grok config. 564 plain forks have zero such pairs, and 427 attributed inbound `thread_send` rows have zero repeats from the same sender within 60 seconds. Receipts would be speculative machinery.

Two adjacent signals belong to other items:
- duplicate wake *notices*, which is item 2's worker+run dedupe key;
- a theoretical double-fork window on orchestrator threads, which is item 6.

### Cited Findings
**Scan method**
- Copied `coder-store.json` (5.9 MB) and APFS-cloned its `messages/` shards (2,041 files, 776 MB on disk) to `/tmp/solenta-scan/`.
- Analysed with node scripts (`scan.js`, `notices.js`, `surplus.js`, `sends.js`, kept in that directory). Never wrote to the live files.
- The copied store and shards were deleted after analysis because they contain transcript data. Re-running the scripts needs a fresh copy.

**Store profile**
- 2,041 threads created between 2026-08-13T18:23Z and 2026-10-04T09:45Z.
- 493 `orchWorker` threads under 247 leads; 1,057 threads with `handoffFrom`, of which 564 are plain forks.

**Sibling orchWorkers by creation gap**
- ≤5 s: 17 adjacent pairs (8 leads). ≤60 s: 117 pairs (69 leads).
- With an identical first user message: **0 within 5 s, 1 within 60 s, 0 at any larger gap**. All 493 worker shards were present.
- Same-title pairs are common (21 within 5 s, 118 within 60 s). Titles are not a duplicate signal, because forks reuse the lead's title ("Fork: …").

**The one pair**
- Lead `0bbcb611…` forked `9855853b…` at 15:53:53Z on 2026-08-23. The worker failed with "grok's config is corrupt".
- The lead repaired `~/.grok/config.toml`, said "Re-forking 7/7 with the same prompt", and forked `37211886…` at 15:54:53Z. This is from the lead transcript in the copied shard.
- This was an intended retry, not a transport duplicate.

**Plain forks and sends**
- Plain forks: 0 identical-first-prompt sibling pairs at any gap.
- `thread_send`: 427 inbound user rows carrying `fromThread` (excluding `fromNotice`), with 0 consecutive identical texts from the same sender within 60 s.

**Adjacent finding (notices)**
- 773 "Worker thread … finished with status …" lines appear in lead transcripts.
- 8 of 450 notified workers have more such lines than they had runs, 9 surplus in total. This is an upper bound, because "Not delivered: …" events echo the notice text ([electron/runner.js:1414](electron/runner.js#L1414)).
- Repeats in one batched prompt are mostly legitimate. Worker `9855853b` failed on 3 separate runs, and the lead received the batched lines at 15:55:04Z.

**Theoretical duplicate source**
- In the orchestrator `pendingFork` branch, `startRun` awaits `startWithPoolFailover` before the lead has any `active` entry ([electron/runner.js:8318-8361](electron/runner.js#L8318)). A second send during that await would fork again.
- The scan found no manifestation: 0 identical pairs within 5 s.

### Inferences
- `thread_fork` and `thread_send` are called from a single agent turn, synchronously over a stateless loopback MCP POST. Retries come from the agent deciding to retry, and those retries are intended. That is what the one pair shows.
- V2's `clientRequestId` guards a multi-client, reconnecting transport that Solenta does not have.
- **Decision: do not build receipts.** Revisit if:
  - (a) external pairing clients start calling a fork-like launch over flaky networks. `task_launch` is the analogue to watch;
  - (b) item 1's transport binding introduces client retries.
- Route the real signals elsewhere:
  - the notice dedupe key (worker id + runId) to item 2;
  - the `pendingFork` window to item 6, which closes it by marking the lead `preparing` or holding its lock during the fork hop.
- **Revised size: 0** (not built). The scan itself is the deliverable.

### Gaps
- Workers purged by `MAX_WORKERS_PER_ORCHESTRATOR` (20 per lead, [electron/runner.js:218](electron/runner.js#L218)) and deleted threads are absent from the store, so the counts are lower bounds. A purged duplicate would have been finished and worktree-less, which is a narrow class.
- Before #551, `thread_send` outputs carry no outcome (254 of 274), so I could not measure queued-versus-delivered history.
