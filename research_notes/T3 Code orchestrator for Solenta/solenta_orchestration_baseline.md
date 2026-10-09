# Solenta multi-agent orchestration baseline (as of 2026-10-04, branch fae77a0b checkout at 7902c729)

All sources are local files in the checkout `/Users/willem/Library/Application Support/Solenta/worktrees/fae77a0b-5c8a-4a21-ba4f-b07f933538ed`. Links are repo-relative `path#Lline`. Pain-point memories cited as `~/.claude/projects/-Users-willem-code-coder/memory/<file>` are Willem's private agent-memory notes, not repo files. They are dated in their frontmatter, and two of them have since been partly superseded by code (flagged inline).

## 1. Architecture: how a thread runs, how state is persisted, how stream events reach the UI

### Takeaway
Solenta is one Electron main process that owns everything: the store, the runner, every agent CLI child process, and an in-process MCP server. Each thread is a row in a mutable JSON store. Each run spawns, or reuses, one provider CLI whose stream events are written straight into mutable message rows. The renderer then gets a full thread-list snapshot plus a tail diff of the open thread. There is no event log or event sourcing. State is mutable snapshots, written with debounced atomic writes.

### Cited Findings
**Process split**
- Main owns agents and disk. The renderer is React. Preload exposes a typed `window.coder` API, and the contract lives in `src/shared/ipc.ts`. Layers: `electron/main.js` (window, Store, Runner, memory supervisor), `electron/ipc.js` (ipcMain handlers), `electron/preload.js`, `electron/services.js` (projects, threads, providers, settings, spend gate, worktree wrappers), and `src/` (App → Sidebar, ThreadView, AgentsPanel). Source: [docs/ARCHITECTURE.md:1-18](docs/ARCHITECTURE.md#L1).
- Size signals that the logic is concentrated in a few god-modules: `electron/runner.js` has 9,317 lines, `worktrees.js` 6,743, `services.js` 5,807, `store.js` 4,185, `ipc.js` 2,476, `orchServer.js` 2,079 and `workflow.js` 2,557 (from `wc -l electron/*.js`, total 94,504 lines in electron/). `src/shared/ipc.ts` is 5,198 lines.

**Provider registry and adapters**
- `electron/providers.js` is data-driven. Each entry has `id`, `name`, `binEnv`, `defaultBin`, `supportsResume`, `models[]`, `kind` and `buildArgs`. The kinds are `claude-stream` (also used by Grok), `codex-json`, `kimi-stream`, `opencode-json`, `cursor-stream`, `muse-json` and `simulate`. Source: [docs/ARCHITECTURE.md:25-43](docs/ARCHITECTURE.md#L25).
- Registered provider ids: claude ([providers.js:242](electron/providers.js#L242)), codex (343), grok (530), opencode (640), kimi (786), cursor (878), muse (1405) and simulate (1457). Read with `LC_ALL=C grep -a` because the file contains a NUL byte.
- Only `claude` ([providers.js:251](electron/providers.js#L251)) and `codex` ([providers.js:353](electron/providers.js#L353)) declare `supportsSteer: true` ("live process accepts a second stdin", [providers.js:74](electron/providers.js#L74)).

**Runner**
- `createRunner` ([runner.js:742](electron/runner.js#L742)) keeps an in-memory `active: Map<threadId, {runId,…}>` ([runner.js:767-770](electron/runner.js#L767)). Every chunk, done and error callback re-checks `runId` so a late exit cannot mutate a newer run ([ARCHITECTURE.md:45-51](docs/ARCHITECTURE.md#L45)). The default push tick is `tickMs = 700` ([runner.js:747](electron/runner.js#L747)).
- Each provider has its own start function: `startClaudeRun` ([runner.js:3844](electron/runner.js#L3844)), `startCodexRun` (5008), `startKimiRun` (5600), `startOpencodeRun` (6136), `startCursorRun` (6616), `startMuseRun` (7148) and `startSimulatedRun` (3537). The single entry point is `startRun` ([runner.js:8209](electron/runner.js#L8209)), which throws "A run is already active on this thread" when `active.has(threadId)` ([runner.js:8228-8230](electron/runner.js#L8228)).
- Claude CLIs are kept warm between turns. `claudeSessions` holds them, `CLAUDE_IDLE_REAP_MS` is 30 minutes and `CLAUDE_IDLE_MAX` is 3. A comment there reads "ponytail: fixed LRU cap — an 8-worker fan-out otherwise leaves 8 idle CLIs resident" ([runner.js:830-845](electron/runner.js#L830)).
- Codex runs through an app-server JSON-RPC path (`runCodexFn = runCodexAppServerTurn` at [runner.js:756](electron/runner.js#L756)), with server-request and approval handling at `handleCodexServerRequest` / `respondCodexPermission` ([runner.js:2444](electron/runner.js#L2444), [2535](electron/runner.js#L2535)).

**Stream events → messages**
- Adapters handle raw stream-json in an `onEvent` closure (Claude: [runner.js:4330](electron/runner.js#L4330)). They mint rows via `appendMessage` ([runner.js:2961-3020](electron/runner.js#L2961)) and mutate them in place with `store.updateMessage(...)`. For example, the streaming assistant text is overwritten at [runner.js:4058](electron/runner.js#L4058), and tool results patch the tool row at [runner.js:4562](electron/runner.js#L4562).
- Message rows have the shape `{id, role, text, createdAt, runId?, tool?, attachments?, fromThread?, thinking?, fromNotice?, steer?}` ([runner.js:2969-2998](electron/runner.js#L2969)).
- A separate work log (`appendWorkLog` / `updateWorkLogItem`) tracks step cards ([runner.js:2922-2959](electron/runner.js#L2922)).
- `unwrapStreamEvent` normalizes Messages-API partials (`content_block_delta` and similar) ([runner.js:150-182](electron/runner.js#L150)).

**Persistence**
- The store is `coder-store.json` under userData, holding an envelope plus per-thread shards. EMPTY shape: `projects, spaces, threads, messagesByThread, workLogByThread, usageByThread, runArtifactsByThread, rewindRestoreByThread, workflowTemplates, spendByDay, usageByDay, usageThreadsByDay, automations, tasksByCrew, digestSeenAt, settings{dailyBudgetUsd, orchestrationBudgetUsd, autoSettleAfterDays, mcpServers, agentProfiles, subagentPool}` ([store.js:78-104](electron/store.js#L78)).
- Transcripts live in `messages/<threadId>.json` (#225) and work logs in `worklogs/<threadId>.json` (#1204). Saves are debounced at 250 ms ([store.js:258-270](electron/store.js#L258)). Each write goes tmp → fsync → rename, and only dirty shards plus the envelope are flushed ([store.js:1544-1555](electron/store.js#L1544), [store.js:1518-1541](electron/store.js#L1518)). An unreadable file is renamed `*.corrupt-<ts>` and a `.bak` is tried ([store.js:1546-1549](electron/store.js#L1546)).
- Retention caps: 1000 messages and 500 work-log items per thread, plus slack. The oldest entries are dropped and an event marker notes the gap ([store.js:272-282](electron/store.js#L272)).
- Crash recovery is lossy by design. On load, every thread still `working` is flipped to `failed` with "Run error: app quit while the run was in flight" and an event "Run interrupted: the app crashed or was force-quit mid-run" ([store.js:1426-1460](electron/store.js#L1426)).
- `updateThread` does not bump `updatedAt` unless the caller opts in ([ARCHITECTURE.md:278-279](docs/ARCHITECTURE.md#L278)).

**No event sourcing**
- A grep for "event sourc", "eventlog", "journal" or "append-only" in store.js, runner.js, ipc.js, services.js and ARCHITECTURE.md finds nothing relevant. The only "replay" is rewind and quota-resume replay of a user turn ([runner.js:622](electron/runner.js#L622), [store.js:1305](electron/store.js#L1305)).
- What exists instead is mirrors and exports. `session-record.js` batches transcript entries to the memory server, with an explicitly bounded mirror ("Store history is unaffected") ([electron/session-record.js:1-25](electron/session-record.js#L1)). OTel spans are exported via `electron/otel.js`, with traceId derived from the root thread so a whole crew shares one trace ([ARCHITECTURE.md:386-414](docs/ARCHITECTURE.md#L386)).
- The governance spec (#262) proposes an "HMAC-chained audit log" ([docs/superpowers/specs/2026-09-02-governance-layer-v1-design.md:1-15](docs/superpowers/specs/2026-09-02-governance-layer-v1-design.md#L1)). `createHmac` appears only in `electron/memory-sup.js` among electron/*.js, and `electron/guardrails.js` (the shipped #409 guardrails: `classifyTool`, `scanInjection`, `scanSecrets`, [guardrails.js:1-20](electron/guardrails.js#L1)) contains no "audit" or "hmac" string.

### Inferences
- Persistence is "mutable rows plus atomic snapshot files". No ordered command or event stream exists that could be replayed, synced to a second client or used for time-travel. Rewind works by truncating the transcript and resetting git to a checkpoint (see §2).
- Run lifecycle state (`active`, `orchNotices`, `autoTurns`, warm CLI sessions) lives only in memory. An app crash therefore fails every in-flight run and silently drops undelivered wake-ups (see §3).
- The HMAC audit log from the governance spec does not appear to be implemented. This is based only on the grep above.

### Gaps
- I did not trace every adapter (codex app-server, kimi, opencode, cursor, muse) event-by-event. Only the Claude path was spot-checked. They are assumed to follow the same `appendMessage`/`updateMessage` pattern, since `appendMessage` is documented as "Every adapter mints its tool messages here" ([runner.js:3003-3005](electron/runner.js#L3003)).
- Not checked: whether `core/src/engine.ts` (the Workflow engine for "Plan and Verify" templates, [ARCHITECTURE.md:53-59](docs/ARCHITECTURE.md#L53)) carries any event or phase log beyond `ThreadDetail.workflow`.

## 2. Orchestration features: MCP tools, fork/send/merge/settle/status, crews, modes

### Takeaway
Orchestration is exposed to agents through an in-main MCP server, `coder-threads` (`electron/orchServer.js`, 28 tools). Its core is fork-a-worker-into-its-own-worktree, async wake-up notices to the lead, user-gated landing (squash merge or PR), and a per-crew shared task board with peer messaging. Around it sit several mode features: orchestrator threads, `/handoff` `/advisor` `/committee`, spec mode with wave dispatch, teach mode, ask mode, Best-of-N, a hypothesis ledger, work-suggestion chips, verify gates, turn checkpoints, Planboard issue sync, lead integration receipts and a local merge queue. Every one of them composes threads and worktrees. None is a separate runtime.

### Cited Findings
**MCP server mechanics**
- `coder-threads` runs as loopback HTTP on 127.0.0.1 with a bearer token stored in `<userData>/orch-server.json`. It fails soft (no SDK or port → the app continues without thread tools) and is injected into every provider's MCP config alongside `coder-memory` ([ARCHITECTURE.md:478-490](docs/ARCHITECTURE.md#L478); [orchServer.js:40-43](electron/orchServer.js#L40); `createOrchServer` [orchServer.js:1854](electron/orchServer.js#L1854)).
- Each POST builds a fresh stateless `McpServer` plus `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined`. `?projectId=` on the URL binds caller identity, and that wins over claimed args (#671) ([orchServer.js:1925-1985](electron/orchServer.js#L1925), [orchServer.js:296-313](electron/orchServer.js#L296)).
- The cross-project guard is `assertSameProject` ([orchServer.js:325-351](electron/orchServer.js#L325)).
- External clients (Claude Desktop, Claude Code, …) can authenticate with scoped, expiring pairing tokens whose capabilities are `read`, `launch`, `steer` and `read_all` ([electron/pairing.js:1-28](electron/pairing.js#L1); routing at [orchServer.js:1925-1945](electron/orchServer.js#L1925)).
- The server's long `INSTRUCTIONS` string is the de facto orchestration protocol. It covers "WORKERS BUILD; YOU ASK", self-contained fork prompts, "Mid-run sends are held, not injected", committing contracts and handing a peer a `branch:path` ref, and `refresh_worker_snapshot` ([orchServer.js:45-130](electron/orchServer.js#L45)).

**Tool inventory** (registration at [orchServer.js:1220-1830](electron/orchServer.js#L1220); handlers at [orchServer.js:304-1211](electron/orchServer.js#L304)):

| Tool | What it does | Code |
|---|---|---|
| `threads_list` | Roster of the caller's project only (id, title, provider, status, handoffFrom, archived, settledOverride, snoozedUntil) | [orchServer.js:390-417](electron/orchServer.js#L390) |
| `thread_fork` | `forkWorkerThread` then `startWithPoolFailover`; optional `provider` / `pool` / `worktree:false` / `title`; returns `{threadId}` | [orchServer.js:419-452](electron/orchServer.js#L419) |
| `thread_merge` | Squash a finished worker onto the caller's tree. Requires `approved:true` on a non-machine turn, plus `expectedPath` / `expectedBranch` that must match the real destination. CI-workflow files need a human sign-off card. Then retention GC runs | [orchServer.js:559-657](electron/orchServer.js#L559) |
| `thread_pr` | Push the worker branch and `createPr` (same approval gate); the worktree survives so review fixes can be sent back | [orchServer.js:659-687](electron/orchServer.js#L659) |
| `thread_send` | Deliver a prompt to another thread: `delivered` / `queued` / `refused` / `undeliverable`, with `fromThreadId` attribution | [orchServer.js:689-777](electron/orchServer.js#L689); rules in [crossThread.js:60-125](electron/crossThread.js#L60) |
| `thread_status` | status, title, provider, first line of the last assistant reply, lastError, `awaitingInput`, `awaitingPermission` | [orchServer.js:779-827](electron/orchServer.js#L779) |
| `ask_user` | Non-blocking multiple-choice card on the caller's own thread; the answer starts the next turn | [orchServer.js:829-850](electron/orchServer.js#L829) |
| `hypothesis_record` | Append `{claim, status: validated/invalidated/inconclusive, reason}` to `thread.hypotheses` | [orchServer.js:852-869](electron/orchServer.js#L852); caps in [services.js:843-849](electron/services.js#L843) |
| `work_suggest` | Out-of-scope chip (`thread.suggestions`, max 20); never starts work | [orchServer.js:871-894](electron/orchServer.js#L871); [services.js:851-854](electron/services.js#L851) |
| `spec_submit` / `teach_review` | Advance the spec-mode stage, or record a teach-mode review | [orchServer.js:896-916](electron/orchServer.js#L896) |
| `task_add/list/claim/complete/release` | Per-crew shared task list | [orchServer.js:918-990](electron/orchServer.js#L918) |
| `peer_send` | `[peer from <id> ("title")] msg` delivered through the notice queue | [orchServer.js:992-1010](electron/orchServer.js#L992) |
| `thread_archive/settle/stop/rename` | Sidebar lifecycle. Cross-thread archive and stop need `approved:true` from a human turn | [orchServer.js:1012-1073](electron/orchServer.js#L1012); gate at [orchServer.js:528-557](electron/orchServer.js#L528) |
| `issue_list/create/set_plan/complete/comment` | Planboard GitHub issues on the project's own origin; only registered when the origin is GitHub | [orchServer.js:1075-1127](electron/orchServer.js#L1075), [orchServer.js:1739-1830](electron/orchServer.js#L1739) |
| `refresh_worker_snapshot` | Retarget an idle worker onto the lead's current committed HEAD | [orchServer.js:1129-1153](electron/orchServer.js#L1129) |
| `preview` | Drive the thread's visible Browser pane (navigate, screenshot, click, type) | [orchServer.js:1155-1180](electron/orchServer.js#L1155) |

**Fork semantics**
- `forkThread` creates a new thread in the same project with `handoffFrom = source.id` and `sessionId: null`, so the session is fresh. It copies provider, model, permission mode (snapped to the new provider), teach and ask ([services.js:1279-1382](electron/services.js#L1279)).
- The fork gets only a digest of the source: the last ≤12 user and assistant messages, ≤2,000 characters each and ≤12,000 in total, prefixed "[Hand-off context … truncated — not the full transcript]" ([services.js:961-963](electron/services.js#L961), [services.js:1209-1261](electron/services.js#L1209)).
- `forkWorkerThread` adds `orchWorker: true` and resolves the worker-model pool. When the project can host a worktree, it sets `pendingWorktree` and records the lead's committed HEAD as `leadSnapshotSha` / `leadSnapshotBranch` / `leadSnapshotDirty` (#948) ([services.js:1384-1466](electron/services.js#L1384)).
- Worktree start: a recorded lead snapshot is exclusive ("Refusing to fall back to main"). Dirty lead edits are noted but never copied ([worktrees.js:495-614](electron/worktrees.js#L495)).
- Worker pools (#467) are a settings-level menu of `(alias, provider, model, description)`. The lead passes `pool=<alias>`. `force` pins every worker to the default alias, and an empty pool inherits the lead's model. Failover to the next alias happens when a CLI is missing ([electron/subagentPool.js:1-25](electron/subagentPool.js#L1); onFailover event at [runner.js:8362-8370](electron/runner.js#L8362)).

**Wake-ups and the crew lifecycle**
- When a worker finishes, `queueOrchNotice` puts "Worker thread X ("title") finished with status done/failed. Last reply: … Its work is still only on branch …: … ask whether to merge it (thread_merge) or open a pull request (thread_pr) …" on the parent's queue ([runner.js:1296-1339](electron/runner.js#L1296)).
- `flushOrchNotices` starts a run on the lead with `[orchestration] …\nContinue orchestrating; thread_status has full details.`, but only when the lead is idle. Otherwise it flushes at the lead's own terminal ([runner.js:1341-1434](electron/runner.js#L1341)).
- Gates apply at wake time: the per-orchestration budget (`assertUnderOrchestrationBudget`) and `CREW_AUTO_TURN_CAP` (25 consecutive machine turns). When either blocks, the lead lands `failed` with "Not delivered: …" ([runner.js:1391-1433](electron/runner.js#L1391); [services.js:2697-2703](electron/services.js#L2697)).
- `deliverNotice` is the generalized queue shared by peer messages and task unblocks ([runner.js:1274-1294](electron/runner.js#L1274)).
- Finished workers are auto-archived by `sweepCrew` / `sweepDoneWorkers`. More than `MAX_WORKERS_PER_ORCHESTRATOR` (20) finished workers without worktrees get purged ([runner.js:1784-1876](electron/runner.js#L1784); [runner.js:218](electron/runner.js#L218)).
- Stopping a lead cascades to its crew via `stopCrew`, and pending notices are written as an event rather than run ([runner.js:8780-8803](electron/runner.js#L8780)).
- A failed run releases the thread's task claims (`afterFailedTurn`, [runner.js:1436-1457](electron/runner.js#L1436)).

**Orchestrator threads (#202)**
- `pendingFork: true` means the first prompt is forked to a worker deterministically, with no LLM call on the lead. The lead runs its own LLM from the second prompt on. Orchestrators never hold a worktree ([docs/superpowers/specs/2026-08-16-orchestrator-threads-design.md:5-33](docs/superpowers/specs/2026-08-16-orchestrator-threads-design.md#L5); runner branch [runner.js:8312-8400](electron/runner.js#L8312)).
- The `defaultOrchestrate` setting makes plain "New thread" create an orchestrator ([ARCHITECTURE.md:268-272](docs/ARCHITECTURE.md#L268)).

**Shared task board and peers (#277)**
- A crew is the root of the `handoffFrom` chain plus all `orchWorker` descendants (`crewRootOf`, [services.js:2717](electron/services.js#L2717)). Tasks are stored in `store.tasksByCrew[rootId]` ([store.js:3323-3343](electron/store.js#L3323)).
- `blocked` is derived from `needs` on every read. `CREW_TASK_ATTEMPT_CAP` is 3, `CREW_TASKS_MAX` is 100, and `crewTaskNoteFor` forces a "what failed / am I repeating myself" preface on a retry ([ARCHITECTURE.md:429-476](docs/ARCHITECTURE.md#L429); [services.js:2697-3096](electron/services.js#L2697)).
- `task_complete` wakes the crew root with `[crew] finished tN … Unblocked: …` ([orchServer.js:951-977](electron/orchServer.js#L951)).
- Hand-offs between agents are git artifacts, not a registry: "commit contract.md … `git show <branch>:<path>`" ([ARCHITECTURE.md:457-461](docs/ARCHITECTURE.md#L457)).

**Orchestration commands (#338)**
- `/handoff [@provider]` uses 1 worker in a worktree. `/advisor` uses 1 read-only worker in the project checkout. `/committee` uses 2 contrasting workers that converge via `peer_send` over at most 3 rounds.
- They are intercepted in the runner (`dispatchOrchCommand`, [runner.js:7730](electron/runner.js#L7730)), not the renderer. By default they pick providers other than the caller's ([ARCHITECTURE.md:518-579](docs/ARCHITECTURE.md#L518)).
- Composer `@provider` delegation forks the thread onto that provider ([src/delegate.ts:1-18](src/delegate.ts#L1)).
- Best-of-N forks share a committed start snapshot ([src/bestOfN.ts:13-48](src/bestOfN.ts#L13); commit a91c5a34 "isolate contract for Best of N forks (#1223)").

**Modes**
- **Spec mode (#269):** three stages (`requirements.md` → `design.md` → `tasks.md` in `.solenta/specs/<slug>/`), each human-approved through SpecCard and submitted with `spec_submit`.
- Once `tasks.md` is approved, `dispatchSpec` parses checkbox tasks with `needs:` into crew tasks and returns the current wave. `ipc.js` then `forkSpecWave`s one worker per wave entry. `convergeSpec` appends missing tasks ([ARCHITECTURE.md:708-751](docs/ARCHITECTURE.md#L708); [services.js:3098-3557](electron/services.js#L3098); [ipc.js:889-891](electron/ipc.js#L889)).
- "ponytail: the gate is procedural — the note plus the human's Approve click" ([services.js:3535](electron/services.js#L3535)).
- **Teach mode:** `TODO(human)` markers and `teach_review`. Autonomy thresholds `{review: 3, pair: 8}` cap the permission modes ([services.js:3559-3830](electron/services.js#L3559)).
- **Ask mode:** read-only Q&A, no tool loop ([ARCHITECTURE.md:581-604](docs/ARCHITECTURE.md#L581)).
- **`/btw`:** side questions that run beside a live turn ([ARCHITECTURE.md:606-635](docs/ARCHITECTURE.md#L606)).

**Hypothesis ledger**
- Entries live on `ThreadInfo.hypotheses` (max 50). `hypothesisNoteFor` injects invalidated entries from up to 5 hops of the `handoffFrom` chain (10 lines) into the next dispatch ([ARCHITECTURE.md:421-427](docs/ARCHITECTURE.md#L421); [services.js:1105-1150](electron/services.js#L1105)).

**Verify gate, checkpoints, rewind**
- After a successful turn, `afterSuccessfulTurn` makes a best-effort checkpoint commit `coder-checkpoint: turn N` in the worktree. The commit carries a `Solenta-Message-Id` trailer and is skipped when the tree is clean ([runner.js:1459-1533](electron/runner.js#L1459); [worktrees.js:5282-5334](electron/worktrees.js#L5282)).
- When `verifyCommand` is set, the thread flips back to `working`, `runVerifyGate` runs the command against the checkpoint sha, and the orchestrator wake-up waits for the result ([runner.js:1485-1525](electron/runner.js#L1485), [runner.js:1632](electron/runner.js#L1632)).
- Checkpoints are listed `--first-parent`, and numbering counts commits rather than turns ([ARCHITECTURE.md:68-72](docs/ARCHITECTURE.md#L68)).
- Rewind truncates the transcript, clears `sessionId`, and can hard-reset to a checkpoint ([ARCHITECTURE.md:150-160](docs/ARCHITECTURE.md#L150)).
- Post-merge re-verification runs 24h later and spawns a fixer thread on failure ([ARCHITECTURE.md:124-148](docs/ARCHITECTURE.md#L124)).

**Landing work**
- `mergeWorktree` → `mergeInto` uses `git merge --squash <branch>` ([worktrees.js:1227](electron/worktrees.js#L1227), [worktrees.js:1484](electron/worktrees.js#L1484)).
- Blast-radius gate: CI workflow files need a human sign-off (#510) ([worktrees.js:1256-1262](electron/worktrees.js#L1256)).
- PR-size cap: 400 changed lines by default, checked before push (#402) ([ARCHITECTURE.md:103-116](docs/ARCHITECTURE.md#L103)).
- Lead integration (#954) stages worker → lead with a durable `CrewIntegrationReceipt`. Its states are running / ready / conflicted / integrated / landed / missing ([electron/crewIntegration.js:1-6](electron/crewIntegration.js#L1); types [src/shared/ipc.ts:1888-1965](src/shared/ipc.ts#L1888); IPC `git:integrateWorker` and `threads:crewIntegration` at [ipc.js:1725](electron/ipc.js#L1725), [ipc.js:509](electron/ipc.js#L509)).
- Merge-queue lanes (#346) are numbered lane worktrees with preview onto the checkout, a wedge watchdog (30 min) and Spotlight hot-swap. Only a human-approved final promote closes issues ([electron/mergeQueue.js:1-45](electron/mergeQueue.js#L1); API [src/shared/ipc.ts:4770-4800](src/shared/ipc.ts#L4770)).
- Worktree retention GC keeps 10 settled worktrees per project by default and never deletes dirty or unmerged ones ([ARCHITECTURE.md:86-94](docs/ARCHITECTURE.md#L86)).

**Planboard**
- Plans are GitHub issues with labels `plan:todo` / `plan:doing` / `plan:done`, accessible to agents through the `issue_*` tools ([orchServer.js:124-130](electron/orchServer.js#L124)).
- `autodispatch.js` starts one worktree thread per `plan:todo` issue every 5 minutes, with at most 3 running ([electron/autodispatch.js:3-45](electron/autodispatch.js#L3)).
- Planboard review-load thresholds are documented in [ARCHITECTURE.md:118-122](docs/ARCHITECTURE.md#L118).

**Review itinerary (#421)**
- The finishing agent writes `.solenta/review-itinerary/<threadId>.json`, a standing note asks for it, and merge conflicts in it are auto-resolved ([electron/reviewItinerary.js:1-45](electron/reviewItinerary.js#L1); [worktrees.js:1108-1166](electron/worktrees.js#L1108)).

**Sidebar nesting (b149eba3, #1421)**
- Plain forks (handoffFrom without orchWorker) now nest under their source like orchWorkers do. "A family sits on the Working shelf while any member is quietly working, unless a member needs the user" (commit message; [src/sidebarGroups.ts:70-200](src/sidebarGroups.ts#L70), [src/sidebarGroups.ts:438-450](src/sidebarGroups.ts#L438)).
- The sidebar ordering model is explicitly reimplemented from t3code (pingdotgg/t3code, MIT) ([ARCHITECTURE.md:836-851](docs/ARCHITECTURE.md#L836)).
- "Waiting on N" for the parent is derived from `handoffFrom` plus the runner's subagent rows, with no new state ([src/waiting.ts:5-20](src/waiting.ts#L5)).
- AgentsPanel shows a Team roster (Orchestrator / Worker chips), a crew Tasks section, and the Integration view ([src/components/AgentsPanel.tsx:212-213](src/components/AgentsPanel.tsx#L212), [2841-2860](src/components/AgentsPanel.tsx#L2841), [2959-2993](src/components/AgentsPanel.tsx#L2959)).

**Shared memory**
- `memory-server/` is a separate HTTP and MCP server (SQLite/FTS5, bearer token) supervised by `electron/memory-sup.js` and injected as `coder-memory`. Citations are verified against live worktrees ([ARCHITECTURE.md:162-187](docs/ARCHITECTURE.md#L162)).

### Inferences
- Solenta's orchestration is a protocol written as prompt text plus host-side gates, built on threads and git worktrees. The LLM lead decides when to fork, send and ask. The host enforces project scoping, user approval for landing, budget and auto-turn caps, and git safety.
- Every multi-agent feature reduces to three primitives: the `handoffFrom` parent link, the `orchWorker` flag, and the in-memory notice queue. Teams, committees, spec waves, Best-of-N and orchestrator threads are all compositions of these.
- Provider-agnostic, cross-provider delegation is already a first-class feature: pools, `@provider`, `/committee` defaulting to other providers, and `thread_fork provider=`.

### Gaps
- The full input schemas (zod) of every MCP tool were not transcribed. Registration starts at [orchServer.js:1227](electron/orchServer.js#L1227) if exact params are needed.
- I did not verify how often each feature is actually used on the live store. The code comments cite live-store numbers: "190 of 195 finished workers … still held an unmerged worktree" ([orchServer.js:559-563](electron/orchServer.js#L559)), and "13 worker branches were committed straight onto main in a single day" ([orchServer.js:495-498](electron/orchServer.js#L495)).

## 3. Limitations and pain points

### Takeaway
The recurring pain points are:
- Workers cannot be steered mid-run by the lead.
- Lifecycle and wake-up state is in memory only, and crashes lose work.
- Hand-off context is a truncated digest, not shared state.
- Parallel workers coordinate only through prompt discipline and git.
- Landing needed several rounds of retrofitted human gates.
- Sandboxed or approval-restricted sessions often cannot fork, commit or push.
- Single-process god-modules make the store and runner the bottleneck. Many recent commits are perf and race fixes.

### Cited Findings
**Steering**
- `thread_send` to a running thread is queued, not injected: "Mid-run sends are held, not injected" ([orchServer.js:93-94](electron/orchServer.js#L93)). `decideCrossThreadSend` returns `queued` when `running` ([crossThread.js:84-125](electron/crossThread.js#L84) (queued branch at line 109)), and the queued blob drains only when the target is idle ([runner.js:2094-2155](electron/runner.js#L2094)).
- Live steering does exist (`steerRun`, which writes to the CLI's stdin, #156), but only for providers with `supportsSteer` (claude and codex). It is wired to the UI through `runs:steer` ([runner.js:8805-8851](electron/runner.js#L8805); [ipc.js:1526-1527](electron/ipc.js#L1526)) and to the external pairing capability `steer` ([pairing.js:28](electron/pairing.js#L28), [pairing.js:613-633](electron/pairing.js#L613)). It is not exposed as a coder-threads tool for a lead to steer its own workers.
- Willem's 2026-08-17 memory (`thread-send-mid-run.md`) records the older behavior, where `thread_send` failed with "A run is already active". Its advice is to put guardrails in the fork prompt, because a worker on a wrong path "cannot be interrupted". The code now queues instead of failing. The inability to steer remains.

**Crash and restart durability**
- `orchNotices` (pending wake-ups) and `autoTurns` are plain in-memory Maps ([runner.js:1163-1179](electron/runner.js#L1163)), and so is `active` ([runner.js:770](electron/runner.js#L770)).
- On restart, every `working` thread is marked failed ([store.js:1426-1460](electron/store.js#L1426)).
- Memory `grok-worker-midrun-crash.md` (2026-08-19): grok workers die with `error_during_execution / cancelled`, and "an uncommitted worker loses everything it did when the run dies". The mitigation is to tell workers to commit incrementally.
- A worker blocked on a permission prompt "stays 'working' forever and never fires a wake-up notice" (#31). The lead has to poll `thread_status.awaitingInput` ([orchServer.js:807-817](electron/orchServer.js#L807); [orchServer.js:99-101](electron/orchServer.js#L99)).

**Context hand-off**
- "the worker does NOT inherit the source session, only a truncated digest" ([orchServer.js:69-72](electron/orchServer.js#L69); digest caps [services.js:961-963](electron/services.js#L961)).
- "ponytail: tail digest, not a summary" ([services.js:1198](electron/services.js#L1198)).

**Parallel-worker coordination**
- Memory `forking-parallel-solenta-workers.md` (2026-08-17) says workers branch from the project checkout's HEAD (usually main), not the lead's branch. Fixed in code since #948: worktree workers now start from the lead's committed HEAD (`leadSnapshotSha`), and uncommitted lead edits are still not copied ([services.js:1393-1396](electron/services.js#L1393), [worktrees.js:495-614](electron/worktrees.js#L495)).
- No snapshot auto-refresh: "Nothing auto-refreshes — call it explicitly" ([orchServer.js:119-123](electron/orchServer.js#L119)).
- Memory `worker-contract-seam-test.md`: parallel workers each mock the other side of a call seam, so nobody tests the join.
- Memory `worker-merge-clobbers-core-dist.md`: a worker committed a `core/dist` symlink that `thread_merge` landed on main.
- `/advisor` and `/committee` run in the project checkout and are "read-only by contract, not by sandbox" ([ARCHITECTURE.md:565-569](docs/ARCHITECTURE.md#L565)).

**Landing governance was retrofitted after incidents**
- Before the gate, "13 worker branches were committed straight onto main in a single day on the live repo" ([orchServer.js:490-526](electron/orchServer.js#L490)).
- `thread_merge` now also requires `expectedPath` / `expectedBranch` to match the real destination ([orchServer.js:601-625](electron/orchServer.js#L601)).
- "ponytail: `approved` is the agent's own claim, so the turn check is the real lock" ([orchServer.js:500-504](electron/orchServer.js#L500)).
- Workers cannot push: memory `worker-push-blocked-merge-locally.md` (2026-08-20) says "`git push` is gated even under grok's `auto` permission mode". The workaround is to merge local branches, since all worktrees share one repo.

**Sandbox and approval blockers** ([docs/issue-drafts/2026-09-03-solenta-session-blockers.md:7-117](docs/issue-drafts/2026-09-03-solenta-session-blockers.md#L7)):
- Issue 1: `thread_fork`, `task_add` and `hypothesis_record` are rejected with "MCP tool call requires approval, but approval policy is never", and `thread_fork` has no `approved` argument to recover with.
- Issue 2: managed worktrees cannot `git add` or `git commit` because their git metadata is read-only (line 117).
- Issue 3: Planboard needs `gh`, but managed sessions cannot authenticate (line 195).

**Scale and race fixes in recent history** (`git log --oneline -150`):
- "Drop detail-only fields from threads:changed rows (#1389)"
- "Stop blocking the main process on worktree removal (#1393)"
- "P1: Stop re-serializing every thread's work log on each stor…"
- "Bound the renderer ThreadDetail session cache (#1273)"
- "Honor Stop while a run is preparing to launch (#1228)"
- "Let a self-archiving Claude turn finish before reaping its CLI (#1387)"
- "Keep Codex parent sessions stable and land pending thread follow-ups (#1381)"
- "Save dirty orphan worktrees to a recovery branch (#1390)"
- "P1: Do not auto-start queued follow-ups after a failed or st…"
- "Codex resume dies with 'already has an active writer' (#1265)"

**Other caps and ceilings**
- Crew budget roll-up is one level only: "Nested crews are not rolled up; each worker that fans out is its own orchestrator" ([ARCHITECTURE.md:295-302](docs/ARCHITECTURE.md#L295)).
- Warm-CLI LRU cap of 3 ([runner.js:843-845](electron/runner.js#L843)).
- Max 20 workers kept per orchestrator ([runner.js:218](electron/runner.js#L218)).
- Hypothesis note limited to 5 hops ([services.js:1107-1108](electron/services.js#L1107)).
- Sidebar: in-agent subagents show as at most 3 name rows; clicking one falls through to the parent ([ARCHITECTURE.md:915-918](docs/ARCHITECTURE.md#L915)).
- `subagents` rows are capped at 20 ([runner.js:885-900](electron/runner.js#L885)).

**Enforcement is mostly procedural**
- Spec gate: "procedural, not sandboxed" ([ARCHITECTURE.md:726](docs/ARCHITECTURE.md#L726)).
- Governance spec non-goals include confining Kimi, Grok `--always-approve` and Cursor `--force`, "or any CLI that never raises can_use_tool" ([governance spec:28-37](docs/superpowers/specs/2026-09-02-governance-layer-v1-design.md#L28)).

### Inferences
- The biggest structural gap for an "orchestrator 2.0" comparison is durability. Without a persisted command and event log, a crash or restart loses in-flight runs and pending notices, and the lead's view of its crew must be rebuilt by polling `thread_status`.
- Coordination quality depends on lead prompts. Much of the hard-won knowledge (commit contracts first, give each worker disjoint files, commit incrementally, test seams on merge) lives in INSTRUCTIONS strings and private memory notes, not in enforced structure.
- Two of Willem's memory notes are stale against current code: thread_send now queues rather than errors, and workers now start from the lead's committed snapshot rather than main. The report should cite the code, not the notes.

### Gaps
- `docs/ISSUES.md` (124 lines) and the `docs/audits/2026-09-24-thread-ux*.md` series were not read in full. They may contain more UX pain points.
- GitHub issues on currentbits/solenta were not queried. This was local repo only, per the constraints.

## 4. Client/renderer update model

### Takeaway
There are 8 push channels. The sidebar gets the full thread list on every `threads:changed`, a snapshot with detail-only fields stripped. The open thread gets `thread:updated`, a `ThreadPatch` whose messages and workLog are tails from the first changed index, with a per-thread `seq` for gap detection. The same handlers back a token-gated WebSocket bridge for the web client.

### Cited Findings
- `PUSH_CHANNELS` are `threads:changed`, `thread:updated`, `thread:select`, `boot:ready`, `stayAwake:changed`, `simulator:changed`, `simulator:focus` and `speech:changed` ([src/shared/ipcChannels.ts:21-30](src/shared/ipcChannels.ts#L21)).
- Invoke channels are one table shared by `preload.js` and `wireClient.ts` ([ipcChannels.ts:1-20](src/shared/ipcChannels.ts#L1)).
- `pushThreadsChanged` sends `services.listThreads(store)`, the full list ([runner.js:2882-2884](electron/runner.js#L2882)). `listRow` drops detail-only fields (#1385/#1389) ([services.js:4531-4575](electron/services.js#L4531)).
- `pushDetail` builds the full `ThreadDetail` and computes `firstChanged` by reference against the last push. It sends `messages.slice(messagesFrom)`, `workLog.slice(workLogFrom)` and `seq` ([runner.js:2198-2300](electron/runner.js#L2198)).
- `ThreadPatch` docs: "A gap means a push was dropped (web socket reconnect), so the prefix we hold may be stale: refetch instead of merging" ([src/shared/ipc.ts:1722-1737](src/shared/ipc.ts#L1722)).
- The renderer merges with `mergeThreadPatch` and refetches on a seq gap ([src/useCoder.ts:1390-1435](src/useCoder.ts#L1390)). `patchThreadList` keeps row identity when nothing changed, because a run pushes every 700 ms ([src/threadPatch.ts:1-35](src/threadPatch.ts#L1)).
- Web access:
  - `--serve-web` starts a static and HTTP server on 127.0.0.1:4620 by default, token-gated, with no TLS in v1 ([electron/webServer.js:1-25](electron/webServer.js#L1)).
  - `webBridge.js` serves WebSocket `/ws` with `{kind:"auth", token}` first, then invokes through the same `IPC_HANDLERS` and broadcasts pushes ([electron/webBridge.js:1-15](electron/webBridge.js#L1), [webBridge.js:38-57](electron/webBridge.js#L38)).
  - SSH remote Connections (#1408, commit 99394430) tunnel to a remote Solenta web port 4620 and keep web tokens encrypted with the OS keychain ([electron/remoteConnections.js:1-20](electron/remoteConnections.js#L1)).

### Inferences
- The update model is a hybrid of a "snapshot plus tail-diff" stream and a sequence counter. It is not an event stream: clients cannot replay history, and a second client can only refetch. The diff relies on the store patching message objects immutably, so unchanged rows keep reference identity ([runner.js:2190-2197](electron/runner.js#L2190)).
- The full-list `threads:changed` push on many events scales with thread count. #1389 already trimmed the row payload for this reason.

### Gaps
- The `src/wireClient.ts` reconnect and resync logic was not read in detail.

## 5. Features already resembling T3 Code "Orchestrator 2.0" concepts

### Takeaway
Several building blocks exist in partial form: steering (UI only), queued follow-ups and inbound queues, permission and plan approval cards, plan mode, a two-level sub-agent tree, cross-provider delegation, remote and web access, external MCP pairing, OTel trace trees and a deterministic orchestrator hop. Two foundations are missing: an event-sourced command/event log, and a durable server-side command queue.

### Cited Findings
- **Event sourcing:** none (§1).
- **Command queues:** what exists is
  - a per-thread `queued` blob that accumulates "thoughts" `items[]` joined into one prompt (#809) and drains when idle ([services.js:1755-1835](electron/services.js#L1755); `ThreadInfo.queued` [ipc.ts:627-650](src/shared/ipc.ts#L627));
  - inbound cross-thread policy `accept` / `queue-only` / `refuse` ([crossThread.js:11-26](electron/crossThread.js#L11));
  - the in-memory notice queue ([runner.js:1163-1170](electron/runner.js#L1163)).
- **Approvals UI:**
  - Permission cards come from `getPendingPermission` / `respondPermission` ([runner.js:2310](electron/runner.js#L2310), [runner.js:2577](electron/runner.js#L2577)), and the proposed shell command is editable before approval (#509) ([ARCHITECTURE.md:779-781](docs/ARCHITECTURE.md#L779)).
  - Codex native approvals go through JSON-RPC ([runner.js:2444-2577](electron/runner.js#L2444)).
  - CI-workflow merge sign-off is a human card ([orchServer.js:632-640](electron/orchServer.js#L632)).
  - `ask_user` adds multiple-choice cards ([orchServer.js:829-850](electron/orchServer.js#L829)).
- **Plan mode:** ExitPlanMode is captured as a `pendingPlan` card that holds queued type-ahead until approved (#707) ([runner.js:2353-2390](electron/runner.js#L2353), [runner.js:2792-2842](electron/runner.js#L2792); [runner.js:2130-2133](electron/runner.js#L2130)). TodoWrite becomes `planSteps` ([runner.js:2904-2920](electron/runner.js#L2904); "ponytail: TodoWrite (claude) only" [services.js:1162](electron/services.js#L1162)).
- **Sub-agent trees:**
  - Thread-level: `handoffFrom` chains and `orchWorker` crews, with nested sub-leads allowed ("a worker that is itself a lead folding its sub-crew", [orchServer.js:586-596](electron/orchServer.js#L586)).
  - In-CLI: Agent-tool subagents are tracked as `ThreadInfo.subagents` rows ([ipc.ts:766-771](src/shared/ipc.ts#L766); [runner.js:885-1022](electron/runner.js#L885)).
  - The OTel trace is rooted at the crew root ([ARCHITECTURE.md:397-401](docs/ARCHITECTURE.md#L397)).
- **Cross-provider delegation:** `thread_fork provider=`, `pool=<alias>` with failover, `@provider` in the composer, `/handoff` `/advisor` `/committee`, and Best-of-N across providers (§2).
- **Remote and web access:** `--serve-web` plus the WebSocket bridge, SSH remote Connections, and external MCP pairing tokens with launch and steer capabilities (§4; [pairing.js:1-28](electron/pairing.js#L1)).
- **Workflows:** a template engine (`core/` plus `electron/workflow.js`) with a builtin "Plan and Verify" ([ARCHITECTURE.md:53-59](docs/ARCHITECTURE.md#L53)). Automations mint agent turns on a cadence ([ARCHITECTURE.md:127-129](docs/ARCHITECTURE.md#L127)).
- **Prior T3 Code borrowing:** the sidebar model reimplements t3code rules ([ARCHITECTURE.md:836-851](docs/ARCHITECTURE.md#L836)). A T3 transcript-grouping design exists at [docs/superpowers/specs/2026-08-29-t3-transcript-grouping-design.md](docs/superpowers/specs/2026-08-29-t3-transcript-grouping-design.md), and commit 531fd0f9 is titled "Calm the UI: T3-style inbox".

### Inferences
- Gap-analysis framing for the report writer:
  - Solenta is ahead or at par on breadth: cross-provider crews, a task board, gated landing, verify and checkpoints, Planboard, a merge queue and memory.
  - It is likely behind wherever T3 Code's Orchestrator 2.0 relies on a durable event or command model: replayable history, multi-client sync, crash-safe resume of runs and wake-ups, and server-side queues.
  - It is also likely behind on structured (non-prompt) steering of workers by a lead.
- The external pairing `steer` capability shows a host-side steer path already exists. Exposing `steerRun` to leads (for claude and codex) would be a small step. Whether it is desirable is a product question.

### Gaps
- This note does not describe T3 Code's Orchestrator 2.0. That is another researcher's scope, so no direct feature-by-feature mapping is asserted here.
