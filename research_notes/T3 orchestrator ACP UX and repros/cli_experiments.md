# CLI experiments: Claude steer priority, rate_limit_event, fork-session, Codex app-server (2026-10-04)

All runs were done on 2026-10-04 in the scratch directory `/tmp/cli-exp`, which is outside every repo. Every inherited `CODER_*` variable was unset; the only one present was `CODER_GUARDRAILS_PATH`. Claude runs used `--strict-mcp-config --safe-mode` and loaded no MCP servers. No user config was modified.

**Versions:**
- `claude --version` → `2.1.283 (Claude Code)`. The binary `/Users/willem/.local/bin/claude` resolves to `/Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, a 225 MB Mach-O Bun bundle.
- `codex --version` → `codex-cli 0.159.2`, at `/Users/willem/.codex/packages/standalone/releases/0.159.2-aarch64-apple-darwin/bin/codex`.
- `node` v22.23.2.

**Budget used:**
- 8 Claude sessions in total (s1–s5, s8, fork-1, fork-2). All used `--model haiku`, which resolved to `claude-haiku-4-5-20251001`.
- The sum of each session's final `total_cost_usd` is about **$0.112** at list prices.
- No Codex model turns; Codex was used only for `--help` and schema generation.

Bundle offsets cited as `claude.exe@N` are byte offsets into the binary above. They were found with the helper `/tmp/cli-exp/ctx.js` (`node ctx.js '<needle>' <before> <after> <max>`), which prints the latin1 text around each match. I used it because the system `grep` here is ugrep, and ugrep rejected the context regex on this file.

## 1. Claude CLI steer semantics: no priority vs `"next"` vs `"now"`

### Takeaway
On CLI 2.1.283 in `-p` stream-json mode, **none of the three priorities shortens the wait behind a running foreground Bash call.**
- `sleep 20` always ran to completion, and the steer was answered about 19 s later in every case.
- No priority and `"next"` behave identically: the steer is folded into the same turn after the tool round, giving one `result` (`terminal_reason:"completed"`) with both message uuids.
- `"now"` aborts the turn when the running tool finishes. It emits an extra `result` with `subtype:"success"`, `is_error:false`, `result:""`, and `terminal_reason:"aborted_tools"`, then starts a new turn for the steer.
- `"now"` also **cancels queued, not-yet-started tool calls** in the same batch with the "The user doesn't want to take this action right now. STOP…" error. This reproduces T3 issue #15351 exactly. `"next"` lets them run.
- After every variant the process stayed usable: a follow-up probe got `PROBE-OK`, and the process exited 0 on stdin EOF.

### Cited Findings

#### Method
- **Driver:** a node script spawns `claude -p --input-format stream-json --output-format stream-json --verbose --model haiku --permission-mode bypassPermissions --strict-mcp-config --safe-mode --no-session-persistence`.
  - It writes the first user message at t=0.
  - It writes the steer **3.0 s after the first `assistant` frame containing a Bash `tool_use`**.
  - After 6 s of silence following a result, it sends a usability probe ("Reply with exactly PROBE-OK."), then closes stdin.
  - Every stdout line is timestamped (seconds since spawn) and logged raw to `<label>.ndjson`.
  - Each user message carries a client `uuid` so the `command_lifecycle` and `result.user_message_uuids` frames can be tied to sends.
  - Source: [/tmp/cli-exp/drive.js](file:///tmp/cli-exp/drive.js). The full script is reproduced at the end of this section.
- **Exact input shape that was accepted** (s3 steer, raw): `{"type":"user","message":{"role":"user","content":"Change of plan: stop waiting and reply with exactly the word STEERED-s3-now and nothing else."},"parent_tool_use_id":null,"session_id":"","uuid":"1cfd10d9-3e80-435d-870f-ef7ddfd1a488","priority":"now"}` — [s3 raw log](file:///tmp/cli-exp/s3-now/s3-now.ndjson)
- **Commands run:**
  - `node ../drive.js s1-none none sleep`
  - `… s2-next next sleep`
  - `… s3-now now sleep`
  - `… s4-multi-now now multi`
  - `… s5-multi-next next multi`
  - `… s8-now-bg now sleep bg`
  - Each was run from its own subdirectory under `/tmp/cli-exp`.
  - Prompts:
    - "sleep" scenario: "Use the Bash tool to run exactly: sleep 20 && echo SLEEP_DONE …". Its steer: "Change of plan: stop waiting and reply with exactly the word STEERED-<label>…".
    - "multi" scenario: "In ONE assistant message, issue these three Bash tool calls together: 1) sleep 8 && touch one.txt 2) touch two.txt 3) touch three.txt …". Its steer is notification-like: "[notification] Background job <label> finished. No action needed; just mention NOTED-<label> in your final reply."
  - Source: [drive.js](file:///tmp/cli-exp/drive.js)

#### Measured results

| run | priority | steer sent | running Bash | queued Bash calls | `result` frames for the steered stretch | steer acknowledged | probe after |
|---|---|---|---|---|---|---|---|
| s1 | (none) | +8.15 s | ran to end (SLEEP_DONE +25.62) | n/a | 1: `success`/`completed`, `num_turns=2`, `user_message_uuids=[first, steer]` | **+19.67 s** | PROBE-OK, exit 0 |
| s2 | `next` | +7.03 s | ran to end (+24.53) | n/a | 1: `success`/`completed`, `num_turns=2`, uuids `[first, steer]` | **+19.01 s** | PROBE-OK, exit 0 |
| s3 | `now` | +5.76 s | ran to end (+23.32), **not killed, not backgrounded** | n/a | 2: `success`/**`aborted_tools`** `result:""` `stop_reason:"tool_use"` uuids `[first]`, then `success`/`completed` uuids `[steer]` | **+18.70 s** | PROBE-OK, exit 0 |
| s4 | `now` | +6.93 s | `sleep 8` ran to end (+12.38) | **both cancelled** (`is_error:true`, "The user doesn't want to take this action right now…"); only `one.txt` exists | 2: `aborted_tools`, then `completed` | +7.66 s | PROBE-OK, exit 0 |
| s5 | `next` | +5.87 s | `sleep 8` ran to end (+11.31) | **both ran** (+11.33, +11.35); `one/two/three.txt` exist | 1: `completed`, uuids `[first, steer]`; text "ALL-DONE. (NOTED-s5-multi-next)" | +6.71 s | PROBE-OK, exit 0 |
| s8 | `now` + `background_tasks` control request | +7.22 s | ran to end (+24.67); control reply `{"backgrounded":false}` | n/a | 2: `aborted_tools`, then `completed` | +19.14 s | PROBE-OK, exit 0 |

Sources: [s1 log](file:///tmp/cli-exp/s1-none/s1-none.log), [s2 log](file:///tmp/cli-exp/s2-next/s2-next.log), [s3 log](file:///tmp/cli-exp/s3-now/s3-now.log), [s4 log](file:///tmp/cli-exp/s4-multi-now/s4.log), [s5 log](file:///tmp/cli-exp/s5-multi-next/s5.log), [s8 log](file:///tmp/cli-exp/s8-now-bg/s8.log).

- **Trimmed s3 (`now`) timeline**, which shows the abort shape. Source: [s3 log](file:///tmp/cli-exp/s3-now/s3-now.log)
  ```
  +2.76s OUT assistant | tool_use Bash id=T6Exjo "sleep 20 && echo SLEEP_DONE"
  +5.76s IN  STEER uuid=1cfd10d9 priority=now
  +5.76s OUT command_lifecycle | cmd=1cfd10d9 state=queued
  +6.30s OUT system/task_started
  +23.31s OUT system/task_notification
  +23.32s OUT user | tool_result id=T6Exjo is_error=false "SLEEP_DONE"
  +23.32s OUT result/success | is_error=false terminal_reason=aborted_tools num_turns=2 queued_turn_count=0 user_message_uuids=da9a652e result=""
  +23.32s OUT command_lifecycle | cmd=da9a652e state=cancelled
  +23.32s OUT command_lifecycle | cmd=1cfd10d9 state=started
  +23.32s OUT system/init | session=d3a0278c-… (same session id)
  +24.46s OUT assistant | text="STEERED-s3-now"
  +24.46s OUT result/success | terminal_reason=completed num_turns=1 user_message_uuids=1cfd10d9 result="STEERED-s3-now"
  ```
- **Trimmed s4 (`now`, three Bash calls in one assistant message)**, which reproduces T3 #15351. Source: [s4 log](file:///tmp/cli-exp/s4-multi-now/s4.log)
  ```
  +3.93s OUT assistant | tool_use Bash id=deFpLR "sleep 8 && touch one.txt"
  +3.94s OUT assistant | tool_use Bash id=gQsLgc "touch two.txt"
  +3.95s OUT assistant | tool_use Bash id=FM4dtv "touch three.txt"
  +6.93s IN  STEER uuid=a4f50d8f priority=now
  +12.38s OUT user | tool_result id=deFpLR is_error=false "(Bash completed with no output)"
  +12.38s OUT user | tool_result id=gQsLgc is_error=true "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."
  +12.38s OUT user | tool_result id=FM4dtv is_error=true "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."
  +12.38s OUT result/success | terminal_reason=aborted_tools num_turns=4 user_message_uuids=aa10c532 result=""
  +12.38s OUT command_lifecycle | cmd=aa10c532 state=cancelled
  ```
- **Steer handling after the tool returned.** In every sleep run the steer was answered 1.1–2.2 s after the tool result:
  - s1: 25.62 → 27.82
  - s2: 24.53 → 26.04
  - s3: 23.32 → 24.46
  - s8: 24.67 → 26.36

  So `now` saved only about 0.4–1 s here, by skipping the continuation of the old turn. It did not save the remaining tool time — [s1](file:///tmp/cli-exp/s1-none/s1-none.log), [s2](file:///tmp/cli-exp/s2-next/s2-next.log), [s3](file:///tmp/cli-exp/s3-now/s3-now.log), [s8](file:///tmp/cli-exp/s8-now-bg/s8.log)
- **`system/task_started` timing.** It always arrived about 3.4 s after the Bash `tool_use` frame, with `"is_backgrounded":false,"task_type":"local_bash"`. A `system/task_notification` with `"status":"completed"` followed when the command ended. Raw s1 line: `{"type":"system","subtype":"task_started","task_id":"bvvo1rbk8","tool_use_id":"toolu_013jpBYpgfQUa5aQTvZKsuEu","description":"Sleep for 20 seconds then echo SLEEP_DONE","is_backgrounded":false,"task_type":"local_bash",…}` — [s1 raw](file:///tmp/cli-exp/s1-none/s1-none.ndjson). The bundle registers a running shell as a task once elapsed ≥ `u3t=2000` ms: `if(!Pn&&!gn&&qt===void 0&&bn>=u3t/1000){if(!hn)hn=XNn({command:He,shell:"bash",…})` — [claude.exe@186646128](file:///Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe)
- **The `background_tasks` control request came too early in s8.** It was sent at +7.22 s, 0.44 s *before* `task_started` (+7.66 s), and returned `{"subtype":"success","request_id":"bg-1","response":{"backgrounded":false}}`. Request sent: `{"type":"control_request","request_id":"bg-1","request":{"subtype":"background_tasks","tool_use_id":"toolu_…tjkaEy"}}` — [s8 log](file:///tmp/cli-exp/s8-now-bg/s8.log)
- **`command_lifecycle` frames are emitted by default** for stdin messages that carry a client `uuid`. The states seen were `queued`, `started`, `completed`, and `cancelled` (the first message of a `now`-aborted turn ends `cancelled`). Schema doc: "'queued' when the inbound message enters the command queue; 'started' when it drains into a turn; then exactly one terminal state: 'completed'… 'cancelled'… consumed into a turn that was aborted (interrupt)…". Commands sent without a uuid "emit no lifecycle events" — [claude.exe@177581821](file:///Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe); observed in all runs, e.g. [s3 log](file:///tmp/cli-exp/s3-now/s3-now.log)
- **Results echo client uuids.** Each `result` carries `user_message_uuid` and `user_message_uuids`, plus `result_index` (0, 1, 2… per process). Raw s3 abort result (usage elided): `{"stop_reason":"tool_use","total_cost_usd":0.008809,"terminal_reason":"aborted_tools","is_error":false,"num_turns":2,"subtype":"success","result":"","user_message_uuid":"da9a652e-…","user_message_uuids":["da9a652e-…"],"queued_turn_count":0,"result_index":0,…}` — [s3 raw](file:///tmp/cli-exp/s3-now/s3-now.ndjson)
- **`queued_turn_count` was 0 on the `aborted_tools` result** even though the `now` steer was about to start, because it had already been dequeued. Its doc says ">0 means at least one more user turn (and result) follows" — [s3 raw](file:///tmp/cli-exp/s3-now/s3-now.ndjson); [claude.exe@177501687](file:///Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe)
- **`total_cost_usd` and `modelUsage` are cumulative per process; `usage` is per turn.** Measured:

  | run | result | `total_cost_usd` | `usage.output_tokens` | `modelUsage.outputTokens` |
  |---|---|---|---|---|
  | s3 | 1 | 0.008809 | 199 | 199 |
  | s3 | 2 | 0.0115976 | 86 | 285 |
  | s3 | 3 | 0.0138752 | 37 | 322 |
  | s1 | 1 | 0.0156312 | — | — |
  | s1 | 2 | 0.0181673 | 44 (with `usage.input_tokens` 10) | 637 |

  The bundle doc agrees: "Cumulative estimated cost in USD for this query() call… cumulative across turns in streaming-input sessions — each result carries the running total so far, so read the latest result rather than summing across results" — [s1/s3 raw](file:///tmp/cli-exp/s3-now/s3-now.ndjson); [claude.exe@177501687 (QR)](file:///Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe)

#### What the installed bundle says (CLI 2.1.283)
- **Input schema for an SDK user message:** `priority:G(["now","next","later"]).optional()`, next to `uuid`, `shouldQuery`, `timestamp`, and `origin` — [claude.exe@177460133](file:///Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe)
- **Queue ordering:** `f6={now:0,next:1,later:2}`. User sends get `priority:nr.priority??"next"`, so omitting `priority` is the same as `"next"`, which matches s1≡s2. Task notifications default to `priority:nr.priority??"later"` — [claude.exe@183082772, @183090095, @183091087](file:///Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe)
- **The `now` mechanism:** `_abortOnNowPriorityCommand(){…if(this._requireHost().messageQueue.getCommandQueueSnapshot().some((h)=>h.priority==="now"))this._snapshot.abortController?.abort(Kl("interrupt"))}` — [claude.exe@204890613](file:///Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe)
- **A running shell ignores an `"interrupt"`-reason abort:** `#T(){let e=ki(this.#i.reason);if(e==="interrupt"||M7t(e,this.#u))return;this.kill()}`. This explains why `sleep 20` was neither killed nor shortened — [claude.exe@182981512](file:///Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe)
- **After the tool batch, an aborted controller returns `{reason:"aborted_tools"}`:** `if(f.abortController.signal.aborted){…yield OA({toolUse:!0,…});…return Jt(f,h),{reason:"aborted_tools"}}` — [claude.exe@190789992](file:///Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe)
- **`terminal_reason` enum:** `blocking_limit, rapid_refill_breaker, prompt_too_long, image_error, model_error, api_error, malformed_tool_use_exhausted, aborted_streaming, aborted_tools, stop_hook_prevented, hook_stopped, tool_deferred, max_turns, background_requested, completed`, plus `budget_exhausted, structured_output_retry_exhausted, tool_deferred_unavailable, turn_setup_failed`. The helper `CD(e)` is `e==="aborted_streaming"||e==="aborted_tools"`. The error classifier returns false (not an error) for `aborted_*` — [claude.exe@177400610](file:///Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe)
- **`result` subtypes:** `success`, or one of the error subtypes `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`. The doc says: "The CLI emits exactly one result message per turn… treat it as the turn-complete signal (informational system messages such as task notifications… may still follow it)" — [claude.exe@177509978, @177513903](file:///Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe)
- **`system/turn_preempted` is gated** (@internal). The CLI can itself preempt a turn for a "rapid follow-up… exactly as a priority 'now' message would have (running shell commands are backgrounded, not killed)… only to a consumer that declared rapidFollowupPreempt on its initialize request, while the feature's rollout flag is on… Explicit 'now' and 'later' priorities never produce it" — [claude.exe@80263722](file:///Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe)
- **The `background_tasks` control request is public:** `{subtype:"background_tasks", tool_use_id?}` — "Backgrounds in-flight foreground tasks (Bash commands and subagents)… the control-request equivalent of pressing Ctrl+B in the terminal. Each blocking tool call returns immediately with a 'running in the background' tool_result and the turn continues; the task keeps running and emits a task_notification when it settles". The reply is `{backgrounded?: boolean}` — [claude.exe@177723666](file:///Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe)
- **An interactive-only low-latency path exists.** `input_low_latency_submit` / `delivered_early` code calls `aEr(...)`, which backgrounds running shells with `{backgroundedToDeliverMessage:!0}`. It sits in the TUI input metric family (`input_*`) — [claude.exe@203729304, @186565317, @178281742](file:///Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe)

#### Driver script (`/tmp/cli-exp/drive.js`, final version)
```js
// Drive one `claude -p` stream-json session, steer it mid-tool, timestamp every stdout line.
// usage: node drive.js <label> <priority:none|next|now> <scenario:sleep|multi> [bg]
// bg: also send control_request background_tasks for the running Bash tool_use right after the steer.
// Raw lines -> <label>.ndjson ({t, dir, line}); compact summary -> stdout.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const crypto = require("node:crypto");

const [label, prio, scenario, bg] = process.argv.slice(2);
const T0 = Date.now();
const t = () => ((Date.now() - T0) / 1000).toFixed(2);
const raw = fs.createWriteStream(`${label}.ndjson`);

const PROMPTS = {
  sleep: {
    first: "Use the Bash tool to run exactly: sleep 20 && echo SLEEP_DONE . When it finishes, reply with the single word FINISHED.",
    steer: `Change of plan: stop waiting and reply with exactly the word STEERED-${label} and nothing else.`,
  },
  multi: {
    first: "In ONE assistant message, issue these three Bash tool calls together (do not wait between them): 1) sleep 8 && touch one.txt  2) touch two.txt  3) touch three.txt . After all three finish, reply ALL-DONE.",
    steer: `[notification] Background job ${label} finished. No action needed; just mention NOTED-${label} in your final reply.`,
  },
};
const P = PROMPTS[scenario];

const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("CODER_")) delete env[k];

const child = spawn("claude", [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--model", "haiku", "--permission-mode", "bypassPermissions",
  "--strict-mcp-config", "--safe-mode", "--no-session-persistence",
], { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });

function send(text, priority, tag) {
  const msg = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "", uuid: crypto.randomUUID() };
  if (priority && priority !== "none") msg.priority = priority;
  child.stdin.write(JSON.stringify(msg) + "\n");
  raw.write(JSON.stringify({ t: +t(), dir: "in", line: msg }) + "\n");
  console.log(`+${t()}s IN  ${tag} uuid=${msg.uuid.slice(0, 8)} priority=${msg.priority ?? "(none)"}`);
  return msg.uuid;
}

function summarize(o) {
  const s = [o.type + (o.subtype ? "/" + o.subtype : "")];
  if (o.type === "system" && o.subtype === "init") s.push(`session=${o.session_id} model=${o.model} cwd=${o.cwd}`);
  if (o.type === "assistant") for (const b of o.message?.content ?? []) {
    if (b.type === "text") s.push(`text=${JSON.stringify(b.text.slice(0, 100))}`);
    if (b.type === "tool_use") s.push(`tool_use ${b.name} id=${b.id.slice(-6)} ${JSON.stringify(b.input?.command ?? b.input).slice(0, 80)}`);
  }
  if (o.type === "user") for (const b of Array.isArray(o.message?.content) ? o.message.content : [])
    if (b.type === "tool_result") s.push(`tool_result id=${b.tool_use_id.slice(-6)} is_error=${!!b.is_error} ${JSON.stringify(typeof b.content === "string" ? b.content : b.content).slice(0, 160)}`);
  if (o.type === "result") s.push(`is_error=${o.is_error} terminal_reason=${o.terminal_reason} num_turns=${o.num_turns} queued_turn_count=${o.queued_turn_count} user_message_uuids=${(o.user_message_uuids ?? []).map((u) => u.slice(0, 8))} result=${JSON.stringify((o.result ?? "").slice(0, 80))} cost=${o.total_cost_usd}`);
  if (o.type === "command_lifecycle") s.push(`cmd=${o.command_uuid?.slice(0, 8)} state=${o.state}`);
  if (o.type === "rate_limit_event") s.push(JSON.stringify(o.rate_limit_info));
  if (o.type === "control_response") s.push(JSON.stringify(o.response));
  if (o.type === "system" && /^task_/.test(o.subtype)) s.push(`task=${o.task_id} status=${o.status ?? ""} is_backgrounded=${o.is_backgrounded ?? ""}`);
  if (!["system", "assistant", "user", "result", "command_lifecycle", "rate_limit_event", "control_response"].includes(o.type)) s.push(Object.keys(o).join(","));
  return s.join(" | ");
}

let buf = "", steerAt = null, steerSent = false, firstAfterSteer = null, ackAt = null, probeSent = false, probeDone = false, idle = null, results = 0;
const ackRe = new RegExp(scenario === "sleep" ? "STEERED" : "NOTED");
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    raw.write(JSON.stringify({ t: +t(), dir: "out", line: JSON.parse(line) }) + "\n");
    const o = JSON.parse(line);
    console.log(`+${t()}s OUT ${summarize(o)}`);
    if (steerAt && !firstAfterSteer && o.type === "assistant") firstAfterSteer = +t();
    if (steerAt && !ackAt && o.type === "assistant" && JSON.stringify(o.message.content).match(ackRe)) ackAt = +t();
    // Steer 3s after the first Bash tool_use appears (tool is running / queued by then).
    if (!steerSent && o.type === "assistant" && o.message.content.some((b) => b.type === "tool_use" && b.name === "Bash")) {
      steerSent = true;
      const toolId = o.message.content.find((b) => b.type === "tool_use").id;
      setTimeout(() => {
        steerAt = +t(); send(P.steer, prio, "STEER");
        if (bg === "bg") {
          const req = { type: "control_request", request_id: "bg-1", request: { subtype: "background_tasks", tool_use_id: toolId } };
          child.stdin.write(JSON.stringify(req) + "\n");
          raw.write(JSON.stringify({ t: +t(), dir: "in", line: req }) + "\n");
          console.log(`+${t()}s IN  CONTROL background_tasks tool_use_id=...${toolId.slice(-6)}`);
        }
      }, 3000);
    }
    if (o.type === "result") {
      results++;
      if (probeSent) probeDone = true;
    }
    // After 6s of silence following a result: probe usability once, then close stdin.
    clearTimeout(idle);
    if (results > 0) idle = setTimeout(() => {
      if (!probeSent) { probeSent = true; send("Reply with exactly PROBE-OK.", "none", "PROBE"); }
      else if (probeDone) child.stdin.end();
    }, 6000);
  }
});
child.stderr.on("data", (c) => process.stderr.write(`+${t()}s ERR ${c}`));
const hard = setTimeout(() => { console.log(`+${t()}s HARD TIMEOUT, killing`); child.kill(); }, 150000);
child.on("close", (code) => {
  clearTimeout(hard); clearTimeout(idle);
  console.log(`+${t()}s EXIT code=${code}`);
  console.log(`SUMMARY label=${label} priority=${prio} scenario=${scenario} steerAt=${steerAt} firstAssistantAfterSteer=${firstAfterSteer} (+${firstAfterSteer && (firstAfterSteer - steerAt).toFixed(2)}s) ackAt=${ackAt} (+${ackAt && (ackAt - steerAt).toFixed(2)}s) results=${results}`);
  if (scenario === "multi") console.log("files:", ["one.txt", "two.txt", "three.txt"].filter((f) => fs.existsSync(f)).join(",") || "(none)");
});
send(P.first, "none", "FIRST");
```

#### Solenta code touched by these findings
- **`claude.js` `sendUser`** writes `{type:"user", message:{role:"user", content}, parent_tool_use_id:null, session_id:""}`, with no `priority` and **no `uuid**`. `handleLine` sets `gotResult` on any `type==="result"` and, in non-keepAlive interactive mode, calls `child.stdin.end()` — [electron/claude.js L180-L239](file://electron/claude.js)
- **`runner.js` Claude event handling** branches only on `system/init`, `assistant`, `user`, and `result`.
  - On `result` it sums `costDelta = Number(ev.total_cost_usd)` into the store and `recordSpend`, and treats `ev.subtype === "success"` as ok.
  - Its phantom-result heuristic (`isPhantomClaudeResult`) treats an empty `success` result with no streamed content as a leftover. A comment says to "switch to a per-turn correlation id if the CLI protocol ever grows one".
  - Interactive Claude sessions are spawned `keepAlive: true` and reused across turns.
  - Source: [electron/runner.js L309-L318, L4469-L4584, L4624, L4669, L4914](file://electron/runner.js)

### Inferences
- **Do not expect `priority:"now"` to fix slow steers behind long Bash calls on 2.1.283 `-p`.** Measured end-to-end latency was the same about 19 s for none/next/now, because an `"interrupt"` abort leaves the shell running and the turn only stops at the tool-batch boundary. T3 PR #12541's 35.2 s → 2.1 s was probably measured in a different situation: a multi-round tool loop, mid-stream text, a subagent, or a newer or flagged CLI build. (This is an inference; the T3 setup was not reproduced.)
- **What `now` actually buys:**
  1. It drops any not-yet-started tool calls, plus the model's continuation after the current round.
  2. It splits the run into two `result`s.

  So `"now"` is right for a user's "stop, change course" message. It is wrong for informational/agent notifications, which should use `"next"` or no priority (which is the same thing). This confirms T3 #15351's proposal on our machine.
- **A truly immediate steer behind a long Bash or subagent needs both `priority:"now"` and `control_request{subtype:"background_tasks", tool_use_id}`.**
  - The control request is only effective once the shell has registered as a task, about 2 s into the run (the `u3t=2000` threshold; `task_started` is the signal). Solenta should send it after `task_started` for that `tool_use_id`, or retry when the reply is `backgrounded:false`.
  - This combination is **untested end-to-end** because the budget was exhausted (see Gaps).
- **If Solenta adds `priority:"now"`, `runner.js` must treat a `result` with `terminal_reason` in {`aborted_tools`,`aborted_streaming`} as "turn superseded, keep the run open".**
  - That result is `subtype:"success"`, `is_error:false`, `result:""`, so today it would finalize the run as a success with no text.
  - It would not be caught as a phantom, because tool content was already streamed (`sawTurnContent`).
  - In non-keepAlive mode, `claude.js` would also end stdin on it.
- **Solenta should stamp a `uuid` on every stdin user message.** Then it can bind results with `result.user_message_uuids`/`user_message_uuid` and track queue fate with `command_lifecycle` (`queued/started/completed/cancelled`). That is the "per-turn correlation id" the phantom-detection comment asks for. It also tells a host whether a folded-in steer was consumed (the `user_message_uuids` of a single result can contain both the original and the steer, as in s1, s2, and s5).
- **Likely cost over-count in Solenta (side finding).** Because `total_cost_usd` is cumulative per process and Solenta reuses keepAlive Claude processes across turns, summing it per `result` (runner.js L4624) probably over-counts spend: turn N adds the running total of turns 1..N. A `now` steer adds one more cumulative result per steer. The fix is to diff against the previous result's `total_cost_usd` in the same process. (This was inferred from code plus measured cumulative values; I did not inspect the store totals.)
- **Do not use `queued_turn_count` to decide "more results coming"** after a `now` abort; it was 0. Use the steer uuid's `command_lifecycle` `started` frame, or the `aborted_*` terminal reason.

### Gaps
- **`aborted_streaming`** (a `now` arriving while the model is streaming text, with no tool running) was not measured. The bundle lists it, and T3 handles it, but I never triggered it.
- **`now` + `background_tasks` sent *after* `task_started`** was not run because the 8-session budget was used. The one attempt (s8) raced registration by 0.44 s and returned `backgrounded:false`. This is the most valuable follow-up experiment: one session, sending the control request on `task_started`.
- **Subagent (Agent/Task tool) steering** was not tested. The bundle's agent path has a separate `interrupt` branch (`if(!(q&&b==="interrupt"))throw new je` — [claude.exe@190176595](file:///Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe)), so behavior may differ from Bash.
- **Possible effect of `--safe-mode`.** All runs used `--safe-mode`, which disables hooks, plugins, and CLAUDE.md, to keep them cheap and isolated. I found no code that ties priority handling to it, but I did not run a control without it.
- **CLI version gap.** T3 #15351 measured on 2.1.288, and this machine has 2.1.283. Newer builds may change the shell-abort rule.
- **`priority:"later"`** was not exercised.

## 2. `rate_limit_event`: fields, and whether Solenta sees it

### Takeaway
The CLI emits `{"type":"rate_limit_event","rate_limit_info":{…},"uuid","session_id"}` on stdout "when rate limit info changes". In practice that was after 1–2 of the API responses per session here. It carries:
- `status` (`allowed|allowed_warning|rejected`), `resetsAt` (epoch seconds), and `rateLimitType` (`five_hour|seven_day|seven_day_opus|seven_day_sonnet|seven_day_overage_included|overage`).
- `utilization`, and overage fields.
- An @internal `unifiedWindows` object with per-window `{utilization, resetsAt}` for `five_hour`, `seven_day`, and `seven_day_overage_included`.

Solenta receives these lines but **ignores them**. `claude.js` forwards every parsed object to `onEvent`, and `runner.js` has no `rate_limit_event` branch. `quotaWait.js` instead regex-parses reset clocks out of error text.

### Cited Findings
- **Schema:**
  ```
  iK = {type:"rate_limit_event", rate_limit_info:k$r(), uuid, session_id}
     .describe("Rate limit event emitted when rate limit info changes.")
  k$r = {
    status: enum["allowed","allowed_warning","rejected"],
    resetsAt?: int,
    rateLimitType?: enum["five_hour","seven_day","seven_day_opus","seven_day_sonnet","seven_day_overage_included","overage"],
    utilization?: number,
    unifiedWindows?: {
      five_hour?: {utilization, resetsAt},
      seven_day?: {utilization, resetsAt},
      seven_day_overage_included?: {utilization, resetsAt}
    },
    overageStatus?: enum["allowed","allowed_warning","rejected"],
    overageResetsAt?: int,
    overageDisabledReason?: enum[overage_not_provisioned, org_level_disabled, org_level_disabled_until, out_of_credits, …, unknown],
    isUsingOverage?: bool,
    overageInUse?: bool,
    surpassedThreshold?: number,
    rateLimitGraceActive?: bool,
    …
  }
  ```
  — [claude.exe@177497581 (iK), @177468614 (k$r)](file:///Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe)
- **`unifiedWindows` doc** (@internal):
  - Windows are "read from the anthropic-ratelimit-unified-* response headers".
  - "utilization is the fraction of the window used (usually 0-1…values above 1 occur when usage legitimately runs past a window's cap)".
  - "resetsAt is unix epoch seconds".
  - "events are emitted when a window's rounded percentage or reset time moves, not only on status transitions".
  - The windows are "always absent for API-key, Bedrock, and Vertex sessions".
  - Source: [claude.exe@177468614](file:///Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe)
- **Observed frame** (s1, +5.17 s, right after the first assistant response): `{"status":"allowed","resetsAt":1791120000,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.51,"resetsAt":1791120000},"seven_day":{"utilization":0.5,"resetsAt":1791349200}}}`.
  - `1791120000` = 2026-10-04T13:20:00Z and `1791349200` = 2026-10-07T05:00:00Z.
  - Across runs, five-hour utilization rose 0.51 → 0.57.
  - Per-session event counts were 2, 1, 1, 2, 2, 1 (s1, s2, s3, s4, s5, s8), against 3–4 API responses each.
  - Sources: [s1 log](file:///tmp/cli-exp/s1-none/s1-none.log), [s8 log](file:///tmp/cli-exp/s8-now-bg/s8.log)
- **Solenta does not handle it.**
  - `LC_ALL=C grep -a -n -E 'rate_limit|terminal_reason|priority|aborted_' electron/claude.js electron/runner.js electron/quotaWait.js` returns **no matches**.
  - `runner.js`'s Claude `onEvent` branches are `system/init` (L4469), `assistant` (L4484), `user` (L4522), and `result` (L4584).
  - `claude.js` `handleLine` passes every JSON object to `onEvent` (L180-L210).
  - Sources: [electron/runner.js](file://electron/runner.js), [electron/claude.js](file://electron/claude.js)
- **`quotaWait.js` works from error text:** "parse a reset clock from a provider error", using `QUOTA_RE = /usage[_\s-]?limit|hit your … limit|rate[_ ]?limit|\b429\b|…/i` — [electron/quotaWait.js L1-L35](file://electron/quotaWait.js)
- **`providerUsage.js` reads Claude quota out-of-band:** "Claude / Kimi: `readClaudeUsage` / `readKimiUsage` from ./providerUsageManaged.js". Codex uses `account/rateLimits/read` — [electron/providerUsage.js L1-L18](file://electron/providerUsage.js)
- **Codex has a push equivalent:** the app-server's `ServerNotification` includes `account/rateLimits/updated` — [generated schema /tmp/cli-exp/codex-schema/ServerNotification.json](file:///tmp/cli-exp/codex-schema/ServerNotification.json)

### Inferences
- `rate_limit_event` is a free, live quota feed inside every Claude run. Solenta could update its usage meter from `unifiedWindows` without polling. It could also pre-empt a quota wait when `status` turns `allowed_warning` or `rejected`, using the exact `resetsAt` instead of parsing reset clocks from error strings.
- `unifiedWindows` is marked @internal, so it can change without notice. The top-level `status`, `resetsAt`, `rateLimitType`, and `utilization` are the documented surface.

### Gaps
- I did not observe `allowed_warning` or `rejected` (the account was at 51–57% of its five-hour window). Whether a `rejected` event precedes the error `result` was not tested.

## 3. `claude --resume <id> --fork-session`, including a different cwd

### Takeaway
It works, including from a different cwd.
- Forking a session created in `/tmp/cli-exp/forkA` while running in `/tmp/cli-exp/forkB` produced a **new session id** that remembered the fact from session 1.
- The fork's transcript was written under forkB's project directory, with `sessionId` and `cwd` rewritten to the fork's values.
- The original transcript was not modified.

### Cited Findings
- **Session 1:** `cd /tmp/cli-exp/forkA && claude -p --model haiku --strict-mcp-config --safe-mode --output-format json "Remember this codeword: PLUM-7731. Reply only OK."` → `session_id: 0f479de6-5441-4578-a80c-b898d90e2df9`, `result: "OK"`, `terminal_reason: completed`, cost $0.0081 — [/tmp/cli-exp/fork-s1.json](file:///tmp/cli-exp/fork-s1.json)
- **Fork from another cwd:** `cd /tmp/cli-exp/forkB && claude -p --model haiku --strict-mcp-config --safe-mode --output-format json --resume 0f479de6-… --fork-session "What codeword did I give you earlier? Reply with just the codeword."` → exit 0 in about 2 s, **`session_id: e85e5b37-5405-4c5b-9add-771cdc87f886`** (new), **`result: "PLUM-7731"`**, `num_turns: 1`, cost $0.0108 — [/tmp/cli-exp/fork-s2.json](file:///tmp/cli-exp/fork-s2.json)
- **Transcript files:**

  | file | lines | `sessionId` values | `cwd` values | "What codeword" occurrences |
  |---|---|---|---|---|
  | `~/.claude/projects/-private-tmp-cli-exp-forkA/0f479de6-….jsonl` | 23 | only `0f479de6-…` | only `/private/tmp/cli-exp/forkA` | 0 (original untouched) |
  | `~/.claude/projects/-private-tmp-cli-exp-forkB/e85e5b37-….jsonl` | 29 | only `e85e5b37-…` | only `/private/tmp/cli-exp/forkB` | 2 |

  The copied history is restamped with the fork's id and cwd. I found no explicit `forkedFrom` key; the only key matching fork/origin/resume was `turnOrigin:"sdk"`. Source: local inspection via a node script over the two files listed.
- **Help text:** `--fork-session  When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)` — `claude --help` (2.1.283)
- **Solenta does not use it yet:** no `fork-session`/`forkSession` in `electron/claude.js`, `runner.js`, or `providers.js` (grep, 2026-10-04) — [electron/](file://electron/)

### Inferences
- A Solenta thread fork into a new worktree can use `--resume <parentSessionId> --fork-session` from the worktree's cwd and inherit full native context. It does not need a digest of the parent's last messages.
- Since `cwd` is restamped in the fork, tools in the fork run against the worktree. Old tool outputs in history still mention the parent's paths.

### Gaps
- I did not test a plain `--resume` (without fork) from a different cwd.
- I did not test forking a session that is still running in another process. Here, session 1 had already exited.

## 4. Codex: version, `thread/fork`, `turn/steer`, default MCP tool-call timeout

### Takeaway
`codex-cli 0.159.2`'s app-server (stable, not `--experimental`) exposes:
- **`thread/fork`** (`threadId` required; optional `lastTurnId` to fork through an earlier turn; `cwd`, `model`, `sandbox`, `approvalPolicy`, `ephemeral`, `excludeTurns`, …).
- **`turn/steer`** (`threadId`, `expectedTurnId`, `input`, optional `clientUserMessageId`; it returns `{turnId}`).
- `turn/interrupt` (`threadId`, `turnId`).

The default MCP **tool-call timeout is 300 s** (`DEFAULT_TOOL_TIMEOUT`), and the default startup timeout is 30 s. Both can be overridden per server with `tool_timeout_sec` / `startup_timeout_sec`. Solenta sets neither for its MCP servers.

### Cited Findings
- **`codex app-server --help`** lists the subcommands `daemon`, `proxy`, `generate-ts`, and `generate-json-schema` ("[experimental] Generate JSON Schema for the app server protocol") and `--listen stdio://|unix://|ws://`. Generated with `codex app-server generate-json-schema --out /tmp/cli-exp/codex-schema`, which produced 39 entries — [/tmp/cli-exp/codex-schema](file:///tmp/cli-exp/codex-schema)
- **ClientRequest methods matching thread/turn (104 methods in total):**
  - Thread lifecycle: `thread/start thread/resume thread/fork thread/archive thread/delete thread/unsubscribe thread/unarchive`
  - Thread metadata and goals: `thread/name/set thread/goal/set thread/goal/get thread/goal/clear thread/metadata/update`
  - Attachments and sections: `thread/attachment/add thread/attachment/list thread/attachment/remove thread/section/move`
  - Thread operations: `thread/compact/start thread/shellCommand thread/approveGuardianDeniedAction thread/revert`
  - Reading: `thread/list thread/loaded/list thread/read thread/turns/list thread/items/list thread/inject_items`
  - Turns: `turn/start turn/steer turn/interrupt`
  - Source: [ClientRequest.json](file:///tmp/cli-exp/codex-schema/ClientRequest.json)
- **`v2/ThreadForkParams.json`:**
  - `required: ["threadId"]`.
  - `lastTurnId`: "Optional last turn id to fork through, inclusive… The referenced turn cannot be in progress."
  - `excludeTurns`: "return only thread metadata and live fork state without populating `thread.turns`".
  - Other optional fields: `cwd`, `model`, `modelProvider`, `sandbox`, `approvalPolicy`, `approvalsReviewer`, `baseInstructions`, `developerInstructions`, `config`, `ephemeral`, `serviceTier`, `threadSource`.
  - The response includes `thread`, `cwd`, `model`, `sandbox`, `approvalPolicy`, and `instructionSources`.
  - Source: [v2/ThreadForkParams.json](file:///tmp/cli-exp/codex-schema/v2/ThreadForkParams.json)
- **`v2/TurnSteerParams.json`:** `required: ["expectedTurnId","input","threadId"]`. `expectedTurnId` is a "Required active turn id precondition. The request fails when it does not match the currently active turn." There is also an optional `clientUserMessageId`. `TurnSteerResponse` is `{turnId}`. `TurnInterruptParams` requires `["threadId","turnId"]` — [v2/TurnSteerParams.json](file:///tmp/cli-exp/codex-schema/v2/TurnSteerParams.json)
- **Default MCP timeouts at tag `rust-v0.159.2`** (commit `8b9fa496bbf2c47aebd62e85a080b9a522a455b5`):
  - `pub(crate) const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);`
  - `pub(crate) const DEFAULT_TOOL_TIMEOUT: Duration = Duration::from_secs(300);`
  - Sources: [codex-rs/codex-mcp/src/rmcp_client.rs L105-L106](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/codex-mcp/src/rmcp_client.rs#L105). Per server: `configured_config.tool_timeout_sec.unwrap_or(DEFAULT_TOOL_TIMEOUT)` — [codex-rs/codex-mcp/src/connection_manager.rs L357-L364](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/codex-mcp/src/connection_manager.rs#L357)
- **The binary confirms the knobs.** The installed codex binary contains the config keys `startup_timeout_sec`, `startup_timeout_ms`, and `tool_timeout_sec`, and the error text "timed out awaiting tools/call after" — [codex binary](file:///Users/willem/.codex/packages/standalone/releases/0.159.2-aarch64-apple-darwin/bin/codex)
- **Solenta's usage:**
  - Solenta's Codex MCP argv builder (`getCodexMcpArgs`) sets `mcp_servers.<name>.command/args/env_vars/url/bearer_token_env_var/default_tools_approval_mode`, but **no `tool_timeout_sec`**. Grep for `tool_timeout_sec|startup_timeout` in `electron/*.js` returned nothing — [electron/memory-sup.js L410-L460](file://electron/memory-sup.js)
  - The user's `~/.codex/config.toml` sets `startup_timeout_sec = 120` only for `mcp_servers.node_repl` (read-only check, L226-L229).
  - Solenta's `codex-appserver.js` uses `thread/start`, `thread/resume`, `turn/steer`, and `turn/interrupt`, but not `thread/fork` — [electron/codex-appserver.js L429, L491, L550, L600](file://electron/codex-appserver.js)
- **No Codex model turn was run.** Answering #4 did not need one.

### Inferences
- Any Solenta MCP tool that blocks longer than 300 s inside a Codex turn (for example a long `thread_wait`-style or `ask_user`-style call) will be cut off by Codex with "timed out awaiting tools/call after …". Solenta should either:
  - pass `-c mcp_servers.<name>.tool_timeout_sec=<N>` for its own servers, or
  - keep blocking calls under about 5 minutes and return a "still waiting, call again" result.
- **The Claude side differs.** The Claude bundle has `callMcpToolWithAutoBackground(... autoBackgroundMs ...)`, so Claude may background long MCP calls instead of timing them out — [claude.exe@209183520](file:///Users/willem/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe). I did not trace this further.
- `thread/fork` with `lastTurnId` gives Solenta a native "fork from turn N" for Codex threads, and `cwd` lets the fork point at a new worktree. This parallels Claude's `--resume --fork-session`, which forks only from the latest state.
- `turn/steer`'s optional `clientUserMessageId` is the Codex analogue of Claude's message `uuid`. Solenta could pass one so a steer that loses the race to turn completion can be re-dispatched idempotently.

### Gaps
- I did not live-test `thread/fork` or `turn/steer` against a running app-server, to stay within the "no Codex model turns" rule. The answers come from the generated schema and the tagged source.
- I did not check whether `tool_timeout_sec` can be set per tool, as opposed to per server; the source only showed it per server.
- I did not regenerate the schema with `--experimental`, so experimental-only methods are not listed.
