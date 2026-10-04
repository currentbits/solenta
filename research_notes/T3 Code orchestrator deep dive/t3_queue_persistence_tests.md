# T3 Code Orchestrator V2: queue, persistence schema, restart recovery, status derivation, and replay test harness (source-level)

Snapshot: `pingdotgg/t3code` **main at `eac52f0087d9ba5dee5542f24788d1482affae43`**. The commit is dated 2026-10-04 01:37 PDT ("fix(client-runtime): closing a busy stream no longer drops the connection (#15563)"). It was fetched with `git fetch origin main` on 2026-10-04 and is identical to the SHA used in the first-round architecture notes.

How to read the citations:
- Every `file:line` below is on **main** at that SHA unless it is labelled **(open PR, not on main)** or **(issue)**.
- Link base: `https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/`.
- Open PRs were listed with `gh pr list --state open --search "created:>=2026-10-02"`, which returned 380 open PRs. Only the relevant ones are cited.

## 1. Server-side message queue: data model, steer vs queue, edit/reorder/delete, Cmd/Ctrl+Enter, persistence, draining, Limited, scheduled tasks

### Takeaway
There is **no separate queue table**. A queued message is an ordinary `Run` row with `status: "queued"`, plus two optional fields: `queuePosition` and `queueHeld`. The full user message is committed when the run is queued, as are its root node, its attempt, and its provider thread.
- **Steer vs queue** is decided under the per-thread lock from provider capabilities (`resolveMessageDispatchIntent`).
- **Edit, reorder, cancel, promote-to-steer, and resume** are ordinary idempotent commands that emit full-entity `run.updated` / `message.updated` events.
- **Draining** happens in one place, `startNextQueuedRun`, which runs whenever a run reaches a terminal state. It does nothing while any queued run is `queueHeld`, while the thread is usage-limited, or while a blocking run exists.
- **Hold triggers.** Three things set `queueHeld: true`:
  - Restart recovery, which is the "explicit consent" gate.
  - A user Stop, because the client always sends `holdQueue: true`.
  - A non-validation provider failure on the same provider.
- `queue.resume` is the only way to release a held queue.

### Cited Findings

**Data model (contracts)**
- `OrchestrationV2Run` carries the queue state inline. Excerpt: `status: OrchestrationV2RunStatus, queuePosition: Schema.optional(Schema.NullOr(PositiveInt)), /** Restart recovery holds the queue until the user explicitly resumes it. */ queueHeld: Schema.optional(Schema.Boolean)`. Other fields are `restartContinuationOfRunId` and `workStartedAt` — [contracts/orchestrationV2.ts:534-562](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L534)
- Run status literal set: `preparing, queued, starting, running, waiting, completed, interrupted, failed, cancelled, rolled_back` — [contracts/orchestrationV2.ts:446-457](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L446)
- The user-message intent records how the message was delivered: `"turn_start" | "queued_turn" | "steer" | "promoted_queued_to_steer"` — [contracts/orchestrationV2.ts:1246-1251](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L1246)
- `message.dispatch` fields:
  - `dispatchMode` is a union of `defer_start{workspaceStrategy?} | steer_active{targetRunId} | restart_active{targetRunId} | queue_after_active | start_immediately`.
  - Optional fields: `deliveryIntent: "auto"|"steer"|"restart"` ("Resolve untargeted delivery against the server's serialized thread state"), `restartContinuationOfRunId`, `usageLimitContinuationOfRunId`, `manualContinuationOfRunId`, `scheduledTaskId`, `notification`, and `delegatedCompletion{parentRunId, generation, taskIds}`.
  - Source: [contracts/orchestrationV2.ts:2696-2735](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L2696)
- Queue commands: `run.interrupt{runId, reason?, holdQueue?}`, `queued-message.promote-to-steer{queuedRunId, targetRunId}`, `queue.resume{threadId}`, `queued-run.reorder{runId, beforeRunId|null}`, `queued-run.cancel{runId}`, and `queued-run.edit{runId, text, attachments?, context?}`. The edit comment reads: "Full replacement list. Absent = leave the message's attachments as-is" — [contracts/orchestrationV2.ts:2770-2815](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L2770)
- The capability flag `turns.supportsQueuedMessages` sits beside `supportsActiveSteering` and `supportsSteeringByInterruptRestart` — [contracts/orchestrationV2.ts:215](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L215)

**Steer-vs-queue decision (server)**
- `resolveMessageDispatchIntent` runs under the thread lock ("Resolve client intent from the state serialized by the thread dispatch lock"). Excerpt:
  ```ts
  if (deliveryIntent === undefined) return requestedMode;
  const activeRun = projection.runs.findLast(r => r.status in preparing|starting|running|waiting);
  if (activeRun === undefined) return { type: "start_immediately" };
  if (deliveryIntent === "steer") return { type: "steer_active", targetRunId: activeRun.id };
  if (deliveryIntent === "restart") return { type: "restart_active", targetRunId: activeRun.id };
  if (activeRun.status === "preparing" || activeRun.status === "starting") return { type: "queue_after_active" };
  if (caps?.supportsActiveSteering) return steer_active;
  if (caps?.supportsQueuedMessages) return queue_after_active;
  if (caps?.supportsSteeringByInterruptRestart) return restart_active;
  return { type: "queue_after_active" };
  ```
  Source: [CommandPolicy.ts:119-163](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/CommandPolicy.ts#L119)
- **Late steer.** If the steer target already completed, or its provider turn completed while the run is still projecting, the message becomes `start_immediately` instead. The comment: "The client may still show a running turn while its completion is being projected. Preserve the submission as a new turn when steering is too late" — [Orchestrator.ts:4487-4511](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L4487)
- **Implicit queueing.** `shouldQueue = activeRun !== undefined && (defer_start || start_immediately || queue_after_active)`. A plain "start" while anything is blocking therefore becomes a queued run. `isBlockingRun` includes `waiting`, the post-terminal background drain — [Orchestrator.ts:4688-4694](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L4688); [Orchestrator.ts:455-462](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L455)
- **Queued-run creation.**
  - `status: "queued"`.
  - `queuePosition = max(existing queued positions, or ordinal) + 1`.
  - The new run inherits `queueHeld: true` if any queued run is already held, so a message sent into a held queue does not jump it.
  - Root node, attempt, and provider thread ids are allocated up front ("execution identity").
  - Source: [Orchestrator.ts:4792-4822](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L4792)
- **Delivery order.** Automatic delegated-completion deliveries always sort first, then by `queuePosition ?? ordinal`, then by `ordinal` (`queuedRunsInDeliveryOrder`) — [QueuedRunOrder.ts:12-31](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/QueuedRunOrder.ts#L12)
- `ThreadManagementService.sendToThread` maps `mode` for MCP, agents, and scheduled tasks:
  - `steer`/`restart` require a steerable run, or the call fails with `ThreadManagementNoSteerableRunError`.
  - `auto` steers a steerable run.
  - Otherwise `queue → queue_after_active` and anything else → `start_immediately`, which still queues behind a blocking run.
  - Source: [ThreadManagementService.ts:524-555](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ThreadManagementService.ts#L524)

**Edit / reorder / delete / promote (server)**
- `queued-run.edit`:
  - Rejects empty text, a run that is not `queued`, and automatic deliveries ("Automatic completion deliveries cannot be edited.").
  - Emits a full `message.updated` with the new text, attachments, and context, plus a `turn-item.updated` for the matching `user_message` item.
  - Source: [Orchestrator.ts:7397-7480](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L7397)
  - A rejected edit is surfaced as `OrchestratorCommandRejectedError` after a rejected receipt is committed, so a retry fails the same way — [Orchestrator.ts:9758-9785](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9758)
- `queued-run.reorder`:
  - Takes the queued runs in delivery order, removes the moving one, and inserts it before `beforeRunId` (or at the end when it is `null`).
  - Automatic runs are pinned first: "Queued messages cannot be reordered ahead of automatic completion delivery."
  - It then renumbers `queuePosition = index + 1` and emits `run.updated` only for rows whose position changed.
  - Source: [Orchestrator.ts:7212-7300](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L7212)
- `queued-run.cancel` sets the run (and its attempt and node) to `cancelled` with `queuePosition: null` — [Orchestrator.ts:7303-7395](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L7303)
- `queued-message.promote-to-steer`:
  - Cancels the queued run, its attempt, and its root node.
  - Calls `dispatchSteerIntoRun` with the queued message's id, text, attachments, context, `createdBy`, `scheduledTaskId`, and `senderThreadId`, so the message keeps its identity.
  - Rejects automatic deliveries.
  - Source: [Orchestrator.ts:7072-7210](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L7072)

**Draining rules (server)**
- **Single drain point.** `startNextQueuedRun(threadId, {failedRunId?})` proceeds only when all of these hold:
  - A cheap SQL precheck `canStartQueuedRun` passes.
  - The thread is not archived or deleted.
  - There is no blocking run.
  - There is no held queued run.
  - The thread is not usage-limited.
  - Source: [Orchestrator.ts:1205-1232](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L1205)
- Usage-limit excerpt: "The limit already stopped this thread. Starting the queue would send every waiting message and drop it from the queue as each one fails." (`if (usageLimitBlockedRun(...) !== null) return;`) — [Orchestrator.ts:1219-1230](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L1219)
- Hold on provider failure, excerpt: "A provider that just failed will likely fail the next message too. Hold the queue so the user decides when to resume it. Validation failures (setup, unsupported handoff) belong to that message alone, and a message queued for another provider is how users recover." The code then writes `queueHeld: true` on every queued run — [Orchestrator.ts:1236-1263](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L1236)
- If starting the queued run throws, `failQueuedRunStart` fails that run, its attempt, and its node, and adds an error turn item "Queued provider could not start" (`code: queued_start_failed | context_handoff_unsupported`) — [Orchestrator.ts:1100-1203](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L1100)
- SQL precheck: `canStartQueuedRun` requires an unarchived, undeleted thread with a `queued` run, and `NOT EXISTS` any run in `preparing|starting|running|waiting` or a queued run with `json_extract(payload_json,'$.queueHeld') = 1` — [ProjectionStore.ts:4474-4491](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProjectionStore.ts#L4474)
- **Trigger.** An event-stream subscriber on `run.updated` terminal statuses calls `startNextQueuedRun` under the thread lock. It starts from the current high-water mark and **filters out reconciliation commits**: `!String(stored.commandId).startsWith("command:runtime-reconcile:")`. Recovery's cancellations therefore never drain the queue — [Orchestrator.ts:9865-9925](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9865)
- `queue.resume`:
  - Rejects while limited: "Continue the limited thread before resuming its queue."
  - Clears `queueHeld` on every queued run. With nothing queued, it emits a no-op `thread.metadata-updated` so the command still produces an event and a receipt.
  - After the receipt commits it calls `startNextQueuedRun`, including on a duplicate-receipt replay.
  - Source: [Orchestrator.ts:9572-9627](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9572); [Orchestrator.ts:9729-9731](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9729); [Orchestrator.ts:9847-9849](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9847)
- `run.interrupt` with `holdQueue: true` marks every unheld queued run `queueHeld: true` in the same command (`holdQueuedRuns`, applied at three interrupt paths). The web/mobile client **always** sends `holdQueue: true` on Stop — [Orchestrator.ts:8068-8082, 8215, 8311, 8368](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L8068); [client-runtime operations/commands.ts:803-809](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/operations/commands.ts#L803)
- `resumeQueuedRuns` drains every thread that has a queued run and no active run. At this SHA its only callers are **tests** (`runtimeLayer.test.ts`, `SteeringCompletion.integration.test.ts`); startup does not call it, which matches the consent rule — [Orchestrator.ts:1811-1835](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L1811)

**Cmd/Ctrl+Enter inversion (client)**
- The setting `followUpBehavior: "queue" | "steer"` defaults to `"queue"` — [contracts/settings.ts:453-455](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/settings.ts#L453)
- The shared resolver serves web (Mod+Enter or Ctrl/⌘-click) and mobile (long-press):
  ```ts
  export function resolveComposerDispatchMode(input) {
    if (!input.running) return "auto";
    const defaultAction = input.activeTurnDefault ?? "steer";
    if (input.alternateModifier) return defaultAction === "queue" ? "steer" : "queue";
    return defaultAction;
  }
  ```
  Source: [client-runtime state/composerDispatch.ts:1-32](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/composerDispatch.ts#L1)
- Web wiring:
  - The send button uses `alternateModifier: event.metaKey || event.ctrlKey`.
  - The keyboard path uses `submissionIntent === "alternate"`.
  - The tooltip reads "Click to {default}, Ctrl/⌘-click … to {alternate}".
  - Source: [ChatComposer.tsx:4176-4188, 4371-4381](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ChatComposer.tsx#L4176); [ComposerPrimaryActions.tsx:279](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ComposerPrimaryActions.tsx#L279)
- Client to server: when the server resolves command context, the client sends `queue → dispatchMode queue_after_active`, and anything else as `start_immediately` plus `deliveryIntent: requestedMode`, so the server decides under its lock. The legacy fallback mirrors the server capability ladder on the client — [client-runtime operations/commands.ts:711-772](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/operations/commands.ts#L711)

**Held queue in the UI**
- `threadWorkflows` exposes:
  - `queuedRuns` (sorted by `queuePosition ?? ordinal`, carrying message text, attachments, and context)
  - `isHeld`
  - `canReorder` (`supportsQueuedMessages`)
  - `canPromoteToSteer` (a steerable running provider turn plus steering or restart support)
  - Source: [client-runtime state/threadWorkflows.ts:130-165](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/threadWorkflows.ts#L130)
- The ChatView "Resume" button has one control for two cases:
  - With nothing to continue, it sends only `queue.resume`.
  - With an interrupted or usage-limited latest run, it first starts a `manualContinuationOfRunId` turn ("Continue where you left off."), then sends `queue.resume` if the queue is held.
  - `canResume={resumableRunId !== null || hasHeldQueuedRuns}`.
  - Source: [ChatView.tsx:2078-2091](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/ChatView.tsx#L2078); [ChatView.tsx:8242-8295](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/ChatView.tsx#L8242); [ChatView.tsx:11168](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/ChatView.tsx#L11168)

**Usage-limit ("Limited") interaction**
- `usageLimitBlockedRun`: the latest *executed* run is `failed` and its root failure classifies as `usage_limit`. "Queued messages after that run must stay queued instead of being sent into the same limit." `latestUnheldRun` keeps held queued runs from standing in for the thread's outcome — [shared/orchestrationV2ThreadError.ts:80-130](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/shared/src/orchestrationV2ThreadError.ts#L80)
- `UsageLimitRecoveryWorker`, "The shared scheduler derives due work from persisted failures and recovery choices, so restarts need no timer restoration or connected client":
  - A 5-second scheduler sweep issues deterministic commands:
    - `thread.metadata.update` with `commandId: limit-arm:${thread}:${run}:${resetMs}`, which arms recovery.
    - After the reset (unless snoozed), `message.dispatch` with `commandId/messageId: limit-resume:${identity}:${requestId}`, `usageLimitContinuationOfRunId`, `text: "Continue where you left off."`, and `dispatchMode: start_immediately`.
  - Receipts make the sweep idempotent. Once the continuation run ends, the terminal listener drains the queue.
  - Source: [UsageLimitRecoveryWorker.ts:10-115](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts#L10)
- **(open PR, not on main)** #15553 "feat(clients): show scheduled usage-limit recovery in thread lists", and #15176 "a thread snoozed until a limit reset stays snoozed until the reset" — [PR list](https://github.com/pingdotgg/t3code/pulls?q=is%3Apr+is%3Aopen+15553)

**Scheduled tasks**
- `scheduled_tasks` table: `task_id, title, prompt, enabled, schedule_json, project_id, thread_id, workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode, created_by, creation_source, created_at, updated_at, next_run_at, last_run_at, last_run_status, last_run_error, run_count`, with partial index `idx_scheduled_tasks_due ON (enabled, next_run_at) WHERE enabled = 1 AND next_run_at IS NOT NULL` — [Migrations/OrchestrationV2/ScheduledTasks.ts:8-42](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/persistence/Migrations/OrchestrationV2/ScheduledTasks.ts#L8)
- A run marks the row `running`. It then dispatches with a fire-keyed id (`commandId = scheduled-task:${taskId}:${startedAtMs}:${trigger}`) through either `threadLaunch.launch` (no bound thread) or `sendToThread({mode: "auto"})`. In auto mode the prompt **steers** a steerable active run and otherwise queues behind a blocking one — [ScheduledTaskService.ts:503-550](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/scheduledTasks/ScheduledTaskService.ts#L503)
- Missed fixed-time slots (server off or asleep) are **skipped and re-aimed**, not fired late. Rows stuck in `running` at boot become `failed` ("Run was interrupted by a server restart."), `next_run_at` advances, and `run_count + 1` counts the attempt "otherwise the first poll after every restart re-fires the interrupted task" — [ScheduledTaskService.ts:598-695](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/scheduledTasks/ScheduledTaskService.ts#L598)
- Scheduler: one 5-second tick, `withPermitsIfAvailable(1)` per source so a source never overlaps itself, and "Due work waits for startup recovery, which would cancel runs it started" (`forkParked`) — [scheduling/Scheduler.ts:52-60](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/scheduling/Scheduler.ts#L52)

### Inferences
- **Copyable model for Solenta.** Make a "queued wake-up / crew message" a pending turn record with `status=queued`, `position`, and `held`, stored where turns already live, not in a side queue. Add one drain function triggered by turn-terminal events (excluding events written by recovery), and one explicit `resume` action that clears `held`. This removes the need to reconcile a separate queue store against turn state.
- The **held flag is inherited by new arrivals**, so a held queue cannot be bypassed by appending. Automatic deliveries (delegated results) get priority ordering but cannot be edited, reordered, or promoted. That is a clean rule for Solenta's server-generated wake notices versus user-typed queued messages.
- Holding the queue on Stop by default (client sends `holdQueue: true`) is a UX decision worth copying: Stop means "pause everything", not "skip to the next message".

### Gaps
- No UI copy string for the held state (for example "Queue paused") was found by grep in `apps/web/src`. The held state appears to surface only as a "Resume" affordance (`canResume`). The exact rendering was not inspected.
- The mobile client's held-queue UI was not inspected.

## 2. SQLite schema: events, receipts, projections, outbox, queue, subagents/lineage; sizes, retention, compaction; V1→V2 copy-then-migrate

### Takeaway
Everything lives in one SQLite file, `statev2.sqlite`.
- **Events and receipts.** V2 events go into the **shared V1 `orchestration_events` table**, tagged `application_event_version = 2` and sharing one global `sequence`. Receipts go into the shared `orchestration_command_receipts`, with an added `command_type` column.
- **Projections.** Projection tables use a hybrid shape: a few indexed scalar columns plus the **full entity as `payload_json`**.
- **Queue.** The queue is just `orchestration_v2_projection_runs` rows with `status='queued'`. `queueHeld` and `queuePosition` live inside `payload_json` and are read with `json_extract`.
- **Lineage.** Subagents and lineage are a projection table plus `lineage`/`forkedFrom` JSON on the thread row and `context_transfers` rows.
- **Retention.** A paged compaction routine exists that keeps only the newest full-state event per entity, but no production call site was found at this SHA.
- **V1→V2.** The first V2 launch takes a SQLite **online backup** of `state.sqlite`, publishes it atomically as `statev2.sqlite` by hard link, and migrates only the copy.

### Cited Findings

**Tables (migration 055 plus composed sub-migrations, in order)**
- Migration 055 runs `Base` (the DDL below), then `Subagents`, `Foundation`, `ProviderSessionBindings`, `ThreadLaunchWorkflows`, `ApplicationEventSource`, `EffectCancellation`, `ScheduledTasks`, `LegacyV1ImportState`, `ApplicationEventSequenceIndexes`, `RecoveryIndexes`, and `ShellIndexes` — [055_OrchestrationV2.ts:320-331](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/persistence/Migrations/055_OrchestrationV2.ts#L320)
- Base tables:
  - `orchestration_v2_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id UNIQUE, command_id, thread_id, run_id, node_id, provider, raw_event_id, event_type, occurred_at, payload_json)`, indexed on command, thread, thread+type, run, node, and raw_event.
  - `orchestration_v2_command_receipts(command_id PK, thread_id, command_type, accepted_at, result_sequence, status, error)`.
  - `orchestration_v2_projection_threads(thread_id PK, project_id, title, default_provider, runtime_mode, interaction_mode, active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json)`.
  - `orchestration_v2_projection_runs(run_id PK, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)` with `UNIQUE(thread_id, ordinal)`.
  - `…_run_attempts` with `UNIQUE(run_id, attempt_ordinal)`.
  - `…_nodes(… parent_node_id, root_node_id, kind, status, provider_turn_id, runtime_request_id, checkpoint_scope_id …)`.
  - `…_provider_sessions`, `…_provider_threads`, `…_provider_turns`, `…_runtime_requests`, `…_messages`, `…_plans`, `…_turn_items`, `…_checkpoint_scopes`, `…_checkpoints`, `…_context_handoffs`, `…_context_transfers`.
  - Source: [055_OrchestrationV2.ts:22-318](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/persistence/Migrations/055_OrchestrationV2.ts#L22)
- Subagents and lineage: `orchestration_v2_projection_subagents(subagent_id PK, thread_id, run_id, parent_node_id, provider, provider_thread_id, child_thread_id, origin, status, started_at, completed_at, updated_at, payload_json)`, indexed on thread, parent_node, provider_thread, and child_thread — [Migrations/OrchestrationV2/Subagents.ts:8-28](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/persistence/Migrations/OrchestrationV2/Subagents.ts#L8)
- Foundation:
  - Adds `driver` and `provider_instance_id` columns across tables.
  - `orchestration_v2_effect_outbox(effect_id PK, command_id, thread_id, effect_type, payload_json, status CHECK IN ('pending','running','succeeded','failed'), attempt_count, available_at, lease_owner, lease_expires_at, created_at, updated_at, completed_at, last_error)`.
  - `orchestration_v2_turn_item_positions(thread_id, turn_item_id, ordinal, PK(thread_id, turn_item_id), UNIQUE(thread_id, ordinal))`.
  - `orchestration_v2_projection_metadata(projection_name PK, schema_version, last_sequence, updated_at)`.
  - Source: [Migrations/OrchestrationV2/Foundation.ts:16-179](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/persistence/Migrations/OrchestrationV2/Foundation.ts#L109)
- EffectCancellation rebuilds the outbox with `'cancelled'` in the status CHECK (create `_next`, copy, drop, rename) and adds index `(thread_id, status, effect_type)` — [Migrations/OrchestrationV2/EffectCancellation.ts:9-78](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/persistence/Migrations/OrchestrationV2/EffectCancellation.ts#L9)
- Other tables:
  - `orchestration_v2_projection_provider_session_bindings(provider_session_id, thread_id, PK both)`.
  - `orchestration_v2_thread_launch_workflows(command_id PK, thread_id, project_id, status, title, worktree_path, branch, setup_committed, thread_committed, message_committed, last_error, …)`: a step-commit record for multi-step launches.
  - `orchestration_v2_legacy_imports(thread_id PK, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count, last_error)`.
  - Source: [ProviderSessionBindings.ts:9-27](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/persistence/Migrations/OrchestrationV2/ProviderSessionBindings.ts#L9); [ThreadLaunchWorkflows.ts:8-22](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/persistence/Migrations/OrchestrationV2/ThreadLaunchWorkflows.ts#L8); [LegacyV1ImportState.ts:12-27](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/persistence/Migrations/OrchestrationV2/LegacyV1ImportState.ts#L12)
- **Shared event source.** `ApplicationEventSource`:
  - Runs `ALTER TABLE orchestration_events ADD COLUMN application_event_version INTEGER NOT NULL DEFAULT 1` and indexes `(application_event_version, sequence)`.
  - Adds `command_type` to `orchestration_command_receipts`.
  - Copies every `orchestration_v2_events` row into `orchestration_events` with `application_event_version=2` (metadata carries runId, nodeId, driver, providerInstanceId, rawEventId).
  - Re-baselines current project rows "so projection rebuilds preserve the exact pre-migration project state".
  - Copies V2 receipts into the shared receipts table with `result_sequence = MAX(sequence)` of the command's events.
  - Source: [Migrations/OrchestrationV2/ApplicationEventSource.ts:55-282](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/persistence/Migrations/OrchestrationV2/ApplicationEventSource.ts#L55)
- The shared V1 table shape is `orchestration_events(sequence PK AUTOINCREMENT, event_id UNIQUE, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)` with `UNIQUE(aggregate_kind, stream_id, stream_version)` — [001_OrchestrationEvents.ts:8-28](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/persistence/Migrations/001_OrchestrationEvents.ts#L8)
- Recovery partial indexes:
  - Runs `WHERE status IN ('queued','preparing','starting','running','waiting')`.
  - Requests `WHERE status='pending'`.
  - Turn items `WHERE type IN ('command_execution','dynamic_tool','subagent') AND status IN ('pending','running','waiting')`.
  - Source: [Migrations/OrchestrationV2/RecoveryIndexes.ts:5-30](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/persistence/Migrations/OrchestrationV2/RecoveryIndexes.ts#L5)
- No dedicated queue table exists. Queue reads are SQL over the runs table, for example `SELECT thread_id FROM orchestration_v2_projection_runs WHERE status = 'queued' AND NOT EXISTS (… active …)` and `json_extract(payload_json, '$.queueHeld') = 1` — [ProjectionStore.ts:3396-3405](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProjectionStore.ts#L3396); [ProjectionStore.ts:4479-4487](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProjectionStore.ts#L4479)

**Event sizes, retention, compaction**
- Events carry full entities, so a streaming message or node produces many full-state `message.updated` / `node.updated` rows. Compaction targets exactly these.
- `ProjectionMaintenanceV2.compactEventStore`:
  - Pages newest-first, 500 rows at a time.
  - Keeps only the newest `message.updated`/`node.updated` per `(type, thread, entity id)` and the newest of each supersedable `thread.*` state event per thread.
  - Deletes V1 events and receipts for threads whose legacy transcript import finished.
  - `turn-item.updated` "stays intact because replay assigns positions on first write", and `thread.created` is kept because verification derives the expected thread set from it.
  - Source: [ProjectionMaintenance.ts:205-330](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProjectionMaintenance.ts#L205)
- `verify` compares the `thread.created` set against the projection rows, checks `projection_metadata.schema_version` and `last_sequence` against the latest event sequence, and lists unreadable rows. The docstring says it "intentionally does not replay domain events through a second projector" — [ProjectionMaintenance.ts:69-110](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProjectionMaintenance.ts#L69)
- The maintenance layer is provided in `runtimeLayer.ts`, but grep found **no non-test call** of `compactEventStore`, `verify`, or `rebuild` at this SHA. Callers are `FoundationPersistence.test.ts`, `ProviderSwitch.integration.test.ts`, legacy cutover tests, and similar — [runtimeLayer.ts:31, 84](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/runtimeLayer.ts#L84)
- Raw provider frames are not stored in SQLite. They go to bounded rotating diagnostic logs (`providerEventLogPath`) — [docs/orchestration-v2/testing-strategy.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/testing-strategy.md)

**V1→V2 copy-then-migrate**
- The server DB path is now `join(stateDir, "statev2.sqlite")` — [config.ts:140](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/config.ts#L140)
- `initializeV2Database`, excerpt:
  ```ts
  if (yield* fs.exists(destinationPath)) return;   // seed once
  if (!(yield* fs.exists(sourcePath))) return;     // fresh install
  const temporaryDirectory = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".v2-import-" });
  const database = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
  await NodeSqlite.backup(database, snapshotPath);  // SQLite online backup
  // Publish only a complete snapshot, without replacing an existing V2 database.
  yield* fs.link(snapshotPath, destinationPath)      // AlreadyExists → ignore
  ```
  Source: [persistence/initializeV2Database.ts:18-53](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/persistence/initializeV2Database.ts#L18)
- From the internals doc on legacy migration:
  - "Only the copy receives v2 migrations; the original remains available to v1. Subsequent launches reuse the copy without refreshing it from v1."
  - Thread shells are created first. Transcripts are imported **lazily** on read or continue.
  - Provider sessions, checkpoints, tool calls, approvals, and plans are not translated.
  - The first continuation sends a transcript-suffix handoff within 32,000 chars.
  - Migration ids: "the migrator compares ids only… fork schema changes belong in a separate migration table".
  - Source: [docs/internals/legacy-orchestration-migration.md:1-59](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/internals/legacy-orchestration-migration.md)
- Server updates snapshot SQLite main, WAL, and SHM before trial migrations, so rollback needs no down-migrations: "This makes trial migrations reversible without down migrations." — [docs/internals/server-updates.md:33-43](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/internals/server-updates.md)
- **(open PR, not on main)** #15261 "recover Stable history missing after V2 migration"; #15074 "recover V1 stash and drafts after upgrading"; #15495 "a restart no longer resends imported history to a session that already has it" — [PR #15261](https://github.com/pingdotgg/t3code/pull/15261); [PR #15495](https://github.com/pingdotgg/t3code/pull/15495)

### Inferences
- For Solenta's mutable `coder-store.json`, **copy-then-migrate with an atomic publish** is cheap to adopt as is: write `store.v2.json` from a consistent snapshot, publish it with link or rename, and leave v1 untouched. It gives rollback and side-by-side builds for free. The "seed once, never refresh" rule avoids two-way sync.
- The hybrid "indexed columns + `payload_json` full entity" schema lets one table serve both SQL queue and recovery predicates and full-entity reads. If Solenta stays on JSON, the equivalent is keeping turn records whole but adding small derived indexes, such as a held/queued id list, rebuilt from them.
- Compaction is designed but apparently not scheduled. Event-log growth is therefore an open operational issue in T3 too, so Solenta should not assume retention is solved there.

### Gaps
- No size limits on a single `payload_json` were found (no CHECK constraint or code cap). No production retention schedule was found.
- Whether `orchestration_v2_events` and `orchestration_v2_command_receipts` are still written after the `ApplicationEventSource` fold-in: code reads and writes go through `appendAgentEvents`/`readAgentEvents` and `orchestration_command_receipts`, and the tables are not dropped. They look vestigial, but this was not exhaustively verified.

## 3. Recovery at boot: exact steps, ordering, what is terminalized, delegated results, how the UI learns

### Takeaway
Boot order is fixed in `runOrderedV2StartupPhases`:
1. Import V1 shells.
2. Run **`ProviderRuntimeRecoveryService.recover`** (`reconcile("startup")`).
3. Run **`orchestrator.recoverDelegatedTasks`**.
4. Start the **effect worker**.
5. Auto-bootstrap.

Schedulers and continuation effects are "parked" until activation, and client commands wait on a command gate.

Recovery runs per thread, and **each thread's changes commit as one command** (`command:runtime-reconcile:startup:<thread>:<iso>`):
- In-flight runs, attempts, nodes, provider turns, subagents, and open turn items → **`cancelled`**. Nothing becomes "failed" or "interrupted".
- Streaming messages → `streaming:false`.
- Pending process-bound approvals → `expired` + `not_resumable`.
- **Queued runs → `queueHeld: true`**, with identity and order preserved.
- Provider threads → `idle`, with background rosters cleared.
- Sessions → `stopped`.
- Lost background work is recorded on the run as `restartCancelledBackgroundWork` for the next turn's prompt.
- Process-bound outbox effects are cancelled, and replay-safe running effects are requeued.
- A durable `provider-runtime.continue` effect is enqueued only if the opt-in "continue threads after restart" setting is on.

The UI learns through the same event stream as any change, since every change is an ordinary committed event.

### Cited Findings

**Ordering**
- Excerpt:
  ```ts
  yield* input.importLegacyShells;
  const recovery = yield* input.recover;
  yield* input.recoverDelegatedTasks;   // "Settles delegated tasks whose runs recovery just terminalized."
  yield* input.startEffectWorker;
  const bootstrap = yield* input.autoBootstrap;
  ```
  Source: [serverRuntimeStartup.ts:383-413](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/serverRuntimeStartup.ts#L383); wired at [serverRuntimeStartup.ts:507-539](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/serverRuntimeStartup.ts#L507)
- Shutdown finalizer, in order:
  1. Fail the command gate.
  2. Interrupt the effect-worker fiber.
  3. `prepareForShutdown` (capture continuation intent), then `providerSessions.shutdown`.
  4. `reconcile("shutdown")`.
  - Source: [serverRuntimeStartup.ts:433-465](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/serverRuntimeStartup.ts#L433)
- Command gate: `makeCommandGate` holds client commands until startup completes (`awaitCommandReady`) — [serverRuntimeStartup.ts:102-140](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/serverRuntimeStartup.ts#L102)
- Docs: "Graceful shutdown captures intent before closing providers, then reconciles after ingestion has stopped so a late completion cannot be overwritten by a stale cancellation… Schedulers wait for activation so they cannot start runs that reconciliation would then cancel." — [docs/internals/server-updates.md:59-88](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/internals/server-updates.md)

**`reconcileProjection(projection, trigger, continueAfterRestart)` steps**

Source: [ProviderRuntimeRecoveryService.ts:206-738](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L206)
1. Collect non-terminal runs (`preparing|starting|running|waiting`). Skip a `waiting` run that still has a pending or running `checkpoint.capture` effect, because that effect will finish it. Non-terminal is defined at [L71-81](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L71); the skip is at [L214-237](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L214).
2. Keep pending runtime requests with `responseCapability.type === "message"`, such as Codex async questions answered by a new message. Every other pending request is closed — [L238-248](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L238).
3. "Delegated task rows, items and nodes stay open: the child settles them." App-owned delegations are excluded — [L249-255](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L249).
4. **Queue hold (the consent gate):**
   ```ts
   // Queued runs have not started provider work. Preserve their execution
   // identities and order, but require explicit consent before draining them.
   for (const run of projection.runs) {
     if (run.status !== "queued" || run.queueHeld === true) continue;
     events.push({ type: "run.updated", …, payload: { ...run, queueHeld: true } });
   }
   ```
   [L305-317](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L305)
5. Requests → `status: startup ? "expired" : "cancelled"` with `responseCapability: {type:"not_resumable", reason:"The server restarted before this runtime request was resolved."}` — [L318-336](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L318).
6. Each in-flight run → `cancelled` (`queuePosition:null, completedAt:now`). Its pending or running attempts, its nodes, its non-terminal subagents, and its running provider turns → `cancelled`. Streaming messages → `streaming:false`. Open turn items → `cancelled`. For a `waiting` run, open items are first recorded as lost background work — [L337-458](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L337).
7. Orphaned background items on already-settled runs → `cancelled`, together with their node and their **linked subagent row**: "Cancelling only the turn item would leave the linked subagent entity non-terminal forever, since the dead provider process can no longer emit its terminal event". Runless provider-native subagent root turns are cancelled too: "Left running, the child would show as working forever." — [L460-602](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L460).
8. Provider threads: `active → idle` and `pendingBackgroundTasks: []`. The roster tasks are recorded as lost work — [L604-633](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L604).
9. Sessions that are not `stopped`/`error` → `stopped, lastError:null` — [L634-647](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L634).
10. For each provider thread that lost work, one separate `run.background-work-cancelled` event on its latest started run merges `restartCancelledBackgroundWork`. It is separate because "a run snapshot read before this commit could regress a lifecycle change" — [L648-668](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L648).
11. Only when the setting is on and the trigger is startup: enqueue `{id: "effect:restart-continuation:<runId>", request: {type:"provider-runtime.continue", sourceRunId}}` in the same commit — [L669-682](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L669).
12. Commit. When `events.length === 0`, only cancel unsettled process-bound effects. Otherwise call `eventSink.commitCommand({commandId, commandType: "provider-runtime.reconcile", events, effects, cancelUnsettledEffects: {effectTypes: PROCESS_BOUND_EFFECT_TYPES, reason}})` — [L683-731](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L683).

**Other recovery pieces**
- **Global outbox step** (after all threads), `outbox.reconcileAfterProcessLoss`:
  - `pending|running` effects of type `provider-turn.start|interrupt|steer|restart` or `runtime-request.respond` → `cancelled` ("Cancelled because the server process ended before the effect completed.").
  - `running` effects of type `provider-runtime.continue`, `provider-session.detach`, `provider-thread.rollback`, `checkpoint.capture`, `terminal.cleanup`, `attachment.cleanup`, or `thread-title.generate` → back to `pending` ("Requeued after the previous server process ended.").
  - Source: [ProviderRuntimeRecoveryService.ts:741-790](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L741); [EffectOutbox.ts:108-124, 456-490](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EffectOutbox.ts#L108)
- **Which threads are scanned.** `getRecoveryThreadIds("runtime" | "queued-runs" | "subagent-results" | "delegated-completions")` uses SQL over projections and JSON paths. For example, `subagent-results` selects child threads (`lineage.relationshipToParent='subagent'`, `forkedFrom.type='node'`) whose latest run is terminal and that have **no `subagent_result` context transfer** to the parent yet — [ProjectionStore.ts:3392-3440](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProjectionStore.ts#L3392)
- **Delegated results.** `recoverDelegatedTasks` runs in two passes:
  1. For every child in `subagent-results`, run `finalizeAppOwnedSubagent(childThreadId)` under the **parent's** lock, with concurrency 8 and per-thread warnings.
  2. For every thread in `delegated-completions`, call `finalizeDelegatedCompletionDelivery` for terminal delivery runs, then re-`offerDelegatedCompletionDelivery` for runs that still have a `delegatedCompletion.delivery`. This re-populates the in-memory continuation queue from durable state.
  - Comment: "Settles child results and completion deliveries whose runs ended without the listener above: before this boot, or in runtime reconciliation, which it skips."
  - Source: [Orchestrator.ts:9926-10015](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9926)
- **Delivery durability.** `ProviderContinuationRequests` is an in-memory `Queue.unbounded`. Delegated-completion delivery state (`pending|claimed|acknowledged|delivered|disposed`) lives on the run, which is what lets boot re-offer it. "Delivery is at least once: provider acceptance and our receipt cannot commit atomically. Reusing the message ID keeps recovery from duplicating timeline items." — [ProviderContinuationRequests.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderContinuationRequests.ts); [contracts/orchestrationV2.ts:460-466](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L460); [NotificationMailbox.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/NotificationMailbox.ts)

**Restart continuation (opt-in) and the lost-work note**
- `restartContinuationRun` chooses the latest non-queued run if either:
  - it was `running` with a live provider turn, a strong native thread ref, and a session that is not stopped or errored; or
  - it was settled (`completed`/`waiting`) but its provider thread lost background work.
  - "Queued runs never started; recovery holds them behind the cut run."
  - Source: [RestartContinuation.ts:24-105](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/RestartContinuation.ts#L24)
- The `continueRestartedRun` handler re-checks before dispatching:
  - the setting, and archive state;
  - an existing message id;
  - newer user work: "A user submission after reconciliation takes precedence over an automatic prompt";
  - a user-requested stop (`run_interrupt_request` item);
  - `/compact`-style maintenance commands.
  - It then dispatches `commandId: command:restart-continuation:<runId>` and `messageId: message:restart-continuation:<runId>` with "Continue where you left off." (prefixed with the lost-work note) as `start_immediately`, `createdBy: "agent"`, `creationSource: "server"`.
  - If it declines, it still calls `recoverDelegatedTask` so a delegated child owes its parent a result.
  - Source: [RestartContinuation.ts:107-193](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/RestartContinuation.ts#L107)
- Note text: "Note: the T3 server restarted, and this background work was cancelled before it finished. It will not report back:\n- {kind}: {label}". Labels are compacted to 160 chars, and a capped list ends with "and N more". The note is carried forward "until a completed turn proves delivery" — [RestartBackgroundNote.ts:12-97, 125-160](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/RestartBackgroundNote.ts#L90)
- With the setting off, the note is prepended to the **next user turn's** provider prompt (`userText: restartNote === "" ? userText : \`${restartNote}\n\n${userText}\``) — [ProviderTurnStartService.ts:958-976, 1126](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderTurnStartService.ts#L958)
- Sessions are never resurrected: "intentionally does not resurrect persisted sessions… a later user command… opens a session lazily" — [ProviderSessionManager.ts:66-71](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L66)

**How the UI is told**
- Recovery has no special channel. Its effects reach clients as ordinary committed V2 events through the normal stream: `run.updated{queueHeld:true}`, `run.updated{status:cancelled}`, `runtime-request.updated{expired, not_resumable}`, `run.background-work-cancelled`, and `provider-session.updated{stopped}`. The client derives "Resume" from `queueHeld` (section 1). A `legacyThreadMigration` lifecycle event is published only for the V1 import progress — [ProviderRuntimeRecoveryService.ts:305-668](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L305); [serverRuntimeStartup.ts:495-505](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/serverRuntimeStartup.ts#L495)
- The latest recovery hardening on main is #15323 (2026-10-03), "restarts keep delegated tasks, queued threads, and stops intact". It touched 29 files (+2494/−172) and added `ProviderRuntimeRecoveryPerformance.test.ts` (510 lines) and `DelegatedCompletionDelivery.test.ts` (624 lines) — [commit 5108c978](https://github.com/pingdotgg/t3code/commit/5108c978b1d9a8bd029e5ea96781d8cbc90b3877)

**Known gaps and open work (not on main)**
- **(issue, open)** #15358: "A thread waiting on background work stays stranded after a backend restart until the user sends a message". Recovery stores `restartCancelledBackgroundWork` correctly, but with continuation off (the default) the thread stays idle and looks finished — [Issue #15358](https://github.com/pingdotgg/t3code/issues/15358)
- **(open PR)** #15201 "reconcile stale delegated task and held queue state": "Existing held input is retained for explicit resume or cancellation; this change does not replay it." — [PR #15201](https://github.com/pingdotgg/t3code/pull/15201)
- **(open PR)** #15308 "close stale request prompts during recovery and detach"; #15442 "recover runs after disk space stalls"; #14729 "a restart that never starts settles the work its run inherited" — [PR #15308](https://github.com/pingdotgg/t3code/pull/15308); [PR #15442](https://github.com/pingdotgg/t3code/pull/15442); [PR #14729](https://github.com/pingdotgg/t3code/pull/14729)

### Inferences
- **Direct prior art for Solenta's "durable crew wake-up notices with consent-gated resume".** Three pieces carry over:
  - **The hold rule.** On boot, never auto-drain pending wake-ups. Mark them held, keep their identity and order, and require one explicit resume action. That action is a command with a deterministic id, so a double click is harmless.
  - **Lost-work notices as durable data on the turn** (`restartCancelledBackgroundWork`), merged and delivered with the next prompt and "carried forward until a completed turn proves delivery".
  - **Opt-in auto-continuation as a durable outbox intent**, not a timer: an `effect:restart-continuation:<runId>` row that survives a second crash.
- T3's open #15358 shows the cost of the default (continuation off). A finished-looking thread silently lost its wake source. Solenta should show a visible "work was lost on restart" state (a Waiting-to-resume badge) even when auto-resume is off.
- A recovery commit must be excluded from the reactors that react to terminal states (the `command:runtime-reconcile:` prefix filter). Otherwise recovery's own cancellations would trigger queue drains and parent wakes, which defeats the consent gate.

### Gaps
- No user-facing copy for the "server restarted" state in the web UI was located. Whether cancelled runs show a distinct banner versus plain "cancelled" was not verified.
- `prepareForShutdown` behavior when the OS kills the process (no finalizer) relies on startup reconcile. No test of SIGKILL mid-commit was found beyond SQLite transactionality.

## 4. Status derivation for sidebar and Lineage, and why subagent rows drift (#13331, #15567)

### Takeaway
Sidebar status is computed in two places from the **thread shell**, the server's per-thread summary row:
- **On the server:** `threadShellFromProjection` picks `latestRun` (skipping held queued runs, and preferring a usage-limited run), `activityRunStatus`, the error class, and `pendingBackgroundTasks`.
- **On the client:**
  - `shellRuntime` parks the status at `idle` when wake-holding background work remains, unless the run failed.
  - `resolveSidebarThreadStatus` maps the result:
    - approval → input → `working` (preparing/queued/starting/running/waiting)
    - `waiting` (idle)
    - `limited` (failed + `usage_limit`) / `failed`
    - `ready`
  - `resolveSidebarV2TopStatus` turns `ready` into `done` when unread.

Lineage rows use the child thread's `activityRunStatus` first and fall back to the parent's `subagents` record status. The parent's record drifts from the child for two reasons, both explained by the code:
- **App-owned:** `finalizeAppOwnedSubagent` writes the parent's subagent row **once**. The `existingResultTransfer` guard returns early forever after, so follow-up runs on the child never update it (#13331 item 2; patched on main client-side only by #15334).
- **Provider-native Codex:** after restart, recovery cancels the child rows. The adapter's child registry is an **in-memory map** that `resumeThread` never rebuilds, so post-restart child turns are parked or dropped (#15567, open).

### Cited Findings

**Sidebar status**
- Status union and rules:
  ```ts
  export type SidebarThreadStatus = "approval" | "input" | "working" | "waiting" | "failed" | "limited" | "ready";
  export function resolveSidebarThreadStatus(thread) {
    if (thread.hasPendingApprovals) return "approval";
    if (thread.hasPendingUserInput) return "input";
    if (thread.runtime !== null && ["preparing","queued","starting","running","waiting"].includes(thread.runtime.status)) return "working";
    if (thread.runtime?.status === "idle") return "waiting";
    if (thread.runtime?.status === "failed") return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
    return "ready";
  }
  ```
  - The comment explains Waiting: runtime "idle" means "the agent stopped with background work that will wake it (subagents, monitors)… Commands it left running, such as a dev server, do not hold the thread".
  - `resolveSidebarV2TopStatus` adds `woke` and `done` (ready + unread).
  - Source: [Sidebar.logic.ts:932-1037](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/Sidebar.logic.ts#L948)
- Client `shellRuntime`: "Park runtime at idle when the post-settlement background roster holds the run's completion… A failed latest run outranks the roster, so the failure stays visible." (`parkAtIdle = backgroundWorkHoldsCompletion(...) && thread.status !== "failed"`). This is the fix for #13331 item 5 — [client-runtime state/models.ts:163-190](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/models.ts#L163)
- `backgroundWorkHoldsCompletion`: `command → false`; `subagent | monitor | background_task → true` — [shared/orchestrationV2PendingBackgroundWork.ts:62-85](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/shared/src/orchestrationV2PendingBackgroundWork.ts#L62)
- Server `threadShellFromProjection`:
  - `latestRun = usageLimitRunPresentedAsLatest(...) ?? latestUnheldRun(runs)`.
  - `activityRunStatus` comes from the newest activity run.
  - `status: latestRun?.status ?? "idle"`, plus `...threadErrorSummary(latestRootProviderFailure(latestRun, turnItems), session.lastError)` and `pendingBackgroundTasks` from `derivePendingBackgroundWork`.
  - Source: [ProjectionStore.ts:1299-1395](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProjectionStore.ts#L1299)
- The thread-detail equivalent is `deriveThreadRuntime(projection)`, which yields `failed` if usage-limited, else `idle` when background work holds and the run is not failed, else the activity run status — [client-runtime state/threadExecution.ts:223-264](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/threadExecution.ts#L223)

**Lineage**
- Lineage edges:
  - Thread-derived edges use `status: thread.activityRunStatus ?? thread.status`.
  - Subagent-record edges use `status: threadsById.get(subagent.childThreadId)?.activityRunStatus ?? subagent.status`, with the comment: "The subagent record settles with the delegated task's first run, but the parent can keep sending the child follow-ups. A live run on the child thread outranks that settled status."
  - Row status: `thread?.activityRunStatus ?? thread?.status`.
  - Source: [client-runtime state/threadRelationships.ts:77-114, 193-202](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/threadRelationships.ts#L77)
- Lineage panel grouping:
  - Subagent edges whose status is in `["completed","failed","error","cancelled","interrupted","idle"]` go to "Previous agents"; the rest are active.
  - `runningCount` = subagents without a child thread whose record says `running`, plus active edges with status `running`.
  - `liveSubagent()` overrides the hover card and timer from the child's live run.
  - Source: [ThreadRelationshipsControl.tsx:165-190, 255-320](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ThreadRelationshipsControl.tsx#L255)
- The client-side fix for steered or followed-up subagents landed as #15334 (2026-10-03) "subagents sent a follow-up show as running in Lineage" — [commit d3071275](https://github.com/pingdotgg/t3code/commit/d3071275)

**Root cause of app-owned drift (server)**
- `finalizeAppOwnedSubagent` returns unless the child's progress is `result_available` with a terminal result run. It then looks up an existing transfer:
  ```ts
  const existingResultTransfer = parentProjection.contextTransfers.find(t =>
    t.type === "subagent_result" && t.sourceThreadId === childThreadId && t.targetThreadId === parentThreadId);
  if (existingResultTransfer !== undefined) { return; }
  const updatedTask = { ...task, status: terminalStatus, result: result.text, completedAt: now, … };
  ```
  The first terminal child run settles the parent's row and creates the `subagent_result` transfer. Every later child run hits the early return, so the parent's `subagents` row stays "completed" while the child works — [Orchestrator.ts:8858-8960](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L8858)
- **(issue, open)** #13331 item 2: "The parent's subagent record settles when the spawning run ends, and a new run on the child thread doesn't reopen it… Fix: prefer the child thread's live `activityRunStatus`". Item 5 (failed shows as waiting) is also fixed on main via `shellRuntime` — [Issue #13331](https://github.com/pingdotgg/t3code/issues/13331)
- **(open PR)** #15004 "deliver results from subagent follow-ups" proposes the server-side fix: "Track each child run's authorized parent at request time and deliver a versioned result for every completion. Follow-ups update the current task outcome while the original result stays in the timeline" — [PR #15004](https://github.com/pingdotgg/t3code/pull/15004)
- The replay test **asserts the settled record by design**. After a Claude subagent is resumed post-restart and does more work, the test expects `assert.equal(subagent?.status, "completed")`, while the child thread carries the new conversation and 3 new command items — [OrchestratorReplayRecovery.integration.test.ts:380-382](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts#L380)

**Root cause of provider-native Codex drift after restart (#15567, issue, open, filed 2026-10-04)**
- Step 1: recovery cancels stale provider-native subagent rows and their nodes, because the old process is gone — [ProviderRuntimeRecoveryService.ts:510-545](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L510)
- Step 2: `CodexAdapterV2` keeps child registrations in `const subagentThreads = yield* Ref.make(new Map<string, CodexSubagentThreadContext>())`, alongside `pendingSubagentTurns`, created empty per session — [CodexAdapterV2.ts:1668-1672](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L1668)
- Step 3: `resumeThread` calls `thread/resume` with `excludeTurns: true` for the parent only and does not rebuild child registrations — [CodexAdapterV2.ts:5429-5436](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L5429)
- Step 4: `rememberSubagentTurnStarted` parks a `turn/started` from an unknown child in `pendingSubagentTurns`, waiting for a registration that never comes — [CodexAdapterV2.ts:2402-2421](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L2402)
- Step 5: item events whose turn context cannot be resolved are dropped (`const resolved = yield* resolveItemEventContext(payload.turnId); if (resolved === undefined) { return; }`) — [CodexAdapterV2.ts:4184-4187](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L4184)
- Issue evidence: native `turn/started` and completed messages arrive after restart, but the stored subagent status stays `completed` with old timestamps, and children created after the restart track correctly. The Claude counterpart was fixed by #13735 — [Issue #15567](https://github.com/pingdotgg/t3code/issues/15567)

### Inferences
- **General lesson for Solenta.** A parent-side "child summary row" that is written by a one-shot finalizer will drift as soon as the child can run again: follow-ups, resume after restart, or a re-steer. Pick one of two designs:
  - **Derive** child status at read time from the child's own latest run (T3's client-side patch).
  - Make the summary row **versioned per child run** (T3's open #15004).
- Never use a "result already exists → return" idempotency guard on a status field that must keep changing. Key idempotency on `(child, runId)` instead of on `child`.
- Any adapter-level in-memory registry (native child id → app thread) must be **rehydrated from persisted projections on session resume**. Otherwise post-restart events from existing children are silently dropped. Solenta's grok/claude/codex runners should persist `nativeChildId → threadId` and reload it when a session resumes.

### Gaps
- The mobile Lineage implementation and `ThreadNotificationCoordinator` (which also uses "limited") were not traced.
- No fix PR for #15567 was found among the open PRs filtered by title.

## 5. Client sync: snapshot+sequence protocol, gap replay limits, protocol-version 426 refusal, whole-entity upserts

### Takeaway
The resume protocol works like this:
- A thread subscription takes `afterSequence`.
- The server replays the gap only if the cursor is not ahead of its high-water mark and the gap is **≤128 events and ≤1 MiB** of encoded wire JSON, with a separate ≤1 MiB raw-payload preflight. Otherwise it sends one bounded, wire-projected snapshot.
- The client drops anything at or below its applied sequence, and advances the cursor even for unknown event types.
- It applies events as whole-entity upserts: find by id, replace or append.
- `/ws` refuses mismatched clients with HTTP 426 before auth or RPC.

### Cited Findings
- Constants and decision:
  ```ts
  export const THREAD_RESUME_MAX_REPLAY_EVENTS = 128;
  export const THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES = 1_048_576;
  export const THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES = 1_048_576; // preflight before decoding persisted payloads
  export function decideThreadResume({ afterSequence, highWater, replayEventCount, replayEncodedBytes }) {
    if (afterSequence > highWater || replayEventCount > 128 || replayEncodedBytes > 1 MiB) return { mode: "snapshot" };
    return { mode: "replay", afterSequence, throughSequence: highWater };
  }
  ```
  Comment: "A client cursor above the high water mark is stale or invalid. Event count limits reducer churn while encoded bytes limit a small number of large updates. Either excess is cheaper to replace with one current snapshot." — [ThreadStream.ts:10-100](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ThreadStream.ts#L10)
- The snapshot item is `{kind:"snapshot", snapshotSequence, projection, historyCursor, hasMoreHistory, latestLocalTurnOrdinal, payloadBudgetExceeded}`, built by `buildBoundedThreadStreamSnapshot` over `projectThreadProjectionForWire` ("the same bounded, wire-projected snapshot for every socket fallback path") — [ThreadStream.ts:38-57](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ThreadStream.ts#L38)
- 426 gate:
  ```ts
  if (Option.isNone(requestUrl) || !hasCompatibleOrchestrationProtocol(requestUrl.value)) {
    return HttpServerResponse.jsonUnsafe({ code: "orchestration_protocol_incompatible",
      message: `Update this client to one that supports orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}.`,
      orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION }, { status: 426 });
  }
  ```
  This runs before `EnvironmentAuth`/`SessionStore` are touched. Clients append `orchestrationProtocol=2` — [ws.ts:3772-3787](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/ws.ts#L3772); [legacy-orchestration-migration.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/internals/legacy-orchestration-migration.md)
- Client apply loop: `if (item.sequence <= sequence) continue; // An event type from a newer server still moves the resume cursor past it.` It then sets `lastSequence` and applies the fresh events "against the latest projection/history in one update so a concurrent loadEarlier merge… cannot be clobbered" — [client-runtime state/threads.ts:442-475](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/threads.ts#L442)
- Whole-entity upsert:
  ```ts
  function upsertEntity(items, item) {
    const index = items.findIndex(c => c.id === item.id);
    if (index === -1) return [...items, item];
    const next = [...items]; next[index] = item; return next;
  }
  // thread.* → { ...base, thread: event.payload }; run.created/run.updated → runs: upsertEntity(base.runs, payload) …
  ```
  `run.background-work-cancelled` is the one partial-patch event. It sets `restartCancelledBackgroundWork` on the matching run — [client-runtime state/orchestrationV2Projection.ts:16-25, 153-250](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/orchestrationV2Projection.ts#L153)
- Ordered publication on the server (a publish lane held through publish) and gap-free live concat (subscribe first, then replay ≤ highWater, then live > highWater) are covered in the first-round notes — [EventSink.ts:231-262, 707-750](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EventSink.ts#L231)

### Inferences
- For Solenta's renderer↔main IPC, the copyable pieces are:
  - A global monotonic `seq` on every store mutation.
  - `subscribe(afterSeq)` returning a replay or a snapshot, decided by a count/bytes budget.
  - A client-side `seq <= applied` drop.
  - Whole-entity upserts.
  - A protocol-version refusal at connect time, which is relevant when an old renderer bundle talks to a newer main process after an in-place update.

### Gaps
- Shell (sidebar) stream resume (`ShellStream.ts`) limits were not re-examined in this round.

## 6. Replay test harness: NDJSON fixtures, fake provider process/driver, entry semantics, recording, assertions, determinism, counts, crash tests

### Takeaway
Integration tests run the **real** orchestrator, adapters, event sink, SQLite projections, checkpoint service, and effect worker. Only the provider transport is replaced, by a transcript.
- **Format.** Transcripts are NDJSON: a `transcript_start` header, then `expect_outbound` (the next frame the app must send, matched structurally), `emit_inbound` (a frame to feed the app, optionally `afterMs`), and `runtime_exit` (the process ends with success, error, or cancelled).
- **Boundary depth varies by provider:**
  - **ACP (Grok, ACP registry) spawns a real child process.** `acp-replay-agent.ts` reads stdin NDJSON JSON-RPC, validates it, and writes recorded frames to stdout. This exercises the production spawn and stdio path and is the closest analog to "pipe recorded CLI stdout through the real runner".
  - **Codex** swaps the `Stdio` of the real JSON-RPC client.
  - **Claude** replays at the Agent SDK `query()` iterator.
- **Determinism.** Time is `TestClock` and ids come from seeded `effect/Random`. Scenario steps advance the clock explicitly. Waits poll projections with an iteration budget plus a wall-clock deadline. Labeled **replay gates** pause inbound emission at a chosen frame.
- **Restart and crash tests** run two scoped runtimes against one file-backed SQLite and one shared transcript cursor, sometimes splicing a recorded transcript with `runtime_exit` plus hand-written resume frames.
- **Counts.** 85 fixture scenario directories hold 138 transcripts. The registry runs 73 scenarios × providers = 120 variants. No property or fuzz tests were found.

### Cited Findings

**Format (schema + loader)**
- Schema:
  ```ts
  ProviderReplayEntry = Union(
    { type: "expect_outbound", label?: string, frame: unknown },
    { type: "emit_inbound",  label?: string, frame: unknown, afterMs?: NonNegativeInt },
    { type: "runtime_exit",  status: "success"|"error"|"cancelled", error?: unknown });
  ProviderReplayTranscript = { provider, protocol, version, scenario, metadata?: Record<string, unknown>, entries };
  ProviderReplayTranscriptHeader = { type: "transcript_start", provider, protocol, version, scenario, metadata? };
  ```
  Source: [contracts/orchestrationV2.ts:3334-3378](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L3334)
- Loader `decodeProviderReplayNdjson`:
  - Splits lines and trims; the first record may be `transcript_start`; a later `transcript_start` is an error.
  - Each line is schema-decoded, with line-numbered errors.
  - `materializeReplayTranscriptWorkspace` replaces `"<workspace>"` in **outbound** expectations only: "The resulting outbound frames still use exact structural equality during replay."
  - Source: [testkit/ReplayTranscriptNdjson.ts:55-94, 190-248](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/ReplayTranscriptNdjson.ts#L190)
- Real snippet, `fixtures/queued_turn/claude_transcript.ndjson` (14 lines; long frames truncated here with …):
  ```json
  {"type":"transcript_start","provider":"claudeAgent","protocol":"claude-agent-sdk.query","version":"0.2.111","scenario":"queued_turn","metadata":{"prompts":["Respond with exactly: first fixture turn complete","Respond with exactly: second fixture turn complete"],"model":"claude-sonnet-4-6","nativeSessionId":"df83c769-…","queryMode":"streaming","tools":"claude_code","permissionMode":"bypassPermissions","generatedBy":"recordClaudeAgentSdkReplayTranscript"}}
  {"type":"expect_outbound","label":"query.open","frame":{"type":"query.open","options":{"model":"claude-sonnet-4-6","tools":{"type":"preset","preset":"claude_code"},"permissionMode":"bypassPermissions","allowDangerouslySkipPermissions":true,"sessionId":"df83c769-…","settings":{"showThinkingSummaries":true}}}}
  {"type":"expect_outbound","label":"prompt.offer:1","frame":{"type":"prompt.offer","message":{"type":"user","message":{"role":"user","content":"Respond with exactly: first fixture turn complete"},"parent_tool_use_id":null}}}
  {"type":"emit_inbound","label":"system","frame":{"type":"system","subtype":"init","claude_code_version":"2.1.111","cwd":"/tmp/claude-replay-queued_turn",…}}
  {"type":"emit_inbound","label":"assistant","frame":{"type":"assistant","message":{"model":"claude-sonnet-4-6","id":"msg_01NQEE…","content":[{"type":"text","text":"first fixture turn complete"}],…}}}
  {"type":"emit_inbound","label":"result","frame":{"type":"result","subtype":"success","is_error":false,"result":"first fixture turn complete","stop_reason":"end_turn",…}}
  {"type":"expect_outbound","label":"prompt.offer:2","frame":{"type":"prompt.offer","message":{"type":"user","message":{"role":"user","content":"Respond with exactly: second fixture turn complete"},"parent_tool_use_id":null}}}
  … assistant / result for turn 2 …
  {"type":"runtime_exit","status":"success"}
  ```
  Source: [fixtures/queued_turn/claude_transcript.ndjson](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/queued_turn/claude_transcript.ndjson)
- Codex snippet (JSON-RPC app-server):
  - Header: `{"type":"transcript_start","provider":"codex","protocol":"codex.app-server","version":"0.156.1","scenario":"simple",…}`.
  - Then `expect_outbound initialize{id:1}` → `emit_inbound {id:1,result:{…}}` → `expect_outbound thread/start{cwd:"<workspace>",model:"gpt-6-luna"}` → … → many `item/agentMessage/delta` notifications with recorded `emittedAtMs`.
  - Source: [fixtures/simple/codex_transcript.ndjson](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson)
- Grok/ACP snippet: the header metadata records the normalization and the dropped-frame count. Excerpt: `"normalization":"Session ids are fixed UUIDs, the workspace is <workspace>, HOME is /home/grok-replay… T3-owned prompt text, MCP servers and initialize params are <any>… Timestamps are kept as recorded.","droppedFrames":5`. Frames are logical `{kind:"request"|"response"|"notification", method, params|result}` — [fixtures/simple/grok_transcript.ndjson](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/simple/grok_transcript.ndjson)

**Fake provider process / runtime drivers (entry semantics)**
- **ACP child-process replay peer**, about 300 lines and dependency-free:
  - Configuration: `T3_ACP_REPLAY_TRANSCRIPT_PATH` (a file, because "Recorded transcripts outgrow the kernel's 128 KiB limit on one environment variable"), `T3_ACP_REPLAY_STATUS_PATH`, and `T3_ACP_REPLAY_WORKSPACE`.
  - Semantics, excerpted:
    - `flushInbound()` emits every consecutive `emit_inbound` until the next `expect_outbound`. It assigns ids to agent→client requests and answers pending client requests by method.
    - `runtime_exit` with `success`/`cancelled` just advances; `error` stops with failure.
    - `handleMessage` reads each stdin line. If the cursor entry is not `expect_outbound`, or `matchesExpected` fails, it replies JSON-RPC error `-32603 "ACP replay frame mismatch"` to requests, records the failure, sets exit code 1, and pauses stdin.
    - `matchesExpected` does structural equality with exact key sets, plus a `"<any>"` wildcard (whole value or glob inside strings) and `<workspace>` expansion.
    - On stdin close before the transcript completes: "ACP replay input closed before transcript completion".
    - After every step it writes `{scenario, cursor, total, failure?}` to the status file.
  - Source: [apps/server/scripts/acp-replay-agent.ts:37-300](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/scripts/acp-replay-agent.ts#L37)
- ACP harness wiring:
  - It uses the **production** `AcpSessionRuntime.layer`, with only `spawn: {command: process.execPath, args: ["--experimental-strip-types", scriptPath], env: {…T3_ACP_REPLAY_*}}` and `authMethodId: "replay"` changed.
  - Replay gates are applied by `transformStdout: holdGatedReplayLines(...)`: "the Nth line it writes belongs to the Nth inbound entry and carries its label. Lines after a held one wait with it, which keeps wire order".
  - Completion check: the status file must show `failure === undefined && cursor === entries.length && total === entries.length`, else "ACP replay did not consume all frames".
  - Source: [Adapters/AcpAdapterV2.testkit.ts:115-150, 152-240](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.testkit.ts#L115)
- **Codex in-process stdio replay** (`effect-codex-app-server/replay.ts`):
  - It builds `Stdio.make({ stdin: Stream.fromQueue(input), stdout: () => Sink.forEach(processOutboundChunk), stderr: Sink.drain })` and passes it to the **real** `CodexClient.make`, so the production JSON-RPC line framing and parsing runs.
  - `drainInbound` offers `emit_inbound` frames, sleeping `Effect.sleep(afterMs)` (TestClock-controlled) first.
  - `runtime_exit success` ends stdin; anything else fails with `CodexAppServerReplayRuntimeExitError`.
  - Each outbound line is split on `\n`, JSON-decoded, and compared with `sameFrame`.
  - Typed errors: `Exhausted`, `UnexpectedOutbound`, `FrameMismatch{label, expected, actual}`, `RuntimeExit`, `Incomplete`.
  - `normalizeReplayFrame` ignores volatile fields (`clientInfo.version`, `developer_instructions`, a default `approvalPolicy: never`, `sandboxPolicy dangerFullAccess`, handoff summary text). Recorder-only config keys are listed in `metadata.recorderThreadConfigKeys`.
  - Source: [packages/effect-codex-app-server/src/replay.ts:138-563](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/effect-codex-app-server/src/replay.ts#L383)
- **Claude**: "the initial replay boundary is the async iterable returned by the Agent SDK `query()`… it does not test the SDK's own subprocess or transport parser." The outbound frames are synthetic `query.open`, `prompt.offer`, and `query.interrupt` — [docs/orchestration-v2/testing-strategy.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/testing-strategy.md); [Adapters/ClaudeAdapterV2.testkit.ts:43, 173-193, 418-420, 535-536, 827-828](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts#L173)
- OpenCode fixtures replace the SDK client at the HTTP/SSE boundary and "must preserve races between request responses and SSE events" — [testing-strategy.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/testing-strategy.md)

**Orchestrator-level harness**
- `makeOrchestratorV2ReplayLayerWithRegistry`:
  - Builds a temp server config per scenario, the real stores, `EventSink`, `ProviderEventIngestor`, `ProviderSessionManager` (MCP off), the checkpoint services, and `Orchestrator`.
  - The database is `SqlitePersistenceMemory` by default, or a file DB via `databaseLayer`.
  - Mocks: `ProviderAuthService` (`tryHandlePromptCommand → false`), title generation (no-op), and `ThreadManagementService`, which forwards to the real orchestrator.
  - Options: `runEffectWorker`, `runContinuationWorker`, `recoverOnStartup`, `continueThreadsAfterServerUpdate`.
  - It mirrors production startup: optional `ProviderRuntimeRecoveryService.recover` first, then `orchestrator.recoverDelegatedTasks`, then `EffectWorker.runDaemon` forked.
  - Source: [testkit/ProviderReplayHarness.ts:63-149, 172-215, 249-507](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts#L249)
- Scenario step DSL:
  - Steps: `dispatch{command, await?, key?}`, `advance_clock{duration}`, `await{key}`, `await_all`, `await_thread_idle`, `await_no_background_work`, `await_run_steerable`, `await_run_status`, `finish_held_run`, `await_run_turn_item`, `release_replay_gate`, `release_replay_gate_after_waiting`, `capture_shell_snapshot`, `respond_to_next_runtime_request{decision?|answers?}`.
  - The result exposes `storedEvents`, `domainEvents`, `projections` (by thread), `shellSnapshot`, and `capturedShellSnapshots`.
  - Source: [testkit/OrchestratorScenario.ts:28-120](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts#L28)
- Wait budget: "Iterations count event-loop turns, not time… A wait is exhausted only once BOTH the iteration budget and this wall-clock deadline are spent" (`SCENARIO_WAIT_DEADLINE_MS = 60_000`; each poll does `yieldNow` + `setImmediate`). On timeout the error names the active runs and pending requests (`await_thread_idle:${threadId}:runs=…:requests=…`) — [OrchestratorScenario.ts:220-356](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts#L220)
- Replay gates: `beforeEmit(label)` blocks emission at a labelled inbound frame until `release(label)`. `recordFinishArmed(debounce)` lets `finish_held_run` advance `TestClock` by exactly the debounce an adapter armed: "Replay runs on a test clock, so a scenario advances it by exactly that on the receipt." — [testkit/ProviderReplayGate.testkit.ts:1-119](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/ProviderReplayGate.testkit.ts#L1)

**Fixture inputs, outputs, and assertions**
- Each fixture directory holds `input.ts` (provider-neutral steps), `<provider>_transcript.ndjson`, and `<provider>_output.ts` (assertions). Example `queued_turn/input.ts`: `steps: [{type:"message", text: FIRST}, {type:"queue_message", text: SECOND}]` — [fixtures/queued_turn/input.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/queued_turn/input.ts)
- `materializeFixtureInput` turns steps into commands and steps:
  - Ids come from `IdAllocator.allocate.command({fixtureName, commandName})`.
  - It inserts `advance_clock 1 millis` after every dispatch.
  - For `queue_message` it dispatches `dispatchMode: {type:"queue_after_active"}`, then awaits the active run's dispatch and `await_thread_idle`.
  - Other step types: `steer`, `restart`, `interrupt`, `cancel_queued_run`, `approve_next_runtime_request`, `answer_next_user_input_request`, `rollback`, `stop_background_work`, `advance_clock`, …
  - Source: [fixtures/shared.ts:201-298, 505-560, 630-665](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/shared.ts#L505)
- Projection assertions, from `queued_turn/codex_output.ts`:
  ```ts
  assertBaseProjection({ result, transcript, runCount: 2, runStatuses: ["completed", "completed"] });
  assertSemanticProjectionIntegrity(projection);
  assertRunOrdinals(projection, [1, 2]);
  assertConversationMessageRoles(projection, ["user", "assistant", "user", "assistant"]);
  assertUserMessageInputIntents(projection, ["turn_start", "queued_turn"]);
  const run2Events = result.domainEvents.filter(e => (e.type === "run.created" || e.type === "run.updated") && e.runId === projection.runs[1]?.id);
  assert.equal(run2Events[0]?.type, "run.created");
  assert.equal(run2Events[0]?.payload.status, "queued");
  assert.isTrue(run2Events.some((event) => event.payload.status === "running"));
  ```
  Source: [fixtures/queued_turn/codex_output.ts:20-49](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/queued_turn/codex_output.ts#L20)
- `assertBaseProjection` checks:
  - the provider instance;
  - the run count;
  - provider turns ≥ runs (with a diagnostic listing runs, sessions, and items);
  - **stored-event sequences exactly `1..n`**;
  - stored event ids equal domain event ids;
  - optional run statuses.
  - Source: [fixtures/shared.ts:955-991](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/shared.ts#L955)
- The doc's guidance on assertions: "Good assertions: duplicate command dispatch returns the original receipt sequence without replaying provider transport; stored-event sequence monotonicity; snapshot sequence plus stream-after-sequence… Weak assertions: exact internal function call counts" — [testing-strategy.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/testing-strategy.md)
- A contract test validates every registry entry: each has providers, the transcript scenario and provider match the fixture, `commands.length === commandProducingSteps + 1` (thread.create), and Codex transcripts begin with `expect_outbound initialize` and end with `runtime_exit` — [testkit/OrchestratorReplayFixtures.contract.test.ts:22-158](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/OrchestratorReplayFixtures.contract.test.ts#L22)

**Timing, clock, ids**
- The deterministic runtime is 13 lines:
  ```ts
  export function provideDeterministicTestRuntime(effect, options = {}) {
    return effect.pipe(Effect.provide(TestClock.layer()), Random.withSeed(options.randomSeed ?? 0x1234_5678));
  }
  ```
  Source: [testkit/DeterministicRuntime.ts:1-13](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/DeterministicRuntime.ts#L1)
- Ids: `randomUuidV4` is built from 16 `Random.nextIntBetween(0,256)` bytes, so seeded Random gives stable ids. Allocated ids look like `command:fixture:<scenario>:<commandName>:<uuid>`. Production rule: "read time through `DateTime.now`/`Clock`… allocate random values through `effect/Random`, not… `crypto.randomUUID`, `Math.random`" — [RandomUuid.ts:1-13](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/RandomUuid.ts#L1); [IdAllocator.ts:236-265](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/IdAllocator.ts#L236); [testing-strategy.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/testing-strategy.md)
- Tests wait on drainable workers or on persisted events and receipts: "Production behavior must use persisted state and events, not test instrumentation or assumptions about elapsed time." — [docs/internals/overview.md:99-104](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/internals/overview.md)

**Recording and refreshing fixtures**
- Recorder scripts: `record:codex-replay`, `record:claude-replay`, `record:cursor-replay`, `record:pi-replay`, and `record:grok-replay`, all taking `--scenario <name>` — [apps/server/package.json:24-28](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/package.json#L24)
- The Grok recorder runs "the fixture's own scenario (the same commands and steps the replay test dispatches)… through the real orchestrator and the real GrokAdapterV2; only the ACP runtime's protocol logger is swapped for a tee". Other details:
  - It waits for quiescence: no running background tasks, and every `subagent_spawned` matched by `subagent_finished`.
  - It drops broadcasts T3 never reads (`_x.ai/settings/update`, `_x.ai/announcements/update`).
  - It normalizes the workspace and HOME and wildcards T3-owned prompt text as `<any>`.
  - It fails if a second ACP process spawns.
  - Source: [scripts/record-grok-acp-replay-fixture.ts:1-11, 90-145, 233-400, 545-576](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/scripts/record-grok-acp-replay-fixture.ts#L1)
- Fixture rules: "Redaction should preserve ids, method names, lifecycle ordering, and correlation structure"; "Expected V2 events or projections are assertions, not fixture input" — [testing-strategy.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/testing-strategy.md)

**Scenario counts (main at SHA)**
- 85 scenario directories under `testkit/fixtures/`, holding 138 transcripts: claude 41, codex 30, opencode 22, grok 16, cursor 11, registry 10, pi 8.
- `ORCHESTRATOR_REPLAY_FIXTURES` registers **73 scenarios** with **120 (scenario, provider) variants**: claudeAgent 33, codex 23, opencode 19, grok 16, acpRegistry 11, cursor 10, pi 8.
- `orchestration-v2/` has 106 `*.test.ts` files: 14 `*.integration.test.ts` and 4 `*.live.test.ts`.
- Source: counted via `ls`/`grep -c` on [fixtures/index.ts:204](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/index.ts#L204)
- Queue- and restart-related scenarios include `queued_turn`, `queued_cancelled_while_active`, `message_steering`, `multi_turn_restart`, `provider_thread_resume`, `claude_subagent_resume_after_restart`, `opencode2_resume_after_restart`, `thread_rollback_after_restart`, `claude_background_wake_before_queued_prompt(_no_echo)`, and `turn_interrupt_restart` — [testkit/fixtures/](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/index.ts)

**Crash and restart recovery tests**
- **Two-runtime restart** over one file DB:
  - `splitAfterFirstIdle` splits the materialized steps at the first `await_thread_idle`.
  - Phase 1 runs in its own `Effect.scoped` runtime; phase 2 runs in a fresh runtime with the same `makeSqlitePersistenceLive(dbPath)` and the **same replay driver**, whose cursor continues.
  - The assertions check 2 completed runs, a `user/assistant/user/assistant` conversation, and exactly one provider thread (resumed, not recreated).
  - Variants: Codex, Cursor, and the Claude subagent resume.
  - Source: [testkit/OrchestratorReplayRecovery.integration.test.ts:94-108, 200-297, 314-422](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts#L94)
- **Simulated crash by transcript splicing:**
  - The recorded entries are sliced through the root `result`, then `{ type: "runtime_exit", status: "success" }` ("The server dies here, with the background subagent still running").
  - Then `expect_outbound query.open:resume {…options, resume: SESSION_ID}`, then hand-authored `prompt.offer`/assistant/result triples for each resumed prompt.
  - Phase 2 runs with `recoverOnStartup: true` and `continueThreadsAfterServerUpdate` toggled.
  - Tests: "tells the next provider turn once that its background subagent died" and "continues a settled thread with the note when restart continuation is on". The replay runner rejects any prompt frame that differs, which proves the exact note text was sent.
  - Source: [testkit/OrchestratorReplayRestartBackgroundNote.integration.test.ts:60-270](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/OrchestratorReplayRestartBackgroundNote.integration.test.ts#L60)
- Unit-level recovery tests with mocked stores and sinks, for example "holds accepted queued work without cancelling its execution state after restart". That test asserts the reconcile commit has `run.updated{status:"queued", queuePosition:1, queueHeld:true}` and **no** attempt or node events. Other tests: "expires orphaned runtime requests before command readiness", "preserves async questions across startup and shutdown", "leaves delegated tasks to their own child threads after process loss" — [ProviderRuntimeRecoveryService.test.ts:29-700, 1276](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts#L581)
- Other recovery suites:
  - `ProjectionRecovery.test.ts` (517 lines), including "recovers terminal subagent results until their cross-thread transfer exists" and "marks fork descendants unreadable when their source is missing or corrupt".
  - `ProviderRuntimeRecoveryPerformance.test.ts`: "selects unfinished recovery work without reading settled thread histories".
  - `DelegatedCompletionDelivery.test.ts` (1,278 lines).
  - Source: [ProjectionRecovery.test.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProjectionRecovery.test.ts); [ProviderRuntimeRecoveryPerformance.test.ts:116](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryPerformance.test.ts#L116)
- **Property and fuzz:** grep for `fast-check`, `FastCheck`, `fc.assert`, and `it.prop` across `apps/server/src` and `packages/*/src` found nothing. No property-based or fuzz tests exist at this SHA — [repo grep at SHA](https://github.com/pingdotgg/t3code/tree/eac52f0087d9ba5dee5542f24788d1482affae43)

### Inferences
- **Blueprint for Solenta's replay-fixture harness** ("pipe recorded provider CLI stdout through the real runner"). The ACP pattern carries over almost unchanged, because Solenta spawns CLIs:
  - A ~300-line standalone node script acts as the fake CLI. It reads the transcript from a file path in an env var and writes a status file.
  - Solenta's **real** runner spawns it, changing only `command/args/env`.
  - It validates each stdin line against `expect_outbound`, using exact-keys structural match with `<any>`/`<workspace>` placeholders.
  - It writes `emit_inbound` lines to stdout and ends on `runtime_exit`.
  - Afterwards the test asserts `cursor === total && !failure` from the status file.
- **For one-way CLIs** (for example `claude -p --output-format stream-json` or grok headless), where stdin only carries the prompt and args, `expect_outbound` can assert the argv/stdin prompt once. After that the transcript is mostly `emit_inbound` lines with optional `afterMs`.
- **Determinism hinges on two things:**
  - A **single injectable clock and seeded id source** in production code. Solenta's memory notes a flaky injected-clock race in the electron tests, which T3 avoids by banning `Date.now`/`crypto.randomUUID` outside Effect services.
  - **Labelled gates** to pause at a frame, instead of sleeps.
- **Restart testing without process kill:**
  - Run phase 1 and phase 2 as two runtime instances over the same on-disk store and the same transcript cursor.
  - Simulate a crash by splicing `runtime_exit` into a recorded transcript and hand-writing the resume frames.
  - Assert on the persisted store, not on calls.
  - This maps directly to Solenta's restart and wake-up issue.

### Gaps
- The per-provider recorder internals for Codex (1,656 lines) and Claude (609 lines) were only skimmed. How often fixtures are re-recorded, and whether CI checks for stale fixtures, was not found.
- CI runtime and flakiness for the replay suites were not found. `OrchestratorScenario`'s 60 s deadline comment implies slow CI runners have been an issue, but no data was located.
