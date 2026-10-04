# Steal Orchestrator V2's invariants, not its engine

T3 Code's "Orchestrator 2.0" is officially **T3 Code Orchestrator V2**. It is a rewrite of T3 Code's agent runtime: PR #2829, open for four months, merged on 2026-10-02 at **+380,729/−203,651 lines across 1,912 files**. It has been **nightly-only since 2026-10-03**, and the stable v0.0.45 is still V1. Under the hood it is event-sourced CQRS on SQLite. Each command is serialized per thread, and one database transaction commits three things together: the events, an idempotency receipt, and a durable outbox of side effects that a leased worker later performs. On top of that engine sit the user-facing features: cross-provider `delegate_task`, a T3 MCP server that lets agents drive other threads, a Lineage view of subagents, fork and merge-back, server-side steer-or-queue, and recovery after restarts and usage limits.

Solenta already matches or beats most of that feature list. It has cross-provider forks into isolated worktrees, configurable worker pools, a crew task board, human-gated landing, verify gates and Planboard. It is also stricter in the places where V2 is loosest: V2's delegated children share the parent's checkout, and V2 shipped with permission regressions.

Solenta falls behind V2 in three areas:
- **Durability.** Wake-ups and auto-turn counts live in in-memory Maps, and a restart marks every running thread failed.
- **Control.** A lead cannot steer its workers mid-run.
- **Identity.** The MCP server trusts thread ids that agents supply themselves. In this checkout, `thread_stop` and `thread_archive` skip the human-approval gate entirely when the caller leaves out `fromThreadId`.

**My recommendation is not to port V2's 10,000-line engine.** Instead, port four of its invariants into the existing JSON store and `orchServer.js`:
1. owed work is a persisted row, not a Map entry;
2. caller identity comes from the transport, not from tool arguments;
3. delivery to a running thread is steer-or-queue;
4. a child's result comes back as structured data, not just a line of text.

The adoption plan at the end turns these into nine items. The three that come first are small.

## V2 rebuilt T3's agent runtime and reached nightly on October 3

**Name and status.** Nobody at T3 calls it "2.0". The release notes say "T3 Code Orchestrator V2". The only "2.0.0" is the version number of the V2-compatible mobile beta app ([Issue #14871](https://github.com/pingdotgg/t3code/issues/14871)). The release notes define its scope: V2 "rebuilds the part of T3 Code that runs your agents: how turns start, stop, queue, and resume; how subagents and background work are tracked; how threads move between providers; and how history is saved" ([Release v0.0.46-nightly.20261003.2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)).
- Julius Marminge opened PR #2829 on 2026-05-27 and squash-merged it on 2026-10-02. Its description closes roughly 80 existing issues ([PR #2829](https://github.com/pingdotgg/t3code/pull/2829)).
- The first nightly carrying V2 shipped at 01:10 UTC on 2026-10-03. Four more nightlies of fixes followed within 30 hours ([Releases](https://github.com/pingdotgg/t3code/releases)).
- Stable v0.0.45 shipped about an hour *before* the merge, so stable users and the mobile store apps are still on V1 ([Issue #14871](https://github.com/pingdotgg/t3code/issues/14871)).
- Theo had been teasing it since August as "a big overhaul of the orchestration layer (aka Orchestrator V2)" that was blocking other work ([Theo on X](https://x.com/theo/status/2085238155746406605)).

**What V1 was and why it broke.** V1 was itself event-sourced: PR #89 in February 2026 moved state from the client to a SQLite event log on the server ([PR #89](https://github.com/pingdotgg/t3code/pull/89)). Its engine had two weak points:
- **A single global command queue.** One unbounded queue fed one worker, which ran over an in-memory read model.
- **Side effects inside subscriptions.** Provider side effects ran from *reactors*, which are live PubSub subscribers to events such as `thread.turn-start-requested` ([V1 OrchestrationEngine.ts](https://github.com/pingdotgg/t3code/blob/024d49520eadb24cc2f2cef0b0a82c33f0290813/apps/server/src/orchestration/Layers/OrchestrationEngine.ts)).

The V2 design docs name the flaw directly: that pipeline "can become hard to trace because the provider side effect is implicit in a live subscription" ([docs/orchestration-v2/README.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/README.md)). The PR's "Closes" list reads like a catalogue of the resulting bugs ([PR #2829](https://github.com/pingdotgg/t3code/pull/2829)):
- messages keyed on provider-supplied ids (#871);
- a follow-up queue that did not survive restarts (#5436);
- parents never woken when delegated children finished (#2778);
- subagent text spliced into the parent stream (#2477);
- Stop that did not end background work (#11428).

V2's stated goals answer each one: app-owned ids, "one execution graph" for turns, subagents, tools and approvals, and the rule that **"child execution completion never closes the parent run"** ([README.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/README.md)).

**Migration.** The migration is a copy, not an in-place upgrade. The first V2 launch copies `state.sqlite` to `statev2.sqlite` and migrates the copy, so V1 and V2 can be installed side by side ([Issue #14871](https://github.com/pingdotgg/t3code/issues/14871)).
- Carried over: titles, projects, branches, worktrees and messages.
- Dropped: live sessions, old checkpoints and diffs, tool activity, approval history and proposed plans.

T3 paid for the rewrite with history. That cost matters for any Solenta store rewrite.

## Agents run agents through one MCP server and a lineage panel

V2's headline user feature is **`delegate_task`**. It "lets an agent hand work to a child agent on any provider and model, with its own options and role. Each child runs as its own thread, keeps its own provider-native history, and reports a result." The parent can wait or keep working, and "wakes up when they finish, with results batched together." T3 calls this "**the recommended way to combine harnesses**, for example Claude planning and Codex implementing" ([Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)).
- **Parameters:** a target provider and model, a `role` (implementation, research, review, design, test, general), `mode: async | wait`, a `clientRequestId` for idempotent retries, and runtime and interaction modes.
- **Privilege ceiling:** the child's runtime mode can only stay equal to the parent's or narrow.
- **No inherited history:** the child receives only the task prompt. "Parent conversation history is not copied into the child" ([orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md)).

Around it sits a dozen documented MCP tools (`orchestrator_capabilities`, `task_status`/`task_cancel`, `create_threads`, and `t3_thread_launch/list/read/update/send/wait/interrupt`). T3 injects them into every provider session with a **session-scoped bearer token** that is minted before the session opens and revoked on release ([orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md)).

| Feature group | What ships in the V2 nightly | Source |
|---|---|---|
| Cross-provider delegation | `delegate_task`, `task_status`, `task_cancel`; parent woken with batched results | [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610) |
| T3 Code MCP | Agents create, launch, message, wait on, read, search and interrupt threads; fork and merge back; edit queues; link PRs; hand work to a worktree. "Agents can't approve their own permission requests" | [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610) |
| Lineage | Native subagents from Claude, Codex, OpenCode 2, Cursor and Pi shown as child threads with model, status, progress, result and duration; "N running"; stop from Lineage | [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610); [PR #15211](https://github.com/pingdotgg/t3code/pull/15211) |
| Fork and merge-back | Fork from any finished run, including failed or limited ones, using native fork where the provider has one; merge the fork's *context* back as a delta | [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610); [feature-lifecycles.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/feature-lifecycles.md) |
| Provider switching | Change provider or model between turns; explicitly "lossy"; handoff capped at 16,000 tokens | [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610); [portable-handoffs.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md) |
| Queue | Server-owned, survives restarts and usage limits; edit, reorder, steer queued messages; a setting picks steer or queue, and Cmd/Ctrl+Enter inverts it | [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610) |
| Recovery | **Limited** state with "resume at reset"; continue threads after restart; live context meter | [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610) |
| PR lifecycle | Agents watch a PR and are woken on checks, reviews or conflicts; threads settle when their PR merges | [Release .2632](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2632); [Release .2623](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2623) |

**There is no orchestrator mode and no task board.** The user chats with a normal thread and either asks the agent to delegate or lets it decide. Children appear as collapsible subagent cards inline and as nodes in a thread-details Lineage panel. Background completion wakes the parent, which "says which subagent, command, or monitor finished" ([Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)). V2 also removed things:
- "The separate agents panel is gone."
- "Subagent threads are read-only. Message the parent thread instead."
- Grok no longer offers auto-accept edits.

Busy threads collapse into a beta **Working** section and return to the top "when it finishes, fails, or needs an approval or answer" ([thread-sidebar.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md)). Solenta already reimplemented this behaviour as its Working shelf ([ARCHITECTURE.md:836-851](../docs/ARCHITECTURE.md#L836)). Routing work to particular models happens per prompt. Users have already filed a request for configurable rules such as "research → Gemini Flash, implementation → GPT" ([Issue #15181](https://github.com/pingdotgg/t3code/issues/15181)).

**Early reception is enthusiastic but buggy, and the bugs cluster.** People ran the unmerged branch in personal forks, and a third-party CLI went "orchestrator V2 only" within a day ([t3code-cli v0.3.0](https://github.com/MajesteitBart/t3code-cli/releases/tag/v0.3.0)). A newsletter rated it 9/10 but warned readers to "test the new nightly's handoffs before trusting long-running work" ([High Learning Rate](https://highlearningrate.substack.com/p/switch-coding-agents-mid-thread-2026)). A rough search finds **82 issues mentioning V2 opened in its first two days** ([t3code issues](https://github.com/pingdotgg/t3code/issues)). They fall into four groups:
- **Status truthfulness in the supervision UI.** This is the largest group. Examples: a steered subagent still shows "Done" ([#13331](https://github.com/pingdotgg/t3code/issues/13331)), Codex subagents lose status after restart ([#15567](https://github.com/pingdotgg/t3code/issues/15567)), and token usage is missing ([#15429](https://github.com/pingdotgg/t3code/issues/15429)).
- **Delegation wake and stop edge cases.** A parent is never notified of a child's follow-up turn ([#13490](https://github.com/pingdotgg/t3code/issues/13490)).
- **Safety regressions.** "Claude Auto mode on orchestrator v2 runs ask-rule commands without prompting" ([#15353](https://github.com/pingdotgg/t3code/issues/15353)) and "silently approves native plan-mode write requests" ([#15503](https://github.com/pingdotgg/t3code/issues/15503)).
- **Resource leaks.** Worktrees are never freed for finished threads ([#15146](https://github.com/pingdotgg/t3code/issues/15146)), and one user saw about 80 idle processes using 9 GB over a day ([#13331](https://github.com/pingdotgg/t3code/issues/13331)).

## One SQLite transaction commits intent, events and owed side effects

**The data model is a graph owned by the app.** Each `AppThread` holds counted `Run`s, which are user turns. Each Run has `RunAttempt`s, with reasons `initial`, `steering_restart`, `retry` or `provider_recovery`. Each attempt has a tree of `ExecutionNode`s: root turn, message, reasoning, plan, tool call, approval request and subagent. Provider sessions, threads and turns are kept as *references*, never as identity. "The root node of a run is the only node allowed to complete the run" ([core-graph-and-data-model.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/core-graph-and-data-model.md)).
- Every `*.updated` event carries the **whole entity**. Server projections and client state therefore both apply as idempotent upserts by id, with no reducer logic per event type ([ProjectionStore.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProjectionStore.ts#L1674); [orchestrationV2Projection.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/orchestrationV2Projection.ts)).
- Ids are **deterministic**, for example `run:thread:<id>:ordinal:<n>` and `node:run:<runId>:root`. A delegated child's thread, node and message ids are all derived from the `commandId`, so a retried command cannot create a second child ([IdAllocator.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/IdAllocator.ts#L389)).

**The command pipeline is the transferable core.** `dispatch` runs in six steps:
1. It takes a **per-thread keyed lock**. The lock is not reentrant and is never nested; cross-thread work takes locks one after another ([KeyedSerialExecutor.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/KeyedSerialExecutor.ts); [Orchestrator.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9866)).
2. It checks a **command receipt**. A duplicate id returns the original result without re-running side effects.
3. It plans `{events, effects}` with no I/O.
4. It commits in **one SQLite transaction**: the receipt, the events, the synchronously applied projections, and the **outbox rows for owed effects** ([EventSink.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EventSink.ts#L518)).
5. It publishes the events to subscribers in sequence order.
6. A leased **EffectWorker** performs the provider and filesystem I/O: starting, steering and interrupting turns, rollback, checkpoint capture and cleanup. It uses a 30-second lease and up to 5 attempts, with exponential backoff capped at 30 seconds. It runs **strictly one effect at a time per thread**, so "a turn cannot start while a failed rollback is about to restore files" ([EffectOutbox.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EffectOutbox.ts#L282); [EffectWorker.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EffectWorker.ts#L505)).

Effect results come back as new commands whose ids are derived from the effect, so replays stay idempotent. The internals doc sums it up: "A command acknowledgement therefore means the intent committed, not that the provider… finished" ([overview.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/internals/overview.md)).

**Recovery is conservative by design.** After process loss, T3 marks provider-bound work as finished and does not resurrect sessions ([ProviderSessionManager.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L66)).
- **Queued runs:** they keep their identity and order, but they "require explicit consent before draining" ([ProviderRuntimeRecoveryService.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L249)).
- **Delegated results:** they are settled from persisted state at startup ([Orchestrator.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9930)).
- **Parent wake-ups:** each subagent row carries a `completionWake` policy. `always` is used for async children and `settled_only` for wait-mode children. The wake is delivered through a mailbox that "steers a capable active session or queues behind that run". The governing rule is "**a missed wake is cheaper than a duplicate one, and the result is already in the projection**" ([Orchestrator.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L976)).

**Capabilities, not provider names, drive behaviour.** Each adapter publishes a versioned capability struct with flags such as `supportsActiveSteering`, `canForkThread` and `terminalStatusQuality`. When a capability is missing, the adapter falls back to a degraded behaviour ([provider-capability-system.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/provider-capability-system.md)):

| Missing capability | Fallback |
|---|---|
| Steering | Interrupt the turn and restart it as a new attempt under the same Run |
| Fork | Portable fork |
| Rollback | Restore the filesystem and mark the provider state divergent |

The other mechanisms follow the same "record it explicitly" pattern:
- **Forks** are cheap lineage records holding a pending `ContextTransfer`. The first run on the fork resolves it, natively where possible and otherwise with a budgeted portable handoff ([thread-lineage-and-context-transfer.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/thread-lineage-and-context-transfer.md)).
- **Merge-back** injects a *delta*, not the transcript: "decisions, files changed, commands/tests run, conclusions, and unresolved issues" ([feature-lifecycles.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/feature-lifecycles.md)).
- **Checkpoints** are hidden git refs, written through a temporary index, so no commits land on the user's branch ([CheckpointService.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/CheckpointService.ts#L26)).
- **Delegated children** copy the parent's project, branch and `worktreePath`, so **they work in the same checkout**. Only `t3_thread_launch` can create a new worktree ([SubagentProjection.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/SubagentProjection.ts#L42)).

**Clients sync by snapshot plus sequence.** A thread subscription sends a snapshot and then events. On reconnect the client asks to resume after its last sequence. The server replays the gap if it is at most 128 events and 1 MiB, and otherwise sends a fresh snapshot ([ThreadStream.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ThreadStream.ts#L10)).

**Tests replay recorded provider transcripts through the real engine.** NDJSON provider transcripts run through the real orchestrator, adapter, normalizer, sink and projections. "Test doubles exist only at true process, network, clock, id, and filesystem boundaries" ([testing-strategy.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/testing-strategy.md)).

**The machinery is large.** `Orchestrator.ts` alone is **10,258 lines**, and each provider adapter runs 2,662 to 7,898 lines ([orchestration-v2/](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts)).

## Solenta leads on isolation and landing but forgets owed work on restart

Solenta's orchestration is a protocol written as prompt text plus host-side gates, built from three primitives:
- the `handoffFrom` link to a parent thread;
- the `orchWorker` flag;
- an in-memory notice queue.

All of it is exposed through 28 `coder-threads` MCP tools ([orchServer.js:1220-1830](../electron/orchServer.js#L1220)). Mapped against V2, Solenta is ahead on breadth and isolation and behind on durability, control and identity.

| V2 capability | Solenta today | Verdict |
|---|---|---|
| Cross-provider children (`delegate_task`) | `thread_fork provider=`/`pool=` with failover, `@provider`, `/handoff` `/advisor` `/committee`, Best-of-N ([subagentPool.js:1-25](../electron/subagentPool.js#L1); [ARCHITECTURE.md:518-579](../docs/ARCHITECTURE.md#L518)) | **Ahead.** Pools are the configurable routing T3 users requested in #15181 |
| Child isolation | Each worker gets its own worktree, started from the lead's committed snapshot, with no fallback to main ([worktrees.js:495-614](../electron/worktrees.js#L495)) | **Stricter.** V2 children share the parent's checkout |
| Landing | Gated squash merge, `expectedPath`/`expectedBranch`, CI-file sign-off, 400-line PR cap, integration receipts, merge queue ([orchServer.js:559-657](../electron/orchServer.js#L559); [mergeQueue.js:1-45](../electron/mergeQueue.js#L1)) | **Stricter.** No PR-watch wake-ups |
| Lineage and Working shelf | Team roster, nested families, "Waiting on N" derived from thread state ([src/sidebarGroups.ts:436-458](../src/sidebarGroups.ts#L436); [src/waiting.ts:5-20](../src/waiting.ts#L5)) | **Parity** |
| First-party MCP pre-approval | `--allowedTools=mcp__coder-threads__*` for Claude and `default_tools_approval_mode="approve"` for Codex; user-added servers are never blanket-approved ([memory-sup.js:321-362](../electron/memory-sup.js#L321), [memory-sup.js:410-416](../electron/memory-sup.js#L410)) | **Parity** |
| Parent wake on child finish | `queueOrchNotice`/`flushOrchNotices` over an in-memory `Map` ([runner.js:1170](../electron/runner.js#L1170), [runner.js:1296-1434](../electron/runner.js#L1296)) | **Behind.** Not durable |
| Restart recovery | Every `working` thread is flipped to `failed`; pending wakes and auto-turn counts vanish ([store.js:1426-1460](../electron/store.js#L1426); [runner.js:1179](../electron/runner.js#L1179)) | **Behind** |
| Steering by a lead | `steerRun` exists for Claude and Codex, but only behind the UI and pairing tokens; MCP `thread_send` holds mid-run messages ([runner.js:8805-8851](../electron/runner.js#L8805); [orchServer.js:1350-1362](../electron/orchServer.js#L1350)) | **Behind** |
| Child result | The notice carries the first line of the last reply plus the branch ([runner.js:1296-1339](../electron/runner.js#L1296)) | **Behind** V2's structured delta |
| Caller identity | One shared token; `?projectId=` is bound in the URL, but the caller's thread id is a claimed argument ([orchServer.js:1964](../electron/orchServer.js#L1964)) | **Behind.** See below |
| Forks | A 12-message, 12,000-character tail digest built when the fork is created ([services.js:1209-1261](../electron/services.js#L1209)) | **Behind** for plain forks |
| Client sync | Snapshot plus tail patch with a per-thread `seq`; refetch on a gap ([src/useCoder.ts:1390-1435](../src/useCoder.ts#L1390)) | **Parity** for one local client |

**Durability is the largest structural gap.** Three things Solenta owes its crews live only in memory: the `active` run map, pending crew wake-ups (`orchNotices`) and consecutive machine-turn counts (`autoTurns`) ([runner.js:771](../electron/runner.js#L771), [runner.js:1170](../electron/runner.js#L1170), [runner.js:1179](../electron/runner.js#L1179)). Boot recovery then marks every in-flight thread failed with "Run interrupted: the app crashed or was force-quit mid-run" ([store.js:1432-1438](../electron/store.js#L1432)). The consequences:
- A lead whose workers were mid-run never learns they died.
- A worker that finished just before the crash may never wake its lead.
- The worktrees survive on disk, but nothing tells anyone to look at them.

Willem's own notes already record the cost: "an uncommitted worker loses everything it did when the run dies" ([memory note](/Users/willem/.claude/projects/-Users-willem-code-coder/memory/grok-worker-midrun-crash.md)).

V2 fixes the equivalent problem with a transactional outbox. Solenta needs much less, because its only lost owed work is *wake-ups*. The store already writes atomically (tmp → fsync → rename) with sharding ([store.js:1518-1555](../electron/store.js#L1518)). It can simply hold the notice queue.

**The identity gap is a real hole, found while verifying this report.** `requireOwnThread` checks only that the target thread belongs to the project ([orchServer.js:357-364](../electron/orchServer.js#L357)). `assertCrossThreadApproved` begins with `if (!fromId || fromId === targetId) return;` ([orchServer.js:536-539](../electron/orchServer.js#L536)). So an agent that omits the optional `fromThreadId` gets through `thread_stop` and `thread_archive` on *any* thread in its project with no human approval ([orchServer.js:1012-1016](../electron/orchServer.js#L1012), [orchServer.js:1058-1061](../electron/orchServer.js#L1058)). That contradicts the stated rule that cross-thread stop and archive are "the user's decision in every permission mode, including Auto and Bypass".

The same weakness affects the merge gate's "turn check is the real lock" comment ([orchServer.js:500-504](../electron/orchServer.js#L500)). The machine-turn check runs on whichever thread id the caller *claims*. I found this by reading the code and did not exercise it live. Solenta closed the cross-project version of this hole in #671 by binding `projectId` in the URL. V2's session-scoped tokens show the same move applied to thread identity.

**Control and result quality are the remaining gaps.** Solenta already has a working steer path for Claude and Codex (`supportsSteer`, [providers.js:74](../electron/providers.js#L74)). Leads simply cannot reach it, because INSTRUCTIONS tell them "Mid-run sends are held, not injected" ([orchServer.js:93-94](../electron/orchServer.js#L93)). When a worker finishes, the lead receives one line of text. Yet the data for a V2-style result delta already exists in four places:
- the lead snapshot sha ([services.js:1384-1466](../electron/services.js#L1384));
- the verify-gate verdict ([runner.js:1485-1525](../electron/runner.js#L1485));
- the hypothesis ledger ([services.js:1105-1150](../electron/services.js#L1105));
- the worker's review itinerary ([reviewItinerary.js:1-45](../electron/reviewItinerary.js#L1)).

A diffstat in that notice would also have caught the `core/dist` symlink that a worker merge landed on main ([memory note](/Users/willem/.claude/projects/-Users-willem-code-coder/memory/worker-merge-clobbers-core-dist.md)).

**One older blocker is already closed.** The permission-blocked worker that "stays 'working' forever" (#31) now pops its whole family off the Working shelf, because `awaitingInput` is set on permission prompts and the sidebar treats it as needing the user ([runner.js:2599](../electron/runner.js#L2599); [src/sidebarGroups.ts:446-450](../src/sidebarGroups.ts#L446)). What remains is stale INSTRUCTIONS text telling leads to poll for it ([orchServer.js:99-101](../electron/orchServer.js#L99)).

## Solenta should decline V2's engine and six of its defaults

**The event-sourced rewrite.** The strongest argument for copying V2 wholesale is that its durability is a property of the architecture rather than a pile of patches. Solenta's recent history is full of race fixes, such as honouring Stop while a run is preparing (#1228) and Codex "already has an active writer" (#1265). Against that, the cost:
- T3 spent **four months and a net +177,000 lines** on the rewrite.
- It shipped 82 issues in two days.
- Its migration dropped checkpoints, tool activity, approvals and plans ([PR #2829](https://github.com/pingdotgg/t3code/pull/2829); [Issue #14871](https://github.com/pingdotgg/t3code/issues/14871)).

The failure that justified it, side effects hanging off live PubSub subscriptions, does not exist in Solenta. Solenta's runner calls providers directly. It already rejects late writes by re-checking `runId`, the same guard as V2's `writeIfRunCurrent` ([ARCHITECTURE.md:45-51](../docs/ARCHITECTURE.md#L45)). Porting the engine would add a second 10,000-line god-module beside a 9,317-line `runner.js`.

Revisit this when one of three things happens:
- remote, web or SSH clients need offline resume rather than refetch;
- the governance spec's HMAC-chained audit log ([governance spec](../docs/superpowers/specs/2026-09-02-governance-layer-v1-design.md#L1)) becomes a requirement;
- store flushes become the bottleneck.

If that day comes, use T3's copy-then-migrate approach so rollback stays trivial.

**Shared checkouts for children.** V2's `delegate_task` and `create_threads` put children in the parent's working tree. Solenta's one-worktree-per-worker model, pinned to the lead's committed snapshot, is stricter. T3 users are already asking for "isolated / elastic compute for delegated workers" ([Discussions](https://github.com/pingdotgg/t3code/discussions)).

**Mid-thread provider switching.** T3 itself calls the handoff "lossy" and tells users to use `delegate_task` instead ([Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)). Solenta's `@provider` fork is already that recommended path.

**Blocking waits.** Solenta does not need `t3_thread_wait` or `mode: "wait"`. A Solenta lead that ends its turn and is woken later spends zero tokens while it waits. V2's own docs note that "a wait timeout does not cancel the child", and wait-mode requires the separate `settled_only` wake policy to avoid double delivery ([orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md)).

**Read-only worker threads.** In Solenta the user can answer a worker's permission prompt directly, and #1421 already routes them there.

**Separate subagent status rows.** V2's largest bug class comes from a projected `Subagent` row disagreeing with the child thread's real state, as in #13331 and #15567. Solenta derives "Waiting on N" and shelf placement from thread status with "no new state" ([src/waiting.ts:5-20](../src/waiting.ts#L5)). Keep deriving.

**Agent-merged landing.** V2 lets agents link and watch PRs, and settles threads "as soon as an agent merges their PR" ([Release .2623](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2623)). Solenta's gate exists because "13 worker branches were committed straight onto main in a single day" ([orchServer.js:495-498](../electron/orchServer.js#L495)). Adopt the watch-and-wake half only.

**Hidden-ref checkpoints: defer, don't adopt.** The idea is attractive. But Solenta's `coder-checkpoint` commits are what `thread_merge` squashes and what the verify gate runs against ([worktrees.js:5282-5334](../electron/worktrees.js#L5282)). Moving them to hidden refs would add a commit-at-merge step for a mostly cosmetic gain.

## Conclusion

Every V2 feature Solenta lacks, from PR-watch wakes to lead steering to restart resume, comes back to one property: **owed work is data, not memory**. The feature lists matter less than that. Solenta's sophistication lives in prompt text and in-memory Maps, and each new gate was retrofitted after an incident. The cheapest form of V2's insight is three rules:
- a notice is a store row;
- a caller's identity comes from the URL it was given;
- a child's result is a structured record the host assembles from data it already has.

None of them requires SQLite, CQRS or a new process.

The comparison also shows that the two products are converging from opposite ends. T3 users are asking for things Solenta already ships: configurable model routing (#15181), isolated compute for delegated workers (#15516), and a Working shelf that Solenta borrowed from T3 itself. Solenta, in turn, needs the durability T3 just paid four months to build.

V2's bug stream is also a warning. The hard part of multi-agent supervision is keeping status honest after steers, restarts and follow-ups. So the first thing Solenta should build alongside any of the plan items below is a replay harness that proves those transitions.

## Prioritized adoption plan

Sizes are my estimates. **S** is up to about 150 changed lines plus tests, roughly a day. **M** is about 300–800 lines, several days. Together the nine items come to roughly **four to six engineer-weeks**. Items 1, 3 and 4 touch different files and can run in parallel in week one. The `orchServer.js` items (1 and 5) and the `queueOrchNotice` items (2 and 3) should be sequenced, or should share a committed contract first ([memory note](/Users/willem/.claude/projects/-Users-willem-code-coder/memory/forking-parallel-solenta-workers.md)).

| # | Item | V2 idea it borrows | Main Solenta touch points | Size | Depends on |
|---|---|---|---|---|---|
| 1 | Bind caller thread identity at the transport; enforce privilege narrowing on fork | Session-scoped MCP tokens; runtime-mode ceiling | `electron/orchServer.js`, `electron/memory-sup.js`, `electron/services.js` | S | none |
| 2 | Durable crew notices and honest restart with consent-gated resume | Outbox rows; "require explicit consent before draining" | `electron/runner.js`, `electron/store.js`, `electron/ipc.js`, `src/shared/ipc.ts`, lead UI in `src/` | M | none (4 helps) |
| 3 | Structured worker result in the wake, rendered as a card | Merge-back delta; `subagent_result` transfer | `electron/runner.js`, `electron/worktrees.js`, `electron/reviewItinerary.js`, `src/components/` | S + S | none |
| 4 | Replay-fixture provider harness | NDJSON replay through real adapters | test tree, provider `binEnv` in `electron/providers.js` | S–M | none |
| 5 | Lead steering via `thread_send mode:"steer"` | `t3_thread_send` steer/queue, capability-driven | `electron/orchServer.js`, `electron/crossThread.js`, `electron/runner.js` | S | 1 |
| 6 | Per-thread lifecycle lock | `KeyedSerialExecutor`, no-nesting rule | `electron/runner.js`, `electron/orchServer.js`, `electron/worktrees.js` | M | 4; after 2 and 5 |
| 7 | PR watch wake-ups and settle on merge | Watch-PR wake (.2632), settle on merge (.2623) | `electron/autodispatch.js` cadence, `electron/runner.js` notices, `electron/worktrees.js` retention | M | 2, 3 |
| 8 | Native same-provider forks, recorded handoff, `thread_read` tool | Lazy `ContextTransfer`, native fork, handoff references | `electron/services.js`, `electron/runner.js`, `electron/providers.js`, `electron/orchServer.js` | M | none |
| 9 | Idempotency receipts on `thread_fork`/`thread_send` (only if evidence warrants) | `clientRequestId` and command receipts | `electron/orchServer.js`, `electron/store.js` | S | evidence scan |

**1. Bind caller identity at the transport (S, first).**
- **Bind the thread id.** Solenta already writes a bound MCP config for each project ([memory-sup.js:1713](../electron/memory-sup.js#L1713)) and reads `projectId` from the request URL ([orchServer.js:1964](../electron/orchServer.js#L1964)). Add `threadId=<caller>` to that URL, pass it into `createToolHandlers` as `boundThreadId`, and treat it as the caller everywhere. Reject a conflicting claimed `fromThreadId`, as #671 does for `projectId`.
- **Close the omission path.** In `assertCrossThreadApproved` ([orchServer.js:536-556](../electron/orchServer.js#L536)), a missing `fromThreadId` now resolves to the bound id, so leaving it out no longer skips the gate. `isAutoTurn` then checks the real caller.
- **Pairing clients are unchanged.** External pairing clients keep their capability tokens ([pairing.js:1-28](../electron/pairing.js#L1)).
- **Enforce privilege narrowing.** In the same change, have `forkThread` ([services.js:1279-1382](../electron/services.js#L1279)) check that the child's snapped permission mode ranks no higher than the parent's. If it ranks higher, refuse with a typed error, as V2 does with `runtime_mode_escalation_denied` ([orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md)).
- **Escape hatch for headless Grok.** Headless Grok only works in `auto` mode ([memory note](/Users/willem/.claude/projects/-Users-willem-code-coder/memory/grok-headless-permissions.md)). The override must therefore be a user-set flag on the pool alias, never an argument the agent can pass. V2's #15353 and #15503 show that cross-provider mode mapping is exactly where safety regressions appear.
- **Test.** One test: a worker calling `thread_stop` on its lead without `fromThreadId` is refused.

**2. Make owed crew work durable (M, the spine).**
- **Persist the Maps.** Replace the `orchNotices` and `autoTurns` Maps ([runner.js:1170-1179](../electron/runner.js#L1170)) with store-backed fields added to the EMPTY shape ([store.js:78-104](../electron/store.js#L78)). Flush immediately on enqueue rather than waiting for the 250 ms debounce. Notices are tiny.
- **Dedupe.** Key each notice by worker id and run id, so a replayed finish cannot double-wake a lead. This is V2's "a missed wake is cheaper than a duplicate one".
- **Tag interrupted threads at boot.** In boot recovery ([store.js:1426-1460](../electron/store.js#L1426)), keep the existing `failed` status so sidebar and waiting logic need no new state, but add `interruptedBy: "restart"`.
- **Tell the lead.** For each interrupted `orchWorker`, enqueue a notice to its lead naming the worktree, the branch, the last checkpoint and whether the tree is dirty.
- **Hold, don't drain.** Do **not** auto-flush held notices at boot. V2 holds queued runs "until an explicit queue.resume command arrives" ([Orchestrator.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9930)). Instead, show a "Resume crew (N updates)" control on the lead. It calls `flushOrchNotices` ([runner.js:1341-1434](../electron/runner.js#L1341)) with the budget and 25-turn auto-turn gates unchanged.
- **Skip the rest of V2's outbox.** No generic effect outbox, leases or retry worker: Solenta runs one process, and wake-ups are the only owed work it currently loses.

**3. Return structured worker results (S, then S for the card).** Extend `queueOrchNotice` ([runner.js:1296-1339](../electron/runner.js#L1296)) to append a bounded block of about 2,000 characters containing:
- `git diff --stat --summary <leadSnapshotSha>..<branch>`. The `--summary` flag prints `create mode 120000` lines, which is exactly the `core/dist` symlink case.
- the verify-gate verdict;
- the worker's invalidated hypotheses;
- open items from its review itinerary.

These are V2's merge-back fields (files changed, tests run, conclusions, unresolved issues), assembled from data Solenta already stores, with no LLM summary. The second step renders worker-result notices as a card in the lead's transcript, with a button into the Integration view (`git:integrateWorker`, [ipc.js:1725](../electron/ipc.js#L1725)). A click there is a genuine human approval, stronger than an agent's `approved:true`. The card must show visibly, unlike V2's merge-back, which "gives no sign it worked until the next message is sent" ([#15063](https://github.com/pingdotgg/t3code/issues/15063)).

**4. Build a replay-fixture harness (S–M, in parallel with 1–3).**
- **Record.** Capture real `claude-stream` stdout (Grok shares this format) to NDJSON fixtures.
- **Replay.** Write a few dozen lines of script that replays them with delays and checks the expected stdin writes, mirroring V2's `expect_outbound`/`emit_inbound`/`runtime_exit` ([testing-strategy.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/testing-strategy.md)).
- **Run the real path.** Point the provider's `binEnv` at the script. Providers are data-driven ([ARCHITECTURE.md:25-43](../docs/ARCHITECTURE.md#L25)), so `startRun` → `startClaudeRun` → `onEvent` → store → `pushDetail` all run for real.
- **First scenarios:** worker finish wakes the lead; restart mid-run (item 2); steer of a live run (item 5); a permission stall.
- **Later.** Codex's two-way JSON-RPC needs a responder and can come after.

This answers the failure pattern Willem's notes keep recording: green tests over mocked seams ([memory note](/Users/willem/.claude/projects/-Users-willem-code-coder/memory/worker-contract-seam-test.md); [memory note](/Users/willem/.claude/projects/-Users-willem-code-coder/memory/dogfood-against-real-store.md)).

**5. Let leads steer their own workers (S, after 1).**
- **Schema.** Add `mode: "queue" | "steer"` to the `thread_send` schema ([orchServer.js:1350-1362](../electron/orchServer.js#L1350)). The default is `queue`, which is today's behaviour.
- **When to steer.** Steer only when all four hold:
  - the target is running;
  - its provider declares `supportsSteer` (Claude, Codex);
  - the bound caller is the target's crew lead (`crewRootOf`, [services.js:2717](../electron/services.js#L2717));
  - the target's inbound policy is `accept` ([crossThread.js:11-26](../electron/crossThread.js#L11)).

  Then call `steerRun` ([runner.js:8805-8851](../electron/runner.js#L8805)) with `fromThread` attribution. Otherwise return `{status: "queued", reason}`.
- **No interrupt-and-restart fallback.** V2's `steering_restart` works because a new attempt keeps the Run. In Solenta, killing a mid-run Grok worker loses its uncommitted state. A lead that wants a restart can call `thread_stop` followed by `thread_send`.
- **Instruction updates.** Rewrite the "held, not injected" line ([orchServer.js:93-94](../electron/orchServer.js#L93)). Replace the polling advice ([orchServer.js:99-101](../electron/orchServer.js#L99)) with "the user sees a blocked worker in the sidebar; you cannot answer it". Then update the stale `thread-send-mid-run` memory note.

**6. Serialize lifecycle transitions per thread (M, after 4).**
- **The lock.** A promise chain of about 25 lines, keyed by thread id with refcounted cleanup, which is V2's `KeyedSerialExecutor`.
- **What it wraps:** only lifecycle transitions. That means `startRun` ([runner.js:8209](../electron/runner.js#L8209)), stop and `stopCrew` ([runner.js:8780-8803](../electron/runner.js#L8780)), `steerRun`, queued-follow-up drain ([runner.js:2094-2155](../electron/runner.js#L2094)), `flushOrchNotices`, the post-turn checkpoint and verify step ([runner.js:1459-1533](../electron/runner.js#L1459)) and `mergeWorktree`. Stream chunks and store writes stay outside it.
- **The rule.** Adopt V2's rule verbatim: never nest, and cross-thread work such as waking a lead after a worker finishes takes locks one after another ([Orchestrator.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9866)).
- **Where the cost is.** The lock itself is trivial. The cost is the call-site audit, plus failover re-entry (`onFailover` → `startRun`), which must release the lock first.

**7. Wake agents on PR events (M, after 2 and 3).**
- **Poll.** For threads with an open PR from `thread_pr` ([orchServer.js:659-687](../electron/orchServer.js#L659)), run `gh pr view --json state,mergeable,reviewDecision,statusCheckRollup` on the existing 5-minute autodispatch cadence ([autodispatch.js:3-45](../electron/autodispatch.js#L3)).
- **Wake.** When checks fail, changes are requested, conflicts appear or the PR merges, enqueue a durable notice for the PR's thread (or the lead, for an `orchWorker`).
- **Settle on merge.** On merge, settle the thread and schedule worktree retention GC, which keeps 10 settled worktrees and never deletes dirty or unmerged ones ([ARCHITECTURE.md:86-94](../docs/ARCHITECTURE.md#L86)). That is stricter than V2, which leaks them ([#15146](https://github.com/pingdotgg/t3code/issues/15146)).
- **Merging stays human.** The agent fixes the PR; a person merges it.

**8. Give plain forks real context (M, lowest priority).**
- **Native fork.** For user forks (not `orchWorker`) on the same provider with a live session, use the provider's native fork instead of the tail digest. V2 does this for Codex, Claude, Pi and OpenCode 2 ([Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)). Gate it on a `supportsNativeFork` flag in `providers.js`, and keep the digest as the fallback, because V2 still has native rewind bugs after compaction ([#15347](https://github.com/pingdotgg/t3code/issues/15347)).
- **Record the handoff.** Store `handoff: {strategy, sourceMessageId, chars}` on the new thread, honouring V2's rule that handoffs are recorded artifacts, "not hidden prompt hacks".
- **Add `thread_read`.** A project-scoped, paged tool. End the digest with a pointer to it, as V2's handoffs include references for fetching omitted history ([portable-handoffs.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md)).
- **Workers stay prompt-only.** V2's `delegate_task` copies no parent history either, which validates Solenta's self-contained fork-prompt rule.

**9. Add fork receipts only if the live store shows duplicates (S, evidence-gated).** First run a read-only scan of `coder-store.json` for sibling `orchWorker`s that share a `handoffFrom` and an identical first prompt and were created seconds apart. Only if the scan finds them, add an optional `requestId` to `thread_fork` and `thread_send`, backed by a capped receipts map that returns the original `{threadId}`. That is V2's `clientRequestId` guarantee that "retrying the same call returns the same durable work". Without evidence, this is speculative machinery.

**What not to copy, as a checklist:**

| V2 choice | Keep Solenta's design instead |
|---|---|
| Event-sourced SQLite engine and outbox | Durable notice rows in the JSON store; revisit only for offline multi-client resume or an audit-log requirement |
| Delegated children in the parent's checkout | One worktree per worker from the lead's committed snapshot |
| Mid-thread provider switching | `@provider` and pool forks (T3's own recommendation) |
| `t3_thread_wait` / `mode:"wait"` | End the turn and get woken; costs zero tokens while waiting |
| Read-only subagent threads | Workers stay answerable; #1421 surfaces the ones that need the user |
| Separately projected subagent status | Derive status from the thread itself (`src/waiting.ts`) |
| Agents merging PRs and auto-settling | Human-gated landing; adopt only the watch-and-wake half |
| Hidden-ref checkpoints | Keep checkpoint commits, which `thread_merge` and the verify gate depend on |
| Interrupt-and-restart steering fallback | Honest `queued` with a reason; an explicit stop-then-send by the lead |
