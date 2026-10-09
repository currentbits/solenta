# Solenta implementation designs for #1425–#1428 (T3 Orchestrator V2 follow-ups)

All sources are the local checkout `/Users/willem/Library/Application Support/Solenta/worktrees/fae77a0b-5c8a-4a21-ba4f-b07f933538ed` at `fbba4e10` (branch `coder/i-want-you-to-research-t3-codes-orchestr-fae77a0b`), read on 2026-10-04. Links are relative to this notes file (`../../<path>#L<n>`). No code was changed, no app run, no test suite run. `electron/providers.js` was read with `LC_ALL=C grep -a` / `LC_ALL=C sed` because of its NUL byte. `git log --oneline -400` shows no commit mentioning #1425–#1428, `boundThread` or replay fixtures, so none of this work has started.

## #1425 — Bind the caller's thread id at the MCP transport, and refuse forks that escalate permission mode

### Takeaway
The bypass is real and wider than the report says. Solenta binds `coder-threads` to a **project**, never to a thread. `?projectId=` is written into a different config for each provider, and three of those are user-global, last-write-wins files. Every tool still identifies the caller by a thread id the agent supplies itself. Omitting `fromThreadId` skips the stop/archive gate, and an existing test asserts that behaviour.

Three more holes need closing in the same change:
- **Claimed `threadId` on landing tools.** Any running thread can claim another `threadId` on `thread_merge`/`thread_pr`.
- **Inbound sends count as human turns.** A `fromInbound` turn (another agent's `thread_send`) resets `autoTurns`, so the next turn passes the "not machine-delivered" check.
- **Unattended-sender refusal is skippable.** Omitting `fromThreadId` on `thread_send` skips the "unattended sender" refusal.

**Cost of the fix:**
- Per-thread binding is nearly free for Codex, Grok, Kimi, Cursor and Muse, which already get per-turn argv or per-thread home overlays.
- Claude needs one config file per thread.
- OpenCode gets no `coder-threads` injection at all.
- The URL parameter alone can be forged by any agent that can read its own token. Deriving a per-thread HMAC token is about 20 more lines and makes the binding a real boundary.
- No permission-mode ranking exists today. `snapPermissionMode` **escalates** `default`/`acceptEdits` to `bypassPermissions` on grok, kimi, cursor, opencode and muse.

### Cited Findings
**How the URL is built today: per project, not per thread**
- `boundSolentaMcpUrl` adds only `projectId` for `coder-threads` and only `project` (a path) for `coder-memory` ([memory-sup.js:635-645](../../electron/memory-sup.js#L635)). `withQuery` leaves the string untouched when nothing is bound ([memory-sup.js:599-611](../../electron/memory-sup.js#L599)).
- **Claude.** `getClaudeMcpArgs({projectPath, projectId, memoryOnly})` writes a bound copy via `writeBoundMcpConfig` ([memory-sup.js:321-363](../../electron/memory-sup.js#L321)).
  - The file is `<userData>/mcp-bound/<sha1([projectPath, projectId]).slice(0,12)>.json`. It is keyed by cwd + project, so a lead and its `worktree:false` workers share one file ([memory-sup.js:1713-1732](../../electron/memory-sup.js#L1713)).
  - The document is built by `mcpServersDoc`, and the bearer token is written into the file's `headers.Authorization` ([memory-sup.js:1651-1691](../../electron/memory-sup.js#L1651)).
  - The unbound global `mcp-coder-memory.json` is "shared by concurrent Claude runs" ([memory-sup.js:1693-1705](../../electron/memory-sup.js#L1693)).
  - The runner call site is [runner.js:4177-4185](../../electron/runner.js#L4177). The workflow engine is a second call site ([workflow.js:480](../../electron/workflow.js#L480)).
  - `claude.js` calls `getClaudeMcpArgs()` with no arguments, which means unbound ([claude.js:154-155](../../electron/claude.js#L154)).
- **Codex.** URLs are passed per spawn as `-c mcp_servers.<name>.url="…"` argv ([memory-sup.js:476-481](../../electron/memory-sup.js#L476)). The token travels in an env var, `CODER_MCP_TOKEN_<NAME>`, through `getCodexMcpEnv` ([memory-sup.js:366-377](../../electron/memory-sup.js#L366), [memory-sup.js:516-539](../../electron/memory-sup.js#L516)).
  - Call sites: [runner.js:5081-5084](../../electron/runner.js#L5081) and [workflow.js:653](../../electron/workflow.js#L653).
  - The app-server is a "Per-turn private app-server", not one shared across threads ([codex-appserver.js:332-347](../../electron/codex-appserver.js#L332)).
- **Grok.** Each thread gets its own `GROK_HOME` at `<userData>/grok-homes/<threadId>`, materialized with `kimiMcpServersForRun({projectId, projectPath})` ([runner.js:4187-4218](../../electron/runner.js#L4187)).
  - Without `userDataPath`, it falls back to `ensureGrokMcpConfig`, which writes the user-global `~/.grok/config.toml` ([runner.js:4235-4244](../../electron/runner.js#L4235); [memory-sup.js:1389-1416](../../electron/memory-sup.js#L1389)).
  - Remote ssh/WSL overlays "never copy host credentials or MCP URLs" ([grok.js:455](../../electron/grok.js#L455)).
- **Kimi.** Each thread gets its own `KIMI_CODE_HOME` at `<userData>/kimi-homes/<threadId>` ([runner.js:5860-5883](../../electron/runner.js#L5860)). `kimiMcpServersForRun` sets `query.projectId` only ([memory-sup.js:686-702](../../electron/memory-sup.js#L686)). `ensureKimiMcpConfig` merges **unbound** entries into `~/.kimi-code/mcp.json` ([memory-sup.js:717-756](../../electron/memory-sup.js#L717)).
- **Cursor.** Each thread gets its own `HOME` at `<userData>/cursor-homes/<threadId>` ([runner.js:6708-6727](../../electron/runner.js#L6708)). It falls back to `ensureCursorMcpConfig({projectPath, projectId})`, which merges into the user-global `~/.cursor/mcp.json` ([runner.js:6728-6749](../../electron/runner.js#L6728); [memory-sup.js:950-997](../../electron/memory-sup.js#L950)).
- **Muse.** Each thread gets its own home at `<userData>/muse-homes/<threadId>` with `kimiMcpServersForRun` ([runner.js:7202-7216](../../electron/runner.js#L7202)).
- **Workflow engine.** It uses `kimiMcpServersForRun` at [workflow.js:846](../../electron/workflow.js#L846) and [workflow.js:1025](../../electron/workflow.js#L1025).
- **OpenCode.** The run sets only `OPENCODE_CONFIG_DIR` for the guardrail plugin ([runner.js:6197-6225](../../electron/runner.js#L6197)). `memory-sup.js` contains no `opencode` string. The only `mcp` hits in providers.js are claude/grok comments and cursor `--approve-mcps` (`LC_ALL=C grep -an mcp electron/providers.js` → lines 578, 1369, 1387). So OpenCode gets no first-party `coder-threads` injection.
- Overlay homes are reclaimed in the retention pass ([worktrees.js:6390-6394](../../electron/worktrees.js#L6390); grok [grok.js:641-657](../../electron/grok.js#L641); cursor [cursor.js:554-573](../../electron/cursor.js#L554); kimi [kimi.js:284-311](../../electron/kimi.js#L284)). Nothing reclaims `mcp-bound/` (grep for `mcp-bound` hits only [memory-sup.js:1719](../../electron/memory-sup.js#L1719)).

**How orchServer reads identity**
- Each POST is authenticated in one of two ways ([orchServer.js:1924-1937](../../electron/orchServer.js#L1924)):
  - the shared session token, via `authorized()`, which accepts `Authorization: Bearer` or `?token=` ([orchServer.js:147-155](../../electron/orchServer.js#L147));
  - a pairing token.
- The token is "Fresh … every launch" ([orchServer.js:275-281](../../electron/orchServer.js#L275)).
- On the non-pairing path, `boundProjectId = url.searchParams.get("projectId")` feeds `createToolHandlers({...handlerDeps, boundProjectId})` ([orchServer.js:1963-1978](../../electron/orchServer.js#L1963)). That is the only place identity enters.
- `assertSameProject` silently prefers the bound id over the claimed one (`want = boundProjectId || claimed`). It does not reject a mismatch ([orchServer.js:336-351](../../electron/orchServer.js#L336)).
- **Pairing clients never reach `createToolHandlers`.** They get `pairing.createExternalHandlers` with their own six tools (`projects_list`, `task_list/status/launch/send/stop`) scoped to threads the pairing owns ([orchServer.js:1954-1962](../../electron/orchServer.js#L1954); [pairing.js:489](../../electron/pairing.js#L489), [pairing.js:612-662](../../electron/pairing.js#L612)).
- The web bridge and web server do not import orchServer (no `orchServer`/`createToolHandlers` hit in `webBridge.js`/`webServer.js`). They go through `IPC_HANDLERS`.

**Every handler that identifies the caller from args**
- **Cross-thread gate.** `assertCrossThreadApproved` does `if (!fromId || fromId === targetId) return;`, and `isAutoTurn` runs on the *claimed* `fromThreadId` ([orchServer.js:536-557](../../electron/orchServer.js#L536)). It is used by `thread_archive` (only when `archived` is truthy) and by `thread_stop` ([orchServer.js:1012-1016](../../electron/orchServer.js#L1012), [orchServer.js:1058-1063](../../electron/orchServer.js#L1058)).
- **The bypass is tested as correct behaviour.** `thread_stop({threadId:"t2", projectId:"p1"})` with no `fromThreadId` is expected to stop t2 ([orch-server.test.js:1066-1071](../../electron/test/orch-server.test.js#L1066)). The gated cases always pass `fromThreadId` ([orch-server.test.js:814-857](../../electron/test/orch-server.test.js#L814)).
- **`thread_send`.** `from` exists only when `args.fromThreadId` is given ([orchServer.js:696-706](../../electron/orchServer.js#L696)). `decideCrossThreadSend` refuses an unattended sender only `if (from && isUnattended(from))` ([crossThread.js:83-88](../../electron/crossThread.js#L83)), so omitting `fromThreadId` skips both attribution and that refusal.
- **Tools where `args.threadId` *is* the caller:**
  - `thread_fork` uses it as source ([orchServer.js:419-452](../../electron/orchServer.js#L419)).
  - `thread_merge`/`thread_pr` use it as `self`, via `requireLandableWorker` ([orchServer.js:459-488](../../electron/orchServer.js#L459)). The approval gate then calls `runner.isAutoTurn(self.id)` on that claimed `self` ([orchServer.js:510-526](../../electron/orchServer.js#L510)).
  - `ask_user` ([orchServer.js:838-850](../../electron/orchServer.js#L838)), `hypothesis_record` (852-869), `work_suggest` (871-894), `spec_submit` (896-903), `teach_review` (905-916), `task_add/list/claim/complete/release` (918-990), `peer_send` (`from = args.threadId`, 992-1010), `refresh_worker_snapshot` (`self`, 1134-1153) and `preview` (1155-1180).
- **Target-only tools with no gate:** `thread_settle`, `thread_rename` and `issue_*`. For `issue_*` the thread only selects the project's origin ([orchServer.js:1042-1127](../../electron/orchServer.js#L1042)).
- **Schemas and instructions.** The `fromThreadId` schema is optional on `thread_send`, `thread_archive` and `thread_stop` ([orchServer.js:1359](../../electron/orchServer.js#L1359), [1380](../../electron/orchServer.js#L1380), [1418](../../electron/orchServer.js#L1418)). INSTRUCTIONS asks agents to "Pass fromThreadId as YOUR OWN thread id" ([orchServer.js:92-94](../../electron/orchServer.js#L92)). The prompt footer states the id: "[Thread] You are thread … Pass these ids" ([services.js:1046-1060](../../electron/services.js#L1046)).

**`isAutoTurn` treats agent sends as human**
- `isAutoTurn(id)` is `(autoTurns.get(id) || 0) > 0` ([runner.js:9033-9035](../../electron/runner.js#L9033)).
- `startRun` resets the counter for anything that is not `fromNotice`: `if (!input.fromNotice && !isReplayTurn(input)) autoTurns.set(threadId, 0)` ([runner.js:8251-8253](../../electron/runner.js#L8251)).
- `thread_send` starts the target with `fromInbound: true` ([orchServer.js:760-767](../../electron/orchServer.js#L760)), and `drainQueued` passes `fromInbound: taken.inbound === true` ([runner.js:2094-2112](../../electron/runner.js#L2094)). Both reset the counter, even though the runner itself treats `fromInbound` as a machine turn when it keeps question and plan cards ([runner.js:8490](../../electron/runner.js#L8490)).

**Permission modes today**
- The four modes are `default, acceptEdits, plan, bypassPermissions` ([providers.js:94-99](../../electron/providers.js#L94)). They have no rank or ordering anywhere: grep for `PERMISSION_RANK|permissionRank` in providers.js finds nothing.
- `honouredPermissionModes` returns the entry's list ([providers.js:180-184](../../electron/providers.js#L180)).
- `snapPermissionMode` maps an unsupported request to the nearest supported mode ([providers.js:194-215](../../electron/providers.js#L194)). Several of those mappings escalate:
  - `acceptEdits` → `bypassPermissions` when available;
  - `default` → `bypassPermissions`;
  - `plan` → `default`, else `bypassPermissions`.
- Honoured lists:

  | Provider | Honoured modes | Source |
  |---|---|---|
  | claude | all four | [providers.js:305](../../electron/providers.js#L305) |
  | codex | all four | [providers.js:476](../../electron/providers.js#L476) |
  | grok | `plan`, `bypassPermissions` | [providers.js:571](../../electron/providers.js#L571) |
  | opencode | `default`, `bypassPermissions` | [providers.js:732](../../electron/providers.js#L732) |
  | kimi | `bypassPermissions` | [providers.js:843](../../electron/providers.js#L843) |
  | cursor | `plan`, `bypassPermissions` | [providers.js:1362](../../electron/providers.js#L1362) |
  | muse | `default`, `bypassPermissions` | [providers.js:1431](../../electron/providers.js#L1431) |

- `forkThread` creates the thread *before* computing the mode: `createThread` at [services.js:1331](../../electron/services.js#L1331), then `snapPermissionModeForThread(nextEntry, source.permissionMode, forkPatch.teach)` at [services.js:1356-1360](../../electron/services.js#L1356), then `updateThread` at [services.js:1379](../../electron/services.js#L1379). The snap is the teach-capped wrapper at [services.js:3619-3633](../../electron/services.js#L3619).
- `forkWorkerThread` resolves the pool, captures the lead snapshot, then calls `forkImpl` ([services.js:1403-1466](../../electron/services.js#L1403)).
- Pool failover re-snaps through `setProvider` ([subagentPool.js:352-398](../../electron/subagentPool.js#L352), [subagentPool.js:381](../../electron/subagentPool.js#L381); [services.js:1557-1561](../../electron/services.js#L1557)).
- Fork call sites:
  - `threads:fork`, the UI ([ipc.js:695-699](../../electron/ipc.js#L695));
  - `thread_fork`, the agent ([orchServer.js:438](../../electron/orchServer.js#L438));
  - `/handoff` `/advisor` `/committee` ([runner.js:7740](../../electron/runner.js#L7740));
  - the orchestrator `pendingFork` path ([runner.js:8332](../../electron/runner.js#L8332));
  - spec waves ([services.js:3477](../../electron/services.js#L3477)).
- Pool entries are `{alias, provider, model, description}`, and `parseEntry` returns exactly those four fields, so any new flag is dropped on load unless added there ([subagentPool.js:11-12](../../electron/subagentPool.js#L11), [subagentPool.js:66-71](../../electron/subagentPool.js#L66); TS [ipc.ts:2795-2816](../../src/shared/ipc.ts#L2795)). The UI is `src/components/SettingsModal.tsx`.
- There is a typed-error precedent: `err.code = "CI_WORKFLOW"` ([orchServer.js:637-639](../../electron/orchServer.js#L637)).

### Inferences
**Design (do in this order; each step is independently shippable):**

1. **Carry the thread id in every per-run config, never in a user-global one.**
   - Add `threadId` to the `opts` of `boundSolentaMcpUrl`, so `coder-threads` gets `?projectId=P&threadId=T`.
   - Do the same in `kimiMcpServersForRun` ([memory-sup.js:699](../../electron/memory-sup.js#L699)), `getCodexMcpArgs`, `getClaudeMcpArgs`→`writeBoundMcpConfig` (add `threadId` to the sha1 key at [memory-sup.js:1716](../../electron/memory-sup.js#L1716)) and `mcpServersDoc`.
   - Pass `threadId` from runner call sites 4177 (claude), 4209 (grok overlay), 5081 (codex), 5876 (kimi), 6723 (cursor overlay) and 7213 (muse), and from workflow.js 480/653/846/1025 when the phase has a thread.
   - **Do not** pass it to `ensureGrokMcpConfig`/`ensureCursorMcpConfig`/`ensureKimiMcpConfig`. Those write shared files where the last write wins, so a bound thread id there would make thread B act as thread A.
   - Callers on those fallbacks (ssh/WSL, no `userDataPath`, the user's own CLI) and `claude.js:155` stay unbound.
   - Add `mcp-bound/` to the retention reclaim, deleting files older than 7 days. They are rewritten at every spawn, and tokens rotate per launch, so stale files only hold dead tokens.

2. **Make the binding unforgeable (recommended, about 20 lines).**
   - The `?threadId=` parameter by itself is advisory. Every per-thread config also contains the shared token: Claude's file `headers.Authorization`, or Codex's `CODER_MCP_TOKEN_CODER_THREADS` env var. An agent with a shell can `curl` the loopback port with any `threadId`.
   - Derive `threadToken = HMAC-SHA256(config.token, threadId)` (hex) and write *that* as the bearer in per-thread configs.
   - In `authorized()` accept either the shared token (unbound path) or `timingSafeEqual(bearer, hmac(token, url.threadId))`. A bearer that matches the HMAC is the only way to get `boundThreadId`.
   - This is V2's session-scoped token without the mint/revoke bookkeeping: rotation per launch already revokes everything.
   - **Residual risk:** the shared token still sits in the user-global kimi/grok/cursor files written at `markHealthy` ([memory-sup.js:1742-1761](../../electron/memory-sup.js#L1742)). It stays readable by any same-user process. Document it; removing global registration is a separate decision.

3. **orchServer identity plumbing.**
   - At [orchServer.js:1964](../../electron/orchServer.js#L1964) read `boundThreadId` (only when step 2 authenticated it) and pass it to `createToolHandlers`.
   - Add one helper next to `assertSameProject`:
     `function caller(claimed) { if (boundThreadId) return boundThreadId; return claimed != null && claimed !== "" ? String(claimed) : ""; }`
     Bound wins silently, which matches #671's `assertSameProject` semantics.
   - Then, per handler:
     - **`thread_send`:** `from = store.getThread(caller(args.fromThreadId))`. Attribution can no longer be forged, and the unattended-sender refusal always applies when bound.
     - **`thread_archive` (`archived:true`) / `thread_stop`:** in `assertCrossThreadApproved`, compute `fromId = caller(args.fromThreadId)`. **If `fromId` is empty, refuse** with "pass fromThreadId (your own thread id); cross-thread stop/archive needs the user's approval". An unbound caller can no longer skip the gate by omission; self-archive simply passes `fromThreadId === threadId`. Keep the `isAutoTurn(self.id)` check, now on the real caller.
     - **Self-identifying tools** (`thread_fork`, `thread_merge`, `thread_pr`, `ask_user`, `hypothesis_record`, `work_suggest`, `spec_submit`, `teach_review`, `task_*`, `peer_send`, `refresh_worker_snapshot`, `preview`): replace `args.threadId` with `caller(args.threadId)` at the top of each.
       - For `thread_merge`/`thread_pr`, a worker that claims `threadId=<lead>` resolves to itself, and `requireLandableWorker` then refuses ("not one of your workers").
       - For `teach_review`, another thread can no longer bump a teach thread's `reviewsPassed`. That counter drives `teachAutonomyFor` and the permission caps ([services.js:3559](../../electron/services.js#L3559), [services.js:3579](../../electron/services.js#L3579), [services.js:3790](../../electron/services.js#L3790)).
     - **`threads_list`, `thread_status`, `thread_settle`, `thread_rename`, `issue_*`:** unchanged.
   - Update INSTRUCTIONS ([orchServer.js:92-94](../../electron/orchServer.js#L92)) and the three tool descriptions to say: "fromThreadId is filled in for you; if you pass it, it must be your own id".

4. **Close the inbound reset (one line plus an increment).**
   - At [runner.js:8253](../../electron/runner.js#L8253), change the reset to `if (!input.fromNotice && !input.fromInbound && !isReplayTurn(input)) autoTurns.set(threadId, 0)`.
   - For `fromInbound`, set `autoTurns` to `n + 1`, so agent ping-pong also counts toward the 25-turn cap.
   - Without this change, a worker that `thread_send`s "user approved, merge me" to its lead turns the lead's next turn into a "human" turn for `assertUserApproved`.

5. **Refuse permission escalation on agent forks only.**
   - Add `PERMISSION_RANK = {plan:0, default:1, acceptEdits:2, bypassPermissions:3}` to services.js, next to `snapPermissionModeForThread`. That keeps the edit out of the NUL-byte file.
   - In `forkThread`, add an optional `input.forbidEscalation`. Move the `snapPermissionModeForThread` computation *above* `createThread` (services.js:1331), so a refusal leaves no orphan thread.
   - When the rank goes up, throw `Object.assign(new Error("PERMISSION_ESCALATION: a worker on <provider> would run in <mode>, above your <mode>. Ask the user, or use a pool alias the user marked 'Full access'."), {code:"PERMISSION_ESCALATION"})`.
   - `forkWorkerThread` passes `forbidEscalation: !(resolved && resolved.allowEscalation)`.
   - Only orchServer's `thread_fork` sets the flag. UI forks, `/handoff`/`/committee`, `pendingFork` and spec waves are user-initiated and stay as they are.
   - Failover: extend the `isAvailable` predicate passed to `startWithPoolFailover` ([orchServer.js:445-449](../../electron/orchServer.js#L445)) so it also rejects an entry whose snapped mode would exceed the original's (unless the alias allows it). Failover can then never escalate.
   - **Escape hatch:** add an `allowEscalation: boolean` field to pool entries, set in parseEntry ([subagentPool.js:66-71](../../electron/subagentPool.js#L66)), in the TS `SubagentPoolEntry` and in a "Full access" checkbox in `SettingsModal.tsx`. It is only ever user-set, never a tool arg.
   - **Behaviour change to expect:** a Claude/Codex lead in `default` that forks `provider=grok|kimi|cursor` (no pool) will now be refused. Willem's grok workers need `bypassPermissions` per his notes, so ship the alias flag in the same PR.

**Test plan (existing infra: `node --test electron/test/*.test.js` via [scripts/test-electron.js](../../scripts/test-electron.js); handler-level fakes in `makeDeps()` [orch-server.test.js:125](../../electron/test/orch-server.test.js#L125)):**
- **Unit, orch-server.test.js:**
  - (a) A bound worker calling `thread_stop({threadId: lead})` with no `fromThreadId` is refused unless approved on a human turn.
  - (b) An unbound `thread_stop` without `fromThreadId` is refused. This **rewrites** the test at 1066-1071, and self-archive tests at 886-960 must pass `fromThreadId` equal to `threadId`.
  - (c) A bound caller's claimed `fromThreadId` of another thread is ignored for attribution.
  - (d) A worker calling `thread_merge` with `threadId=lead` is refused.
- **HTTP binding test,** cloned from [orch-server.test.js:1481-1517](../../electron/test/orch-server.test.js#L1481): `?threadId=` with the HMAC bearer binds; `?threadId=` with the shared bearer does **not** bind.
- **URL assertions:** update the exact Codex URL string in [orch-server.test.js:1834-1836](../../electron/test/orch-server.test.js#L1834) and the bound-URL assertions in `kimi-home`/`grok-home`/`cursor-home`/`muse-home`/`memory-sup`/`codex` tests (each references the builders).
- **Fork escalation:** default-mode Claude lead plus `thread_fork provider=grok` → `PERMISSION_ESCALATION` and no new thread. With a pool alias carrying `allowEscalation` → allowed.
- **Runner (crew-notices.test.js pattern):** a `fromInbound` startRun leaves `isAutoTurn` true.

**Risks:**
- Agents that legitimately forked *another* thread's context via `thread_fork threadId=X` now fork themselves. No such use is documented in INSTRUCTIONS.
- If the per-thread Claude file is not written atomically, two kept-alive sessions could clash. Each thread now has its own file, which removes today's shared-file clobber risk.
- OpenCode has no `coder-threads` tools, so the binding does not apply to it. Note this in the PR rather than fixing it here.

**Revised size:** about **250–350 changed lines including tests**, roughly 2 days. That is the upper end of S or a small M. The report said S. The extra work is 7 injection sites, the HMAC, the inbound fix, the pool flag plus its Settings checkbox, and rewriting tests that currently encode the bypass.

### Gaps
- I did not verify whether the Claude CLI expands `${VAR}` in `--mcp-config` headers. If it does, the Claude token could move to env instead of a per-thread file. The per-thread file works either way.
- I did not check which workflow.js phases have a stable `threadId` in `opts`.
- The teach-review escalation path is inferred from code, not exercised.

## #1426 — Durable crew notices and honest restart with consent-gated "Resume crew"

### Takeaway
`orchNotices` and `autoTurns` are two plain Maps with exactly four write sites and three read sites. They die on **both** crash and clean quit:
- **Crash:** store load marks `working` threads failed.
- **Clean quit:** `stopAll` marks them `idle` with `stoppedAt`.

Neither path tells the lead.

The fix is:
- Move both Maps into top-level store maps named `orchNoticesByThread` and `autoTurnsByThread`. The `*ByThread` suffix gets delete-cleanup for free, but each needs one line in the load whitelist.
- Make each notice a record, `{id, kind, …, held?}`.
- Mark every persisted record `held` on load.
- Enqueue an "interrupted" record for each in-flight `orchWorker` in both recovery paths.
- Make `flushOrchNotices` refuse while any record is held.
- Add one IPC, `runs:resumeCrew`, and a status strip in ThreadView modelled on the quota-wait strip.

### Cited Findings
**Full lifecycle of the Maps**
- Declarations: `orchNotices: Map<threadId, string[]>` ([runner.js:1163-1170](../../electron/runner.js#L1163)) and `autoTurns: Map<threadId, number>` ([runner.js:1172-1179](../../electron/runner.js#L1172)).
- **orchNotices writes:**
  - `enqueueNotice` push ([runner.js:1268-1272](../../electron/runner.js#L1268)), reached from `deliverNotice` for peer and crew lines ([runner.js:1282-1294](../../electron/runner.js#L1282)) and from `queueOrchNotice` for worker finished ([runner.js:1302-1339](../../electron/runner.js#L1302));
  - `flushOrchNotices` deletes on a missing thread ([runner.js:1365-1366](../../electron/runner.js#L1365)) and before delivery ([runner.js:1389](../../electron/runner.js#L1389));
  - `stopCrew` deletes and writes the lines as an event ([runner.js:8793-8800](../../electron/runner.js#L8793)).
- **autoTurns writes:** increment in flush ([runner.js:1398-1404](../../electron/runner.js#L1398)) and reset in `startRun` ([runner.js:8253](../../electron/runner.js#L8253)). **Read:** `isAutoTurn` ([runner.js:9033-9035](../../electron/runner.js#L9033)).
- **Flush triggers:** `queueOrchNotice` → `flushOrchNotices(parent)` (1338), `deliverNotice` (1290), `afterFailedTurn` (1451-1452), `finishSuccessfulTurn` (1600-1601), the Codex release timer `scheduleCodexReleaseFlush` (1201-1213), [runner.js:1971](../../electron/runner.js#L1971) and [runner.js:8994](../../electron/runner.js#L8994).
- **Gates run at wake time, inside a Promise:**
  - `assertUnderOrchestrationBudget`, then `n >= services.CREW_AUTO_TURN_CAP` → throw. The cap is 25 ([services.js:2701](../../electron/services.js#L2701)).
  - The catch appends `"<prompt>\n\nNot delivered: <reason>"` as an event with `fromNotice`, and marks the lead `failed` if it is idle ([runner.js:1391-1433](../../electron/runner.js#L1391)).
  - Delivery is skipped while the lead is active, and parked for Codex writer locks ([runner.js:1363](../../electron/runner.js#L1363), [runner.js:1369-1387](../../electron/runner.js#L1369)).
- **Prompt shape:** `noticePrompt` joins lines, prefixes `[orchestration] ` unless the text starts with `[`, and appends "Continue orchestrating; thread_status has full details." ([runner.js:1348-1352](../../electron/runner.js#L1348)).

**Store shape, save path and back-compat**
- `EMPTY` holds the top-level maps, including `tasksByCrew` and `digestSeenAt` ([store.js:78-104](../../electron/store.js#L78)). A second literal copy exists at [store.js:4125-4141](../../electron/store.js#L4125).
- Load builds `data` from an **explicit key list**, so unknown top-level keys are dropped. `tasksByCrew` is the pattern to copy: accept an object that is not an array, else `{}` ([store.js:2451-2456](../../electron/store.js#L2451)).
- Recovery runs right after: `this._recoveredOnLoad = recoverInterruptedRuns(this, data) || …` ([store.js:2463](../../electron/store.js#L2463)).
- `deleteThread` deletes `threadId` from **every** key ending in `ByThread` ([store.js:3970-3976](../../electron/store.js#L3970)).
- Envelope serialization writes all top-level keys (`_serialize` → `stringifyStore`, [store.js:2358-2379](../../electron/store.js#L2358)).
- `save()` is debounced at a flat 250 ms ([store.js:258-261](../../electron/store.js#L258), [store.js:2580-2590](../../electron/store.js#L2580)). The async flush uses tmp, then fsync, then rename ([store.js:2603-2660](../../electron/store.js#L2603); sync variant `writeAtomicSync` [store.js:1518-1541](../../electron/store.js#L1518)).
- Accessor precedent: the `tasksByCrew` getter and setter ([store.js:3323-3343](../../electron/store.js#L3323)).

**Restart paths**
- **Crash:** `recoverInterruptedRuns` sets every `working` thread to `failed` with `lastError "Run error: app quit while the run was in flight"` and splices the event "Run interrupted: the app crashed or was force-quit mid-run". Its docstring says "clean quits mark idle via runner.stopAll first" ([store.js:1413-1461](../../electron/store.js#L1413)).
- **Clean quit:** `stopAll` (called from main.js before-quit, [main.js:915](../../electron/main.js#L915)) kills runs, appends "Run interrupted by app quit", sets `{status:"idle", stoppedAt}`, and notes "a quit-interrupted worker never resumes on its own" ([runner.js:9074-9121](../../electron/runner.js#L9074)). It never calls `queueOrchNotice`.

**UI hooks**
- The quota-wait status strip, with "Resume now" (`onResumeQuotaWait`) and "Don't auto-resume", is the precedent ([ThreadView.tsx:8346-8385](../../src/components/ThreadView.tsx#L8346)). The prop is declared at [ThreadView.tsx:523](../../src/components/ThreadView.tsx#L523) and wired from App at [App.tsx:2297-2299](../../src/App.tsx#L2297).
- **IPC chain for the precedent:**
  - `ipcChannels.ts` entry `{ ns: "runs", method: "resumeQuotaWait" }` ([ipcChannels.ts:182](../../src/shared/ipcChannels.ts#L182));
  - the inlined preload copy ([preload.js:214](../../electron/preload.js#L214)), regenerated with `node --experimental-strip-types scripts/sync-ipc-preload.js` ([ipcChannels.ts:1-17](../../src/shared/ipcChannels.ts#L1));
  - the `CoderApi` type ([ipc.ts:4475-4480](../../src/shared/ipc.ts#L4475));
  - the handler `"runs:resumeQuotaWait"` ([ipc.js:1538-1539](../../electron/ipc.js#L1538));
  - the `useCoder` method ([useCoder.ts:509](../../src/useCoder.ts#L509), [useCoder.ts:2504-2507](../../src/useCoder.ts#L2504));
  - the `devCoder.ts` stub ([devCoder.ts:4899](../../src/devCoder.ts#L4899)).
- `ThreadDetail` is built by `services.getThreadDetail` ([services.js:4649-4672](../../electron/services.js#L4649); type [ipc.ts:1707-1720](../../src/shared/ipc.ts#L1707)).
- `listThreads` caches rows by the identity of the threads array, so a field derived from another store map would go stale in the sidebar ([services.js:4541-4566](../../electron/services.js#L4541)).

### Inferences
**Shared record shape. Commit this first; #1427 extends it:**
```ts
// store.data.orchNoticesByThread[leadId]: OrchNotice[]   (new, top-level)
// store.data.autoTurnsByThread[threadId]: number          (new, top-level)
interface OrchNotice {
  id: string;                 // dedupe key: `worker:<workerId>:<runId>` | `interrupted:<workerId>:<runId>` | `line:<uuid>`
  kind: "worker" | "interrupted" | "line";
  text: string;               // pre-rendered line, exactly what noticePrompt joins today
  workerId?: string;
  status?: "done" | "failed";
  cause?: "crash" | "quit";   // kind "interrupted"
  at: number;
  held?: true;                // set by store load: survived a restart, waits for consent
  result?: WorkerResult;      // #1427
}
```

**Store (store.js):**
- Add both keys to `EMPTY` (78-104) and to the reset literal (4125-4141).
- In the load whitelist next to `tasksByCrew` (2451), add `orchNoticesByThread: normalizeNotices(parsed.orchNoticesByThread)`. It keeps arrays of objects with a string `id`/`text` and a known `kind`, and **sets `held: true` on every record**. Every record read from disk survived a restart by definition. Also add `autoTurnsByThread`, keeping finite non-negative integers.
- Add accessors `getOrchNotices(id)`, `setOrchNotices(id, list)` (delete when empty), `getAutoTurns(id)` and `setAutoTurns(id, n)` (no-op when unchanged, so `startRun`'s reset does not dirty the store on every send). Model them on [store.js:3323-3343](../../electron/store.js#L3323).
- In `recoverInterruptedRuns` (1426): for each recovered `t` with `t.orchWorker && t.handoffFrom`, append an `interrupted` record (`cause:"crash"`, `held:true`) to `data.orchNoticesByThread[t.handoffFrom]`. Its text: `Worker thread <id> ("<title>") was interrupted mid-run by an app crash. Its worktree <worktreePath> on branch <branch> survives with any uncommitted changes; it will not resume on its own — thread_send it to continue, or ask the user.` No git at boot.
- Do **not** add `interruptedBy` to the thread. `lastError` already says it, and a new field would need `listRow` and type work for no reader.
- Back-compat:
  - An old file without the keys loads as `{}`.
  - A downgraded build drops the keys on its next save. Held notices are lost, which is today's behaviour.
  - No migration code is needed.

**Runner (runner.js):**
- Delete the two Maps. Make `enqueueNotice(threadId, record)` read-modify-write through the store, skip it if a record with the same `id` is already queued, then call `store.save()`.
- Use the normal 250 ms debounce. Messages, the worker's own done status and transcripts already ride the same debounce. A `saveNow()` per enqueue would add a synchronous full-envelope write on the main thread for a guarantee the surrounding data does not have.
- `deliverNotice` produces `kind:"line"`.
- `queueOrchNotice` produces `kind:"worker"` with `id: worker:<id>:<lastRunIdFor(id)>` (`lastRunIdFor` is at [runner.js:1569-1575](../../electron/runner.js#L1569)).
- `flushOrchNotices`:
  - read `store.getOrchNotices(threadId)`;
  - add `if (notes.some(n => n.held)) return;` before the `active` check;
  - `noticePrompt(notes.map(n => n.text))`;
  - `store.setOrchNotices(threadId, [])` where it deletes today (1389);
  - change the gate to `store.getAutoTurns` / `store.setAutoTurns(n+1)`.
- `stopCrew` (8793) uses the store accessors.
- `isAutoTurn` and the `startRun` reset (8253) use `store.getAutoTurns` / `setAutoTurns`.
- In `stopAll` (9079-9121): for each active thread with `orchWorker && handoffFrom`, enqueue an `interrupted` record with `cause:"quit"` before marking it idle. The existing quit flush in main.js persists it.
- New `resumeCrew({threadId})`:
  - throw if there are no held records;
  - clear `held` on every record and save;
  - `flushOrchNotices(threadId)`;
  - `pushDetail(threadId)`;
  - `pushThreadsChanged()`;
  - return `{ released: n }`.
- The budget and 25-turn gates are unchanged. A refusal surfaces through the existing "Not delivered" path, and "Retry turn" (a human turn) resets the cap.
- The click is consent to deliver. The resulting turn is still `fromNotice`, so the lead cannot land work on it, which is correct.
- **Optional:** `dismissCrewNotices` reuses the `stopCrew` trace (append the lines as an event and clear). Ship it only if the strip proves sticky.

**IPC and renderer:**
- `services.getThreadDetail` adds `heldNotices: store.getOrchNotices(id).filter(n => n.held).length || undefined` to `ThreadDetail`. Put it on `ThreadDetail`, not `ThreadInfo`, to avoid the `listThreads` identity cache.
- Add `heldNotices?: number` to `ThreadDetail` in ipc.ts (1707).
- Add `runs.resumeCrew(input: {threadId}): Promise<{released: number}>` in the following places:
  - ipc.ts, near 4480;
  - `{ ns: "runs", method: "resumeCrew" }` in ipcChannels.ts, then run `scripts/sync-ipc-preload.js` to regenerate preload.js. `IPC_CHANNEL_LOCK` fails tsc if one side is missing;
  - `"runs:resumeCrew": (ctx, input) => ctx.runner.resumeCrew(input)` in ipc.js, next to 1538;
  - `useCoder.resumeCrew`;
  - the `devCoder.ts` stub (#623 says do not generate it).
- App passes `onResumeCrew={() => resumeCrew(selectedThreadId)}`.
- In ThreadView, render a strip next to the quota-wait strip (8346), shown when `detail.heldNotices > 0 && !isWorking`. Copy: "Solenta restarted while this crew was working — N updates are waiting." Button: **Resume crew (N)** (`data-resume-crew`), styled with the existing `styles.retryBtn`. This needs no new CSS module, which matters because a broken `.module.css` passes the test suite (Willem's renderer-build note).
- The web bridge gets the IPC for free, because it consumes the same `IPC_HANDLERS`.

**Test plan:**
- **Store, `store.test.js`:**
  - (1) A file with a `working` orchWorker reloads with one held `interrupted` record on its lead.
  - (2) Records and `autoTurnsByThread` round-trip through `saveNow` + `new Store(file)`.
  - (3) `deleteThread(lead)` removes the lead's queue.
- **Runner, `crew-notices.test.js`,** with the `CODER_SIMULATE=1` + `createRunner` harness ([crew-notices.test.js:52-93](../../electron/test/crew-notices.test.js#L52)):
  - (4) A worker that finishes while the lead runs leaves a record in `store.data.orchNoticesByThread`.
  - (5) After `runner.stopAll()` and a reload into a new runner, the lead does **not** start.
  - (6) `getThreadDetail(lead).heldNotices === 1`.
  - (7) `runner.resumeCrew` starts a `fromNotice` run.
  - (8) With `autoTurnsByThread[lead] = 25` persisted, resume yields "Not delivered: Crew auto-turn cap reached". This adapts the existing cap test at [crew-notices.test.js:145](../../electron/test/crew-notices.test.js#L145).
  - (9) Duplicate `queueOrchNotice` for the same run enqueues once.
- **IPC:** `IPC_HANDLERS["runs:resumeCrew"](makeCtx(...))`, following the `makeCtx` pattern in [claude-self-archive.test.js:177-185](../../electron/test/claude-self-archive.test.js#L177).
- **Renderer,** in `test/threadView.test.tsx`: the strip appears with `heldNotices` and the click calls `onResumeCrew`.
- Run `npx vite build`, plus `npm run typecheck` for the channel lock.
- **End to end:** use #1428's harness to hold a worker mid-run with a gate, `stopAll`, reload, and assert the interrupted notice and the strip.

**Risks:**
- **Notices are deleted before startRun resolves.** A crash in that window loses the wake, but the prompt is already in the lead's transcript as the `fromNotice` user row or the "Not delivered" event. That matches V2's "a missed wake is cheaper than a duplicate".
- **Dedupe is in-queue only.** A notice already delivered and then replayed would wake twice. `ponytail:` add a capped delivered-ids ring per lead if that ever shows up.
- **Any human send to a lead with held notices** leaves the strip in place until clicked. That is deliberate consent semantics, but users may expect a send to imply "resume".
- **Codex parking** (`codexParkNotified`) stays in memory. A parked Codex lead after a restart simply shows the held strip.

**Revised size:** M, **about 450–550 lines including tests** (3–4 days). That matches the report's M.

### Gaps
- I did not check `main.js` `recover()` ordering in detail ([main.js:560-607](../../electron/main.js#L560)). The design assumes the store loads before `createRunner` ([main.js:664](../../electron/main.js#L664)), which the line order suggests.
- I did not read the sidebar logic to decide whether a lead with held notices should count as "needs you". It is left as a follow-up.

## #1427 — Structured worker result in the wake notice, plus a card linking to the Integration view

### Takeaway
All four data sources exist, but with three corrections:
- **Itinerary.** The review itinerary has no "open items". It has `risks` (top-level and per chunk).
- **Checkpoint race.** In the non-verify path the checkpoint commit is fired and forgotten, so a diff against the branch at notice time can miss the last turn.
- **Text coupling.** The lead's transcript folds notices by **exact-matching the runner's canned text** in `src/workerActivity.ts`. Any appended block silently un-folds it.

So:
- carry the result as structured data on the notice record (#1426) and on the wake user row;
- await the checkpoint for workers;
- build the diff with async git;
- render a card whenever `message.workerResults` is present.

The card can call the existing `onOpenCrewIntegration(leadId)` prop that ThreadView already receives.

### Cited Findings
**Data sources**
- **Lead snapshot.** `forkWorkerThread` stores `leadSnapshotSha`/`leadSnapshotBranch`/`leadSnapshotDirty` on the worker ([services.js:1448-1462](../../electron/services.js#L1448)). `refreshWorkerSnapshot` updates `leadSnapshotSha` only ([services.js:2438-2491](../../electron/services.js#L2438)).
- **Integration base.** `crewIntegration.js` already resolves the base: `snapshotSha(worker)` tries `leadSnapshotSha`, `startSha`, `sourceSha` ([crewIntegration.js:379-385](../../electron/crewIntegration.js#L379)). Per worker it lists `changedFiles` against `snapshotSha || recordedBaseBranch || finalTarget` ([crewIntegration.js:441-461](../../electron/crewIntegration.js#L441)).
- **Existing diff helpers.** worktrees.js uses `--numstat`, `--shortstat` and `--name-status`. No `--summary` caller exists (grep: [worktrees.js:2043](../../electron/worktrees.js#L2043), [4589](../../electron/worktrees.js#L4589), [5092](../../electron/worktrees.js#L5092), [5160-5165](../../electron/worktrees.js#L5160)).
- **Verify.** `thread.verify` is a `VerifyResult` `{runId, command, ok, exitCode, timedOut, log, sha, durationMs, at, attempt, artifactIds?}` ([ipc.ts:1826-1847](../../src/shared/ipc.ts#L1826)). It is written at [runner.js:1709](../../electron/runner.js#L1709), [1724](../../electron/runner.js#L1724) and [1764](../../electron/runner.js#L1764).
- **Hypotheses.** `thread.hypotheses: Hypothesis[]` `{id, claim, status, reason, at}` ([ipc.ts:958-968](../../src/shared/ipc.ts#L958)). They are capped at 50 entries, 200-character claims and 500-character reasons ([services.js:843-845](../../electron/services.js#L843)). `hypothesisNoteFor` already formats invalidated entries as `- claim — reason` ([services.js:1114-1150](../../electron/services.js#L1114)).
- **Review itinerary.** The file `.solenta/review-itinerary/<threadId>.json` has shape `{"version":1,"readOrder":[…],"chunks":[{"area","rationale","risks":[]}],"risks":[]}` ([reviewItinerary.js:43-53](../../electron/reviewItinerary.js#L43)). It is read with `readAnnotation(cwd, threadId)`, which falls back to the legacy flat file ([reviewItinerary.js:112-121](../../electron/reviewItinerary.js#L112)). There is no "open items" field; the hunk-accept state lives on the thread as `reviewAcceptedHunks` ([reviewItinerary.js:242-252](../../electron/reviewItinerary.js#L242)).

**Timing**
- **Non-verify path:** `void maybeCreateCheckpoint(store, threadId)` is not awaited, and then `finishSuccessfulTurn` → `queueOrchNotice` runs immediately ([runner.js:1526-1532](../../electron/runner.js#L1526)).
- **Verify path:** awaits the checkpoint before `runVerifyGate` and only then calls `finishSuccessfulTurn` ([runner.js:1506-1516](../../electron/runner.js#L1506), [runner.js:1700-1716](../../electron/runner.js#L1700)).
- `maybeCreateCheckpoint` is async and does `git add -A` and commit ([worktrees.js:5282-5334](../../electron/worktrees.js#L5282)).
- The runner avoids `execFileSync` on this path: "an execFileSync here blocks the main process" ([runner.js:1547-1567](../../electron/runner.js#L1547)).

**How notices render today**
- The wake turn's user row is appended by `startRun` with `fromNotice: true`, through the `appendMessage` extras ([runner.js:8461-8474](../../electron/runner.js#L8461); `appendMessage` [runner.js:2961-3000](../../electron/runner.js#L2961)). Store messages are not field-whitelisted; only a `fromNotice` back-fill exists ([store.js:1133-1154](../../electron/store.js#L1133)).
- `ChatMessage` already has `fromThread`, `thinking`, `fromNotice` and `steer` ([ipc.ts:1174-1212](../../src/shared/ipc.ts#L1174)).
- `routineWorkerActivitySummary` returns null unless every body line parses. It rebuilds the canned landing paragraph with `cannedLandingSuffix`, a byte copy of the runner text, and requires the footer to be the last line ([workerActivity.ts:1-13](../../src/workerActivity.ts#L1), [workerActivity.ts:51-62](../../src/workerActivity.ts#L51), [workerActivity.ts:243-259](../../src/workerActivity.ts#L243)).
- `UserMessageBlock` (memo) renders the fold at [ThreadView.tsx:1403-1466](../../src/components/ThreadView.tsx#L1403). Its props are at [ThreadView.tsx:1259-1284](../../src/components/ThreadView.tsx#L1259), and `MessageBlock` passes them at [ThreadView.tsx:1678-1690](../../src/components/ThreadView.tsx#L1678).

**Integration entry**
- ThreadView already takes `onOpenCrewIntegration?: (leadThreadId) => void` ([ThreadView.tsx:804](../../src/components/ThreadView.tsx#L804)). App wires it to `openCrewIntegration`, which selects the lead and reveals the Agents team panel ([App.tsx:650-656](../../src/App.tsx#L650), [App.tsx:2286](../../src/App.tsx#L2286)). `WorktreeControl` uses the same prop ([WorktreeControl.tsx:451-454](../../src/components/WorktreeControl.tsx#L451)).
- The Integration view is `CrewIntegration` inside AgentsPanel ([AgentsPanel.tsx:3218-3219](../../src/components/AgentsPanel.tsx#L3218)). Its read model is `threads:crewIntegration` ([ipc.js:509-511](../../electron/ipc.js#L509)), and the human action is `git:integrateWorker` ([ipc.js:1725-1737](../../electron/ipc.js#L1725)).

### Inferences
**Data shape (extends #1426's `OrchNotice.result`, and is also persisted on the wake user row):**
```ts
interface WorkerResult {
  workerId: string; title: string; status: "done" | "failed";
  branch: string | null; baseSha: string | null;        // snapshotSha(worker)
  diffstat: string | null;   // `git diff --stat=100 --summary <base> HEAD`, ≤30 lines / 1,500 chars, "… N more"
  flags: string[];           // --summary lines matching /mode 120000|delete mode/ (symlinks, deletions) — the core/dist case
  uncommitted: number;       // `git status --porcelain` count (failed workers never got a checkpoint)
  verify: { ok: boolean; command: string; attempt: number; timedOut: boolean } | null;
  ruledOut: string[];        // invalidated hypotheses, newest first, ≤5, "claim — reason" ≤200 chars
  risks: string[];           // itinerary top-level + chunk risks, deduped, ≤5
}
// ChatMessage gains: workerResults?: WorkerResult[]   (only on fromNotice user rows)
```

**Electron changes:**
1. **Await the checkpoint for workers.** In `afterSuccessfulTurn`'s non-verify branch ([runner.js:1526-1532](../../electron/runner.js#L1526)), for `thread.orchWorker && thread.worktreePath`, chain `maybeCreateCheckpoint(...).catch(() => null).then(() => finishSuccessfulTurn(threadId))`. This mirrors the verify path. Non-worker threads keep today's timing, so sweep and drain tests are unaffected.
2. **Build the result.** Add `async function buildWorkerResult(worker)` in runner.js:
   - import `snapshotSha` from crewIntegration.js and export it from there;
   - use `gitTryAsync` from worktrees.js for `diff --stat=100 --summary <base> HEAD` and `status --porcelain`;
   - read `worker.verify`;
   - filter `worker.hypotheses` for `invalidated`;
   - call `readAnnotation(worker.worktreePath, worker.id)`.
   - For `worktree:false` workers return `diffstat: null` with the note "ran in the project checkout".
   - It never throws.
3. **Enqueue with the result.** `queueOrchNotice` becomes `void buildWorkerResult(thread).then(result => { enqueueNotice(parentId, {kind:"worker", …, text: line + renderResultBlock(result), result}); flushOrchNotices(parentId); })`. Keep the current first line and the landing paragraph text unchanged.
   - `renderResultBlock` appends lines starting with `[result <workerId>]`, for example:

     ```
     [result w1] verify: passed `npm test` (attempt 0)
     diff vs lead snapshot abc1234: 4 files changed, 120 insertions(+), 8 deletions(-)
     ! create mode 120000 core/dist
     ruled out: …
     risks: …
     ```

     The whole block is capped at about 2,000 characters, as the report proposed.
   - The existing synchronous `flushOrchNotices(threadId)` calls in `afterFailedTurn`/`finishSuccessfulTurn` stay. They flush older queued records, and the async continuation flushes the new one.
4. **Pass results to the wake row.** In `flushOrchNotices`, pass `workerResults: notes.filter(n => n.result).map(n => n.result)` into `startRun`. `startRun` forwards it through the `appendMessage` extras at 8471, alongside `fromNotice`, and `appendMessage` copies `extra.workerResults` when it is a non-empty array.
   - The "Not delivered" event also carries the results, so Retry keeps the card. `retryTurn.ts` resends text only, which is fine.
5. **Optional:** `thread_status` can return `result: await buildWorkerResult(thread)` for a finished worker. Skip it unless leads are seen polling.

**Renderer changes:**
- Add `workerResults?: WorkerResult[]` to `ChatMessage` and export `WorkerResult` from `src/shared/ipc.ts`.
- New `src/components/WorkerResultCard.tsx`:
  - a title button (`onSelectThread(workerId)`) and a status chip;
  - a verify chip (passed / failed / not configured);
  - a `<pre>` diffstat, collapsed after 8 lines;
  - `flags` shown as a warning row ("symlink added: core/dist");
  - "Ruled out" and "Risks" lists;
  - a primary button **Review & integrate**, calling `onOpenCrewIntegration(leadThreadId)`.
  - It must render visibly on arrival. The report's point about V2 #15063 stands.
- In `UserMessageBlock`, before the `routineWorkerActivitySummary` branch (1403), add: `if (message.workerResults?.length) return <article …>{results.map(r => <WorkerResultCard …/>)}<details>{message.text}</details></article>`.
- Thread two new props through `MessageBlock` → `UserMessageBlock`: `leadThreadId` and `onOpenCrewIntegration`. Both must be stable, because the panes are memoized per #91 ([App.tsx:658-664](../../src/App.tsx#L658) comment).
- `workerActivity.ts` needs **no change**. Notices with results bypass it, and peer and crew-only notices fold as before.
- Styles: reuse `ThreadView.module.css` classes (`inboundCard`, `retryBtn`) or add a small `WorkerResultCard.module.css`. Run `npx vite build` either way.

**Test plan:**
- **Electron:**
  - (1) A worker with a worktree commits a symlink (`ln -s … core/dist; git add`) and finishes. The lead's queued record and its wake user row carry `result.flags` containing `create mode 120000 core/dist`, and the prompt text contains `[result`. Use the crew-notices simulate harness with a real git repo, as crew-notices.test.js already runs `git init`.
  - (2) In the non-verify path, the diff includes files written in the last turn. This proves the checkpoint is awaited.
  - (3) Invalidated hypotheses and itinerary `risks` appear, and the cap is enforced.
  - (4) A failed worker reports `uncommitted > 0`.
- **Renderer, `test/threadView.test.tsx`:** a `fromNotice` row with `workerResults` renders `[data-worker-result]`, and the button calls `onOpenCrewIntegration` with the lead id. A row without `workerResults` still folds; the existing `routineWorkerActivitySummary` tests stay green.

**Risks:**
- Git on large diffs: `--stat` stays cheap, but cap the output.
- Workers on ssh/WSL projects: `gitTryAsync` with a local path is wrong for remote checkouts. Skip the diff when `project.remoteHost` is set, as `loadReviewContext` does ([reviewItinerary.js:217-221](../../electron/reviewItinerary.js#L217)).
- The awaited checkpoint delays `sweepDoneWorkers` for workers by one commit. It already does so for verify-gated workers.

**Revised size:** S + S holds only roughly. Expect **about 350–450 lines including tests** (2–3 days): about 120 electron, about 150 renderer, about 150 tests.

### Gaps
- I did not confirm `gitTryAsync`'s exact signature beyond its use at [runner.js:1560-1561](../../electron/runner.js#L1560) and [worktrees.js:4821](../../electron/worktrees.js#L4821).
- I did not check whether the AgentsPanel reveal scrolls to the Integration section or only to the Team roster (`revealAgentsTeam`).

## #1428 — Replay-fixture provider harness (fake Claude via CODER_CLAUDE_BIN)

### Takeaway
Most of the plumbing already exists:
- `resolveBin` honours `CODER_CLAUDE_BIN`.
- 28 electron test files already point it at an inline node fake built with `writeFakeBin`, and they drive the **real** `createRunner` → store → IPC path.
- A 681-line dual-mode fake Codex CLI, including a JSON-RPC app-server, already exists.
- Muse even has recorded `.jsonl` fixtures, but only a shape test reads them.

What is missing is a **generic, fixture-driven** fake that asserts stdin. That means:
- one `replayCli.js`;
- one `useReplay()` env helper, which centralises the `CODER_*` hygiene that each test currently hand-rolls;
- one recorder script;
- a handful of fixtures.

This is an S, not an S–M.

### Cited Findings
- **Binary override.** The Claude entry is `binEnv: "CODER_CLAUDE_BIN"` and `supportsSteer: true` ([providers.js:242-251](../../electron/providers.js#L242)). `resolveBin` returns the trimmed env override before `defaultBin` ([providers.js:1477-1484](../../electron/providers.js#L1477)). Every provider has a `binEnv`: `CODER_CODEX_BIN` 345, `CODER_GROK_BIN` 532, `CODER_OPENCODE_BIN` 642, `CODER_KIMI_BIN` 788, `CODER_CURSOR_BIN` 880, `CODER_MUSE_BIN` 1407.
- **Exact Claude argv.** `-p --output-format stream-json --input-format stream-json --permission-prompt-tool stdio --verbose --include-partial-messages --permission-mode <mode> [--model M] [--resume <sid>] [--effort L]`, with no trailing prompt, because "the runner delivers it on stdin" ([providers.js:307-338](../../electron/providers.js#L307)). The runner appends `--mcp-config=<file>` and `--allowedTools=mcp__coder-memory__* mcp__coder-threads__*` only when `entryDef.id === "claude"` ([runner.js:4173-4185](../../electron/runner.js#L4173); [memory-sup.js:352-361](../../electron/memory-sup.js#L352)).
- **Stdin protocol** ([claude.js](../../electron/claude.js)):
  - each write is one NDJSON line ([claude.js:168-178](../../electron/claude.js#L168));
  - a user turn is `{"type":"user","message":{"role":"user","content":"<text>"},"parent_tool_use_id":null,"session_id":""}` ([claude.js:231-239](../../electron/claude.js#L231)), and steering is a second such line ([providers.js:246-250](../../electron/providers.js#L246));
  - permission answers are `{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{behavior:…}}}` ([claude.js:312-321](../../electron/claude.js#L312)), or `subtype:"error"` with `error` ([claude.js:327-336](../../electron/claude.js#L327));
  - stdin is piped only when interactive ([claude.js:243-251](../../electron/claude.js#L243)). After a `result`, stdin is ended unless the session is kept alive ([claude.js:190-202](../../electron/claude.js#L190)).
- **Stdout events the runner consumes:**
  - `control_request` with `request.subtype === "can_use_tool"`, `tool_name` and `input` ([runner.js:4355-4362](../../electron/runner.js#L4355)); outside a turn it answers `respondError` ([runner.js:4339-4349](../../electron/runner.js#L4339));
  - partials are unwrapped by `unwrapStreamEvent` ([runner.js:4351-4352](../../electron/runner.js#L4351)).
  - A minimal turn, as used by the existing fake, is `{"type":"system","subtype":"init","session_id","model"}`, then an `assistant` message with text content, then `{"type":"result","subtype":"success","result","usage","total_cost_usd","num_turns","session_id"}` ([claude-self-archive.test.js:67-111](../../electron/test/claude-self-archive.test.js#L67)).
- **Existing fakes and infrastructure:**
  - `writeFakeBin` writes a `#!/usr/bin/env node` script with mode 0755, which also works on win32 through cross-spawn ([support/fakeBin.js](../../electron/test/support/fakeBin.js));
  - `support/fakeCodexCli.js` is a "Dual-mode fake Codex CLI … `app-server --listen stdio://` speaks newline JSON-RPC" that dumps argv and env, and 6 test files use it ([fakeCodexCli.js:1-30](../../electron/test/support/fakeCodexCli.js#L1));
  - 28 test files set `CODER_CLAUDE_BIN` (grep `-l` count);
  - recorded Muse fixtures exist at `electron/test/fixtures/muse/echo-hello.jsonl` and `echo-tools.jsonl`, but `muse-fixtures.test.js` only checks that they parse ([muse-fixtures.test.js:1-30](../../electron/test/muse-fixtures.test.js#L1)).
  - There are no Claude `.ndjson`/`.jsonl` fixtures (`find electron/test test -name '*.jsonl' -o -name '*.ndjson'`).
- **How tests run:**
  - `npm run test:electron` → `scripts/test-electron.js` → `node --import=./test/support/render.mjs --experimental-strip-types --test electron/test/*.test.js` on POSIX, plus an explicit `WIN32_FILES` allowlist on Windows ([scripts/test-electron.js:13-99](../../scripts/test-electron.js#L13); [package.json:18-24](../../package.json#L18)).
  - CI runs `npm test` on macOS, Windows and Ubuntu with Node 22, after `npx vite build` and an Ubuntu-only global `@openai/codex@0.153.4` ([.github/workflows/test.yml:40-86](../../.github/workflows/test.yml#L40)).
  - Runner tests import `../../core/dist/index.js`, so `core` must be built first ([claude-self-archive.test.js:147-149](../../electron/test/claude-self-archive.test.js#L147)).
- **Env hazards:**
  - `CODER_SIMULATE=1` and `CODER_AGENT_CMD` override provider resolution before the binary is consulted ([runner.js:610-615](../../electron/runner.js#L610)).
  - The self-archive test snapshots and clears `CODER_SIMULATE`, `CODER_AGENT_CMD`, `CODER_CLAUDE_BIN`, `CODER_GROK_MCP_DISABLE` and `CODER_GROK_BIN`, setting `CODER_GROK_BIN` to a non-binary ([claude-self-archive.test.js:113-145](../../electron/test/claude-self-archive.test.js#L113)).
  - Other `CODER_*` env reads in electron/ include `CODER_CLAUDE_ACK_MS`, `CODER_STALL_MS`, `CODER_CODEINDEX_DISABLE`, `CODER_GUARDRAILS*` and `CODER_MEMORY_*` (grep of `process.env.CODER_` in electron/*.js).

### Inferences
**Fixture format (NDJSON, one directive per line; mirrors V2's `expect_outbound` / `emit_inbound` / `runtime_exit`):**
```jsonc
{"v":1,"provider":"claude","match":{"firstPrompt~":"Worker task A"},"argv":{"has":["--input-format","stream-json","--permission-prompt-tool","stdio"],"mcpConfigUrl~":["projectId=","threadId="]}}
{"expect":{"type":"user","message.content~":"Worker task A"}}          // next stdin line must match (dot-path ==, "~" = substring)
{"emit":{"type":"system","subtype":"init","session_id":"sess-a","model":"m"}}
{"emit":{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}}
{"expect":{"type":"control_response","response.request_id":"req-1","response.response.behavior":"allow"}}
{"emit":{"type":"assistant","message":{"content":[{"type":"text","text":"built it"}]}},"delayMs":5}
{"gate":"worker-a-finish"}                                              // block until <CODER_REPLAY_GATES>/worker-a-finish exists
{"emit":{"type":"result","subtype":"success","result":"built it","usage":{"input_tokens":1,"output_tokens":1},"total_cost_usd":0,"num_turns":1,"session_id":"sess-a"}}
{"expect":{"type":"user","message.content~":"[orchestration] Worker thread"}}   // kept-alive: the next turn's stdin (lead fixtures)
{"exit":0}                                                              // omit = stay alive until stdin ends (Claude keep-alive)
```

**`electron/test/support/replayCli.js`, about 100 lines:**
- Load fixtures from `CODER_REPLAY_DIR`. When several fixtures exist, pick one by `match.firstPrompt~` against the first stdin user line. A lead and its workers are separate Claude processes reading the same env, so prompt matching is how each finds its script.
- Check the `argv` header. When `mcpConfigUrl~` is set, read the `--mcp-config=` file and test the `coder-threads` URL. This tests #1425 end to end.
- Walk the directives:
  - `emit` writes a stdout line;
  - `expect` reads one stdin line and asserts it;
  - `gate` polls a file;
  - `exit` exits.
- On a mismatch, append `{"mismatch":{expected,got,step}}` to `CODER_REPLAY_LOG` and exit 3. The runner surfaces "Run error (exit 3)", and every test asserts the log has no mismatches.
- Append every observed argv and stdin line to the log, so tests can make extra assertions.
- Use `writeFakeBin(tmp/claude, "require(<abs replayCli.js>)")`, so the win32 cross-spawn path works.

**`electron/test/support/replay.js`, `useReplay({fixtures, provider:"claude"})`, about 40 lines:**
- Snapshot and delete **every** `process.env` key starting with `CODER_`.
- Set `CODER_CLAUDE_BIN`, `CODER_REPLAY_DIR`, `CODER_REPLAY_LOG` and `CODER_REPLAY_GATES`.
- Set `CODER_GROK_MCP_DISABLE=1` and `CODER_GROK_BIN=no-grok-not-a-real-binary`.
- Set `PATH` to `[dirname(process.execPath), dirname(git)]`. That makes `which`-based provider availability deterministic, while the shebang still finds node and `git init`/worktrees still work. The brief's "PATH with only node" would break every test that creates a repo.
- Return `{ gate(name), log(), restore() }`.

**`scripts/record-claude-fixture.js`, about 60 lines, manual use only and never in CI:**
- Set it as `CODER_CLAUDE_BIN` for one real Solenta session.
- It spawns the real Claude binary (`CODER_RECORD_REAL_BIN` or `claude`) with the same argv and tees stdin into `{"expect":…}` and stdout into `{"emit":…,"delayMs":Δ}` under `CODER_RECORD_OUT`.
- `--sanitize` replaces session ids, request ids, `$HOME`/cwd paths, model ids and any `Bearer`/token strings with placeholders. It drops `stream_event` partials unless `--keep-partials`, because partials exercise `applyPartial` but make fixtures large.
- Grok shares `claude-stream` but takes the prompt in argv, so its fixture would have no first `expect`. The same `replayCli` works with `argv.promptLast` matching.

**First scenarios, in `electron/test/replay-crew.test.js`:**
- (1) A worker finishes and wakes its idle lead. Assert that the lead fixture's second `expect` sees `[orchestration] Worker thread`, and that the store has a `fromNotice` row. This also covers #1427's `workerResults`.
- (2) A permission stall: `control_request`, then `thread_status.awaitingInput === true`, then `runner.respondPermission` → an `expect` on `control_response`.
- (3) A restart mid-run, for #1426: gate the worker, `stopAll()`, reload with `new Store(file)` plus a new runner, and assert a held `interrupted` notice and that nothing auto-starts.
- (4) A steer on a live run, for item 5: `runner.steerRun`, then a second `expect` of type `user`.
- Add the new file to `WIN32_FILES` once it passes on Windows. It uses only `writeFakeBin` and git ([scripts/test-electron.js:13-25](../../scripts/test-electron.js#L13)).
- **Later:** a JSON-RPC variant reusing `fakeCodexCli.js`'s responder rather than a new one.

**Risks:**
- Fixture drift when the Claude CLI changes its stream. Mitigation: date-stamp fixture names with the CLI version in the header, and re-record on bumps.
- Timing flakiness. Avoid sleeps by using `gate` files and `waitFor`, as the existing tests do. Willem's notes record one known flaky injected-clock race in the web-integration test, so do not add wall-clock assertions.

**Revised size:** S, **about 300 lines** (1–2 days), down from the report's S–M.

### Gaps
- I did not verify a live `claude` recording. The sanitize list is inferred from the event fields above, not from a real capture.
- I did not check whether `runner.respondPermission` is reachable without IPC in tests. The baseline cites `respondPermission` at [runner.js:2577](../../electron/runner.js#L2577).

## Corrections to the earlier report, and revised plan-level sizing

### Takeaway
The report's core claims hold: the `fromThreadId` omission bypass, in-memory notices, and data already present for a result delta. But it understates the identity hole and mis-describes restart, the itinerary, steering via pairing, and the harness starting point. Items 1–4 total about **1,400–1,750 changed lines including tests, roughly 8–11 engineer-days**. Items 1 and 4 are larger and smaller, respectively, than the report estimated.

### Cited Findings
**Correct as stated**
- `assertCrossThreadApproved` returns early on a missing `fromThreadId` ([orchServer.js:536-539](../../electron/orchServer.js#L536)).
- The `orchNotices`/`autoTurns` Maps ([runner.js:1170](../../electron/runner.js#L1170), [runner.js:1179](../../electron/runner.js#L1179)).
- The `git:integrateWorker` entry point ([ipc.js:1725](../../electron/ipc.js#L1725)).
- Pairing clients are unaffected by binding ([orchServer.js:1954-1962](../../electron/orchServer.js#L1954)).

**Understated**
- **Thread identity.** Besides the omission path:
  - claimed `threadId` on `thread_merge`/`thread_pr` lets any running thread in the project act as a lead whose last turn was human ([orchServer.js:459-526](../../electron/orchServer.js#L459));
  - `fromInbound` turns reset `autoTurns`, so the "turn check is the real lock" comment ([orchServer.js:500-504](../../electron/orchServer.js#L500)) is defeated by an agent-to-agent `thread_send` ([runner.js:8253](../../electron/runner.js#L8253));
  - omitting `fromThreadId` also skips the unattended-sender refusal ([crossThread.js:86-88](../../electron/crossThread.js#L86)).
- **The URL parameter is forgeable** by any agent that can read its own bearer token from its env or config ([memory-sup.js:516-539](../../electron/memory-sup.js#L516), [memory-sup.js:1680-1681](../../electron/memory-sup.js#L1680)).

**Imprecise**
- **"a restart marks every running thread failed".** That is the crash path only. A clean quit marks threads `idle` with `stoppedAt` ([runner.js:9074-9121](../../electron/runner.js#L9074)). Notices are lost in both cases ([store.js:1413-1417](../../electron/store.js#L1413)).
- **"Solenta already writes a bound MCP config for each project".** For Claude, it writes one per (cwd, project), keyed by sha1 ([memory-sup.js:1713-1718](../../electron/memory-sup.js#L1713)). Codex, Grok, Kimi, Cursor and Muse each bind in their own per-run or per-thread place, and OpenCode gets none (#1425 findings).
- **"Reject a conflicting claimed fromThreadId, as #671 does for projectId".** #671 does not reject; bound silently wins ([orchServer.js:336-339](../../electron/orchServer.js#L336)).
- **"Flush immediately on enqueue rather than the 250 ms debounce".** Not recommended. Transcripts and the worker's own status use the same 250 ms debounce ([store.js:258-261](../../electron/store.js#L258)), and `saveNow` is a synchronous envelope write.
- **"open items from its review itinerary".** The itinerary schema has `risks`, not open items ([reviewItinerary.js:43-53](../../electron/reviewItinerary.js#L43)).
- **`git diff --stat --summary <leadSnapshotSha>..<branch>` at notice time.** The branch can lag the last turn, because the checkpoint is not awaited in the non-verify path ([runner.js:1526-1532](../../electron/runner.js#L1526)).
- **Appending a block to the notice text.** This silently breaks the transcript fold, which exact-matches the canned text ([workerActivity.ts:51-62](../../src/workerActivity.ts#L51)).
- **"steerRun exists … but only behind the UI and pairing tokens" (item 5).** Pairing's `steer` capability never calls `steerRun`. Its `task_send` refuses while a task is running ("Task is still running. Poll task_status…") ([pairing.js:612-629](../../electron/pairing.js#L612)).
- **Harness, "Codex's two-way JSON-RPC needs a responder and can come after".** A JSON-RPC fake Codex app-server already exists ([fakeCodexCli.js:1-10](../../electron/test/support/fakeCodexCli.js#L1)). The `binEnv` approach is already used by 28 test files.

**Not in the report**
- No permission ranking exists. `snapPermissionMode` actively escalates on 5 of 7 providers ([providers.js:194-215](../../electron/providers.js#L194)), and pool failover re-snaps ([subagentPool.js:381](../../electron/subagentPool.js#L381)). The "privilege narrowing" check is therefore a behaviour change for every default-mode lead that forks grok, kimi or cursor. It needs the alias flag in the same PR.

### Inferences
- **Sequencing:**
  1. #1428 (harness), plus a committed `OrchNotice`/`WorkerResult` type contract.
  2. #1425 and #1426 in parallel. They touch different functions: orchServer, memory-sup and services for #1425; store, runner notices and the renderer strip for #1426. Both edit runner.js, but at different lines (8253 versus 1163-1434 and 9074+).
  3. #1427 on top of #1426's record shape.
- Willem's memory notes warn that parallel workers fork from committed HEAD and mock each other's seams. So commit the record type before forking, and test the join (#1426 records that carry #1427 results) on merge.
- **Revised sizes:**

  | Item | Report | Revised | Estimate |
  |---|---|---|---|
  | #1425 | S | small M | ~250–350 lines, ~2 days |
  | #1426 | M | M | ~450–550 lines, 3–4 days |
  | #1427 | S + S | M | ~350–450 lines, 2–3 days |
  | #1428 | S–M | S | ~300 lines, 1–2 days |

### Gaps
- Sizes are line-count estimates from the touch points listed, not from prototypes.
- I did not check the currentbits/solenta issue bodies for #1425–#1428 (local checkout only). Their acceptance criteria may differ from the issue summaries in the brief.
