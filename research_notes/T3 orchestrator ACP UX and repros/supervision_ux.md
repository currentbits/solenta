# T3 Code Orchestrator V2 supervision UX vs Solenta's renderer: component-level comparison and adoption ideas (as of 2026-10-04)

**Scope and method**
- **T3 code.** `/tmp/t3code-research`, main `eac52f0087d9ba5dee5542f24788d1482affae43`, committed 2026-10-04 01:37 PDT. `git fetch origin main` on 2026-10-04 found **main had not moved**.
  - The clone is shallow: about 400 commits, oldest `016cdb96` on 2026-09-22.
  - Nearly every V2 supervision file first appears in the squash `de343914` "feat(orchestrator): introduce new orchestrator (#2829)" on 2026-10-02. Older history isn't visible.
  - T3 links below are pinned to that SHA. In the citations, "T3" means `https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/`.
- **Solenta code.** Read-only, from this checkout (branch `coder/i-want-you-to-research-t3-codes-orchestr-fae77a`, which includes `origin/main` `d0143309`). Solenta links are relative to this notes file.
- **T3 main vs open PRs.** Every finding is on T3 main unless it is tagged **(open PR)**.
- **Screenshots** of Solenta (demo data) are in this folder: `solenta_main_view.png`, `solenta_agents_panel.png`, `solenta_thread_details.png`.
  - Caveat: they come from the vite dev server another session already had running on :5391, serving worktree `4911186c…` (branch `coder/i-want-you-to-look-at-our-github-pr-s-an-491118`, HEAD `6a682319`). That branch includes b149eba3 plus an unmerged "Calm UI pass 2" palette restyle (#1429). The layout matches main; the colors may not.
  - The demo thread is idle, so the queue strip and quota strip are not visible.

## 1. Lineage panel and inline subagent cards: data model, status, caps, grouping, stop, read-only children (vs Solenta Team roster, nested families, worker activity fold)

### Takeaway
T3 shows every child: provider-native subagents, `delegate_task` children, forks and context transfers. Each appears in two places:
- a capped, grouped **Lineage** list inside thread details, with title, provider icon, live elapsed time, a status label, and a hover card (model, account, progress/result preview);
- **collapsible inline group cards** in the transcript ("3 subagents · 2 working · 1 done", with one group timer).

T3 main has **no per-child Stop**: "stop active subagents from Lineage" is open PR #15211. The only stop is the parent-level "Waiting on 2 subagents and 1 command … Stop" banner.

Solenta is **ahead** on crew orchestration: task graph, Integration staging, Delegating/Stalled states, family nesting in the sidebar. It **has a real gap** on in-session subagents:
- `SubagentInfo` carries only `description / agentType / status(running|done|failed)`;
- the Agents-tab rows show no model, duration or result;
- in the transcript, Agent/Task tool calls are generic "Used N tools" cards.

### Cited Findings
**T3: Lineage data model and graph (main)**
- **Subagent record fields:** `id, threadId, runId, parentNodeId, origin: "provider_native"|"app_owned", driver, providerInstanceId, childThreadId (nullable), prompt, title, model, status, progress?, result, startedAt, completedAt, updatedAt, completionWake?, completionDelivery?` — [T3 packages/contracts/src/orchestrationV2.ts:656-694](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L656)
- **Thread lineage:** `{ parentThreadId, relationshipToParent: "fork"|"subagent"|null, rootThreadId }` — [T3 orchestrationV2.ts:103-107](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L103)
- **Graph edges** `kind: "parent"|"fork"|"subagent"|"transfer"`, built by `deriveThreadRelationshipGraph`:
  - edges come from thread shells, from projection subagents with a `childThreadId`, and from `contextTransfers`;
  - status is `childShell.activityRunStatus ?? subagent.status`, so a live follow-up outranks a stale "Done". That was the fix for "subagents sent a follow-up show as running in Lineage" (#15334).

  — [T3 packages/client-runtime/src/state/threadRelationships.ts:48-117](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/threadRelationships.ts#L48); [PR #15334](https://github.com/pingdotgg/t3code/pull/15334)
- **Client projection gaps:** a missing title falls back to the prompt cut to 77 chars plus "...". `usage`, `duration` and `parentAgentId` are **always null**, which is the root cause of issue #15429 "no token usage for subagents". — [T3 subagentRuntime.ts:98-147](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/subagentRuntime.ts#L98); [#15429](https://github.com/pingdotgg/t3code/issues/15429)

**T3: Lineage panel UI (main)**
- **Section title:** `Lineage · {runningCount} running`, or plain "Lineage". `runningCount` counts only status `running`; pending and waiting rows are not counted. — [T3 apps/web/src/components/chat/ThreadRelationshipsControl.tsx:271-274, 320](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ThreadRelationshipsControl.tsx#L320)
- **Status labels:**

  | Raw status | Label |
  |---|---|
  | preparing, starting | "Starting" |
  | running | "Running" |
  | pending, queued | "Queued" |
  | waiting, blocked | "Waiting" |
  | completed | "Done" |
  | failed | "Failed" |
  | cancelled, interrupted | "Stopped" |
  | rolled_back | "Reverted" |
  | other | "Resolved (native)", "Consumed", "Superseded", "Idle", "Unknown" |

  Dot colors: info (active), destructive (failed), success (done). — [T3 ThreadRelationshipIcon.tsx:6-43, 71-85](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ThreadRelationshipIcon.tsx#L6)
- **Groups:**
  - related rows (parent, forks, transfers);
  - active subagents;
  - **"Previous agents"**: completed, failed, cancelled, interrupted or idle. Collapsed by default, with ` (N)` and a `{n} failed` accessory.
- **Caps and ordering:**
  - `THREAD_LINEAGE_INITIAL_COUNT = 6`, then `Show {≤12} more` (page size 12), in a `max-h-[13.5rem]` scroll list with `aria-label="Related threads"`.
  - The parent row is pinned first and the merge-back target second; the rest are newest first.

  — [T3 ThreadRelationshipsControl.tsx:68-69, 94-108, 129-139, 252-269](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ThreadRelationshipsControl.tsx#L68); [T3 threadRelationships.ts:227-251](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/threadRelationships.ts#L227)
- **Row content:** icon (provider glyph for subagents; fork, parent or bot icon otherwise), title, live elapsed time (`AgentElapsed`: "Ns" / "Mm SSs" / "Hh MMm", ticking every second), then the status label.
  - **Row click** opens the child in the same chat.
  - **Hover card** shows model (plus `· {account}` when there are several accounts, #15493), status, elapsed time, Project/Branch/Worktree differences, and a progress/result preview of up to 280 chars. An unknown model shows "Not reported".

  — [T3 ThreadRelationshipsControl.tsx:401-428](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ThreadRelationshipsControl.tsx#L401); [T3 SubagentTooltipContent.tsx:29-118](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/SubagentTooltipContent.tsx#L29); [T3 subagentDisplay.ts:79-132](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/subagentDisplay.ts#L79); [T3 AgentElapsed.tsx:6-51](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/AgentElapsed.tsx#L6)
- **Empty state:** there is none; the panel renders `null` when there are no rows. A missing related thread shows as a disabled row with the tooltip "This related thread is unavailable". — [T3 ThreadRelationshipsControl.tsx:276-278, 378-380](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ThreadRelationshipsControl.tsx#L276)
- **Stop:** there is no per-child stop on main. The section's "More thread actions" menu has a single item, "Disconnect agent session", which detaches the provider sessions of the **current** thread without a confirm step. — [T3 ThreadRelationshipsControl.tsx:322-346](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ThreadRelationshipsControl.tsx#L322); **(open PR)** "stop active subagents from Lineage" [#15211](https://github.com/pingdotgg/t3code/pull/15211)
- **Parent-level stop banner** (main), shown after the foreground turn settles while background work continues:
  - titles: "Waiting on subagent {name}", "Waiting on a subagent", "Waiting on 2 subagents and 1 command", "Running: {cmd}";
  - each child name is an inline link, `Open subagent {label}`;
  - the button reads "Stop" / "Stopping...", with no confirm. It sends `run.interrupt{holdQueue:true}`.
  - Error text: "Failed to stop background work."

  — [T3 threadExecution.ts:305-369](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/threadExecution.ts#L305); [T3 ChatView.tsx:7094, 7160](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/ChatView.tsx#L7160)
- **Read-only children:**
  - Provider-native subagent threads (`relationshipToParent === "subagent" && creationSource === "provider"`) **replace the composer** with `ProviderSubagentBar`. It shows the model, effort, a status like "Working 12s" or "Completed in 34s", "Runs on its own", and an "Open parent" button.
  - `delegate_task` children (`creationSource: "mcp"`) keep a normal composer.
  - Every subagent child gets a timeline pill, "Subagent of {parent}", with the action "Open parent thread".
  - Release note: "Subagent threads are read-only. Message the parent thread instead."

  — [T3 orchestrationV2.ts:435-444](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/orchestrationV2.ts#L435); [T3 ProviderSubagentBar.tsx:55-91](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ProviderSubagentBar.tsx#L55); [T3 MessagesTimeline.tsx:1248-1266](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/MessagesTimeline.tsx#L1248); [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
- **Subagent children are hidden from the new sidebar.** Code comment: "Subagent child threads live in the parent's Agents surface". — [T3 Sidebar.logic.ts:560-577](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/Sidebar.logic.ts#L560)

**T3: inline subagent cards (main)**
- **Folding rule** ("Several subagents fold into one collapsible card"): consecutive `subagent` event rows that share `runId` and `providerTurnId` merge into one row. A group card is drawn only when there is more than one member. The `delegate_task` tool row is hidden once its child card exists. — [T3 MessagesTimeline.logic.ts:1139-1169, 1609-1627](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/MessagesTimeline.logic.ts#L1609); [T3 MessagesTimeline.tsx:2785](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/MessagesTimeline.tsx#L2785); [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
- **Collapsed group:**
  - up to 3 overlapping provider avatars plus `+{n-3}`;
  - the label `{n} subagents`;
  - a status line from `summarizeSubagentStatuses`, e.g. "2 working · 1 done" (pending, running and waiting all count as working), colored info while active and destructive if any failed;
  - one group elapsed time, from first start to last completion;
  - a chevron.

  Groups are collapsed by default and dimmed (`opacity-55`) unless active or expanded. Expanding shows one card per member. — [T3 MessagesTimeline.tsx:2959-3104](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/MessagesTimeline.tsx#L2959); [T3 subagentDisplay.ts:29-44](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/subagentDisplay.ts#L29)
- **Single card:**
  - avatar with a status dot, title, and a detail line: progress while live, result once settled, markdown flattened;
  - elapsed time and a chevron;
  - status labels: Queued, Running, Waiting, "Idle · resumable", Completed, Failed, Stopped;
  - a click opens the child, and hover shows the same card as Lineage.
  - Since #15281, a finish notification renders as that subagent's card labelled "Finished", "Failed", "Stopped" or "Updated".

  — [T3 V2LifecycleRow.tsx:241-253, 331-525](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/V2LifecycleRow.tsx#L241); [PR #15281](https://github.com/pingdotgg/t3code/pull/15281)

**T3 bug reports against these surfaces**
- #15304 (open): the details side-tabs (Subagents, Lineage, Automations, Background Tasks) vanish once rows populate, because density flips from full to compact at about 1400x800 and Lineage renders only at `density === "full"`. — [#15304](https://github.com/pingdotgg/t3code/issues/15304); [T3 ThreadDetailsPanel.tsx:229-234](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ThreadDetailsPanel.tsx#L229)
- Missing subagent metadata, all open:
  - no token usage (#15429);
  - no reasoning effort (#15214);
  - Claude workflow phases are flattened (#15448);
  - Codex model stays "Not reported" (#15250);
  - a completed delegated-task notification expands to an empty panel (#15169);
  - the parent link has no pointer cursor (#15159);
  - the Lineage three-dot hover is misaligned (#15306).

  — [#15429](https://github.com/pingdotgg/t3code/issues/15429); [#15214](https://github.com/pingdotgg/t3code/issues/15214); [#15448](https://github.com/pingdotgg/t3code/issues/15448); [#15250](https://github.com/pingdotgg/t3code/issues/15250); [#15169](https://github.com/pingdotgg/t3code/issues/15169); [#15159](https://github.com/pingdotgg/t3code/issues/15159); [#15306](https://github.com/pingdotgg/t3code/issues/15306)
- Open follow-up PRs:
  - #15446 token usage in lineage tooltips
  - #15348 expanding previous agents no longer hides lineage
  - #12598 / #15559 Claude workflow phases
  - #13056 effort/speed in hover cards
  - #15163 keep the parent highlighted while viewing a subagent

  — [#15446](https://github.com/pingdotgg/t3code/pull/15446); [#15348](https://github.com/pingdotgg/t3code/pull/15348); [#12598](https://github.com/pingdotgg/t3code/pull/12598); [#13056](https://github.com/pingdotgg/t3code/pull/13056); [#15163](https://github.com/pingdotgg/t3code/pull/15163)
- Doc drift: `docs/user/thread-sidebar.md:210` still says "use **Agents** to follow work delegated to subagents", but the web Agents surface was removed ("v14 removes the agents surface; lineage lives in the thread title bar"). — [T3 docs/user/thread-sidebar.md:210](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/user/thread-sidebar.md#L210); [T3 rightPanelStore.ts:93](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/rightPanelStore.ts#L93)

**Solenta equivalents**
- `SubagentInfo` has only `id`, `description`, `agentType`, and `status: "running"|"done"|"failed"`. `ThreadInfo.subagents` is "tracked by the runner from the CLI stream (issue #21). Newest-last, capped to 20 rows." — [Solenta src/shared/ipc.ts:766-771, 1077-1085](../../src/shared/ipc.ts)
- **Agents tab "Subagents" section.** Each subagent renders as a `TeamRow` with role "Subagent", the `agentType` in the provider slot, and `description` as the title. Rows are not navigable (no `onSelect`), and there is no duration, model, result or stop. — [Solenta src/components/AgentsPanel.tsx:3094-3119](../../src/components/AgentsPanel.tsx)
- **`TeamRow`** (crew workers): role chip, provider, title, raw status badge (with "waiting" / "stalled" overrides), and the child's last assistant line. Clicking navigates. There is no model, duration, cost or stop. — [Solenta AgentsPanel.tsx:2705-2756](../../src/components/AgentsPanel.tsx)
- **Orchestrator view:** Session card, Team (WaitLine, then live workers, then done workers folded behind `"{N} done"` / "Hide done" while any worker is live), CrewIntegration, Tasks (open / claimed / done / blocked, with attempts), Subagents, Hypotheses. Summaries poll every 5 s. — [Solenta AgentsPanel.tsx:3172-3317, 819](../../src/components/AgentsPanel.tsx); screenshot `solenta_agents_panel.png`
- **Waiting line:** `waitLabel` produces e.g. "Waiting on 2 workers · 1 subagent · 3m · 1 blocked · 1 stopped". `crewSummaryLabel` on the lead's sidebar family toggle produces e.g. "4 workers · 1 needs you · 1 failed · 1 stopped · 2 running · 2 ready". — [Solenta src/waiting.ts:154, 196-205](../../src/waiting.ts)
- **Nested families (b149eba3, #1421).**
  - `isFamilyChild` now covers any `handoffFrom` row (plain forks too); before, it covered orchWorkers only.
  - The whole family sits on the Working shelf while any member is quietly working, unless a member needs input, is stalled, or has failed.
  - Family collapse state is stored per root in localStorage.

  — [Solenta src/sidebarGroups.ts:74-136, 438-473](../../src/sidebarGroups.ts); `git show b149eba3`
- **Worker activity fold.** Routine "Worker … finished with status done." / "[crew] finished …" notices collapse into one `<details>` line: `Worker "<title>" finished`, `{N} workers finished`, `Unblocked t2, t3`. Anything actionable stays expanded. — [Solenta src/workerActivity.ts:243-259](../../src/workerActivity.ts); [Solenta ThreadView.tsx:1403-1466](../../src/components/ThreadView.tsx)
- **Transcript.** Agent/Task tool calls get no special treatment: `toolAction` maps them to "other", and they collapse into a generic `ToolGroupRow` ("Used N tools") with raw-JSON `ToolCallCard`s. — [Solenta src/toolGroups.ts:32-91](../../src/toolGroups.ts); [Solenta ThreadView.tsx:874-1156](../../src/components/ThreadView.tsx)
- **Stop:** only the selected thread's status-strip "Stop" exists. There is no per-child or stop-all control. — [Solenta ThreadView.tsx:8391-8408](../../src/components/ThreadView.tsx)
- **Child threads are not read-only.** The composer is disabled only for archived threads. Crew workers show a banner `Task <lead title>` / `Parent worker <title>`. — [Solenta ThreadView.tsx:7815-7837, 8757](../../src/components/ThreadView.tsx)
- **Count inconsistency.** The sidebar wait counts plain forks as "workers" (since b149eba3), while the Agents-panel wait and the header "Workers (N)" button count orchWorkers only. — [Solenta Sidebar.tsx:2014](../../src/components/Sidebar.tsx); [Solenta AgentsPanel.tsx:3088-3091](../../src/components/AgentsPanel.tsx); [Solenta App.tsx:1443-1452](../../src/App.tsx)

### Inferences
**Verdicts**

| Area | Verdict | Why |
|---|---|---|
| Crew lineage (workers, tasks, integration) | **Solenta ahead** | T3 has no task graph, attempt tracking, or integrate-then-land view |
| In-session subagents (Agent tool) | **Gap** | Per-child model, live elapsed, progress/result and "N running" are missing, and inline cards are generic |
| Stop | **Parity on main; both lack per-child stop** | T3's advantage is the named "Waiting on … / Stop" banner; Solenta's WaitLine has no Stop |

**Adoption sketch (gap #1 in section 8)**
- **Data.** Extend `SubagentInfo` (`src/shared/ipc.ts:1077`) with:
  - `startedAt`, `completedAt`;
  - `model?` (the Agent tool input's `model`, when given);
  - `resultPreview?` (first ~280 chars of the matching tool_result);
  - optional `toolUses` / `tokens` if the CLI stream reports them.

  The runner already pairs Agent tool_use with its status (ipc.ts:766-771 comment), so this is a runner-side addition, not a new channel.
- **Transcript.** Add an `"agent"` action to `toolAction` (`src/toolGroups.ts:32`). When a ToolGroupRow's calls are all agent calls, render a `SubagentGroupRow`:
  - collapsed: `{n} subagents · 2 working · 1 done · 1m 12s`;
  - expanded: one row per agent with description, agentType, status dot, elapsed time and the result line.

  Port `summarizeSubagentStatuses` (15 lines). Reuse the existing ToolGroupRow collapse state (`expandedGroups`).
- **Agents tab.** Title the section `Subagents · N running` (the same rule as T3), and give each `TeamRow` an elapsed time and a result line. For crew workers, `ThreadSummaryInfo` (ipc.ts:1093) already has `runStartedAt` / `stoppedAt`, so TeamRow can show elapsed time **today** without any IPC change.

### Gaps
- I did not verify whether Claude's CLI stream exposes a per-subagent model or token usage that the runner could record. This needs a check of `electron/runner.js` Agent tool parsing.
- T3's group timer and statuses depend on server projection fields that Solenta doesn't have. The mapping above assumes tool_use/tool_result timestamps are available in `ThreadDetail.workLog` (ipc.ts:1707); I did not verify this.

## 2. Queue UI: rendering, edit/reorder/delete, steer vs queue, held state and Resume, automatic deliveries (vs Solenta #364 queue)

### Takeaway
T3's web queue is a collapsible "Queued [count]" region directly above the composer. Each row has:
- a drag/keyboard reorder grip;
- an edit button that loads the message into the composer under a separate draft key;
- a per-row **Steer** (promote) button;
- a remove X.

Steer vs queue is a setting (default **queue**). `Cmd/Ctrl+Enter` or a Cmd-click inverts it, and the send icon morphs while the modifier is held.

A held queue shows no label on web; it surfaces only as the send button turning into a Play "Resume thread". Mobile shows "Queue held after restart / Resume queue". Automatic deliveries (subagent results) are **never shown** in the queue: the server pins them first and refuses to let you edit, reorder or promote them.

Solenta's queue is at **rough parity**, and ahead in places (inline in-strip edit, `/btw` side questions, a per-thread inbound policy). It lacks:
- per-row steer while a run is live ("Send now" is disabled while working);
- any explanation of why a queue is sitting idle after a stop or failure;
- marking of inbound items from other threads (the `fromThread` / `inbound` fields exist in IPC with zero renderer consumers);
- drag and keyboard reorder, and shortcuts for "edit last queued" and "steer first queued".

### Cited Findings
**T3 web queue (main)**
- Placement and header:
  - Rendered inside `ComposerBanner.Dock` before the banner stack, so it sits directly above the composer.
  - Header: ListOrdered icon, "Queued", a count badge, and a chevron ("Collapse queued messages" / "Expand queued messages").
  - Region `aria-label` is `{n} queued message(s)` with `aria-live="polite"`. The list is an `<ol>` scrolling at `max-h-32`.
  - It is open by default (unpersisted `useState(true)`), and the control returns null when empty (there is no empty-state copy).

  — [T3 QueuedRunsControl.tsx:73, 232, 250-272](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/QueuedRunsControl.tsx#L250); [T3 ChatComposer.tsx:6568-6575](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ChatComposer.tsx#L6568)
- Row contents: grip, 16 px image thumbnails, a truncated preview (full text in a tooltip), a pencil, a "Steer" button (CornerUpRight icon), and an X ("Remove queued message", tooltip "Remove from queue"). — [T3 QueuedRunsControl.tsx:374-484](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/QueuedRunsControl.tsx#L374)
- **Edit flow:**
  - The pencil ("Edit queued message") loads the message into the composer under its own draft key, `queued-edit:<thread>:<runId>`, so the user's own draft survives.
  - The row is highlighted with "Editing queued message: " and offers "Cancel".
  - The send button becomes a check icon, "Update queued message", which replaces text, attachments and context.
  - If the run starts while you are editing: toast "Queued message is no longer queued" / "Your unsaved edit was kept in the composer." (or "…was discarded.").

  — [T3 QueuedRunsControl.tsx:367, 407-415, 442](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/QueuedRunsControl.tsx#L407); [T3 ChatView.tsx:1623-1632, 4594-4627, 8549-8606](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/ChatView.tsx#L4594); [T3 queuedMessageEdit.ts:11-54](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/queuedMessageEdit.ts#L11)
- **Reorder:**
  - Drag by the grip only; a 2 px primary line marks the drop point.
  - Keyboard: ArrowUp/ArrowDown on a focused grip ("Reorder queued message (drag, or press the arrow keys)").
  - Only server-confirmed rows reorder, and only when `supportsQueuedMessages`.

  — [T3 QueuedRunsControl.tsx:281-360](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/QueuedRunsControl.tsx#L281)
- **Per-row Steer (promote):**
  - Tooltip: "There is no active run to steer", or "Send as a steer instead ({shortcut})".
  - Disabled without `canPromoteToSteer`, which requires a running provider turn plus steering or interrupt-restart support.

  — [T3 QueuedRunsControl.tsx:459-470](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/QueuedRunsControl.tsx#L459); [T3 threadWorkflows.ts:131-161](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/threadWorkflows.ts#L131)
- **Steer vs queue:**
  - `resolveComposerDispatchMode`: not running → "auto"; running → the setting; with the alternate modifier → the opposite.
  - The setting `followUpBehavior` defaults to **"queue"**. The "steer" fallback in `composerDispatch.ts:18` applies only when no value is passed, and ChatComposer always passes one.
  - Keybinding `mod+enter → composer.sendAlternate` when `composerFocus && turnRunning`; a Cmd/Ctrl-click on Send also inverts.
  - The send icon morphs while the modifier is held (ListPlus = queue, CornerUpRight = steer). Send-button labels are "Queue message" / "Steer message"; tooltip `Click to {queue|steer}, Ctrl/⌘-click to {other}`.
  - An empty draft during a run turns the button into Stop ("Stop generation", tooltip "Interrupt").

  — [T3 composerDispatch.ts:11-21](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/composerDispatch.ts#L11); [T3 contracts/settings.ts:453-455](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/settings.ts#L453); [T3 shared/keybindings.ts:48-50](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/shared/src/keybindings.ts#L48); [T3 ComposerPrimaryActions.tsx:110-145, 250-280](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ComposerPrimaryActions.tsx#L110)
- **Settings copy:** "Follow-up behavior" (Queue / Steer), "Queue follow-ups while the agent runs or steer the current run. Press {mod} + Enter to do the opposite for one message." Note: `docs/user/composer.md:155-159` still describes Steer as the default, which is stale. — [T3 SettingsPanels.tsx:2832-2870](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/settings/SettingsPanels.tsx#L2832); [T3 docs/user/composer.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/user/composer.md)
- **Queue shortcuts:**
  - `mod+shift+enter` → "Queue: Send First Queued Message as Steer"
  - `alt+arrowup` (caret at start) → "Queue: Edit Last Queued Message"

  — [T3 shared/keybindings.ts:48-49](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/shared/src/keybindings.ts#L48); [T3 KeybindingsSettings.logic.ts:315-319](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/settings/KeybindingsSettings.logic.ts#L315)
- **Held queue and Resume:**
  - The server holds the queue:
    - on Stop (the client always sends `holdQueue:true`);
    - after a same-provider non-validation failure;
    - on restart recovery;
    - new arrivals inherit the hold.
  - Web shows **no held label**. The send button becomes a Play icon labelled "Resume thread" whenever there is a resumable run or a held queue and the draft is empty.
  - Mobile shows "Queue held after restart" plus a "Resume queue" button. That copy is shown even when the hold came from Stop.
  - The server refuses `queue.resume` on a limited thread: "Continue the limited thread before resuming its queue."

  — [T3 ChatView.tsx:2078-2091, 8242-8310](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/ChatView.tsx#L8242); [T3 ComposerPrimaryActions.tsx:254-256](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ComposerPrimaryActions.tsx#L254); [T3 mobile ThreadQueueControl.tsx:187-206](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/mobile/src/features/threads/ThreadQueueControl.tsx#L187); [T3 Orchestrator.ts:1236-1262, 8068-8082, 9598](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Orchestrator.ts#L8068)
- **Automatic deliveries:**
  - Filtered out of the client queue entirely (`getUserQueuedThreadRuns`).
  - The server pins `delegatedCompletion` runs first and rejects edit, reorder and promote with:
    - "Automatic completion deliveries cannot be edited."
    - "Queued messages cannot be reordered ahead of automatic completion delivery."

  — [T3 threadWorkflows.ts:110-125](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/threadWorkflows.ts#L110); [T3 QueuedRunOrder.ts:12-31](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/QueuedRunOrder.ts#L12)
- **Optimistic rows:** a pending (not yet acknowledged) queued message shows a clock icon ("Saving queued message") with its actions disabled. — [T3 QueuedRunsControl.tsx:126-166, 368-373](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/QueuedRunsControl.tsx#L126)
- **Mobile queue:**
  - a pill `{n} queued` opens a sheet;
  - swipe-left reveals "Remove";
  - a long-press menu offers Edit / Move up / Move down / Steer now / Remove;
  - empty state "No messages waiting in this queue."
  - Bug #15414 (Remove not tappable) was fixed by #15417 on main.

  — [T3 ThreadQueueControl.tsx](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/mobile/src/features/threads/ThreadQueueControl.tsx); [#15414](https://github.com/pingdotgg/t3code/issues/15414)
- **Release-note claims:**
  - "The queue lives on the server and keeps its order across restarts. After a restart it waits for you to resume it. It also survives usage limits."
  - "Edit, reorder, remove, and steer queued messages, including their attachments. This works on mobile too."

  — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
- **Bugs:**
  - #15279 (open): steered messages render below the "Worked for…" fold (fix #15421 open).
  - #15517 (open): steering while an AskUserQuestion is pending leaves a stale, unanswerable question.
  - #15289 (open): keep-alive drops queued threads while the UI still says working.

  Open PRs:
  - #14617 resume a paused queue from the queue itself
  - #12892 navigate queued messages without losing edits
  - #12824 queue messages sent during compaction
  - #15201 reconcile stale held-queue state

  — [#15279](https://github.com/pingdotgg/t3code/issues/15279); [#15517](https://github.com/pingdotgg/t3code/issues/15517); [#15289](https://github.com/pingdotgg/t3code/issues/15289); [#14617](https://github.com/pingdotgg/t3code/pull/14617); [#15201](https://github.com/pingdotgg/t3code/pull/15201)

**Solenta equivalents**
- **Data:** `ThreadInfo.queued` = `{prompt, items[] (#809), attachments, error (#314), fromThread{id,title} (#551), inbound, posted}`. API: `threads.setQueued` (append, or `replace:true` to edit), `runs.start` (`fromQueue`), `runs.steer`, `runs.stop`. — [Solenta src/shared/ipc.ts:627-649, 4010, 4422, 4446, 4474](../../src/shared/ipc.ts)
- **Queued strip** (shown when a queue exists), labelled "Queued":
  - Single item: text plus "Edit", "Send now" (or "Retry"), "Cancel".
  - Multiple items: per-row "Up" / "Down" / "Edit" / "Remove", and a footer with "Send now" / "Retry" / "Cancel".
  - Inline textarea edit with Save/Cancel (Esc cancels, Cmd+Enter saves). Saving empty text cancels the item.
  - "Send now" is **disabled while working**.
  - Cancel restores the text into the composer draft.

  — [Solenta ThreadView.tsx:8411-8702, 5314-5399](../../src/components/ThreadView.tsx); [Solenta App.tsx:1068-1077](../../src/App.tsx)
- **Steer vs queue:**
  - A segmented "Queue | Steer" toggle (aria "Follow-up while this run is live"), persisted per device, default "queue".
  - `⌘⇧Enter` always steers the current draft; `⌥Enter` sends a `/btw` side question.
  - Hint line: "⌘Enter {send|queue|steer} · ⌥Enter side question · ⌘S stash · ⌘⇧Enter steer · Esc stop".
  - If a steer fails with "no live run", it falls back to queueing. Steered messages render with a "Steered" label.

  — [Solenta src/components/Composer.tsx:3392-3424, 3497-3505, 1836-1872, 2495-2497](../../src/components/Composer.tsx); [Solenta src/uiPrefs.ts:196-220](../../src/uiPrefs.ts); [Solenta useCoder.ts:1798-1880](../../src/useCoder.ts)
- **Held queue:** since #1203 (`8fa7dec5`), the runner no longer drains the queue after a failed or stopped turn, and a quota-parked thread also doesn't drain. The strip simply keeps showing "Send now", with **no held/paused label**. — `git show 8fa7dec5`; [Solenta ThreadView.tsx:8576, 8685](../../src/components/ThreadView.tsx)
- **Inbound items:** `queued.fromThread`, `inbound` and `posted` have **zero consumers** in `src/`, verified with `LC_ALL=C grep -a`. Inbound blobs look like ordinary queued text. In the transcript they render as a "From <title>" card. A per-thread policy menu "Messages from other threads" offers Accept / Queue only / Refuse. — [Solenta ipc.ts:643-648](../../src/shared/ipc.ts); [Solenta ThreadView.tsx:1372-1401, 7130-7168](../../src/components/ThreadView.tsx)
- **Sidebar:** shows a "Queued" label when nothing louder applies, and appends "— Queued: <prompt>" to a busy card's tooltip. — [Solenta Sidebar.tsx:514-537, 716-726](../../src/components/Sidebar.tsx)

### Inferences
**Verdict: parity with specific gaps.**
- **Solenta ahead:** inline in-place edit; the `/btw` lane; the inbound policy; a steer→queue fallback.
- **T3 ahead:**
  - per-row promote-to-steer;
  - drag and keyboard reorder;
  - Resume affordance tied to a server "held" flag;
  - optimistic "Saving" rows;
  - keyboard shortcuts to edit the last item and steer the first item;
  - automatic deliveries kept out of the user queue.

**Adoption sketch (gap #3 in section 8), all in the ThreadView queued strip (`ThreadView.tsx:8411-8702`):**
1. **Per-row "Steer now" while working**, when `ProviderInfo.supportsSteer` (ipc.ts:2403) is true. It calls `runs.steer` (ipc.ts:4446) with that item, then `threads.setQueued` with `replace:true` (ipc.ts:4010) to remove it. This is the T3 "Send as a steer instead" pattern. Reuse the existing `editQueued` and `steer` helpers in `useCoder.ts`.
2. **Held explanation** when `queued != null` and `thread.status` is `failed`, or `idle` with `stoppedAt` set (ipc.ts:450, 490). The label would read "Paused after the run stopped. Send now to continue." This makes #1203's deliberate non-drain visible. T3 web has the same blind spot (only mobile labels it).
3. **Inbound chip:** render `From <fromThread.title>` (ipc.ts:644) as a link on inbound items, and make inbound-only blobs non-editable. This is the T3 automatic-delivery rule, applied to data Solenta already stores.
4. **Two shortcuts:** `⌥↑` with the caret at the start edits the last queued item; `⌘⇧Enter` with an empty draft steers the first queued item. (Today `⌘⇧Enter` steers only the draft.)

### Gaps
- I did not check whether Solenta's main process supports partial removal of one queued item after a steer without a race against the run-terminal drain.
- The T3 web held state shows no label, so there is no T3 copy to borrow. The copy suggested above is mine.

## 3. Limited state, resume-at-reset and snooze (vs Solenta quota wait)

### Takeaway
T3 marks a usage-limit stop as **Limited**: a sidebar pill with CircleAlert in warning color, and a warning composer banner reading "Usage limit reached / Resets {localeString}". The banner offers:
- **Resume at reset**, which toggles to "Cancel auto-resume";
- **Snooze until reset**.

There is no countdown. Auto-resume and auto-snooze are opt-in settings, both default off.

Solenta is **at parity or ahead**:
- a quota-wait thread parks and auto-resumes by setting ("Usage limit reached. Resuming at 3pm." with "Resume now" / "Don't auto-resume");
- it has a provider failover chain;
- it has per-provider window bars.

The one small gap is a **"Snooze until reset"** button that combines snooze with the quota reset time.

### Cited Findings
- **T3 derivation:** sidebar status `limited` when `runtime.status === "failed" && lastErrorClass === "usage_limit"`. — [T3 Sidebar.logic.ts:993-995](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/Sidebar.logic.ts#L993)
- **T3 banner:**
  - Title "Usage limit reached"; description `Resets ${new Date(resetAt).toLocaleString()}`, or "Reset time unavailable; retry manually".
  - Actions appear only when `resetAt` is later than the stop time: "Resume at reset" ↔ "Cancel auto-resume", and "Snooze until reset" (shown as "Saving..." while pending).
  - Errors: "The reset time has passed. Retry the thread manually." and "Could not change limit recovery."

  — [T3 UsageLimitRecoveryBanner.tsx:20-98](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/UsageLimitRecoveryBanner.tsx#L20)
- **T3 manual resume:** the empty-composer Play "Resume thread" sends "Continue where you left off." (`manualContinuationOfRunId`). — [T3 ChatView.tsx:8242-8310](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/ChatView.tsx#L8242)
- **T3 settings:**
  - "Auto-resume limited threads": "Resume usage-limit stops at the reported reset time. Each thread can cancel its scheduled continuation."
  - "Snooze limited threads": "Snooze usage-limit stops until the reported reset time. Combine with auto-resume to continue when they wake."
  - Both default false.

  — [T3 SettingsPanels.tsx:2332-2364](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/settings/SettingsPanels.tsx#L2332); [T3 UsageLimitRecoveryWorker.ts:11-115](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts#L11)
- **T3 doc semantics:**
  - "Snooze and auto-resume are independent: snooze alone wakes the thread without sending a message; enabling both wakes and continues it. **Wake now** cancels the snooze."
  - "Sending a new message, archiving, or settling the thread prevents a pending continuation from starting."

  — [T3 docs/user/thread-sidebar.md:187-208](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/user/thread-sidebar.md#L187)
- **T3 custom snooze dialog:** "Custom snooze" / "Choose when snoozed threads return to your inbox.", with a toggle between "Date and time" and "Duration" (Minutes/Hours/Days). Errors: "Choose a valid date and time in the future." / "Enter a positive duration." — [T3 CustomSnoozeDialog.tsx](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/CustomSnoozeDialog.tsx)
- **T3 bugs:**
  - #14169 (open; fix #14889 open): Codex limit banner says "Reset time unavailable; retry manually", disabling both buttons, while Usage → Limits shows the countdown.
  - #15130 (open; fix #15176 open): a thread snoozed until reset reappears early on any metadata bump.
  - #15555 (open): Resume retries Claude after the user picked Codex.

  Open PR #15553 shows scheduled limit recovery in thread lists. — [#14169](https://github.com/pingdotgg/t3code/issues/14169); [#15130](https://github.com/pingdotgg/t3code/issues/15130); [#15555](https://github.com/pingdotgg/t3code/issues/15555); [#15553](https://github.com/pingdotgg/t3code/pull/15553)
- **Solenta quota-wait strip:**
  - "Usage limit reached. Resuming at {3pm | tomorrow 3pm | Mon 9:30am}." (or "…at the reset.").
  - Buttons: "Resume now" (`runs.resumeQuotaWait`) and "Don't auto-resume" (`threads.setQuotaWaitAutoResume(false)`).
  - No countdown.

  — [Solenta ThreadView.tsx:8344-8389](../../src/components/ThreadView.tsx); [Solenta src/quotaWait.ts:17-36](../../src/quotaWait.ts); [Solenta ipc.ts:4074, 4480](../../src/shared/ipc.ts)
- **Solenta sidebar:** a "Quota" label in the attention tone, tooltip "Usage limit reached. Resuming at {clock}.". A quota-wait thread never auto-settles. — [Solenta Sidebar.tsx:560-572, 649-657](../../src/components/Sidebar.tsx); [Solenta src/threadSettle.ts:54](../../src/threadSettle.ts)
- **Solenta settings:**
  - "Continue automatically when usage limit resets" ("Parks a thread until the provider's reset time, then sends the same prompt once. Off = fail the turn.").
  - "Quota failover", per-provider, ordered.
  - Data: `ThreadInfo.quotaWaitUntil / quotaWaitResumed / quotaWaitAutoResume / quotaFailoverTried`.

  — [Solenta SettingsModal.tsx:1426-1499](../../src/components/SettingsModal.tsx); [Solenta ipc.ts:460-475, 2583, 2639](../../src/shared/ipc.ts)
- **Solenta snooze** (`src/threadSnooze.ts`, credited "t3-style"): the same presets as T3 ("In 1 hour", "In 3 hours", "This evening", "Tomorrow", "Next week"), plus the raised-hand early wake and a "Woke" pill. — [Solenta src/threadSnooze.ts:4-9, 72-120](../../src/threadSnooze.ts)

### Inferences
**Verdict: Solenta ahead.** Auto-resume, failover, and a visible resume clock in both the strip and the sidebar tooltip cover T3's Limited features.

**Cheap adoption:** add a "Snooze until reset" button to the quota strip, calling `threads.setSnoozed(quotaWaitUntil)` (ipc.ts:4024, 460). One line in ThreadView; no IPC change.

**Lessons from T3's bugs:**
- Keep the snooze-until-reset wake rule immune to metadata bumps (#15130).
- Make "Resume" honor a provider change made while parked (#15555). Solenta's quota failover may already avoid this; not verified.

### Gaps
- I did not verify whether Solenta's resume after quota wait re-reads the composer's currently selected provider (the analogue of T3 #15555).

## 4. Thread details panel (Git / PRs / merge / lineage / automations), PR watch/settle, and context meter (vs Solenta Thread details, NextGitAction, context ring)

### Takeaway
T3's thread-details card is an inline 280 px aside or a popover. Its sections:
1. Workspace (env selector, branch toolbar, Open-in, scripts);
2. Version Control (branch, PR rows, commit/push/PR);
3. Automations;
4. Lineage.

PR rows rank one action at a time: Resolve, Ready, Fix, or Merge (with a confirm), and show nothing while checks are pending. "Watching" (the agent wakes on PR events) shows only in the linked-PRs right-panel tab.

Solenta is **ahead on git flow**: a one-button NextGitAction with 8 s CI polling, CI-workflow sign-off, PR size split, conflict forecast and post-merge verify. It is **ahead on the context meter**: on by default, an estimated breakdown, and "Fork to fresh context", whereas T3's meter is a legacy setting, off by default.

Solenta **lacks**:
- a lineage/related-threads section in Thread details (plain forks and their children are visible only through sidebar nesting);
- a PR state glyph in the sidebar (only a "#N" link);
- an agent-wakes-on-PR-events "Watching" indicator (whether Solenta has the backend capability is unverified).

### Cited Findings
- **T3 sections and density:**
  - Workspace: optional "Client and server versions differ" warning, environment selector, BranchToolbar, OpenInPicker, scripts.
  - Version Control: branch picker with `ThreadDetailsPrRows`, plus `GitActionsControl`.
  - Automations: "Manage scheduled tasks", per-row edit / "Run now" / pause switch, "Could not load automations: {error}".
  - Lineage.
  - Density is "full", "compact" or "essential" by measured height; Automations and Lineage render only at full.

  — [T3 ThreadDetailsPanel.tsx:116-238](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ThreadDetailsPanel.tsx#L116); [T3 threadDetailsCardLayout.ts:4-45](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/threadDetailsCardLayout.ts#L4); [T3 ThreadAutomationsPanel.tsx](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ThreadAutomationsPanel.tsx)
- **Opening the panel:**
  - Title-bar toggle "Toggle thread details panel" (SquareMenu icon), with a warning dot when the environment is unavailable or versions mismatch.
  - Command `threadPanel.toggle` has **no default keybinding**.
  - Per-thread `{inlineOpen: true, popoverOpen: false}` by default.

  — [T3 PanelLayoutControls.tsx:52-91](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/PanelLayoutControls.tsx#L52); [T3 contracts/keybindings.ts:69](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/keybindings.ts#L69); [T3 rightPanelStore.ts:116-119](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/rightPanelStore.ts#L116)
- **T3 PR row:**
  - Tooltip: `#n`, state, `{base} ← {head}`, checks summary, "Merge conflicts with {base}", diff stat.
  - The checks popover segment is hidden for conflicting or draft PRs.
  - The single trailing action, by rank:
    - "Resolve": "Check the branch out and resolve the conflicts in a new thread"
    - "Ready": "Mark this pull request as ready for review"
    - "Fix": "Fix the failing checks in a new thread"
    - "Merge": "Merge this pull request ({method})"
  - No action while checks are pending.
  - Merge confirm: "Merge pull request?" / "This merges #{n} using {method}." / Cancel / Merge.
  - Release note: "Merge controls follow the current checks."

  — [T3 ThreadDetailsPrRow.tsx:227-446](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ThreadDetailsPrRow.tsx#L227); [T3 pullRequestDetail.logic.ts:414-429](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/pullRequest/pullRequestDetail.logic.ts#L414); [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
- **T3 PR watch (#15057, main):**
  - An Eye icon "Watching" with tooltip "Watching: the agent wakes when checks finish, someone comments, or the branch conflicts".
  - Row menu "Watch for changes" / "Stop watching", in the linked-PRs panel only.
  - Polls every minute and stops on merge or close, after 10 comment-only wakes, or after 15 min of read failures.
  - Open issues: #15362 misses late required gates; #15282 misses bots that edit their review comment in place (fix #15415 open).

  — [T3 ThreadPullRequestsPanel.tsx:133-141, 246-283](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/pullRequest/ThreadPullRequestsPanel.tsx#L133); [T3 docs/user/source-control.md:184-189](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/user/source-control.md#L184); [PR #15057](https://github.com/pingdotgg/t3code/pull/15057)
- **T3 settle:**
  - Server-side auto-settle after 3 days inactive or a merged PR.
  - "Auto-settle behavior" Enabled/Disabled per thread; "Settle thread" / "Un-settle thread".
  - Sweep-drag buttons (#14768).
  - "Only your own messages count as resuming. A turn that finished background work or a pull request watch starts on its own does not."

  — [T3 docs/user/thread-sidebar.md:127-161](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/user/thread-sidebar.md#L127); [T3 threadActionMenu.logic.ts:133-203](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/threadActionMenu.logic.ts#L133)
- **T3 sidebar PR badge:** the state glyph and number, colored by state; it opens the PR list for stacks or multiple PRs. — [T3 ThreadStatusIndicators.tsx:161-336](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/ThreadStatusIndicators.tsx#L161)
- **T3 context meter:**
  - A 20 px SVG ring in the composer footer, error color above 90 %.
  - Hover popover: "Context Window", `{pct} · {used}/{max}`, "Total processed", "Cost", "Compacts automatically at {n} tokens.", and a "Compact context" button when the provider has `/compact`.
  - Setting `contextWindowMeterEnabled` defaults false, listed under "Legacy features" as "Context window indicator (legacy)".
  - Issue #9352 (closed) and open PR #14957 move the toggle out of legacy.

  — [T3 ContextWindowMeter.tsx:21-180](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ContextWindowMeter.tsx#L21); [T3 ContextWindowMeter.logic.ts:100-110](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ContextWindowMeter.logic.ts#L100); [T3 contracts/settings.ts:444](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/settings.ts#L444); [T3 SettingsPanels.tsx:2133-2145](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/settings/SettingsPanels.tsx#L2133); [#14957](https://github.com/pingdotgg/t3code/pull/14957)
- **Solenta NextGitActionButton** (header split-button). States, in order:
  1. "Commit {N} files"
  2. "Push"
  3. "Checking…"
  4. "Retry checks"
  5. "Checks {pass}/{total}" / "Watching checks"
  6. "Checks failed"
  7. "Update from main"
  8. "Merge PR #{N}"
  9. "Create PR"

  CI checks poll every 8 s while watching. CI-workflow merges need sign-off. — [Solenta ThreadView.tsx:2232-2720](../../src/components/ThreadView.tsx); [Solenta src/nextGitAction.ts:160-257](../../src/nextGitAction.ts); [Solenta src/prUi.ts:43-75](../../src/prUi.ts)
- **Solenta Thread details popover:**
  - Tooltip "Thread details · {N} behind upstream".
  - Workspace: worktree, Sandbox, Context.
  - Version control: changed count, sync pill, commit/push/PR.
  - Notes.
  - No lineage section.

  — [Solenta ThreadView.tsx:7285-7500](../../src/components/ThreadView.tsx); screenshot `solenta_thread_details.png`
- **Solenta context ring:**
  - Warns at 0.85.
  - Popover: `{used} / {window}`, a breakdown ("Tool output", "Transcript", "System prompt + tool defs"; "Estimated from the thread (chars÷4)").
  - At warn: "Compaction is close" plus "Fork to fresh context".
  - In the header when warning, otherwise inside Thread details.
  - `/compact` forks to fresh context; it does not compact in place.

  — [Solenta src/contextRing.ts:13-86](../../src/contextRing.ts); [Solenta ThreadView.tsx:288-400, 7284, 7341-7351](../../src/components/ThreadView.tsx); [Solenta src/slashCommands.ts:44-49](../../src/slashCommands.ts)
- **Solenta settle and sidebar PR:**
  - `effectiveSettled`: live/quota threads never settle; pinned never settle; CLOSED settles; MERGED settles when the toggle is on; an OPEN PR blocks; otherwise settle after 3 days.
  - The sidebar PR badge is a plain `#{N}` link with no state glyph or CI dot.
  - Conflict-forecast pill "conflict" / "overlap".

  — [Solenta src/threadSettle.ts:48-101](../../src/threadSettle.ts); [Solenta Sidebar.tsx:774-820, 1408-1420](../../src/components/Sidebar.tsx)
- **Solenta PR/CI data available to the renderer:** `ThreadInfo.prNumber/prUrl/prState/prMergeable/verify/postMergeVerify`; `PrCheckBucket`; `git.prChecks` / `git.prMerge`. — [Solenta ipc.ts:447-449, 673-700, 2080-2094, 4612-4624](../../src/shared/ipc.ts)

### Inferences
**Verdicts**

| Area | Verdict |
|---|---|
| Git/PR controls | Solenta ahead |
| Context meter | Solenta ahead (T3 ahead only on in-place compaction, cost and the auto-compact threshold note) |
| Settle | Parity (Solenta borrowed T3's rules; comments credit "t3's sidebarAutoSettleOnMerge") |
| Lineage in details | Gap |
| Sidebar PR state | Small gap |
| PR-watch wake indicator | Gap, if the backend exists |

**Adoption sketches**
- **Sidebar PR glyph.** Replace the plain `#N` link (`Sidebar.tsx:1408-1420`) with a state glyph colored by `prState` (ipc.ts:673), plus a red dot when `verify` failed (ipc.ts:689) or `prMergeable` is CONFLICTING (ipc.ts:679). All of this data is already on `ThreadInfo`.
- **"Related" section in Thread details.** List parent (`handoffFrom`, ipc.ts:561) and direct children from `threads.summaries` (`ThreadSummaryInfo`, ipc.ts:1093). Use T3's ordering (parent pinned, then newest first) and cap of 6 plus "Show more". This covers plain forks, which the Agents-tab Team excludes (`isDirectCrewChild` requires `orchWorker`).
- **Avoid T3's #15304 trap:** don't hide whole sections by measured density; truncate rows instead.

### Gaps
- I did not verify whether Solenta's main process has any "wake the agent on PR checks/comments" loop equivalent to T3's `watch_pull_request`. Only post-merge verify (`src/verifyCard.ts`) was seen in the renderer.

## 5. Sidebar statuses and the Working section (vs Solenta Working shelf)

### Takeaway
T3's new sidebar status set is approval, input, working (with a live duration), waiting, limited, failed, and ready (shown as "Done" when unread), plus "Woke". The **Working section is beta and off by default**. When on, it:
- folds working or monitoring inbox threads into a collapsed "Working (N)" section;
- orders it by the latest user send;
- reorders the active list by when each thread "came back to you".

Solenta's Working shelf is borrowed from T3 (code comments credit it) and is **ahead**:
- it is always on in Default grouping;
- whole families move together;
- it has extra Delegating / Stalled / Quota states.

The only T3 behaviors Solenta lacks are deliberate design choices (return-order sorting) and a separate Approval vs Input distinction.

### Cited Findings
- **T3 status type:** `"approval" | "input" | "working" | "waiting" | "failed" | "limited" | "ready"`. Derivation:
  1. pending approval → approval
  2. pending input → input
  3. preparing / queued / starting / running / waiting → working
  4. idle with pending background work → waiting
  5. failed → limited or failed

  — [T3 Sidebar.logic.ts:948-997](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/Sidebar.logic.ts#L948)
- **T3 pills:**

  | Pill | Icon | Color / extra |
  |---|---|---|
  | "Working" | CircleDashed | info, plus `Ns/Nm/Nh Nm` timer |
  | "Waiting" | — | muted |
  | "Approval" | ShieldQuestion | warning |
  | "Input" | MessageCircleQuestion | indigo |
  | "Limited" | CircleAlert | warning |
  | "Failed" | CircleAlert | error |
  | "Woke" | AlarmClock | — |
  | "Done" | CircleCheck | success |

  The label is a `role="status"` live region. — [T3 Sidebar.tsx:1258-1311, 2011-2020](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/Sidebar.tsx#L1258)
- **T3 Working section:**
  - Setting `sidebarWorkingShelfEnabled` defaults false. Copy: "Working section (beta)" / "Fold working and monitoring threads into a Working section. They return to the top of the inbox when they need you."
  - Membership excludes threads with a pending approval or input; failed and limited threads stay in the inbox.
  - Header "Working" / `Working (${n})`, collapsed by default; the open thread's row still shows when collapsed.
  - Ordered by newest user-authored send (#15418: finishing or waking doesn't move rows).
  - You cannot drop a thread into it.

  — [T3 contracts/settings.ts:463-468](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/contracts/src/settings.ts#L463); [T3 SettingsPanels.tsx:2366-2391](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/settings/SettingsPanels.tsx#L2366); [T3 threadInbox.ts:20-145](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/threadInbox.ts#L20); [T3 Sidebar.tsx:5299-5314](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/Sidebar.tsx#L5299); [PR #15418](https://github.com/pingdotgg/t3code/pull/15418)
- **T3 doc:**
  - "A thread returns to the top of the active list when it finishes, fails, or needs an approval or answer. The Working section lists the thread you last sent work to first."
  - "While this is on, the active list is ordered by when each thread last came back to you, so you cannot drag or move threads within it."

  — [T3 docs/user/thread-sidebar.md:115-125](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/user/thread-sidebar.md#L115)
- **T3 release history:** web beta in v0.0.45 (#13926, 2026-10-01); mobile in .2644 (#15346). — [v0.0.45](https://github.com/pingdotgg/t3code/releases/tag/v0.0.45); [.2644](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261004.2644)
- **T3 bugs:**
  - #15258 (open; fix #15430 open): async questions make a running thread show "Input" / "Awaiting Input", with no Working timer, and it drops off the Working shelf.
  - #15239 (open): after Settle stops a background server, the thread still shows "Waiting" with a dead Stop.
  - #15572 (open): live sidebar updates move row action targets under the pointer, so a Snooze/Settle click can land on another thread.
  - #15238 (open): running dev servers are not shown in the new sidebar.
  - Open PRs: #15413 / #15315 keep threads in Working while background commands run.

  — [#15258](https://github.com/pingdotgg/t3code/issues/15258); [#15239](https://github.com/pingdotgg/t3code/issues/15239); [#15572](https://github.com/pingdotgg/t3code/issues/15572); [#15238](https://github.com/pingdotgg/t3code/issues/15238)
- **Solenta status precedence** (`statusLabelFor`):
  1. "Failed"
  2. "Quota"
  3. "Waiting" (awaitingInput, tooltip "Waiting for input")
  4. "Stalled" ("Stalled 4m")
  5. "Waiting" (a child is blocked)
  6. "Working {elapsed}"
  7. "Delegating" (done/idle with live children)
  8. "Woke"
  9. "Queued"
  10. "Done" (unread)
  11. otherwise the relative age

  — [Solenta Sidebar.tsx:539-741](../../src/components/Sidebar.tsx); [Solenta src/waiting.ts:125-130, 211-225](../../src/waiting.ts)
- **Solenta Working shelf:**
  - Shown only with group-by Default and when non-empty; collapsed by default (`sidebar:workingOpen`); header `Working ({N})`.
  - The active thread is carved out (visible even when collapsed); auto-expands while filters are on.
  - Contents: quietly-working families, in createdAt order ("activity never reorders it").
  - Code credits T3: "T3-style flat sidebar" (`sidebarGroups.ts:335`), "T3 inbox: the shelves sit at the foot of the list." (`Sidebar.tsx:4139`).

  — [Solenta src/sidebarGroups.ts:335-473](../../src/sidebarGroups.ts); [Solenta Sidebar.tsx:4115-4170](../../src/components/Sidebar.tsx)

### Inferences
**Verdict: Solenta ahead.**
- **Solenta extras:** Delegating, Stalled and Quota states; family-level shelving; always-on. T3's section is still beta and per-device.
- **Possible small adoptions:**
  - Split Solenta's single "Waiting" into "Approval" (`pendingPermission` on `ThreadDetail`, ipc.ts:1707) vs "Input" (`awaitingInput` / `pendingQuestion`, ipc.ts:498-507), with different icons. This helps triage, since an approval is usually a one-click action.
  - Port T3's live-region `role="status"` on the status label.
- **Risk to check in Solenta:** #15572 (row actions shifting under the pointer as threads move between Working and Active). Solenta's createdAt ordering avoids reorder-on-activity, but shelf membership changes still shift rows.
- **Do not copy** return-order sorting. It conflicts with Solenta's deliberate "activity never reorders" rule, and T3 needed #15418 to stop it jittering.

### Gaps
- I did not test whether Solenta's sidebar has the #15572 pointer-shift problem; that needs a live session with several threads changing state.

## 6. Fork, merge-back and handoff UI (banner, pending-context notice PR #15092)

### Takeaway
T3 (main) offers:
- **"Fork from this response"** on every eligible assistant message;
- a "Forked from conversation" timeline divider, with no banner;
- a **Merge-back** split button on the parent row in Lineage ("Merge this conversation back into {parent}"), with no confirm, which navigates to the parent;
- a "Context handoff" divider with from→to model chips.

There is **no pending-context notice on main**. PR #15092 (open) adds "Merged back from <fork> / Its context will be included in your next message", fixing #15063 ("no sign it worked until the next message").

Solenta has richer **git**-level landing: Integrate, then Land; Best-of-N; divergence compare. But it has **no message-level fork point** and **no conversational merge-back**. Context returns to the source only through the worker-notice path or the git merge.

### Cited Findings
- **T3 fork from a response:**
  - `aria-label` / tooltip "Fork from this response". Shown for completed assistant messages when native fork or full-thread handoff is supported.
  - Dispatches `thread.fork` with `sourcePoint {type:"run"}` and title "{title} fork".
  - Errors: "Failed to fork this response." / "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar."

  — [T3 MessagesTimeline.tsx:2537-2580](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/MessagesTimeline.tsx#L2573); [T3 ChatView.tsx:8125-8160](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/ChatView.tsx#L8125)
- **T3 forked thread display:** divider "Forked from conversation" with action "Open source conversation". The banner stack has no fork item. — [T3 V2LifecycleRow.tsx:159-169](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/V2LifecycleRow.tsx#L159); [T3 ChatView.tsx:7373-7440](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/ChatView.tsx#L7373)
- **T3 merge-back:**
  - aria "Merge back to {parentTitle}".
  - Tooltip "Merge this conversation back into {parentTitle}", or (disabled) "Complete a run in this fork before merging it back".
  - Eligible run: the newest waiting or completed run, with no newer active run.
  - Dispatches `thread.merge_back`, then navigates to the parent.

  — [T3 ThreadRelationshipsControl.tsx:432-490](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/ThreadRelationshipsControl.tsx#L465); [T3 threadWorkflows.ts:48-64](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/threadWorkflows.ts#L48)
- **T3 handoff:**
  - Divider "Context handoff" with from→to model chips (danger tone on failure).
  - Inspector shows `{from} → {to}` and `{strategy} · {status}`.
  - Handoff budget: `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP`, default 16,000.
  - Release note: "The handoff is lossy…"
  - Open issue #15476: the divider omits account badges, so "Claude Opus 5.5 → Claude Opus 5.5" looks like a no-op (fix #15477 open).

  — [T3 V2LifecycleRow.tsx:122-158](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/web/src/components/chat/V2LifecycleRow.tsx#L122); [T3 docs/user/portable-handoffs.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/user/portable-handoffs.md); [#15476](https://github.com/pingdotgg/t3code/issues/15476)
- **(open PR) #15092** "fix(chat): merging a fork back shows a pending-context notice":
  - New `resolvePendingMergeBack` in client-runtime `threadRelationships.ts`.
  - Composer notice: "Merged back from <fork> / Its context will be included in your next message", or "…once this thread is idle" while a run is active.
  - A warning when more than one fork is pending, since the server rejects sends in that state.
  - No dismiss; it clears when the next run consumes the transfer.
  - Not on main: no matching commit or strings.

  — [PR #15092](https://github.com/pingdotgg/t3code/pull/15092); [#15063](https://github.com/pingdotgg/t3code/issues/15063)
- **Solenta fork entry points:**
  - sidebar menu "Fork" / "Hand off · {provider}";
  - Environment card "Fork" / "Hand off to…" (disabled while working);
  - `/fork`, `/compact` (fork to fresh), `@provider` delegation, `/bestof`, `/handoff`, `/advisor`, `/committee`.

  The per-message actions are "Edit and resubmit", Pin, Copy, Reply, "Cite selection" and "Wait, what?". **There is no "fork from here"** (screenshot `solenta_main_view.png`). — [Solenta AgentsPanel.tsx:636-755](../../src/components/AgentsPanel.tsx); [Solenta src/slashCommands.ts:44-49, 112-127](../../src/slashCommands.ts); [Solenta src/delegate.ts:18-31](../../src/delegate.ts)
- **Solenta forked-thread banner:** "Forked from <source title>" (link), with a dismiss "×" ("Dismiss handoff banner"), or "Forked from a deleted thread". — [Solenta ThreadView.tsx:7838-7870](../../src/components/ThreadView.tsx)
- **Solenta merge paths are git-only:**
  - worker header "Merge onto {base}";
  - lead Integration "Integrate into {leadBranch}", then "Merge into {target}" / "Open PR".
  - There is no "Merge back" string in `src/`.

  — [Solenta src/components/CrewIntegration.tsx:142-296](../../src/components/CrewIntegration.tsx); [Solenta src/crewIntegration.ts:46](../../src/crewIntegration.ts)
- **Solenta fork API:** `ThreadForkOpts` = `{provider, model, worktree, isolate, leadSnapshot*}`, with no message cut point. — [Solenta ipc.ts:3567, 4234](../../src/shared/ipc.ts)

### Inferences
**Verdict.**
- **Solenta ahead:** git integration and landing.
- **Gap:** message-level fork, and conversational merge-back with visible pending-context feedback.

**Adoption sketch (gap #5 in section 8)**
- **Fork from here.** Add a "Fork from here" icon to the assistant-message action row (next to Pin/Reply). It calls `threads.fork` with a new `ThreadForkOpts.fromMessageId` so the fork's context digest is cut at that message. `editResubmit.ts` already does truncation-style logic, which may be reusable (unverified).
- **Merge-back.** On a thread whose `handoffFrom` is set (ipc.ts:561), show a "Send findings back to <source>" action. It produces a digest of the fork's final answer and enqueues it on the source via the existing inbound path (`threads.setQueued` with `fromThread`, ipc.ts:627-649).
- **Pending notice.** The source renders a T3-#15092-style notice: "Merged back from <fork>. Included in your next message."
- **Avoid T3's #15063.** Show feedback immediately on the source, not after the next send.

### Gaps
- I did not verify how Solenta's fork context digest is built in the main process. A `fromMessageId` cut needs main-process support.

## 7. Mobile and remote supervision (T3 mobile beta Agents sheet vs Solenta web mode, pairing issues #151 and #287)

### Takeaway
T3's native mobile app (V2 needs the beta build) gives, per thread:
- a **floating agents pill** (`{live}/{total}`, or `{n} done`) that opens an **Agents sheet**: run-scoped, no cap, rows with status dot, title, elapsed time, account · model, and a 3-line progress/result;
- a queue pill and sheet;
- a composer Stop.

Across threads it gives a **Live Activity / ongoing notification** of up to 5 rows ("2 active agents · 1 needs attention"). Pairing is a QR code or one-time link (`t3 pair`), or T3 Connect. Push requires T3 Connect.

The mobile sheet has **no stop** (open issue #14655).

Solenta has:
- a token-gated web mode (`--serve-web`, paste a 43-char token, no QR, no TLS, no push);
- a responsive 900 px layout with drawer sidebar and agents panels;
- desktop notifications plus a webhook (ntfy/Slack).

QR pairing (#151) and a PWA companion (#287) are open plans.

### Cited Findings
- **T3 agents pill:**
  - Label `{live}/{total}` (accessibility "{live} of {total} agents working") or `{total} done`.
  - Hint "Opens this turn's subagents".
  - Opens the `ThreadAgents` form sheet (detents 0.5 / 0.9).

  — [T3 threadSubagents.ts:41-90](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/client-runtime/src/state/threadSubagents.ts#L74); [T3 mobile Stack.tsx:775-783](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/mobile/src/Stack.tsx#L775)
- **T3 Agents sheet:**
  - Title "Agents"; empty state "No agents in this turn."
  - Rows: status dot, title (falling back to the prompt cut at 80 chars), status label, elapsed time, a chevron, `{account} · {model}`, Branch/Worktree chips, and up to 3 lines of detail (rose when failed).
  - Labels: "Working", "Waiting", "Idle", "Completed", "Failed", "Cancelled", "Interrupted".
  - A tap opens the child thread. Provider-native rows have the hint "Provider-managed agent. Its work appears in the transcript."
  - #15189 "show complete subagent details" is on main.

  — [T3 ThreadAgentsSheet.tsx](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/mobile/src/features/threads/ThreadAgentsSheet.tsx); [T3 SubagentRow.tsx:36-93](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/mobile/src/features/threads/SubagentRow.tsx#L36); [T3 threadAgentsPresentation.ts:40-58](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/mobile/src/features/threads/threadAgentsPresentation.ts#L40); [PR #15189](https://github.com/pingdotgg/t3code/pull/15189)
- **T3 mobile stop:** only the composer's "Stop agent" button (`run.interrupt`). #14655 (open): "Mobile has no way to stop background work after the turn settles". — [#14655](https://github.com/pingdotgg/t3code/issues/14655)
- **T3 Live Activity:**
  - Header `{n} active agent(s)` plus ` · {n} need(s) attention`; "Agent work completed" / "Agent work failed"; stale state "Agent status out of date".
  - Rows ordered attention → failed → running → done.
  - Compact trailing labels "Approval" / "Input" / `{n} active` / "Done" / "Failed".
  - Finished rows linger 15 minutes; at most 5 rows.
  - Subagent threads are excluded.
  - Deep link `t3code://threads/{env}/{thread}`.

  — [T3 apps/mobile/src/widgets/AgentActivity.tsx:22-176](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/mobile/src/widgets/AgentActivity.tsx#L22); [T3 infra/relay/src/agentActivity/agentActivityAggregate.ts:14-61](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/infra/relay/src/agentActivity/agentActivityAggregate.ts#L14); [T3 packages/shared/src/agentAwareness.ts:62](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/shared/src/agentAwareness.ts#L62)
- **T3 pairing and push:**
  - T3 Connect (sign in, pick an environment), or direct pairing via `t3 pair` / `t3 pair --tailscale` with a QR or one-time link per device; sessions are revocable.
  - Device Notifications and Live Activity require T3 Connect plus agent-activity publishing.

  — [T3 docs/user/remote-access.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/user/remote-access.md); [T3 docs/user/mobile-notifications.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/user/mobile-notifications.md); [T3 docs/user/devices.md](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/user/devices.md)
- **T3 rollout:**
  - "V2 servers only accept V2 clients… Join the beta" (TestFlight / Play).
  - No 2.0.0 GitHub release exists; issue #15098 cites "iOS App 2.0.0 (103)".
  - Android testers were stuck on 1.4.0 until they rejoined (#14871 comments).
  - Open Android sheet-corner PRs: #14925, #14934.

  — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610); [#14871](https://github.com/pingdotgg/t3code/issues/14871)
- **Solenta web mode:** `WebTokenGate`, "Connect to Solenta" / "This browser session needs the token printed when the web server started." / "Session token". The `wireClient` WebSocket queues up to 64 offline requests and backs off 1–30 s. — [Solenta src/components/WebTokenGate.tsx:13-97](../../src/components/WebTokenGate.tsx); [Solenta src/wireClient.ts](../../src/wireClient.ts)
- **Solenta pairing:** exists for **MCP clients**, not phones. `PairingCapability` is read / launch / steer / read_all; "Pairing launch" approval card ("Approve" / "Don't run"). No QR anywhere in `src/`. — [Solenta ipc.ts:2887-2932, 3698-3703](../../src/shared/ipc.ts); [Solenta ThreadView.tsx:3015-3075](../../src/components/ThreadView.tsx)
- **Solenta responsive layout:** at `(max-width: 900px)`, single column, with the sidebar and agents panel as slide-in drawers (`min(300px,88vw)` / `min(380px,92vw)`). `hover: none` keeps hover-only actions visible. — [Solenta App.tsx:124-136](../../src/App.tsx); [Solenta App.module.css](../../src/App.module.css)
- **Solenta notifications:** desktop only, plus `WebhookSettings {url, onDone, onFailed, onWaiting}` for ntfy/Slack/Discord. No web push or service worker. — [Solenta ipc.ts:2595, 2701](../../src/shared/ipc.ts)
- **Solenta #151** (open, plan:todo), "Phone pairing UX: QR code, one-time tokens, revocable device sessions". A 2026-10-02 comment names T3 commit 54084ae (a one-use 5-minute grant becomes a revocable 30-day device session, plus a short-lived WS ticket) as the model. — [currentbits/solenta#151](https://github.com/currentbits/solenta/issues/151)
- **Solenta #287** (open, plan:todo), "Mobile companion: PWA with lock-screen progress, approve-from-phone, offline queue". Comments favor:
  - the phone for intent and approvals, the desktop for review;
  - notifying only on judgment calls;
  - a direct tailnet/LAN connection over a relay;
  - quota visibility on the phone.

  — [currentbits/solenta#287](https://github.com/currentbits/solenta/issues/287)

### Inferences
**Verdict: Gap.** It is large, but tracked in #151 and #287.

**Cheapest supervision wins before the full PWA:**
1. **Narrow-layout agents pill above the composer.** Show `{live}/{total}` from `thread.subagents` (ipc.ts:771) plus direct-child `ThreadSummaryInfo` (ipc.ts:1093), and open the existing agents drawer.
2. **QR pairing.** Render the existing web token as a QR in Settings: reuse the `--serve-web` token, and replace it later with #151's one-time grant.
3. **Phone alerts.** Point the existing `onWaiting` / `onFailed` webhook at ntfy as the interim phone notification (no new code).

**Lessons from T3:**
- Exclude subagent threads from phone notifications (T3 `agentAwareness.ts:62`).
- Put a Stop for background/delegated work on the phone from day one (T3 #14655).

### Gaps
- I did not test Solenta's narrow layout on a phone-sized viewport for the queue and quota strips. The screenshots were taken at 1500x950 only.

## 8. Top 5 UX gaps ranked by user value, with adoption sketches

### Takeaway
Ranked by user value for someone supervising many agents in Solenta:
1. Subagent cards and rich subagent rows.
2. A named "Waiting on … / Stop" banner for delegated work, plus per-worker Stop.
3. Queue upgrades: per-row steer, a held explanation, inbound marking, two shortcuts.
4. Remote/mobile supervision: agents pill, QR pairing, phone alerts.
5. Message-level fork plus conversational merge-back with a pending-context notice.

Near misses: a sidebar PR state glyph and CI dot; a "Related" section in Thread details; "Snooze until reset" on the quota strip; an Approval vs Input split.

Solenta is already ahead on the Working shelf, quota wait, context ring, git landing, and crew orchestration.

### Cited Findings
**Feature-by-feature verdicts** (T3 main unless noted)

| T3 feature | T3 location | Solenta closest | Verdict |
|---|---|---|---|
| Lineage panel ("Lineage · N running", groups, cap 6 / +12, hover card) | `ThreadRelationshipsControl.tsx:68-428` | AgentsPanel Team/Subagents `AgentsPanel.tsx:2705-3119`; sidebar families `sidebarGroups.ts:74-136` | Crew: Solenta ahead. In-session subagents: **gap** |
| Inline subagent group cards | `MessagesTimeline.tsx:2959-3104`, `V2LifecycleRow.tsx:395-525` | generic `ToolGroupRow` `ThreadView.tsx:1075-1156` | **Gap** |
| Stop from Lineage | not on main (open #15211); background banner Stop `ChatView.tsx:7068-7171` | status-strip Stop for the selected thread only `ThreadView.tsx:8391-8408` | **Gap** (banner pattern) |
| Read-only child threads | `ProviderSubagentBar.tsx:55-91` | crew-worker banner `ThreadView.tsx:7815-7837`; subagents not navigable | Parity (different model) |
| Mobile agents sheet / Live Activity | `ThreadAgentsSheet.tsx`, `AgentActivity.tsx` | 900 px drawers, token gate, webhook | **Gap** |
| Thread details (Workspace / Git / Automations / Lineage) | `ThreadDetailsPanel.tsx:116-238` | Thread details popover `ThreadView.tsx:7285-7500` | Parity. Lineage section: small gap |
| PR merge controls follow checks | `ThreadDetailsPrRow.tsx:227-446` | NextGitAction `nextGitAction.ts:160-257` | Solenta ahead |
| PR watch "Watching" (agent wake) | `ThreadPullRequestsPanel.tsx:133-141` (#15057) | none seen in renderer | Gap (backend unverified) |
| Sidebar statuses | `Sidebar.logic.ts:948-997` | `Sidebar.tsx:539-741` | Solenta ahead (Delegating / Stalled / Quota); T3 splits Approval vs Input |
| Working section (beta) | `threadInbox.ts:20-145` | Working shelf `sidebarGroups.ts:438-473` | Solenta ahead |
| Editable queue, steer vs queue, ⌘Enter inversion | `QueuedRunsControl.tsx`, `composerDispatch.ts:11-21` | queued strip `ThreadView.tsx:8411-8702`, Queue/Steer toggle `Composer.tsx:3392-3424` | Parity with gaps (per-row steer, held label, inbound marking, shortcuts) |
| Resume for held queues | Play "Resume thread" `ComposerPrimaryActions.tsx:254-256` | "Send now" with no explanation | Small gap |
| Limited, resume-at-reset, snooze | `UsageLimitRecoveryBanner.tsx:20-98` | quota strip `ThreadView.tsx:8344-8389` | Solenta ahead; "Snooze until reset" missing |
| Live context meter | `ContextWindowMeter.tsx` (legacy, off by default) | context ring `contextRing.ts`, `ThreadView.tsx:288-400` | Solenta ahead |
| Fork from response / merge-back / handoff divider | `MessagesTimeline.tsx:2573`, `ThreadRelationshipsControl.tsx:432-490`, `V2LifecycleRow.tsx:122-169` | thread-level fork, "Forked from" banner, git-only merge | **Gap** (message fork, context merge-back) |

T3 paths are under `apps/web/src/components/` or `packages/client-runtime/src/state/` at [eac52f0](https://github.com/pingdotgg/t3code/tree/eac52f0087d9ba5dee5542f24788d1482affae43). Solenta paths are under [src/](../../src/). See sections 1–7 for line-level citations.

### Inferences
**1. Subagent visibility: inline group card plus rich rows** (highest value; Claude Agent tool calls are frequent and today they are buried in "Used N tools")
- **Components:**
  - a new `SubagentGroupRow` in ThreadView, picked when a tool group is all Agent/Task calls (`toolGroups.ts:32`);
  - an extended `TeamRow` for subagents in `AgentsPanel.tsx:3094-3119`;
  - a section title `Subagents · N running`.
- **Copy to borrow:** `{n} subagents`, "2 working · 1 done", the group timer, "Idle · resumable".
- **Data:**
  - Add `startedAt`, `completedAt`, `model?` and `resultPreview?` to `SubagentInfo` (ipc.ts:1077). The runner already tracks Agent tool calls (ipc.ts:766-771).
  - Crew workers already have `runStartedAt` / `stoppedAt` in `ThreadSummaryInfo` (ipc.ts:1093), so elapsed time on worker rows needs no IPC change.
- **Avoid T3's bugs:** null usage (#15429) and a stale "Done" (#13331 / #15334). Derive row status from the live thread, not a cached record.

**2. Named delegated-work banner with Stop, plus per-worker Stop**
- **Components:** a composer-adjacent banner on the lead whenever `isDelegating` (`waiting.ts:125-130`) or a WaitLine exists:
  - text "Waiting on 2 workers · 1 subagent";
  - each worker name a link (`onSelectThread`);
  - a "Stop workers" button.
- **Per-row Stop** on working TeamRows.
- **Data/IPC:** `runs.stop` (ipc.ts:4474) per child id from `threads.summaries` (ipc.ts:3854); `buildWaitStates` (`waiting.ts`).
- **Limits:**
  - In-session Agent-tool subagents can only be stopped via the parent's Stop.
  - T3 itself only has the banner-level Stop on main (#15211 is open), so this would put Solenta ahead.

**3. Queue: per-row steer, held explanation, inbound marking, shortcuts**
- **Component:** the queued strip, `ThreadView.tsx:8411-8702`.
- **Data:**
  - `ProviderInfo.supportsSteer` (ipc.ts:2403)
  - `runs.steer` (4446)
  - `threads.setQueued replace:true` (4010)
  - `queued.fromThread` / `inbound` (644-646; currently unused)
  - `ThreadInfo.status` / `stoppedAt` (450, 490)
- **Value:** you can redirect a running agent with a pre-typed follow-up in one click, and a queue sitting idle after Stop stops looking like a bug.

**4. Remote/mobile supervision**
- **Components:** a narrow-layout agents pill (`{live}/{total}`) opening the existing agents drawer; a QR of the web token in Settings (stepping stone to #151); ntfy via the existing webhook (ipc.ts:2701) for phone alerts.
- **Data:** `thread.subagents`, `ThreadSummaryInfo`, `PairingInfo` types (ipc.ts:2887-2932) for future device sessions.
- **Effort:** highest of the five; already planned in #151 and #287.

**5. Fork from a response, plus merge-back with a pending-context notice**
- **Components:**
  - a "Fork from here" icon in the assistant message action row;
  - "Send findings back to <source>" on forked threads;
  - a pending notice on the source ("Merged back from <fork>. Included in your next message."), borrowed from T3's open PR #15092.
- **Data:** a new `ThreadForkOpts.fromMessageId` (ipc.ts:3567); the merge-back reuses the inbound queue path (`queued.fromThread`, ipc.ts:644).

**Near misses** (cheap, lower value)
- Sidebar PR state glyph and CI dot from `prState` / `prMergeable` / `verify` (ipc.ts:673-700).
- A "Related" list in Thread details for plain forks (`handoffFrom`, ipc.ts:561).
- "Snooze until reset" (`threads.setSnoozed(quotaWaitUntil)`, ipc.ts:4024 / 460).
- Approval vs Input split in sidebar statuses.

**Solenta code-level nits found along the way**
- AgentsPanel comment says the poll is 2 s, but `SUMMARY_POLL_MS` is 5 s (`AgentsPanel.tsx:2761` vs `:819`).
- `crewSummaryLabel` now calls plain forks "workers" (since b149eba3), while the "Workers (N)" button counts orchWorkers only.
- `CrewIntegration.tsx:12-31` duplicates `crewIntegration.ts:60-99` with a different integrate rule.

### Gaps
- **Ranking basis.** The ranking is my judgment of user value from the code and bug stream. No Solenta usage data was available.
- **Screenshots.** They show only the idle demo state (sidebar, Agents tab with Workflow/Tasks/Hypotheses, Thread details popover). The queue strip, quota strip and nested families were not captured, because the demo thread was not in those states and I stopped after the quick pass. They also come from another worktree's dev server, on a branch with an unmerged palette restyle (#1429).
- **T3 history.** The shallow clone prevents attributing pre-2026-09-22 origins (for example the context meter's original PR). The squash #2829 hides the individual V2 PRs: #12835 (removed the agents panel), #12842 (lineage hover cards), #12677 / #12686 / #12687 (Limited, resume at reset, snooze until reset). The GitHub research saw these as targeting the V2 branch; whether #12677 / #12686 / #12687 reached main individually is unverified, but the features are on main.
