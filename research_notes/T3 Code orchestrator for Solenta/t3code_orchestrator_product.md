# T3 Code "Orchestrator 2.0" (officially "T3 Code Orchestrator V2"): product, features, UX, reception (as of 2026-10-04)

## What is "Orchestrator 2.0", what is it called, and when and in what state did it ship?

### Takeaway
It exists. The official name is **"T3 Code Orchestrator V2"**, also written "Orchestration V2" or "orchestration protocol 2". Nobody officially calls it "2.0". The only "2.0.0" is the version number of the V2-compatible mobile beta app. V2 rewrites the server layer that runs agents. It was developed in PR #2829 (opened 2026-05-27), merged to `main` on 2026-10-02, and first shipped in nightly **v0.0.46-nightly.20261003.2610** on 2026-10-03 at 01:10 UTC. As of 2026-10-04 it is **nightly-only, with no stable release**. The latest stable, v0.0.45 (2026-10-02), is still V1.

### Cited Findings
- **Name and scope.** From the release notes: "This nightly is the first build of T3 Code Orchestrator V2. V2 rebuilds the part of T3 Code that runs your agents: how turns start, stop, queue, and resume; how subagents and background work are tracked; how threads move between providers; and how history is saved." — [Release v0.0.46-nightly.20261003.2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
- **Release date and type.** That release was published 2026-10-03T01:10:51Z and is marked as a prerelease. It ships commit `8ed276c246b6`. — [Release v0.0.46-nightly.20261003.2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
- **The PR.**
  - PR #2829 "feat(orchestrator): introduce new orchestrator" is by Julius Marminge (`juliusmarminge`).
  - It was created 2026-05-27 and merged 2026-10-02T19:22Z, so it ran about 4 months as a draft branch.
  - Size: +380,729 / −203,651 lines across 1,912 files.
  - The description says it closes roughly 80 existing issues, sorted into "high confidence" and "medium confidence" groups.

  — [PR #2829](https://github.com/pingdotgg/t3code/pull/2829)
- **Stable is still V1.** The latest stable is v0.0.45, published 2026-10-02T18:17Z, about an hour *before* the V2 merge. The V2 nightlies since then are .2610, .2623, .2632, .2638 (all 2026-10-03) and .2644 (2026-10-04T03:41Z). — [Releases list](https://github.com/pingdotgg/t3code/releases)
- **Pinned migration issue.** Julius filed #14871 "[IMPORTANT] Moving from T3 Code Orchestrator V1 to V2" on 2026-10-02T20:03Z.
  - It said V2 was "SOON (est. 3am UTC) out in nightly builds".
  - It says the team will "keep it updated as V2 moves toward a stable release".
  - On mobile: "Mobile store releases will move to V2 when V2 reaches stable."

  — [Issue #14871](https://github.com/pingdotgg/t3code/issues/14871)
- **Mobile beta version.** The V2-compatible mobile app is version 2.0.0 (Android versionCode 77), distributed through TestFlight and a Play beta track. The V1 store app is 1.4.0 (versionCode 74). — [Issue #14871 comments](https://github.com/pingdotgg/t3code/issues/14871); [Issue #15098 "iOS App 2.0.0 (103)"](https://github.com/pingdotgg/t3code/issues/15098)
- **Earliest public mention found.** On 2026-08-06 Theo tweeted: "We're trying to get a big overhaul of the orchestration layer (aka Orchestrator V2) shipped, and it was blocking a lot of this work. Made the decision to ship visualization early…" — [Theo on X, status 2085238155746406605](https://x.com/theo/status/2085238155746406605). The date is decoded from the tweet ID. The full text could not be fetched because X returned HTTP 402; the quote is the search snippet.
- **Theo's merge-day tweet** (2026-10-02 ~20:47Z, date decoded from ID): "Things included in this PR: - Pi support. - Auto-resume when limits reset - T3 Code MCP (create, launch, message, wait on, read, search and interrupt threads) - `delegate_task` lets an agent start child agents on any provider or model - ACP Registry: add any registry agent (Dev…" — [Theo on X, status 2106123856759120317](https://x.com/theo/status/2106123856759120317). Snippet only.
- **"Preview" builds before merge.** Maintainers cut preview builds "from unreleased branches to exercise the release pipeline". They "are never offered as updates, and are not supported". An example is v0.0.46-preview.20261002.2598, about 2 h before the nightly. — [Release v0.0.46-preview.20261002.2598](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-preview.20261002.2598)
- **People ran the branch early.** Users ran personal forks on the V2 branch before the merge. One example is issue #13331 (2026-09-24): "Five bugs found while running the orchestrator v2 branch (#2829) day to day". A search result also lists a "fork for orchestrator v2 testing" repo. — [Issue #13331](https://github.com/pingdotgg/t3code/issues/13331); [Young-caveman/t3code](https://github.com/Young-caveman/t3code)

### Inferences
- Shipped status as of 2026-10-04: **shipped in nightly, about 1.5 days old**. It is not in stable, and the mobile store apps are not V2. Over the first 30 hours the team pushed 4 more nightlies, mostly V2 fixes, which matches the release note's "We'll be polishing this over the next few days".
- From a user's point of view, "Orchestrator V2" is less one orchestrator feature than a platform release: a new agent runtime plus a bundle of features built on top of it.

### Gaps
- No official stable-release date or roadmap was found.
- The "(LINK)" placeholder to the release notes in #14871 was never filled in.
- I could not read the full tweet texts or reply threads (X paywall/402).

## What was V1, and what changed and why?

### Takeaway
V1 was the server-side, event-sourced orchestration engine added in Feb 2026 (PR #89). It moved app state from the client to a server SQLite event log. Its weaknesses were a long list of race and lifecycle bugs, all rooted in modelling provider sessions loosely:
- provider IDs used as app identity;
- subagent output spliced into the parent stream;
- queues that did not survive restarts;
- parents that were never woken when delegated children finished;
- Stop not ending background work.

V2 is a rewrite of the orchestrator only. It keeps the rest of the app platform and introduces:
- one execution graph: thread → run → execution nodes → provider threads;
- app-owned IDs;
- capability-driven provider adapters;
- first-class lineage (fork, merge-back, subagent, provider handoff).

### Cited Findings
- **V1 origin.** PR #89 "Add server-side orchestration engine with event sourcing" by juliusmarminge (created 2026-02-22, merged 2026-02-26). It "Introduces event-sourced orchestration engine on the server with SQLite-backed persistence; Moves state management from client to server". Clients send commands only, and the server emits domain events to a read model that is pushed to clients. It was followed by PR #103 "orchestration core and Codex plumbing" (created 2026-02-27, merged). — [PR #89](https://github.com/pingdotgg/t3code/pull/89); [PR #103](https://github.com/pingdotgg/t3code/pull/103)
- **Stated V2 goals** (design-doc README):
  - "Preserve provider-native lifecycle fidelity without leaking provider ids into app identity."
  - "Model root turns, subagents, tools, approvals, plans, and checkpoints as one execution graph."
  - "Make root-run completion the only event that completes a user-visible turn."
  - "Support forking from normal threads and completed subagent/provider threads."
  - "Support changing providers between runs as a first-class context handoff."
  - "Make feature behavior capability-driven, not provider-name-driven."

  — [docs/orchestration-v2/README.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/README.md)
- **Scope of the rewrite.** "V2 is an orchestrator rewrite, not a rewrite of the whole app domain platform… V2 is designed around the real provider behavior observed in the Codex app-server probes… Codex is treated as the richest protocol we currently have; weaker providers are adapted into the same model with app-owned ids and explicit capability flags." — [docs/orchestration-v2/README.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/README.md)
- **Key invariants:**
  - "Child execution completion never closes the parent run."
  - "Provider switches create explicit context handoff artifacts; they are not hidden prompt hacks."
  - "Forks record app-level lineage first."

  — [docs/orchestration-v2/README.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/README.md)
- **V1 pain points named in the PR's "Closes" list.** Each line gives the V2 fix:
  - message identity keyed on provider-supplied IDs (#871);
  - queue not owned by the server or not preserved across restart (#4673, #5436, #12100);
  - "V2 tracks delegated children in projections and wakes the parent when they finish" (#2778);
  - Codex subagents not showing in the Agents panel (#8499);
  - subagent text spliced into the parent stream rather than shown as lineage nodes (#2477);
  - token usage that was wrong after compaction (#4650);
  - Stop not ending retained background work (#11428);
  - interrupted threads not continuing after restart (#10928);
  - no distinct "Limited" state when usage limits hit (#10545);
  - Cursor run through the CLI/ACP instead of the official SDK (#10480, #7244).

  — [PR #2829](https://github.com/pingdotgg/t3code/pull/2829)
- **Visualization shipped before V2.** Theo (2026-08-06) said they "Made the decision to ship visualization early and break the giant pile of code on top". In a follow-up: "This gives you everything other than 'what work is this thread actually doing' - that will come with Orchestrator V2 (along with a LOT of other fun things)". — [Theo on X 2085238155746406605](https://x.com/theo/status/2085238155746406605); [Theo on X 2085238441667940728](https://x.com/theo/status/2085238441667940728). Snippets only.
- **Removed or changed in V2:**
  - "The separate agents panel is gone. Subagents appear in the lineage view and inline in the thread."
  - "Workspace, Git, and script controls moved into thread details."
  - "The token-by-token streaming setting is gone."
  - "Grok no longer offers Auto-accept edits."
  - "Subagent threads are read-only. Message the parent thread instead."
  - "The desktop app uses a new browser profile."

  — [Release v0.0.46-nightly.20261003.2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)

### Inferences
- The motivation was mostly reliability and fidelity, not a new UI idea. V1 treated the provider stream as the source of truth and broke on subagents, steering, interrupts and restarts. V2 makes the app own the graph and treats provider IDs as references.
- The user-visible multi-agent features (delegate_task, lineage, cross-provider) are what that graph made practical.
- V1 seems to have had some delegation or "agents panel" concept before V2, since #2778 and #8499 refer to delegated children and an Agents Panel. Exactly what V1 delegation looked like is not documented in what I read.

### Gaps
- No blog post or video was found in which Theo or Julius explain the "why" in long form.
- The V1 delegation/subagent UX is not described anywhere I could find. It can only be inferred from issue titles.

## Full V2 feature list (confirmed / announced / rumored)

### Takeaway
The shipped V2 nightly has eight confirmed feature groups:
1. **Cross-provider delegation** with the `delegate_task` MCP tool.
2. **The T3 Code MCP**: agents drive other threads (launch, send, wait, read, interrupt, fork/merge, worktree handoff).
3. **Native subagents** from every provider, shown in a Lineage view.
4. **Fork and merge-back** of any thread.
5. **Mid-thread provider/model switching** (lossy, explicitly not recommended for combining harnesses).
6. **A durable server-side queue** with steer-vs-queue.
7. **Restart and usage-limit recovery.**
8. **Scheduled tasks.**

It also adds providers: Pi, OpenCode 2, ACP Registry, and Cursor on the official SDK. All of these are confirmed in the official release notes.

### Cited Findings (all confirmed in the official release notes unless marked otherwise)
- **`delegate_task` (agents that manage agents).**
  - What it is: `delegate_task` "lets an agent hand work to a child agent on any provider and model, with its own options and role. Each child runs as its own thread, keeps its own provider-native history, and reports a result."
  - Waiting: "The parent can wait for children or keep working, and it wakes up when they finish, with results batched together."
  - Recommended use: "**This is the recommended way to combine harnesses**, for example Claude planning and Codex implementing."

  — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
- **`delegate_task` parameters.**
  - `task`
  - `target{providerInstanceId, driverKind, model}`
  - `title`
  - `role` (`implementation | research | review | design | test | general`)
  - `mode` (`async | wait`)
  - `timeoutMs`
  - `clientRequestId`
  - `runtimeMode` (`inherit | approval-required | auto-accept-edits | full-access`)
  - `interactionMode` (`inherit | plan | default`)

  — [docs/orchestration-v2/orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md)
- **`delegate_task` behavior.**
  - Context: "The child receives only the supplied task prompt, plus an optional role instruction… Parent conversation history is not copied into the child."
  - Defaults: provider, model and modes inherit from the parent when omitted.
  - Timeouts: "A wait timeout does not cancel the child".
  - Results report `status` (queued/running/waiting/completed/failed/cancelled/interrupted), `workState` (working / waiting_for_children / result_available) and `summary`.
  - Review loops: "Each delegated review round uses a new `delegate_task` call with the original brief, prior findings, responses, and unresolved objections."
  - Companion tools: `task_status` and `task_cancel`.

  — [orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md)
- **Providers that can run child tasks:** Codex, Claude Agent SDK, Cursor Agent SDK, Grok, generic ACP registry agents, OpenCode, OpenCode 2, Pi, and Antigravity. Unavailable providers are reported to the model along with the reason (not installed, not authenticated, and so on) via `orchestrator_capabilities`. — [orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md)
- **The T3 Code MCP.**
  - Core: agents can "create, launch, message, wait on, read, search, and interrupt threads".
  - They can also:
    - "fork and merge back; edit and reorder queues; answer questions;
    - rename threads, regenerate titles, link pull requests, and settle threads;
    - manage scheduled tasks and projects; hand work off to a worktree; list and close previews."
  - Limit: "Agents can't approve their own permission requests."

  — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
- **MCP tools documented:**
  - `orchestrator_capabilities`, `delegate_task`, `task_status`, `task_cancel`
  - `create_threads`: 1–20 top-level threads that share the parent's checkout, with no lineage
  - `t3_thread_launch`: workspaceStrategy `worktree` with baseRef, `existing_worktree`, or `root`; also `scratch: true` and stacked PRs via `baseRef` + `startFromOrigin:false`
  - `t3_thread_list`, `t3_thread_read`, `t3_thread_update`
  - `t3_thread_send`: modes `auto | queue | steer | restart`
  - `t3_thread_wait`, `t3_thread_interrupt`

  Agent-written messages carry the provenance tags `createdBy: "agent"` and `creationSource: "mcp"`. — [orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md)
- **Worktree tools (from search snippets only).** V2 ships `t3_worktree_handoff`, `t3_worktree_status` and `t3_worktree_list`. A follow-up adds `existingWorktreePath`. — [PR #11560 "let agents hand a thread off to a worktree they created"](https://github.com/pingdotgg/t3code/pull/11560); [PR #15191 "resume delegated work after workspace handoffs"](https://github.com/pingdotgg/t3code/pull/15191). I did not open either PR, so treat the tool list as unverified.
- **Subagents you can follow.**
  - "Native subagents from Claude, Codex, OpenCode 2, Cursor, and Pi show as child threads in a lineage view, with their model, status, progress, results, and duration."
  - "Several subagents fold into one collapsible card, and the mobile app has an agents sheet."
  - "When background work finishes, the agent wakes up and says which subagent, command, or monitor finished."
  - "Stop works on background work too."

  — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
- **Lineage follow-up PRs:** "show subagent models and running count in Lineage" (#12491) and "stop active subagents from Lineage" (#15211). — [PR #12491](https://github.com/pingdotgg/t3code/pull/12491); [PR #15211](https://github.com/pingdotgg/t3code/pull/15211)
- **Fork any thread / merge back.**
  - "Fork from any finished run, including failed, interrupted, and limited ones. Forks stay on the same provider by default and use the provider's native fork where it has one (Codex, Claude, Pi, OpenCode 2)… When you're done, merge the fork's context back into its source." — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
  - In the design, merge-back injects a *delta* (decisions, files changed, commands/tests run, conclusions, unresolved issues) with the next source-thread message, not the full transcript. — [feature-lifecycles.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/feature-lifecycles.md)
- **Switching providers mid-thread.**
  - "change provider, account, model, or options between turns, and queue a switch without stopping the current turn."
  - The release notes carry a warning: "The handoff is lossy… not the previous provider's reasoning, its tool calls and results, or attachments… To get another harness's help, have the agent use `delegate_task` instead."
  - The handoff is a budgeted selection, not a summary. It defaults to 16,000 tokens (`T3CODE_CONTEXT_HANDOFF_TOKEN_CAP`, clamped to 1,024–64,000). It includes references the agent can use to fetch omitted history.

  — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610); [docs/user/portable-handoffs.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md)
- **Attach another thread as context.** "type `@` and the thread's name, or drag a thread from the sidebar into the composer." — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
- **Queue.**
  - "The queue lives on the server and keeps its order across restarts… It also survives usage limits."
  - "Edit, reorder, remove, and steer queued messages, including their attachments."
  - Setting **Settings → General → Follow-up behavior** chooses whether a follow-up steers or queues. `Cmd/Ctrl+Enter` does the opposite of your default.

  — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
- **Limits and recovery.**
  - Threads stopped by a usage limit show as **Limited**, with "resume at reset" and "snooze until reset".
  - "Continue threads after restarts" setting.
  - A live context meter.

  — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
- **Scheduled tasks.** "Create, edit, pause, resume, run, and delete automations on web and mobile." — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
- **Thread details panel and sidebar.**
  - "Workspace, Git, scripts, linked pull requests, automations, and lineage now live in a thread-details panel. Merge controls follow the current checks."
  - Sidebar statuses: working, waiting, limited, failed.
  - Server-owned auto-"settling" that accounts for linked PRs, pins and background work.
  - "Working section (beta)": busy threads collapse until they need you.
  - Per-project worktree branch-name templates.

  — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
- **Threads without a project.** These run in `~/.t3/scratch/<date>-<words>-<id>`, with Git controls hidden. — [Issue #14871](https://github.com/pingdotgg/t3code/issues/14871); [docs/user/thread-sidebar.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md)
- **Providers.**
  - Pi (including 1.0): native resume, fork, rollback and steering.
  - OpenCode 2 (2.0.18+): native steering, forks, rollback, compaction, plan mode, and child sessions shown as subagent threads.
  - ACP Registry: "Devin, Cline, Kimi, Droid, and more", with search and install per server.
  - Cursor on the official `@cursor/sdk`.
  - Claude, Codex, Grok and Antigravity are still supported.

  — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
- **Minimum provider versions:** Codex 0.159+, Claude Code 2.1.280+, Cursor CLI build ≥2026-05-09, Grok 1.0.13+, OpenCode 2.0.18+, Pi 0.80.5+ (1.0 recommended), Antigravity 1.1.1. — [Issue #14871](https://github.com/pingdotgg/t3code/issues/14871)
- **Shipped in the following nightlies (2026-10-03/04):**
  - "agents can watch a PR and get woken when checks, reviews, or conflicts need them" (.2632);
  - "threads settle as soon as an agent merges their PR" (.2623);
  - "keep delegated review rounds on the task API" (.2632);
  - "restarts keep delegated tasks, queued threads, and stops intact" (.2644);
  - "subagents sent a follow-up show as running in Lineage" (.2644);
  - "subagent finish notifications look like subagent cards" (.2644);
  - mobile beta Working section (.2644).

  — [Release .2632](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2632); [Release .2623](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2623); [Release .2644](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261004.2644)
- **Related, possibly pre-V2:** you can fan one prompt out to several models. "Shift-click models in a new thread's model picker… Each selection starts a separate thread and worktree." — [docs/user/thread-sidebar.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md)
- **Proposed, not shipped:**
  - Configurable model routing rules for `delegate_task` (for example: research → Gemini Flash, implementation → GPT, planning → Claude Opus). This was filed as #15181 and moved to Discussion #15182 on 2026-10-03. The issue notes that today "Subagents delegated via `delegate_task` inherit the parent thread's provider and model by default unless the orchestrator model decides to override".
  - Discussion #15516 (2026-10-04): "Orchestrator V2: isolated / elastic compute for delegated workers".

  — [Issue #15181](https://github.com/pingdotgg/t3code/issues/15181); [Discussions](https://github.com/pingdotgg/t3code/discussions)

### Inferences
- **No dedicated planner UI or "task board".** Splitting work into tasks happens *inside the agent*: the model decides when to call `delegate_task` or `create_threads`, and with what role and model. T3 provides the durable plumbing, the lineage UI and wake-ups. Routing is per-prompt today, and users are already asking for configurable routing.
- **Two levels of orchestration, both shown in Lineage:**
  - (a) the provider's *native* subagents (Claude Task, Codex multi-agent, and so on);
  - (b) T3's *app-owned* cross-provider children via `delegate_task`.
- **Delegated vs ordinary threads.** Delegated children are read-only to the user ("message the parent"). Ordinary threads created by `create_threads` / `t3_thread_launch` are full top-level threads, which can live in their own worktrees.

### Gaps
- No evidence of a dedicated diff/merge "review and land" UI specific to subagent output. The merge path seems to be:
  - fork merge-back (context-level, not git);
  - PR linking, "watch a PR", and merge controls in thread details;
  - worktree handoff.
- How a git merge of a delegated worker's worktree back into the parent branch is surfaced in the UI is not documented in what I read.
- The `t3_worktree_*` tool list is from search snippets, not verified.

## How a user interacts with it, step by step

### Takeaway
There is no separate "orchestrator mode". The user chats with a normal thread and asks the agent to delegate, or the agent decides to. Children show up as collapsible subagent cards inline and as nodes in the thread-details Lineage panel, with model, status, progress, duration and result. The parent is woken with a batched result when they finish. The user supervises by:
- stopping children (now including background work) from Lineage;
- steering or queueing follow-ups;
- forking and merging back;
- watching sidebar statuses (Working / Waiting / Limited / Failed).

### Cited Findings
- **Starting work.**
  - A new thread can be **New worktree**, current checkout, or **No project**.
  - `Cmd/Ctrl+Enter` starts a thread in the background and opens another draft.
  - Shift-click several models to fan one prompt into separate threads and worktrees.

  — [docs/user/thread-sidebar.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md)
- **Delegating.** The agent calls `delegate_task`. The release frames this as user-directed ("have the agent use `delegate_task`"), with the example "Claude planning and Codex implementing". — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
- **A real user flow (bug report, 2026-10-03):** "A native Claude coordinator delegates to a Codex worker… The coordinator starts a worker thread. Its initial run completes, and the Lineage entry shows 'Done'. The coordinator sends follow-up work to that same worker thread…" — [Issue #13331 comment by letrandat](https://github.com/pingdotgg/t3code/issues/13331)
- **Supervising.**
  - The Lineage view lists children with model, status, progress, results and duration, plus a "N running" count.
  - Several subagents collapse into one card. Mobile has an "agents sheet".
  - Stop ends background work.
  - When background work finishes, the agent says which subagent, command or monitor finished.

  — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610); [Issue #13331](https://github.com/pingdotgg/t3code/issues/13331)
- **Sidebar Working section (beta).** Working/monitoring threads collapse into a **Working** section below the active list. "A thread returns to the top of the active list when it finishes, fails, or needs an approval or answer." — [docs/user/thread-sidebar.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md)
- **Follow-ups.** The composer either steers the running turn or queues. The default is set in Settings and `Cmd/Ctrl+Enter` inverts it. The queue can be edited and reordered, including from mobile. — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
- **Landing.**
  - Thread details hold Git, linked PRs and merge controls ("Merge controls follow the current checks").
  - Agents can link PRs, watch a PR and get woken on checks, reviews or conflicts.
  - Threads auto-settle when their PR merges.

  — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610); [Release .2632](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2632); [Release .2623](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2623)
- **Fork, explore, merge back.** Fork from any finished run. Afterwards "merge the fork's context back into its source". There is a known UX bug: "Merging a fork back gives no sign it worked until the next message is sent". — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610); [Issue #15063](https://github.com/pingdotgg/t3code/issues/15063)
- **Migration experience.**
  - The first V2 launch copies `state.sqlite` to `statev2.sqlite`, one way.
  - Carried over: titles, projects, models, modes, branches/worktrees, pin/snooze/settled state, linked PRs, and messages.
  - Not carried over: live provider sessions, old checkpoints and diffs, tool activity, approval history, and proposed plans.
  - V1 and V2 can be installed side by side.

  — [Issue #14871](https://github.com/pingdotgg/t3code/issues/14871)

### Gaps
- No official demo video, screenshots page or YouTube walkthrough of V2 was found.
- UI descriptions above come from release-note text and bug reports, not from images.

## Reception, limitations and known bugs

### Takeaway
Reception is early, about 1.5 days in, and almost all of it is on GitHub. There are many enthusiastic early adopters: people ran the unmerged branch in personal forks, and third-party tools ported to "orchestrator V2 only" within a day. There is also a heavy bug stream, with about 80 issues mentioning V2 since 2026-10-02.

Recurring complaint themes:
- Lineage/subagent status accuracy (stale "Done", no token usage or reasoning effort, workflows flattened);
- delegation wake/stop edge cases;
- Claude permission-mode safety regressions;
- migration and Android beta-distribution friction;
- higher energy use.

I found no Reddit, HN or YouTube discussion specific to V2.

### Cited Findings
- **Third-party press.** A newsletter item (2026-10-03, "Switch Coding Agents Mid-Thread") rated it 9/10. It summarized V2 as adding provider switching, cross-model delegation, Pi support and server-owned queues, and cautioned: "test the new nightly's handoffs before trusting long-running work." — [High Learning Rate substack](https://highlearningrate.substack.com/p/switch-coding-agents-mid-thread-2026)
- **Ecosystem uptake** (search-result titles; not opened):
  - t3code-cli shipped "Release v0.3.0: orchestrator V2 only";
  - otal-labs/nexul PRs for "a T3 Code client for orchestrator V2";
  - a skills repo PR "Run cross-provider agents as T3 child tasks".

  — [MajesteitBart/t3code-cli v0.3.0](https://github.com/MajesteitBart/t3code-cli/releases/tag/v0.3.0); [otal-labs/nexul PR #348](https://github.com/otal-labs/nexul/pull/348); [olivercederborg/skills PR #7](https://github.com/olivercederborg/skills/pull/7)
- **Bug volume.** A GitHub issue search for "V2" created on or after 2026-10-02 returns 82 issues. This is a rough count, since the search also matches issue bodies. — [t3code issues](https://github.com/pingdotgg/t3code/issues)
- **Lineage and subagent visibility bugs:**
  - "Orchestrator V2 shows no token usage for subagents" (#15429). The AgentsPanel removal dropped token counts.
  - "shows no reasoning effort for subagents" (#15214).
  - "shows a Claude workflow as a plain subagent; its phases and agents are dropped" (#15448).
  - "V2 Codex subagent model stays 'Not reported'" (#15250).
  - "Codex subagents lose status and message tracking after server restart" (#15567).
  - A steered or resumed subagent still shows "Done" in Lineage (#13331 item 2). This was confirmed by several users with different triggers, and partly fixed in .2644.

  — [#15429](https://github.com/pingdotgg/t3code/issues/15429); [#15214](https://github.com/pingdotgg/t3code/issues/15214); [#15448](https://github.com/pingdotgg/t3code/issues/15448); [#15250](https://github.com/pingdotgg/t3code/issues/15250); [#15567](https://github.com/pingdotgg/t3code/issues/15567); [#13331](https://github.com/pingdotgg/t3code/issues/13331)
- **Delegation lifecycle bugs:**
  - "Parent is never notified when a delegated child finishes a follow-up turn" (#13490).
  - "Delegated-task notifications cancel queued Claude tool calls and tell the agent the user refused" (#15351).
  - "Stop on a completion-wake run leaves tasks delegated during that run able to wake the parent" (#15325).
  - "Completed delegated task notification expands to an empty panel" (#15169).
  - "Threads launched into another project via t3_thread_launch can't be waited on, read, sent to, or interrupted" (#15125).
  - "Stop can't end background work after a run fails before its provider starts" (#15472).
  - "V2 keep-alive drops queued/waiting threads while UI still shows working" (#15289).

  — [#13490](https://github.com/pingdotgg/t3code/issues/13490); [#15351](https://github.com/pingdotgg/t3code/issues/15351); [#15325](https://github.com/pingdotgg/t3code/issues/15325); [#15169](https://github.com/pingdotgg/t3code/issues/15169); [#15125](https://github.com/pingdotgg/t3code/issues/15125); [#15472](https://github.com/pingdotgg/t3code/issues/15472); [#15289](https://github.com/pingdotgg/t3code/issues/15289)
- **Safety and permission regressions:**
  - "Claude Auto mode on orchestrator v2 runs ask-rule commands without prompting" (#15353).
  - "Claude Auto + Plan silently approves native plan-mode write requests (V2)" (#15503).

  — [#15353](https://github.com/pingdotgg/t3code/issues/15353); [#15503](https://github.com/pingdotgg/t3code/issues/15503)
- **Resource and cleanup issues:**
  - "V2 storage cleanup never frees worktrees for completed/cancelled/interrupted/rolled_back threads" (#15146).
  - A Codex detach leaves native threads and their MCP servers loaded: "about 80 idle processes and 9 GB" over a day (#13331 item 4).
  - A user reports much higher energy use on the V2 nightly: 12-hour power of 750.77 vs Chrome 84.97 on an M4 Pro.

  — [#15146](https://github.com/pingdotgg/t3code/issues/15146); [#13331](https://github.com/pingdotgg/t3code/issues/13331); [#14871 comment by SrirajBehera](https://github.com/pingdotgg/t3code/issues/14871)
- **Migration and rollout friction:**
  - Android testers stuck on 1.4.0 ("Client not supported") until they left and rejoined the Play testing program.
  - "Windows nightly: projects and chats unavailable after orchestrator v2 update" (#15003, closed).
  - "nightly silently reuses a preview-created database and misses newer V1 threads" (#15017).
  - "Claude rollback/rewind fails on Orchestrator V2 after compaction" (#15347).
  - "Resume retries Claude after selecting Codex, while Send hands off successfully" (#15555).

  — [#14871 comments](https://github.com/pingdotgg/t3code/issues/14871); [#15003](https://github.com/pingdotgg/t3code/issues/15003); [#15017](https://github.com/pingdotgg/t3code/issues/15017); [#15347](https://github.com/pingdotgg/t3code/issues/15347); [#15555](https://github.com/pingdotgg/t3code/issues/15555)
- **Maintainer-acknowledged hardening backlog.** Issue #15013 "Orchestration V2: open hardening work" was filed by `t3dotgg` on 2026-10-03 and signed "_Filed by Claude Code (Opus 5.5)._". Open items:
  - interrupt semantics, for example when a provider accepts an interrupt but completes normally;
  - typed failure reasons for context transfers (missing source point, unsupported capability, context too large, and others);
  - rollback when there is no active provider thread;
  - a test for forking from a subagent thread;
  - App Store showcase seeding of V2 tables.

  — [#15013](https://github.com/pingdotgg/t3code/issues/15013)
- **Documented limitations:**
  - provider switching is lossy;
  - subagent threads are read-only;
  - delegated children get no parent history, only the task prompt and role;
  - "There is no task-level follow-up API for preserving the same reviewer session";
  - the mobile store apps can't connect to V2 servers.

  — [Release .2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610); [orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md)
- **Hype tweets before launch.** In August Theo repeatedly answered feature requests with "Coming soon as part of Orchestrator V2" (2026-08-25) and "look into orchestrator v2 ;)" (to Rhys Sullivan, about 2026-08-09). — [Theo on X 2092320489540894802](https://x.com/theo/status/2092320489540894802); [Theo on X 2086576915977261421](https://x.com/theo/status/2086576915977261421). Snippets only; the second date is approximate, decoded from the tweet ID.
- **Unrelated HN hit.** The only Hacker News hit was about Antigravity's terms of service and third-party use, not V2. — [HN item 49553725](https://news.ycombinator.com/item?id=49553725)

### Inferences
- The most common complaint class is **status truthfulness in the supervision UI**: Lineage saying Done while a child is working, missing tokens, missing models. This matters for Solenta, because a multi-agent UI is only as trustworthy as its status projection.
- The design choice that probably prevents a class of bugs Solenta could also hit: **only the root run completes a turn; child completion never closes the parent**.
- **Cross-provider delegation as durable child threads, not provider switching**, is the headline idea that T3 itself explicitly recommends.

### Gaps
- No Reddit threads, HN threads or YouTube videos specifically about Orchestrator V2 were found as of 2026-10-04. This may be because the release is about 1.5 days old.
- I could not read Theo's X threads or their replies (402). Sentiment on X is unknown beyond Theo's own snippets.
- No quantitative adoption numbers were found (nightly download counts, how many users opted in).
