# T3 Code "Orchestrator V2" (Orchestrator 2.0): source-code architecture

Analyzed snapshot: `pingdotgg/t3code` main at **`eac52f0087d9ba5dee5542f24788d1482affae43`** (commit date 2026-10-04 01:37 PDT), shallow clone (400 commits, back to 2026-09-22) in `/tmp/t3code-research`. Link base used below: `R = https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43`. Everything below is on **main** unless it is explicitly marked as a doc-only target or as pre-merge V1.

## 1. What "Orchestrator 2.0" is, where it lives, and its status (main vs. branches/PRs)

### Takeaway
"Orchestrator V2" is a rewrite of the server's orchestration layer. It landed on main on 2026-10-02 as one squash commit: PR #2829, "feat(orchestrator): introduce new orchestrator", from branch `t3code/codex-turn-mapping`. The PR was open from May 27 to Oct 2, 2026, with +380,729/-203,651 lines across 1,912 files. As of Oct 4 it ships only in nightly builds; stable v0.0.45 is still V1. No open V2 branch or PR remains. The code is in `apps/server/src/orchestration-v2/`, the wire schemas are in `packages/contracts/src/orchestrationV2.ts`, and the design docs are in `docs/orchestration-v2/`.

### Cited Findings
- Squash commit `de343914` "feat(orchestrator): introduce new orchestrator (#2829)", authored by Julius Marminge, dated Fri Oct 2 2026 — [commit](https://github.com/pingdotgg/t3code/commit/de343914273eceb852a1d1d739cd1d38df7796ee)
- PR #2829 metadata: state MERGED, createdAt 2026-05-27T19:52:16Z, mergedAt 2026-10-02T19:22:22Z, head `t3code/codex-turn-mapping`, 1912 files, +380729/−203651 — [PR #2829](https://github.com/pingdotgg/t3code/pull/2829)
- The PR body has a "Revert before merging into `main`" list of V2-only preview stopgaps, such as the OpenCode 2 compatibility policy. Its "Closes" section maps dozens of V1 issues to specific V2 mechanisms (see section 8) — [PR #2829](https://github.com/pingdotgg/t3code/pull/2829)
- Maintainer migration notice: "T3 Code Orchestrator V2 is SOON (est. 3am UTC) out in nightly builds". The first V2 server start copies `state.sqlite` to `statev2.sqlite` and migrates the copy. V1 and V2 apps cannot talk to each other. Mobile store builds stay on V1 until V2 is stable. Minimum provider versions: Codex 0.159, Claude Code 2.1.280, Grok 1.0.13, OpenCode 2.0.18, Pi 0.80.5 — [Issue #14871](https://github.com/pingdotgg/t3code/issues/14871)
- Releases: stable `v0.0.45` (2026-10-02) is pre-V2. Nightlies `0.0.46-nightly.20261003.*` and `.20261004.2644` follow the merge — [Releases](https://github.com/pingdotgg/t3code/releases)
- The T3 Code CLI 0.3.0 "works only with T3 Code builds that include orchestrator V2, specifically nightly 0.0.46-nightly.20261003.2610 or later" — [t3code-cli v0.3.0](https://github.com/MajesteitBart/t3code-cli/releases/tag/v0.3.0)
- Theo calls it "a big overhaul of the orchestration layer (aka Orchestrator V2)" that was blocking other work — [Theo on X](https://x.com/theo/status/2085238155746406605)
- Docs say V2 is "an orchestrator rewrite, not a rewrite of the whole app domain platform". Persistence, migrations, websocket/RPC, and projection-streaming semantics are kept. "The V1 command and event unions are gone; V1 rows survive only as input to the legacy importer" — [docs/orchestration-v2/README.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/README.md)
- The design doc set has 9 files, about 3,100 lines: README, core-graph-and-data-model, entity-ids-and-correlation, feature-lifecycles, thread-lineage-and-context-transfer, provider-switching-and-context, orchestrator-mcp-server, provider-capability-system, testing-strategy — [docs/orchestration-v2/](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/README.md)
- Code size on main:
  - `Orchestrator.ts` is 10,258 lines.
  - `ProjectionStore.ts` is 6,151 lines.
  - Adapters: Codex 6,317, Claude 7,817, ACP (shared by Grok, Devin, and the ACP registry) 7,898, OpenCode 1 3,758, OpenCode 2 4,266, Pi 3,007, Cursor 2,662.
  - Source: `wc -l` on [apps/server/src/orchestration-v2/](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts)
- Only 3 commits on main match `--grep=orchestrat` (#2829, #15041 "docs, dev scripts and CI catch up with orchestration V2", #14104). Within this snapshot, 27 commits after the merge touch `orchestration-v2/`. They are bug fixes such as #15323 "restarts keep delegated tasks, queued threads, and stops intact" and #15057 "agents can watch a PR and get woken". `gh pr list --search "orchestrat in:title" --state open` returned no open PRs — [repo history](https://github.com/pingdotgg/t3code/commits/main/apps/server/src/orchestration-v2)

### Inferences
- "Orchestrator 2.0" in conversation means this V2. There is no separate unmerged "2.0" branch to look at. The four-month branch became main.
- The migration copies the V1 database (`state.sqlite` → `statev2.sqlite`) instead of upgrading it in place. That makes rollback trivial. A large Solenta store rewrite could reuse the same pattern.

### Gaps
- The shallow clone has no per-commit history from the private branch, because the PR was squash-merged. The step-by-step evolution of the branch could not be reconstructed. The full PR timeline and review comments were not read.
- The issue's "release notes" link was a placeholder (`LINK`) when read.

## 2. Data model: commands, events, aggregates/projections, persistence

### Takeaway
V2 is event-sourced CQRS over SQLite.
- Each event payload carries the full updated entity: `run.updated` carries the whole Run, `node.updated` the whole ExecutionNode. Projections are therefore idempotent `INSERT … ON CONFLICT DO UPDATE` upserts, and the client applies the same upsert.
- The model is a graph: `AppThread → Run (counted user turn) → RunAttempt → ExecutionNode tree`, plus `ProviderThread`/`ProviderTurn`/`ProviderSession` handles, `RuntimeRequest` (approvals and questions), `Subagent`, `CheckpointScope`/`Checkpoint`, `ContextTransfer`/`ContextHandoff`, and an ordered `turnItems` display projection.

### Cited Findings
- The conceptual layers are: native provider protocol → rotating raw diagnostics → adapter/normalizer → V2 event store → runtime execution graph → conversation projection → UI. "Raw provider frames are not durable app state" — [README.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/README.md); [core-graph-and-data-model.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/core-graph-and-data-model.md)
- Mental model: an `AppThread` holds `Run`s. Each run has a root `ExecutionNode`, and under it tool, approval, and subagent nodes. A subagent node can own a `ProviderThread` with its own child root node. "Provider switches do not create new app threads… Forks do create new app threads" — [README.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/README.md)
- Key invariants from the README:
  - (1) App ids are primary; provider ids are refs.
  - (3) Child execution completion never closes the parent run.
  - (4) Child checkpoints are nested and do not advance the run count.
  - (6) Every command targets app ids; adapters translate at the edge.
  - (7) A missing capability is represented explicitly.
  - (8) Provider switches create explicit handoff artifacts, "not hidden prompt hacks".
  - (9) A fork records lineage first and resolves it lazily.
  - Source: [README.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/README.md)
- Run status: `queued|starting|running|waiting|completed|interrupted|failed|cancelled|rolled_back`. A `RunAttempt` has reason `initial|steering_restart|retry|provider_recovery` and status including `superseded`. "Only one attempt is the final selected attempt for run completion and checkpointing" — [core-graph-and-data-model.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/core-graph-and-data-model.md)
- ExecutionNode kinds: `root_turn, assistant_message, reasoning, plan, todo_list, tool_call, approval_request, user_input_request, subagent, hook, system`. "The root node of a run is the only node allowed to complete the run" — [core-graph-and-data-model.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/core-graph-and-data-model.md)
- The Codex app-server probes drove the separation of run, provider turn, and node:
  - `turn/completed` is authoritative, not `thread/status/changed`.
  - `turn/interrupt` returns first, and the interrupted terminal state arrives later.
  - Child `turn/completed` can arrive before the parent's.
  - Child provider turns "must not be remapped onto the parent provider turn id".
  - Source: [README.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/README.md)
- SQLite schema (migration 055). `orchestration_v2_events` has `sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id UNIQUE, command_id, thread_id, run_id, node_id, provider, raw_event_id, event_type, occurred_at, payload_json`, indexed by command, thread, run, and node. `orchestration_v2_command_receipts(command_id PK, thread_id, command_type, accepted_at, result_sequence, status, error)` sits alongside it, and so do projection tables for threads, runs (`UNIQUE(thread_id, ordinal)`), run_attempts (`UNIQUE(run_id, attempt_ordinal)`), nodes, provider_sessions, provider_threads, provider_turns, runtime_requests, messages, plans, turn_items, checkpoint_scopes, checkpoints, context_handoffs, and context_transfers — [055_OrchestrationV2.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/persistence/Migrations/055_OrchestrationV2.ts)
- Later setup steps, released together as migration 055:
  - `orchestration_v2_effect_outbox(effect_id PK, command_id, thread_id, effect_type, payload_json, status pending|running|succeeded|failed, attempt_count, available_at, lease_owner, lease_expires_at, …, last_error)`
  - `orchestration_v2_turn_item_positions(thread_id, turn_item_id, ordinal, UNIQUE(thread_id, ordinal))`
  - `orchestration_v2_projection_metadata(projection_name, schema_version, last_sequence)`
  - Source: [OrchestrationV2/Foundation.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/persistence/Migrations/OrchestrationV2/Foundation.ts#L109-L179)
- Further tables: `orchestration_v2_projection_subagents`, `…_provider_session_bindings`, `…_thread_launch_workflows`, `…_legacy_imports`, `scheduled_tasks` — [Migrations/OrchestrationV2/](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/persistence/Migrations/OrchestrationV2/Subagents.ts)
- The V2 event source was later folded into the shared `orchestration_events` table through an `application_event_version` column, and `EventStoreV2` reads and writes through `appendAgentEvents`/`readAgentEvents`. So project events and V2 thread events share one global sequence (`latestApplicationSequence`) — [ApplicationEventSource.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/persistence/Migrations/OrchestrationV2/ApplicationEventSource.ts); [EventStore.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EventStore.ts)
- Stored envelope: `OrchestrationV2StoredEvent = { sequence, commandId | null, event: OrchestrationV2DomainEvent }` — [contracts/orchestrationV2.ts L1856](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L1856)
- Domain event types (all `*.updated` carry the full entity):
  - Thread metadata: `thread.created` and `thread.{archived,unarchived,deleted,settled,unsettled,snoozed,pinned,visited,metadata-updated,runtime-mode-updated,interaction-mode-updated,model-selection-updated,provider-switched,…}`
  - Graph entities: `run.created`, `run.updated`, `run-attempt.created/updated`, `node.updated`, `subagent.updated`, `provider-session.attached/detached/updated`, `provider-thread.updated`, `provider-turn.updated`, `runtime-request.updated`, `message.updated`, `plan.updated`, `turn-item.updated`
  - Checkpoints and context: `checkpoint-scope.created`, `checkpoint.captured`, `checkpoint.rollback-requested`, `context-transfer.created/updated`, `context-handoff.updated`
  - Other: `run.background-work-cancelled`
  - Source: [contracts/orchestrationV2.ts L1525-L1855](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L1525)
- Projection apply is a switch over event type with `ON CONFLICT(run_id)`, `ON CONFLICT(node_id)`, … upserts for each entity table — [ProjectionStore.ts L1674-L2404](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProjectionStore.ts#L1674)
- The client keeps an `OrchestrationV2ThreadProjection` and applies events with `upsertEntity(items, item)` (find by id, replace or append) — [client-runtime orchestrationV2Projection.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/orchestrationV2Projection.ts)
- Projections are split into thread shell (sidebar), thread detail, execution graph (debug), provider sessions, and pending requests. The backend owns an ordered `turnItems` projection plus a derived `visibleTurnItems` for forks, so "the frontend should not reconstruct display order by merging messages, plans, checkpoints…". TurnItem variants: `user_message, assistant_message, reasoning, plan, file_change, command_execution, file_search, web_search, approval_request, checkpoint, compaction, handoff, fork, dynamic_tool` — [core-graph-and-data-model.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/core-graph-and-data-model.md)
- Excerpt of the Subagent entity: `origin: "provider_native" | "app_owned"`, `childThreadId`, `providerThreadId`, `nativeTaskRef`, `completionWake: "always" | "settled_only"`, `completionDelivery`, `status`, `result` — [contracts/orchestrationV2.ts L656-L693](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L656)

### Inferences
- Having events carry full state is the main simplification. Replay, client apply, and projection apply are all "upsert by id", so a duplicate or reordered-but-sequenced event cannot corrupt state, and no per-event reducer logic is needed on the client. The cost is larger events; they bound this with wire projection and coalescing (section 6).
- The `Run` vs `ProviderTurn` vs `ExecutionNode` split is the transferable core idea for Solenta. A user turn is an app concept. Provider turns are attempts inside it. Children never terminate parents.

### Gaps
- `ProjectionStore.ts` was not read in full. Whether projection rows are ever rebuilt from the log (versus only `ProjectionMaintenance.ts` and `ProjectionRecovery`) was not confirmed beyond `projection_metadata.last_sequence` existing.

## 3. Command pipeline, idempotency, side effects, concurrency, crash recovery

### Takeaway
1. `dispatch(command)` takes a **per-thread lock** (keyed semaphore).
2. It checks the **command receipt**. A duplicate `commandId` returns the original `resultSequence` and stored events without re-running side effects.
3. A pure-ish `dispatchOnce` "plans" `{events, effects}` from projections without doing I/O.
4. `EventSink.commitCommand` writes, in **one SQLite transaction**: the receipt reservation, appended events, synchronously applied projections, **durable outbox effects**, and the final receipt.
5. It publishes to in-memory PubSub after commit, under a "publish lane" that keeps live delivery in sequence order.
6. A leased, retrying **EffectWorker** performs provider and filesystem I/O. It runs effects strictly one at a time per thread and feeds results back as new events and commands.

### Cited Findings
- The canonical summary: "The v2 orchestrator serializes commands and decides events without performing provider or filesystem work. EventSink commits events, persisted projections, the accepted command receipt, and outbox effects in one database transaction… A command acknowledgement therefore means the intent committed, not that the provider… finished. Keep external I/O out of command decisions and the database transaction." — [docs/internals/overview.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/internals/overview.md)
- Per-thread serialization: `KeyedSerialExecutor` "Serializes work that targets the same domain identity without coupling unrelated identities to a process-wide mutex". It is a `Map<Key, {semaphore, users}>` with refcounted cleanup. `dispatchWithReceipt = (command) => threadDispatch.withLock(commandThreadId(command), dispatchWithReceiptEffect(command))` — [KeyedSerialExecutor.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/KeyedSerialExecutor.ts); [Orchestrator.ts L9864](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9864)
- Lock-ordering rule (comment in `handleTerminalRun`): "each takes its own thread's lock, sequentially and never nested… the keyed executor's semaphores are neither reentrant nor deadlock-aware" — [Orchestrator.ts L9866-L9880](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9866)
- Receipt replay:
  - An existing receipt with status `rejected` gives `OrchestratorCommandPreviouslyRejectedError`.
  - A receipt for a different thread gives `OrchestratorCommandIdConflictError` ("A receipt only proves this exact command was handled for its own thread").
  - Otherwise the call returns `{ sequence: receipt.resultSequence, storedEvents: readByCommandId(...) }`.
  - Failed planning commits a **rejected receipt**, so retries fail in the same way.
  - Source: [Orchestrator.ts L9676-L9860](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9676); [L222](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L222)
- `dispatchOnce` is a big `switch (command.type)` that pushes into `Ref<events>` and `Ref<effects>` and returns `{events, effects, cancelUnsettledEffects?}`. A command that produces no events is an error, except `thread.background-work.settle` — [Orchestrator.ts L9399-L9673](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9399)
- `commitCommandEffect` steps, inside `sql.withTransaction`:
  1. `commandReceipts.insertIfAbsent(...)` reserves the id. If the id is taken, it returns the existing result as `committed:false`.
  2. `normalizeEvents` assigns turn-item positions.
  3. `eventStore.append`
  4. `applyStoredEvents` applies projections and bumps `projection_metadata.last_sequence`.
  5. `effectOutbox.enqueue(input.effects)`
  6. `commandReceipts.upsert({... resultSequence: lastSequence})`
  7. Optionally `effectOutbox.cancelUnsettled`.
  - After commit it signals cancellations, wakes the worker, and publishes events.
  - Source: [EventSink.ts L518-L584](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EventSink.ts#L518)
- Ordered publication: "If a writer is descheduled in between, a later commit reaches subscribers first, and clients drop any event at or below the newest sequence they have applied. So a writer takes this lane as the last step of its transaction and holds it until it has published" (`publishLane = Semaphore.make(1)`) — [EventSink.ts L231-L262](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EventSink.ts#L231)
- In-transaction race guard: "A user can answer after terminal normalization reads the pending request. Recheck inside the write transaction so stale cleanup cannot erase answers" (`guardUserInputCancellations`). `writeIfRunCurrent` and `writeIfProviderThreadOwner` also exist, and atomically drop provider writes from an attempt that has lost ownership — [EventSink.ts L265](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EventSink.ts#L265); [ProviderEventIngestor.ts L198-L235](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderEventIngestor.ts#L198)
- Outbox effect types: `provider-runtime.continue, provider-session.detach, provider-turn.start, provider-turn.interrupt, provider-turn.steer, provider-turn.restart, runtime-request.respond, provider-thread.rollback, checkpoint.capture, terminal.cleanup, attachment.cleanup, thread-title.generate` — [EffectOutbox.ts L26-L106](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EffectOutbox.ts#L26)
- Claim semantics:
  - An atomic `UPDATE … SET status='running', attempt_count+1, lease_owner, lease_expires_at WHERE effect_id = (SELECT … ORDER BY available_at, created_at LIMIT 1) RETURNING *`.
  - A candidate is claimable only if no other effect for the same thread is `running` or an earlier `pending` row (by rowid).
  - Comment: "Each thread runs its effects one at a time, in enqueue (rowid) order. An earlier effect waiting out a retry backoff still blocks later ones, so a turn cannot start while a failed rollback is about to restore files."
  - Title generation gets its own per-thread lane.
  - Source: [EffectOutbox.ts L282-L325, L491-L525](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EffectOutbox.ts#L282)
- Worker defaults: `workerId = orchestration-v2:<pid>`, `leaseDurationMs 30_000`, `maxAttempts 5`, backoff `min(30s, 100ms·2^(attempt−1))`, concurrency 4 worker fibers. On an unexpected worker failure it requeues with delay 0 — [EffectWorker.ts L505-L560, L704, L756](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EffectWorker.ts#L505)
- Effects feed back as commands. For example, after `provider-turn.interrupt` the worker dispatches `thread.background-work.settle` with the derived `commandId = ${effect.id}:background-work-settled`, so a replay is idempotent — [EffectWorker.ts L165-L196](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EffectWorker.ts#L165)
- Reactors are now event-stream subscribers that issue commands under locks. Example: a subscription to `run.updated` terminal events (starting from the current high-water mark, not full history) finalizes app-owned subagents, finalizes delegated completion deliveries, and promotes the next queued run. Comment: "Replaying the full event table on every server start delays live queue promotion in proportion to the lifetime size of the database" — [Orchestrator.ts L9866-L9925](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9866)
- Startup recovery:
  - `recoverDelegatedTasks` settles subagent results and deliveries "whose runs ended without the listener above: before this boot, or in runtime reconciliation… Startup runs this after reconciliation and before the effect worker. Queue recovery instead holds unstarted runs until an explicit queue.resume command arrives." — [Orchestrator.ts L9930-L10010](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9930)
  - `ProviderRuntimeRecoveryService` terminalizes provider-bound work after process loss. Background work that outlived its turn is recorded "for their next turn", so the next provider turn is told about it. "Queued runs have not started provider work. Preserve their execution identities and order, but require explicit consent before draining them." — [ProviderRuntimeRecoveryService.ts L249-L310](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L249)
  - `ProviderSessionManager` "intentionally does not resurrect persisted sessions. Process-loss recovery terminalizes provider-bound work and retires non-replayable effects; a later user command… opens a session lazily." — [ProviderSessionManager.ts L66-L71](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L66); [overview.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/internals/overview.md)
- Deterministic ids give idempotency across retries:
  - `run = run:thread:<threadId>:ordinal:<n>`
  - `runAttempt = run-attempt:run:<runId>:attempt:<k>`
  - `rootNode = node:run:<runId>:root`
  - `providerTurn = provider-turn:provider:<driver>:native-turn:<nativeId>`
  - `nodeFromProviderItem = node:provider:<driver>:native-item:<id>`
  - `approvalNode = node:runtime-request:<requestId>`
  - Delegated child thread, node, message, and turn item are all derived from the `commandId`.
  - Source: [IdAllocator.ts L389-L433](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/IdAllocator.ts#L389)
- Correlation doc: "Provider ids are evidence. App ids are identity." Correlation is always scoped (`provider + providerSessionId + nativeThreadRef`, `providerThreadId + nativeTurnRef` or ordinal, …). Weak providers use scoped ordinals, then fingerprints. "Do not use complete assistant text as a primary fingerprint" — [entity-ids-and-correlation.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/entity-ids-and-correlation.md)
- Pending approvals after restart carry a `responseCapability: {type:"live", providerSessionId} | {type:"not_resumable", reason}`. On session release the manager writes `not_resumable` for pending requests (PR body, closing #11799) — [entity-ids-and-correlation.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/entity-ids-and-correlation.md); [PR #2829](https://github.com/pingdotgg/t3code/pull/2829)

### Inferences
- The README still calls the durable effect outbox a "Tracked Follow-Up… not a prerequisite for the first V2 slice". The code has since implemented it as a SQLite table with leases. The docs lag the code here; trust the code and `overview.md`.
- The pattern worth copying for Solenta's JSON store, which is mutated directly: **decide → (events + projection + outbox + receipt) in one transaction → publish in order → leased worker does I/O → result becomes a new idempotent command.** Per-thread FIFO effect ordering is what stops "start turn" from racing "restore files".

### Gaps
- No multi-process or multi-server leader election was found beyond the lease owner being `orchestration-v2:<pid>`. Leases suggest crash-safety rather than horizontal scale.

## 4. Provider layer: adapters, session lifecycle, approvals, interrupt, resume, normalization

### Takeaway
Each provider has a `ProviderAdapterV2` with three members: `getCapabilities()`, `planSelectionTransition()`, and a scoped `openSession()`. `openSession` returns a session runtime with `ensureThread`/`resumeThread`/`startTurn`/`steerTurn`/`interruptTurn`/`respondToRuntimeRequest`/`readThreadSnapshot`/`rollbackThread`/`forkThread` (plus optional `injectHistory` and `compactThread`) and a normalized event stream. Adapters emit **entity-shaped** updates plus a `turn.terminal` event. `ProviderEventIngestor` stamps app ids and envelopes and writes them through `EventSink`. Behavior differences are expressed through a capability struct and policies, not provider-name checks.

### Cited Findings
- Normalized adapter events:
  - Entity updates: `app_thread.created`, `provider_session.updated`, `provider_thread.updated`, `provider_turn.updated`, `node.updated`, `subagent.updated`, `message.updated`, `turn_item.updated`, `runtime_request.updated`, `plan.updated`
  - `turn.terminal` with `status completed|interrupted|cancelled|failed`, a `failure`, an optional `retry`, and `threadDisposition: "reusable" | "broken"`
  - Source: [ProviderAdapter.ts L78-L155](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderAdapter.ts#L78)
- Session runtime surface: `events` stream, `subscribeEvents`, `hasPendingBackgroundWork(ForThread)`, `getModelContextWindow`, `canReuseContextUsage`, `ensureThread`, `resumeThread`, `injectHistory?`, `startTurn`, `compactThread?`, `steerTurn`, `interruptTurn`, `unloadThread?`, `respondToRuntimeRequest`, `readThreadSnapshot`, `rollbackThread`, `forkThread`. The adapter shape is `{instanceId, driver, getCapabilities, planSelectionTransition, openSession(input): Effect<…, Scope>}` — [ProviderAdapter.ts L484-L598](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderAdapter.ts#L484)
- `ProviderAdapterV2TurnInput` carries app ids into the adapter: `threadId, runId, runOrdinal, providerTurnOrdinal, attemptId, rootNodeId, providerThread, message, modelSelection, runtimePolicy` — [ProviderAdapter.ts L396-L409](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderAdapter.ts#L396)
- Capability struct (versioned, emitted at session start). Groups `sessions, threads, turns, streaming, tools, approvals, planning, subagents, context, checkpointing, identity`, with flags such as `supportsActiveSteering`, `supportsSteeringByInterruptRestart`, `canForkThread`, `canRollbackThread`, `terminalStatusQuality: strong|weak|none`, and `nativeTurnIds: strong|weak|none`. "Provider-thread resumption is not a capability. It is a required adapter primitive." — [provider-capability-system.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/provider-capability-system.md); schema in [contracts/orchestrationV2.ts L201-L323](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L201)
- Degradation policies:
  - Steering unsupported: interrupt and restart as a replacement attempt.
  - Fork unsupported: synthetic or portable fork.
  - Rollback unsupported: restore the filesystem and mark provider state divergent.
  - Structured approvals unsupported: rely on the sandbox policy, with no approval UI.
  - Source: [provider-capability-system.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/provider-capability-system.md)
- Adapter roster: Codex (app-server JSON-RPC via `packages/effect-codex-app-server`), Claude (Agent SDK), Cursor (official `@cursor/sdk`), Grok and generic ACP-registry agents (shared `AcpAdapterV2` plus flavors), OpenCode 1.x and 2.x, Pi (RPC mode), Antigravity — [orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md); [Adapters/](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts)
- `ProviderSessionManager` "owns live session residency: open sessions, idle release, explicit shutdown, and release-on-runtime-failure". Idle release is deferred while background work is pending, up to a `maxIdlePinMs` cap — [ProviderSessionManager.ts L66-L226](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L66)
- Ingestor guards: `writeIfRunCurrent {runId, activeAttemptId, expectedStatus}` "Atomically reject mutable provider state emitted by an attempt that lost ownership while the adapter event was in flight" — [ProviderEventIngestor.ts L198-L235](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderEventIngestor.ts#L198)
- Interrupt semantics: "provider interrupt request returns → command acknowledged only; provider emits root turn/completed status=interrupted → run interrupted… The app should not mark the run terminal solely because the interrupt request returned." — [feature-lifecycles.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/feature-lifecycles.md)
- Protocol traps:
  - Codex async questions arrive as notifications and are answered with a new user message, so they are persisted with `responseCapability: { type: "message" }` and do not block the run.
  - `runtime-request.respond` validates answers and commits the resolution plus a user message in one transaction.
  - "Repeating the same command returns its receipt without posting the answer twice."
  - Source: [docs/internals/providers.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/internals/providers.md)
- Raw provider frames go to bounded rotating diagnostic logs, not SQLite, and serve as replay-fixture input — [core-graph-and-data-model.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/core-graph-and-data-model.md)
- Text streaming: adapters use a `ProviderTextDeltaCoalescer` (`append/complete/flushTurn` by turn and item) before emitting `message.updated` — [ProviderTextDeltaCoalescer.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ProviderTextDeltaCoalescer.ts)
- Every provider session gets the T3 MCP server injected with a session-scoped bearer token: Codex via `-c mcp_servers.t3-code.url=…`, Claude via `mcpServers` with `type:"http"` plus `allowedTools: ["mcp__t3-code__*"]`, ACP via the `session/new` `mcpServers` field, and Pi via a generated extension bridge. The token is minted before the session opens and revoked on release — [orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md); [ProviderSessionManager.ts L449-L475](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L449)

### Inferences
- Solenta's provider CLIs (claude, codex, grok, cursor) map onto this adapter shape closely. The key discipline is that adapters emit **full-entity updates keyed by deterministic ids** plus one authoritative `turn.terminal`, and the orchestrator alone decides run/attempt state.

### Gaps
- The individual adapters (6k–8k lines each) were not read line by line. The Codex `collabAgentToolCall`/`spawnAgent` → subagent mapping ([CodexAdapterV2.ts ~L2685](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L2685)) and the Claude `parent_tool_use_id`/`task_started` handling were only located, not traced end to end.

## 5. Multi-agent: subagents/delegation, forks, merge-back, provider switching, steering/queueing, checkpoints, worktrees

### Takeaway
V2 has two kinds of subagent:
- **Provider-native**: Codex `spawnAgent`, Claude Task. These are observed and modeled as child nodes, with their own provider threads and projected child threads.
- **App-owned**: a parent agent calls the T3 MCP tool `delegate_task`. That becomes one `delegated_task.request` command, which atomically creates a child thread (lineage `subagent`), a parent subagent node, a turn item, a `message.dispatch(start_immediately)` on the child, and a `subagent_spawn` context transfer.

When the child run terminalizes, a reactor finalizes the parent's subagent row, records a `subagent_result` transfer, and optionally wakes the parent through a mailbox continuation.

Forks are cheap lineage records that resolve lazily, natively or through a portable handoff, on the first run. Provider switches are explicit, audited handoffs. Steering is policy-driven, with server-owned queues. Checkpoints are hidden git refs. Delegated children share the parent's checkout. Only `t3_thread_launch` can create a new worktree.

### Cited Findings
- MCP tool surface, 11 tools: `orchestrator_capabilities, delegate_task, task_status, task_cancel, create_threads (1–20), t3_thread_launch, t3_thread_list, t3_thread_read, t3_thread_update, t3_thread_send, t3_thread_wait, t3_thread_interrupt`. "These are T3 orchestration operations, not provider-native sub-agent APIs" — [orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md)
- `delegate_task` input: `{task, target?{providerInstanceId?, driverKind?, model?}, title?, role?, mode?: "async"|"wait", timeoutMs?, clientRequestId?, runtimeMode?, interactionMode?}`.
  - "The child receives only the supplied task prompt… Parent conversation history is not copied into the child."
  - "A wait timeout does not cancel the child."
  - The result includes `taskId, childThreadId, status, workState: working|waiting_for_children|result_available, summary, resultContextTransferId, waitTimedOut`.
  - Source: [orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md)
- Privilege ceiling: a child runtime mode can only stay equal or narrow, and interaction mode can go `default→plan` but not `plan→default`. `clientRequestId` "derives stable command, thread, and message IDs within the provider session. Retrying the same call returns the same durable work." Typed failures include `runtime_mode_escalation_denied`, `parent_not_active`, `provider_unavailable`, and others — [orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md)
- Lifecycle chain: MCP call → `OrchestratorMcpService` → `ThreadManagementService` → V2 `delegated_task.request` → child thread and run → parent `app_owned` subagent projection → consumed `subagent_spawn` transfer → normal provider effect → child terminal → parent node/turn item finalized → consumed `subagent_result` transfer. "The event stream first replays persisted events and then follows live events, so finalization also runs after a server restart. An existing subagent_result transfer makes finalization idempotent." — [orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md)
- Code: `dispatchDelegatedTaskRequest` derives `taskNodeId`, `childThreadId`, `childMessageId`, and `taskTurnItemId` from `command.commandId`. It emits `thread.created`, `node.updated`, `subagent.updated`, and `turn-item.updated`, composes a `message.dispatch` with `dispatchMode: {type:"start_immediately"}` into the same batch, then adds a `subagent_spawn` context transfer — [Orchestrator.ts L6313-L6560](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L6313)
- The child thread is built as `{...input.parentThread, id: childThreadId, lineage: {parentThreadId, relationshipToParent: "subagent", rootThreadId}, forkedFrom: {type:"node", nodeId: parentNodeId}, …}`. The spread copies the parent's project, branch, and `worktreePath`, so children work in the **same checkout** — [SubagentProjection.ts L42-L83](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/SubagentProjection.ts#L42)
- Workspace selection for top-level launches: `t3_thread_launch` with `workspaceStrategy` `worktree` (plus `baseRef`, `startFromOrigin`), `existing_worktree`, or `root`. "Creating a worktree in the task prompt does not update this binding." `create_threads` "inherit[s] the parent's project, branch, and worktree path". Run preparation emits `prepared-run.progress` phases `worktree|setup` and supports `prepared-run.retry` — [orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md); [contracts L2740-L2760](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L2740)
- Parent wake-up:
  - `completionWake: "always"` is used for async delegations; it "offers a continuation on every terminal". `"settled_only"` is used for wait-mode; it "offers only when the parent has no live run".
  - Delivery goes through `continuationRequests.offer({... delivery: "message_text", delegatedCompletion: {parentRunId, generation, messageId}})`. The mailbox "steers a capable active session or queues behind that run".
  - Comment: "a missed wake is cheaper than a duplicate one, and the result is already in the projection".
  - Source: [contracts L671-L677](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L671); [Orchestrator.ts L976-L1020](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L976)
- Forks:
  - `thread.fork` creates the target `AppThread` with lineage and a `ContextTransfer(type=fork, status=pending)`. It needs no provider session, provider thread, or handoff.
  - The first message on the fork resolves it: provider-native fork if same provider with strong refs (Codex `thread/fork` with inclusive `lastTurnId`), else a lazily materialized portable `ContextHandoff`.
  - "Active source runs are rejected"; `latest_stable` resolves to the latest completed checkpointed run.
  - Source: [thread-lineage-and-context-transfer.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/thread-lineage-and-context-transfer.md); [ThreadForkService.ts L34-L38](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ThreadForkService.ts#L34)
- `ContextTransfer.type` is `fork | provider_handoff | merge_back | subagent_spawn | subagent_result`. Status: `pending|resolved_native|resolved_portable|failed|consumed|superseded`. Resolution strategies: `native_fork|portable_context|delta_context|checkpoint_context` — [core-graph-and-data-model.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/core-graph-and-data-model.md)
- Merge-back: "user sends next source-thread message with merge-back intent → ContextTransfer(type=merge_back, basePoint=S, sourcePoint=F) → build delta context lazily → inject delta with the next source-thread user message". The delta covers "decisions, files changed, commands/tests run, conclusions, and unresolved issues", not the transcript. There is a `thread.merge_back` command and a `ThreadMergeBack.integration.test.ts` — [feature-lifecycles.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/feature-lifecycles.md); [testkit/ThreadMergeBack.integration.test.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/ThreadMergeBack.integration.test.ts)
- Provider switching:
  - Example: runs 1–5 on Codex C1, switch to Claude (summarize 1–5, new thread L1), runs 6–8 on L1, switch back. Then "resume Codex provider thread C1 if possible, summarize runs 6–8 for Codex" (`delta_since_target_last_seen`). Fallback is `full_thread_summary`.
  - "Provider switching should never concatenate hidden summaries into arbitrary prompts without recording the handoff."
  - The handoff token cap is `DEFAULT_HANDOFF_TOKEN_CAP = 16_000`, with a pessimistic "one UTF-8 byte per token" estimate.
  - Source: [feature-lifecycles.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/feature-lifecycles.md); [ContextHandoffBudget.ts L14, L107-L110](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ContextHandoffBudget.ts#L14)
- Steering and queueing:
  - `message.dispatch.dispatchMode` is `defer_start | steer_active{targetRunId} | restart_active{targetRunId} | queue_after_active | start_immediately`, plus `deliveryIntent: auto|steer|restart` "Resolve untargeted delivery against the server's serialized thread state".
  - Queue commands: `queued-run.edit/reorder/cancel`, `queued-message.promote-to-steer`, `queue.resume`.
  - `ThreadManagementService` mode `auto` "starts an idle thread, steers a fully active turn, or queues behind a turn that is not yet steerable".
  - Source: [contracts L2696-L2733](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L2696); [ThreadManagementService.ts L37, L533-L555](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ThreadManagementService.ts#L533); [orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md)
- Steering without native support: "interrupts the active provider turn, finalizes the interrupted attempt, and starts a replacement provider turn" under the same `RunId` as a new `RunAttempt` (`reason: steering_restart`). Grok/ACP "uses orchestrator-owned child threads and implements steering through cancel-and-restart" — [feature-lifecycles.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/feature-lifecycles.md); [orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md)
- Checkpoints:
  - `CheckpointScope` has kind `root_run|subagent|tool|provider_thread|manual` and `advancesAppRunCount`.
  - Only root-run checkpoints advance the run count.
  - A completion barrier flushes text, finalizes plans, and closes non-live children, then captures the checkpoint, then publishes the run terminal.
  - Rollback to run N restores the filesystem, calls provider rollback when supported, and marks later runs `rolled_back`.
  - Source: [core-graph-and-data-model.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/core-graph-and-data-model.md); [feature-lifecycles.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/feature-lifecycles.md)
- Checkpoint mechanics:
  - Hidden git refs (`refs/t3/orchestration-v2/checkpoints`), captured with a temporary `GIT_INDEX_FILE` in the git common dir, so no commits land on the user's branch.
  - "A provider that cannot roll back its conversation must reject that operation before changing the filesystem."
  - Late checkpoints must not extend the recorded provider duration (`RunFinalizationService`).
  - Source: [CheckpointService.ts L26](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/CheckpointService.ts#L26); [GitVcsDriver.ts L801-L830](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/vcs/GitVcsDriver.ts#L801); [overview.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/internals/overview.md)
- Plans: `todo_list` (Codex `turn/plan/updated`), `proposed_plan` (plan-mode final plan), and `questions` plus a `RuntimeRequest(user_input)`. "Child plans do not replace root plans unless promoted/forked" — [feature-lifecycles.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/feature-lifecycles.md)

### Inferences
- For Solenta (forked worker threads in separate worktrees):
  - Copy T3's **command-derived child ids**, the **spawn/result context-transfer records**, the **wake policy (`always` vs `settled_only`) delivered by steer-or-queue**, and the **privilege-narrowing rule**.
  - Do not copy T3's choice to put delegated children in the parent's checkout. Solenta's per-worker worktrees are stricter isolation than T3's `delegate_task` default.
- Lazy fork resolution (record lineage now, choose native vs. portable context when the first run picks a provider) fits Solenta's cross-provider `thread_fork` directly. Today Solenta passes only a truncated digest; T3 would store a `ContextTransfer` and materialize a budgeted handoff at first run.

### Gaps
- `ProviderSwitchService.ts` and `ContextHandoffService.ts` were not read in full. The exact summarizer used to generate handoff text (LLM call vs. transcript excerpting) was not confirmed. The legacy import handoff uses raw transcript suffixes within 32,000 chars ([legacy-orchestration-migration.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/internals/legacy-orchestration-migration.md)), and the budget code suggests excerpt selection ("Prioritize the latest request and partial answer, then original constraints").

## 6. Client protocol: WebSocket/RPC, subscription, sequence numbers, reconnection

### Takeaway
Clients use Effect RPC over one authenticated WebSocket. Methods include `orchestration.dispatchCommand`, `subscribeShell`, and `subscribeThread`. A thread subscription sends `snapshot{snapshotSequence, projection}` followed by `event{sequence, event}` items, then a `synchronized` marker. Clients resume with `afterSequence`. The server decides between replaying the gap (≤128 events and ≤1 MiB) and sending a fresh bounded snapshot. Clients drop any item with `sequence ≤ lastApplied`. A protocol-version gate rejects mismatched clients with HTTP 426.

### Cited Findings
- WS methods: `orchestration.dispatchCommand, getTurnDiff, getFullThreadDiff, searchThreads, getArchivedShellSnapshot, getThreadProjection, getWorkflowScript, launchThread, subscribeArchivedShell, subscribeShell, subscribeThread` — [contracts L2964-L2976](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L2964)
- Thread stream item union: `{kind:"synchronized"} | {kind:"snapshot", snapshotSequence, projection, historyCursor?, hasMoreHistory?, latestLocalTurnOrdinal?, payloadBudgetExceeded?} | {kind:"event", sequence, event}`, plus an unknown-event arm for forward compatibility — [contracts L3168-L3192](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L3168)
- Snapshot-plus-cursor contract: "read snapshot at sequence N → stream committed V2 events where sequence > N… Reconnects may reset from a fresh snapshot" — [core-graph-and-data-model.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/core-graph-and-data-model.md)
- Command dispatch "returns the last committed stored-event sequence for accepted commands. Duplicate command ids must return the same receipt-backed result… This is the API-level boundary the frontend uses for reconnect/recovery cursors" — [README.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/README.md)
- Resume decision: `THREAD_RESUME_MAX_REPLAY_EVENTS = 128`, `THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES = 1_048_576`. `decideThreadResume` returns `snapshot` if `afterSequence > highWater` or a budget is exceeded, otherwise `replay(afterSequence, highWater)` — [ThreadStream.ts L10-L96](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ThreadStream.ts#L10)
- Server-side live stream: subscribe to PubSub first, read the high-water mark, then `concat(replay(≤highWater), live.filter(seq > max(highWater, afterSequence)))`, so no gap or duplicate occurs between catch-up and live — [EventSink.ts L707-L750](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EventSink.ts#L707)
- Backpressure:
  - `LIVE_STREAM_MAX_ITEMS = 1_000` per subscription. "RpcServer requests the next batch only after the client ACKs this one".
  - `ThreadLiveEventCoalescer` keeps "only the latest in-flight update for each stable tool-call id… terminal updates are never discarded".
  - `WireProjection` trims command output and diffs on the wire; "Full diffs already have a dedicated read path".
  - Source: [LiveStreamBudget.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/LiveStreamBudget.ts); [ThreadLiveEventCoalescer.ts L44-L46](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ThreadLiveEventCoalescer.ts#L44); [WireProjection.ts L76-L87](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/WireProjection.ts#L76)
- Client apply: `if (item.sequence <= sequence) continue;` and "An event type from a newer server still moves the resume cursor past it". The resume cursor is seeded from a cached snapshot so a warm cache catches up through `afterSequence`. A shared idle cache keeps state and cursor for 5 minutes — [client-runtime threads.ts L210-L235, L440-L470](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/threads.ts#L440); [connection-runtime.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/internals/connection-runtime.md)
- Version gate: clients append `orchestrationProtocol=2` to the socket URL, and `/ws` rejects a missing or mismatched version with HTTP 426 `orchestration_protocol_incompatible` before RPC or auth — [legacy-orchestration-migration.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/internals/legacy-orchestration-migration.md); [ws.ts ~L3783](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/ws.ts#L3783)
- One transport-retry owner per environment: jittered exponential backoff capped at 5 minutes, and transport health is kept separate from data freshness — [connection-runtime.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/internals/connection-runtime.md)

### Inferences
- Solenta's renderer could adopt the same contract over Electron IPC: a global monotonic sequence, snapshot then delta subscription per thread, and a client-side `seq <= applied` drop. That would replace ad-hoc store broadcasts.

### Gaps
- The shell (sidebar) subscription reducer (`shellReducer.ts`, `ShellStream.ts`) was not examined in detail.

## 7. Testing approach

### Takeaway
Tests are replay-backed integration tests. They run the real orchestrator, adapter, normalizer, event sink, projections, and checkpoint policy. Only the provider transport is replaced, by NDJSON transcripts. Clock and Random come from Effect test services.

### Cited Findings
- "Test doubles exist only at true process, network, clock, id, and filesystem boundaries." The chain under test is dispatch → real Orchestrator → real ProviderAdapter → **replayed transport** → real normalizer → real event sink → real projection → real checkpoint policy. Not allowed: a mocked orchestrator, adapter, normalizer, sink, projection reducer, or capability policy, or "pre-normalized domain events used as the input for adapter tests" — [testing-strategy.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/testing-strategy.md)
- Transcript entries are `expect_outbound`, `emit_inbound` (with `afterMs`), and `runtime_exit`. Fixtures live under `testkit/fixtures/<scenario>/{claude_transcript.ndjson,input.ts,output.ts}` (for example `claude_background_subagent_lifecycle`, `claude_idle_resume`, `claude_compact_after_peer_turn`) — [testing-strategy.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/testing-strategy.md); [testkit/](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts)
- Production code must read time through `DateTime.now`/`Clock` and randomness through `effect/Random`, so `TestClock` and deterministic Random make ids stable — [testing-strategy.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/testing-strategy.md)
- Large integration suites include `ProviderSwitch.integration.test.ts` (3,315 lines), `ThreadFork.integration.test.ts`, `ThreadMergeBack.integration.test.ts`, `SteeringCompletion.integration.test.ts`, `OrchestratorReplayRecovery.integration.test.ts`, and `FoundationPersistence.test.ts` (3,383 lines). There are also opt-in `*.live.test.ts` runs against real Cursor, Grok, OpenCode 2, and ACP registry agents — [orchestration-v2/](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts)
- Tests wait on drainable workers or on specific persisted events or receipts. "Production behavior must use persisted state and events, not test instrumentation or assumptions about elapsed time" — [overview.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/internals/overview.md)

### Inferences
- The "record real CLI frames once, replay through the real adapter" approach would close the gaps Solenta hit with mocked provider seams. Solenta's memory notes record failures that unit tests missed: green tests hid gaps, and workers each mocked the other side of a seam.

### Gaps
- No CI-timing or flakiness data for these suites was found.

## 8. V1 → V2: what changed and why

### Takeaway
V1 was a single global command queue: a pure `decider` plus `projector` over an in-memory read model, with PubSub domain events consumed by **live reactors**. The reactors (`ProviderCommandReactor`, `ProviderRuntimeIngestion`, `CheckpointReactor`, `ThreadDeletionReactor`, settlement and PR reactors) performed provider side effects implicitly from subscriptions, and provider turn ids were tangled with app turns. V2 replaces this with:
- per-thread locks;
- a transactional receipt + events + projection + outbox commit;
- a leased effect worker;
- deterministic app-owned ids;
- the run/attempt/node graph;
- server-owned queueing, settlement, and subagents.

The PR body justifies each change by the V1 bug class it removes.

### Cited Findings
- V1 files at the parent of the merge (`024d4952`): `orchestration/decider.ts`, `projector.ts`, `Layers/OrchestrationEngine.ts`, `Layers/ProviderCommandReactor.ts`, `Layers/ProviderRuntimeIngestion.ts`, `Layers/CheckpointReactor.ts`, `Layers/ProjectionPipeline.ts`, `Layers/RuntimeReceiptBus.ts`, `Layers/ThreadDeletionReactor.ts`, `ThreadSettlementReactor.ts` — [V1 tree @024d4952](https://github.com/pingdotgg/t3code/tree/024d49520eadb24cc2f2cef0b0a82c33f0290813/apps/server/src/orchestration)
- V1 engine: `const commandQueue = yield* Queue.unbounded<CommandEnvelope>()` and `const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)))`, a single worker over an in-memory `commandReadModel`, with a fresh PubSub subscription per consumer ("wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc."). The V1 reactor reacts to `thread.turn-start-requested`, `thread.turn-interrupt-requested`, `thread.approval-response-requested`, and similar events. Its comments note "Orchestration turn ids are not provider turn ids, so interrupt by session" — [V1 OrchestrationEngine.ts](https://github.com/pingdotgg/t3code/blob/024d49520eadb24cc2f2cef0b0a82c33f0290813/apps/server/src/orchestration/Layers/OrchestrationEngine.ts); [V1 ProviderCommandReactor.ts](https://github.com/pingdotgg/t3code/blob/024d49520eadb24cc2f2cef0b0a82c33f0290813/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts)
- Stated rationale for the outbox: the reactor pipeline "is valid, but it can become hard to trace because the provider side effect is implicit in a live subscription" — [README.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/README.md)
- Rationale lines from the PR's "Closes" list:
  - #11907: "V2 commits intent, projection and command receipt in one transaction with idempotent receipts, and holds sends as server-side queued turns, removing the V1 admission r[ace]".
  - #11889: "V2 deletes the reactor-based path (ThreadDeletion.ts runs through the serialized orchestrator and effect worker)".
  - #871: "V2 mints message identity itself… instead of keying projections on provider-supplied message [ids]".
  - #12904: V2 "replaces [the V1 adapter layer] with ProviderSessionManager plus ProviderRuntimeRecoveryService".
  - #5436: "the follow-up queue server-owned and durable (queued messages keep order and are held across a server restart)".
  - #2477: "V2 models native subagents as distinct lineage nodes with their own projection rows rather than splicing their text into the parent stream".
  - #5454: "ProviderRuntimeRecoveryService reconciles on startup/shutdown and cancels every pending runtimeRequest".
  - #12885: "Cross-thread session eviction is a V1 session-lifecycle race".
  - Source: [PR #2829](https://github.com/pingdotgg/t3code/pull/2829)
- User-visible V2 features listed by maintainers: OpenCode 2, Pi, and ACP Registry agents; "Subagents and background work you can see, and that Stop actually ends"; "Steer or queue, with a server-side queue"; "Switching providers mid-thread, plus native fork and rollback"; threads without a project; MCP tools for agents; scheduled tasks and usage-limit handling — [Issue #14871](https://github.com/pingdotgg/t3code/issues/14871)
- Migration: there is no V1 event-log replay. `LegacyV1ThreadImporter` creates thread shells first and imports user and assistant messages lazily on read or continue. It does not translate provider sessions, checkpoints, tool activity, approvals, or plans. The first continuation sends a transcript-suffix handoff within 32,000 chars — [legacy-orchestration-migration.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/internals/legacy-orchestration-migration.md)
- Design philosophy in AGENTS.md: "Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive… fight for the smallest model that makes the correct behavior unsurprising." Agents are a first-class "surface": "A capability a user can trigger is usually one an agent should reach through MCP tools… That only works when it is a service method, not handler code." — [AGENTS.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/AGENTS.md)

### Inferences
- V1's core flaw was that side effects hung off live subscriptions. A crash, a missed event, or a reconnect could double-start or orphan provider work, and the app had no durable record of which effect was owed. V2's fix generalizes to Solenta: an effect is a durable row created in the same transaction as the intent, and a lease-holding worker settles it. Solenta's `coder-store.json` plus in-process orchestration would need a SQLite (or equivalent) log to get this.
- Ranked for Solenta adoption, by value per effort:
  1. Deterministic, command-derived ids plus command receipts (idempotent `thread_fork`/`thread_send`).
  2. A per-thread keyed lock with a no-nesting lock order.
  3. Separating Run from ProviderTurn attempts, so steering by restart and child completion cannot close parent turns.
  4. A durable per-thread FIFO effect outbox with leases.
  5. A `ContextTransfer` record for fork, switch, merge-back, and subagent spawn/result.
  6. Snapshot+sequence client sync.
  7. Replay-transcript integration tests.

### Gaps
- Pre-September-2026 V1 history and the private V2 branch commits are not in this shallow clone, so the incremental rationale (beyond the PR body and docs) could not be traced commit by commit.
