# T3 Code Orchestrator V2: delegation and parent wake-up, traced in the source

**Snapshot analyzed:** `pingdotgg/t3code` main at **`eac52f0087d9ba5dee5542f24788d1482affae43`** (2026-10-04 08:37 UTC, "fix(client-runtime): closing a busy stream no longer drops the connection (#15563)").
- `git fetch origin main` on 2026-10-04 and `gh api repos/pingdotgg/t3code/commits/main` both return this same SHA.
- **Nothing in `orchestration-v2/`, `mcp/`, or the contracts has changed since the first research round (eac52f0).** Every line number below is valid for that SHA.

**Conventions:**
- Link base: `R = https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43`.
- "[main]" means code that is on main at this SHA. "[open PR]" means a proposed change that is not merged.
- This note builds on the first-round architecture overview (`t3code_orchestrator_architecture.md`) and does not repeat it.

---

## 1. End-to-end trace of `delegate_task`: MCP call → auth → command → planner → child run → child session → completion → parent result → parent wake

### Takeaway
Delegation is ten hops. Only two of them do I/O: the provider-turn effect and the provider continuation. Everything else is pure planning inside per-thread locks.
1. A provider CLI calls the HTTP MCP tool with a per-session bearer token.
2. `OrchestratorMcpService.delegateTask` validates the call (active parent run, privilege ceiling) and dispatches one `delegated_task.request` command under the **parent** thread lock.
3. `dispatchDelegatedTaskRequest` plans, in one transaction:
   - the child thread;
   - the parent subagent row, node, and turn item;
   - a nested `message.dispatch(start_immediately)` on the child, which enqueues a `provider-turn.start` effect;
   - a consumed `subagent_spawn` transfer.
4. The effect worker opens the child's provider session and mints the child's own MCP credential.
5. When the child's run turns terminal, a `run.updated` stream listener calls `finalizeAppOwnedSubagent` under the parent lock. It publishes the result **once** and plans a wake through a durable "cohort" on the parent run.
6. An in-memory continuation queue turns that wake into a server-authored `message.dispatch`. The parent is steered if its provider supports active steering, and queued otherwise.

### Cited Findings
**Hop 0: credential minted when the provider session opens [main]**
- `ProviderSessionManager` revokes any older credential for the thread, then calls `mcpSessionRegistry.issue({threadId, providerInstanceId, browserToolsAvailable, capabilities})` and stores the config for the adapter to inject — [ProviderSessionManager.ts L482-L491](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L482-L491)
- `issue` generates a fresh `providerSessionId = randomUUIDv4` and a 32-byte base64url token, and stores only `SHA-256(token)` in a `SynchronizedRef<Map>`. The scope `{environmentId, threadId, providerSessionId, providerInstanceId, capabilities}` always includes `orchestration`, `worktree`, and `pull-requests` — [McpSessionRegistry.ts L123-L161](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/McpSessionRegistry.ts#L123-L161)
- Liveness: a credential dies 24 h after its last sign of life (`DEFAULT_LIVENESS_WINDOW_MS`). MCP traffic and `touch` on every provider turn refresh it. "`/mcp` is mounted outside the environment auth stack… this token is the only thing guarding the `t3-code` toolkits" — [McpSessionRegistry.ts L67-L81](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/McpSessionRegistry.ts#L67-L81); touch call in [RunExecutionService.ts L1344](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/RunExecutionService.ts#L1344)
- How the endpoint is injected:
  - Claude: `mcpServers["t3-code"] = {type:"http", url, headers:{Authorization}, timeout: CLAUDE_T3_MCP_TOOL_TIMEOUT_MS}` — [ClaudeAdapterV2.ts L962-L990](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L962-L990)
  - Codex: `config.mcp_servers["t3-code"] = {url, http_headers:{Authorization}}` — [CodexAdapterV2.ts L1199-L1229](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L1199-L1229)

**Hop 1: HTTP auth middleware [main]**
- The middleware strips `Bearer `, calls `registry.resolve(token)` (hash lookup, which also refreshes `lastAliveAt`), and returns 401 on a miss with a logged reason (`missing_bearer_token` / `unknown_or_expired_token`). On success it provides `McpInvocationContext` to the handler — [McpHttpServer.ts L102-L128](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/McpHttpServer.ts#L102-L128); [McpSessionRegistry.ts L163-L177](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/McpSessionRegistry.ts#L163-L177); scope type in [McpInvocationContext.ts L20-L27](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/McpInvocationContext.ts#L20-L27)

**Hop 2: tool handler → service [main]**
- `delegate_task: (input) => service.delegateTask(scope, input)`, where `scope` comes from `McpInvocationContext` — [handlers.ts L15-L20](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/toolkits/orchestrator/handlers.ts#L15-L20)
- Input schema: `{task, target?{providerInstanceId, driverKind, model, options}, title?, role?, mode?: "async"|"wait", timeoutMs?, clientRequestId?, runtimeMode?, interactionMode?}` — [orchestratorMcp.ts L169-L189](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestratorMcp.ts#L169-L189)

**Hop 3: `OrchestratorMcpService.delegateTask` [main]** — [OrchestratorMcpService.ts L1369-L1493](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/OrchestratorMcpService.ts#L1369-L1493)
- The steps, in order:
  1. `requireCapability(scope)` checks the `orchestration` capability.
  2. `loadProjection(scope.threadId)` loads the parent.
  3. It picks the newest active parent run and fails `parent_not_active` unless that run has a `rootNodeId` and `parentRun.providerInstanceId === scope.providerInstanceId`.
  4. `resolveTarget` picks the provider and model.
  5. `resolveRuntimeMode` / `resolveInteractionMode` enforce the privilege ceiling (section 6).
  6. `requestKey(clientRequestId ?? randomUUID)` produces the request key.
  7. `stableCommandId` builds the command id.
  8. `threadManagement.dispatch({type:"delegated_task.request", …, completionWake})` sends the command.
  9. It picks the `subagent.updated` (app_owned) event out of `result.storedEvents` to get `taskId`.
- Command id = `command:mcp:<scope.providerSessionId>:delegate-task:<requestKey>`, with each part URI-encoded — [OrchestratorMcpService.ts L479-L495](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/OrchestratorMcpService.ts#L479-L495)
- A `role` other than `general` prepends `Act as the ${role} sub-agent for this task.\n\n` to the task — [OrchestratorMcpService.ts L556-L560](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/OrchestratorMcpService.ts#L556-L560)

**Hop 4: `ThreadManagementService.dispatch` → `Orchestrator.dispatch` [main]**
- `dispatch = (command) => ensureCommandTranscripts(command).pipe(Effect.andThen(orchestrator.dispatch(command)))` — [ThreadManagementService.ts L447-L448](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ThreadManagementService.ts#L447-L448)
- Lock routing: `delegated_task.request`, `.wake-policy`, `.completion-delivery.acknowledge`, and `.completion-delivery.dispose` all lock on `command.parentThreadId`. `dispatchWithReceipt = threadDispatch.withLock(commandThreadId(command), …)` — [Orchestrator.ts L418-L422](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L418-L422); [L9863-L9864](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9863-L9864)

**Hop 5: planner `dispatchDelegatedTaskRequest` [main]** — [Orchestrator.ts L6313-L6574](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L6313-L6574)
- It re-checks that the parent run `isBlockingRun` and that the parent node belongs to it (L6337-L6360).
- It derives `taskNodeId`, `childThreadId`, `childMessageId`, and `taskTurnItemId` from `command.commandId` (L6374-L6385). The id formats are `node:delegated-task:<commandId>`, `thread:delegated-task:<commandId>`, and so on — [IdAllocator.ts L394-L401](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/IdAllocator.ts#L394-L401)
- Child thread = `makeSubagentChildThread({...parentThread, …})` with the command's `runtimeMode`/`interactionMode` (L6392-L6407).
- Subagent row (L6408-L6429): `{origin:"app_owned", childThreadId, prompt, completionWake, status:"running", result:null}`.
- Parent `node.updated` (L6430-L6446): `{kind:"subagent", countsForRun:false}`.
- It emits `thread.created`, `node.updated`, `subagent.updated`, and `turn-item.updated` (L6474-L6511).
- It then calls `dispatchMessage({type:"message.dispatch", threadId: childThreadId, senderThreadId: parent, text: task, dispatchMode:{type:"start_immediately"}})` inside the **same** events/effects batch, reusing the same `commandId` (L6513-L6526).
- It emits `context-transfer.created` of type `subagent_spawn`, status `consumed`, `targetRunId: childRun.id` (L6537-L6572).

**Hop 6: child run start effect [main]**
- `dispatchMessage` (Orchestrator.ts L4305 onward) ends by appending the outbox effect `effect:<commandId>:provider-turn.start:<runId>` — [Orchestrator.ts L6304-L6310](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L6304-L6310)
- `EffectWorker` routes `provider-turn.start` to `providerTurnStart.start({threadId, runId, willRetry})` — [EffectWorker.ts L152-L154](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EffectWorker.ts#L152-L154)
- `ProviderTurnStartService` opens the session with `providerSessions.open(...)` (L526). That repeats hop 0 for the **child** thread, so the child gets its own token and can delegate in turn — [ProviderTurnStartService.ts L526](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderTurnStartService.ts#L526)

**Hop 7: child terminal [main]**
- `RunExecutionService` persists a root `turn.terminal` of `completed` as **`waiting`** (post-terminal drain while the checkpoint is captured). Other statuses are persisted as-is — [RunExecutionService.ts L634-L651](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/RunExecutionService.ts#L634-L651)
- The orchestrator subscribes to `run.updated` events after the current high-water mark. It filters to terminal statuses (`completed|interrupted|failed|cancelled|rolled_back`) and skips `command:runtime-reconcile:*` — [Orchestrator.ts L9904-L9925](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9904-L9925)
- `handleTerminalRun` runs three steps sequentially, each under its own lock: `finalizeAppOwnedSubagent(child)` under the **parent** lock, then `finalizeDelegatedCompletionDelivery` under this thread's lock, then `startNextQueuedRun`. Its comment: locks are "sequentially and never nested… the keyed executor's semaphores are neither reentrant nor deadlock-aware" — [Orchestrator.ts L9866-L9902](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9866-L9902)

**Hop 8: result recorded on parent [main]** — `finalizeAppOwnedSubagent` [Orchestrator.ts L8858-L9148](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L8858-L9148)
- Gates:
  - lineage must be `subagent` with `forkedFrom.type==="node"`;
  - `delegatedTaskProgress(child).state === "result_available"`, which means no active child run, no live grandchildren, no pending or claimed grandchild deliveries, and no pending native background tasks ([SubagentProjection.ts L207-L253](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/SubagentProjection.ts#L207-L253));
  - the child is not awaiting a restart continuation;
  - **no existing `subagent_result` transfer for the (child, parent) pair** (L8933-L8941).
- It then writes one batch through `writeSystemEvents`:
  - `subagent.updated` (status, `result` text, `completionDelivery` from the planner);
  - optionally the parent `run.updated` (cohort) and the wake `message.updated`;
  - parent `node.updated` and `turn-item.updated` (terminal plus result);
  - `context-handoff.updated` (`strategy:"manual_context"`, `summaryText = result`);
  - a consumed `subagent_result` `context-transfer.created`.
- Finally it calls `offerDelegatedCompletionDelivery` if the planner said `offer` (L9145-L9147).
- Result text: the error turn item's message if the run failed, else the latest non-empty assistant message, else `"Child task completed without an assistant result."` or `"Child task ended with status ${run.status}."` — [SubagentProjection.ts L156-L205](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/SubagentProjection.ts#L156-L205)

**Hop 9: wake offer → mailbox → parent turn [main]** (detail in section 2)
- `offerDelegatedCompletionDelivery` puts `{threadId, providerThreadId, delivery:"message_text", delegatedCompletion:{parentRunId, generation, messageId}}` onto `ProviderContinuationRequests` — [Orchestrator.ts L976-L1020](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L976-L1020)
- `ProviderContinuationService` re-reads the cohort and dispatches `message.dispatch` (`createdBy:"agent"`, `creationSource:"server"`, `queue_after_active`, `delegatedCompletion`) — [ProviderContinuationService.ts L115-L147](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderContinuationService.ts#L115-L147)
- `dispatchMessage` upgrades the dispatch to `steer_active` when possible, otherwise queues it — [Orchestrator.ts L4565-L4599](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L4565-L4599)

**Startup recovery [main]**
- Order: reconciliation → `recoverDelegatedTasks` → effect worker — [serverRuntimeStartup.ts L402-L410](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/serverRuntimeStartup.ts#L402-L410)
- `recoverDelegatedTasks` does two scans:
  - It runs `finalizeAppOwnedSubagent` for every child thread that is terminal and has no `subagent_result`. SQL: `json_extract(payload,'$.lineage.relationshipToParent')='subagent'`.
  - It re-finalizes and re-offers every run whose `delegatedCompletion.delivery` is an object.
  - Sources: [Orchestrator.ts L9932-L10019](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9932-L10019); [ProjectionStore.ts L501-L516, L3406-L3419](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProjectionStore.ts#L501-L516)
- **Doc/code mismatch:** the design doc says finalization runs because "The event stream first replays persisted events and then follows live events" — [orchestrator-mcp-server.md L423-L426](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md#L423-L426). The code instead subscribes from the latest sequence ("Replaying the full event table on every server start delays live queue promotion"). Pre-boot terminals are covered by the explicit recovery scan above.

### Inferences
- The reusable shape for Solenta is "**MCP ingress → one idempotent command under the parent lock → child thread plus start effect in the same commit → terminal listener → finalize under the parent lock**".
- Solenta's `thread_fork` already has the ingress and the worker. What it lacks is the atomic commit, deterministic child ids, and a parent-side publish latch.
- Deriving the child's thread, node, message, and turn-item ids from the command id means a retried `delegate_task` cannot double-spawn.
- There is a caveat: the command id embeds `scope.providerSessionId`, which is the **credential's** random UUID (McpSessionRegistry L126), not a stable session id. A retry after the credential rotates (session reopened) would mint a new command id and spawn a second child. This is inferred from the code; no test or issue was found that confirms it.

### Gaps
- `resolveTarget` (provider and model selection, around L889-L1005) and `ensureCommandTranscripts` were not read line by line.
- `ProviderTurnStartService.start` was read only around session open and handoff selection. The exact prompt wrapping for a child's first run (`t3OrchestrationPromptForFirstRun`) was confirmed in [T3OrchestrationInstructions.ts L94-L102](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/T3OrchestrationInstructions.ts#L94-L102), but its call site was not.

---

## 2. The wake "mailbox": data structure, persistence, `completionWake`, batching, steer vs queue, the text the parent receives, dedupe

### Takeaway
The mailbox is **durable state on projection rows plus an in-memory offer queue**:
- **Durable state:**
  - The parent **run** carries a cohort: `delegatedCompletion = {disposition: open|stopped|disposed, nextGeneration, delivery: {generation, messageId, taskIds[]} | null}`.
  - Each **subagent row** carries `completionDelivery.state ∈ pending|claimed|acknowledged|delivered|disposed`.
  - The wake **message** carries `delegatedCompletion` ownership `{parentRunId, generation, taskIds}`.
- **In-memory queue:** an unbounded Effect `Queue` (`ProviderContinuationRequests`), drained by `ProviderContinuationService`. It only carries pointers, and every consumer re-reads and re-validates the durable cohort under the thread lock. A lost offer is therefore recoverable (startup re-offers) and a stale one is dropped.
- **Content:** the parent never receives the child's result in the wake. It receives a fixed pointer sentence and must call `task_status`, and reading `task_status` acknowledges the delivery and can cancel a still-queued wake.
- **Delivery:** the wake is steered into a running turn only when every task in the batch is `completionWake:"always"` and the live session advertises `supportsActiveSteering`. Otherwise it is queued, and queued wakes jump ahead of user-queued runs.

### Cited Findings
**Schemas [main]**
- `OrchestrationV2DelegatedCompletionTaskDeliveryState = "pending"|"claimed"|"acknowledged"|"delivered"|"disposed"`.
- Delivery `{generation: PositiveInt, messageId, taskIds: NodeId[]}`.
- Cohort `{disposition: "open"|"stopped"|"disposed", nextGeneration, delivery | null}`.
- The cohort sits on `Run.delegatedCompletion`.
- Sources: [orchestrationV2.ts L460-L491](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L460-L491); [L574](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L574)
- Subagent fields: `completionWake?: "always"|"settled_only"` and `completionDelivery?`. Contract comment: "'always' offers a continuation on every terminal (async delegations; queue_after_active sequences it behind a live parent run), 'settled_only' offers only when the parent has no live run (wait-mode delegations…). Absent on legacy records; treated as settled_only" — [orchestrationV2.ts L656-L693](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L656-L693)

**The offer queue is in memory [main]**
- `Queue.unbounded<ProviderContinuationRequest>()`, with `offer`/`take`.
- The request carries `delivery: "adapter_buffered"|"message_text"`. `message_text` "is for app-owned work with no buffered provider output, such as a delegated child finishing. The text is the entire wake".
- The default reference drops offers, which is only for tests.
- Source: [ProviderContinuationRequests.ts L15-L76](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderContinuationRequests.ts#L15-L76)

**Policy selection [main]**
- `completionWake: input.mode === "wait" ? "settled_only" : "always"`. Comment: "wait delegations deliver through the blocking tool call, so a wake is only needed if the parent settled first (timeout, disconnect)" — [OrchestratorMcpService.ts L1417-L1420](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/OrchestratorMcpService.ts#L1417-L1420)
- "Live" means `preparing|starting|running`. A run parked at `waiting` is "post-terminal drain, so its agent turn is over and a wake is still needed" — [Orchestrator.ts L464-L473](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L464-L473)

**Planner `planDelegatedCompletionDelivery` [main]** — [Orchestrator.ts L8652-L8846](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L8652-L8846). It returns `{task, parentRun?, message?, offer}`:
1. If the task is already `acknowledged|delivered|disposed`, it does nothing (L8667-L8678).
2. If the parent run is missing, the parent is archived or deleted, or the cohort is not `open`, the task is marked `disposed` (L8679-L8698).
3. If the task is `settled_only` and the spawning parent run is live, there is no offer; the blocking wait owns delivery (L8699-L8712).
4. If an outstanding delivery exists:
   - When its wake run is still `queued`, the task **joins** it: `taskIds = union`, the message text is rewritten, the task is `claimed`, and there is no new offer (L8716-L8754).
   - When the wake run is in flight (blocking) or already exists, the task is marked `pending` for the successor (L8755-L8786).
   - Otherwise it joins the existing delivery and offers it (L8787-L8809).
5. With no delivery, it opens generation `nextGeneration ?? 1` with a freshly allocated `messageId`, marks the task `claimed`, and sets `offer:true` (L8812-L8845).

**Batching successors [main]**
- When a wake run turns terminal, `finalizeDelegatedCompletionDelivery` marks that delivery's `claimed` tasks `delivered`, or `pending` if the wake run was cancelled.
- It then reserves **one** successor delivery (next generation) for all `pending` siblings, and offers it.
- Comment: "Results that arrived while this delivery was outstanding go out together in one successor. Each child becomes pending once, so a cohort's successors are bounded by its children."
- Source: [Orchestrator.ts L9150-L9291](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9150-L9291)
- History: this replaced a lifetime cap. Issue #12285 ("delegate_task async completions are silently starved after two wake deliveries per cohort", `settledDeliveryCount >= 2`) was fixed by #13938 before the merge; `settledDeliveryCount` no longer appears in the tree — [Issue #12285](https://github.com/pingdotgg/t3code/issues/12285)

**Steer acceptance batches too [main]**
- After a successful `provider-turn.steer` of a delegated-completion message, the effect worker dispatches `notification.delivery.accept` (`commandId: command:mailbox-accepted:<effectId>`) — [EffectWorker.ts L197-L224](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EffectWorker.ts#L197-L224)
- `dispatchNotificationAccepted` then:
  - marks the accepted tasks `delivered`;
  - folds `pending` siblings into the next generation (only `completionWake==="always"` ones while the parent is live);
  - notes "Provider acceptance drains this batch but does not acknowledge its results. task_status owns acknowledgment";
  - on commit, re-offers.
  - Sources: [Orchestrator.ts L9293-L9389](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9293-L9389); [L9850-L9855](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9850-L9855)
- Test "acceptance batches pending siblings without acknowledging their results": after accept, the first task is `delivered`, the cohort's delivery becomes `{generation:2, taskIds:[second, third]}`, both are `claimed`, and repeating the old acceptance leaves the cohort unchanged — [DelegatedCompletionDelivery.test.ts L296-L387](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts#L296-L387)

**Consumer [main]: `ProviderContinuationService.workerLive`**
- `requests.take` → `dispatchContinuation`, forever.
- It drops the request if the thread is archived or deleted.
- For delegated completions, it validates through `currentDelegatedCompletionDelivery`: the cohort must be `open`, `delivery.generation` and `messageId` must match the request, and the message must not already exist unless it is an undelivered steer.
- It then dispatches with the **reserved** `messageId`.
- On failure it retries with in-memory backoff `min(100·2^min(attempt,6), 5000)` ms, rechecking the cohort before re-offering.
- Sources: [ProviderContinuationService.ts L20-L51, L60-L233](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderContinuationService.ts#L20-L233)

**Steer vs queue decision [main]** — inside `dispatchMessage`, under the parent thread lock:
- A delegated-completion message must be `createdBy:"agent"`, `creationSource:"server"`, `queue_after_active`, and must match the live cohort (generation and messageId), else it is rejected "no longer dispatchable" (L4527-L4564).
- Then, "Route durable mailbox deliveries under the thread lock, using the live session's capabilities. Never interrupt/restart a turn for a notification". It switches to `steer_active{targetRunId}` only if all of these hold:
  - every task is `completionWake==="always"`;
  - a run is `running` with a `running` provider turn and a live provider session;
  - the active message is not a native maintenance command;
  - `session.capabilities.turns.supportsActiveSteering` (L4565-L4599).
- Otherwise it queues: a new run with `queue_after_active` behind the blocking run (L4685-L4695).
- Source: [Orchestrator.ts L4524-L4695](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L4524-L4695)
- Queue priority: `queuedRunsInDeliveryOrder` sorts runs whose user message has `delegatedCompletion` **ahead** of other queued runs, then by `queuePosition`/ordinal — [QueuedRunOrder.ts L12-L32](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/QueuedRunOrder.ts#L12-L32)
- A wake run keeps the `workStartedAt` of the work it continues ("delegated results jump the queue") — [Orchestrator.ts L324-L345](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L324-L345)
- Steer that lands too late: if the steer fails because the turn already completed, the worker re-dispatches the **same `messageId`** as a follow-up `message.dispatch` under `command:steer-follow-up:<effectId>`. "A delegated completion stays pinned to the run it reports to" — [EffectWorker.ts L226-L259](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EffectWorker.ts#L226-L259)

**What the parent actually receives [main]** — the whole wake text:
```ts
function delegatedCompletionWakeDetail(taskIds: ReadonlyArray<string>): string {
  const taskList = taskIds.join(", ");
  return taskIds.length === 1
    ? `Delegated task ${taskList} reached a terminal state. Use task_status with taskId ${taskList} to read the result.`
    : `Delegated tasks ${taskList} reached terminal states. Use task_status with each taskId to read the results.`;
}
```
- Sources: [Orchestrator.ts L504-L509](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L504-L509); duplicated as `delegatedCompletionText` in [ProviderContinuationService.ts L13-L18](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderContinuationService.ts#L13-L18)
- `dispatchMessage` forces this text for delegated completions (`dispatchText = delegatedCompletion === undefined ? command.text : delegatedCompletionWakeDetail(taskIds)`) — [Orchestrator.ts L4600-L4603](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L4600-L4603)
- On Claude, a steer is sent to the SDK as a user message with `priority: "now"` (no sender check), per the triage of #15351 — [Issue #15351](https://github.com/pingdotgg/t3code/issues/15351); `priority: "now"` at [ClaudeAdapterV2.ts L7347](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L7347)
- The result handoff (`manual_context`, `summaryText = result`) recorded at finalize has `targetRunId = spawning parent run`. `ProviderTurnStartService` only prepends `ready` handoffs whose `targetRunId` is the starting run, or (same provider thread) whose source run failed or was interrupted, or a `/compact` case. So in the normal async case the result text is **not** injected into the wake turn — [ProviderTurnStartService.ts L240-L258](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderTurnStartService.ts#L240-L258)
- The agent-facing contract matches: "An async child's completion wakes this thread through a notification, steered into active turns where supported or queued otherwise, so end the turn instead of polling or spawning watchers" — [tools.ts L60](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/toolkits/orchestrator/tools.ts#L60)

**Dedupe rules [main]**
1. **Publish latch:** finalize returns early if any `subagent_result` transfer exists for the (child, parent) pair, so a result is published once per task ever — [Orchestrator.ts L8933-L8941](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L8933-L8941)
2. **No re-claim** after `acknowledged|delivered|disposed` — [L8665-L8678](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L8665-L8678)
3. **Join instead of a second wake** when a queued delivery exists (rule 4 of the planner above).
4. **Generation plus reserved messageId** guard at the consumer and at dispatch, so stale offers are dropped.
5. **At-least-once steer:** "Delivery is at least once: provider acceptance and our receipt cannot commit atomically. Reusing the message ID keeps recovery from duplicating timeline items" (`isUndeliveredMailboxSteer`) — [NotificationMailbox.ts L3-L23](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/NotificationMailbox.ts#L3-L23)
6. **Reading acknowledges:**
   - `task_status` (and `t3_thread_read` on the child) dispatch `delegated_task.completion-delivery.acknowledge` with `observedByRunId` — [OrchestratorMcpService.ts L1132-L1163](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/OrchestratorMcpService.ts#L1132-L1163)
   - The handler removes the task from the outstanding delivery. If the delivery is still queued and becomes empty, it **cancels the queued wake run**; otherwise it rewrites the wake text to the remaining ids. Re-acknowledging is an idempotent re-emit — [Orchestrator.ts L1880-L2007](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L1880-L2007)
   - The integration test asserts the queued wake run becomes `cancelled` and the task becomes `acknowledged` with `observedByRunId: parentRun.id` after a direct read — [OrchestratorMcpToolkit.integration.test.ts L1095-L1108](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts#L1095-L1108)
7. **Wake-policy upgrade:** "Plan a delivery only when that run is live now, which is precisely the case where finalize skipped… When that run is not live, finalize already offered and a second offer would wake the parent twice. (If the parent settled in between, this skips a wake that finalize also skipped; a missed wake is cheaper than a duplicate one, and the result is already in the projection.)" — [Orchestrator.ts L6624-L6651](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L6624-L6651)

### Inferences
- **Pattern to copy for Solenta's "orch notices":**
  - Keep the durable truth on rows: a cohort on the lead's turn and a state per worker task. The in-process notice queue then becomes a disposable hint that every consumer re-validates against (generation, messageId).
  - Solenta's current in-memory notices are lost on restart and cannot be deduped. T3's design makes "re-offer everything with an open delivery at boot" safe.
- The **pointer-only wake** ("reached a terminal state… use task_status") keeps steering cheap and lets "read = acknowledge" cancel a queued wake. This is the main dedupe lever, because a lead that already polled is not woken again.
- The **"jump the queue"** priority ensures a lead consumes worker results before any user follow-up queued behind it.

### Gaps
- No test was found that drives a real provider steer of a wake end to end (CLI acceptance timing). PR #14732 (open) adds `DelegatedSteerSettlement.integration.test.ts` for the "steer never landed" case — [PR #14732](https://github.com/pingdotgg/t3code/pull/14732)
- The in-memory retry chain has no bound on main. PR #15311 (open draft) bounds it to 8 retries — [PR #15311](https://github.com/pingdotgg/t3code/pull/15311)

---

## 3. `task_status`, `task_cancel`, Stop propagation, and parent archive or delete

### Takeaway
- `task_status` is a projection read. It derives the task status from the original child run and `delegatedTaskProgress`, publishes `summary` once, exposes later child turns as `latestTerminal*`, and **acknowledges** a terminal result.
- `task_cancel` dispatches `run.interrupt` on the child's active run and **disposes** the parent delivery.
- Parent **Stop**, **archive**, and **delete** never interrupt app-owned child threads. They only dispose the wake cohort (stop: `disposition "stopped"`; archive and delete: `"disposed"`), so a finished child cannot start a new parent turn.
- Children keep running in their own threads, which are hidden from the sidebar. Native provider subagents are different: they are reached because Stop interrupts the parent's provider turn, and Codex also interrupts its native child turns.

### Cited Findings
**`task_status` [main]** — `readTask(scope, taskId, waitTimedOut=false, acknowledgeTerminal=true)` [OrchestratorMcpService.ts L1012-L1165](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/OrchestratorMcpService.ts#L1012-L1165)
- Ownership: the task must be `app_owned` with `threadId === scope.threadId`, else `task_not_found`.
- The delegated run is the `subagent_spawn` transfer's `targetRunId` (`delegatedTaskRun`, L300-L317).
- Status mapping: `rolled_back` → `cancelled`; `preparing|starting|running` → `running` (L275-L298).
- `heldForRestart` keeps `workState:"working"` while a restart continuation is pending (L1062-L1071).
- `hasPendingChildRuns` = any non-terminal child run with an ordinal after the delegated run (L319-L328).
- Tool text: "Reading a terminal result acknowledges its automatic parent delivery… a completed turn with live nested work is not a completed task" — [tools.ts L71-L73](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/toolkits/orchestrator/tools.ts#L71-L73)

**`task_cancel` [main]** — [OrchestratorMcpService.ts L1495-L1575](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/OrchestratorMcpService.ts#L1495-L1575)
- It always prepares `delegated_task.completion-delivery.dispose`.
- If the task is already terminal, it disposes and returns the status. "Published task results stay terminal. Later child-thread messages do not reopen the task, so cancelling it must not interrupt those separate runs."
- Otherwise it requires `latestActiveRun(child)` (else `task_not_cancellable`), dispatches `run.interrupt{threadId: child, runId}`, disposes (best effort), and returns `cancel_requested`.

**Parent Stop (`run.interrupt` on the parent) [main]** — [Orchestrator.ts L7995-L8065](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L7995-L8065)
- `completionCohortRunId = completionMessage?.delegatedCompletion?.parentRunId ?? run.id`.
- `stopCompletionCohort` calls `disposeDelegatedCompletionCohort({disposition:"stopped"})`, which:
  - sets the cohort to `{disposition, delivery:null}`;
  - marks every un-settled app-owned task of that run `completionDelivery:{state:"disposed"}`;
  - cancels a queued wake run.
  - Source: [Orchestrator.ts L2009-L2090](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L2009-L2090)
- No code path dispatches `run.interrupt` to `subagent.childThreadId`. The only lineage-aware server code is finalize and recovery; a grep for `relationshipToParent` across `apps/server/src` finds no cascade. Maintainer triage confirms: "Stopping doesn't cancel the child thread" — [Issue #15325](https://github.com/pingdotgg/t3code/issues/15325)
- Background work: Stop also interrupts other live provider threads that own pending background work. "a native subagent item names its own provider thread but its parent's turn; interrupting the parent's turn reaches the subagent" — [Orchestrator.ts L8233-L8249](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L8233-L8249)
- After each `provider-turn.interrupt`, the worker dispatches `thread.background-work.settle` (`commandId = ${effect.id}:background-work-settled`) to end leftover work that no process will report ending — [EffectWorker.ts L165-L196](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EffectWorker.ts#L165-L196); settle logic at [Orchestrator.ts L7859-L7993](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L7859-L7993)
- Codex also sends `turn/interrupt` to newly discovered active native child turns, bounded by a 10 s timeout — [CodexAdapterV2.ts L5786-L5822](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L5786-L5822)
- Native subagents still open when the parent run turns terminal (interrupted, failed, or cancelled) are cascade-terminalized (`cascadeTerminalizeRunOwnedSubagents`). This uses the adapter-stream snapshot of run-owned subagents — [RunExecutionService.ts L167-L171, L205, L618-L633, L1028-L1043](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/RunExecutionService.ts#L618-L633)

**Issue #11428 [V1, closed]**
- The bug: Stop on background work left the thread stuck in "Monitoring"/"Stopping...". It was a V1 Antigravity adapter whose `interruptTurn` did not stop promoted background commands.
- The fix was #13388: "Antigravity `interruptTurn` now stops the session when Stop is pressed with no active prompt".
- V2's generic answer is the `thread.background-work.settle` follow-up above.
- Source: [Issue #11428](https://github.com/pingdotgg/t3code/issues/11428)

**Archive [main]**
- `thread.archive`:
  - cancels the parent's active runs, attempts, and nodes;
  - runs `disposeAllDelegatedCompletionCohorts({cancelQueuedDelivery:false})`, which disposes every cohort and task;
  - detaches all live provider sessions ("Settle joins archive here… a live provider session must not keep running background work (PR monitors, dev servers, subagent fleets)").
- Source: [Orchestrator.ts L3135-L3240](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L3135-L3240); [L2092-L2120](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L2092-L2120)
- The planner refuses and disposes when `thread.archivedAt`/`deletedAt` is set (L8682-L8683), and the continuation worker drops archived threads — [ProviderContinuationService.ts L95-L114](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderContinuationService.ts#L95-L114)

**Delete [main]**
- `planThreadDeletion` emits `thread.deleted`, cancels active runs, attempts, nodes, and pending runtime requests (`not_resumable`), and disposes every cohort and task.
- It also emits a `provider-session.detach` effect with `revokeMcpCredential: true` for the deleted thread's own sessions, plus terminal and attachment cleanup.
- It never touches child threads.
- Source: [ThreadDeletion.ts L57-L227](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ThreadDeletion.ts#L57-L227)

**Child visibility**
- Subagent threads are filtered out of project thread lists (`includeSubagents || relationshipToParent !== "subagent"`) — [ThreadManagementService.ts L514](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ThreadManagementService.ts#L514)
- The issue reporter observed that "Subagent threads are hidden from the sidebar and the mobile thread list" — [Issue #15082](https://github.com/pingdotgg/t3code/issues/15082)

**Open PRs**
- #15331 (open): Stop on a completion-wake run should dispose both the incoming cohort and the wake run's own cohort (`new Set([completionCohortRunId, run.id])`) — [PR #15331](https://github.com/pingdotgg/t3code/pull/15331)
- #15211 (open): Lineage stop button that "interrupts T3-owned child runs and native Codex child turns"; per-child native stop is Codex-only — [PR #15211](https://github.com/pingdotgg/t3code/pull/15211)
- #15004 (open): "Stop reads active child interrupt targets from the parent projection… Stop and archive still dispose their delivery" — [PR #15004](https://github.com/pingdotgg/t3code/pull/15004)

### Inferences
- T3 separates **"stop waking me"** (cohort disposal, which is cheap and durable) from **"stop the child"** (an explicit `task_cancel` or a per-child interrupt).
- For Solenta, whose leads fork workers into separate worktrees and threads, the T3 default is that stopping or archiving a lead silences worker notices but leaves workers running. That is a deliberate product choice. Solenta should decide explicitly whether lead Stop cascades, and whatever it chooses it should copy the "dispose cohort" step, so a late worker cannot restart a lead the user stopped.
- The #15325 bug shows the subtle part: a wake run is itself a parent run that can delegate. Disposal must cover both the cohort the wake came from and the cohort the wake run started.

### Gaps
- Behavior when a **child** thread is deleted while its parent waits was not traced. The planner keys on the parent projection, and recovery only scans existing child threads. It is unclear whether the parent subagent row stays `running` forever.
- The web Stop button's exact command path for app-owned children (vs `run.interrupt` on the parent) was not traced in `apps/web`.

---

## 4. `mode: "wait"` vs `mode: "async"`

### Takeaway
- **async** returns `readTask` immediately with `completionWake:"always"`.
- **wait** blocks the MCP HTTP request **server-side**. It polls the projection every **50 ms**, default budget 10 min, capped at 60 min.
- If the wait reaches a terminal state, the result comes back in the tool response, and the read acknowledges the delivery so no wake follows.
- On timeout it returns `waitTimedOut:true` (the child keeps running) and upgrades the task to `completionWake:"always"` so a later terminal wakes the parent even mid-turn.
- If the client disconnects first, `settled_only` still wakes the parent once its spawning turn has ended.
- Claude's client-side MCP timeout is raised to 65 min to fit. Codex's is not configured.

### Cited Findings
- Constants: `DEFAULT_WAIT_TIMEOUT_MS = 10*60*1000`, `MAX_WAIT_TIMEOUT_MS = 60*60*1000`, `TASK_POLL_INTERVAL_MS = 50` — [OrchestratorMcpService.ts L75-L77](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/OrchestratorMcpService.ts#L75-L77)
- `waitForTask` is a loop `readTask(scope, taskId, false, true)` that returns when `isTerminalTaskStatus(result.status)`, then sleeps 50 ms; the whole loop is wrapped in `Effect.timeoutOption`. Each iteration also acknowledges a terminal result — [OrchestratorMcpService.ts L1167-L1174](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/OrchestratorMcpService.ts#L1167-L1174)
- Timeout path: dispatch `delegated_task.wake-policy{completionWake:"always"}` with command id operation `delegate-task-wake-policy`. Failures are logged as warnings ("Best effort; on failure the settled_only policy still wakes a settled parent"). It then returns `readTask(..., waitTimedOut=true, ...)` — [OrchestratorMcpService.ts L1445-L1492](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/OrchestratorMcpService.ts#L1445-L1492)
- The wake-policy handler runs under the parent lock. It rejects no-op upgrades, and if the task is already terminal while the parent run is live, it plans a delivery immediately — [Orchestrator.ts L6576-L6672](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L6576-L6672); post-commit re-offer at [L9853-L9855](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9853-L9855)
- Wait semantics in the docs: "`mode: "wait"` waits for the task result, including nested work and completion follow-ups, or until the timeout expires. A wait timeout does not cancel the child" — [orchestrator-mcp-server.md L243-L246](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md#L243-L246)
- Claude client timeout: "Claude Code aborts an HTTP MCP call after 60 s ("The operation timed out.") unless the server config sets `timeout`. T3's wait tools… legitimately block for up to an hour… so the budget sits just above that". `CLAUDE_T3_MCP_TOOL_TIMEOUT_MS = 65*60*1000` — [ClaudeAdapterV2.ts L949-L954](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L949-L954)
- Codex injection sets only `url` and `http_headers`, with no tool timeout — [CodexAdapterV2.ts L1199-L1229](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L1199-L1229)
- Test "wakes the parent for a settled_only task once its spawning turn ended" — [DelegatedCompletionDelivery.test.ts L1211](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts#L1211)
- PR #15033 (open, by t3dotgg): "MCP waits polled SQL every 50 to 250 ms for up to an hour", to be replaced with no wait polling — [PR #15033](https://github.com/pingdotgg/t3code/pull/15033)
- A parent blocked in a long wait can lose its session. Issue #15173 (open) reports that the Claude session is idle-released after 30 min while a run waits on an app-owned child, because `releaseIfStillIdle` only defers for native `hasPendingBackgroundWork`. Stop, Settle, and queued wakes then wedge until a server restart. The maintainer confirmed it and linked it to the stranded-projection class (#14856, #14507, #14857) — [Issue #15173](https://github.com/pingdotgg/t3code/issues/15173)

### Inferences
- The `settled_only`→`always` upgrade is the key trick: blocking waits own delivery while they are alive, and the durable wake takes over afterwards. A Solenta lead that "waits" on a worker could use the same two-state flag on the worker record.
- A blocked tool call and an idle-release timer interact badly (#15173). Any session-reaper in Solenta must count "waiting on my own delegated workers" as activity.

### Gaps
- Codex's default MCP tool-call timeout was not verified from this repo. If it is shorter than `timeoutMs`, a Codex parent's wait would be cut client-side, and delivery would rely on the `settled_only` path. No issue reporting this was found.
- Whether a client disconnect interrupts the server-side wait fiber, which would skip the wake-policy upgrade, was not verified.

---

## 5. Native provider subagents (Claude Task/Agent, Codex, OpenCode, Cursor, Pi) → ExecutionNodes and Lineage child threads, and the status-truth bugs

### Takeaway
Each adapter turns its provider's native subagent signal into the same entity triple: a parent `kind:"subagent"` node, an `origin:"provider_native"` Subagent row, and a child AppThread (`lineage.relationshipToParent:"subagent"`) whose id is derived deterministically from native ids.
- **Claude:** maps every `system/task_started` except `local_bash` to a subagent. That is why a whole `Workflow` (`task_type: local_workflow`) appears as one subagent whose child thread holds only the script.
- **Codex:** registers a child per `spawnAgent` receiver thread, with its own ProviderThread.
- **Cursor** and **OpenCode 2:** derive child threads from the tool call or session.
- **Pi:** records subagents with no child thread.
- **ACP (Grok):** has no native subagents.

The status-truth bugs share a cause: native child state lives in **in-memory adapter maps** (Codex `subagentThreads`, Claude `sessionSubagentsByTaskId`) that are empty after a restart. App-owned task rows also **settle on the first result and are never reopened**.

### Cited Findings
**Capability flags [main]**
- Claude: `supportsSubagents:true, exposesSubagentThreadIds:false, emitsSubagentLifecycle:true, canWaitForSubagents:false, canCloseSubagents:false` — [ClaudeAdapterV2.ts L236-L243](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L236-L243)
- Codex: all true — [CodexAdapterV2.ts L295-L302](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L295-L302)
- Cursor: `exposesSubagentThreadIds:false, canWaitForSubagents:true` — [CursorAdapterV2.ts L141-L148](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CursorAdapterV2.ts#L141-L148)
- OpenCode 2: `exposesSubagentThreadIds:true` — [OpenCode2AdapterV2.ts L161-L168](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.ts#L161-L168)
- Pi: "T3 delegation uses the shared MCP `delegate_task` path. Installed Pi subagent extensions are observed best-effort… no resumable child id"; `childThreadId: null` — [PiAdapterV2.ts L182-L190](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts#L182-L190), [L1082](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts#L1082)
- ACP (Grok and registry agents): `supportsSubagents:false` — [AcpAdapterV2.ts L596-L603](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L596-L603)

**Claude mapping [main]**
- `task_started`: when `isClaudeNonSubagentTask(message)` (roster kinds = only `local_bash`→`command`), it goes to the background-task roster. Everything else does the following, in order:
  1. resolves the pending launch (model and owner from the `Agent` tool_use, recorded by `rememberClaudeSubagentLaunch`);
  2. marks backgrounded non-nested tasks for root wakes;
  3. calls `recoverResumedClaudeSubagent`;
  4. calls `updateClaudeSubagentNode({status:"running", reopen:true})`.
  - Sources: [ClaudeAdapterV2.ts L1715-L1759](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1715-L1759); [L2777-L2800](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L2777-L2800); [L5847-L5899](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L5847-L5899)
- `task_progress` keeps only `message.description` as `progress` — [ClaudeAdapterV2.ts L5901-L5918](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L5901-L5918)
- `task_notification` records a wake report for backgrounded subagents (`kind:"subagent"`, `childThreadId`), which drives the adapter-buffered continuation path — [ClaudeAdapterV2.ts L5920-L5955](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L5920-L5955)
- Ids: node `task:<taskId>`; child root `task:<taskId>:thread-root`; child thread from `${providerThread.id}:${taskId}`; turn item `task:<taskId>:subagent` — [ClaudeAdapterV2.ts L3644-L3661](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L3644-L3661)
- On first sight it emits `app_thread.created` (via `makeSubagentChildThread`), the parent subagent node, the child `root_turn` node, and the child's opening prompt as an agent-authored user message (`task.prompt`). Each resume adds another prompt item — [ClaudeAdapterV2.ts L4144-L4270](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L4144-L4270)
- Resume after restart: `subagentLaunchToolUseId` reads the CLI's session storage to recover the launch `parent_tool_use_id`. This is the #13735 fix, merged 2026-09-26: "a Claude subagent resumed after a server restart stays in its thread" — [ClaudeAdapterV2.ts L761-L789](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L761-L789); [PR #13735](https://github.com/pingdotgg/t3code/pull/13735)

**Codex mapping [main]**
- `subagentThreads` is an in-memory `Map<nativeThreadId, CodexSubagentThreadContext>` per session — [CodexAdapterV2.ts L1668](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L1668)
- `registerSubagentThread` creates:
  - node from `nativeItemId`;
  - child thread from `nativeThreadId`;
  - a child **ProviderThread** (`forkedFrom` the parent provider thread and turn);
  - a `provider_native` Subagent row;
  - a child AppThread.
  - It runs on `collabAgentToolCall` with `tool==="spawnAgent"`, per `receiverThreadIds`, or on `subAgentActivity` kind `started`.
  - Child `turn/started` events from unregistered threads are parked in `pendingSubagentTurns`.
  - Sources: [CodexAdapterV2.ts L2402-L2560](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L2402-L2560); [L2680-L2685](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L2680-L2685)
- Resume uses `thread/resume` with `excludeTurns: true` — [CodexAdapterV2.ts L5432-L5435](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L5432-L5435)

**Cursor [main]**: child thread derived from `${runId}:task:${callId}` — [CursorAdapterV2.ts L1532](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CursorAdapterV2.ts#L1532)

**Workflow flattening [open bug #15448; open PR #15559]**
- Maintainer triage:
  - "`isClaudeNonSubagentTask` only treats `local_bash` as non-subagent work, so `task_started` for `local_workflow` creates a `kind: "subagent"` node titled with the description."
  - "The child thread's opening message is `task_started.prompt`… For a workflow that's the script, and nothing else is appended because member agents don't emit on the parent stream."
  - "`task_progress` keeps `description` and ignores `workflow_progress`."
  - "`OrchestrationV2Subagent` has no task kind, workflow name, phases or members."
- The reporter's database showed workflow rows with 1–2 child items, versus 139–327 for `local_agent` rows. They also found that a Workflow launch is misread as a `SendMessage` resume, which triggers a `subagent.lookup` each time.
- PR #15559 "restores workflow phases and member progress".
- Sources: [Issue #15448](https://github.com/pingdotgg/t3code/issues/15448); [PR #15559](https://github.com/pingdotgg/t3code/pull/15559)

**Codex status loss after restart [open #15567]**
- Triage: "`CodexAdapterV2` keeps child registrations in `subagentThreads`, an in-memory map that starts empty for each provider session… `resumeThread` … never rebuilds existing children. After restart, a child `turn/started` from an unregistered native thread gets parked… flushed only by `registerSubagentThread`… Item and `turn/completed` events then fail in `resolveItemEventContext`… and return without projecting".
- The triage calls it "the Codex counterpart of #13735".
- Source: [Issue #15567](https://github.com/pingdotgg/t3code/issues/15567)

**Follow-up status and wake [#13331 item 2, #13490]**
- The parent subagent record "settles when the spawning run ends, and a new run on the child thread doesn't reopen it".
- [main] fix #15334 (merged 2026-10-03) changes only the client edge status: `status: threadsById.get(subagent.childThreadId)?.activityRunStatus ?? subagent.status`. The server row is still stale.
- #13490 (follow-up turns never wake the parent) is classified "Not a bug… the contract", because of the `existingResultTransfer` latch. [open PR #15004] proposes "a versioned result for every completion".
- Sources: [Issue #13331](https://github.com/pingdotgg/t3code/issues/13331); [commit d3071275](https://github.com/pingdotgg/t3code/commit/d3071275d576bb289a6cb177c6cc28fff8e95015); [Issue #13490](https://github.com/pingdotgg/t3code/issues/13490); [PR #15004](https://github.com/pingdotgg/t3code/pull/15004)

**Missing subagent telemetry [open #15429, PR #15446]**: "`OrchestrationV2Subagent` has no usage field… `projectedSubagentsToRuntime` sets `usage: null`… Claude's `task_progress` handler keeps `description` and drops `usage`" — [Issue #15429](https://github.com/pingdotgg/t3code/issues/15429)

**Other open native-subagent truth issues** (titles only):
- #15447 "Cursor run continues after T3 marks parent and native subagents failed"
- #15581 "OpenCode v2 subagents remain running without output or surfaced errors"
- Source: [issue search](https://github.com/pingdotgg/t3code/issues?q=subagent)

### Inferences
- The mapping is a **lossy projection of native events**. Anything the adapter does not explicitly model (workflow phases, usage, model on a non-Agent launch) is dropped, and anything that needs cross-restart memory breaks.
- For Solenta, which observes Claude, Codex, and Grok CLIs:
  - Persist the native-id → app-id registry (or make it fully derivable from durable rows) instead of keeping it in adapter memory.
  - Treat native subagent status as **advisory**. Source truth should be "is a live run on the child thread", as #15334 does on the client.

### Gaps
- `updateClaudeSubagentNode`'s terminal path (`task_notification` → completed/failed) and the OpenCode 2 mapping were not traced line by line.
- No fix commit for #15567 or #15448 exists on main as of this SHA.

---

## 6. Permission and runtime-mode ceiling (`runtime_mode_escalation_denied`)

### Takeaway
A pure rank comparison runs in the MCP service before any command is dispatched:
- Runtime mode: `approval-required(0) < auto-accept-edits(1) < auto(2) < full-access(3)`.
- Interaction mode: `plan(0) < default(1)`.
- `inherit` or an omitted value resolves to the parent's mode. If the resolved rank is greater than the parent's, the call fails with a typed `OrchestratorMcpFailure`.

The same ceiling applies to `t3_thread_send`, according to the docs.

### Cited Findings
- Code [main]:
```ts
function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case "approval-required": return 0;
    case "auto-accept-edits": return 1;
    case "auto": return 2;
    case "full-access": return 3;
  }
}
function interactionModeRank(mode: ProviderInteractionMode): number { return mode === "plan" ? 0 : 1; }
export function resolveRuntimeMode(parentMode, requested) {
  const resolved = requested === undefined || requested === "inherit" ? parentMode : requested;
  return runtimeModeRank(resolved) > runtimeModeRank(parentMode)
    ? Effect.fail(failure("runtime_mode_escalation_denied",
        `Child runtime mode ${resolved} is broader than parent mode ${parentMode}.`))
    : Effect.succeed(resolved);
}
```
  — [OrchestratorMcpService.ts L428-L473](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/OrchestratorMcpService.ts#L428-L473)
- The check compares against `parent.thread.runtimeMode`/`interactionMode` (the thread's current setting, not the run's) and runs before `requestKey`/dispatch — [OrchestratorMcpService.ts L1392-L1396](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/OrchestratorMcpService.ts#L1392-L1396)
- The resolved modes are written onto the child thread — [Orchestrator.ts L6405-L6406](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L6405-L6406)
- Failure codes include `runtime_mode_escalation_denied` and `interaction_mode_escalation_denied` — [orchestratorMcp.ts L568-L589](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestratorMcp.ts#L568-L589)
- Docs: "A child runtime mode may stay equal to or become narrower than the parent mode… Send additionally enforces the same runtime and interaction privilege ceiling as child creation" — [orchestrator-mcp-server.md L433-L439](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md#L433-L439)
- Doc drift: the doc's `runtimeMode` union omits `"auto"`, which the code ranks at 2 — [orchestrator-mcp-server.md L219](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md#L219)
- Read-only sandboxes pre-approve only annotated read-only T3 tools, "so a read-only session cannot silently spawn threads or scheduled tasks" — [ClaudeAdapterV2.ts L956-L976 (comment L956-L961, fn L962)](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L956-L976)
- A narrower child mode can **stall** unattended work. A child in `approval-required` blocks on approvals, and nothing tells the parent (#15082, open; PR #13343 open). Codex `mcpServer/elicitation/request` "always forwards to the user" regardless of runtime mode — [Issue #15082](https://github.com/pingdotgg/t3code/issues/15082); [PR #13343](https://github.com/pingdotgg/t3code/pull/13343); related [PR #14416](https://github.com/pingdotgg/t3code/pull/14416) (open, "delegate_task explains that supervised runtime modes pause the child")

### Inferences
- The rank check is the right minimal model for Solenta's fork modes (and trivially unit-testable). The rank should come from the lead's **current** mode at call time, as T3 does.
- The #15082 failure mode transfers directly. A narrowed worker that blocks on approval must surface to the lead or the user, otherwise "narrower" silently means "stuck".

### Gaps
- Model and provider escalation (for example, a cheaper parent spawning a pricier child) has no ceiling; only provider availability checks apply.

---

## 7. Do delegated children share the parent's worktree, and how are conflicting edits avoided?

### Takeaway
**Confirmed: they share it, and there is no conflict avoidance.**
- `makeSubagentChildThread` spreads the parent AppThread, so the child inherits `projectId`, `branch`, and `worktreePath`.
- No lock, lease, file ownership, or separate checkout exists for delegated children. Only per-thread command and effect serialization exists, and it does not coordinate two threads editing the same files.
- Isolation is opt-in elsewhere: `t3_thread_launch` with `workspaceStrategy`, or the child calling `t3_worktree_handoff` on itself, which has an open Claude bug.

### Cited Findings
- `makeSubagentChildThread` returns `{...input.parentThread, id: childThreadId, title, providerInstanceId, modelSelection, lineage:{parentThreadId, relationshipToParent:"subagent", rootThreadId}, forkedFrom:{type:"node", nodeId}, …}`. Nothing overrides `worktreePath` or `branch` — [SubagentProjection.ts L42-L83](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/SubagentProjection.ts#L42-L83)
- Native subagent child threads are built through the same helper (Claude [L4144-L4166](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L4144-L4166), Codex [L2519-L2536](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L2519-L2536)). They run inside the provider's own process, in the same cwd.
- Agent instructions: "`create_threads` … always inherits the caller's project, branch, and worktree… Asking an agent to run `git worktree add` or `cd` in its prompt does not update T3's thread binding. Select the workspace in the launch call instead. `t3_worktree_handoff` moves the calling thread, not another thread" — [T3OrchestrationInstructions.ts L14-L24](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/T3OrchestrationInstructions.ts#L14-L24)
- The design doc says the same: "`create_threads` remains the batch option for a shared checkout" — [orchestrator-mcp-server.md L312-L330](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md#L312-L330)
- A grep for "conflict", "same checkout", or "concurrent edit" in `docs/`, `orchestration-v2/*.ts`, `mcp/*.ts`, and the agent instructions returned only the `create_threads` line above. No conflict-handling code exists — [repo search at SHA](https://github.com/pingdotgg/t3code/tree/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2)
- Self-isolation path: a delegated child can call `t3_worktree_handoff` with a `continuationPrompt`. For Codex children this works ("run 2 (the continuation) starts inside the worktree, and the parent gets one … notice after run 2"). For Claude children the session is closed about 2 s after the handoff and the continuation never starts — [Issue #15136](https://github.com/pingdotgg/t3code/issues/15136) (open). Possibly related: [PR #15203](https://github.com/pingdotgg/t3code/pull/15203) (open, "resume continuations after planned worktree handoffs").
- Isolation also has a cross-install hazard: "A copied state database wakes the original install's agents and can touch its worktrees" — [Issue #15513](https://github.com/pingdotgg/t3code/issues/15513) (open, title only)

### Inferences
- Solenta's default (each forked worker in its own git worktree and branch) is **stricter than T3's `delegate_task`**. The source gives no reason to adopt T3's shared-checkout default.
- If Solenta ever offers a `worktree:false` fan-out, T3 is evidence that nobody has solved concurrent edits in a shared checkout at the orchestrator level. Leave it to prompt discipline (for example, read-only reviewers) or add file leases.
- Because checkpoints are per thread but share one filesystem, rolling back a parent while a shared-checkout child is mid-edit could also revert the child's work. This is inferred from the shared `worktreePath` plus hidden-ref checkpoints; no issue or test confirms it.

### Gaps
- No test was found that exercises two delegated children editing the same file.
- Checkpoint-scope behavior for app-owned children in a shared worktree (`CheckpointScopeOwnership.test.ts`) was not read.

---

## 8. Bugs reported against delegation and wake since the 2026-10-02 merge: main vs open PRs

### Takeaway
Main carries the core delegation and wake machinery plus five post-merge fixes (restart recovery, review-round guidance, Lineage display, stuck runs, wake-turn status).
- The largest open gaps: no wake for follow-up turns; no notice when a child blocks on approval or a question; Stop leaking wakes from tasks delegated during a wake run; Claude steer priority cancelling queued tool calls; a session idle-release wedge; native subagent tracking lost on restart or flattened (workflows).
- Each has an open fix PR except #15173 and #15567, where triage names a fix area but no PR is linked.

### Cited Findings
**Merged on main since 2026-10-02** (`git log de343914..eac52f0 -- orchestration-v2 mcp contracts`):
- `5108c978` #15323 "restarts keep delegated tasks, queued threads, and stops intact": "hold child results until restart continuations settle, re-offer interrupted completion deliveries… preserve stop intent, held queues". It was verified live with a Codex child across a SIGTERM restart — [PR #15323](https://github.com/pingdotgg/t3code/pull/15323)
- `31a9da17` #15115 "keep delegated review rounds on the task API": tool and instruction text telling agents to re-`delegate_task` each round instead of `t3_thread_send` to `childThreadId` (the workaround for #13490) — [commit 31a9da17](https://github.com/pingdotgg/t3code/commit/31a9da17)
- `d3071275` #15334: Lineage shows a child's live `activityRunStatus` over the stale subagent row — [commit d3071275](https://github.com/pingdotgg/t3code/commit/d3071275d576bb289a6cb177c6cc28fff8e95015)
- `6108ef3d` #15048 "runs no longer get stuck" (EventSink, EffectOutbox, ProviderSessionManager) — [commit 6108ef3d](https://github.com/pingdotgg/t3code/commit/6108ef3d)
- `5bf19d12` #15055 "threads stay working while Claude starts a wake turn" — [commit 5bf19d12](https://github.com/pingdotgg/t3code/commit/5bf19d12)
- Earlier on the branch: the #12285 wake cap was fixed by #13938, and #13735 (Claude subagent restart) was merged — [Issue #12285](https://github.com/pingdotgg/t3code/issues/12285); [PR #13735](https://github.com/pingdotgg/t3code/pull/13735)

**Open issues, each with its open fix PR where one exists:**

| Issue | Problem | Fix PR |
|---|---|---|
| #13490 | Follow-up turn never wakes the parent; maintainer calls it the contract | #15004 (versioned results per completion) |
| #15082 | Child waiting on a question or approval never tells the parent | #13343 (server notice, `queue_after_active`, dedupe) |
| #15325 | Stop on a wake run leaves newly delegated tasks able to wake the parent | #15331 |
| #15351 | Claude steer with `priority:"now"` cancels the parent's not-yet-started tool calls ("The user doesn't want to take this action right now"). Triage options: send delegated completions with `priority:"next"`, or stop upgrading to `steer_active` for Claude | — |
| #15173 | Parent Claude session idle-released while waiting on a child; Stop and Settle fail until restart | — |
| #15567 | Codex children lost after restart | — |
| #15448 | Workflow flattened into one subagent | #15559 |
| #15429 | No subagent token usage | #15446 |
| #15136 | Claude child dies after worktree handoff | — |
| #15169 | Delegated task notification expands to an empty panel | — |

- Sources: [#13490](https://github.com/pingdotgg/t3code/issues/13490), [#15004](https://github.com/pingdotgg/t3code/pull/15004); [#15082](https://github.com/pingdotgg/t3code/issues/15082), [#13343](https://github.com/pingdotgg/t3code/pull/13343); [#15325](https://github.com/pingdotgg/t3code/issues/15325), [#15331](https://github.com/pingdotgg/t3code/pull/15331); [#15351](https://github.com/pingdotgg/t3code/issues/15351); [#15173](https://github.com/pingdotgg/t3code/issues/15173); [#15567](https://github.com/pingdotgg/t3code/issues/15567); [#15448](https://github.com/pingdotgg/t3code/issues/15448), [#15559](https://github.com/pingdotgg/t3code/pull/15559); [#15429](https://github.com/pingdotgg/t3code/issues/15429), [#15446](https://github.com/pingdotgg/t3code/pull/15446); [#15136](https://github.com/pingdotgg/t3code/issues/15136); [#15169](https://github.com/pingdotgg/t3code/issues/15169)
- Note on #15169: PR #15535 ("notifications without detail no longer expand to an empty panel") appears to address it, but the link was not confirmed.

**Other open delegation PRs:**
- #14437 "retry mailbox delivery after receiver failure"
- #14732 "a delegated result whose steer never landed wakes the parent after it settles" (by maintainer juliusmarminge)
- #15201 "reconcile stale delegated task and held queue state"
- #15211 "stop active subagents from Lineage"
- #15311 "bound completion delivery retries"
- #15033 "no MCP wait polling"
- #13345 "report delegated tasks stopped by a server restart"
- Source: [open PR list](https://github.com/pingdotgg/t3code/pulls)

**Hardening tracker #15013** (open):
- "Define and test what happens when a provider accepts an interrupt but then completes normally"
- "Add a test for forking from a subagent thread"
- typed context-transfer failure reasons
- Source: [Issue #15013](https://github.com/pingdotgg/t3code/issues/15013)

### Inferences
- The bug pattern is consistent:
  - The durable cohort and dedupe design is solid. Restart, duplicate, and batching bugs were fixed quickly (#12285, #15323).
  - The weak points are the **edges that are not modeled as delivery events**: child-blocked-on-input, follow-up turns, a wake run's own children, a provider's steer semantics, and session reaping.
- Solenta's design should model those five as first-class notice types from day one.

### Gaps
- The full PR diffs for #15004, #13343, and #14732 were not reviewed. Their summaries come from PR bodies only.
- Merge likelihood and maintainer stance on #15004 vs the "contract" verdict in #13490 are unknown.
