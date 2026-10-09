# Agent-facing orchestration surface: T3 Code Orchestrator V2 vs Solenta coder-threads, with live-store evidence

**Snapshots and how sources are cited**
- **T3 Code:** `pingdotgg/t3code` main at `eac52f0087d9ba5dee5542f24788d1482affae43`. I ran `git fetch origin main` on 2026-10-04 and **main has not moved**. T3 links use the base `https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/`.
- **Solenta:** checkout `fae77a0b…` at `615b38a0` ("coder-checkpoint: turn 71"). Solenta sources are cited as repo-relative paths with line numbers, e.g. `[orchServer.js L45-L130](electron/orchServer.js#L45)`.
- **[LS] = live-store analysis.** This is a read-only APFS clone of the live store, made 2026-10-04:
  - files: `coder-store.json` (mtime 12:44 CEST), `messages/` (2,044 files, 779 MB) and `worklogs/`;
  - it was analysed with node scripts in `/tmp` and then deleted;
  - the live files were never written.
- **Store coverage:**
  - 2,044 threads in 12 projects. By provider: grok 943, claude 555, cursor 334, codex 109, kimi 103.
  - Tool-call records span 2026-08-13 20:58Z → 2026-10-04 10:33Z.
  - 224,228 tool messages in total. **10,498 are coder-threads calls**, made by 1,310 threads (4.7% of all tool calls).
- **How each provider records an MCP call in the transcripts:**
  - Claude/Kimi: `mcp__coder-threads__<tool>`
  - Codex (and some Claude): `coder-threads/<tool>`
  - Grok: `use_tool {tool_name:"coder-threads__<tool>"}`
  - Cursor: `Mcp {name:"coder-threads-<tool>"}`
  - All four were normalised before counting.
- **Caveat:** transcripts store tool input and output truncated at about 2–4k chars. Output sizes and long `thread_fork` arguments (e.g. `title`, which comes after `prompt`) therefore cannot be measured reliably.

---

## 1. What T3 Code V2 tells agents: tool list, schemas, descriptions, injected instructions, errors, async steering, roles, token cost

### Takeaway
- T3 exposes one MCP server, `t3-code`, with **72 tools (~20.8k chars of descriptions)**. It authenticates each provider session with a per-session bearer token, so **agents never pass their own thread or project ids**.
- T3 injects a single **4.1k-char orchestration block** (plus a 1.05k-char PR-linking block) **once per session**, through the provider's system or developer channel.
- **Async is the default, and polling is explicitly discouraged.** Descriptions say "end the turn instead of polling or spawning watchers". Wakes carry only a pointer; reading the task acknowledges the wake.
- **Failures are typed** (`{_tag:"OrchestratorMcpFailure", code, message}`, 14 codes). **Roles are cosmetic:** a prompt prefix only.

### Cited Findings

**Orchestrator toolkit: tool names and full descriptions (verbatim)** — [orchestrator/tools.ts L45-L256](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/toolkits/orchestrator/tools.ts#L45-L256)
- `orchestrator_capabilities`: "List the V2 provider instances and their current models from the same live catalog as the composer, including configured custom models, inherited runtime settings, and app-owned orchestration features available to this T3 thread. For a separate top-level thread in a new or existing worktree, use t3_thread_launch with workspaceStrategy." (Readonly, Idempotent)
- `delegate_task`: "Delegate one task to a T3-owned child agent/subagent of THIS thread and run it with only the supplied task prompt, without copying parent conversation history. Choose providers and models from orchestrator_capabilities, which uses the same live catalog as the composer. Prefer native subagent tools for same-provider work only when they support the chosen model. Use this for any model missing from the native tool, including same-provider work, for cross-provider work, or for explicitly T3-owned child tasks. For every T3 delegated review round, call delegate_task again with the original brief, prior findings, responses, and unresolved objections in the task prompt. Track each round by its own taskId and use a distinct clientRequestId per round, stable across retries of that round. The childThreadId is backing storage, not the target for starting another delegated review round through t3_thread_send. Provider, model, model options (see orchestrator_capabilities), runtime mode, and interaction mode inherit unless target overrides them. Prefer mode='async' for long work; mode='wait' blocks until completion or timeout. timeoutMs on mode=wait is only the parent's wait budget and does not cancel the child. waitTimedOut on that wait call means the timeout fired; keep that taskId and read status on later task_status. **An async child's completion wakes this thread through a notification, steered into active turns where supported or queued otherwise, so end the turn instead of polling or spawning watchers; use task_status only when the result is needed mid-turn.**" (Destructive, OpenWorld; 1,574 chars, the longest T3 description)
- `task_status`: "Read a T3-owned delegated task created by this parent thread. childRunId identifies the original delegated run. workState distinguishes working, waiting_for_children, and result_available; a completed turn with live nested work is not a completed task. summary is the final task result, including provider errors on failure, and remains stable after publication. hasPendingChildRuns reports later queued or executing turns in the backing child thread, even after the task is terminal; it does not reopen the task or extend task_cancel to those turns. latestTerminal* provides later non-monitor turn results. **Reading a terminal result acknowledges its automatic parent delivery.**"
- `task_cancel`: "Request interruption of an active T3-owned delegated task and dispose its automatic parent delivery. For a terminal task, return its existing status and dispose delivery without interrupting later child-thread runs, even when task_status reports hasPendingChildRuns=true. Published task results remain available. Use t3_thread_interrupt for a later active run."
- `schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task`: a recurring scheduler. "Pass schedule as a STRUCTURED OBJECT, never JSON text… Report the returned schedule and nextRunAt after success."
- `create_threads`: "Create one or more ORDINARY TOP-LEVEL T3 conversations. This is not delegation and does not create child agents/subagents… Both require the user to request separate/new/top-level threads or conversations…"
- `t3_thread_list`: "List T3 threads in the calling thread's project, newest first. Filter by durable run status, title, or settled state … and paginate with the returned cursor. Threads from other projects are never exposed."
- `t3_thread_read`: "Read durable state and a paginated timeline from a T3 thread in the calling project… The default messages view returns user messages, assistant messages, and proposed plans; activity returns all summarized timeline items. Reading an untruncated terminal assistant result from this parent thread's direct app-owned child acknowledges that child's automatic completion delivery. Continue with afterPosition=nextPosition. Recover long item text with itemId and textOffset=nextTextOffset until nextTextOffset is null…"
- `t3_thread_update`: rename, regenerate_title, link or unlink a PR. "clientRequestId makes retries idempotent."
- `t3_thread_send`: "Send a message to a T3 thread in the calling project. Do not use a delegated task's childThreadId to start another review round here… **mode='auto' starts an idle thread, steers a fully active turn, or queues behind a turn that is not yet steerable. Use queue for a separate follow-up turn, steer for an in-flight update, or restart to interrupt-and-restart the active turn.** clientRequestId makes retries idempotent."
- `t3_thread_wait`: "Wait for a T3 thread run to reach a terminal durable state. Without runId, the latest run at call time is selected; an idle thread returns immediately. Timeout does not interrupt work, so call again or use t3_thread_read/list after timedOut=true. Waiting reports status only and does not acknowledge a delegated result."
- `t3_thread_interrupt`: "Request interruption of a running turn… Without runId, the newest interruptible run is selected. Terminal runs and threads without an active turn return without another side effect."

**Key input and output schemas** — [orchestratorMcp.ts L40-L48, L139-L240, L320-L460](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestratorMcp.ts#L139-L240)
- `delegate_task` input:
  - `task` (≤120k chars; "Self-contained task for one delegated child agent/subagent.")
  - `target?{providerInstanceId, driverKind, model, options}`
  - `title?`, `role?`
  - `mode?: "async"|"wait"` ("Defaults to async. Use wait only when this turn needs the child's result before you can continue.")
  - `timeoutMs?` ("Wait budget for mode=wait only. Default 10 minutes…")
  - `clientRequestId?` ("Stable idempotency key to reuse when retrying this mutation.")
  - `runtimeMode?`, `interactionMode?`
- `delegate_task` and `task_status` result fields:
  - ids: `{taskId, childThreadId, childRunId, childNodeId}`
  - state: `status: queued|running|waiting|completed|failed|cancelled|interrupted`, `workState`, `hasPendingChildRuns`
  - results: `summary`, `latestTerminal{RunId,Status,Summary,ResultContextTransferId}`
  - target: `providerInstanceId`, `model`
  - `waitTimedOut`
- `t3_thread_list` input: `{statuses?, titleContains?, settled?, includeSubagents?, cursor?, limit≤100}`. Result: `{projectId, currentThreadId, threads[], nextCursor, total}`.
- `t3_thread_read` input: `{threadId, itemId?, textOffset?, view?: messages|activity, afterPosition?, limit≤100, runLimit≤50, maxCharsPerItem≤50k}`.
- `t3_thread_send` input: `{threadId, message, mode?: auto|queue|steer|restart, clientRequestId?}`. Result: `delivery: started|queued|steered|restarted`.
- `t3_thread_wait`: `{threadId, runId?, timeoutMs?}` → `{status, timedOut}`.
- `t3_thread_interrupt`: `{threadId, runId?, reason?, clientRequestId?}` → `interrupt_requested|no_active_run|<terminal>`.

**Other toolkits** (all on the same server)
- **Launch** — `t3_thread_launch` ("Create an ordinary TOP-LEVEL thread with an explicit workspace binding before its agent starts… Omitted workspaceStrategy means the project root, NOT the caller's worktree… Do not ask the agent to create its own worktree via shell: that does not update the thread binding. Each call creates a new launch with no retry key; retain threadId and use t3_thread_read/t3_thread_wait to follow preparation. After errors or lost responses, inspect t3_thread_list before retrying…") — [project/tools.ts L102-L148](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/toolkits/project/tools.ts#L102-L148)
- **Worktrees** — `t3_worktree_handoff` ("…Changing the workspace detaches the live provider session… call this as the last action of the turn. To keep working after the handoff, pass continuationPrompt…"), `t3_worktree_status`, `t3_worktree_list` — [worktree/tools.ts L24-L83](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/toolkits/worktree/tools.ts#L24-L83)
- **Pull requests** — [pullRequests/tools.ts L22-L23, L220-L293](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/toolkits/pullRequests/tools.ts#L220-L293)
  - `watch_pull_request`: "Have T3 Code watch an open pull request for this thread… T3 Code checks it every minute and wakes you with a message when a check fails, the required checks pass, someone else comments or reviews, or the branch starts to conflict with its base. **Use this to monitor or babysit a pull request instead of polling, sleeping, or running a watcher.** Only comments posted after this call wake you, so handle the existing ones first, then end your turn. **A wake is news, not a merge decision: check readiness yourself before merging.**…"
  - Also: `link_pull_request`, `unlink_pull_request`, `list_thread_pull_requests`, `unwatch_pull_request`.
- **Thread toolkit** (17 tools) — [thread/tools.ts L30-L279](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/toolkits/thread/tools.ts#L30-L279)
  - `t3_thread_organize` (pin/snooze/settle/archive/mark_unread)
  - `t3_queue_list|read|edit|cancel|reorder|promote_to_steer`
  - `t3_pending_request_list|read|respond` ("This cannot approve a permission request.")
  - `t3_thread_configuration|configure`, `t3_thread_fork`, `t3_thread_merge_back`, `t3_thread_transfers`, `t3_thread_search`, `run_scheduled_task_now`
- **Not orchestration:** `preview_*` (14), `device_*` (4), `t3_project_*` (6), attachments (3), environment (2).

**Injected instructions** — [T3OrchestrationInstructions.ts L3-L31, L57-L106](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/T3OrchestrationInstructions.ts#L3-L106)
- The full `T3_CODE_ORCHESTRATION_INSTRUCTIONS` (4,105 chars) contains these paragraphs:
  1. A concept split: a delegated task/subagent is child work owned by the current thread; use `orchestrator_capabilities` → `delegate_task`; "Retain each returned `taskId`, and use `task_status` or `task_cancel` to manage it. The returned `childThreadId` is backing storage…"
  2. "`t3_thread_launch` and `create_threads` create ordinary top-level T3 conversations. Use them only when the user explicitly asks for separate/new/top-level threads or conversations. Never use them merely because the user said "subagent" or requested parallel delegated work."
  3. Review rounds: re-delegate with the full brief and a new clientRequestId.
  4. `schedule_task` structured schedule.
  5. "Choose the workspace before starting a new thread": a worked JSON example for each `workspaceStrategy`; "Asking an agent to run `git worktree add` or `cd` in its prompt does not update T3's thread binding."
  6. "`t3_thread_launch` has no idempotency key… inspect `t3_thread_list` before retrying."
  7. "Tool names may include a harness-normalized MCP prefix, such as `mcp__t3_code__delegate_task`… if an initial tool-catalog scan does not show T3 tools, do not conclude that cross-provider delegation is unavailable. Make one bounded direct attempt… **Keep polling/wait loops bounded, do not duplicate active work, and use stable `clientRequestId` values when retrying**."
  8. An ACP terminal fallback (`acp-mcp-call`).
- Separate blocks:
  - a browser block, `T3_CODE_BROWSER_TOOL_INSTRUCTIONS`: "first call `preview_status`. If no automation-capable preview is attached, call `preview_open` before concluding that the browser is unavailable"
  - interaction-mode blocks for ACP: Default and Plan
  - a PR-linking block (1,052 chars), which ends: "When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn… so do not poll or run your own watcher." — [RuntimeInstructions.ts L1-L28](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/RuntimeInstructions.ts#L1-L28)

**Injection channel, per provider — the text is sent once, not per turn**
- **Claude:** `systemPrompt: {type:"preset", preset:"claude_code", append: buildRuntimeInstructions(...) + T3_CODE_ORCHESTRATION_INSTRUCTIONS}` — [ClaudeAdapterV2.ts L907-L913](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L907-L913)
- **Codex:** `turn/start.additionalContext` keys `t3_code_orchestration`, `t3_code_runtime` and `t3_code_tools`. "Codex renders each entry as a `<key>value</key>` developer message and resends it only when the value changes". This is deliberately kept out of `developer_instructions`, because models with their own mode text drop the client's `developer_instructions` — [CodexDeveloperInstructions.ts L191-L225](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/CodexDeveloperInstructions.ts#L191-L225)
- **OpenCode:** `t3OrchestrationSystemPrompt` — [OpenCodeAdapterV2.ts L973](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/OpenCodeAdapterV2.ts#L973)
- **Cursor:** first run only, wrapped in `<t3_code_orchestration_instructions>` — [CursorAdapterV2.ts L2107](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/CursorAdapterV2.ts#L2107)
- **ACP/Grok:** in `<t3_code_instructions>` only "on the first user prompt and whenever the available tools or interaction mode change" (`T3OrchestrationInstructions.ts` L57-L83)
- **Pi:** via an extension — [piT3McpExtensionSource.ts L32](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/piT3McpExtensionSource.ts#L32)

**Roles**
- `role` is one of `"implementation"|"research"|"review"|"design"|"test"|"general"`. It has no schema description — [orchestratorMcp.ts L139-L146](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestratorMcp.ts#L139-L146)
- Its only effect: any role except general prepends `Act as the ${role} sub-agent for this task.\n\n` to the task — [OrchestratorMcpService.ts L556-L560](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/OrchestratorMcpService.ts#L556-L560)
- No other use of `role` exists in the service. Tools, privileges and model are unaffected (grep of `OrchestratorMcpService.ts`).

**Errors**
- `OrchestratorMcpFailure` codes:
  - access and lifecycle: `capability_denied`, `parent_not_active`
  - provider/model selection: `provider_unavailable`, `model_unavailable`
  - privilege ceiling: `runtime_mode_escalation_denied`, `interaction_mode_escalation_denied`
  - lookups and state: `task_not_found`, `task_not_cancellable`, `thread_not_found`, `run_not_found`, `thread_not_sendable`, `thread_not_interruptible`
  - generic: `invalid_request`, `orchestration_error`
  - Source: [orchestratorMcp.ts L568-L589](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestratorMcp.ts#L568-L589)
- Messages are short and factual, e.g.:
  - "Delegated tasks require an active run owned by this MCP provider session."
  - "Model ${requestedModel} is not advertised by provider ${instanceId}."
  - "Child runtime mode ${resolved} is broader than parent mode ${parentMode}."
  - Source: [OrchestratorMcpService.ts L452-L470, L976-L978, L1381-L1384](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/OrchestratorMcpService.ts#L1381-L1384)
- With `failureMode:"return"`, failures come back as `structuredContent {_tag:"OrchestratorMcpFailure", code, message}`. Tests assert this shape — [OrchestratorMcpToolkit.integration.test.ts L1310-L1318, L2337-L2353](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts#L2337-L2353)
- Effect's McpServer encodes handler results with `isError:false` plus structuredContent and JSON text. Only thrown or undeclared errors become `isError:true` — [effect-smol McpServer.ts L1513-L1600](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/.repos/effect-smol/packages/effect/src/unstable/ai/McpServer.ts#L1513-L1600)
- A foreign-project thread returns `thread_not_found` and does not say which project owns it (test L2325-L2353).

**Async steering**
- The wake text is a pointer only: "Delegated task ${id} reached a terminal state. Use task_status with taskId ${id} to read the result."
- Reading acknowledges the result and cancels a queued wake.
- Both are traced in the prior note: `research_notes/T3 Code orchestrator deep dive/t3_delegation_and_wake.md` §2. Source: [Orchestrator.ts L504-L509](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L504-L509)

**Token cost (measured from source with node; chars/4)**
- **Orchestration block:** 4,105 chars (~1.0k tok).
- **PR linking plus runtime info:** ~1.3k chars (~0.33k tok).
- **Tool descriptions:** 72 tools, 20,772 chars (~5.2k tok), excluding JSON-schema field annotations. Largest: `delegate_task` 1,574, `t3_thread_launch` 1,220, `create_threads` 890, `t3_worktree_handoff` 866, `preview_snapshot` 706, `watch_pull_request` 688.
- **No per-turn notes.**
- Source: [orchestrator/tools.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/toolkits/orchestrator/tools.ts) and the sibling `toolkits/*/tools.ts`.

### Inferences
- T3's descriptions spend their words on **semantics an agent would get wrong**:
  - idempotency keys;
  - "childThreadId is backing storage";
  - wait timeout does not cancel;
  - "a completed turn with live nested work is not a completed task";
  - reading acknowledges.
- They spend almost nothing on **identity or scoping boilerplate**, because the bearer token carries the scope.
- **The anti-polling stance is repeated at every place an agent might poll:** `delegate_task`, the PR-linking block, `watch_pull_request`, and "Keep polling/wait loops bounded". It is always paired with "end your turn" and the promise of a wake.
- **Roles add nothing beyond a one-line persona prefix.** Copying the enum into Solenta would add schema surface without behaviour.

### Gaps
- I did not measure the JSON-schema token cost of T3's tool catalog (field annotations, unions).
- I did not verify how each harness surfaces MCP server-level `instructions` (T3 does not use MCP `instructions`; it uses system/developer channels).

---

## 2. What Solenta tells agents: INSTRUCTIONS, tool descriptions, bracketed notes, cost, contradictions and stale lines

### Takeaway
- **Session-level surface:** about **5.96k chars of MCP `instructions`** plus **11.7k chars of descriptions across 28 tools** (23 tools without a GitHub origin). That is ~4.4k tok, about the same as T3's per-session cost.
- **Per-turn surface:** Solenta also appends **bracketed notes to every dispatched prompt**, so they accumulate in resumed CLI sessions:
  - ~2.2k chars (~0.55k tok) of fixed notes on a GitHub-origin worktree thread;
  - plus a hypothesis note of median 1.4k / p90 4k chars on 566 threads;
  - plus a code map of up to ~3.7k chars;
  - plus a hand-off digest of up to 12k chars on a worker's first turn.
- **Several lines are false or stale.** Most important: "thread_status has full details", when it returns only the first line of the last reply.

### Cited Findings

**INSTRUCTIONS** (verbatim source at [orchServer.js L45-L130](electron/orchServer.js#L45); 5,957 chars ≈ 1,490 tok). Size by topic, measured:

| Topic | Chars |
|---|---|
| landing/approval ("A worker's commits live ONLY on its own branch… WORKERS BUILD; YOU ASK… Asking on the machine-delivered turn that woke you IS the job…") | 1,052 |
| thread_send/status/wake/stall | 953 |
| preview | 438 |
| Planboard issue tools | 432 |
| fork + digest + worktree | 396 |
| ask_user | 348 |
| threads_list/guards | 349 |
| spec/teach | 323 |
| refresh_worker_snapshot | 311 |
| crew tasks + peer | 303 |
| branch:path hand-off | 300 |
| ids/project scope | 281 |
| pool | 181 |
| work_suggest | 153 |
| hypothesis | 137 |

**The wake/stall passage** (verbatim, L89-L101): "thread_send delivers a prompt… returns an outcome: delivered (started a turn), queued (held until that thread is idle), refused (the receiver's inbound policy is refuse), or undeliverable (archived, unattended/scheduled, unknown)… Mid-run sends are held, not injected. thread_status reports a thread's status and the first line of its last assistant reply. Runs are asynchronous: send work, then continue. When a worker you forked finishes (done or failed) you are woken on a new turn with a notice; do not sit idle waiting for the user to relay that. **thread_status still has full details if you need them before the wake-up.** A worker can also stall on a permission prompt only the user can answer: that sends no notice and stays "working", so **if one goes quiet check thread_status for awaitingInput** and tell the user what it is waiting on." — [orchServer.js L89-L101](electron/orchServer.js#L89)

**Tool descriptions** (28 tools, 11,707 chars ≈ 2,930 tok; 10,289 chars without the 5 Planboard tools) — [orchServer.js L1227-L1828](electron/orchServer.js#L1227)
- **Sizes:**
  - Over 1,000 chars: `thread_merge` 1,675 and `thread_fork` 1,079.
  - 400–700 chars: `thread_pr` 671, `ask_user` 599, `refresh_worker_snapshot` 590, `thread_send` 480, `thread_archive` 424.
  - Everything else is 212–396 chars.
- The phrase "projectId is YOUR OWN project id (stated at the end of your prompt); the thread must belong to it" (≈105 chars) appears **17 times** (grep count). 21 tools require `threadId` plus `projectId` that name the caller itself.
- **`thread_status` description:** "…lastAssistantText (first line of the last assistant message, null when none), lastError…, awaitingInput (true when the run is stalled on a permission prompt only the user can answer) and awaitingPermission…" — [orchServer.js L1442-L1452](electron/orchServer.js#L1442)
  - The handler confirms first-line-only: `String(m.text).split(/\r?\n/)[0]` — [orchServer.js L779-L793](electron/orchServer.js#L779)
- **`ask_user`:** "…Each question needs 2-4 labelled options… put the option you recommend first with "(Recommended)"… This call RETURNS IMMEDIATELY and does not wait: finish your turn right after it, without guessing an answer and without polling…" — [orchServer.js L1454-L1491](electron/orchServer.js#L1454)
- **`threads_list` input:** only `{projectId?}`. No filter, limit or pagination. The handler returns every non-trashed thread of the project — [orchServer.js L390-L417](electron/orchServer.js#L390); [L1227-L1240](electron/orchServer.js#L1227)

**Error shape**
- Handlers `throw new Error(...)`, which the MCP SDK returns as `isError` text. Successes are `JSON.stringify(value, null, 2)` text with no structuredContent — [orchServer.js L157-L159](electron/orchServer.js#L157)
- Refusals carry recovery hints:
  - **Project guard:** "Thread X belongs to "A" (projectId …), not to "B" … Use your own projectId and a threadId from threads_list with that same projectId." — [L336-L351](electron/orchServer.js#L336)
  - **Approval gate:** "…is the user's decision, not yours. Report what worker … built… then ask whether to merge it, open a pull request (thread_pr), or leave the branch alone, and call this again with approved:true in the turn their answer starts… This turn was machine-delivered (nobody has answered yet), so approved:true is not true here however you set it." — [L510-L526](electron/orchServer.js#L510)
- Codes appear only as ad-hoc prefixes (`MERGE_CONFLICT:`, `CI_WORKFLOW:`).

**Bracketed notes appended to every dispatched prompt** (order at [runner.js L8600-L8631](electron/runner.js#L8600); all "CLI-only, never stored in the transcript")

| Note | Chars | Source | Condition |
|---|---|---|---|
| `[Planboard]` | 676 | [services.js L971-L982](electron/services.js#L971) | GitHub origin only |
| `[Thread]` | ~380 (with ids and path) | [services.js L1046-L1063](electron/services.js#L1046) | "the only channel by which an agent learns its own id… Rides every dispatch rather than only the first turn: context compaction and resumed sessions would otherwise lose it" |
| `[Suggested work]` | 491 | [services.js L1072-L1082](electron/services.js#L1072) | coder-threads registered |
| `[Worker pool]` | 159 (current settings, 1 pool entry; grows per entry) | [subagentPool.js L225-L262](electron/subagentPool.js#L225) | |
| `[Hypotheses]` (invalidated entries only, 5 hops, ≤10 lines) | **p50 1,398 / p90 ~4,000 / max 4,843**; present on 566 threads [LS] | [services.js L848-L849, L1100-L1140](electron/services.js#L1100) | |
| `[Review itinerary]` | ~474 | [reviewItinerary.js L43-L65](electron/reviewItinerary.js#L43) | worktree threads |
| `[Code map]` | ≤3,500 plus header | [services.js L3830-L3880](electron/services.js#L3830) | |
| `[Crew task]` | variable | [services.js L3047](electron/services.js#L3047) | |
| `[Computer use]` | 461 | [services.js L984-L996](electron/services.js#L984) | Codex only |
| `[Spec mode]` / `[Teach mode]` / `[Ask mode]` | — | — | mode-gated |
| Hand-off digest (worker first turn) | ≤12 msgs × 2,000 chars, ≤12,000 total | [services.js L961-L963, L1209-L1260](electron/services.js#L1209) | |
| Memory bootstrap | — | [ask.js L126-L142](electron/ask.js#L126) | first turn only |

**Worker-finished notice** — [runner.js L1302-L1351](electron/runner.js#L1302)
- Text: `Worker thread <id> ("<title>") finished with status <s>. Last reply: <first line>`.
- Plus a merge paragraph of ~430 chars: "…check it, then tell the user what it built and ask whether to merge it (thread_merge) or open a pull request (thread_pr)… Do not land it before they answer — not even onto your own branch…"
- Plus the tail: **"Continue orchestrating; thread_status has full details."**

**History of the relevant lines** (`git log -S`)
- "Continue orchestrating; thread_status has full details" — 2026-08-14 (259475a0)
- "A worker can also stall on a permission prompt" — 2026-08-15 (19430c20)
- `isAutoTurn` gate — 2026-08-20 (862812a2)
- `expectedBranch` — 2026-09-10 (f6c9323a)
- `title` on `thread_fork` — 2026-09-26 (#1355)
- Sidebar fix #1421 (b149eba3, 2026-10-03): "A family sits on the Working shelf while any member is quietly working, unless a member needs the user". The sidebar now surfaces a stalled worker family member.

### Inferences
**Contradictions and stale lines**
1. **False promise.** "thread_status still has full details" (INSTRUCTIONS) and "thread_status has full details" (every notice) are wrong. `thread_status` returns the same first line the notice already carries, plus status, error and awaitingInput. Section 3 shows this sends leads into a useless status call on 164 notice turns.
2. **Stale stall advice.** The awaitingInput advice ("if one goes quiet check thread_status") invites polling. Since #1421 the sidebar shows a family member that needs the user. In the data, the advice paid off in 15 of 1,267 status results.
3. **Wrong outcome list.** The `thread_send` outcome list in INSTRUCTIONS says undeliverable covers "unknown". The handler actually throws `Unknown thread` ([orchServer.js L689-L700](electron/orchServer.js#L689)), and the tool description omits "unknown".
4. **Digest wording is accurate.** "Mid-run sends are held, not injected" matches the code. The digest claim is also accurate: a worker does get a truncated tail digest of up to 12k chars.
5. **Landing rules said four times.** They appear in INSTRUCTIONS, `thread_merge`, `thread_pr` and the notice, totalling ~3.8k chars. A host gate also enforces them.

**Cost relative to T3**
- Per session, Solenta is roughly comparable: ~4.4k tok versus T3's ~1.35k tok of instructions plus ~5.2k tok of (larger) catalog.
- But Solenta adds ~0.55–1.8k tok **per turn** of notes, and these are re-appended every dispatch.
- T3 sends its instructions once per session. Codex re-sends only on change.

### Gaps
- I did not verify whether every harness (Grok, Cursor, Kimi) surfaces MCP server `instructions` to the model at all. If one does not, INSTRUCTIONS has zero effect there and the notes are the only steering.
- The code-map note size per project was not measured from live data; only the cap was read.

---

## 3. Live-store evidence: how agents actually use and misuse coder-threads

### Takeaway
1. **Gated landing works.** Approval refusals are rare (17 in 267 merge/PR calls), and 73% of successful merges follow an `ask_user` answer.
2. **Wrong ids are rare** (≈11 in 10,498 calls).
3. **Polling is real but declining:**
   - 52% of `thread_status` calls sit in runs with ≥3 status calls;
   - 387 are repeat checks of a still-working worker;
   - shell `sleep` loops occur;
   - the worst period was 2026-09-01..14, at 9.3 status calls per fork.
4. **The biggest current misuses:**
   - a useless `thread_status` right after a notice (164 turns);
   - `threads_list` overflowing Claude's tool-output cap (34 of 285 calls);
   - **`preview` has never once succeeded** (47 of 47 failed, "pane not open");
   - `spec_submit` called outside spec mode (13 of 14).

### Cited Findings

**Volume by tool** (calls / error results / distinct calling threads) [LS]

| Tool | Calls | Errors | Threads |
|---|---|---|---|
| hypothesis_record | 2,427 | 8 | 910 |
| thread_status | 1,267 | 10 | 249 |
| work_suggest | 958 | 1 | 746 |
| issue_set_plan | 888 | 2 | 357 |
| issue_create | 774 | 0 | 285 |
| issue_list | 658 | 2 | 453 |
| issue_comment | 656 | 5 | 191 |
| issue_complete | 579 | 0 | 339 |
| ask_user | 483 | 1 | 201 |
| thread_send | 341 | 5 | 82 |
| thread_fork | 299 | 4 | 104 |
| threads_list | 285 | 34 | 204 |
| thread_merge | 214 | 58 | 104 |
| peer_send | 191 | 3 | 54 |
| task_list | 90 | 0 | 63 |
| task_claim | 69 | 0 | 27 |
| task_complete | 66 | 1 | 25 |
| thread_pr | 53 | 23 | 23 |
| preview | 47 | 47 | 30 |
| thread_archive | 35 | 0 | 30 |
| thread_settle | 35 | 2 | 3 |
| task_add | 29 | 2 | 12 |
| thread_rename | 23 | 0 | 21 |
| spec_submit | 14 | 10 | 13 |
| thread_stop | 6 | 4 | 5 |
| task_release | 5 | 0 | 3 |
| refresh_worker_snapshot | 1 | 0 | 1 |
| teach_review | 0 | — | — |

- Calls to non-existent names: `issue_update` 1, `memory_store` 1, `list_mcp_resources` 2, `list_mcp_resource_templates` 1.
- **Tool-discovery overhead** (lazy MCP tool loading, counting calls whose query names coder-threads or its tools):
  - grok `search_tool`: 2,191
  - cursor `GetMcpTools`: 759 (plus 130 `search_tool`)
  - claude `ToolSearch`, e.g. `select:mcp__coder-threads__thread_fork,…`: 416
  - In these harnesses the tool descriptions load on demand, but INSTRUCTIONS and notes do not.

**Error results by cause** (227 total) [LS]
- **Host gates working as designed:**
  - PR size cap (`PR too large: N lines… (cap N)`): 19
  - merge conflicts (`MERGE_CONFLICT:`): 24
  - approval refusals: 16 merge + 1 PR + 4 stop. **All 16 merge refusals were on machine-delivered turns.**
  - local main behind origin: 6; CI_WORKFLOW sign-off: 3; secret guardrail: 2; dirty checkout: 2; still running: 2; "not one of your workers": 2; settle while running: 2; destination mismatch: 1
- **UI precondition never met:** `preview` "Browser pane is not open on this thread. Open Views → Browser, then retry." This was **47 of 47 calls** (45 runs, 30 threads, 2026-08-26 → 10-04). 31 started with `info` and 16 with `navigate`. Zero successful preview calls exist in the store.
- **Output overflow:** `threads_list` "Error: result (N characters…) exceeds maximum allowed tokens. Output has been saved to …" — **34 of 285 calls (12%)** (Claude's MCP output cap).
- **Mode mismatch:** `spec_submit` "Thread is not in spec mode" 9, plus 1 auto-mode block. **13 of 14 `spec_submit` callers were not spec threads** (grok and cursor). Only 2 threads in the store have `spec`, and 1 has `teach`.
- **Wrong or invalid ids (~11):**
  - `Unknown thread` on `thread_status` ×6, including truncated or `????` ids
  - `hypothesis_record` ×2: `PLACEHOLDER`, and a provider session id passed as threadId
  - `thread_merge` ×1, `peer_send` ×1
  - one cross-project refusal on `thread_status`
- **Schema validation (13):** missing `body` or `number` (issue_comment ×4), `threadId` (issue_list ×2), `status` (issue_set_plan ×2), `toThreadId`/`threadId` (peer_send ×2), fewer than 2 options (ask_user ×1), an empty call (hypothesis_record ×1), and an unknown `needs` id (task_add ×1).
- **Harness or transport:**
  - Codex "MCP tool call requires approval, but approval policy is never": 6 (fork ×4)
  - Grok "Tool not found: coder-threads__thread_status"/`work_suggest`: 3
  - user-cancelled: 3; socket reset: 2

**Ids and project scoping** [LS]
- Self-scoped tools: in 7,888 calls with parsed input, `threadId` differed from the caller only **10 times (0.13%)**.
- `projectId` differed from the caller's project 13 times in 8,552 checks:
  - 6 from one Cursor agent inventing a UUID;
  - 5 Grok `threads_list` calls passing a path or project name.
- All 13 still **succeeded**, because the session's bound `?projectId=` silently wins ([orchServer.js L336-L339](electron/orchServer.js#L336); binding at [memory-sup.js L699](electron/memory-sup.js#L699)).
- `projectId` was omitted 40 times, 32 of them on `threads_list`.

**Polling** [LS]
- `thread_status`: 1,267 calls in 588 runs. Calls per run: p50 1, p90 3, p99 27, max **49 (one Grok lead, 27 min)**. 84 runs have ≥3 calls and hold 657 calls (52%). 18 runs have ≥10.
- Results: 841 "working", 374 "done". **387 calls re-checked a target already seen "working" in the same run.**
- Shell sleep:
  - 7 of the 84 polling runs used shell sleep (56 calls, e.g. `sleep 180/240/300; echo woke`);
  - across 780 lead runs, 26 used `sleep` (80 calls).
- Trend in `thread_status` calls per `thread_fork`:
  - before 08-21: 1.7 (264/158)
  - 09-01..09-14: **9.3** (859/92; 56 polling runs)
  - 09-25..10-04: **1.6** (70/43; 4 polling runs)
- `awaitingInput:true` appeared in 15 results.

**Worker-finished notice turns** [LS]
- Scope: 104 lead threads forked; 447 runs were started by notices (544 finish lines).
- **The first coder-threads call after a notice was `thread_status` in 222 runs.** In 164 runs it targeted the very worker named in the notice, and got back the same first line.
- Other behaviour on notice turns:
  - `ask_user` on 101 notice turns;
  - `thread_merge` on 4 (3 refused as machine-delivered);
  - `thread_fork` on 25;
  - no coder-threads call at all on 165.
- Shell activity in notice runs: `git diff` 263, `git log` 220, `git show` 183. Leads also read Solenta's own `messages/<worker>.json` 9 times (66 store-file reads in 17 lead threads). **Leads reconstruct worker results from git and raw files, because no read tool exists.**
- **Raw `git merge` of worker branches on notice turns:** 132 commands. **126 predate the approval gate** (2026-08-20). Only 6 come after, all in 3 threads where the user had asked to merge.

**Landing** [LS]
- `thread_merge`:
  - 214 calls; **152 merged** (152 distinct workers);
  - 200 passed `approved:true`;
  - 38 passed `expectedPath` (required since 09-10).
- After an approval refusal, 12 of 17 asked via `ask_user` in the same run, and 0 retried successfully in that run.
- **Of 139 runs with a successful merge, 101 (73%) were started by an `ask_user` answer** ("Answering your question:…"); 38 by other user turns.
- `thread_pr`:
  - 53 calls, 21 PRs opened;
  - 19 hit the size cap;
  - `allowOversize` was passed 18 times. It was retried without a user turn once, and in a later run 8 times.
- Workers (`orchWorker`): 496 total; 480 done; 495 archived; 24 still hold a worktree. 147 were landed by lead `thread_merge` and 20 via `thread_pr`.

**ask_user** [LS]
- 483 calls in 201 threads.
- **397 (82%) were the last tool call of the run**, as instructed to end the turn. 75 were followed by 1–2 tools and 11 by more.
- Content: 485 questions; 16 multi-question calls; 2.95 options on average; 439 used "(Recommended)".
- **264 (54%) were merge/PR/landing questions.**
- Of 391 answered, 28 were pre-empted by a worker notice arriving before the user's answer.

**work_suggest** [LS]
- 958 calls in 746 threads, at most 3 per run.
- The store holds 996 suggestions:
  - **561 (56%) started by the user**, median 4.1 min after the suggestion (p10 0.6, p90 92 min);
  - 35 filed as issues;
  - 4 dismissed;
  - 396 open.

**hypothesis_record** [LS]
- 2,427 calls in 1,446 runs (p50 1/run, max 15).
- Status mix: 1,431 validated (59%), 686 invalidated (28%), 309 inconclusive.
- **Strongly provider-skewed adoption** (runs with a call / runs that used any coder-threads tool):
  - grok 872/1,104
  - cursor 481/607
  - codex 60/380
  - claude 33/656
  - kimi 0/53
- Effect downstream: 433 of 1,060 forks have an ancestor with invalidated entries, so they receive the note.

**Other tools** [LS]
- `thread_send`: delivered 157, **queued 165 (51%)**, refused 0, undeliverable 0; 263 passed `fromThreadId`.
- `peer_send`: 191 calls, 83 by workers. Only ~5 carried a `branch:path` ref, despite the 300-char INSTRUCTIONS paragraph.
- `task_*`: 13 crews.
- `thread_settle`: 35 calls (27 settling own workers, 3 threads).
- `thread_rename`: 23, 21 of them self-renames.

### Inferences
**Misuse patterns ranked by volume, with the instruction line that caused or failed to prevent each**
1. **Redundant status read after a notice (164–222 turns).** Caused by "Continue orchestrating; thread_status has full details" ([runner.js L1349-L1350](electron/runner.js#L1349)) and "thread_status still has full details" (INSTRUCTIONS). Both are false.
2. **Polling a working worker (387 repeat checks; 84 polling runs; sleep loops).**
   - Not prevented: "Runs are asynchronous: send work, then continue" is weak next to T3's "end the turn instead of polling or spawning watchers".
   - Actively invited by the stall advice "if one goes quiet check thread_status".
   - The September spike suggests some leads did not trust the wake.
3. **`threads_list` overflow (34).** Caused by schema: no limit, filter or cursor, and every project thread returned (some projects hold hundreds).
4. **Calling `preview` with the pane closed (47/47).** The INSTRUCTIONS paragraph advertises preview to every agent. The tool can never succeed unless the user opened the pane, and nothing tells the agent to check first, or to end its turn after asking.
5. **`spec_submit` outside spec mode (13/14).** The INSTRUCTIONS line ("When a thread is in spec mode… call spec_submit") plus the tool's constant presence lure Grok and Cursor into calling it.
6. **Approval-gate collisions on notice turns (16).** Low, and recovered by `ask_user` in 12 of 17 cases. The gate plus the refusal text works. Raw-git bypass effectively stopped after the gate landed (6 after, all with user intent).
7. **Hallucinated ids (~11) and invented projectIds (13 silently overridden).** Rare. Because the binding overrides the projectId, the 17 "YOUR OWN" sentences buy little.

### Gaps
- **How workers were landed outside the tools is not recorded on threads** (`integrationLanded` is 0 and `integrationReceipts` exists on 2 threads). So "user integrates via UI" versus "lead integrates via tool" cannot be fully split. The 147 + 20 tool landings are the lower bound for lead-driven landing.
- Truncated transcript inputs mean `thread_fork` argument counts are lower bounds (`title`, `pool`, `worktree`). In particular, whether leads pass `title` (added 09-26) cannot be measured.
- I did not test whether the September polling spike correlates with a specific provider or app version.

---

## 4. Rarely or never used Solenta tools, and which T3 ideas fill real gaps

### Takeaway
- **Drop or gate:** `teach_review` (0 calls), `refresh_worker_snapshot` (1), `spec_submit` (1 legitimate in 14), `thread_stop` (6), `task_release` (5), `preview` (0 successes). These five, plus INSTRUCTIONS text for spec/teach/refresh/preview, cost ~2.5k chars for near-zero use.
- **The T3 ideas with direct evidence of need:**
  - a **thread_read** / richer result channel (leads already scrape git and raw store files);
  - **list filtering and pagination** (34 overflows);
  - **"end the turn" wake semantics with read-acknowledges** (164 redundant reads; polling);
  - **send `mode` with steer** (51% of sends queued);
  - **binding identity to the session** instead of id arguments.

### Cited Findings
- Usage counts are in §3 [LS]:
  - `teach_review` 0; `refresh_worker_snapshot` 1; `spec_submit` 14 (13 invalid); `thread_stop` 6 (4 refused); `task_release` 5; `thread_rename` 23; `thread_settle` 35 in 3 threads.
  - `preview` 47/47 failures.
  - Store mode counts: `teach` 1 thread, `spec` 2 threads.
- Solenta already gates whole tools by session condition: the issue tools register only `if (opts.planboard)` — [orchServer.js L1738](electron/orchServer.js#L1738)
- **T3 equivalents:**
  - `t3_thread_read` with pagination and an acknowledge-on-read side effect;
  - `t3_thread_list` with `statuses/titleContains/settled/cursor/limit` plus `currentThreadId`;
  - `t3_thread_send` with `mode: auto|queue|steer|restart`;
  - `t3_thread_wait` (bounded server-side wait, "Timeout does not interrupt work");
  - `task_status` ("Reading a terminal result acknowledges its automatic parent delivery");
  - per-session bearer scope, so there are no self-id arguments;
  - `preview_status` → `preview_open` ("call `preview_open` before concluding that the browser is unavailable").
  - Sources: §1 citations, [orchestrator/tools.ts L160-L238](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/mcp/toolkits/orchestrator/tools.ts#L160-L238); [T3OrchestrationInstructions.ts L39](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/T3OrchestrationInstructions.ts#L39)
- **Heavily used and worth keeping as they are:**
  - `work_suggest`: 56% of suggestions started by the user;
  - `ask_user`: 82% end-of-turn compliance, and the main landing-approval channel;
  - `thread_merge`: 152 landings;
  - the Planboard `issue_*` tools: 3.5k calls.

### Inferences
- **`thread_wait` is not needed.** Solenta's wake notice already gives the "end turn, get woken" path. T3's server-side wait (50 ms SQL polling, being removed in open PR #15033 per the prior note) is not worth copying.
- **Read-acknowledge is worth copying in spirit.** If the notice carried the full last reply, or a `thread_read` existed, then "lead already read the result" could suppress a duplicate notice later.
- **Roles are not worth copying:** T3's role enum is a one-line prefix (§1).

### Gaps
- No evidence was found for whether `thread_rename` or `thread_settle` calls were user-requested. They are low-volume and harmless.

---

## 5. Prioritized wording and schema changes for Solenta (before/after, justified by evidence)

### Takeaway
- **Fix false promises first** (notice and INSTRUCTIONS `thread_status` lines), and **give leads a real result channel**.
- **Then remove polling invitations**, add `threads_list` paging, and gate the never-working `preview` and `spec_submit`/`teach_review`.
- **Then cut boilerplate** (self ids, the repeated landing rules, the per-turn `[Suggested work]` and hypothesis cost).
- Each change below cites the §3 evidence.

### Cited Findings
- All "Before" strings are verbatim from [orchServer.js](electron/orchServer.js), [runner.js L1316-L1351](electron/runner.js#L1316), and [services.js](electron/services.js) at 615b38a0.
- All evidence numbers are [LS] (§3).

### Inferences
**P1 — Make the result channel true and sufficient.** Evidence: 164 notice turns call `thread_status` on the named worker and get the same first line; leads run 666 git diff/log/show on notice turns; 9 raw reads of `messages/<worker>.json`.
- Notice tail, [runner.js L1350](electron/runner.js#L1350):
  - Before: `"\nContinue orchestrating; thread_status has full details."`
  - After: `"\nIts final reply is above. Review its branch with git (log/diff against your branch) before reporting; do not call thread_status for this worker."`
- Notice body: replace `Last reply: <first line>` with the **full last assistant message, capped at ~4,000 chars**.
- INSTRUCTIONS:
  - Before: "thread_status reports a thread's status and the first line of its last assistant reply… thread_status still has full details if you need them before the wake-up."
  - After: "thread_status returns a thread's status, error, and the start of its last reply — for a one-off check, not a loop."
- Optional schema: add `thread_read {threadId, limit?≤20, afterIndex?}` returning user and assistant messages (T3 `t3_thread_read` pattern). That would also remove the incentive to read `coder-store.json`.

**P2 — Remove polling invitations; adopt T3's "end the turn" wording.** Evidence: 387 repeat checks of working workers; 84 polling runs (52% of status calls); sleep loops up to 300 s; 9.3 status calls per fork in early September. The stall advice paid off in 15 of 1,267 results, and #1421 now surfaces stalled family members in the sidebar.
- INSTRUCTIONS:
  - Before: "Runs are asynchronous: send work, then continue. When a worker you forked finishes (done or failed) you are woken on a new turn with a notice; do not sit idle waiting for the user to relay that. thread_status still has full details if you need them before the wake-up. A worker can also stall on a permission prompt only the user can answer: that sends no notice and stays "working", so if one goes quiet check thread_status for awaitingInput and tell the user what it is waiting on."
  - After: "Runs are asynchronous. After thread_fork or thread_send, end your turn: each worker's finish (done or failed) wakes you with its final reply. Do not poll thread_status, sleep, or start watchers while workers run. A worker blocked on a permission prompt shows as needing the user in the sidebar."
- `thread_status` description: append "Do not call it in a loop; finished workers wake you."
- Host follow-up (not wording): make "worker hit a permission prompt" a wake notice too. That makes the stall line unnecessary everywhere.

**P3 — Page and filter `threads_list`.** Evidence: 34 of 285 calls (12%) overflowed Claude's output cap; the handler returns all project threads ([orchServer.js L390-L417](electron/orchServer.js#L390)).
- Schema, before: `{ projectId?: string }`. After: `{ projectId?, status?: "working"|"done"|"failed"|"idle", workersOf?: string /* lead thread id */, includeArchived?: boolean /* default false */, limit?: 1..100 /* default 25 */, cursor?: string }` → `{ threads, nextCursor, total }`.
- Description, after: "List threads in your project, newest first. Archived threads are omitted unless includeArchived. Use workersOf=<your thread id> to list your own workers. Page with cursor."

**P4 — Stop advertising tools that cannot work in the current session.**
- **`preview`** (47/47 failed):
  - Either open the pane host-side on first call (T3: `preview_open` before "concluding that the browser is unavailable"), or register `preview` only when the pane is open.
  - Minimum wording fix in INSTRUCTIONS and the description. Before: "If the pane is not open the tool says so: ask the user to open it." After: "Call action:"info" first. If it reports the pane closed, ask the user once to open Views → Browser and end your turn; do not retry or claim the UI works."
- **`spec_submit` / `teach_review`** (13 of 14 invalid calls, 0 calls):
  - Register them only on threads in spec or teach mode, using the same mechanism as `opts.planboard`.
  - Delete the 323-char spec/teach sentence from INSTRUCTIONS; the `[Spec mode]` / `[Teach mode]` notes already instruct.
- **`refresh_worker_snapshot`** (1 call): delete its 311-char INSTRUCTIONS paragraph and keep the description.

**P5 — Bind identity to the session; drop the 17 "YOUR OWN" sentences.** Evidence: 0.13% self-id mismatches; 13 wrong projectIds silently overridden by the bound `?projectId=`; T3 derives the caller from the credential.
- Schema: make `threadId`/`projectId` optional on self-scoped tools, defaulting from a `?threadId=` added beside `?projectId=` at [memory-sup.js L699](electron/memory-sup.js#L699).
- Description, before (×17): "projectId is YOUR OWN project id (stated at the end of your prompt); the thread must belong to it." After: (delete).
- INSTRUCTIONS, before: "Your thread id and project id are stated at the end of your prompt; pass them, never guess an id from a title." After: "Your own thread and project are implied; pass a threadId only to act on another thread, taken from threads_list or a notice."
- Saves ~1.8k description chars and 42 required fields. Keep `[Thread]` only as a fallback for unbound sessions.
- Caveat: per-thread binding needs a per-thread MCP config. Grok and Cursor use per-home config files (see gaps).

**P6 — State the landing rule once in tool text; keep the notice.** Evidence:
- The gate plus the refusal text work: 16 refusals, 12/17 recovered via `ask_user`, 0 same-run bypasses.
- Raw `git merge` dropped from 126 (pre-gate) to 6 (all user-requested).
- 73% of merges follow an `ask_user` answer.
- The notice is where bypass risk lives, so its paragraph stays. Changes:
  - **INSTRUCTIONS landing paragraph (1,052 chars).** After (~380): "Workers commit only to their own branch. When one finishes, review it, then ask the user with ask_user whether to merge (thread_merge) or open a PR (thread_pr) — once for all finished workers, naming the order. Pass approved:true only in the turn their answer starts; the host refuses it on machine-delivered turns, and never land worker branches with raw git."
  - **`thread_merge` description (1,675 chars).** Cut to the mechanics: squash into your tree, expectedPath/expectedBranch, CI_WORKFLOW, conflicts. Drop the repeated "Merging is the user's decision…" sentences; the refusal message already teaches them.

**P7 — Hypotheses: ask only for dead ends, and stop paying for the note every turn.** Evidence:
- 59% of 2,427 records are "validated", which is never injected.
- Adoption is provider-skewed: grok 79% of runs, claude 5%.
- The note is p50 1.4k / p90 4k chars on 566 threads, every dispatch.
- Changes:
  - INSTRUCTIONS, before: "Keep the hypothesis ledger current as you work: call hypothesis_record for each distinct approach as soon as you know how it turned out." After: "When an approach fails, record it with hypothesis_record (status invalidated, reason = the evidence) so later agents skip it."
  - Host: inject the `[Hypotheses]` note only on a session's first turn or when it changed (T3/Codex "resend only when the value changes").

**P8 — `[Suggested work]` duplicates INSTRUCTIONS on every turn (491 + 153 chars).** Keep one.
- `work_suggest` is high-value (56% of suggestions started), so keep the INSTRUCTIONS sentence and the tool description.
- Inject the note on the first turn only, unless harness evidence shows the MCP `instructions` are not surfaced (see gaps).

**P9 — Fix the `thread_send` outcome list; expose queue position; consider steer.** Evidence: 51% of sends queued; refused and undeliverable never occurred.
- INSTRUCTIONS, before: "…or undeliverable (archived, unattended/scheduled, unknown)." After: "…or undeliverable (archived non-worker or unattended/scheduled thread); an unknown id is an error."
- Future schema (T3 `t3_thread_send.mode`): `mode?: "queue"|"steer"` where the provider supports mid-turn injection.

**P10 — Typed error prefixes.** T3 uses `code`. Solenta's refusals already read well. Add a stable leading code to the remaining ones so harnesses and leads can branch on it: `APPROVAL_REQUIRED:`, `UNKNOWN_THREAD:`, `WRONG_PROJECT:`, `PANE_CLOSED:`, `NOT_SPEC_MODE:`, `PR_TOO_LARGE:` (`MERGE_CONFLICT:` and `CI_WORKFLOW:` already exist). Low priority: 227 errors in 10,498 calls.

**P11 — A harness-prefix sentence, like T3's.** Evidence: 3 "Tool not found: coder-threads__…" errors on Grok, plus calls to non-existent `issue_update`/`memory_store`. Add: "Tool names may carry a harness prefix (mcp__coder-threads__x, coder-threads/x); if a tool search does not show one, try the known name once before concluding it is missing." Low priority.

**Net size estimate if P1–P8 land**
- INSTRUCTIONS: ~5.96k → ~3.3k chars.
- Tool descriptions: ~11.7k → ~8.5k chars.
- Fixed per-turn notes on later turns: ~2.2k → ~0.9k chars.
- Hypothesis note: first turn only.

### Gaps
- **Per-thread MCP binding (P5) is not confirmed feasible:**
  - Grok and Cursor config is written per CLI home (`grok-homes/`, `cursor-homes/`), and per-thread URLs may need per-thread config files.
  - Codex config overrides were not checked.
- **I did not measure whether Grok, Cursor and Kimi expose MCP server `instructions` to the model.** P2 and P8 should keep the key sentences in a per-turn note for any harness that drops server instructions.
- Expected impact of P1/P2 is inferred from the counts above, not from an A/B run.
