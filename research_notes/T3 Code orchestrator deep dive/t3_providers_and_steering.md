# T3 Code Orchestrator V2: provider adapters, capabilities, steering, interrupt, approvals, usage limits, recovery

**Snapshot.** `pingdotgg/t3code` main at **`eac52f0087d9ba5dee5542f24788d1482affae43`** (2026-10-04 01:37 PDT, "fix(client-runtime): closing a busy stream no longer drops the connection (#15563)"). A fresh `git fetch origin main` on 2026-10-04 returned the same SHA. Every `R/...` link below means `https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/...`. Code facts are from **main** unless they are explicitly tagged **OPEN PR** or **OPEN issue**. Solenta comparisons cite the local worktree: `electron/providers.js`, `electron/runner.js`, `electron/claude.js`, `electron/codex-appserver.js`.

## 1. Adapter interface, event types, and the full capability struct per provider

### Takeaway
Every provider is a `ProviderAdapterV2Shape` with three members: `getCapabilities()`, `planSelectionTransition()`, and a scoped `openSession()`. `openSession()` returns a session runtime with these required methods: `ensureThread`, `resumeThread`, `startTurn`, `steerTurn`, `interruptTurn`, `respondToRuntimeRequest`, `readThreadSnapshot`, `rollbackThread`, and `forkThread`. It also has optional hooks, such as background-work probes, `injectHistory`, `compactThread`, and `unloadThread`. The adapter emits 11 normalized event types, which are full-entity upserts plus one authoritative `turn.terminal`.

Capabilities are a static, 12-group struct per adapter, with 59 boolean/enum fields plus `runtimePolicy.enforcement`. The orchestrator's steer, queue, and restart policy reads only `turns.supportsActiveSteering`, `supportsQueuedMessages`, `supportsSteeringByInterruptRestart`, and `supportsInterrupt`.

### Cited Findings
- **Adapter shape:**
  ```ts
  ProviderAdapterV2Shape = {
    instanceId, driver,
    getCapabilities(),
    planSelectionTransition(input),
    openSession(input): Effect<SessionRuntime, Error, Scope>,
  }
  ```
  — [R/apps/server/src/orchestration-v2/ProviderAdapter.ts#L581-L594](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderAdapter.ts#L581)
- **Session runtime** ([ProviderAdapter.ts#L484-L579](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderAdapter.ts#L484)):
  - Fields: `events` stream, optional `subscribeEvents`.
  - Background-work probes:
    - `hasPendingBackgroundWork?`: "Adapters whose native runtime can hold pending work outside an active turn (for example Claude background tasks and their wake turns) report it here so the session manager defers idle release while it is pending".
    - `hasPendingBackgroundWorkForThread?`.
  - Context-window hooks: `getModelContextWindow?`, `canReuseContextUsage?`.
  - Thread lifecycle: `ensureThread`, `resumeThread`, `injectHistory?` ("False means the native protocol explicitly does not support history injection").
  - Turn control: `startTurn`, `compactThread?`, `steerTurn`, `interruptTurn`, `unloadThread?` (a shared runtime unloads one native thread when its app thread detaches).
  - Requests and history: `respondToRuntimeRequest`, `readThreadSnapshot`, `uploadFeedback?` (Codex → OpenAI), `rollbackThread`, `forkThread`.
- **Steer and interrupt inputs.**
  - `SteerInput` is `{threadId, runId, providerThread, providerTurnId, message}`.
  - `InterruptInput` is `{providerThread, providerTurnId, requestRuntimeRestart?}`. The flag's doc: "When true, the next `startTurn` may respawn the provider runtime (Grok Stop recovery)".
  - `TurnInput` carries app ids (`runId`, `runOrdinal`, `providerTurnOrdinal`, `attemptId`, `rootNodeId`, `restartContinuationOfRunId?`) plus `modelSelection` and `runtimePolicy`.
  - Source: [ProviderAdapter.ts#L396-L424](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderAdapter.ts#L396)
- **Normalized adapter events:**
  - Entity upserts: `app_thread.created`, `provider_session.updated`, `provider_thread.updated`, `provider_turn.updated`, `node.updated`, `subagent.updated`, `message.updated`, `turn_item.updated`, `runtime_request.updated`, `plan.updated`.
  - Two `turn.terminal` variants:
    - Status `completed|interrupted|cancelled` with `failure: null`.
    - Status `failed` with `failure: OrchestrationV2ProviderFailure`, optional `retry: OrchestrationV2ProviderRetry`, and `retryStartedAt`.
    - Both carry `threadDisposition: "reusable" | "broken"`.
  - Source: [ProviderAdapter.ts#L78-L154](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderAdapter.ts#L78)
- **Typed adapter errors** include `ProviderAdapterSteerRunUnsupportedError` ("does not support active-run steering"), `ProviderAdapterSteerRunError`, `ProviderAdapterInterruptError`, `ProviderAdapterResumeThreadError`, and `ProviderAdapterProtocolError` — [ProviderAdapter.ts#L156-L378](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderAdapter.ts#L277)
- **Capability schema.** The groups are `sessions`, `threads`, `turns`, `streaming`, `tools`, `approvals`, `planning`, `subagents`, `context`, `checkpointing`, `identity`, and `runtimePolicy`. `runtimePolicy` decodes old events to `client-boundary` "so replay never overclaims enforcement".
  - The `runtimePolicy.enforcement` doc: "'native' providers receive the approval and sandbox policy each turn and confine their own execution. 'client-boundary' providers only have policy applied where T3 mediates the work (permission requests and client fs/terminal handlers); provider-owned execution is not confined".
  - `NativeRefStrength = "strong"|"weak"|"none"`.
  - Source: [R/packages/contracts/src/orchestrationV2.ts#L188-L327](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L188)
- **Field meanings from the doc:**
  - `supportsActiveSteering` "means the provider can modify an in-flight turn directly". `supportsSteeringByInterruptRestart` "means V2 can implement app-level steering by interrupting the active turn and starting a replacement attempt".
  - "If `terminalStatusQuality` is weak, V2 should use adapter policy to infer terminal state".
  - "If message completion is not emitted, the normalizer closes assistant messages at root run terminal".
  - Identity `strong` uses the native id as a scoped ref, `weak` uses native id plus ordinal/fingerprint, and `none` allocates by scoped ordinal.
  - "Provider-thread resumption is not a capability. It is a required adapter primitive."
  - Source: [R/docs/orchestration-v2/provider-capability-system.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/provider-capability-system.md)
- **Degradation table from the doc:**
  - "interrupt unsupported -> stop session if allowed, otherwise mark unsupported".
  - "active steering unsupported -> interrupt active turn and restart the run as a steering replacement attempt".
  - "rollback unsupported -> restore filesystem checkpoint, restart provider context, mark provider state divergent".
  - "structured approvals unsupported -> provider runs under configured sandbox policy; no approval UI".
  - "plan_updated unsupported -> no live todo UI".
  - Source: [provider-capability-system.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/provider-capability-system.md)
- **Per-provider values.** The table below was extracted mechanically from the `satisfies OrchestrationV2ProviderCapabilities` constants. T = true, F = false, s/w/n = strong/weak/none. Sources:
  - Codex: [CodexAdapterV2.ts#L237](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L237)
  - Claude: [ClaudeAdapterV2.ts#L178](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L178)
  - Cursor (official `@cursor/sdk`): [CursorAdapterV2.ts#L83](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CursorAdapterV2.ts#L83)
  - ACP base (registry agents, Devin): [AcpAdapterV2.ts#L538](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L538)
  - Grok (ACP flavor that spreads the ACP base): [GrokAdapterV2.ts#L81-L108](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.ts#L81)
  - OpenCode 1: [OpenCodeAdapterV2.ts#L121](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/OpenCodeAdapterV2.ts#L121)
  - OpenCode 2: [OpenCode2AdapterV2.ts#L99](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.ts#L99)
  - Pi: [PiAdapterV2.ts#L118](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts#L118)
  - Antigravity (ACP flavor): [AntigravityAdapterV2.ts#L47](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts#L47)

  | field | Codex | Claude | Cursor | ACP base | Grok | OC1 | OC2 | Pi |
  |---|---|---|---|---|---|---|---|---|
  | sessions.supportsMultipleProviderThreadsPerSession | T | F | F | F | F | F | T | F |
  | sessions.supportsModelSwitchInSession | T | T | T | F | **T** | T | T | T |
  | sessions.supportsProviderSwitchingViaHandoff | T | T | T | T | T | T | T | T |
  | sessions.supportsRuntimeModeSwitchInSession | T | F | F | F | F | F | T | F |
  | sessions.pendingRequestsSurviveRestart | F | F | F | F | F | F | F | F |
  | threads.canCreateEmptyThread | T | T | T | T | T | T | T | T |
  | threads.canReadThreadSnapshot | T | F | T | F | **T** | T | T | T |
  | threads.canRollbackThread | T | T | F | T | T | T | T | T |
  | threads.canForkThread / canForkFromTurn | T/T | T/T | F/F | F/F | F/F | T/T | T/T | T/T |
  | threads.canForkFromSubagentThread | T | F | F | F | F | T | F | F |
  | threads.exposesNativeThreadId | T | T | T | T | T | T | T | T |
  | turns.exposesNativeTurnId | T | F | T | F | F | F | F | F |
  | turns.emitsTurnStarted / emitsTurnCompleted | T/T | T/T | T/T | T/T | T/T | T/T | T/T | T/T |
  | turns.supportsInterrupt | T | T | T | T | T | T | T | T |
  | **turns.supportsActiveSteering** | **T** | **T** | **F** | **F** | **F** | **T** | **T** | **T** |
  | **turns.supportsSteeringByInterruptRestart** | **T** | **F** | **T** | **T** | **T** | **T** | **T** | **F** |
  | turns.supportsQueuedMessages | T | T | T | T | T | T | T | T |
  | turns.terminalStatusQuality | s | s | s | s | s | s | s | s |
  | streaming.streamsAssistantText / Reasoning | T/T | T/T | T/T | T/T | T/T | T/T | T/T | T/T |
  | streaming.streamsToolOutput | T | F | T | T | T | T | F | T |
  | streaming.streamsPlanText | T | F | T | F | F | F | F | F |
  | streaming.emitsMessageCompleted | T | T | T | T | T | T | T | T |
  | tools.exposesToolItemIds / emitsToolStarted / Completed / Output | T | T | T | T | T | T | T | T |
  | tools.supportsMcpTools | T | T | T | F | **T** | T | F | T |
  | tools.supportsDynamicToolCallbacks | T | T | F | F | F | F | F | F |
  | approvals.supportsCommandApproval | T | T | F | T | T | T | T | T |
  | approvals.supportsFileReadApproval | T | T | F | T | T | T | T | F |
  | approvals.supportsFileChangeApproval | T | T | F | T | T | T | T | T |
  | approvals.supportsApplyPatchApproval | T | F | F | F | F | T | T | F |
  | approvals.approvalsHaveNativeRequestIds | T | T | F | F | F | T | T | T |
  | approvals.approvalCallbacksAreLiveOnly | T | T | F | T | T | T | T | T |
  | approvals.approvalsCanOriginateFromSubagents | T | F | F | F | F | T | T | F |
  | planning.emitsPlanUpdated / emitsTodoList | T/T | T/T | T/T | T/T | T/T | T/T | F/F | F/F |
  | planning.emitsProposedPlan | T | T | T | F | F | F | F | F |
  | planning.supportsStructuredQuestions | T | T | F | T | T | T | T | T |
  | planning.planDeltasHaveItemIds | T | F | T | F | F | F | F | F |
  | subagents.supportsSubagents | T | T | T | F | **T** | T | T | T |
  | subagents.exposesSubagentThreadIds | T | F | F | F | **T** | T | T | F |
  | subagents.emitsSubagentLifecycle | T | T | T | F | **T** | T | T | T |
  | subagents.canWaitForSubagents | T | F | T | F | F | T | T | F |
  | subagents.canCloseSubagents | T | F | F | F | F | F | F | F |
  | subagents.canForkSubagentThread | T | F | F | F | F | T | F | F |
  | context.acceptsSystemContext / DeveloperContext | T/T | T/T | F/F | F/F | F/F | F/F | F/F | F/F |
  | context.acceptsSyntheticUserContext | T | T | T | T | T | T | T | T |
  | context.canGenerateSummaries | T | T | T | T | T | T | F | F |
  | context.canConsumeHandoffSummaries / Delta / FullThread | T | T | T | T | T | T | T | T |
  | context.maxRecommendedHandoffChars | null | null | null | null | null | null | null | null |
  | checkpointing.appCanCheckpointFilesystem | T | T | T | T | T | T | T | T |
  | checkpointing.supportsNestedCheckpointScopes | T | T | T | T | T | T | T | F |
  | checkpointing.providerCanRollbackConversation / RollbackReturnsSnapshot | T/T | T/T | F/F | T/T | T/T | T/T | T/T | T/T |
  | checkpointing.providerCanReadConversationSnapshot | T | F | T | F | **T** | T | T | T |
  | identity.nativeThreadIds | s | s | s | s | s | s | s | s |
  | identity.nativeTurnIds | s | w | s | w | w | w | w | w |
  | identity.nativeItemIds | s | s | w | w | w | s | s | s |
  | identity.nativeRequestIds | s | s | n | w | w | s | s | s |
  | runtimePolicy.enforcement | native | native | native | client-boundary | client-boundary | native | native | client-boundary |

  Grok spreads `AcpProviderCapabilitiesV2` and overrides only the cells shown in bold (plus `supportsRuntimeModeSwitchInSession: false`). Antigravity overrides `supportsModelSwitchInSession: true`, `supportsRuntimeModeSwitchInSession: true`, `supportsMcpTools: true`, and `supportsSubagents: true`. Registry ACP agents use the ACP base unchanged ([AcpRegistryAdapterV2.ts#L189](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.ts#L189)).
- **Grok/ACP-specific knobs** live on `AcpAdapterV2Flavor` rather than in the capability struct:
  - `interruptPromptOnCancel`.
  - `restartRuntimeAfterInterrupt`: "Kill and respawn the ACP child process before the next `session/prompt` after a user interrupt. Grok can keep `task_already_running` state until the process exits".
  - `restartRuntimeOnEveryInterrupt`, `terminateRuntimeProcessGroupOnInterrupt`.
  - `preserveRuntimeOnSettledInterrupt`, `deferFinalizeForBackgroundWork`, `enablePostSettleContinuation`.
  - `supportsImagePrompts`: Grok "reports promptCapabilities.image:false but the agent still accepts image content blocks".
  - Source: [AcpAdapterV2.ts#L380-L425](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L380); [GrokAdapterV2.ts#L232-L256](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.ts#L232)
- **Command-policy capability names** that the orchestrator can reject with a typed `CommandPolicyCapabilityUnsupportedError`: `queued_messages`, `active_steering`, `interrupt`, `interrupt_restart_steering`, `native_fork`, `fork_from_turn`, `rollback`, `rollback_snapshot`, `context_handoff`, `strong_terminal_status` — [R/apps/server/src/orchestration-v2/CommandPolicy.ts#L52-L63](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/CommandPolicy.ts#L52)
- **Open hardening issue #15013 (OPEN).** One item reads: "Call optional adapter methods (`injectHistory`, `compactThread`) through a capability check, not `!` assertions (`ProviderTurnStartService.ts`)". So not every optional method is capability-gated yet — [issue #15013](https://github.com/pingdotgg/t3code/issues/15013)

### Inferences
- For Solenta, the minimum useful subset is about 8 fields:
  - `turns.supportsActiveSteering`, `turns.supportsSteeringByInterruptRestart`, `turns.supportsInterrupt`.
  - `approvals.*` (does the CLI have a prompt channel at all).
  - `sessions.pendingRequestsSurviveRestart`.
  - `runtimePolicy.enforcement` (native vs client-boundary).
  - `identity.nativeTurnIds`.
  - A `hasPendingBackgroundWork` probe.

  Solenta's current `supportsSteer` boolean ([electron/providers.js L74](file://electron/providers.js)) conflates "active steering" with "allowed to steer at all". T3 separates them, so a provider with no live input channel can still offer Steer via interrupt-and-restart.
- In practice T3 marks Claude and Pi as "active steer but cannot interrupt-restart". The reason is that their interrupt is destructive: Claude's `interruptTurn` closes the query/CLI process (see section 3). The second flag is not about protocol support. It means "interrupt leaves the session usable for an immediate replacement turn".
- Capabilities are static constants. Even ACP agents that advertise features at `initialize` get a fixed flavor struct; only `sessionCapabilities.close` is read dynamically ([AcpAdapterV2.ts#L7119](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L7119)). Solenta can safely keep capabilities as static per-provider data in `providers.js`.

### Gaps
- The doc says capabilities "should be versioned and emitted by each adapter at session start". The code attaches them to `providerSession.capabilities`, but I did not find a capability version number field.
- Why Claude is `supportsSteeringByInterruptRestart: false` is not commented at the definition. The rationale above is inferred from `interruptTurn`'s behavior and from closed PR #12541's description ("Stop stays a hard session boundary").

## 2. Steering: per-provider mechanics, interrupt-and-restart fallback, steer vs queue decisions

### Takeaway
T3 has three delivery outcomes for a message sent while a run is active:
1. **active steer**: provider-native injection into the running turn.
2. **interrupt-and-restart**: a soft interrupt, then a replacement `RunAttempt` with `reason: "steering_restart"` inside the same `Run`.
3. **queue**: an app-owned queued `Run`.

Per-provider native steering:
- **Claude**: an Agent SDK streaming-input `SDKUserMessage` with **`priority: "now"`**.
- **Codex**: app-server `turn/steer {threadId, expectedTurnId, input}`.
- **OpenCode 2**: `session.prompt` with `delivery: "steer"`.
- **OpenCode 1**: a second prompt admitted into the running session.
- **Pi**: an RPC `prompt` with `streamingBehavior: "steer"`.
- **Cursor and Grok/ACP**: no active steering. They throw `SteerRunUnsupported` and use interrupt-restart.

For an untargeted user message, the UI's `auto` picks the first that applies: active steer, then queue (every provider has `supportsQueuedMessages`), then interrupt-restart. Interrupt-restart therefore happens only when the user explicitly chooses Steer/Restart on a non-steerable provider, or when a model/provider change must apply now. Agent-originated wakes queue by default. Delegated-task completions are upgraded to an active steer when the live session supports it, and are "never" interrupt/restart. Steers that land after the turn ended are re-dispatched as a follow-up turn under the same message id.

### Cited Findings
- **Claude (Agent SDK, streaming input).** `steerTurn` checks for a live query and that `providerTurnId` is the active turn. It builds a user message with `priority: "now"`, records the turn in `steeredTurns`, and calls `existing.query.offer(userMessage)`. The prompt-effort prefix is re-applied to steer text through `applyClaudePromptEffortPrefix` — [ClaudeAdapterV2.ts#L7325-L7371](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L7325)
  - Wire shape (recorded fixture): `{"type":"user","message":{"role":"user","content":"Actually, respond with exactly: steering fixture observed"},"parent_tool_use_id":null,"priority":"now"}` — [R/apps/server/src/orchestration-v2/testkit/fixtures/message_steering/claude_transcript.ndjson L4](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/message_steering/claude_transcript.ndjson)
  - A `now` steer makes the CLI end the current turn with a `result` whose `terminal_reason` is `aborted_streaming` or `aborted_tools`. T3 swallows that intermediate result for a steered, non-interrupted turn (`if (!interrupted && wasSteered && isClaudeActiveSteeringAbortResult(message)) return;`), so the run continues on the steered prompt. Elsewhere those reasons map to `interrupted`: "The CLI can label an abort as success with is_error=false. Its explicit terminal reason takes precedence" — [ClaudeAdapterV2.ts#L2310-L2350, L6273-L6278](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L2346); test `handles $terminalReason with active steering=$steered` asserts `offeredMessages[1]?.priority === "now"` — [ClaudeAdapterV2.test.ts#L2303-L2340](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts#L2303)
  - Skills quirk: "Claude Code expands a skill only from the LAST text block, and only when `/name` is its first character", so the user message is split into `[leading text, "/name trailing text"]` — [ClaudeAdapterV2.ts#L1233-L1258](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1227)
  - **Why `priority` matters.** The V1-era PR #12541 (CLOSED unmerged, 2026-09-19) says: "the message reached the CLI's stdin at once, but Claude only folds a queued user message into a running turn between tool rounds, so behind a long tool call or a subagent it sat there arbitrarily long". It measured a correction answered after 35.2 s before the change vs 2.1 s after — [PR #12541](https://github.com/pingdotgg/t3code/pull/12541)
  - **OPEN issue #15351** (2026-10-03): a `now` steer used for a *delegated-task notification* cancels queued, not-yet-started tool calls. Claude Code then returns "The user doesn't want to take this action right now. STOP what you are doing…", and autonomous agents stop.
    - Measured on Claude Code 2.1.288: `now` gives "ended with `aborted_tools`, then a new turn started"; `next` gives "one turn; the agent read the notification in the same turn".
    - Proposed fix: "send notification steers with `priority: "next"`… User steers should keep `"now"`".
    - Claude Code has a neutral "[Tool call skipped…]" text, but it is behind a default-off flag.
    - Source: [issue #15351](https://github.com/pingdotgg/t3code/issues/15351)
  - **OPEN issue #15517**: steering while Claude waits on `AskUserQuestion` aborts the permission request ("Tool permission request aborted"). T3 removes it from `pendingRuntimeRequests` and returns `deny` "but it emits no `runtime_request.updated` that cancels the request", so a stale question stays pending — [issue #15517](https://github.com/pingdotgg/t3code/issues/15517)
- **Codex (app-server JSON-RPC).** `steerTurn` looks up the active turn context by `providerTurnId` (it errors "is not active and cannot be steered" otherwise) and sends `client.request("turn/steer", { expectedTurnId: activeTurn.nativeTurnId, input: codexInput, threadId })` — [CodexAdapterV2.ts#L5613-L5640](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L5613). Fixture: request `{"method":"turn/steer","params":{"expectedTurnId":"01a0d5ed-…","input":[{"text":"…","type":"text"}],"threadId":"…"}}`, response `{"result":{"turnId":"01a0d5ed-…"}}`, which is the same turn id — [message_steering/codex_transcript.ndjson L16-L17](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/message_steering/codex_transcript.ndjson)
- **OpenCode 2.**
  - Module doc: "A steer is another prompt with `delivery: "steer"`, which OpenCode reads at the running execution's next step boundary, so it ends with the turn it joined" — [OpenCode2AdapterV2.ts#L1-L22](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.ts#L1)
  - Implementation:
    - Derives a stable `inboxID = steerPromptId(sessionId, messageId)`. "A retried steer that already reached the model is not sent again".
    - Sends `client.session.prompt({sessionID, id: inboxID, text, delivery: "steer"})`.
    - On an unclear failure the steer is kept as "stranded" so "the next prompt takes it back".
    - Source: [OpenCode2AdapterV2.ts#L3852-L3906](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.ts#L3852)
- **OpenCode 1.** `steerTurn` submits a new prompt (`submitPrompt` with a fresh `messageID`, model, and text/file parts) into the same session while the turn is active. It tracks it through an "admission" state machine (`admissionPending`, `admissionAccepted`, `reconcile-idle`) — [OpenCodeAdapterV2.ts#L3290-L3381](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/OpenCodeAdapterV2.ts#L3290)
- **Pi (RPC JSONL).** `steerTurn` sends `{type:"prompt", message, streamingBehavior:"steer"}` under a session permit. Comment: "Prompt with streamingBehavior steer is atomic on Pi's side: it queues during an active run and starts a new run if settlement won the race. A direct `steer` sent after Pi became idle would remain queued forever". `/compact` goes through a separate compact RPC — [PiAdapterV2.ts#L2407-L2464](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts#L2407). **OPEN issue #15221 / OPEN PR #15444**: pi ≥1.0 rejects a *turn-start* `prompt` without `streamingBehavior` while an extension-driven run is active ("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp')") — [issue #15221](https://github.com/pingdotgg/t3code/issues/15221); [PR #15444](https://github.com/pingdotgg/t3code/pull/15444)
- **Cursor (`@cursor/sdk`) and ACP/Grok.** `steerTurn: () => Effect.fail(new ProviderAdapterSteerRunUnsupportedError(...))` — [CursorAdapterV2.ts#L2422-L2428](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CursorAdapterV2.ts#L2422); [AcpAdapterV2.ts#L7290-L7296](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L7290). Doc: "ACP does not define native subagents or active steering. Grok therefore uses orchestrator-owned child threads and implements steering through cancel-and-restart" — [R/docs/orchestration-v2/orchestrator-mcp-server.md#L111-L113](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md). The Grok steering fixture shows `session/cancel` with `"_meta":{"cancelTrigger":"ctrl_c"}` followed by a new `session/prompt` — [message_steering/grok_transcript.ndjson L28](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/message_steering/grok_transcript.ndjson). Cursor V1 issue #14585 ("Cursor Steer waits for the turn to finish") was confirmed fixed by V2: "Steer: answered 4.7s after sending, while the command was still running" — [issue #14585](https://github.com/pingdotgg/t3code/issues/14585)
- **Steer vs queue for untargeted user messages (server).** `resolveMessageDispatchIntent(projection, requestedMode, deliveryIntent)` works as follows:
  - No active run (`preparing|starting|running|waiting`) → `start_immediately`.
  - `steer` → `steer_active`.
  - `restart` → `restart_active`.
  - Active run still `preparing|starting` → `queue_after_active`.
  - Otherwise, by session capabilities: `supportsActiveSteering` → steer, else `supportsQueuedMessages` → queue, else `supportsSteeringByInterruptRestart` → restart, else queue.
  - Source: [CommandPolicy.ts#L120-L163](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/CommandPolicy.ts#L120)
  - The client mirrors the same ladder and passes `deliveryIntent` so "the server's serialized thread state" decides — [R/packages/client-runtime/src/operations/commands.ts#L735-L770](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/operations/commands.ts#L735); contract `deliveryIntent: Schema.optional(Schema.Literals(["auto","steer","restart"]))` — [contracts L2716](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L2716)
- **A late steer becomes a new turn.** If the target run is `completed`, or still `running|waiting` but its provider turn is already `completed`: "The client may still show a running turn while its completion is being projected. Preserve the submission as a new turn when steering is too late" → `start_immediately` — [Orchestrator.ts#L4492-L4510](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L4492)
- **Steer execution policy.** `decideSteeringExecution`:
  - `!forceRestart && supportsActiveSteering` → `"active_steering"`.
  - Else `supportsInterrupt && supportsSteeringByInterruptRestart` → `"interrupt_restart"`.
  - Else a typed unsupported error.
  - Source: [CommandPolicy.ts#L241-L260](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/CommandPolicy.ts#L241)
  - `forceRestart` is set by `restart_active`, by a selection change that "must apply now" (a provider switch or a transition other than `apply_on_next_turn`), or by any selection change on a provider that can interrupt-restart. Comment: "A selection the provider applies on its next turn restarts the run when the provider can restart it. Otherwise the steer joins the running turn and the selection waits for the next one, rather than failing the steer" — [Orchestrator.ts#L3820-L3840](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L3820)
  - This came from merged PR #14615 (2026-10-01). Before it, steering Claude from web always failed with "Claude cannot redirect an active run", because the web composer adds `fastMode: false` and the selection mismatch forced an unsupported restart. Follow-up merged PR #14725 (2026-10-02): "an actively steered user message saves its selection whenever it differs from the thread's saved selection, not the run's" — [PR #14615](https://github.com/pingdotgg/t3code/pull/14615); [PR #14725](https://github.com/pingdotgg/t3code/pull/14725)
- **Active-steer path.**
  - Appends a `user_message` turn item with `inputIntent: "steer"` (or `"promoted_queued_to_steer"`) on the *current* run and root node.
  - Enqueues outbox effect `provider-turn.steer` with id `effect:<commandId>:provider-turn.steer:<providerTurnId>`.
  - Source: [Orchestrator.ts#L3785-L3890](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L3842)
  - If the adapter's steer fails *and* the provider turn is by then `completed` (`turnCompleted`), the EffectWorker re-dispatches `message.dispatch` with `commandId = command:steer-follow-up:<effectId>`, the **same messageId**, and `start_immediately`. Comment: "Reuse the message identity and a stable command receipt so an outbox retry cannot append a duplicate message or start a second follow-up" — [EffectWorker.ts#L197-L290](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EffectWorker.ts#L197); [ProviderTurnControlService.ts#L266-L335](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderTurnControlService.ts#L266)
- **Interrupt-and-restart path (same Run, new attempt).** In one transaction:
  1. Allocates `attemptOrdinal = max+1`, a new `RunAttemptId`, and a new root node id (`rootNodeAttempt`).
  2. Marks the old attempt `superseded` and the old root node `interrupted`.
  3. Rewrites the Run (`activeAttemptId`, `rootNodeId`, `userMessageId: <steer message>`, `status: "starting"`, possibly new `modelSelection`/`providerThreadId`/`contextHandoffId`).
  4. Creates `RunAttempt{reason: "steering_restart", status: "pending"}` with a fresh root checkpoint scope.
  5. Appends the steer message to the new root.
  6. Enqueues `provider-turn.restart {providerSessionId, providerThreadId, providerTurnId, interruptedAttemptId, runId, sessionTransition?}`.
  - If the restart also switches provider, it builds a `full_thread_summary` `ContextHandoff` plus a consumed `provider_handoff` transfer and `sessionTransition: detach`. A selection needing a session restart gets `sessionTransition: replace`.
  - Source: [Orchestrator.ts#L3893-L4300](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L3893)
  - **What carries over:** the Run id and ordinal, the provider thread (and therefore native conversation history, which is resumed rather than replayed) unless a handoff was needed, and the earlier attempt's output, which stays visible as a superseded fold (see OPEN issue #15489).
  - **What does not carry over:** no partial-output summary is injected. The replacement turn's prompt is just the steer message, and the provider's own transcript supplies the context.
- **Worker side of `provider-turn.restart`.**
  1. `interruptAndAwaitTerminal`, which calls `interruptTurn` *without* `requestRuntimeRestart` (a soft interrupt). It then polls the projection, up to 1,000 event-loop yields, until the provider turn and attempt are no longer `running`. "Provider terminal events are projected on a detached ingestion fiber. Yield through the Node event loop instead of sleeping on Effect's clock".
  2. Optional `providerSessions.detach`.
  3. `providerTurnStart.start({threadId, runId})`.
  - Source: [EffectWorker.ts#L292-L330](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EffectWorker.ts#L292); [ProviderTurnControlService.ts#L200-L255](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderTurnControlService.ts#L200)
  - Grok's soft path: "Non-Stop interrupts (mid-prompt steering, restart_active) omit requestRuntimeRestart and stay soft: session/cancel carries cancelTrigger=ctrl_c, the session survives, and background work remains available to the replacement turn". On a turn whose prompt already settled, it even skips `session/cancel` "so fire-and-forget subagents survive the steer" — [GrokAdapterV2.ts#L236-L249](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.ts#L236); [AcpAdapterV2.ts#L7297-L7340](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L7297)
- **Agent-originated messages.**
  - (a) **Provider-native background wakes** (Claude background Bash/Monitor finished after the turn, OpenCode 2 background subagent) go through `ProviderContinuationService` → `message.dispatch` with `dispatchMode: {type:"queue_after_active"}`, `createdBy:"agent"`, and `creationSource:"provider"` for adapter-buffered wakes or `"server"` for `message_text` — [ProviderContinuationService.ts#L150-L180](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderContinuationService.ts#L150); [ProviderContinuationRequests.ts#L15-L43](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderContinuationRequests.ts#L15)
  - (b) **Delegated-task completions** start as queued. When every task has `completionWake === "always"` and a live session's `supportsActiveSteering` holds for a running, non-maintenance turn, they upgrade to `steer_active`. Comment: "Route durable mailbox deliveries under the thread lock, using the live session's capabilities. Never interrupt/restart a turn for a notification." Notifications must be "server- or provider-created queued messages" — [Orchestrator.ts#L4511-L4600](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L4511)
  - (c) **Agent → thread sends via MCP `t3_thread_send`** use `ThreadManagementService` modes `auto|queue|steer|restart`. `auto` with a steerable run (`status==="running"` and a running provider turn) → `steer_active`, else `start_immediately`, which the orchestrator turns into a queue if a run blocks — [ThreadManagementService.ts#L37, L363-L376, L524-L560](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ThreadManagementService.ts#L524). The doc says "`auto` starts an idle thread, steers a fully active turn, or queues behind a turn that is not yet steerable; `steer` requires a steerable active provider turn; `restart`… uses the orchestrator's interrupt-and-restart path" — [orchestrator-mcp-server.md#L370-L377](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md)
- **Open steering PRs and issues since 2026-10-02.**
  - **OPEN PRs:**
    - #14732: "a delegated result whose steer never landed wakes the parent after it settles". With Pi, every steer retry failed near turn end and the reservation blocked later wakes.
    - #15421: "a steer splits the settled work fold".
    - #15444: Pi `streamingBehavior` at turn start.
  - **OPEN issues:**
    - #15279: steered messages render below "Worked for…".
    - #15351.
    - #15517.
  - **MERGED:** #14615, #14725, #14546 ("stop stranded thinking after a steer").
  - Source: `gh pr list/issue list --repo pingdotgg/t3code` on 2026-10-04 — [PR #14732](https://github.com/pingdotgg/t3code/pull/14732); [issue #15279](https://github.com/pingdotgg/t3code/issues/15279)
- **Solenta today:**
  - `steerRun` requires `providerEntry.supportsSteer === true` and a live `entry.handle.send`. It writes the prompt and appends a `user` row with `{steer: true}` on the current `runId`. Otherwise it throws "cannot steer a live turn" — [electron/runner.js L8805-L8848](file://electron/runner.js).
  - Claude's `sendUser` writes `{type:"user", message:{role:"user", content}, parent_tool_use_id:null, session_id:""}` with **no `priority` field** — [electron/claude.js L230-L240](file://electron/claude.js).
  - Codex `send` uses `turn/steer {threadId, expectedTurnId, input}` and returns `false` on any rejection — [electron/codex-appserver.js L589-L606](file://electron/codex-appserver.js).
  - `providers.js` notes "Do not fake steer by kill+resume. Queue remains idle follow-up" — [electron/providers.js L351-L353](file://electron/providers.js).

### Inferences
- **The highest-value port for Solenta is a single resolver like `resolveMessageDispatchIntent`** that runs under a per-thread lock against the current run state: active steer → queue → interrupt-restart, with an explicit `restart` intent available. Two more behaviors matter:
  - A steer that loses the race to turn completion should become a follow-up turn with the same message id. Today Solenta's Codex `send` just returns `false` and `steerRun` throws "Live process is not accepting input".
  - `priority` should be chosen per origin: `"now"` for user steers, `"next"` for agent/notification deliveries (T3 #15351's measured behavior).
- Solenta's Claude steer omits `priority`. PR #12541's measurement says such a message is folded in only "between tool rounds". That likely explains slow-landing Claude steers behind long tools. Adding `priority:"now"` to user steers, and handling the resulting `aborted_streaming`/`aborted_tools` intermediate `result` as "keep the run open", is a small, contained change. Solenta's `claude.js` currently treats any `result` as the end of the turn and ends stdin in non-keepAlive mode. That would close the session on the abort `result`, so the result-handling change is required, not optional.
- T3's "Do we kill and restart?" rule (`supportsSteeringByInterruptRestart`) is true only where interrupt keeps the session alive (Codex `turn/interrupt`, ACP `session/cancel`, OpenCode abort, Cursor `run.cancel`). Solenta's comment "Do not fake steer by kill+resume" matches T3 for Claude, which is restart-false for exactly that reason. T3 *does* fake it for Cursor and Grok, but only because their interrupts are soft (cancel, not process kill).
- There is an asymmetry worth noting. UI `auto` *queues* on Cursor/Grok, but MCP `t3_thread_send(auto)` picks `steer_active` whenever a provider turn is running, and `decideSteeringExecution` then makes it an interrupt-restart on those providers. So an agent poking a running Grok thread restarts its turn, while a user's default send queues. Solenta's agent-to-thread sends (`thread_send`, held until idle) are closer to T3's notification rule ("never interrupt for a notification").

### Gaps
- I did not find documentation of the Claude CLI's default behavior when `priority` is omitted in stream-json input. The only evidence is the PR #12541 description ("only folds… between tool rounds"); I could not verify it against Anthropic docs in this pass.
- How OpenCode 1 orders a steer prompt relative to the running prompt (queue vs immediate) was not traced beyond the admission state machine.

## 3. Interrupt / Stop semantics per provider; background tasks and monitors

### Takeaway
User **Stop** does three things:
1. Dispatches `run.interrupt`, which holds every queued run (`queueHeld: true`) and records an "Interrupt requested" item.
2. Enqueues `provider-turn.interrupt`.
3. The worker calls `interruptTurn({requestRuntimeRestart: true})`, a hard stop, and then always dispatches `thread.background-work.settle`. That marks any still-pending command/dynamic-tool/subagent items `interrupted` and clears rosters of dead processes.

Steering restarts use the same adapter method without `requestRuntimeRestart`, a soft stop. Hard vs soft differs by provider:
- **Claude**: always `query.interrupt` + `query.close` (process ends; background shells die with it).
- **Codex**: `turn/interrupt` on the turn and all descendant turns, plus `thread/backgroundTerminals/terminate` for tracked background processes.
- **Grok/ACP**: Stop = process-group kill + respawn; steer = `session/cancel` only.
- **Pi**: `abort` RPC, or terminate the process for compaction/Stop.
- **Cursor**: `run.cancel`.

The run becomes terminal only when the provider's terminal event arrives, never on the interrupt acknowledgement.

### Cited Findings
- **Doc rule:** "provider interrupt request returns → command acknowledged only; provider emits root turn/completed status=interrupted → run interrupted… The app should not mark the run terminal solely because the interrupt request returned." — [R/docs/orchestration-v2/feature-lifecycles.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/feature-lifecycles.md)
- **Stop → hard interrupt.** `ProviderTurnControlService.interrupt` calls `session.value.interruptTurn({providerThread, providerTurnId, requestRuntimeRestart: true})` even for settled turns. "A settled turn reaches its adapter too: only the adapter knows whether it still runs work for the thread" — [ProviderTurnControlService.ts#L171-L198](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderTurnControlService.ts#L171)
  - The worker then dispatches `thread.background-work.settle` with `commandId = ${effect.id}:background-work-settled`: "Whatever the thread still shows on that provider thread is work no process will report on, so the Stop ends it too" — [EffectWorker.ts#L165-L195](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EffectWorker.ts#L165)
  - `settleBackgroundWork` marks pending `command_execution|dynamic_tool|subagent` turn items with run ordinal ≤ the stopped run `interrupted`. It skips items on *other* provider threads that still have a live session ("A live process owns its roster and reports clearing it"), and empties `pendingBackgroundTasks` on threads with no live session. It bails if a new run started since Stop — [Orchestrator.ts#L7850-L7990](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L7859)
- **Stop holds the queue.** `dispatchRunInterrupt` emits `run.updated {...queuedRun, queueHeld: true}` for every queued run, plus a `run_interrupt_request` turn item. If no provider turn exists yet (run `preparing|starting`), it writes a `run_interrupt_result` "Run interrupted before provider start" directly — [Orchestrator.ts#L7995-L8140](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L7995)
- **Non-retryable interrupt failures.** `provider-turn.interrupt` failures matching `/is not active/`, `/hard teardown is already in progress/`, or `/treating as already interrupted/` are not retried. This does not apply to `provider-turn.restart`, because "Swallowing a start failure that happens to mention 'is not active' would drop the outbox item without ever starting the replacement turn" — [EffectWorker.ts#L41-L60](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EffectWorker.ts#L41)
- **Claude.**
  - `interruptTurn` on an active turn does `query.interrupt`, then `query.close`, waits up to 10 s for `closed`, and otherwise self-finalizes the turn as `interrupted` with a warning.
  - On Stop of an already-settled turn (`requestRuntimeRestart` and no active turn): "The background shells belong to the CLI process, so closing its query is what stops them". It calls `closeLiveQueryForNativeThread`, then clears wake state and resets the background-task roster to idle.
  - Source: [ClaudeAdapterV2.ts#L7237-L7323](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L7237)
- **Claude background work model.**
  - "Claude can settle a turn while a local_bash background task keeps running; the CLI later re-invokes the model (a 'wake turn') on the same query stream with no active provider turn. These refs track pending background tasks, buffer wake messages until a continuation run attaches."
  - The roster is keyed by native session id "so concurrent provider threads on one runtime cannot share or clear each other".
  - Background subagents (`Agent` with `run_in_background`) live in a session-scoped registry that survives turn settle. Nested subagents (spawn_depth >1) never wake the root.
  - Source: [ClaudeAdapterV2.ts#L3000-L3080](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L3000)
  - Task classification: only SDK `task_type === "local_bash"` counts as opaque background work, with kind `command`. "Claude runs a Monitor as a local_bash task, so only the Monitor tool call that started it tells it apart from a background Bash command" (kind `monitor`). The undeclared SDK subtype `background_tasks_changed` is a "full roster snapshot of live background tasks" — [ClaudeAdapterV2.ts#L1715-L1770](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1715)
  - The roster schema `OrchestrationV2PendingBackgroundTask` has kinds `subagent` (with optional `childThreadId`), `command`, `monitor`, and `background_task` — [contracts L802-L821](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L802)
  - A model/setting change that needs a new Claude process while background work runs fails with `ClaudeBackgroundWorkBlocksQueryReplacementError`: "Claude is still running background agents or commands, and this model or setting change would end them. Wait for them to finish, or press Stop, then send the message again." — [ClaudeAdapterV2.ts#L351-L357](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L351). Merged #14726 (2026-10-02): "Claude model changes no longer kill running background agents" — [commit b4d3d51a](https://github.com/pingdotgg/t3code/commit/b4d3d51a)
- **Codex.** `interruptTurn`:
  1. Collects the target turn plus all active/settled **descendant** turns (child agents) and registers completion waiters.
  2. Waits for `nativeStartReady`: "A null start timestamp acknowledges a queued turn; Codex cannot interrupt it until turn/started confirms that the native task exists". After 10 s it fails with "Codex did not start the queued turn within 10 seconds; Stop could not be delivered."
  3. Sends `turn/interrupt {threadId, turnId}` for each target, then re-scans for late-spawned descendants in a loop.
  4. In parallel, calls `thread/backgroundTerminals/terminate {threadId, processId}` for every tracked running command item. It verifies through paginated `thread/backgroundTerminals/list` that the process is gone, or errors "remained active after termination". If the app-server process exited, it treats the terminal as terminated.
  5. Finally terminalizes the retained command and dynamic-tool items of settled turns as `interrupted`.
  - Source: [CodexAdapterV2.ts#L2043-L2080, L5656-L6030](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L5656)
  - Settled turns with running background commands are retained ("Turn contexts retained past turn/completed while background command items started in that turn are still running"), and a `continuationRequests` sink exists "so the orchestrator can start a continuation run" on late completion — [CodexAdapterV2.ts#L1538-L1545, L1684-L1690](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L1538)
  - `unloadThread` sends `thread/unsubscribe` so "the shared app-server [can] shut the native thread (and its MCP servers) down once it is idle" — [CodexAdapterV2.ts#L5642-L5656](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L5642)
- **Grok/ACP.**
  - User Stop: "still hard-kills the process group and respawns so existing background tasks stop too… current source kills foreground work but intentionally preserves already-backgrounded tasks" (`restartRuntimeAfterInterrupt: true`, `terminateRuntimeProcessGroupOnInterrupt: true`) — [GrokAdapterV2.ts#L236-L246](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.ts#L236)
  - The ACP interrupt runs under a runtime transition permit and handles races: a concurrent Stop waits for the in-flight hard teardown. A Stop that races a soft interrupt that already cleared the turn "contain[s] the orphan runtime": it quarantines the transport generation, cancels pending approvals/elicitations, terminalizes carry-over subagents, and kills the process group. "Transport death or a prior Stop already cleared the turn. Failing here caused effect-worker retries while the process was already gone; treat as success." — [AcpAdapterV2.ts#L7297-L7420](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L7297)
- **Pi.** Stop on a settled turn returns ("Pi runs nothing between prompts"). A normal interrupt sends `{type:"abort"}`. On Stop (`requestRuntimeRestart`), during compaction, or in `settleWhenIdle`, it sends abort with a 2 s timeout, captures session-tree refs for rollback, then `connection.terminate`: "Pi's generic abort does not cancel manual compaction" — [PiAdapterV2.ts#L2466-L2515](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts#L2466)
- **Cursor.** Sets `context.interrupted = true` and calls `context.run.cancel`. It waits 10 s for completion, otherwise finalizes as `interrupted`. Stop on a settled turn is a no-op ("finalization already ended its tools and subagents") — [CursorAdapterV2.ts#L2429-L2468](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CursorAdapterV2.ts#L2429)
- **OpenCode 1/2.** Interrupt aborts in-flight HTTP request controllers and calls `client.session.abort({sessionID})` (OC1). OC2 interrupts follow-up sessions with `session.interrupt` and cancels pending forms — [OpenCodeAdapterV2.ts#L3383-L3420](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/OpenCodeAdapterV2.ts#L3383); [OpenCode2AdapterV2.ts#L3405-L3450, L3908](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.ts#L3908)
- **Recorded fixtures** exist for these flows: `turn_interrupt`, `turn_interrupt_mid_tool`, `turn_interrupt_restart`, `claude_background_task_interrupt`, `claude_background_monitor_wake`, `grok_background_bash`, `grok_monitor`, `opencode2_interrupt`, and `stop_background_work_after_failed_turn` (87 fixture scenarios total) — [R/apps/server/src/orchestration-v2/testkit/fixtures/](https://github.com/pingdotgg/t3code/tree/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures)
- **Open Stop/interrupt PRs and issues** (all OPEN as of 2026-10-04):
  - PR #15298 "Stop ends a run whose turn its adapter already settled". Claude reported `result/success` but the run stayed `running`. Sixteen Stop presses succeeded at the effect level, and "nothing ever ends the run".
  - PR #15474 "Stop reaches background work after a run fails before its provider starts".
  - PR #15331 "Stop on a completion-wake run also disposes the tasks it delegated".
  - Issue #15197, the stuck "Thinking" run.
  - Issue #15013, the interrupt hardening list: "Define and test what happens when a provider accepts an interrupt but then completes normally"; "explicit policy… for starting a new root turn while an interrupted provider turn is still active".
  - Merged: #14896 "a Claude command you stop shows as interrupted" (2026-10-03) and #15355 "Stop ends a dev server left running before a provider switch".
  - Source: [PR #15298](https://github.com/pingdotgg/t3code/pull/15298); [issue #15013](https://github.com/pingdotgg/t3code/issues/15013)
- **Solenta's `stopRun`:**
  1. Cascades to crew workers first.
  2. Stops the Solenta-managed dev server ("Solenta-managed `npm run dev` is its own process group, so killTree on the agent CLI never reaches it").
  3. Sets `entry.stopping`, cancels outstanding Codex server requests, and calls `entry.handle.kill()`.
  - There is no queue-hold step and no separate background-work settle.
  - Source: [electron/runner.js L8854-L8935](file://electron/runner.js)

### Inferences
- Patterns worth adopting in Solenta:
  - (1) **Stop pauses the queue** (`queueHeld`) and requires an explicit resume.
  - (2) **Stop always runs a "settle leftover background work" pass**, idempotent and keyed by the effect, that marks pending tool/command items interrupted for providers whose process died.
  - (3) **Keep two interrupt strengths**: Stop is hard, kills the process group and background shells, and asks for a respawn; steering-restart is soft and keeps the process and backgrounded work.
  - (4) **Never terminalize on the interrupt ack.** Wait for the provider terminal with a ~10 s timeout, then self-finalize as interrupted.
- For Codex specifically, Solenta should replicate the `thread/backgroundTerminals/terminate` + `thread/backgroundTerminals/list` verification and the descendant-turn interrupt. A plain `turn/interrupt` leaves Codex background terminals running.
- Claude's background `local_bash`/Monitor tasks die only when the CLI process dies. Solenta's keepAlive path (claude.js keeps stdin open "so the process (and its background tasks) survives the turn") matches T3's model. T3 adds a roster (`background_tasks_changed`, task_started/notification) to show "Waiting" and to defer idle release.

### Gaps
- What OpenCode 2 does with background subagents on Stop was only partially read. OPEN PR #14760 "OpenCode 2 stops subagents a dropped background reply started" suggests it is still being fixed.

## 4. Approvals / permission requests, runtime modes, and the Claude Auto/Plan regressions

### Takeaway
**Who builds an approval.** Each adapter, not the orchestrator, builds three artifacts for every permission prompt:
- an `approval_request` (or `user_input_request`) ExecutionNode with id `node:runtime-request:<requestId>` and status `waiting`;
- a `RuntimeRequest` with status `pending` and `responseCapability: {type:"live", providerSessionId}`;
- an `approval_request` turn item.

The run's own status does not change, so "waiting" on a Run means post-terminal drain. Pending prompts surface through the thread's `pendingRuntimeRequest`.

**Modes and decisions.**
- Four runtime modes: `approval-required | auto-accept-edits | auto | full-access` (default `full-access`).
- Two interaction modes: `default | plan`.
- Five decisions: `accept | acceptForSession | acceptAlways | decline | cancel`.

Each adapter maps modes onto native flags and maps decisions back. The details are below.

**Two open Claude bugs.**
- **#15353 (OPEN):** Auto mode does not install the asking permission callback. Claude's own escalations (ask rules, protected paths, classifier escalations) therefore get auto-`allow`ed. **Fix PR #15360 (OPEN)** asks for every mode except full-access.
- **#15503 (OPEN, no fix PR):** `plan` takes precedence. Claude routes plan-mode writes to `canUseTool`, which auto-allows them under Auto or Full access.

### Cited Findings
- **RuntimeRequest schema:**
  - `kind`: ProviderRequestKind or `dynamic_tool_call | user_input | auth_refresh`.
  - `status`: `pending | resolved | expired | cancelled`.
  - `responseCapability`: `{type:"live", providerSessionId} | {type:"message"} | {type:"not_resumable", reason}`.
  - Source: [contracts L966-L985](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L966)
- **Request kinds:** `command | file-read | file-change | mcp-elicitation | permission`. There is no `apply_patch` kind; Codex `applyPatchApproval` becomes `file-change`.
- **Decisions:** `accept | acceptForSession | acceptAlways | decline | cancel`.
- Source: [R/packages/contracts/src/providerPolicy.ts#L25-L56](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/providerPolicy.ts#L25)
- **Runtime modes:** `"approval-required" | "auto-accept-edits" | "auto" | "full-access"`, default `"full-access"`. The UI labels them Supervised, Auto-accept edits, Auto, and Full access. Interaction modes are `["default","plan"]` — [providerPolicy.ts#L25-L34](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/providerPolicy.ts#L25)
  - A mode the provider does not offer runs as `"approval-required"` — [R/apps/server/src/orchestration-v2/RuntimePolicy.ts#L79-L88](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/RuntimePolicy.ts#L79)
  - The policy passed to adapters is `{runtimeMode, interactionMode, cwd, approvalPolicy?, sandboxPolicy?, reasoningEffort?}` — [ProviderAdapter.ts#L47-L54](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderAdapter.ts#L47)
- **Artifact construction (Claude example).** `buildApprovalRequestArtifacts` derives the node id with `idAllocator.derive.approvalNode({requestId})`. It sets `kind: questions === undefined ? "approval_request" : "user_input_request"`, `status: "waiting"`, and `responseCapability: {type:"live", providerSessionId}`, then emits `node.updated`, then `runtime_request.updated`, then `turn_item.updated` — [ClaudeAdapterV2.ts#L4595-L4693, L6702-L6721](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L4595)
  - The id format comes from `approvalNode: (input) => NodeId.make(joinId("node","runtime-request", input.requestId))` — [IdAllocator.ts#L430](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/IdAllocator.ts#L430)
  - The run is parked at `"waiting"` only after a completed provider turn: `input.terminal.status === "completed" ? "waiting" : input.terminal.status` — [RunExecutionService.ts#L635-L636](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/RunExecutionService.ts#L635)
- **Responding.** `dispatchRuntimeRequestRespond`:
  - Rejects anything that is not `pending` or is `not_resumable`.
  - Marks the request `resolved`. The node becomes `cancelled` for decline/cancel and `completed` otherwise.
  - Enqueues a `runtime-request.respond` effect — [Orchestrator.ts#L6805-L7032](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L6805)
  - `RuntimeRequestService` requires a `live` capability whose session matches before it calls the adapter — [RuntimeRequestService.ts#L98-L122](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/RuntimeRequestService.ts#L98)
  - When a session is released, pending live requests become `not_resumable`, with status `expired` or `cancelled` — [ProviderSessionManager.ts#L654-L682](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L654)
- **Claude mode mapping** (`permissionModeForClaudeRuntimePolicy`):
  - `interactionMode === "plan"` → `"plan"` (checked first).
  - `approval-required` → `"default"`, `auto-accept-edits` → `"acceptEdits"`, `auto` → `"auto"`, `full-access` → `"bypassPermissions"`.
  - An explicit `approvalPolicy: "never"` with a `readOnly` sandbox → `"dontAsk"`; with a `dangerFullAccess` sandbox → `bypassPermissions`.
  - Source: [ClaudeAdapterV2.ts#L1440-L1487](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1440)
- **Claude ask gate:** `installPermissionCallback = approvalPolicy === undefined ? runtimeMode === "approval-required" || runtimeMode === "auto-accept-edits" : approvalPolicy !== "never"`, under the comment "acceptEdits approves edits before the callback runs; everything else it leaves to the callback, which must ask rather than allow" — [ClaudeAdapterV2.ts#L1508-L1515](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1508)
  - `canUseTool` is always passed, whatever the mode.
  - `AskUserQuestion` becomes a `user_input` request.
  - `ExitPlanMode` is always answered `deny`, and the plan is captured.
  - When no approval is needed the callback returns `{behavior:"allow", updatedInput}` — [ClaudeAdapterV2.ts#L6525-L6745](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L6525)
- **Claude decision mapping:**
  - `accept`/`acceptForSession` → `{behavior:"allow", updatedInput, decisionClassification: user_temporary|user_permanent, updatedPermissions?}`. A session grant rewrites suggestions to `destination:"session"`, or falls back to an `addRules` rule for the tool.
  - `decline` → `{behavior:"deny", decisionClassification:"user_reject"}`.
  - `cancel` adds `interrupt: true`.
  - Source: [ClaudeAdapterV2.ts#L2177-L2239](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L2177)
  - Merged #15224 (2026-10-03) resets the permission mode after Claude enters plan mode by itself. Comment: "Claude can switch its own mode mid-session (EnterPlanMode), and a denied ExitPlanMode leaves it there" — [ClaudeAdapterV2.ts#L6888-L6894](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L6888)
- **Codex mode mapping.** Values are sent on every `turn/start`; `thread/start` carries only cwd, model, and config.

  | runtime mode | approvalPolicy | approvalsReviewer | sandboxPolicy |
  |---|---|---|---|
  | approval-required | `untrusted` | `user` | `{type:"readOnly"}` |
  | auto-accept-edits | `on-request` | `user` | `{type:"workspaceWrite"}` |
  | auto | `on-request` | `auto_review` | `{type:"workspaceWrite"}` |
  | full-access | `never` | `user` | `{type:"dangerFullAccess"}` |

  Plan mode sends `collaborationMode: {mode: "plan"|"default", settings: {reasoning_effort}}` — [CodexAdapterV2.ts#L655-L771](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L655)
  - Responses go back as JSON-RPC results:
    - `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` → `{decision}`, with `acceptAlways` sent as `acceptForSession`.
    - `item/permissions/requestApproval` → `{permissions, scope: "session"|"turn"}`.
    - Legacy `execCommandApproval`/`applyPatchApproval` → `approved | approved_for_session | {denied} | abort`.
    - Source: [CodexAdapterV2.ts#L533-L573, L4473-L4801](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L4473)
  - **OPEN PR #14888**: Auto and Auto-accept-edits send a bare `workspaceWrite`, which drops sandbox network access.
- **Cursor (`@cursor/sdk`).**
  - `autoReview` is on only for `approval-required`. `sandboxEnabled = runtimeMode !== "full-access"`. Plan → `mode: "plan"`, else `"agent"`.
  - No interactive approvals: `respondToRuntimeRequest` fails with "Cursor Agent SDK does not expose interactive approval requests."
  - Source: [CursorAdapterV2.ts#L182-L201, L315, L2469-L2479](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CursorAdapterV2.ts#L182)
- **ACP generic.**
  - Permission requests go through `acpPermissionDisposition`, which returns `allow`, `ask`, or `deny`; only `ask` creates a T3 request.
  - Option selection: `acceptForSession` → `allow_always`, `accept` → `allow_once`, else `reject_once`. The response is `{outcome:{outcome:"selected", optionId}}`, or `{outcome:{outcome:"cancelled"}}` for cancel or no match.
  - Plan mode switches to the session mode `"plan"`/`"architect"` and later restores the previous build mode.
  - Source: [AcpAdapterV2.ts#L1036-L1061, L5499-L5639, L6220-L6302](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L1036); [R/apps/server/src/provider/acp/AcpClientPolicy.ts#L101-L219](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/AcpClientPolicy.ts#L101)
- **Grok (ACP).**
  - Launch args by mode: `auto` → `["--permission-mode","auto","agent","stdio"]`, `full-access` → `["agent","--always-approve","stdio"]`, other modes → `--permission-mode default`.
  - Supported modes: `approval-required`, `auto`, `full-access`.
  - Comment: "`acceptEdits` only exists as a settings-file `permissions.defaultMode`, and `grok agent` treats it as ask".
  - Source: [R/apps/server/src/provider/acp/GrokAcpSupport.ts#L41-L77](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/GrokAcpSupport.ts#L41)
  - Any explicit approval or sandbox override launches as `approval-required` — [GrokAdapterV2.ts#L224-L230](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.ts#L224)
- **OpenCode.**
  - OC1 sends permission rules on `session.create`. Full access → `[{permission:"*", pattern:"*", action:"allow"}]`. Otherwise deny-all, then `ask` for bash/edit/webfetch, with read/glob/grep always allowed. `auto-accept-edits` adds `edit: allow`.
  - OC2 rules:
    - full-access → `rule("*","allow")`.
    - Otherwise `shell: ask`, `edit: ask` (or `allow` for auto-accept-edits), `external_directory: ask`.
    - Plan adds `edit: deny` and switches to the `plan` agent.
    - Comment: "Shell and read are never denied: the free tier refuses sessions whose rules deny them".
  - OC2 always replies `once` or `reject`. A session grant becomes a session rule instead of OpenCode's project-wide `always`. A decline carries a message "because a reject without a message ends the whole run".
  - Source: [OpenCodeAdapterV2.ts#L621-L711](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/OpenCodeAdapterV2.ts#L621); [OpenCode2AdapterV2.ts#L467-L486, L3995-L4074](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.ts#L467)
- **Pi.**
  - Runtime mode reaches Pi only as an env var read by a T3-injected extension: `auto` is mapped to `approval-required`.
  - The extension's `tool_call` hook calls `ctx.ui.confirm(...)` and returns `{block:true}` on decline. The answer is sent back as `{type:"extension_ui_response", id, confirmed|cancelled}`.
  - Pi has no plan-mode mapping.
  - Source: [piT3McpInjection.ts#L299-L303](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/piT3McpInjection.ts#L299); [piT3McpExtensionSource.ts#L234-L247](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/piT3McpExtensionSource.ts#L234); [PiAdapterV2.ts#L2516-L2535, L2927-L2936](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts#L2516)
- **#15353 "Claude Auto mode on orchestrator v2 runs ask-rule commands without prompting"** (OPEN, 2026-10-03).
  - Root cause per the issue and triage: `runtimeMode:"auto"` maps to `permissionMode:"auto"` with `installPermissionCallback: false`. `canUseTool` is still passed, so Claude's escalations hit the `!requiresClaudeApproval` branch and get `allow`. This is the same gap that merged #13786 closed for Auto-accept edits.
  - Fix: **PR #15360 "fix(server): Claude Auto mode asks before commands it escalates" (OPEN)**. It changes the default branch to `runtimePolicy.runtimeMode !== "full-access"` (+5/−4 in source, plus about 170 lines of tests).
  - Source: [issue #15353](https://github.com/pingdotgg/t3code/issues/15353); [PR #15360](https://github.com/pingdotgg/t3code/pull/15360)
- **#15503 "Claude Auto + Plan silently approves native plan-mode write requests (V2)"** (OPEN, 2026-10-04).
  - Root cause per the issue: plan wins, so the permission mode is `"plan"`. "Claude's plan mode routes file edits, and file-modifying shell commands on Claude Code ≥2.1.212, to `canUseTool`". Under Auto or Full access `requiresClaudeApproval` is false, so the callback returns `allow`.
  - No linked fix PR was found by `gh pr list` searches for "15503", "plan mode approval", or "Auto + Plan".
  - Source: [issue #15503](https://github.com/pingdotgg/t3code/issues/15503)
- **Other approval items since 2026-10-02.**
  - Open PRs:
    - #15308 closes stale request prompts during recovery and detach.
    - #14895 surfaces approval-only MCP elicitations. Issue #14878: Claude has no `onElicitation`, so the SDK auto-declines.
    - #15430 adds `blocking` to `pendingRuntimeRequest` so async questions keep a thread "Working".
    - #15317 handles a blank AskUserQuestion option that fails the run.
  - Open issue #15082: a delegated child that needs approval never tells its parent.
  - Every adapter has `pendingRequestsSurviveRestart: false`.
  - Source: [PR #15308](https://github.com/pingdotgg/t3code/pull/15308); [issue #15082](https://github.com/pingdotgg/t3code/issues/15082)
- **Solenta today:**
  - `permissionModes` are `default | acceptEdits | plan | bypassPermissions` ([electron/providers.js L76-L78](file://electron/providers.js)).
  - Grok runs headless `-p` with "NO prompt channel", so asking modes are remapped to `bypassPermissions` + `--always-approve`, because otherwise "the run dies with `errors: ["cancelled"]`" ([electron/providers.js L566-L590](file://electron/providers.js)).
  - T3 instead drives Grok as an ACP agent (`grok agent stdio`), where `session/request_permission` is a real prompt channel.

### Inferences
- The #15353 and #15503 lesson applies directly to Solenta's Claude path. If a permission callback is wired at all (SDK `canUseTool` or a CLI permission-prompt tool), Claude sends it the requests *its own mode* escalates, such as ask rules, protected paths, and plan-mode writes. The callback must ask or deny those, never default to allow. The safe rule is PR #15360's: ask in every mode except full-access, and give plan mode its own deny-writes rule.
- Moving Grok from headless `-p` to `grok agent stdio` (ACP) would give Solenta real approvals and soft `session/cancel` for Grok. The price is an ACP client (`initialize`, `session/new|load`, `session/prompt`, `session/update`, `session/request_permission`, `session/cancel`).
- T3's `responseCapability` (`live` / `message` / `not_resumable`) cleanly models "the approval died with the process". Solenta could stamp pending approvals the same way on restart, so the UI never offers an Approve button that cannot reach a process.

### Gaps
- I did not verify whether Solenta's Claude spawn args pass a `--permission-prompt-tool` (the CLI-side equivalent of `canUseTool`). Whether the #15353 failure mode exists in Solenta today is unverified.
- `acceptAlways` falls through to `reject_once` in ACP option selection. No ACP flavor offers it, so this is latent, not observed.

## 5. Usage limits: detection, reset-time parsing, "Limited" state, resume/snooze

### Takeaway
T3 detects usage limits only from **structured provider signals**, never from regexes on error text:
- **Claude**: `rate_limit_event` with `status === "rejected"` and no overage; an assistant `error === "rate_limit"`; `terminal_reason === "blocking_limit"`; or API status 429.
- **Codex**: `codexErrorInfo` of `usageLimitExceeded` or `rateLimitExceeded`.
- **Grok**: ACP `stopReason === "rate_limit"`, mapped to error code −32003.
- **Mistral Vibe** (registry): error code −31001.
- **Cursor, OpenCode, Pi**: none.

Reset times come only from Claude (`resetsAt` epoch seconds per window, taking the latest of the rejected windows) and Codex (`account/rateLimits` windows with `usedPercent >= 100`, all of which must have `resetsAt`, taking the latest). The failure is stored as `failure: {class:"usage_limit", resetAt?}` on the failed turn terminal.

"Limited" is a UI label derived from `lastErrorClass === "usage_limit"`. Resume-at-reset and snooze are **opt-in** (both settings default `false`). A 5-second scheduler sweep dispatches an idempotent "Continue where you left off." message once the reset passes. The queue stays held while the thread is limited.

### Cited Findings
- **Failure class** is `usage_limit | provider_error | transport_error | permission_error | validation_error | unknown`. `ProviderFailure` has `retryable` and "`resetAt` … Reported reset time; absent when the provider cannot name one". `ProviderRetry` is `{attempt, maxAttempts, retryDelayMs}` — [contracts L1200-L1239](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L1200)
  - `resetAt` is kept only for `usage_limit` and only if it parses. The error item is titled "Usage limit reached" — [ProviderFailure.ts#L156-L192](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderFailure.ts#L156)
- **"Limited" is not a contract status.** The thread shell carries `lastErrorClass` and `usageLimitResetAt` ([contracts L1745-L1746](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L1745)). The sidebar computes `thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed"` ([R/apps/web/src/components/Sidebar.logic.ts#L994](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/Sidebar.logic.ts#L994)).
- **Claude detection:**
  - `rate_limit_event` → `blocked = rateLimitInfo.status === "rejected" && !overageAllowed`, which adds the window to `rejectedRateLimitTypes` and stores `resetMs = resetsAt * 1000`.
  - `allowed`/`allowed_warning` clears the window.
  - Events arriving with no active turn are buffered for the wake turn.
  - Assistant `message.error === "rate_limit"` sets `latestAssistantRateLimited`.
  - The `api_retry` frame with `error_status === 429` → `usage_limit`, `retryable: true`.
  - Source: [ClaudeAdapterV2.ts#L5399-L5448, L5591, L2484-L2490](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L5399)
  - On the terminal `result`:
    - `usageLimited` requires a rejected window or an assistant rate_limit, no auth failure, `api_error_status` null or 429, and `terminal_reason` null, `api_error`, or `blocking_limit`.
    - Hint text: "Claude usage limit reached. Send the message again once the limit resets."
    - `resetAt` is the latest reset among the rejected windows, but only if every one of them has a reset.
    - Source: [ClaudeAdapterV2.ts#L6284-L6310](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L6284)
  - 529 "overloaded" is `provider_error`, retryable — [ClaudeAdapterV2.ts#L2442-L2472](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L2442)
  - **OPEN PR #14891** notes that today "any 429 reads as a usage limit". **OPEN PR #15105** adds proxy 429 + `Retry-After` handling.
- **Codex detection:**
  - The `error` notification and `turn/completed.turn.error.codexErrorInfo` are mapped by `code === "usageLimitExceeded" || code === "rateLimitExceeded" ? "usage_limit" : code startsWith "http"/"responseStream" ? "transport_error" : "provider_error"`.
  - `willRetry` errors become retry items instead of failures.
  - `serverOverloaded` stays `provider_error`.
  - Source: [CodexAdapterV2.ts#L1006-L1014, L3919-L3956, L4943-L4947](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L3919)
  - The reset is computed by `codexUsageLimitResetAt`: "All exhausted windows must reset before a continuation can run". It filters windows with `usedPercent >= 100`, returns null if any lacks `resetsAt`, and otherwise takes the latest — [R/apps/server/src/provider/Layers/codexUsageLimits.ts#L236-L250](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/Layers/codexUsageLimits.ts#L236)
  - Late `account/rateLimits/updated` data "Fill[s] late reset data once" — [CodexAdapterV2.ts#L3809-L3815](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L3809)
  - **OPEN issue #14169** "Orchestrator V2 Usage Reset Tracker Broken": Codex shows "Reset time unavailable" because a window never reaches 100%. **OPEN PR #14889** falls back to the reset shown in Limits.
- **Grok:** `if (notification.stopReason === "rate_limit") return new AcpRequestError({code: xAiRateLimitedErrorCode /* -32003 */, errorMessage: "Grok usage limit reached. Try again later."})`, then `class: cause.code === xAiRateLimitedErrorCode ? "usage_limit" : "provider_error"`. There is no reset time — [R/apps/server/src/provider/acp/XAiAcpExtension.ts#L18, L1411-L1415](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/XAiAcpExtension.ts#L1411); [GrokAdapterV2.ts#L303](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.ts#L303)
- **Mistral Vibe** (ACP registry): error code `-31001` and `_session/retrying` with `category === "rate_limited"` both map to `usage_limit` — [AcpRegistryAdapterV2.ts#L92-L133](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.ts#L92)
- **Cursor, OpenCode 1/2, and Pi have no usage-limit classification.** Pi `auto_retry_start` becomes `provider_error`, retryable. The research subagent's search found no reset-time regex anywhere in the server or web code — [PiAdapterV2.ts#L1690-L1703](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts#L1690)
- **Opt-in settings:** `snoozeLimitedThreads` and `autoResumeLimitedThreads`, both `withDecodingDefault(false)` — [R/packages/contracts/src/settings.ts#L1275-L1276](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/settings.ts#L1275)
  - Per-thread state is `OrchestrationV2LimitRecovery = {requestId?, runId, resetAt, autoResume, snooze?}` — [contracts L332-L338](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L332)
  - Banner buttons: "Resume at reset", "Cancel auto-resume", "Snooze until reset". When there is no reset: "Reset time unavailable; retry manually" — [R/apps/web/src/components/chat/UsageLimitRecoveryBanner.tsx](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/UsageLimitRecoveryBanner.tsx)
  - Arming is rejected if "The reset time has passed. Retry the thread manually.". A snooze sets `snoozedUntil = resetAt` — [Orchestrator.ts#L2598-L2603, L2808-L2816](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L2598)
- **Resume worker.** `UsageLimitRecoveryWorker` first arms the thread (`thread.metadata.update`, commandId `limit-arm:<identity>`). After the reset, with no active snooze, it dispatches `message.dispatch`:
  - `commandId` and `messageId` are both `limit-resume:<identity>:<requestId|legacy>`.
  - `usageLimitContinuationOfRunId: thread.latestRunId`.
  - `text: "Continue where you left off."`, `dispatchMode: {type:"start_immediately"}`, `createdBy: "user"`, `creationSource: "server"`.
  - It is registered as `scheduler.register("usage-limit-recovery", sweep())` on a shared 5 s scheduler.
  - Source: [UsageLimitRecoveryWorker.ts#L38-L113](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts#L38); [R/apps/server/src/scheduling/Scheduler.ts#L60](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/scheduling/Scheduler.ts#L60)
- **While limited:**
  - The queue is held: "The limit already stopped this thread. Starting the queue would send every waiting message…".
  - `queue.resume` is refused with "Continue the limited thread before resuming its queue."
  - Manual resume (`manualContinuationOfRunId`) accepts a `failed` run only when its latest failure is `usage_limit`, or an `interrupted` run.
  - Source: [Orchestrator.ts#L1220-L1231, L4312-L4330, L9594-L9599](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L4312)
- **Account usage display (separate from failure detection):**
  - Codex probe `account/rateLimits/read` (3 s timeout) plus live `account/rateLimits/updated`.
  - Claude `get_usage` probe (5-minute TTL) plus live `rate_limit_event`.
  - HTTP endpoints for Cursor (`DashboardService/GetCurrentPeriodUsage`), Grok (`cli-chat-proxy.grok.com/v1/billing`), and OpenCode Go.
  - Default refresh is every 5 minutes, demand-driven.
  - Source: [R/apps/server/src/provider/Layers/CodexProvider.ts#L451-L457](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/Layers/CodexProvider.ts#L451); [contracts/settings.ts#L1034](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/settings.ts#L1034)
- **Open items since 2026-10-02** (OPEN unless noted):
  - #15553: show scheduled recovery in thread lists.
  - #15176 and #15130: a snoozed thread reappears early.
  - #15555: Resume retries Claude after the user switched to Codex.
  - #15354: Claude `get_usage` 4 s timeout vs ~11 s real latency.
  - Closed issue #15126 (auto-fork when a rate limit cuts a turn off) was moved to discussion #15128.
  - Source: [issue #15555](https://github.com/pingdotgg/t3code/issues/15555); [issue #15130](https://github.com/pingdotgg/t3code/issues/15130)
- **Solenta today:**
  - Detection is text-based. `QUOTA_RE = /usage[_\s-]?limit|hit your (?:session |weekly |daily )?(?:limit|cap)|rate[_ ]?limit|\b429\b|quota[_\s-]?(?:exceeded|exhausted)|…|limit reached/i`, and a reset clock is parsed from the error text (`MAX_WAIT_MS = 8 days`) — [electron/quotaWait.js L4-L65](file://electron/quotaWait.js)
  - The runner parks the thread as `status: "quota-wait"` with `quotaWaitUntil` and schedules a wake. Before that it tries a cross-provider failover chain — [electron/runner.js L3090-L3125, L3145, L3263-L3330](file://electron/runner.js)

### Inferences
- For Solenta's Claude stream-json path, T3's structured signal is available on the same stream: the `rate_limit_event` NDJSON frame with `rate_limit_info.status` / `resetsAt` (epoch seconds) / overage, plus `result.terminal_reason === "blocking_limit"`. Solenta could prefer these over `QUOTA_RE` text matching. That would avoid false positives such as transient 429s, which T3 itself still misclassifies (#14891). The regex would remain the fallback for kimi, cursor, and opencode.
- For Codex app-server, Solenta can key off `codexErrorInfo` (`usageLimitExceeded`/`rateLimitExceeded`) and take the reset from `account/rateLimits/updated`, using the "all exhausted windows must reset; take the latest" rule.
- T3 makes auto-resume opt-in and holds the queue while limited, so queued prompts don't burn into the same wall. Solenta auto-wakes when `quotaWaitEnabled`. Holding the queue during a quota wait and using an idempotent resume id (`limit-resume:<thread>:<requestId>`) are the two cheap pieces to copy.

### Gaps
- I did not verify the exact Claude stream-json `rate_limit_event` field names in Solenta's own recorded CLI output. T3's names come from the Agent SDK types (`rate_limit_info.status`, `resetsAt`, overage), and the CLI NDJSON is assumed to match.
- How T3 behaves when Codex's error carries `willRetry` and the retry also hits the limit was not traced.

## 6. Session recovery after app restart

### Takeaway
T3 **never resurrects provider processes** on boot. Startup recovery runs before the effect worker:
- It **cancels** (not interrupts) every `preparing/starting/running/waiting` run, with its attempts, nodes, provider turns, turn items, and native subagents.
- Pending approvals and questions become `expired` + `not_resumable`.
- Open background command/tool/subagent items are cancelled and recorded as `run.background-work-cancelled`, so the **next** turn on that provider thread gets a "the T3 server restarted, and this background work was cancelled" note.
- Provider threads become `idle` and sessions `stopped`.
- Queued runs keep their ids and order but get `queueHeld: true` until an explicit `queue.resume`.
- App-owned delegated children are left open to settle.

"Auto-continue after restart" exists behind the opt-in `continueThreadsAfterServerUpdate` (default **false**). It enqueues a durable `provider-runtime.continue` effect, which sends "Continue where you left off." on the next session, which is opened lazily.

The native conversation is resumed lazily per provider:
- Codex: `thread/resume`.
- Claude: SDK `resume`/`resumeSessionAt`.
- Cursor: `Agent.resume`.
- ACP: `session/load` or `session/resume`.
- OpenCode: `session.get`.
- Pi: `switch_session` with the session file path.

If a resume fails, T3 falls back to a fresh native session plus a `full_thread_summary` handoff.

### Cited Findings
- **Startup order:** `importLegacyShells` → `recover` (`reconcile("startup")`) → `recoverDelegatedTasks` → `startEffectWorker`. Graceful shutdown runs `prepareForShutdown` → `providerSessions.shutdown` → `reconcile("shutdown")` — [R/apps/server/src/serverRuntimeStartup.ts#L406-L452](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/serverRuntimeStartup.ts#L406)
- **Design statement:** "It intentionally does not resurrect persisted sessions. Process-loss recovery terminalizes provider-bound work and retires non-replayable effects; a later user command… opens a session lazily." — [ProviderSessionManager.ts#L66-L71](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L66)
- **Run terminalization:** `payload: { ...run, status: "cancelled", queuePosition: null, completedAt: now }`. A `waiting` run with a pending `checkpoint.capture` effect is skipped — [ProviderRuntimeRecoveryService.ts#L215-L234, L340-L458](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L340)
- **Requests:** `status: trigger === "startup" ? "expired" : "cancelled", responseCapability: {type:"not_resumable", reason: "The server … before this runtime request was resolved."}`. `message`-type requests (Codex async questions answered by a new user message) are excluded — [ProviderRuntimeRecoveryService.ts#L246-L334](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L326)
- **Background work:** cancelled items are recorded on the latest started run (`run.background-work-cancelled`). The next turn gets "Note: the T3 server restarted, and this background work was cancelled before it finished…" — [ProviderRuntimeRecoveryService.ts#L460-L668](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L648); [RestartBackgroundNote.ts#L93](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/RestartBackgroundNote.ts#L93); [ProviderTurnStartService.ts#L973-L976](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderTurnStartService.ts#L973)
- **Queue:** "Queued runs have not started provider work. Preserve their execution identities and order, but require explicit consent before draining them." → `{...run, queueHeld: true}`. Only `queue.resume` clears it — [ProviderRuntimeRecoveryService.ts#L305-L318](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L305); [Orchestrator.ts#L9572-L9615](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L9572)
- **Outbox:** process-bound effects (`provider-turn.start/interrupt/steer/restart`, `runtime-request.respond`) are cancelled. Replay-safe effects that were `running` are requeued, and that list includes `provider-runtime.continue` — [EffectOutbox.ts#L108-L124, L456-L485](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EffectOutbox.ts#L108)
- **Auto-continue setting:** `// Retain the update-era key; recovery now needs an environment-owned opt-in.` `continueThreadsAfterServerUpdate: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)))` — [contracts/settings.ts#L1204-L1208](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/settings.ts#L1204)
  - When it is on, startup reconcile (and `prepareForShutdown` *before* providers are killed) enqueues `{type: "provider-runtime.continue", sourceRunId}` — [ProviderRuntimeRecoveryService.ts#L669-L682, L795-L826](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L669)
  - **Eligibility:** the latest non-queued run is `running` (with a strong native ref, an active provider thread, a running provider turn, and a live session), or `starting` as a prepared continuation, or `completed`/`waiting` with lost background work. `continueRestartedRun` re-checks the setting and skips archived threads, runs superseded by a newer user run, runs that have a `run_interrupt_request` (the user had pressed Stop), and maintenance commands. It then dispatches `message.dispatch` with "Continue where you left off." and/or the background note, `createdBy: "agent"`, `restartContinuationOfRunId`, and `start_immediately` — [RestartContinuation.ts#L30-L191](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/RestartContinuation.ts#L30)
  - **CLOSED PR #15438** (unmerged, 2026-10-04) would have woken background-waiting threads after every restart. The maintainers' rationale: waking by default "starts unrequested turns after every update". OPEN issue #15358 tracks the stranded-thread symptom — [PR #15438](https://github.com/pingdotgg/t3code/pull/15438); [issue #15358](https://github.com/pingdotgg/t3code/issues/15358)
- **Native resume primitives.**
  - The provider thread persists `nativeThreadRef {driver, nativeId, strength, fingerprint?, ordinal?}` and `nativeConversationHeadRef`. V2 has no `resumeCursor` — [contracts L93-L99, L842-L843](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L93)
  - **Codex:** `thread/resume {threadId, excludeTurns: true, …}`. If the error says the session is archived, it calls `thread/unarchive` and retries once (merged #15389) — [CodexAdapterV2.ts#L5429-L5480](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L5429)
  - **Claude:** `resumeThread` only marks the thread idle. The real resume happens at turn start: `shouldResume = resumeSessionAt !== undefined || openedWithResume || providerTurnOrdinal > 1` → SDK `{resume: nativeThreadId}` (or `{sessionId}`) plus `resumeSessionAt` from `nativeConversationHeadRef` — [ClaudeAdapterV2.ts#L841-L877, L6928-L6941, L7490-L7499](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L6928)
  - **Cursor:** `Agent.resume(agentId, options)` — [CursorAgentSdk.ts#L363-L365](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CursorAgentSdk.ts#L363)
  - **ACP:** `session/load` if `loadSession` is advertised, else `session/resume`. If an eager load fails at open, it falls back to a fresh session — [AcpAdapterV2.ts#L6049-L6105, L7219-L7264](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L7219)
  - **OpenCode 2:** `session.get` → stop leftover requests → write rules → `session.move` if the cwd changed. "a server without this session fails the resume, so T3 recreates the thread with a handoff" — [OpenCode2AdapterV2.ts#L3636-L3667](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.ts#L3636)
  - **Pi:** `{type:"switch_session", sessionPath}`. The persisted native id is the session *file path* — [PiAdapterV2.ts#L1995-L2049, L2233-L2250](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts#L2233)
- **Resume failure fallback:** logs "Provider resume failed; attempting a fresh native session", calls `ensureThread` with `nativeThreadRef: null`, and builds a `provider_resume_fallback` context transfer plus a `full_thread_summary` handoff covering runs 1..N−1 — [ProviderTurnStartService.ts#L659-L773](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderTurnStartService.ts#L665). OPEN issue #15103 / OPEN PR #15318: Claude's fresh-session fallback resumes a newly minted id ("No conversation found").
- **Merged since 2026-10-02:** #15323 "restarts keep delegated tasks, queued threads, and stops intact" (2026-10-03). It holds child results until continuations settle, keeps queues held, keeps Stop intent, and captures shutdown intent before process-group signals — [commit 5108c978](https://github.com/pingdotgg/t3code/commit/5108c978)
- **Open items:**
  - #15357: a SIGKILLed backend leaves `claude` processes running while their runs show `cancelled`; fix PR #15450 is OPEN.
  - #15567: Codex subagents lose tracking after restart.
  - #15513: a copied state DB wakes the original install's agents.
  - Source: [issue #15357](https://github.com/pingdotgg/t3code/issues/15357)
- **Solenta today:** `recoverInterruptedRuns` handles only the crash path. Threads still `working` on load become `failed`, with "Run interrupted: the app crashed or was force-quit mid-run", and open work-log steps are closed. Clean quits mark threads idle via `runner.stopAll` — [electron/store.js L1413-L1458](file://electron/store.js)

### Inferences
- T3 and Solenta both refuse to silently re-run after a crash. T3 adds four pieces Solenta lacks:
  - (a) `queueHeld` on queued runs.
  - (b) A note to the *next* turn listing background work killed by the restart.
  - (c) Expiring approvals with a typed reason.
  - (d) An opt-in "continue after restart" that is captured *during graceful shutdown* (before providers die) and replayed as a durable effect.
- T3 uses `cancelled` rather than `failed` for restart-killed runs, which keeps them out of the failure UI. Solenta marks them `failed`. That is a product choice; T3's reasoning is that a restart is not the model's failure.
- The resume-failure fallback (fresh native session + full-thread-summary handoff) is the robust answer for Solenta's `sessionIdForResume` misses ("No conversation found"). The alternative is surfacing an error.

### Gaps
- Whether T3's Claude SDK `resume` replays tool results identically to the CLI `--resume` flag was not checked.
- The Cursor resume failure path was not traced.

## 7. Process lifecycle: idle reaping, the "~80 idle processes / 9 GB" issue, concurrency

### Takeaway
`ProviderSessionManager` releases a session after **30 min idle**. It defers release while the adapter reports pending background work, but caps that pin at **4 h**. Release closes the session scope within a 30 s budget, and the adapters' finalizers do the killing.

The "~80 idle processes / 9 GB" report is issue **#13331 item 4**. Codex threads share one `codex app-server`, and detaching a T3 thread never unloaded the native thread or its MCP servers. The fix was merged PR #14187, which unloads via `thread/unsubscribe`; Codex then shuts the thread down after its own `thread_unload_delay`, 60 s by default per the PR body.

There is **no global or per-provider concurrency cap** on sessions or runs. The only limits are:
- one blocking run per thread (later messages queue);
- per-thread FIFO outbox effects;
- 4 effect-worker fibers;
- concurrency 8 for delegated-task recovery.

### Cited Findings
- **Constants:** `DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; DEFAULT_MAX_IDLE_PIN_MS = 4 * 60 * 60 * 1000; RELEASE_SCOPE_CLOSE_TIMEOUT_MS = 30 * 1000; UNLOAD_THREAD_TIMEOUT_MS = 10 * 1000;` — [ProviderSessionManager.ts#L52-L55](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L52)
  - The timer is armed on open, on `markIdle`, and after detach. `markBusy` cancels it.
  - If `hasPendingBackgroundWork` is true and the pin is under 4 h, release is deferred one more window (`idle-release-deferred`). Past 4 h it logs `idle-release-pin-expired` and releases.
  - The background-work probe is implemented by the Claude, Codex, ACP, and OpenCode 2 adapters.
  - Source: [ProviderSessionManager.ts#L1017-L1108, L1310-L1342](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L1017)
- **Issue #13331** "Five bugs found while running the orchestrator v2 branch (#2829) day to day" (OPEN; other items are unresolved): "All Codex threads share one `codex app-server`. Disconnecting a thread detaches it in T3, but the native thread stays loaded in the app-server along with its MCP servers (e.g. one language server per thread or subagent). Over a day I measured about 80 idle processes and 9 GB." — [issue #13331](https://github.com/pingdotgg/t3code/issues/13331)
  - Fix: PR #14187 "detaching a Codex thread unloads it from the shared app-server", merged 2026-09-29 into the V2 branch, which became main via #2829. The code calls `unloadThread` with a 10 s timeout under the attach lock; Codex sends `client.request("thread/unsubscribe", {threadId})`, and OpenCode 2 also implements `unloadThread` — [PR #14187](https://github.com/pingdotgg/t3code/pull/14187); [ProviderSessionManager.ts#L2020-L2061](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L2020); [CodexAdapterV2.ts#L5642-L5656](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L5642)
- **Kill semantics per provider:**
  - **Claude:** SDK `query.close()`, no process group.
  - **Codex:** child process killed by its scope finalizer.
  - **Grok (only, via `ownDetachedProcessGroup`):** process group SIGTERM → 1 s → SIGKILL. Linux uses a cgroup-v2 lease; Windows uses `taskkill /T /F`.
  - **Other ACP agents:** `child.kill({forceKillAfter: "1 second"})`.
  - **OpenCode and Pi:** detached process groups, SIGTERM → grace → SIGKILL. Pi checks liveness before the kill to avoid hitting a reused pid.
  - Source: [R/apps/server/src/provider/acp/AcpSessionRuntime.ts#L1693-L1747](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/AcpSessionRuntime.ts#L1693); [PiRpc.ts#L200-L276](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/PiRpc.ts#L200); [R/apps/server/src/provider/opencodeRuntime.ts#L732-L748](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/opencodeRuntime.ts#L732)
  - **Orphan reaping at startup exists only for OpenCode.** `OpenCodeServerLedger.reapOrphans` verifies pid, start time, pgid, and command before signalling — [R/apps/server/src/provider/OpenCodeServerLedger.ts#L262-L325](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/OpenCodeServerLedger.ts#L262)
  - Claude, Codex, Cursor, and ACP have no orphan reaping (OPEN issue #15357, OPEN PR #15450). OPEN PR #15571: "provider sessions clean up when their start is interrupted" (`tapError` missed interrupts, so the child kept running).
- **Concurrency:**
  - `isBlockingRun` covers `preparing|starting|running|waiting` ([Orchestrator.ts#L455-L462](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L455)).
  - `DEFAULT_EFFECT_WORKER_CONCURRENCY = 4`, and run ingestion is `forkDetach`, so a running turn holds no worker slot ([EffectWorker.ts#L756](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/EffectWorker.ts#L756)).
  - Single-thread sessions refuse a second app thread: "does not support attaching multiple app threads to one session" ([ProviderSessionManager.ts#L1707-L1715](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L1707)).
  - The research subagent found no `maxConcurrent`, `maxSessions`, LRU, or eviction anywhere in V2.
- **Open lifecycle issues:**
  - #15173: a Claude session is idle-released at 30 min while its run waits on a `delegate_task` child; Stop and Settle then fail permanently.
  - #15235: the reaper kills a session whose subagent runs a background job. It cites V1 `ProviderSessionReaper` names that do not exist in V2.
  - #11805: host sleep counts as idle time.
  - Source: [issue #15173](https://github.com/pingdotgg/t3code/issues/15173)

### Inferences
- If Solenta moves Codex to a *shared* app-server, #13331 is the trap: every detached or archived thread must `thread/unsubscribe`, or per-thread MCP servers accumulate. Solenta's current private app-server per interactive turn (`codex-appserver.js`, "→ unsubscribe → kill") already sidesteps it.
- T3's idle policy is "30 min idle, but never while background work is pending, up to 4 h". That is a concrete default for Solenta's keepAlive Claude processes. The pin needs an absolute cap, and the "waiting on a delegated child" case must count as busy (#15173).
- Kill the process *group*, with SIGTERM then SIGKILL after about 1 s, for any CLI that spawns shells (Grok, OpenCode, Pi in T3). Plain `child.kill` leaves background shells orphaned. Solenta's dev-server note in `stopRun` shows the same lesson.

### Gaps
- The Effect `ChildProcessSpawner` default kill signal for Codex could not be checked, because `node_modules` is not installed in the clone.

## 8. Model / effort catalog handling and per-provider quirks

### Takeaway
`ModelSelection` is `{instanceId, model, options?: Array<{id, value}>}`, with **no typed effort field**. Effort, fast mode, thinking, and context window are provider-specific option ids, and capabilities are generic `select`/`boolean` descriptors.

Catalog sources:
- **Dynamic:** Codex (`model/list` on a short-lived app-server), Cursor (`Cursor.models.list`), Grok/ACP (session model state or config options), OpenCode (`provider.list`), Pi (`get_available_models`).
- **Static:** Claude, from a `model-manifest.json` that is bundled, refreshed hourly from `main`, and filtered by `claude --version` with per-model `minVersion`.

Every adapter except ACP returns `apply_on_next_turn` from `planSelectionTransition`. ACP rejects a model change when the session has no model config. Runtime-mode changes always restart the session. The Claude adapter still *replaces the CLI process* when its compiled query identity changes, and refuses if background work would die.

### Cited Findings
- **Schema:** `ModelSelectionWire = {instanceId, model, options?: ProviderOptionSelections}` with `options: Array<{id, value: string|boolean}>`. The legacy object form (`{effort:"max", fastMode:true}`) and the legacy `{provider, model}` shape still decode — [R/packages/contracts/src/modelSelection.ts#L16-L33](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/modelSelection.ts#L16); [R/packages/contracts/src/model.ts#L24-L66](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/model.ts#L24)
- **Manifest:** "Provider catalogs and legacy classification live in `model-manifest.json`. The bundled copy ships with every release; at runtime the service refreshes it from the same file on `main`. Preference order is remote, then the last successful on-disk copy, then the bundle." TTL is 1 h — [R/apps/server/src/provider/ModelManifest.ts#L2-L44](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/ModelManifest.ts#L2)
- **Codex catalog and turn params.**
  - Catalog: `client.request("model/list", cursor ? {cursor} : {})`. Efforts come from `supportedReasoningEfforts`, tiers from `serviceTiers`/`additionalSpeedTiers` — [R/apps/server/src/provider/Layers/CodexProvider.ts#L156-L342](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/Layers/CodexProvider.ts#L335)
  - `turn/start` carries `model`, `effort`, `serviceTier`, and always `summary: "detailed"`: "Model catalogues can default summaries to 'none'. Request them on every turn, including resumed threads" — [CodexAdapterV2.ts#L717-L771](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L717)
- **Claude.**
  - Static manifest catalog filtered by version (`resolveClaudeModelsForVersion`). `supportedModels()` is never called.
  - `[1m]` comes from the manifest `modelSuffixes`. The `effortMap` maps `ultracode→xhigh` and treats `ultrathink` as prompt-injected.
  - The SDK gets `effort`, `thinking: {type:"adaptive", display:"summarized"}`, and `settings` (`fastMode`, `alwaysThinkingEnabled`).
  - Source: [R/apps/server/src/provider/ClaudeModelCatalog.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/ClaudeModelCatalog.ts); [ClaudeAdapterV2.ts#L862-L904](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L862)
  - Context usage = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`, taken from each root assistant message's usage (not from `result`) — [ClaudeAdapterV2.ts#L141-L167](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L141)
- **ACP model setting.** `runtime.setModel` actually sends `set_config_option(modelConfigId ?? "model", model)`. `session/set_model` is used only for Grok legacy protocol v1. Unadvertised option values are skipped — [R/apps/server/src/provider/acp/AcpSessionRuntime.ts#L2776-L2794](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/AcpSessionRuntime.ts#L2776); [AcpAdapterV2.ts#L6114-L6209](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L6114)
  - Quirks: "agents advertise the union of values across models but can reject a per-model invalid one at set time (codex-acp advertises "ultra" reasoning effort and then rejects it for most models)", and "Failing the open here wedges the run in a retry loop" — [AcpAdapterV2.ts#L6170-L6194](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L6170)
- **Selection transitions.** `ProviderSelectionTransitionPlan = apply_on_next_turn | restart_session | create_with_handoff | reject{reason}`. Codex, Claude, Cursor, OpenCode 1/2, and Pi use `turnScopedSelectionTransition()`, which always returns `apply_on_next_turn`. ACP uses `acpSelectionTransition`, which rejects a model change if `!supportsModelSwitchInSession` — [ProviderSelectionTransition.ts#L13-L37](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderSelectionTransition.ts#L13)
  - Session policy: an instance, runtime-mode, or workspace change → `restart_and_resume`; a selection change → `switch_model_in_session`, or restart; an interaction-mode change → reuse ("Interaction mode is turn-scoped"); a different driver → `create_with_handoff` — [ProviderSessionTransitionPolicy.ts#L51-L94](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts#L51)
  - The Claude adapter replaces the CLI query when `compiledSelection.queryIdentity` changes. It refuses if background work runs: "Background agents and shells run inside the CLI process, so a new selection would kill them and lose their results" — [ClaudeAdapterV2.ts#L6882-L6909](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L6882)
- **Version gating** is advisory, driven by the manifest `compatibility` array:
  - Codex recommended `>=0.159.0` (broken `<0.149.0`).
  - Claude recommended `>=2.1.280` (graceful `>=2.1.111 <2.1.280`), with per-model `minVersion` (e.g. `claude-opus-5-5` needs `2.1.280`).
  - Cursor `>=2026.05.09`, Grok `>=1.0.13`, OpenCode `>=2.0.18`.
  - Hard code minimums exist only for OpenCode `1.14.19` and Pi `0.80.5`.
  - Source: [R/apps/server/src/provider/providerCompatibility.ts#L59-L100](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/providerCompatibility.ts#L59)
- **Launch commands:**
  - Codex: `["app-server", ...launchArgs]`.
  - Claude: Agent SDK `query()` with `pathToClaudeCodeExecutable`.
  - Grok: `grok agent stdio` (plus a `--permission-mode` / `--always-approve` variant).
  - OpenCode: `opencode serve --hostname --port`.
  - Pi: `pi --mode rpc [--no-session] --extension <t3 ext>`.
  - Cursor: in-process `@cursor/sdk` (`local: {cwd, autoReview, settingSources}`), with no separate binary.
  - Source: [R/apps/server/src/provider/acp/GrokAcpSupport.ts#L56-L77](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/GrokAcpSupport.ts#L56); [piT3McpInjection.ts#L272-L288](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/piT3McpInjection.ts#L272)
- **Other quirk comments worth knowing:**
  - Codex "drops client developer messages during compaction but only resends additionalContext when it changes" ([CodexAdapterV2.ts#L1587](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L1587)).
  - Omitting the approvals reviewer on resume "leaves Codex's previous reviewer sticky after switching away from Auto mode" ([CodexAdapterV2.ts#L761-L765](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L761)).
  - "Claude echoes the prompt's uuid on the turn that answers it", which T3 uses to attribute output to queued vs wake turns ([ClaudeAdapterV2.ts#L6397-L6404](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L6397)).
  - "Claude never streams subagent output" ([ClaudeAdapterV2.ts#L6086](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L6086)).
  - "Pi never emits agent events for" a command-only turn ([PiAdapterV2.ts#L1529-L1531](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts#L1529)).
  - OpenCode 2 "drops a request when the asking session's execution ends" ([OpenCode2AdapterV2.ts#L1671](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.ts#L1671)).
  - Grok ACP accepts images despite advertising `image:false` ([GrokAdapterV2.ts#L252-L254](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.ts#L252)).

### Inferences
- A generic `options: [{id, value}]` list plus per-model capability descriptors is how T3 avoids encoding every provider's effort ladder in the core schema. Solenta's `efforts` arrays (per provider, overridable per model) are close. The `effortVia: "config"` escape hatch for kimi is the same idea as T3's per-provider option compile step.
- The remote-refreshable manifest (bundled → last good on disk → remote `main`, 1 h TTL) is a cheap way for Solenta to ship model-list fixes without a release. Solenta's `providers.js` comments show model lists are currently hand-copied from live CLIs.
- T3's Codex adapter always sends `summary:"detailed"` and an explicit approvals reviewer on every `turn/start`, because both are sticky or defaulted on resume. Solenta's interactive Codex path should check the same two params.

### Gaps
- T3 never calls the Claude SDK's `supportedModels()`, so there is no T3 evidence on whether dynamic Claude model discovery is reliable.
- The `model-manifest.json` contents were only sampled (Claude entries and the compatibility array), not read in full.
