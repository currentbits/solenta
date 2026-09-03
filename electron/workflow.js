"use strict";

const { randomUUID } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { runClaude } = require("./claude.js");
const {
  runCodex,
  extractAgentMessageText,
  extractUsage,
  extractSessionId: codexExtractSessionId,
  extractCommandItem,
} = require("./codex.js");
const {
  runKimi,
  materializeKimiHome,
  deployKimiGuardrailOverlay,
  extractAssistantText: kimiExtractText,
  extractUsage: kimiExtractUsage,
  extractToolEvents: kimiExtractTools,
  extractSessionId: kimiExtractSessionId,
} = require("./kimi.js");
const {
  runCursor,
  extractAssistantText: cursorExtractText,
  extractUsage: cursorExtractUsage,
  extractToolEvents: cursorExtractTools,
  parseToolArgs: cursorParseToolArgs,
  extractSessionId: cursorExtractSessionId,
} = require("./cursor.js");
const {
  getProvider,
  resolveBin,
  isBinAvailable,
} = require("./providers.js");
const { planboardNoteFor, PLANBOARD_NOTE } = require("./services.js");
const { codexWorkspaceWriteArgs } = require("./codexWorkspaceWrite.js");
const {
  getClaudeMcpArgs,
  getCodexMcpArgs,
  getCodexMcpEnv,
  kimiMcpServersForRun,
  mergeGrokSpawnEnv,
  looksGrokConfigCorrupt,
  grokConfigCorruptMessage,
} = require("./memory-sup.js");
const { wslTarget } = require("./wsl.js");
const { wrapCommand } = require("./ssh.js");
const { guardrailsEnabled } = require("./guardrails.js");
const { insertBeforeLast, guardrailNotice } = require("./guardrail-hook-core.js");
const {
  materializeCursorPinPlugin,
  cursorPinPluginDir,
} = require("./cursorPinTaskParent.js");
const {
  materializeCursorGuardrailPlugin,
  cursorGuardrailPluginDir,
  deployCursorGuardrailPlugin,
} = require("./cursor-guardrail.js");
const {
  materializeCodexGuardrailHome,
  deployCodexGuardrailOverlay,
} = require("./codex-guardrail.js");
const {
  materializeOpencodeGuardrailDir,
  deployOpencodeGuardrailOverlay,
} = require("./opencode-guardrail.js");
const {
  runOpencode,
  extractTextPart: opencodeExtractText,
  extractSessionId: opencodeExtractSessionId,
  extractToolEvent: opencodeExtractTool,
} = require("./opencode.js");
const {
  runMuse,
  materializeMuseHome,
  museChildEnv,
  museRemoteChildEnv,
  deployMuseGuardrailOverlay,
  extractAssistantText: museExtractText,
  extractUsage: museExtractUsage,
  extractToolEvent: museExtractTool,
  extractSessionId: museExtractSessionId,
} = require("./muse.js");
const {
  museGuardrailHookCommand,
} = require("./muse-guardrail-hook.js");

const PUSH_THROTTLE_MS = 250;
const DOSSIER_INPUT_MAX = 800;
const DOSSIER_OUTPUT_MAX = 6000;

/**
 * Deterministic non-negative int seed from threadId + runId.
 * @param {string} threadId
 * @param {string} runId
 */
function hashSeed(threadId, runId) {
  const s = `${threadId}${runId}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) >>> 0;
}

/**
 * Capitalize first letter for work log labels.
 * @param {string} name
 */
function capitalize(name) {
  if (!name) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Same predicate runner.js uses. Duplicated here so workflow.js does not
 * require runner.js (circular: runner already loads this module).
 * @param {{ remoteHost?: string, path?: string } | null | undefined} project
 */
function crossesBoundary(project) {
  return Boolean(project && (project.remoteHost || wslTarget(project)));
}

/**
 * Wrap a phase spawn the way runner.resolveSpawn does, including
 * `env KEY=value` on the far side (#834 / #835 / #836 / #837).
 * @param {{ remoteHost?: string, remotePath?: string, path?: string } | null | undefined} project
 * @param {string} binary
 * @param {string[]} args
 * @param {string} localCwd
 * @param {Record<string, string> | null | undefined} [env]
 */
function resolveWorkflowSpawn(project, binary, args, localCwd, env) {
  if (!crossesBoundary(project)) {
    return { binary, args, cwd: localCwd };
  }
  const wrapped = wrapCommand(project, binary, args, undefined, env);
  return { binary: wrapped.bin, args: wrapped.args, cwd: process.cwd() };
}

/**
 * @param {object} opts
 * @param {string} toolName
 * @param {unknown} input
 */
function notePhaseGuardrail(opts, toolName, input) {
  if (typeof opts.appendMessage !== "function" || !opts.threadId) return;
  const project = opts.project;
  const worktreePath =
    opts.worktreePath ||
    (project && (project.remotePath || project.path)) ||
    opts.cwd;
  const notice = guardrailNotice(toolName, input, worktreePath);
  if (notice) {
    opts.appendMessage(opts.threadId, "event", notice, opts.runId || null);
  }
}

/**
 * Truncate a string to max chars.
 * @param {unknown} s
 * @param {number} max
 */
function truncate(s, max) {
  const str = String(s ?? "");
  return str.length <= max ? str : str.slice(0, max);
}

/**
 * Real CLI session id for a workflow agent slot. The leftover "cwd"
 * sentinel is not a session (issue #220). Empty / non-strings are not.
 * @param {unknown} id
 * @returns {string | null}
 */
function realSessionId(id) {
  return typeof id === "string" && id && id !== "cwd" ? id : null;
}

/**
 * Claude / Grok stream session id (system init, then result).
 * @param {object} ev
 * @returns {string | null}
 */
function claudeStreamSessionId(ev) {
  if (!ev || typeof ev !== "object") return null;
  if (typeof ev.session_id !== "string" || !ev.session_id) return null;
  if (ev.type === "system" && ev.subtype === "init") return ev.session_id;
  if (ev.type === "result") return ev.session_id;
  return null;
}

/**
 * Display model label for an agent in the workflow view.
 * @param {{ model?: string | null, provider: string }} phase
 */
function agentModelLabel(phase) {
  if (phase.model != null && phase.model !== "") {
    return String(phase.model);
  }
  const entry = getProvider(phase.provider);
  if (entry && Array.isArray(entry.models) && entry.models.length > 0) {
    return entry.models[0];
  }
  return "default";
}

/**
 * Build the initial WorkflowView from a resolved template.
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.name
 * @param {object} opts.template
 */
function buildWorkflowView({ runId, name, template }) {
  const phases = (template.phases || []).map((phase, phaseIndex) => {
    const count = Math.max(1, Math.min(4, Number(phase.agentCount) || 1));
    const model = agentModelLabel(phase);
    /** @type {object[]} */
    const agents = [];
    for (let i = 0; i < count; i++) {
      agents.push({
        id: `${phaseIndex}:${phase.name}:${i}`,
        model,
        status: "pending",
        tokensUsed: 0,
        // Per-slot CLI session. Must not be written to thread.sessionId
        // (a later interactive turn would resume it).
        sessionId: null,
      });
    }
    return {
      name: phase.name,
      pipelined: false,
      agents,
      // Internal: keep phase provider/model for spawn
      __provider: phase.provider,
      __model: phase.model != null && phase.model !== "" ? phase.model : null,
      __instruction: phase.instruction || "",
      __agentCount: count,
    };
  });
  return recomputeView({
    __orchestrated: true,
    id: runId,
    name,
    phases,
  });
}

/**
 * Recompute settled/total/tokensTotal/complete from agent statuses.
 * @param {object} view
 */
function recomputeView(view) {
  let settled = 0;
  let total = 0;
  let tokensTotal = 0;
  for (const phase of view.phases) {
    for (const agent of phase.agents) {
      total += 1;
      tokensTotal += Number(agent.tokensUsed) || 0;
      if (agent.status === "settled" || agent.status === "failed") {
        settled += 1;
      }
    }
  }
  view.settled = settled;
  view.total = total;
  view.tokensTotal = tokensTotal;
  view.complete =
    total > 0 &&
    settled === total &&
    view.phases.every((p) =>
      p.agents.every((a) => a.status === "settled"),
    );
  return view;
}

/**
 * Public WorkflowView strip (no internal flags).
 * @param {object} view
 */
function toPublicView(view) {
  if (!view) return null;
  recomputeView(view);
  return {
    id: view.id,
    name: view.name,
    phases: view.phases.map((phase) => ({
      name: phase.name,
      pipelined: Boolean(phase.pipelined),
      agents: phase.agents.map((agent) => ({
        id: agent.id,
        model: agent.model,
        status: agent.status,
        tokensUsed: agent.tokensUsed,
        sessionId: agent.sessionId || null,
      })),
    })),
    settled: view.settled,
    total: view.total,
    tokensTotal: view.tokensTotal,
    complete: view.complete,
  };
}

/**
 * @param {object} view
 * @param {string} agentId
 */
function findAgent(view, agentId) {
  for (const phase of view.phases) {
    for (const agent of phase.agents) {
      if (agent.id === agentId) return agent;
    }
  }
  return null;
}

/**
 * Parse `phaseIndex:phaseName:agentIndex` (phase names may contain ':').
 * @param {string} agentId
 * @returns {{ phaseIndex: number, phaseName: string, agentIndex: number } | null}
 */
function parseAgentId(agentId) {
  const str = String(agentId || "");
  const first = str.indexOf(":");
  const last = str.lastIndexOf(":");
  if (first < 0 || last <= first) return null;
  const phaseIndex = Number(str.slice(0, first));
  const agentIndex = Number(str.slice(last + 1));
  const phaseName = str.slice(first + 1, last);
  if (!Number.isInteger(phaseIndex) || !Number.isInteger(agentIndex)) {
    return null;
  }
  return { phaseIndex, phaseName, agentIndex };
}

/**
 * Prior-phase outputs for prompt chaining, from settled agent text.
 * @param {object} view
 * @param {number} beforePhaseIndex
 */
function collectPriorOutputs(view, beforePhaseIndex) {
  /** @type {{ phaseName: string, agentIndex: number, text: string }[]} */
  const out = [];
  for (let i = 0; i < beforePhaseIndex; i++) {
    const phase = view.phases[i];
    if (!phase) continue;
    phase.agents.forEach((agent, agentIndex) => {
      out.push({
        phaseName: phase.name,
        agentIndex,
        text: agent.status === "settled" ? String(agent.__text || "") : "",
      });
    });
  }
  return out;
}

/**
 * @param {object} phase
 */
function phaseSpecFromView(phase) {
  return {
    name: phase.name,
    provider: phase.__provider,
    model: phase.__model,
    instruction: phase.__instruction || "",
    agentCount: phase.__agentCount || phase.agents.length,
  };
}

/**
 * Build the per-agent prompt for a phase.
 * @param {object} opts
 * @param {string} opts.userPrompt
 * @param {string} opts.instruction
 * @param {number} opts.agentIndex - 0-based within phase
 * @param {number} opts.agentCount
 * @param {{ phaseName: string, agentIndex: number, text: string }[]} opts.priorOutputs
 */
function buildAgentPrompt(opts) {
  const {
    userPrompt,
    instruction,
    agentIndex,
    agentCount,
    priorOutputs = [],
  } = opts;

  const parts = [];
  parts.push(`Original task:\n${userPrompt}`);

  if (priorOutputs.length > 0) {
    const blocks = priorOutputs.map(
      (o) =>
        `--- ${o.phaseName} agent ${o.agentIndex + 1} ---\n${o.text || "(unavailable)"}`,
    );
    parts.push(`Previous phase outputs:\n${blocks.join("\n\n")}`);
  }

  parts.push(String(instruction || ""));

  if (agentCount > 1) {
    parts.push(
      `You are agent ${agentIndex + 1} of ${agentCount}; take a distinct angle from the other agents.`,
    );
  }

  return parts.join("\n\n");
}

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
    args = [...baseArgs, ...getClaudeMcpArgs({ projectPath: cwd })];
  }

  const handle = runClaude({
    binary:
      binary ||
      (entry ? resolveBin(entry) : null) ||
      process.env.CODER_CLAUDE_BIN ||
      "claude",
    args,
    prompt,
    cwd,
    permissionMode: permissionMode || "default",
    sessionId: resumeId,
    model: model || null,
    interactive,
    envExtra:
      entry && entry.id === "grok" ? mergeGrokSpawnEnv(undefined) : undefined,
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

/**
 * Spawn a Codex JSONL agent. Resume is `exec resume <id>` when this slot
 * already has a real session id (no `--sandbox` on resume, #795).
 * @param {object} opts
 * @returns {{ handle: { kill: () => void }, done: Promise<object> }}
 */
function spawnAgentCodex(opts) {
  const {
    prompt,
    cwd,
    model,
    binary,
    providerEntry,
    onText,
    reasoningEffort,
    webSearch,
    permissionMode,
    sessionId,
    userDataPath,
    threadId,
    skipOverlay,
    project,
  } = opts;

  let text = "";
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

  const entry = providerEntry || getProvider("codex");
  const args = entry.buildArgs({
    prompt,
    sessionId: realSessionId(sessionId),
    model: model || null,
    reasoningEffort: reasoningEffort || null,
    webSearch: webSearch === true,
    permissionMode: permissionMode || "default",
  });
  // Same as runner.js: -c must sit after `exec` / `exec resume`, or
  // resume drops MCP auto-approve and thread_send dies under never.
  const planboardNote = planboardNoteFor(cwd, {
    provider: "codex",
    permissionMode: permissionMode || "default",
  });
  const codexExecConfig = [
    ...codexWorkspaceWriteArgs({
      permissionMode: permissionMode || "default",
      allowNetwork: planboardNote === PLANBOARD_NOTE,
    }),
    ...getCodexMcpArgs({ projectPath: cwd }),
  ];
  if (codexExecConfig.length) insertBeforeLast(args, codexExecConfig);
  /** @type {Record<string, string>} */
  const envExtra = { ...getCodexMcpEnv() };
  /** @type {Record<string, string> | undefined} */
  let wrapEnv;
  if (userDataPath && threadId && !skipOverlay && guardrailsEnabled()) {
    try {
      const dest = path.join(userDataPath, "codex-homes", threadId);
      const sourceHome =
        process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
      materializeCodexGuardrailHome({ dest, sourceHome });
      insertBeforeLast(args, [
        "-c",
        "features.hooks=true",
        "--dangerously-bypass-hook-trust",
      ]);
      envExtra.CODEX_HOME = dest;
      envExtra.SOLENTA_WORKTREE = cwd;
    } catch {
      // best-effort
    }
  } else if (crossesBoundary(project) && guardrailsEnabled()) {
    try {
      const dest = deployCodexGuardrailOverlay({ project, threadId });
      if (dest) {
        insertBeforeLast(args, [
          "-c",
          "features.hooks=true",
          "--dangerously-bypass-hook-trust",
        ]);
        wrapEnv = {
          CODEX_HOME: dest,
          SOLENTA_WORKTREE: (project && project.remotePath) || cwd,
        };
        envExtra.CODEX_HOME = dest;
        envExtra.SOLENTA_WORKTREE = wrapEnv.SOLENTA_WORKTREE;
      }
    } catch {
      // Deploy miss must not kill the phase; stream notice remains.
    }
  }

  const codexBin = binary || resolveBin(entry);
  const spawn = resolveWorkflowSpawn(project, codexBin, args, cwd, wrapEnv);
  const handle = runCodex({
    binary: spawn.binary,
    args: spawn.args,
    cwd: spawn.cwd,
    envExtra,
    onEvent: (ev) => {
      if (!ev || typeof ev !== "object") return;
      const sid = realSessionId(codexExtractSessionId(ev));
      if (sid) capturedSessionId = sid;
      const agentText = extractAgentMessageText(ev);
      if (agentText != null) {
        const type = String(ev.type || "");
        const isDelta =
          (ev.msg &&
            typeof ev.msg === "object" &&
            /delta/i.test(String(ev.msg.type || ""))) ||
          /delta/i.test(type);
        if (isDelta) {
          text += agentText;
        } else if (
          type === "item.completed" ||
          type === "item_completed" ||
          (ev.item && ev.item.type === "agent_message")
        ) {
          text = agentText;
        } else if (!text) {
          text = agentText;
        } else if (!text.endsWith(agentText)) {
          text += agentText;
        }
        if (typeof onText === "function") onText(text);
      }
      const u = extractUsage(ev);
      if (u) {
        usage = {
          inputTokens: Number(u.inputTokens) || 0,
          outputTokens: Number(u.outputTokens) || 0,
          costUsd: 0,
        };
      }
      const cmd = extractCommandItem(ev);
      if (cmd && cmd.phase === "started") {
        notePhaseGuardrail(opts, "Bash", { command: cmd.command });
      }
    },
    onExit: ({ code, stderr }) => {
      finish({
        ok: code === 0,
        text,
        usage,
        code,
        stderr: String(stderr || ""),
      });
    },
    onError: (err) => {
      const msg = err && err.message ? err.message : String(err);
      finish({
        ok: false,
        text,
        usage,
        code: 1,
        stderr: msg,
        error: err,
      });
    },
  });

  return { handle, done };
}

/**
 * Spawn a Kimi stream-json agent. Resume is `-S <id>` when this slot
 * already has a real session id; never `-c` (issue #220 / #782).
 * @param {object} opts
 * @returns {{ handle: { kill: () => void }, done: Promise<object> }}
 */
function spawnAgentKimi(opts) {
  const {
    prompt,
    cwd,
    model,
    binary,
    providerEntry,
    onText,
    reasoningEffort,
    userDataPath,
    threadId,
    projectId,
    overlayKey,
    skipOverlay,
    project,
    sessionId,
  } = opts;

  let text = "";
  let usage = null;
  let finished = false;
  let fullStdout = "";
  let gotJson = false;
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

  const entry = providerEntry || getProvider("kimi");
  const args = entry.buildArgs({
    prompt,
    sessionId: realSessionId(sessionId),
    model: model || null,
    reasoningEffort: reasoningEffort || null,
  });

  // Same overlay runner uses for normal kimi turns (#671 / #699): isolated
  // KIMI_CODE_HOME so the phase cannot inherit foreign MCP, and so
  // flipKimiEffort writes a local config.toml. Nested under threadId so
  // parallel phase agents do not race one file and reclaim still keys off
  // the thread. Local only. ssh/WSL: deploy PreToolUse onto the far side
  // and pass KIMI_CODE_HOME through wrapCommand (#834 / #836).
  /** @type {NodeJS.ProcessEnv | undefined} */
  let kimiEnv;
  if (userDataPath && threadId && !skipOverlay) {
    try {
      const destName = overlayKey
        ? String(overlayKey).replace(/[^A-Za-z0-9._-]+/g, "-")
        : "";
      const dest = destName
        ? path.join(userDataPath, "kimi-homes", threadId, destName)
        : path.join(userDataPath, "kimi-homes", threadId);
      const sourceHome =
        process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
      materializeKimiHome({
        dest,
        sourceHome,
        cwd,
        mcpServers: kimiMcpServersForRun({
          projectId,
          projectPath: cwd,
        }),
      });
      kimiEnv = { KIMI_CODE_HOME: dest };
    } catch {
      // Overlay is best-effort; a failed isolate must not block the phase.
    }
  } else if (crossesBoundary(project) && guardrailsEnabled()) {
    try {
      const dest = deployKimiGuardrailOverlay({ project, threadId });
      if (dest) kimiEnv = { KIMI_CODE_HOME: dest };
    } catch {
      // Deploy miss must not kill the phase; stream notice remains.
    }
  }

  const kimiBin = binary || resolveBin(entry);
  const spawn = resolveWorkflowSpawn(project, kimiBin, args, cwd, kimiEnv);
  const handle = runKimi({
    binary: spawn.binary,
    args: spawn.args,
    cwd: spawn.cwd,
    env: kimiEnv,
    reasoningEffort: reasoningEffort || null,
    onEvent: (ev) => {
      gotJson = true;
      if (!ev || typeof ev !== "object") return;
      const sid = kimiExtractSessionId(ev);
      if (sid) capturedSessionId = sid;
      const chunk = kimiExtractText(ev);
      if (chunk != null) {
        text += chunk;
        if (typeof onText === "function") onText(text);
      }
      const u = kimiExtractUsage(ev);
      if (u) {
        usage = {
          inputTokens: Number(u.inputTokens) || 0,
          outputTokens: Number(u.outputTokens) || 0,
          costUsd: 0,
        };
      }
      for (const tool of kimiExtractTools(ev)) {
        if (tool.phase === "start") {
          notePhaseGuardrail(opts, tool.name, tool.input);
        }
      }
    },
    onExit: ({ code, stderr, fullStdout: stdout, gotJson: parsed }) => {
      fullStdout = stdout || "";
      gotJson = gotJson || parsed;
      let finalText = text;
      if (!gotJson && fullStdout) {
        finalText = fullStdout.replace(/\s+$/, "");
        if (typeof onText === "function") onText(finalText);
      }
      finish({
        ok: code === 0,
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
        text,
        usage,
        code: 1,
        stderr: msg,
        error: err,
      });
    },
  });

  return { handle, done };
}

/**
 * Spawn a Muse JSONL agent. Resume is `--session-id <id>` when this slot
 * already has a real session id; never `--last` (issue #873). Overlay
 * throw fails the phase (grok fail-closed, not kimi's best-effort catch).
 * @param {object} opts
 * @returns {{ handle: { kill: () => void }, done: Promise<object> }}
 */
function spawnAgentMuse(opts) {
  const {
    prompt,
    cwd,
    model,
    binary,
    providerEntry,
    onText,
    reasoningEffort,
    permissionMode,
    userDataPath,
    threadId,
    projectId,
    overlayKey,
    skipOverlay,
    project,
    sessionId,
  } = opts;

  let text = "";
  let usage = null;
  let finished = false;
  let fullStdout = "";
  let gotJson = false;
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

  const entry = providerEntry || getProvider("muse");
  const args = entry.buildArgs({
    prompt,
    sessionId: realSessionId(sessionId),
    model: model || null,
    reasoningEffort: reasoningEffort || null,
    permissionMode: permissionMode || "default",
  });

  // Isolated XDG overlay so parallel phases do not share one settings.json.
  // Nested under threadId/overlayKey. Fail-closed: a throw fails the phase.
  /** @type {NodeJS.ProcessEnv | undefined} */
  let museEnv;
  if (crossesBoundary(project)) {
    try {
      const dest = deployMuseGuardrailOverlay({ project, threadId });
      if (!dest) throw new Error("Muse remote overlay failed");
      museEnv = {
        ...museRemoteChildEnv(dest),
        SOLENTA_WORKTREE: (project && project.remotePath) || cwd,
      };
    } catch (err) {
      const msg =
        "Muse remote overlay failed: " +
        (err && err.message ? err.message : String(err));
      finish({
        ok: false,
        text: "",
        usage: null,
        code: 1,
        stderr: msg,
        error: err,
      });
      return { handle: { kill() {} }, done };
    }
  } else if (userDataPath && threadId && !skipOverlay) {
    try {
      const destName = overlayKey
        ? String(overlayKey).replace(/[^A-Za-z0-9._-]+/g, "-")
        : "";
      const dest = destName
        ? path.join(userDataPath, "muse-homes", threadId, destName)
        : path.join(userDataPath, "muse-homes", threadId);
      const xdgConfig =
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
      const xdgData =
        process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
      materializeMuseHome({
        dest,
        sourceConfigDir: path.join(xdgConfig, "muse"),
        sourceDataDir: path.join(xdgData, "muse"),
        mcpServers: kimiMcpServersForRun({
          projectId,
          projectPath: cwd,
        }),
        hookCommand: museGuardrailHookCommand({
          hookPath: path.join(dest, "muse-guardrail-hook.js"),
        }),
      });
      museEnv = {
        ...museChildEnv(dest),
        SOLENTA_WORKTREE: cwd,
      };
    } catch (err) {
      const msg =
        "Muse MCP overlay failed: " +
        (err && err.message ? err.message : String(err));
      finish({
        ok: false,
        text: "",
        usage: null,
        code: 1,
        stderr: msg,
        error: err,
      });
      return { handle: { kill() {} }, done };
    }
  }

  const museBin = binary || resolveBin(entry);
  const spawn = resolveWorkflowSpawn(project, museBin, args, cwd, museEnv);
  const handle = runMuse({
    binary: spawn.binary,
    args: spawn.args,
    cwd: spawn.cwd,
    env: museEnv,
    onEvent: (ev) => {
      gotJson = true;
      if (!ev || typeof ev !== "object") return;
      const sid = museExtractSessionId(ev);
      if (sid) capturedSessionId = sid;
      const chunk = museExtractText(ev);
      if (chunk != null) {
        // Echo delta and terminal carry the same full payload.text.
        // Terminal is a snapshot: replace, or skip if already equal.
        if (ev.payload_type === "run.terminal.completed") {
          if (chunk !== text) {
            text = chunk;
            if (typeof onText === "function") onText(text);
          }
        } else {
          text += chunk;
          if (typeof onText === "function") onText(text);
        }
      }
      const u = museExtractUsage(ev);
      if (u) {
        usage = {
          inputTokens: Number(u.inputTokens) || 0,
          outputTokens: Number(u.outputTokens) || 0,
          costUsd: Number(u.costUsd) || 0,
        };
      }
      const tool = museExtractTool(ev);
      if (tool && tool.phase === "start") {
        notePhaseGuardrail(opts, tool.name, tool.input);
      }
    },
    onExit: ({ code, stderr, fullStdout: stdout, gotJson: parsed }) => {
      fullStdout = stdout || "";
      gotJson = gotJson || parsed;
      let finalText = text;
      if (!gotJson && fullStdout) {
        finalText = fullStdout.replace(/\s+$/, "");
        if (typeof onText === "function") onText(finalText);
      }
      finish({
        ok: code === 0,
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
        text,
        usage,
        code: 1,
        stderr: msg,
        error: err,
      });
    },
  });

  return { handle, done };
}

/**
 * Spawn a Cursor stream-json agent. Resume is `--resume <id>` when this
 * slot already has a real session id.
 * @param {object} opts
 * @returns {{ handle: { kill: () => void }, done: Promise<object> }}
 */
function spawnAgentCursor(opts) {
  const {
    prompt,
    cwd,
    model,
    binary,
    providerEntry,
    onText,
    reasoningEffort,
    permissionMode,
    sessionId,
    userDataPath,
    skipOverlay,
    project,
    threadId,
  } = opts;

  let text = "";
  let usage = null;
  let finished = false;
  let fullStdout = "";
  let gotJson = false;
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

  const entry = providerEntry || getProvider("cursor");
  const args = entry.buildArgs({
    prompt,
    sessionId: realSessionId(sessionId),
    model: model || null,
    reasoningEffort: reasoningEffort || null,
    permissionMode: permissionMode || "default",
  });

  /** @type {Record<string, string> | undefined} */
  let cursorWrapEnv;
  if (!skipOverlay && args.length > 0) {
    try {
      const pluginDirs = [
        materializeCursorPinPlugin(cursorPinPluginDir(userDataPath)),
      ];
      if (guardrailsEnabled()) {
        pluginDirs.push(
          materializeCursorGuardrailPlugin(
            cursorGuardrailPluginDir(userDataPath),
          ),
        );
      }
      const extras = [];
      for (const dir of pluginDirs) {
        extras.push("--plugin-dir", dir);
      }
      insertBeforeLast(args, extras);
    } catch {
      // best-effort
    }
  } else if (
    crossesBoundary(project) &&
    args.length > 0 &&
    guardrailsEnabled()
  ) {
    try {
      const dest = deployCursorGuardrailPlugin({ project, threadId });
      if (dest) {
        insertBeforeLast(args, ["--plugin-dir", dest]);
        cursorWrapEnv = {
          SOLENTA_WORKTREE: (project && project.remotePath) || cwd,
        };
      }
    } catch {
      // Deploy miss must not kill the phase; stream notice remains.
    }
  }

  const cursorBin = binary || resolveBin(entry);
  const spawn = resolveWorkflowSpawn(
    project,
    cursorBin,
    args,
    cwd,
    cursorWrapEnv,
  );
  const handle = runCursor({
    binary: spawn.binary,
    args: spawn.args,
    cwd: spawn.cwd,
    onEvent: (ev) => {
      gotJson = true;
      if (!ev || typeof ev !== "object") return;
      const sid = realSessionId(cursorExtractSessionId(ev));
      if (sid) capturedSessionId = sid;
      const chunk = cursorExtractText(ev);
      if (chunk != null) {
        if (ev.timestamp_ms != null) {
          text += chunk;
          if (typeof onText === "function") onText(text);
        } else if (!text) {
          text = chunk;
          if (typeof onText === "function") onText(text);
        }
      }
      const u = cursorExtractUsage(ev);
      if (u) {
        usage = {
          inputTokens: Number(u.inputTokens) || 0,
          outputTokens: Number(u.outputTokens) || 0,
          costUsd: 0,
        };
      }
      for (const tool of cursorExtractTools(ev)) {
        if (tool.phase === "start") {
          const parsed = cursorParseToolArgs(tool.input);
          notePhaseGuardrail(opts, tool.name, parsed || tool.input);
        }
      }
    },
    onExit: ({ code, stderr, fullStdout: stdout, gotJson: parsed }) => {
      fullStdout = stdout || "";
      gotJson = gotJson || parsed;
      let finalText = text;
      if (!gotJson && fullStdout) {
        finalText = fullStdout.replace(/\s+$/, "");
        if (typeof onText === "function") onText(finalText);
      }
      finish({
        ok: code === 0,
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
        text,
        usage,
        code: 1,
        stderr: msg,
        error: err,
      });
    },
  });

  return { handle, done };
}

/**
 * Spawn an OpenCode NDJSON agent. Resume is `-s <id>` when this slot
 * already has a real session id.
 * @param {object} opts
 * @returns {{ handle: { kill: () => void }, done: Promise<object> }}
 */
function spawnAgentOpencode(opts) {
  const {
    prompt,
    cwd,
    model,
    binary,
    providerEntry,
    onText,
    reasoningEffort,
    permissionMode,
    sessionId,
    userDataPath,
    skipOverlay,
    project,
    threadId,
  } = opts;

  let text = "";
  /** @type {string[]} */
  const partOrder = [];
  /** @type {Map<string, string>} */
  const partTextById = new Map();
  let anonPartSeq = 0;
  let finished = false;
  let fullStdout = "";
  let gotJson = false;
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

  function rebuild() {
    return partOrder.map((id) => partTextById.get(id) || "").join("");
  }

  const entry = providerEntry || getProvider("opencode");
  const args = entry.buildArgs({
    prompt,
    sessionId: realSessionId(sessionId),
    model: model || null,
    reasoningEffort: reasoningEffort || null,
    permissionMode: permissionMode || "default",
  });

  /** @type {NodeJS.ProcessEnv | undefined} */
  let opencodeEnv;
  if (userDataPath && !skipOverlay && guardrailsEnabled()) {
    try {
      const dest = path.join(userDataPath, "opencode-guardrails");
      materializeOpencodeGuardrailDir(dest);
      opencodeEnv = {
        OPENCODE_CONFIG_DIR: dest,
        SOLENTA_WORKTREE: cwd,
      };
    } catch {
      // best-effort
    }
  } else if (crossesBoundary(project) && guardrailsEnabled()) {
    try {
      const dest = deployOpencodeGuardrailOverlay({ project, threadId });
      if (dest) {
        opencodeEnv = {
          OPENCODE_CONFIG_DIR: dest,
          SOLENTA_WORKTREE: (project && project.remotePath) || cwd,
        };
      }
    } catch {
      // Deploy miss must not kill the phase; stream notice remains.
    }
  }

  const opencodeBin = binary || resolveBin(entry);
  const spawn = resolveWorkflowSpawn(
    project,
    opencodeBin,
    args,
    cwd,
    opencodeEnv,
  );
  const handle = runOpencode({
    binary: spawn.binary,
    args: spawn.args,
    cwd: spawn.cwd,
    env: opencodeEnv,
    onEvent: (ev) => {
      gotJson = true;
      if (!ev || typeof ev !== "object") return;
      const textPart = opencodeExtractText(ev);
      if (textPart) {
        const partId =
          textPart.id != null && textPart.id !== ""
            ? textPart.id
            : `__anon_${anonPartSeq++}`;
        if (!partTextById.has(partId)) {
          partOrder.push(partId);
        }
        const prev = partTextById.get(partId) || "";
        if (
          !prev ||
          textPart.text.length >= prev.length ||
          !prev.startsWith(textPart.text)
        ) {
          partTextById.set(partId, textPart.text);
        }
        text = rebuild();
        if (typeof onText === "function") onText(text);
      }
      const sid = realSessionId(opencodeExtractSessionId(ev));
      if (sid) capturedSessionId = sid;
      const tool = opencodeExtractTool(ev);
      if (tool && tool.phase === "start") {
        notePhaseGuardrail(opts, tool.name, tool.input);
      }
    },
    onExit: ({ code, stderr, fullStdout: stdout, gotJson: parsed }) => {
      fullStdout = stdout || "";
      gotJson = gotJson || parsed;
      let finalText = text;
      if (!gotJson && fullStdout) {
        finalText = fullStdout.replace(/\s+$/, "");
        if (typeof onText === "function") onText(finalText);
      }
      const tokens = Math.ceil((finalText || "").length / 4) || 0;
      finish({
        ok: code === 0,
        text: finalText,
        usage: {
          inputTokens: 0,
          outputTokens: tokens,
          costUsd: 0,
        },
        code,
        stderr: String(stderr || ""),
      });
    },
    onError: (err) => {
      const msg = err && err.message ? err.message : String(err);
      finish({
        ok: false,
        text,
        usage: null,
        code: 1,
        stderr: msg,
        error: err,
      });
    },
  });

  return { handle, done };
}

/**
 * Spawn one agent using the phase provider kind.
 * @param {object} opts
 * @returns {{ handle: { kill: () => void }, done: Promise<object> }}
 */
function spawnPhaseAgent(opts) {
  const {
    providerId,
    prompt,
    cwd,
    permissionMode,
    model,
    onText,
    reasoningEffort,
    webSearch,
    userDataPath,
    threadId,
    projectId,
    overlayKey,
    skipOverlay,
    sessionId,
    project,
    appendMessage,
    runId,
    worktreePath,
  } = opts;

  const entry = getProvider(providerId);
  if (!entry) {
    /** @type {(value: object) => void} */
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    queueMicrotask(() => {
      resolveDone({
        ok: false,
        text: "",
        usage: null,
        code: 1,
        stderr: `Unknown provider: ${providerId}`,
      });
    });
    return { handle: { kill() {} }, done };
  }

  const binary = resolveBin(entry);

  if (entry.kind === "claude-stream") {
    return spawnAgentClaude({
      prompt,
      cwd,
      permissionMode,
      model,
      binary,
      providerEntry: entry,
      onText,
      reasoningEffort,
      sessionId,
    });
  }
  if (entry.kind === "codex-json") {
    return spawnAgentCodex({
      prompt,
      cwd,
      model,
      binary,
      providerEntry: entry,
      onText,
      reasoningEffort,
      webSearch,
      permissionMode,
      sessionId,
      userDataPath,
      threadId,
      skipOverlay,
      project,
      appendMessage,
      runId,
      worktreePath,
    });
  }
  if (entry.kind === "kimi-stream") {
    return spawnAgentKimi({
      prompt,
      cwd,
      model,
      binary,
      providerEntry: entry,
      onText,
      reasoningEffort,
      userDataPath,
      threadId,
      projectId,
      overlayKey,
      skipOverlay,
      sessionId: realSessionId(sessionId),
      project,
      appendMessage,
      runId,
      worktreePath,
    });
  }
  if (entry.kind === "muse-json") {
    return spawnAgentMuse({
      prompt,
      cwd,
      model,
      binary,
      providerEntry: entry,
      onText,
      reasoningEffort,
      permissionMode,
      userDataPath,
      threadId,
      projectId,
      overlayKey,
      skipOverlay,
      sessionId: realSessionId(sessionId),
      project,
      appendMessage,
      runId,
      worktreePath,
    });
  }
  if (entry.kind === "opencode-json") {
    return spawnAgentOpencode({
      prompt,
      cwd,
      model,
      binary,
      providerEntry: entry,
      onText,
      reasoningEffort,
      permissionMode,
      sessionId,
      userDataPath,
      skipOverlay,
      project,
      threadId,
      appendMessage,
      runId,
      worktreePath,
    });
  }
  if (entry.kind === "cursor-stream") {
    return spawnAgentCursor({
      prompt,
      cwd,
      model,
      binary,
      providerEntry: entry,
      onText,
      reasoningEffort,
      permissionMode,
      sessionId,
      userDataPath,
      skipOverlay,
      project,
      threadId,
      appendMessage,
      runId,
      worktreePath,
    });
  }
  // All known providers use structured kinds; plain-text path was removed.
  /** @type {(value: object) => void} */
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  queueMicrotask(() => {
    resolveDone({
      ok: false,
      text: "",
      usage: null,
      code: 1,
      stderr: `Unsupported provider kind for workflow: ${entry.kind} (${providerId})`,
    });
  });
  return { handle: { kill() {} }, done };
}

/**
 * Assert every phase provider binary is available. Throws naming the binary.
 * @param {object} template
 */
function assertTemplateProvidersAvailable(template) {
  for (const phase of template.phases || []) {
    const entry = getProvider(phase.provider);
    if (!entry || entry.kind === "simulate") {
      throw new Error(
        `Unknown provider for phase "${phase.name}": ${phase.provider}`,
      );
    }
    const bin = resolveBin(entry);
    if (!isBinAvailable(bin)) {
      throw new Error(
        `Provider binary not found: ${bin}. Install it or set ${entry.binEnv || "the provider binary env var"}.`,
      );
    }
  }
}

/**
 * Kickoff event text from a template.
 * @param {object} template
 */
function kickoffText(template) {
  let total = 0;
  const lines = [];
  for (const phase of template.phases || []) {
    const n = Number(phase.agentCount) || 1;
    total += n;
    lines.push(`${phase.name} ${n}`);
  }
  return [`Kicked off ${total} subagents`, ...lines].join("\n");
}

/**
 * Start an orchestrated multi-phase workflow run from a template.
 *
 * @param {object} deps
 * @param {string} deps.threadId
 * @param {string} deps.prompt
 * @param {string} [deps.templateId]
 * @param {import('./store').Store} deps.store
 * @param {object} deps.core - @coder/core (nameForSeed)
 * @param {(channel: string, payload: unknown) => void} deps.pushFn
 * @param {Map<string, object>} deps.active
 * @param {(threadId: string) => void} deps.clearRun
 * @param {(threadId: string, workflow: object | null) => object | null} deps.pushDetail
 * @param {() => void} deps.pushThreadsChanged
 * @param {(threadId: string, runId: string, label: string) => string} deps.beginWorkLogStep
 * @param {(threadId: string, itemId: string) => void} deps.completeWorkLogStep
 * @param {(threadId: string, runId: string, label: string) => void} deps.appendDoneWorkLog
 * @param {(threadId: string, role: string, text: string, runId?: string | null, tool?: object | null) => string} deps.appendMessage
 * @param {(threadId: string, status: "done"|"failed"|"stopped", text?: string, extras?: object) => void} [deps.notifyRunTerminal]
 * @param {string} [deps.userDataPath] - for kimi KIMI_CODE_HOME overlay (#699)
 * @param {string} [deps.resumeFromAgentId] - #825 retry one failed slot
 * @param {object | null} [deps.existingView] - last orchestrated view for retry
 * @returns {Promise<{ runId: string }>}
 */
async function startWorkflowRun(deps) {
  const {
    threadId,
    templateId,
    store,
    core,
    active,
    clearRun,
    pushFn,
    pushDetail,
    pushThreadsChanged,
    beginWorkLogStep,
    completeWorkLogStep,
    appendDoneWorkLog,
    appendMessage,
    notifyRunTerminal,
    userDataPath = "",
    resumeFromAgentId = null,
    existingView = null,
  } = deps;
  let prompt = deps.prompt;

  if (active.has(threadId)) {
    throw new Error("A run is already active on this thread");
  }

  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }

  // Budget gate is start-time only; never kills an in-flight run.
  const services = require("./services.js");
  services.assertUnderDailyBudget(store);

  const project = store.getProject(thread.projectId);
  if (!project) {
    throw new Error(`Unknown project for thread: ${threadId}`);
  }

  let template = null;
  if (resumeFromAgentId) {
    if (!existingView || !existingView.__orchestrated) {
      throw new Error("No workflow to retry");
    }
    const retryAgent = findAgent(existingView, resumeFromAgentId);
    if (!retryAgent || retryAgent.status !== "failed") {
      throw new Error("Workflow agent is not failed");
    }
    if (!existingView.__prompt) {
      throw new Error("Workflow prompt is missing");
    }
    prompt = existingView.__prompt;
    assertTemplateProvidersAvailable({
      phases: existingView.phases.map((p) => ({
        name: p.name,
        provider: p.__provider,
      })),
    });
  } else {
    const resolvedTemplateId = templateId || "standard";
    template = store.getTemplate(resolvedTemplateId);
    if (!template) {
      throw new Error(`Unknown workflow template: ${resolvedTemplateId}`);
    }
    if (!Array.isArray(template.phases) || template.phases.length === 0) {
      throw new Error(`Workflow template has no phases: ${resolvedTemplateId}`);
    }

    // Reject at start when any phase provider binary is unavailable.
    assertTemplateProvidersAvailable(template);
  }

  const runId = randomUUID();
  // Same stale-worktree guard as startRun: a folder removed outside the
  // app would make every phase fail with "spawn <cli> ENOENT". Never fall
  // back to the project checkout — isolation loss is worse than ENOENT (#511).
  const { clearMissingWorktree } = require("./worktrees.js");
  const droppedWorktree = clearMissingWorktree({
    store,
    threadId,
    broadcast: pushFn,
  });
  if (droppedWorktree) {
    throw new Error(
      `Worktree folder is gone (${droppedWorktree}); refusing to run in the project checkout.`,
    );
  }
  const cwd = thread.worktreePath || project.path;
  const permissionMode = thread.permissionMode || "default";
  const reasoningEffort = thread.reasoningEffort || null;
  const webSearch = thread.webSearch === true;
  // Overlay lives on this host; ssh/WSL phases inherit the remote kimi home.
  const skipKimiOverlay = Boolean(project.remoteHost || wslTarget(project));

  let view;
  if (resumeFromAgentId) {
    view = existingView;
    store.updateThread(
      threadId,
      {
        status: "working",
        runStartedAt: Date.now(),
        awaitingInput: false,
        lastEventAt: null,
        stalledAt: null,
        stoppedAt: null,
        ...services.clearSettledOnActivity(thread),
      },
      { touch: true },
    );
  } else {
    const seed = hashSeed(threadId, runId);
    const name =
      typeof core.nameForSeed === "function"
        ? core.nameForSeed(seed)
        : `WF-${seed}`;

    appendMessage(threadId, "user", prompt, runId);

    let title = thread.title;
    if (title === "New Thread") {
      const firstLine = String(prompt).split(/\r?\n/)[0].trim();
      title = firstLine.slice(0, 60) || "New Thread";
    }

    // Real activity clears a stale "settled" pin (same as startRun). An
    // "active" pin survives. Without this, a workflow on a settled thread
    // re-folds the moment the run finishes.
    store.updateThread(
      threadId,
      {
        status: "working",
        title,
        runStartedAt: Date.now(),
        awaitingInput: false,
        lastEventAt: null,
        stalledAt: null,
        stoppedAt: null,
        ...services.clearSettledOnActivity(thread),
      },
      { touch: true },
    );

    view = buildWorkflowView({ runId, name, template });
    view.__prompt = prompt;
    view.__templateId = template.id;

    appendMessage(threadId, "event", kickoffText(template), runId);
  }

  /** @type {Map<string, string>} */
  const phaseItemIds = new Map();
  /** Live child handles for stopRun */
  /** @type {Map<string, { kill: () => void }>} */
  const liveHandles = new Map();
  /** Accumulated usage across agents (also on entry.runUsage for stop footers). */
  let aggInput = 0;
  let aggCached = 0;
  let aggCacheWrite = 0;
  let aggOutput = 0;
  let aggCost = 0;
  const runUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

  function syncRunUsage() {
    runUsage.tokensIn = aggInput;
    runUsage.tokensOut = aggOutput;
    runUsage.costUsd = aggCost;
  }

  /** @type {{ lastPush: number, pending: boolean, timer: ReturnType<typeof setTimeout> | null }} */
  const throttle = { lastPush: 0, pending: false, timer: null };

  function flushPush() {
    throttle.lastPush = Date.now();
    throttle.pending = false;
    if (throttle.timer) {
      clearTimeout(throttle.timer);
      throttle.timer = null;
    }
    recomputeView(view);
    store.save();
    pushDetail(threadId, view);
  }

  function schedulePush(force) {
    if (force) {
      flushPush();
      return;
    }
    const now = Date.now();
    const elapsed = now - throttle.lastPush;
    if (elapsed >= PUSH_THROTTLE_MS) {
      flushPush();
      return;
    }
    if (throttle.pending) return;
    throttle.pending = true;
    throttle.timer = setTimeout(() => {
      flushPush();
    }, PUSH_THROTTLE_MS - elapsed);
  }

  function beginPhase(phaseName) {
    if (phaseItemIds.has(phaseName)) return;
    const id = beginWorkLogStep(threadId, runId, capitalize(phaseName));
    phaseItemIds.set(phaseName, id);
  }

  function completePhase(phaseName) {
    const id = phaseItemIds.get(phaseName);
    if (id) completeWorkLogStep(threadId, id);
  }

  function guard() {
    const e = active.get(threadId);
    if (!e || e.stopping || e.runId !== runId) return null;
    if (e.kind !== "workflow") return null;
    return e;
  }

  /**
   * Append a per-agent dossier tool message.
   * @param {string} phaseName
   * @param {number} agentIndex
   * @param {string} agentPrompt
   * @param {object | null} result
   * @param {boolean} failed
   */
  function appendDossier(phaseName, agentIndex, agentPrompt, result, failed) {
    const statusWord = failed ? "failed" : "finished";
    const text = `${phaseName} agent ${agentIndex} ${statusWord}`;
    const output = truncate((result && result.text) || "", DOSSIER_OUTPUT_MAX);
    const tool = {
      id: `${runId}:${phaseName}:${agentIndex}`,
      name: `${phaseName} agent ${agentIndex}`,
      input: truncate(agentPrompt || "", DOSSIER_INPUT_MAX),
      output,
      isError: Boolean(failed),
      done: true,
    };
    appendMessage(threadId, "tool", text, runId, tool);
  }

  const entry = {
    kind: "workflow",
    runId,
    stopping: false,
    liveHandles,
    phaseItemIds,
    view,
    throttle,
    runUsage,
  };
  Object.defineProperty(entry, "workflow", {
    get() {
      return view;
    },
    enumerable: true,
  });
  active.set(threadId, entry);

  store.save();
  pushThreadsChanged();
  schedulePush(true);

  // Fire-and-forget orchestration; errors handled inside.
  const started = resumeFromAgentId
    ? runFromRetry(resumeFromAgentId)
    : runPhases();
  void started.catch((err) => {
    if (!guard()) return;
    failRun(
      "workflow",
      err && err.message ? err.message : String(err),
    );
  });

  /**
   * @param {string} agentId
   * @param {string} stderrTail
   */
  function failRun(agentId, stderrTail) {
    if (!guard()) return;
    const e = active.get(threadId);
    if (e && e.throttle && e.throttle.timer) {
      clearTimeout(e.throttle.timer);
      e.throttle.timer = null;
    }
    // Mark any still-running agents failed
    for (const phase of view.phases) {
      for (const agent of phase.agents) {
        if (agent.status === "running" || agent.status === "pending") {
          agent.status = "failed";
        }
      }
    }
    for (const id of phaseItemIds.values()) {
      completeWorkLogStep(threadId, id);
    }
    const tail = String(stderrTail || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-8)
      .join("\n");
    const errText = looksGrokConfigCorrupt(tail)
      ? grokConfigCorruptMessage()
      : tail
        ? `Run error (${agentId}):\n${tail}`
        : `Run error (${agentId})`;
    appendMessage(threadId, "event", errText, runId);
    appendDoneWorkLog(threadId, runId, "Run error");
    store.updateThread(
      threadId,
      { status: "failed", runStartedAt: null },
      { touch: true },
    );
    recomputeView(view);
    store.save();
    clearRun(threadId);
    // Final push never dropped.
    pushDetail(threadId, view);
    pushThreadsChanged();
    if (typeof notifyRunTerminal === "function") {
      notifyRunTerminal(threadId, "failed", errText, {
        tokensIn: aggInput,
        tokensOut: aggOutput,
        costUsd: aggCost,
      });
    }
  }

  /**
   * Run one agent, updating view live. Returns result or null if stopped.
   * @param {object} spec
   */
  async function runOneAgent(spec) {
    const {
      agentId,
      agentPrompt,
      providerId,
      model,
      phaseName,
      agentIndex,
    } = spec;
    if (!guard()) return null;

    const agent = findAgent(view, agentId);
    if (!agent) return null;

    agent.__attempted = true;
    agent.__prompt = agentPrompt;
    agent.status = "running";
    agent.tokensUsed = 0;
    schedulePush(true);

    let charCount = 0;

    async function spawnSlot() {
      const { handle, done } = spawnPhaseAgent({
        providerId,
        prompt: agentPrompt,
        cwd,
        permissionMode,
        model,
        reasoningEffort,
        webSearch,
        userDataPath,
        threadId,
        projectId: thread.projectId,
        overlayKey: agentId,
        skipOverlay: skipKimiOverlay,
        sessionId: agent.sessionId || null,
        project,
        appendMessage,
        runId,
        worktreePath: cwd,
        onText: (t) => {
          if (!guard()) return;
          charCount = t.length;
          agent.tokensUsed = Math.ceil(charCount / 4) || 1;
          schedulePush(false);
        },
      });
      liveHandles.set(agentId, handle);
      const slotResult = await done;
      liveHandles.delete(agentId);
      // Persist on this workflow agent only. Never thread.sessionId.
      // A hint-less turn keeps the prior real id. Never "cwd" (#220).
      const captured = realSessionId(slotResult && slotResult.sessionId);
      if (captured) agent.sessionId = captured;
      return slotResult;
    }

    function absorbUsage(slotResult) {
      if (!slotResult || !slotResult.usage) return;
      aggInput += slotResult.usage.inputTokens || 0;
      aggCached += slotResult.usage.cachedInputTokens || 0;
      aggCacheWrite += slotResult.usage.cacheWriteTokens || 0;
      aggOutput += slotResult.usage.outputTokens || 0;
      const agentCost = Number(slotResult.usage.costUsd) || 0;
      aggCost += agentCost;
      syncRunUsage();
      if (agentCost > 0) {
        store.recordSpend(agentCost);
      }
    }

    let result = await spawnSlot();

    if (!guard()) {
      // Stopped mid-flight: leave status as-is if stop already marked failed
      if (agent.status === "running") agent.status = "failed";
      // Still emit dossier so the renderer has a card for the killed agent.
      appendDossier(phaseName, agentIndex, agentPrompt, result, true);
      return null;
    }

    // One bounded retry on the same slot / overlay / sessionId (#815 / #819).
    // The work-log line is in-progress for the second spawn only (#823).
    if (result && !result.ok) {
      absorbUsage(result);
      if (!guard()) {
        if (agent.status === "running") agent.status = "failed";
        appendDossier(phaseName, agentIndex, agentPrompt, result, true);
        return null;
      }
      const retryItemId = beginWorkLogStep(
        threadId,
        runId,
        `${capitalize(phaseName)} agent ${agentIndex + 1} retrying`,
      );
      schedulePush(true);
      result = await spawnSlot();
      completeWorkLogStep(threadId, retryItemId);
      schedulePush(true);
      if (!guard()) {
        if (agent.status === "running") agent.status = "failed";
        appendDossier(phaseName, agentIndex, agentPrompt, result, true);
        return null;
      }
    }

    if (result.ok) {
      agent.status = "settled";
      agent.__text = result.text || "";
      if (result.usage) {
        agent.tokensUsed =
          (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0) ||
          Math.ceil((result.text || "").length / 4) ||
          1;
        aggInput += result.usage.inputTokens || 0;
        aggCached += result.usage.cachedInputTokens || 0;
        aggCacheWrite += result.usage.cacheWriteTokens || 0;
        aggOutput += result.usage.outputTokens || 0;
        const agentCost = Number(result.usage.costUsd) || 0;
        aggCost += agentCost;
        syncRunUsage();
        // Record per agent as it settles so stop/fail mid-run still bills spend.
        if (agentCost > 0) {
          store.recordSpend(agentCost);
        }
      } else {
        agent.tokensUsed = Math.ceil((result.text || "").length / 4) || 1;
      }
      appendDossier(phaseName, agentIndex, agentPrompt, result, false);
    } else {
      agent.status = "failed";
      if (result.usage) {
        agent.tokensUsed =
          (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
        aggInput += result.usage.inputTokens || 0;
        aggCached += result.usage.cachedInputTokens || 0;
        aggCacheWrite += result.usage.cacheWriteTokens || 0;
        aggOutput += result.usage.outputTokens || 0;
        const agentCost = Number(result.usage.costUsd) || 0;
        aggCost += agentCost;
        syncRunUsage();
        if (agentCost > 0) {
          store.recordSpend(agentCost);
        }
      }
      appendDossier(phaseName, agentIndex, agentPrompt, result, true);
    }

    schedulePush(true);
    return result;
  }

  function laterUnstarted(afterPhaseIndex) {
    return view.phases.slice(afterPhaseIndex + 1).some((p) =>
      p.agents.some((a) => !a.__attempted),
    );
  }

  /**
   * @param {object} phaseSpec
   * @param {{ spec?: { agentIndex: number }, result?: { text?: string } }[]} successes
   */
  function finishSuccess(phaseSpec, successes) {
    const phaseName = phaseSpec.name;
    let answerText = "";
    if (successes.length === 1) {
      answerText = (successes[0].result && successes[0].result.text) || "";
    } else {
      answerText = successes
        .map(
          (s) =>
            `## ${phaseName} agent ${s.spec.agentIndex + 1}\n${(s.result && s.result.text) || ""}`,
        )
        .join("\n\n");
    }

    if (!guard()) return;

    appendMessage(threadId, "assistant", answerText, runId);

    const prev = store.getUsage(threadId) || {
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      turns: 0,
    };
    store.setUsage(threadId, {
      model: prev.model || thread.model || agentModelLabel(phaseSpec),
      inputTokens: prev.inputTokens + aggInput,
      outputTokens: prev.outputTokens + aggOutput,
      costUsd: prev.costUsd + aggCost,
      turns: prev.turns + 1,
    });
    store.recordUsage({
      provider: thread.provider,
      model: prev.model || thread.model || agentModelLabel(phaseSpec),
      costUsd: aggCost,
      inputTokens: aggInput,
      cachedInputTokens: aggCached,
      cacheWriteTokens: aggCacheWrite,
      outputTokens: aggOutput,
      threadId,
      projectId: thread.projectId,
      projectName: store.getProject(thread.projectId)?.name,
      title: thread.title,
    });

    recomputeView(view);
    store.updateThread(
      threadId,
      { status: "done", runStartedAt: null },
      { touch: true },
    );
    store.save();
    clearRun(threadId);
    pushDetail(threadId, view);
    pushThreadsChanged();
    if (typeof notifyRunTerminal === "function") {
      notifyRunTerminal(threadId, "done", answerText, {
        tokensIn: aggInput,
        tokensOut: aggOutput,
        costUsd: aggCost,
      });
    }
  }

  function closeRetrySession() {
    recomputeView(view);
    const final = view.phases[view.phases.length - 1];
    const alreadyFinished =
      Boolean(final) &&
      final.agents.some((a) => a.status === "settled" && a.__attempted);
    store.updateThread(
      threadId,
      {
        status: view.complete || alreadyFinished ? "done" : "failed",
        runStartedAt: null,
      },
      { touch: true },
    );
    store.save();
    clearRun(threadId);
    pushDetail(threadId, view);
    pushThreadsChanged();
  }

  async function runFromRetry(agentId) {
    const loc = parseAgentId(agentId);
    if (!loc || !view.phases[loc.phaseIndex]) {
      throw new Error("Workflow agent is not failed");
    }
    const phaseView = view.phases[loc.phaseIndex];
    const phaseSpec = phaseSpecFromView(phaseView);
    const priorOutputs = collectPriorOutputs(view, loc.phaseIndex);
    const agentPrompt = buildAgentPrompt({
      userPrompt: prompt,
      instruction: phaseSpec.instruction,
      agentIndex: loc.agentIndex,
      agentCount: phaseSpec.agentCount,
      priorOutputs,
    });

    if (!guard()) return;
    beginPhase(phaseSpec.name);
    schedulePush(true);
    const retryItemId = beginWorkLogStep(
      threadId,
      runId,
      `${capitalize(phaseSpec.name)} agent ${loc.agentIndex + 1} retrying`,
    );
    schedulePush(true);
    let result = null;
    try {
      result = await runOneAgent({
        agentId,
        agentPrompt,
        providerId: phaseSpec.provider,
        model: phaseSpec.model,
        phaseName: phaseSpec.name,
        agentIndex: loc.agentIndex,
      });
    } finally {
      completeWorkLogStep(threadId, retryItemId);
      schedulePush(true);
    }
    if (!guard()) return;
    completePhase(phaseSpec.name);

    const phaseHasSettled = phaseView.agents.some((a) => a.status === "settled");
    if ((!result || !result.ok) && !phaseHasSettled) {
      failRun(agentId, (result && result.stderr) || "retry failed");
      return;
    }

    const isFinal = loc.phaseIndex === view.phases.length - 1;
    if (isFinal && phaseHasSettled) {
      const successes = phaseView.agents
        .map((agent, agentIndex) => ({
          spec: { agentIndex },
          result: {
            ok: agent.status === "settled",
            text: agent.__text || "",
          },
        }))
        .filter((s) => s.result.ok);
      finishSuccess(phaseSpec, successes);
      return;
    }

    if (phaseHasSettled && laterUnstarted(loc.phaseIndex)) {
      for (const later of view.phases.slice(loc.phaseIndex + 1)) {
        for (const agent of later.agents) {
          if (agent.status === "failed" && !agent.__attempted) {
            agent.status = "pending";
          }
        }
      }
      await runPhases(
        loc.phaseIndex + 1,
        collectPriorOutputs(view, loc.phaseIndex + 1),
      );
      return;
    }

    closeRetrySession();
  }

  /**
   * @param {number} [fromIndex]
   * @param {{ phaseName: string, agentIndex: number, text: string }[]} [seedOutputs]
   */
  async function runPhases(fromIndex = 0, seedOutputs = []) {
    /** @type {{ phaseName: string, agentIndex: number, text: string }[]} */
    let priorOutputs = seedOutputs.slice();

    const lastPhaseIndex = view.phases.length - 1;

    for (let phaseIndex = fromIndex; phaseIndex < view.phases.length; phaseIndex++) {
      const phaseView = view.phases[phaseIndex];
      const phaseSpec = phaseSpecFromView(phaseView);
      const phaseName = phaseSpec.name;
      const agentCount = Math.max(
        1,
        Math.min(4, Number(phaseSpec.agentCount) || 1),
      );
      const isFinal = phaseIndex === lastPhaseIndex;

      if (fromIndex > 0) {
        for (const agent of phaseView.agents) {
          if (agent.status === "failed" && !agent.__attempted) {
            agent.status = "pending";
          }
        }
      }

      if (!guard()) return;
      beginPhase(phaseName);
      schedulePush(true);

      /** @type {{ agentIndex: number, agentId: string, agentPrompt: string }[]} */
      const specs = [];
      for (let i = 0; i < agentCount; i++) {
        const agentId = `${phaseIndex}:${phaseName}:${i}`;
        const agentPrompt = buildAgentPrompt({
          userPrompt: prompt,
          instruction: phaseSpec.instruction,
          agentIndex: i,
          agentCount,
          priorOutputs,
        });
        specs.push({ agentIndex: i, agentId, agentPrompt });
      }

      const results = await Promise.all(
        specs.map((s) =>
          runOneAgent({
            agentId: s.agentId,
            agentPrompt: s.agentPrompt,
            providerId: phaseSpec.provider,
            model:
              phaseSpec.model != null && phaseSpec.model !== ""
                ? phaseSpec.model
                : null,
            phaseName,
            agentIndex: s.agentIndex,
          }).then((r) => ({ spec: s, result: r })),
        ),
      );

      if (!guard()) return;
      completePhase(phaseName);

      const successes = results.filter((r) => r.result && r.result.ok);
      const failures = results.filter((r) => !r.result || !r.result.ok);

      // All agents failed => run failed (any phase, including final).
      if (successes.length === 0) {
        const firstFail = failures[0];
        const failId =
          (firstFail && firstFail.spec && firstFail.spec.agentId) ||
          `${phaseIndex}:${phaseName}:0`;
        const stderr =
          (firstFail &&
            firstFail.result &&
            firstFail.result.stderr) ||
          `all agents in phase "${phaseName}" failed`;
        failRun(failId, stderr);
        return;
      }

      // Partial failures: note and continue (final phase still needs >=1 success).
      if (failures.length > 0) {
        for (const f of failures) {
          const label = `${capitalize(phaseName)} agent ${f.spec.agentIndex + 1} failed, continuing`;
          appendDoneWorkLog(threadId, runId, label);
        }
        schedulePush(true);
      }

      if (isFinal) {
        finishSuccess(phaseSpec, successes);
        return;
      }

      // Chain outputs into subsequent phases (stable agentIndex order).
      /** @type {{ phaseName: string, agentIndex: number, text: string }[]} */
      const phaseOutputs = [];
      for (const s of successes) {
        phaseOutputs.push({
          phaseName,
          agentIndex: s.spec.agentIndex,
          text: (s.result && s.result.text) || "",
        });
      }
      // Include failed slots as unavailable so later prompts stay labeled.
      for (const f of failures) {
        phaseOutputs.push({
          phaseName,
          agentIndex: f.spec.agentIndex,
          text: "",
        });
      }
      phaseOutputs.sort((a, b) => a.agentIndex - b.agentIndex);
      priorOutputs = priorOutputs.concat(phaseOutputs);
    }
  }

  return { runId };
}

/**
 * Re-spawn a failed phase agent after the run has ended (#825).
 * @param {object} deps
 */
async function retryWorkflowAgent(deps) {
  return startWorkflowRun({
    ...deps,
    prompt: deps.view && deps.view.__prompt,
    resumeFromAgentId: deps.agentId,
    existingView: deps.view,
  });
}

/**
 * Stop a workflow entry: kill all live children, mark running agents failed.
 * Caller handles messages/status/clearRun.
 * @param {object} entry
 */
function stopWorkflowEntry(entry) {
  if (!entry || entry.kind !== "workflow") return;
  entry.stopping = true;
  if (entry.throttle && entry.throttle.timer) {
    clearTimeout(entry.throttle.timer);
    entry.throttle.timer = null;
  }
  if (entry.liveHandles) {
    for (const handle of entry.liveHandles.values()) {
      try {
        handle.kill();
      } catch {
        // ignore
      }
    }
    entry.liveHandles.clear();
  }
  if (entry.view) {
    for (const phase of entry.view.phases) {
      for (const agent of phase.agents) {
        if (agent.status === "running" || agent.status === "pending") {
          agent.status = "failed";
        }
      }
    }
    recomputeView(entry.view);
  }
}

module.exports = {
  startWorkflowRun,
  retryWorkflowAgent,
  stopWorkflowEntry,
  buildWorkflowView,
  recomputeView,
  toPublicView,
  hashSeed,
  buildAgentPrompt,
  spawnPhaseAgent,
  assertTemplateProvidersAvailable,
  kickoffText,
  agentModelLabel,
  PUSH_THROTTLE_MS,
  DOSSIER_INPUT_MAX,
  DOSSIER_OUTPUT_MAX,
};
