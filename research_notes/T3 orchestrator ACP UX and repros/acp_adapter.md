# ACP adapter for Solenta: protocol, T3's Grok/Cursor/registry use, and a Solenta design

Research date: 2026-10-04. T3 clone `/tmp/t3code-research` at `eac52f00` (main, 2026-10-04, "fix(client-runtime): closing a busy stream no longer drops the connection (#15563)"). `git fetch origin main` left it unchanged. Links below pin `eac52f0087d9ba5dee5542f24788d1482affae43` as `T3@eac52f0`. All T3 code cited here is on **main** unless it is marked as an OPEN PR. Solenta checkout: `fae77a0b…` worktree, read-only.

Abbreviations:
- `R` = `https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43`
- `S` = the Solenta checkout (`/Users/willem/Library/Application Support/Solenta/worktrees/fae77a0b-5c8a-4a21-ba4f-b07f933538ed`)

## (1) ACP spec essentials that matter for an orchestrator client

### Takeaway
ACP v1 is stable: JSON-RPC 2.0, newline-delimited over the agent's stdio. A client needs about seven methods: `initialize`, `session/new`, `session/load` or `session/resume`, `session/prompt`, `session/cancel`, plus answering `session/request_permission` and consuming `session/update`. That set gives real approval prompts, a cancel that keeps the session, and per-session MCP injection. ACP v2 is still a **draft** (published 2026-07-20). It removes `session/load`, `fs/*` and `terminal/*`, and moves turn completion off the `session/prompt` response. A Solenta client should therefore speak v1 and send no fs/terminal capabilities.

### Cited Findings

**Transport and versioning**
- Agents run as a subprocess and speak JSON-RPC 2.0 over stdio, one message per line. Cursor's doc: "Transport uses stdio, Protocol envelope uses JSON-RPC 2.0, and messages use newline-delimited JSON." — [Cursor ACP docs](https://cursor.com/docs/cli/acp)
- Version negotiation: if the client's `protocolVersion` is unsupported, "the Agent MUST respond with the latest version it supports". A client that does not recognise that version should "close the connection and inform the user". — [ACP initialization](https://agentclientprotocol.com/protocol/initialization)
- v1 is the stable line. Recent stabilizations:
  - Session Resume: 2026-04-22
  - Message IDs, Session Usage Updates and Session Delete: 2026-06-05
  - Rust/TS SDK 1.0.0: 2026-06-25
  - Elicitation: 2026-07-22
  - Tool Call Names: 2026-09-17
  - "ACP v2 protocol documentation and schema are now published in Draft form": 2026-07-20
  - Source: [ACP updates](https://agentclientprotocol.com/updates)
- v2 is "draft". Clients must gate v2 behind explicit negotiation and feature flags, and "v1 peers remain supported indefinitely". A client that sends `protocolVersion: 2` to a v1-only agent gets `1` back. — [ACP v1→v2 migration](https://agentclientprotocol.com/protocol/v2/migration)
- Breaking changes in v2 (same source):
  - Removed:
    - `session/load` (replaced by `session/resume` with `replayFrom`)
    - `session/set_mode`
    - `fs/read_text_file` and `fs/write_text_file`
    - all `terminal/*` methods
    - the `tool_call` update (the first `tool_call_update` now creates the call)
  - Turn lifecycle: "`session/prompt` response no longer ends the turn". Completion and stop reasons move to `state_update` (`running` / `idle` / `requires_action`).
  - Permission requests: `title` is now required.
  - MCP servers: the `type` discriminator is required and SSE is removed.
- T3 pins schema `schema-v2.0.0-alpha.3` (`PROTOCOL_VERSION = 2`) — [R/packages/effect-acp/src/_generated/meta.gen.ts#L2,L43](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/effect-acp/src/_generated/meta.gen.ts)
  - Its compat layer keeps v1 shapes: "ACP v1 client-mediated filesystem and terminal shapes remain as internal types… ACP v2 never advertises or wires them" — [R/packages/effect-acp/src/compat.ts#L383-L384](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/packages/effect-acp/src/compat.ts)
  - In practice Grok 1.0.41 answers T3's `protocolVersion: 2` with `protocolVersion: 1` — [simple/grok_transcript.ndjson, line 3](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/simple/grok_transcript.ndjson)

**Capabilities**
- Client capabilities:
  - `fs.readTextFile` and `fs.writeTextFile` default to unsupported.
  - `terminal` enables the terminal methods.
  - `auth.terminal` and elicitation modes are optional.
  - Source: [ACP initialization](https://agentclientprotocol.com/protocol/initialization)
- Agent capabilities: `loadSession` (default false), `promptCapabilities` (image/audio/embeddedContext), `mcpCapabilities` (http/sse, both default false; SSE deprecated), and `sessionCapabilities` (resume/list/close/delete/additionalDirectories…). — same source

**Sessions and MCP**
- `session/new` takes `cwd` (absolute), `mcpServers`, and optionally `additionalDirectories` (gated by `sessionCapabilities.additionalDirectories`). — [ACP session setup](https://agentclientprotocol.com/protocol/session-setup)
- MCP server shapes:
  - **stdio** is mandatory for every agent: `name`, `command`, `args`, `env: [{name,value}]`.
  - **http** is gated by `mcpCapabilities.http`: `type:"http"`, `name`, `url`, `headers`.
  - **sse** is gated by `mcpCapabilities.sse` and is deprecated.
  - "Agents SHOULD connect to all MCP servers specified by the Client."
  - Source: same page.
- `session/load` makes the agent "replay the entire conversation to the Client in the form of `session/update` notifications" before it responds. `session/resume` reconnects and "MUST NOT replay". The client must check `loadSession` in the `initialize` response first. — same page

**Prompt turns and updates**
- `session/prompt` takes `{sessionId, prompt: ContentBlock[]}` and resolves with `{stopReason}`. The stop reasons are `end_turn`, `max_tokens`, `max_turn_requests`, `refusal` and `cancelled`. — [ACP prompt turn](https://agentclientprotocol.com/protocol/prompt-turn)
- `session/update` kinds:
  - `user_message_chunk`
  - `agent_message_chunk`
  - `agent_thought_chunk`
  - `tool_call`
  - `tool_call_update`
  - `plan`
  - `available_commands_update`
  - `current_mode_update`
  - `config_option_update`
  - `session_info_update`
  - `usage_update`
  - Source: same page
- Tool calls (source: [ACP tool calls](https://agentclientprotocol.com/protocol/tool-calls)):
  - Fields: `toolCallId`, `title`, `kind`, `status`, `content`, `locations`, `rawInput`, `rawOutput`, and optional `name`.
  - `kind` is one of `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode` or `other`.
  - `status` is one of `pending`, `in_progress`, `completed` or `failed`.
  - Content is a regular block, a `diff` (`path`, `oldText`, `newText`) or a `terminal` (`terminalId`).
  - `locations` is `[{path, line}]`.

**Permissions and cancellation**
- Permission request (source: [ACP tool calls](https://agentclientprotocol.com/protocol/tool-calls)):
  - The agent sends `session/request_permission {sessionId, toolCall, options: PermissionOption[]}`.
  - Each option is `{optionId, name, kind}`, with `kind` one of `allow_once`, `allow_always`, `reject_once` or `reject_always`.
  - The client answers `{outcome: {outcome: "selected", optionId}}` or `{outcome: {outcome: "cancelled"}}`.
  - "If the current prompt turn gets cancelled, the Client MUST respond with the 'cancelled' outcome."
- Cancellation (source: [ACP prompt turn](https://agentclientprotocol.com/protocol/prompt-turn)):
  - `session/cancel` is a notification.
  - The client "SHOULD preemptively mark all non-finished tool calls… as cancelled" and "MUST respond to all pending session/request_permission requests with the cancelled outcome".
  - The agent "SHOULD stop all language model requests and all tool call invocations as soon as possible" and "MUST catch these errors and return the semantically meaningful cancelled stop reason".
  - Updates may still arrive after the cancel, but only before the `session/prompt` response.

**Extensions**
- Method names starting with `_` are reserved for extensions. Unknown extension requests MUST get JSON-RPC `-32601`, and unknown notifications SHOULD be ignored. `_meta` is the place for custom data, and implementations "MUST NOT add any custom fields at the root of a type that's part of the specification". — [ACP extensibility](https://agentclientprotocol.com/protocol/extensibility)
- The ACP Registry (released 2026-03-09) lists installable agents — [ACP updates](https://agentclientprotocol.com/updates)
  - Today's `registry.json` (last-modified 2026-10-04 09:04 GMT) has 41 agents, including:
    - `grok-build` 1.0.49: npx `@xai-official/grok@1.0.49 agent stdio`
    - `cursor` 2026.10.01: binary `cursor-agent acp`
    - `kimi` 1.52.0: binary `kimi acp`; this is MoonshotAI/kimi-cli, not kimi-code
    - `opencode` 1.18.34: `opencode acp`
    - `devin`, `factory-droid`, `cline`, `gemini`, `codex-acp`, `claude-acp`, `qwen-code`, `goose`, `junie`, `mistral-vibe` and others
  - Source: [cdn.agentclientprotocol.com/registry/v1/latest/registry.json](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)

### Inferences
- Solenta should send `protocolVersion: 1` and accept 1. Every agent installed here is v1 in practice (Grok answers 1). v2 is a draft with an incompatible turn model, so supporting it now buys nothing.
- Solenta should advertise `fs:{readTextFile:false, writeTextFile:false}, terminal:false`. Agents then run their own tools under their own sandbox and permission model, which is also what T3 concluded (see section 2). This avoids implementing reverse file and terminal RPC, which v2 deletes anyway.
- Both v1 and v2 put the "cancelled" contract on the client: every pending permission request must be answered `cancelled`. A Solenta permission card that is still open when the user hits Stop has to be auto-resolved.

### Gaps
- The spec pages do not say how long a client should wait after `session/cancel` before killing the process. T3 uses its own timeout (`defaultCancelTimeout`), whose value I did not look up.
- I did not fetch the v2 RFDs (`rfds/v2/*`) themselves, only the migration summary.

## (2) How T3 uses ACP: AcpAdapterV2, GrokAcpSupport, Cursor and registry agents

### Takeaway
T3 has one shared ACP stack:
- `packages/effect-acp`: the JSON-RPC client.
- `AcpSessionRuntime.ts` (3,030 lines): process, initialize, session and cancel.
- `AcpAdapterV2.ts` (7,898 lines): maps ACP to T3's orchestration.
- Per-agent "flavors" on top: Grok, Antigravity, and the generic ACP-Registry flavor (with small Devin and Mistral hooks).

**Cursor is not on ACP in V2.** The V2 merge (#2829, 2026-10-02) deleted `CursorAcpSupport.ts` and moved Cursor to `@cursor/sdk` after a long list of Cursor-over-ACP reliability bugs.

Grok over ACP works, but only with many xAI-specific workarounds:
- a `clientType` meta in `initialize`
- `allow_once`-only grants
- racing an extension "prompt_complete" notification against the `session/prompt` RPC
- a hard process-group kill and respawn on Stop, because of `task_already_running`
- `ctrl_c` cancel meta

Stuck-on-Working bugs keep recurring (#3580 → #15489, which is open).

### Cited Findings

**Process lifecycle and handshake (AcpSessionRuntime)**
- Client capabilities default to `fs:{readTextFile:false, writeTextFile:false}, terminal:false` unless a flavor opts in — [R/apps/server/src/provider/acp/AcpSessionRuntime.ts#L1891-L1903](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/AcpSessionRuntime.ts#L1891)
  - The PR history explains why. #13584 (merged 2026-09-25): under on-request approval Grok "couldn't read any file" because it sent all reads through T3's client fs. #13623/#13633/#13634 then made client fs and terminals opt-in per agent ("rely on the agent's own sandboxes and permission models"). Only Antigravity serves client fs and only Devin uses T3 terminals.
  - Source: T3 PRs (gh search, 2026-10-04); also [R/apps/server/src/provider/acp/AcpClientPolicy.ts#L7-L15](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/AcpClientPolicy.ts#L7): "ACP agents run their own tools under their own permission model and ask through `session/request_permission`, which T3 answers by policy. The one client-mediated path left is Devin's `terminal/*`".
- `initialize` sends `{protocolVersion: 2, clientCapabilities, clientInfo, _meta?}` — [AcpSessionRuntime.ts#L2157-L2172](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/AcpSessionRuntime.ts#L2157)
- Session setup has three paths ([AcpSessionRuntime.ts#L2270-L2325](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/AcpSessionRuntime.ts#L2270)):
  - With a `resumeSessionId`, use `session/load` if `agentCapabilities.loadSession === true`.
  - Otherwise use `session/resume` if `sessionCapabilities.resume` is present.
  - Otherwise fail with -32601 "ACP agent does not advertise session/load or session/resume support".
  - New sessions call `session/new {cwd, mcpServers, additionalDirectories?}`.
  - `session/load` is wrapped in `runLoadSessionWithReplayIdle`, which has a timeout "waiting for RPC response or replay idle gap" ([L2061-L2100](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/AcpSessionRuntime.ts#L2061)). #3156 says Grok's `session/load` sometimes never returns.
- Auth runs `authenticate` only after an auth-required error, unless the flavor sets `authenticateEagerly`. It refuses non-`agent` auth types "which cannot run inside a headless provider session" — [AcpSessionRuntime.ts#L2224-L2266](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/AcpSessionRuntime.ts#L2224)
- Cancel: `session/cancel {sessionId, _meta: cancelMeta}` ([AcpSessionRuntime.ts#L2430-L2475](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/AcpSessionRuntime.ts#L2430)).
  - In `wait-for-prompt` mode it waits for the prompt to settle.
  - On timeout it fails with "The ACP agent did not finish cancellation. Its process was stopped." and kills the child with `forceKillAfter: "1 second"`.
- Model and mode changes ([AcpSessionRuntime.ts#L2744-L2796](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/AcpSessionRuntime.ts#L2744)):
  - Model goes through `session/set_config_option(model)`.
  - Mode goes through `set_config_option(category "mode")`, falling back to `session/set_mode` for v1 agents that only advertise `modes` (gemini-cli).
  - `session/set_model` is used only for Grok legacy protocol v1.
- Teardown: Grok gets an owned detached process group, killed with SIGTERM and then SIGKILL. Linux uses a cgroup-v2 lease. macOS "keeps the prior provider-group teardown until a stable libproc identity provider can cover Grok's nested detached tool groups" — [R/apps/server/src/provider/acp/GrokAcpSupport.ts#L92-L105](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/GrokAcpSupport.ts#L92); [AcpSessionRuntime.ts#L1721-L1760](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/AcpSessionRuntime.ts#L1721)

**MCP injection (T3's own `t3-code` orchestration MCP server)**
- Every ACP session gets a **stdio** MCP server that runs T3's own binary as a bridge. The credential travels in env, not argv ([R/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L675-L728](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L675)):
  - `{name:"t3-code", command: self.command, args:[…,"acp-mcp-bridge"], env:[ELECTRON_RUN_AS_NODE=1, T3_ACP_MCP_ENDPOINT, T3_ACP_MCP_AUTHORIZATION]}`
  - Code comment: "Stdio is ACP's required baseline MCP transport. Agents that advertise optional http support still routinely fail to wire injected http servers through to their backend (codex-acp 1.2.0 and pi-acp both drop them), so every ACP session gets the `t3 acp-mcp-bridge` stdio server".
  - Agents advertising `mcpCapabilities.acp` get `{type:"acp", name:"t3-code"}` (MCP-over-ACP) instead ([AcpSessionRuntime.ts#L2208-L2219](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/AcpSessionRuntime.ts#L2208)).
  - The prose doc still says Grok gets "the authenticated HTTP MCP endpoint through the ACP `session/new`, `session/load`, and `session/fork` `mcpServers` field" ([R/docs/orchestration-v2/orchestrator-mcp-server.md#L104-L114](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md)). The code (stdio bridge) is what runs, so the doc is stale.
- Grok's handling of client MCP servers is additive. **OPEN issue #12914** (2026-09-21): Grok CLI 1.0.40 "*admits* that list on top of what it already has (`admit_client_mcp_servers`) instead of substituting it". Every T3 Grok session therefore inherits the user's full MCP set, including servers imported from Claude/Cursor config. — [pingdotgg/t3code#12914](https://github.com/pingdotgg/t3code/issues/12914)
- **OPEN #14175** (2026-09-28): with `mcpServers: []`, `grok agent stdio` never fetches grok.com connectors, and `x.ai/mcp/list` returns -32601 — [#14175](https://github.com/pingdotgg/t3code/issues/14175)

**Approvals and runtime modes**
- The generic policy (`acpPermissionDisposition`) returns `allow`, `ask` or `deny` ([R/apps/server/src/provider/acp/AcpClientPolicy.ts#L101-L236](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/AcpClientPolicy.ts#L101)):
  - Read kinds (`read`/`search`/`think`) follow the sandbox and never ask.
  - `approval-required` asks.
  - `workspaceWrite` allows edits only when every `toolCall.locations[]` path canonicalizes inside cwd or writable roots, using realpath and following symlinks; it fails closed.
  - Full access allows.
- The permission handler ([AcpAdapterV2.ts#L5499-L5640](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L5499)):
  - `allow` answers with the agent's `allow_once` option.
  - `deny` answers with `reject_once`.
  - `ask` creates a T3 approval request and awaits the user's decision.
  - A cancel, or a missing option, answers `{outcome:{outcome:"cancelled"}}`.
  - User "accept" for a command records a per-turn grant, and "acceptForSession" a per-session grant, for client-terminal checks.
- Option selection ([AcpAdapterV2.ts#L1036-L1061](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L1036)) maps `acceptForSession` → `allow_always`, `accept` → `allow_once`, otherwise `reject_once`. Auto-approval prefers `allow_once`, because "Its allow-always option can outlive the session (Grok saves it for the whole project)".
- Grok runtime modes → argv ([GrokAcpSupport.ts#L40-L67](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/GrokAcpSupport.ts#L40)):
  - `approval-required` → `--permission-mode default agent stdio`
  - `auto` → `--permission-mode auto agent stdio`
  - `full-access` → `agent --always-approve stdio`
  - Comment: "It has no Auto-accept edits: `acceptEdits` only exists as a settings-file `permissions.defaultMode`, and `grok agent` treats it as ask."
  - Explicit approval or sandbox overrides launch as `approval-required` ([R/apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.ts#L219-L230](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.ts#L219)).
  - In `auto`, every Grok prompt goes to the user ("In its Auto mode Grok decides routine actions itself and only asks about what its classifier blocked") ([GrokAdapterV2.ts#L286-L289](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.ts#L286)).
- **Key Grok quirk: `clientType`.** T3 sends `initialize._meta = {clientType:"extension"}`. Source comment: "Grok's Auto mode asks the client about an action its classifier blocks only when the client declares a type that can show a prompt; the default (`generic`) gets a silent denial instead" ([GrokAcpSupport.ts#L114-L121](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/GrokAcpSupport.ts#L114)).
  - PR #13732 (merged 2026-09-26) quotes grok-build: Grok asks "only `if client_type.can_present_permission_prompt()`. Otherwise it returns a `PolicyDeny`, and keeps doing so until 3 consecutive or 20 total denials" — [#13732](https://github.com/pingdotgg/t3code/pull/13732)
  - xAI's own doc agrees: "In non-interactive sessions (`grok -p`, unidentified stdio), that same call fails and is reported to the model (for example `Auto mode blocked this action …`)" — [grok-build 22-permissions-and-safety.md#L100](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md)
- **Grok's permission options** come from live recordings:
  - An `rm -rf` in auto mode offers `always-allow` ("Yes, and don't ask again for bash commands", allow_always), `allow-once`, `reject-once` and `reject-always`.
  - An edit offers `allow-edits-session` (allow_always), `allow-once` and `reject-once`.
  - T3 answered `{"outcome":{"outcome":"selected","optionId":"allow-once"}}` in both.
  - Sources: [grok_auto_blocked_command/grok_transcript.ndjson](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/grok_auto_blocked_command/grok_transcript.ndjson); [tool_call_read_only_on_request/grok_transcript.ndjson](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/grok_transcript.ndjson)
  - The request also carries `toolCall.kind` (`execute`/`edit`), `title` ("Execute `rm -rf …`"), `rawInput` and `_meta["x.ai/tool"]`.
- Only `allow-edits-session` is session-scoped. Grok's "bash, monitor and MCP `always-allow` rows instead save a grant for the whole project that outlives the session". T3's approval card therefore offers Cancel, Decline, "Allow all edits this session" (only when present) and Approve ([GrokAcpSupport.ts#L123-L153](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/GrokAcpSupport.ts#L123)). The fixing PRs were #13796 and #13802 (merged 2026-09-26). Grants persist under `~/.grok/sessions/<cwd>/permission_*.toml`, per the PR body as relayed by my sub-search.
- Grok extension requests T3 must answer, or turns hang ([GrokAdapterV2.ts#L154-L217](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.ts#L154)):
  - `x.ai/ask_user_question` (and the `_x.ai/` alias) is routed to T3's user-input card.
  - `x.ai/exit_plan_mode` is captured as a proposed plan, and the native gate is abandoned "so the turn does not hang (#8358)".

**Turn completion, errors, usage limits (Grok)**
- Grok's `session/prompt` RPC can be stranded, so T3 wraps the runtime and "Races `session/prompt` against root-matched terminal notifications": `_x.ai/session_notification{turn_completed}` and `x.ai/session/prompt_complete` / `_x.ai/session/prompt_complete`, keyed by a T3-injected `_meta.promptId` — [R/apps/server/src/provider/acp/XAiAcpExtension.ts#L1560-L1600](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/XAiAcpExtension.ts#L1560). This came from PR #3156 (merged 2026-06-26): "so Grok turns settle when the standard ACP RPC remains stranded".
- Failures ([XAiAcpExtension.ts#L1404-L1430](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/XAiAcpExtension.ts#L1404)):
  - `stopReason: "rate_limit"` (a non-spec stop reason) → code -32003 "Grok usage limit reached. Try again later." → class `usage_limit` ([GrokAdapterV2.ts#L291-L306](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.ts#L291)).
  - `stopReason: "error"` carries Grok's text in `agentResult`, "before its `session/prompt` RPC error arrives".
- Recorded error turn ([grok_prompt_error fixture](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/grok_prompt_error/grok_transcript.ndjson)):
  - Grok emits `retry_state {type:"failed", error_type:"api", message:"API error (status 400 …)"}`, then `turn_completed stop_reason:"error"`, then the `session/prompt` error -32603 with `data.http_status: 400`.
  - **The same session then accepts the next prompt and completes normally.** Under headless `-p`, that error ends the process.
- Usage arrives on the `session/prompt` result `_meta`: `inputTokens`, `outputTokens`, `cachedReadTokens`, `reasoningTokens`, `costUsdTicks`, `modelUsage`, `numTurns` — [grok_auto_blocked_command fixture](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/grok_auto_blocked_command/grok_transcript.ndjson). OPEN PR #15233 (2026-10-03) "record usage from ACP prompt responses".
- Grok is noisy on the wire. A one-line "simple" turn produced:
  - 31 `agent_thought_chunk`, 3 `agent_message_chunk`, 3 `available_commands_update`
  - 12 `_x.ai/session/setup`, plus `_x.ai/queue/changed`, `_x.ai/models/update`, `_x.ai/sessions/changed`, `_x.ai/mcp_initialized` and others
  - Source: my count over [simple/grok_transcript.ndjson](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/simple/grok_transcript.ndjson)
  - Grok uses both `x.ai/*` (no underscore, which is not spec-compliant) and `_x.ai/*` aliases.
- Grok's `initialize` response (1.0.41) has these agent capabilities: `loadSession:true`, `promptCapabilities.image:false`, `mcpCapabilities {http, sse}`, and `sessionCapabilities {list, resume, close}`. Its auth methods are `cached_token` ("Cached token from ~/.grok/auth.json") and `grok.com` — same fixture. T3 sets `supportsImagePrompts: true` because "Grok CLI currently accepts and vision-processes image blocks while still reporting the capability as false" ([AcpAdapterV2.ts#L421-L428](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L421)).

**Stop, steer, cancel over ACP (Grok)**
- `cancelMeta = {cancelTrigger:"ctrl_c"}` ([GrokAcpSupport.ts#L107-L112](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/GrokAcpSupport.ts#L107)): "Current Grok treats Ctrl+C cancellation as a barrier against stale background-task wake prompts until the next genuine user turn."
- A recorded steer ([message_steering/grok_transcript.ndjson](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures/message_steering/grok_transcript.ndjson)):
  - T3 sends `session/cancel {_meta:{cancelTrigger:"ctrl_c"}}`.
  - Grok answers `turn_completed stop_reason:"cancelled"` (`cancellationCategory:"MidTurnAbort"`) and `prompt_complete`, then the `session/prompt` result `{stopReason:"cancelled"}`.
  - T3 then sends a **new `session/prompt` on the same session**, which completes with `end_turn`.
  - This is ACP's soft cancel: the context survives.
- Flavor flags ([GrokAdapterV2.ts#L232-L255](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.ts#L232); [AcpAdapterV2.ts#L388-L415](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L388)):
  - `restartRuntimeAfterInterrupt: true` and `terminateRuntimeProcessGroupOnInterrupt: true`. User Stop "still hard-kills the process group and respawns", because "Grok can keep `task_already_running` state until the process exits".
  - Steering interrupts stay soft (cancel plus same-session re-prompt).
  - `preserveRuntimeOnSettledInterrupt: true`: if the prompt already settled, skip the cancel so background subagents survive.
- The bug behind these flags is #3580 (closed 2026-08-04, fixed by #3578): "Stop → continue wedges after interrupting a mid-turn Grok run — the next prompt hits `task_already_running` in the zombie ACP child" — [#3580](https://github.com/pingdotgg/t3code/issues/3580)
- Steering: ACP has no in-turn injection, so `steerTurn` fails with `SteerRunUnsupported` and the orchestrator does interrupt-and-restart ([AcpAdapterV2.ts#L7290-L7296](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L7290)). The interrupt path handles Stop-vs-soft-steer races, orphan containment and "session is poisoned" outcomes ([AcpAdapterV2.ts#L7297-L7420](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L7297)).

**Cursor: ACP in V1, removed in V2**
- V1 spawned Cursor as `cursor-agent [-e endpoint] [--auto-review | --force] acp` with `authMethodId: "cursor_login"`. Runtime mode mapped `auto` → `--auto-review` and `full-access` → `--force`. Source: deleted file `apps/server/src/provider/acp/CursorAcpSupport.ts`, from `git show de343914^:…` in the T3 clone.
- Commit `de343914` (2026-10-02, "feat(orchestrator): introduce new orchestrator (#2829)") deletes `CursorAcpSupport.ts`, `CursorAcpExtension.ts` and their tests. Only `CursorTransportFailure.ts` remains: a 52-line detector for Cursor transport-error text that arrives as assistant chunks ([R/apps/server/src/provider/acp/CursorTransportFailure.ts](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/CursorTransportFailure.ts)).
- The V2 doc says Cursor gets T3's MCP "through the SDK's `mcpServers` agent and send options" — [orchestrator-mcp-server.md#L98-L102](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md)
- Why Cursor left ACP (via gh, relayed by my sub-search; I spot-checked several):
  - #1772 (closed 2026-04-06) quotes Theo: "Cursor ACP is not as reliable as Cursor Team claims and often provides outdated model lists".
  - #2829: "V2 runs Cursor through the official `@cursor/sdk` and explicitly does not use Cursor's ACP transport".
  - Cursor-over-ACP bugs closed by V2:
    - #7830: transport failures arrived as an assistant text chunk plus `end_turn`, so failed turns were recorded as successful.
    - #10480: `RetriableError … exceeded max retries`.
    - #12374: "http/2 stream closed with error code CANCEL".
    - #13284: "Cursor ACP backgrounds a shell, ends the turn, and never comes back" (reproduces on bare ACP).
    - #11216/#11217: resume permanently broken after a JSON-RPC line over 16 MiB.
    - #14006: subagents lost.
    - #6533: Full access still prompted.
    - #14586: steer waited behind the running prompt.
  - Treat these as reported symptoms. Except #3580 and #12914, I did not re-read every body.
- Cursor's own ACP doc ([cursor.com/docs/cli/acp](https://cursor.com/docs/cli/acp)):
  - Start with `agent acp`; the auth method is `cursor_login`.
  - Permission responses are `allow-once`, `allow-always` and `reject-once`.
  - Modes are agent, plan and ask.
  - **MCP servers "come from project-level or user-level `.cursor/mcp.json` files only"**: `session/new` accepts `mcpServers: []`, and team-level servers are unsupported.
  - Blocking extension requests `cursor/ask_question` and `cursor/create_plan`; notifications `cursor/update_todos`, `cursor/task` and `cursor/generate_image`.

**ACP Registry agents (Devin, Cline, Kimi, Droid…)**
- Registry URL `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`. npx/uvx packages must pin an exact version, and binary sha256 is checked when present — [R/apps/server/src/provider/acp/AcpRegistrySupport.ts#L45-L143](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/provider/acp/AcpRegistrySupport.ts#L45)
- Install flow ([orchestrator-mcp-server.md "ACP Registry V2"](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/docs/orchestration-v2/orchestrator-mcp-server.md)):
  - Binaries go to a managed versioned cache, npx packages install globally through `npm`, and uvx packages through `uv tool install`.
  - Readiness is proven by "a disposable `session/new`".
  - "Terminal-only login remains a manual operation".
  - Missing features degrade: steering becomes interrupt-and-restart, and forks use portable context.
- The generic adapter forbids per-agent branches: "do NOT add another `agentId === "..."` branch… Propose a dedicated driver instead" ([R/apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.ts#L80-L90](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.ts#L80)). The existing exceptions:
  - Mistral Vibe: rate-limit code -31001 and `_session/retrying`.
  - Devin: `cognition.ai/*` client meta, update normalizers, and client terminals, because "Devin runs commands through client terminals and has no ask mode over ACP" ([L184-L258](https://github.com/pingdotgg/t3code/blob/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.ts#L184)).
- Kimi is served through the generic registry adapter (`kimi acp`). The sub-search found no Kimi-specific bug reports, and earlier Kimi provider PRs were closed in favour of the registry (#2829).

**Test tooling worth copying**
- `apps/server/scripts/acp-replay-agent.ts` (300 lines) replays a recorded NDJSON transcript as a fake ACP agent. Entry types are `expect_outbound`, `emit_inbound` and `runtime_exit`.
- `record-grok-acp-replay-fixture.ts` (622 lines) records live `grok agent stdio` sessions through the real adapter.
- There are 87 fixture scenarios, about 18 of them Grok.
- Sources: [R/apps/server/scripts/](https://github.com/pingdotgg/t3code/tree/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/scripts); [testkit/fixtures](https://github.com/pingdotgg/t3code/tree/eac52f0087d9ba5dee5542f24788d1482affae43/apps/server/src/orchestration-v2/testkit/fixtures). T3 is MIT-licensed (`LICENSE`).

**Open ACP-path bugs in T3 (as of 2026-10-04; open issues and PRs, separated from main)**
- Grok, OPEN issues:
  - #15489 (2026-10-04): "Grok stays working after the final answer, then Stop files that answer as a superseded partial". It reads like a regression of #3580.
  - #15251: selected reasoning effort ignored; fix PR #15319 is open.
  - #12914: MCP servers are additive, not replacing.
  - #14175: no grok.com connectors.
  - #14285: an expired token is read as logged-out; fix PR #14731 is open.
  - #8879: Grok ends turns on a short progress note.
- Generic ACP, OPEN:
  - #14619: Antigravity/Gemini hang in thinking, then "ACP transport operation call-rpc failed for method session/cancel" and the thread can't recover.
  - #12979: a stale `session/request_permission` deadlocks the UI.
  - #15263: Kotlin-SDK agents (Junie) never become ready because request ids start at 2^32; fix PR #15374.
  - #15118: Mistral Vibe sign-in stuck.
- OPEN PRs:
  - #14138: time-limit ACP extension requests ("A wedged ACP agent that stays alive but never answers… hung the caller forever").
  - #14969: surface `AcpRequestError.data`.
  - MCP-bridge fixes #14432, #14419, #14420, #14431 and #15273.
  - #12513: helper processes outlive the backend.
- Previously fixed Grok-over-ACP problems, on main:
  - #7210 (closed 2026-08-27): a 70+ minute stall mid-reasoning; watchdog PR #7215 closed unmerged.
  - #10607 (merged 2026-09-30): a dead Grok ACP process kept its session registered; it is now retired and resumed via `session/load`.
  - #8282/#8293: rate-limit and error stop reasons were mapped to `end_turn`.
  - #14487: HTTP 426 from an outdated CLI produced an empty "completed" turn.
- Sources: gh searches on pingdotgg/t3code (2026-10-04). I spot-checked #3580, #12914, #13732, #14619 and #15489 directly.

### Inferences
- T3 shows ACP for Grok is **workable but not free**. About 1,700 lines of xAI extension handling and about 280 lines of Grok support sit on top of a 3,000-line runtime. Most of it covers features Solenta does not need on day one: subagent and background-task projection, plan capture, fork, Linux cgroups. The irreducible Grok-specific items:
  - `clientType:"extension"`
  - `allow_once` only
  - answering `x.ai/ask_user_question` and `x.ai/exit_plan_mode`
  - racing `prompt_complete` against the RPC
  - hard-kill and respawn on user Stop
  - `cancelTrigger: ctrl_c`
  - mapping `rate_limit` / `error` stop reasons
- Cursor: T3's experience argues **against** moving Cursor to ACP. Its ACP mode ignores client-passed MCP servers (Cursor's own doc), and T3 collected transport and hang bugs before leaving for `@cursor/sdk`. If Solenta wants more from Cursor than print mode, the SDK path is the better-evidenced option. That is a separate decision from ACP.
- Recurring stuck-on-Working bugs (#3580, #7210, #15489) suggest Solenta needs a watchdog/idle timeout on ACP turns, just as for print mode.

### Gaps
- I did not read the bodies of every Cursor-over-ACP issue; they are summarised from a sub-search.
- I did not verify whether Grok's `allow_always` grant file path is exactly `~/.grok/sessions/<cwd>/permission_*.toml`. The grok-build permissions doc says only "stored in Grok's own state directory under your home directory, scoped to the git repository", in `permission.toml` files ([22-permissions-and-safety.md](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md)).
- T3's macOS process-group teardown for Grok's nested detached tool groups is described as weaker than on Linux. I found no macOS-specific orphan bug report.

## (3) Installed CLIs on this machine: ACP modes and versions (help/version only)

### Takeaway
Every non-Anthropic and non-OpenAI worker CLI installed here ships a native ACP stdio server:
- `grok agent stdio` (1.0.46)
- `cursor-agent acp` (2026.09.10; hidden from top-level help)
- `kimi acp` (kimi-code 0.39.1)
- `opencode acp` (1.17.12)

One Solenta ACP client could therefore drive all four. Codex and Claude have no native ACP; they would need the registry's npx adapters, which Solenta does not need because it already has better native channels for them.

### Cited Findings
These come from local commands run on 2026-10-04: `--version`, `--help` and `<sub> --help` only. No sessions were started.

- **grok**: `grok 1.0.46 (2765805b9442) [stable]`, at `/Users/willem/.local/bin/grok`.
  - `grok agent --help` lists the subcommands `stdio` ("Run the agent over stdio"), `headless` (WebSocket relay), `serve` and `leader`.
  - Agent options: `-m/--model`, `--reasoning-effort`, `--always-approve`, `--agent-profile`, `--leader`/`--no-leader`, `--leader-socket`, and `--plugin-dir <DIR>`. The help text for the last: "Load a plugin from this directory for this process only… always trusted: hooks and MCP servers activate without a prompt. Used by the Agent SDKs to inject per-connection plugins."
  - `grok agent stdio --help` has only `--debug`, `--debug-file` and `--leader-socket`.
  - Leader mode "Defaults to [cli] use_leader in config.toml". Solenta's billing probe already passes `--no-leader` (S `electron/providerUsage.js:564`).
  - The ACP registry's latest is `grok-build` 1.0.49 (npx `@xai-official/grok@1.0.49 agent stdio`).
- **cursor-agent** (also `agent`): `2026.09.10-fd3934a`. `cursor-agent --help` does not list `acp`, but `cursor-agent acp --help` prints "Usage: agent acp [options] — Start the Cursor Agent as an ACP (Agent Client Protocol) server".
  - Top-level flags relevant to ACP launch: `--force/--yolo`, `--auto-review`, `--trust`, `--approve-mcps`, `--sandbox`, `--plugin-dir`, and `--mode plan|ask`.
  - The registry has `cursor` 2026.10.01 as a binary with args `["acp"]`.
- **kimi** (kimi-code, `/Users/willem/.kimi-code/bin/kimi`): `0.39.1`.
  - `kimi acp [--login] [--region]`: "Run kimi-code as an Agent Client Protocol (ACP) server over stdio".
  - Top-level `-y/--yolo` ("the agent may still ask questions") and `--auto` ("fully autonomous, the agent will not ask questions").
  - The registry's `kimi` 1.52.0 is a **different product** (MoonshotAI/kimi-cli, the Python CLI) — [registry.json](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
- **opencode**: `1.17.12`. It has `opencode acp` ("start ACP (Agent Client Protocol) server") with `--cwd`, `--port`, `--hostname`, `--mdns` and `--pure`. The registry's latest is 1.18.34.
- **codex** (`codex-cli 0.159.2`) and **claude** (`2.1.283 (Claude Code)`) are installed. The registry serves them through `@agentclientprotocol/codex-acp@2.1.1` and `@agentclientprotocol/claude-agent-acp@0.85.1` adapters.
- Not installed: gemini, droid, devin, cline, goose, qwen, auggie.
- Kimi-code's documented ACP surface ([kimi-code llms-full.txt, `kimi acp` reference](https://moonshotai.github.io/kimi-code/llms-full.txt)):
  - Capabilities: `loadSession: true`, `image: true`, `embeddedContext: true`, `mcpCapabilities.http` and `.sse` true, and session list/resume/close/delete/fork/additionalDirectories.
  - Methods: `session/new` returns `configOptions[]` and `modes`; `session/load` replays history; `session/set_mode` and `set_config_option` exist; `session/set_model` is an extension.
  - Client side: `session/request_permission` is the "Shared channel for tool approval and question prompts". fs and terminal reverse-RPC are used only when the client advertises them. `elicitation/create` is used for questions when the client advertises `elicitation.form`.
  - MCP forwarding: `http`, `stdio` and `sse` map to kimi transports; `acp` is "discarded with a warn".
- Grok's agent-mode doc ([grok-build 15-agent-mode.md](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md)):
  - `session/new` accepts `_meta` with `rules` ("Extra rules appended to the system prompt"), `systemPromptOverride`, `agentProfile`, `yoloMode` and `autoMode`.
  - `configOptions` include `model` and `reasoning_effort`, changed via `session/set_config_option`.
  - Extension methods live under `x.ai/*` (fs, git, worktree, search, terminal, session fork, rewind, compact, auth…).
  - Grok's own sample client uses `protocolVersion: 1`.
  - Note: Solenta passes `--rules` on the headless argv today; ACP's equivalent is `_meta.rules` on `session/new`.

### Inferences
- Version floor: T3's prior notes recorded a Grok `>=1.0.13` requirement for its ACP driver (see the earlier "T3 Code orchestrator deep dive/t3_providers_and_steering.md", around line 715). The local 1.0.46 clears it.
- Cursor's ACP being hidden from `--help` fits T3's experience that it is a second-class path.

### Gaps
- Per the constraints, I did not start any ACP session, so the local `initialize` responses (capabilities and auth methods per CLI) are unverified. Grok's comes from T3's 1.0.41 recordings.
- I did not check whether `opencode acp` honours client-passed `mcpServers` or how it asks for permission.

## (4) Solenta today, and what `electron/acp.js` would plug into

### Takeaway
Grok is not a separate runner. It runs through `startClaudeRun` as a non-interactive `claude-stream` provider (`grok -p … --output-format streaming-messages-json`) with asking modes force-mapped to `bypassPermissions --always-approve`. Kimi, Cursor and OpenCode are also one-shot print-mode processes with no prompt channel and no steering (they are queue-only).

Solenta already owns almost every piece an ACP adapter needs:
- a bidirectional NDJSON JSON-RPC client (`codexJsonRpc.js`, 374 lines)
- a notification-to-legacy-event translator pattern (`codex-appserver.js`)
- a decision model that maps 1:1 onto ACP options (Codex accept/acceptForSession/decline/cancel)
- per-run MCP server lists in nearly ACP shape (`kimiMcpServersForRun`)
- process-group kill
- even a one-shot Grok ACP `initialize` for billing

So an adapter is mostly glue: an estimated ~1.5–2.5k lines including tests, against T3's ~12.6k Effect-based lines.

### Cited Findings (Solenta, read-only; paths relative to S)

**How Grok, Cursor, Kimi and OpenCode run today**
- Dispatch is by `entryDef.kind` (`electron/runner.js:8668-8704`):
  - `claude-stream` → `startClaudeRun` (3844); Grok uses this kind (`electron/providers.js:572`).
  - `kimi-stream` → `startKimiRun` (5600).
  - `opencode-json` → `startOpencodeRun` (6136).
  - `cursor-stream` → `startCursorRun` (6616).
  - `codex-json` → `startCodexRun` (5008, app-server).
  - Workflows have a parallel dispatcher, `electron/workflow.js:1462` `spawnPhaseAgent`.
- Grok argv and permissions (`electron/providers.js:568-637`, verified):
  - `permissionModes: ["plan", "bypassPermissions"]`.
  - Comment: "headless -p has NO prompt channel (no --permission-prompt-tool / stream-json input like claude), so any mode that would ask auto-cancels the gated tool and the run dies with `errors: ["cancelled"]`… grok 1.0.5 treats `--permission-mode auto` as `default`… Map asking modes to bypassPermissions + --always-approve" (#549, #578).
  - argv: `--output-format streaming-messages-json --include-partial-messages --permission-mode <m> --rules "<detached-preview text>" [--always-approve] [-m] [--resume sid] [--reasoning-effort] -p <prompt>`.
  - Only Claude is interactive (`runner.js:4176`). Grok's stdin is ignored.
- Kimi (`electron/providers.js:785-876`): `permissionModes: ["bypassPermissions"]`, because "-p CANNOT combine with -y or --auto" (850-853). Effort is set by editing `config.toml` (`electron/kimi.js:367`).
- Cursor (`electron/providers.js:877-1403`): `-p --output-format stream-json --stream-partial-output --trust [--force] --approve-mcps …`. Modes are `["plan","bypassPermissions"]` because "asking cannot prompt (stdio is ignored)" (1361-1362).
- OpenCode (`electron/providers.js:639-784`): `run --format json --thinking [-s sid] [--auto] <prompt>`, modes `["default","bypassPermissions"]`.
- Questions: headless `grok -p` "answers its own ask_user_question with 'No user is available', and `kimi -p` forbids its question tool outright". Solenta therefore persists the question card and answers on the *next turn* (`electron/runner.js:2702-2716`, verified).
- Guardrail: because `--always-approve` skipped Solenta's `classifyTool` (#812), Grok runs get a PreToolUse hook written into a per-thread `GROK_HOME` overlay `config.toml` (`electron/grok.js:517-583`; `electron/runner.js:4186-4245`; issues #812/#832, closed 2026-09-02).

**Event normalization target**
- Rows are written with `appendMessage(threadId, role, text, runId, tool, …)` (`electron/runner.js:2969-3012`) into `ChatMessage {id, role: user|assistant|event|tool, text, tool?: ToolCallInfo, thinking?, …}` (`src/shared/ipc.ts:1174-1212`).
- `ToolCallInfo` is `{id, name, input, output|null, isError, done, images?}` (`ipc.ts:1122-1139`).
- `SessionUsage` is `{model, inputTokens, outputTokens, costUsd, turns, contextTokens?, contextWindow?}` (`ipc.ts:1215-1239`).
- `startClaudeRun`'s `onEvent` (`runner.js:4330-4765`) handles `system/init`, `assistant` (text, thinking, tool_use), `user` (tool_result), `result` (usage, sid, terminal status) and partial `stream_event` deltas.
- Pattern to copy: `electron/codex-appserver.js:187-269` `notificationToJsonl` rewrites app-server notifications into legacy exec-jsonl events, so the existing parsers are reused unchanged.

**Approvals**
- `getPendingPermission` (`electron/runner.js:2310-2346`) builds `PendingPermissionInfo {requestId, toolName, summary, input, command?, acceptAlways?, questions?, plan?, guardrail?}` (`src/shared/ipc.ts:1594-1639`). The decision type is `"allow"|"allowAlways"|"deny"|"cancel"` (`ipc.ts:1683`).
- `respondPermission` (`runner.js:2577-2700`) routes the answer.
- **Both only recognise `e.kind === "claude" || "codex"`** (`runner.js:2324`, `2610-2615`, verified). Everything else falls to `respondPersistedPlan`.
- Codex approvals: `handleCodexServerRequest` (`runner.js:2444-2533`) and `respondCodexPermission` (`2535-2566`), helpers in `electron/codexApprovals.js` (243 lines).
- Renderer: `threads:respondPermission` IPC (`electron/ipc.js:712-714`). Cards are `PermissionPrompt` / `QuestionPrompt` / `PlanPrompt` / `InputPrompt` (`src/components/ThreadView.tsx:8307-8343`).

**Stop and steer**
- `stopRun` (`electron/runner.js:8857-8999`) ends in `handle.kill()`. `killTree` (`electron/proc.js:183-197`) sends SIGTERM to the process group and SIGKILL after 3 s; spawns are `detached` on POSIX (`proc.js:29`).
- Hard-coded kind lists: `runner.js:3476-3482`, `8910-8919`, `8934-8941`, `9087-9096`.
- Steering needs `supportsSteer` and `handle.send` (`runner.js:8812-8851`). Only Claude (`providers.js:251`) and Codex (`providers.js:353`) have them.
- Grok, Kimi, OpenCode and Cursor sends are **queued** until the turn ends (`src/hooks/useCoder.ts:1801-1870`, drained by `runner.js:2094-2149`).

**JSON-RPC to reuse**
- `electron/codexJsonRpc.js` (374 lines): request/notify, inbound server requests, fail-closed -32601, `cancelOutstanding`, EPIPE handling. Only the binary/args (56-57), the error strings and `cancelOutstanding`'s Codex `approvalResponse` (349) are Codex-specific.
- `electron/providerUsage.js:344-476` `runStdioJsonRpc` is one-shot only. Lines 558-580 already do `grok agent --no-leader stdio` → `initialize {protocolVersion: 1, clientCapabilities: {}, clientInfo:{name:"solenta"}}` → `_x.ai/billing` (verified).

**MCP injection today**
- Grok: per-thread `GROK_HOME` overlay `config.toml` with `[mcp_servers]` from `kimiMcpServersForRun`, plus the guardrail hook (`electron/runner.js:4186-4219`; `electron/grok.js:521-588`; issue #706, closed 2026-08-25). The `ensureGrokMcpConfig` fallback for ssh/WSL writes `~/.grok/config.toml` and is now serialized: "One grok CLI at a time against ~/.grok/config.toml (#626)" (`electron/memory-sup.js:843-844`, verified). `enqueueGrokMcp` with snapshot/restore-if-corrupt is at about lines 1197-1289.
- Kimi: `KIMI_CODE_HOME` overlay. Cursor: `HOME` overlay plus `ensureCursorMcpConfig`.
- **OpenCode: no Solenta MCP injection found.**
- `kimiMcpServersForRun` (`electron/memory-sup.js:653-715`) returns `{name: {type:"http"|"sse", url, headers}}` or stdio `{type, command, args, env}`. That is ACP's `McpServer` minus reshaping `headers`/`env` into `[{name,value}]`.

**Resume and quota**
- Session ids come from `system/init` / `result` for Grok (`runner.js:4469-4472`, `4606-4611`), Kimi `-S` (`kimi.js:1170`) and OpenCode `-s` (`opencode.js:31`).
- `QUOTA_RE` / `decideQuotaWait` (`electron/quotaWait.js:32-33`, `404`) apply to any adapter that calls `markRunFailed` (`runner.js:3063-3114`).

**Sizes, as analogues**
- `startClaudeRun` is about 1,154 lines, `startKimiRun` about 536, `startOpencodeRun` about 480 and `startCursorRun` about 524.
- `codex-appserver.js` is 635 lines; `codex-appserver.test.js` is 1,129 lines.
- The prior research ("t3_queue_persistence_tests.md" 534-592) already proposed porting T3's ~300-line ACP replay peer.

### Design: minimal Solenta ACP adapter

1. **`electron/acp.js` (~400–550 lines): one module, no framework.**
   - **Transport.** Generalise `codexJsonRpc.js` (parametrise bin/args, error labels and the `cancelOutstanding` responder) instead of writing a second client.
     - Keep request ids as small integers. T3's #15263 shows Kotlin-SDK agents choke on ids ≥ 2^32.
   - **Handshake.** Send `initialize {protocolVersion: 1, clientCapabilities: {fs:{readTextFile:false, writeTextFile:false}, terminal:false}, clientInfo:{name:"solenta", version}, _meta: flavor.initializeMeta}`.
     - For Grok, `initializeMeta` is `{clientType:"extension"}`.
     - Reject if the agent answers a version other than 1.
   - **Session.**
     - If `thread.sessionId` exists and `loadSession` is true, call `session/load`. Bound it with a replay-idle timeout, because Grok sometimes never returns (T3 #3156).
     - Else, if `sessionCapabilities.resume` exists, call `session/resume`.
     - Else call `session/new {cwd, mcpServers}`.
     - Grok extras: `_meta.rules` replaces `--rules`, and `_meta.autoMode` / `yoloMode` are also available.
   - **Inbound requests.**
     - `session/request_permission` → `entry.pendingPermissions` (same shape as Claude/Codex) → existing `PermissionPrompt`.
     - Grok `x.ai/ask_user_question` (plus the `_x.ai/` alias) → `questions` on the pending entry → `QuestionPrompt`, answered live instead of on the next turn.
     - Grok `x.ai/exit_plan_mode` → `PlanPrompt`. This answers the Grok half of #707 (plan approval only exists for Claude).
     - Everything else, including `fs/*` and `terminal/*`, gets -32601. Unknown notifications are ignored, which covers Grok's large `_x.ai/*` notification stream.
   - **Turn.** `session/prompt {prompt:[{type:"text", text}], _meta:{promptId}}`.
     - For Grok, race the RPC against `_x.ai/session/prompt_complete` / `_x.ai/session_notification{turn_completed}` with the matching `promptId` (T3 #3156).
     - Stop reasons:
       - `end_turn` → success.
       - `cancelled` → idle, "Run stopped".
       - `rate_limit` (Grok, non-spec) → `markRunFailed` with quota text, so the existing `QUOTA_RE` / failover path engages.
       - `error` → failure carrying `agentResult` text.
   - **Usage.** Read the Grok `session/prompt` result `_meta.usage` (`inputTokens`, `outputTokens`, `cachedReadTokens`, `costUsdTicks` at 1e10 ticks per USD). Fall back to spec `usage_update`.
2. **Normalization (~150 lines, inside `acp.js`).** Emit claude-stream-shaped events, the `notificationToJsonl` trick, so `startClaudeRun`'s `onEvent` (`runner.js:4330-4765`) is reused:
   - `agent_message_chunk` → text `stream_event` delta / `assistant` text.
   - `agent_thought_chunk` → thinking.
   - `tool_call` → `assistant` `tool_use {id: toolCallId, name: title ?? kind, input: rawInput}`.
   - `tool_call_update` with a terminal `status` → `user` `tool_result {tool_use_id, content: text/diff content, is_error: status==="failed"}`.
   - `plan` → a TodoWrite-like tool row.
   - Prompt result → `result {subtype, session_id, usage}`.
   - The handle mimics `runClaude`'s `{send, respond, respondError, kill, getStderr, child}`, so runner integration stays at roughly 150 lines instead of a new 500-line `start*Run`.
3. **Runner wiring (~100–200 lines).**
   - Add the new kind (or flag) to `getPendingPermission` / `respondPermission` (`runner.js:2324`, `2610-2615`), the four `stopRun` kind lists and `workflow.js` `spawnPhaseAgent`.
   - Decision map, reusing `codexApprovals.js`' logic:
     - `allow` → the agent's `allow_once` option.
     - `allowAlways` → `allow_always` **only when it is session-scoped**, which for Grok means only `allow-edits-session`. Otherwise use `allow_once`, because Grok's bash/MCP `always-allow` writes a permanent project-wide grant (T3 #13796/#13802).
     - `deny` → `reject_once`.
     - `cancel` → `{outcome:"cancelled"}`.
   - On Stop, answer every pending request `cancelled` (an ACP MUST).
4. **Provider entries (~40–60 lines each in `providers.js`).**
   - Grok:
     - default → `--permission-mode default agent --no-leader stdio`. This gives real asks.
     - worker or "auto" → `--permission-mode auto agent --no-leader stdio`. Grok's classifier decides, and blocked actions become cards.
     - bypassPermissions → `agent --always-approve --no-leader stdio`.
   - Kimi: `kimi acp` (mode through `session/set_mode` / `set_config_option`; the ids need checking).
   - OpenCode: `opencode acp`. This gains MCP injection via `session/new`, which OpenCode has never had in Solenta.
   - Cursor: **leave on print mode** (see section 2).
   - Pass MCP via `session/new.mcpServers` from `kimiMcpServersForRun`, reshaped.
5. **Stop.** Send `session/cancel {sessionId, _meta:{cancelTrigger:"ctrl_c"}}` (the meta is Grok-only and harmless elsewhere). Wait up to about 3 s for `stopReason: "cancelled"`, then `killTree`. For Grok, never reuse the process after a user Stop (`task_already_running`, T3 #3580).
6. **Lifecycle phasing.**
   - Phase 1: one ACP process per run, matching today's model. This gives prompts, live questions, structured errors and usage.
   - Phase 2 (optional): keep the process per thread. Steer becomes `session/cancel` plus a re-prompt on the same session (T3's soft steer), which enables `supportsSteer` for Grok, Kimi and OpenCode. It adds idle-process and reaping state; T3 has an OPEN orphan-reaping issue (#15357, cited in the earlier notes).
7. **Tests.** Port T3's replay-peer idea (~300 lines, MIT) and record 4–6 Grok and Kimi NDJSON fixtures: simple, permission, cancel/steer, prompt error, rate limit. Use a fake agent in the `electron/test` style. Run the renderer build check (`npx vite build`) before release, per the memory notes.

**Size estimate**

| Piece | Lines |
|---|---|
| `acp.js` | 450–700 |
| Runner/workflow wiring | 250–400 |
| Provider entries | 120–180 |
| Tests and fixtures | 800–1,200 |
| **Total** | **~1.6–2.5k** |

### Inferences
- The cheapest high-value slice is Phase 1 for Grok alone (about 1k lines with tests). Kimi and OpenCode are mostly a provider entry once the client exists.
- Keep headless print mode as a per-provider fallback toggle. T3's open Grok-over-ACP wedge bugs (#15489) mean ACP should not be the only path at first.
- Solenta's `classifyTool` guardrail can become the ACP permission disposition: `deny` → `reject_once`, `ask` → card, `allow` → `allow_once`, just as T3's `acpPermissionDisposition` works. In ask and auto modes this moves guardrails from a hook into the protocol. In always-approve mode Grok never asks, so keep the overlay PreToolUse hook (or `grok agent --plugin-dir`) for the deny tier.

### Gaps
- I have not verified whether `grok agent stdio` honours the per-thread `GROK_HOME` overlay and its PreToolUse hook the way `grok -p` does, or whether `--plugin-dir` could replace the overlay.
- The plan-mode mapping for Grok over ACP (a `--permission-mode plan` launch vs a session mode config option) is not traced.
- Kimi-code's ACP mode ids (`default` / `yolo` / `auto` / `plan`) are not listed on its ACP page.
- The worker split (399 of 493 workers on Grok) comes from the assignment, not the repo. Per-provider worker counts are not stored; only per-day spend `byProvider` exists (`src/usage.ts:32`).

## (5) Does ACP fix Solenta's Grok pain points? Cost/benefit

### Takeaway
ACP clearly fixes the **missing prompt channel** (approvals, questions and plan exits become live cards). It also enables **soft mid-run steering**, but only with a per-thread process in Phase 2. It does **not** fix crashes. The config.toml corruption and trust-prompt issues are already mitigated or don't apply on Solenta's path.

Net: worth doing for Grok (most of the fleet), with Kimi and OpenCode as cheap add-ons. Not worth doing for Cursor.

### Cited Findings

**Pain point mapping**

| Pain point | Does ACP fix it? | Evidence |
|---|---|---|
| Headless cannot ask permission; Solenta forces `bypassPermissions --always-approve` | **Yes** | `session/request_permission` is a blocking request the client answers ([ACP tool calls](https://agentclientprotocol.com/protocol/tool-calls)). T3 runs Grok in `default` and `auto` with real cards (`GrokAcpSupport.ts#L56-L67`; fixtures `grok_auto_blocked_command`, `tool_call_read_only_on_request`). Grok only asks a client that declares `clientType:"extension"`; "unidentified stdio" gets the same silent failure as `grok -p` ([grok-build permissions doc L100](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md); T3 #13732). Today's workaround: `electron/providers.js:585-598`. |
| Questions / plan approval impossible headless (`grok -p` answers "No user is available"; `kimi -p` forbids questions) | **Yes** | Grok sends `x.ai/ask_user_question` / `x.ai/exit_plan_mode` as requests over ACP (`GrokAdapterV2.ts#L154-L217`). Kimi's `request_permission` is the "shared channel for tool approval and question prompts" (kimi docs). Today's workaround: `electron/runner.js:2702-2716`. |
| Mid-run deaths `error_during_execution` / `cancelled` | **Mostly no; evidence thin** | See the note below this table. |
| `~/.grok/config.toml` self-corruption (#626) | **Already fixed in Solenta; ACP removes the last writer** | #626 closed 2026-08-20 (serialized `grokMcpChain`, `electron/memory-sup.js:843-844`). Normal runs use a per-thread `GROK_HOME` overlay (#706). ACP's `session/new.mcpServers` would replace the overlay's MCP writes and the ssh/WSL `grok mcp add` fallback. Caveat: Grok *adds* client servers on top of the user's (T3 #12914 open), and the overlay still carries the guardrail hook unless that moves too. |
| Trust-prompt "hangs" | **Not applicable / unknown** | The memory note concerns TUI panes launched via agentmux, not Solenta's headless runs. Grok's doc: "Headless startup with these sources requires `--trust` or a prior grant", and folder trust gates repo `.grok/config.toml`, `.claude/settings.json`, instructions and skills ([permissions doc L559](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md)). How `grok agent stdio` treats an untrusted folder is undocumented, and T3's Grok code has no trust handling (grep found none). Cursor already gets `--trust` (`providers.js:1382`). |
| Mid-run steering (Grok sends are queued today) | **Yes, soft, Phase 2 only** | ACP has no injection. T3 does `session/cancel` (ctrl_c meta) then a new `session/prompt` on the **same session**, keeping context (`message_steering` fixture). This needs a long-lived process. User Stop must still kill and respawn Grok (`task_already_running`, T3 #3580). Queue-only today: `useCoder.ts:1801-1870`. |
| Provider errors kill the run | **Partly** | In ACP a failed prompt (`stopReason:"error"` / -32603) leaves the session usable; the next prompt succeeds in the same process (`grok_prompt_error` fixture). Usage limits come as structured `stopReason:"rate_limit"` instead of text matching (`XAiAcpExtension.ts#L1404-L1430`). |
| OpenCode has no Solenta MCP | **Yes** | `session/new.mcpServers` is mandatory-stdio in every agent ([ACP session setup](https://agentclientprotocol.com/protocol/session-setup)). |

**Mid-run deaths: why the answer is "mostly no"**
- The 2026-08-19 cluster recorded in memory is most plausibly the headless permission auto-cancel. Solenta #578, opened and closed 2026-08-19, says: "Grok threads (and grok workers) end with Run stopped even when nobody hit Stop… `User cancelled the execution for tool run_terminal_command`… `--permission-mode auto` is `default` in CLI 1.0.5". That was fixed the same day by always-approve.
- The memory itself says "Bash worked fine in that mode". That conflicts with #578's finding, so the attribution is not certain.
- My search of Solenta issues since 2026-08-20 found no newer report with this signature.
- ACP does not prevent process or transport death. T3's Grok-over-ACP has its own wedge and stall bugs: #3580, #7210, and #15489 (open, 2026-10-04, "Grok stays working after the final answer").

**Benefits beyond the pain list**
- A persistent session gives no per-turn process startup, live `config_option` model and effort switching, and structured usage with cost ticks.
- Live question and plan cards for Grok and Kimi.
- One client covers Grok, Kimi and OpenCode (section 3). Issue #272's comments already argue this ("ONE ACP client integration gives Solenta deep control of two harnesses"), and in Round 26 flag Goose ACP bugs where client system prompts and tools are silently dropped — `gh issue view 272 -R currentbits/solenta`.

**Costs and risks**
- About 1.6–2.5k new lines (section 4), plus a second Grok code path to maintain alongside headless.
- Grok-specific protocol quirks:
  - the `clientType` meta
  - `x.ai` vs `_x.ai` method aliases
  - the `prompt_complete` race
  - the non-spec `rate_limit` stop reason
  - `allow_always` meaning a persistent project grant
  - wrong `image:false` advertising
  - additive MCP
- Grok over ACP has open wedge bugs at T3 (#15489) and earlier stalls (#7210), so Solenta needs an idle watchdog.
- ACP v2 (draft) will change the turn model. Staying on v1 is safe because "v1 peers remain supported indefinitely" ([migration](https://agentclientprotocol.com/protocol/v2/migration)).
- Unattended workers + asking modes = blocked fleet. With 399 of 493 historical workers on Grok, the worker default should be Grok `auto` (classifier; only blocked actions ask), or always-approve plus the guardrail hook. Plain `default` would flood the user with cards.

### Inferences
- **Recommendation:**
  1. Build Phase 1 (per-run ACP process) for Grok behind a provider toggle, with `auto` as the worker default and `default` for foreground threads.
  2. Add Kimi and OpenCode entries once it is stable.
  3. Consider Phase 2 (persistent process, soft steer) only after Phase 1 fixtures pass.
  4. Do not move Cursor to ACP: its ACP mode ignores client MCP servers, and T3 abandoned it for `@cursor/sdk`.
- Keep the "commit incrementally" worker guidance. ACP is not a crash fix.
- The memory note `grok-worker-midrun-crash.md` should be cross-checked against #578. The same-day root cause suggests it may be stale.

### Gaps
- There is no local evidence (by constraint) that ACP Grok 1.0.46 behaves like T3's 1.0.41 recordings.
- There is no data on crash rates under ACP vs headless for the same workload. T3 never ran Grok headless (sub-search), so no side-by-side comparison exists.
- I could not confirm whether Grok persists client-passed `session/new` MCP servers anywhere on disk; nothing found either way.
