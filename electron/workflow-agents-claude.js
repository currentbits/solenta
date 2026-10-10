"use strict";

const { runClaude } = require("./claude.js");
const { withProjectEnv } = require("./worktreeEnv.js");
const { deployGrokGuardrailOverlay } = require("./grok.js");
const { grokGuardrailNotice } = require("./grok-guardrail-hook.js");
const {
  getProvider,
  resolveBin,
} = require("./providers.js");
const {
  getClaudeMcpArgs,
  mergeGrokSpawnEnv,
} = require("./memory-sup.js");
const {
  crossesBoundary,
  resolveWorkflowSpawn,
  realSessionId,
  claudeStreamSessionId,
} = require("./workflow-spawn.js");

/**
 * Spawn a claude-stream agent (claude, grok, ...). Resume is `--resume <id>`
 * when this slot already has a real session id.
 * @param {object} opts
 * @returns {{ handle: { kill: () => void }, done: Promise<object> }}
 */
function spawnAgentClaude(opts) {
  const {
    prompt,
    cwd,
    permissionMode,
    model,
    binary,
    onText,
    providerEntry,
    reasoningEffort,
    fast,
    sessionId,
  } = opts;

  let text = "";
  let resultText = "";
  let usage = null;
  let finished = false;
  /** @type {string | null} */
  let capturedSessionId = null;

  /** @type {(value: object) => void} */
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function finish(payload) {
    if (finished) return;
    finished = true;
    resolveDone({ ...payload, sessionId: capturedSessionId });
  }

  const entry = providerEntry || getProvider("claude");
  const resumeId = realSessionId(sessionId);
  const baseArgs = entry
    ? entry.buildArgs({
        prompt,
        sessionId: resumeId,
        permissionMode: permissionMode || "default",
        model: model || null,
        reasoningEffort: reasoningEffort || null,
        fast: fast === true,
      })
    : [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        String(permissionMode || "default"),
        String(prompt ?? ""),
      ];
  // Claude runs interactively (prompt over stdin, no trailing argv prompt),
  // so --mcp-config can simply be appended. Grok (and other claude-stream
  // providers) must not receive --mcp-config and keep the argv prompt.
  const interactive = Boolean(entry && entry.id === "claude");
  let args = baseArgs;
  if (interactive) {
    args = [...baseArgs, ...getClaudeMcpArgs({ projectPath: cwd, projectId: opts.projectId || opts.project?.id })];
  }

  let wrapEnv;
  if (entry && entry.id === "grok" && crossesBoundary(opts.project)) {
    const dest = deployGrokGuardrailOverlay({
      project: opts.project,
      threadId: opts.threadId,
      sessionId: resumeId,
    });
    wrapEnv = {
      GROK_HOME: dest,
      GROK_CLAUDE_MCPS_ENABLED: "false",
      GROK_CURSOR_MCPS_ENABLED: "false",
    };
  }
  const agentBin = binary || (entry ? resolveBin(entry) : null) ||
    process.env.CODER_CLAUDE_BIN || "claude";
  const spawn = entry && entry.id === "grok"
    ? resolveWorkflowSpawn(opts.project, agentBin, args, cwd, wrapEnv)
    : { binary: agentBin, args, cwd };
  const handle = runClaude({
    binary: spawn.binary,
    args: spawn.args,
    prompt,
    cwd: spawn.cwd,
    permissionMode: permissionMode || "default",
    sessionId: resumeId,
    model: model || null,
    interactive,
    envExtra: withProjectEnv(
      opts.project,
      entry && entry.id === "grok" ? mergeGrokSpawnEnv(wrapEnv) : undefined,
    ),
    onEvent: (ev) => {
      if (!ev || typeof ev !== "object") return;
      const sid = realSessionId(claudeStreamSessionId(ev));
      if (sid) capturedSessionId = sid;
      if (ev.type === "control_request") {
        // Workflow agents have no UI to answer prompts; auto-deny keeps the
        // pre-interactive headless behavior instead of hanging the agent.
        const rid = String(ev.request_id || "");
        if (!rid) return;
        if (ev.request && ev.request.subtype === "can_use_tool") {
          handle.respond(rid, {
            behavior: "deny",
            message: "Permission prompts are not supported for workflow agents",
          });
        } else {
          handle.respondError(rid, "unsupported control request");
        }
        return;
      }
      if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (entry && entry.id === "grok" && block && block.type === "tool_use" &&
              typeof opts.appendMessage === "function") {
            const notice = grokGuardrailNotice({
              toolName: block.name,
              input: block.input,
              worktreePath: (opts.project && opts.project.remotePath) || cwd,
            });
            if (notice) opts.appendMessage(opts.threadId, "event", notice, opts.runId || null);
          }
          if (block && block.type === "text" && typeof block.text === "string") {
            text += block.text;
            if (typeof onText === "function") onText(text);
          }
        }
      }
      if (ev.type === "result") {
        const u = ev.usage || {};
        usage = {
          inputTokens: Number(u.input_tokens) || 0,
          cachedInputTokens: Number(u.cache_read_input_tokens) || 0,
          cacheWriteTokens: Number(u.cache_creation_input_tokens) || 0,
          outputTokens: Number(u.output_tokens) || 0,
          costUsd: Number(ev.total_cost_usd) || 0,
        };
        if (typeof ev.result === "string" && ev.result) {
          resultText = ev.result;
        }
      }
    },
    onExit: ({ code, stderr }) => {
      const finalText = resultText || text;
      const ok = code === 0;
      finish({
        ok,
        text: finalText,
        usage,
        code,
        stderr: String(stderr || ""),
      });
    },
    onError: (err) => {
      const msg = err && err.message ? err.message : String(err);
      finish({
        ok: false,
        text: resultText || text,
        usage,
        code: 1,
        stderr: msg,
        error: err,
      });
    },
  });

  return { handle, done };
}

module.exports = { spawnAgentClaude };
