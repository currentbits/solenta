"use strict";

const { randomUUID } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { runClaude } = require("./claude.js");
const { runCodex, extractAgentMessageText, extractUsage } = require("./codex.js");
const {
  runKimi,
  materializeKimiHome,
  extractAssistantText: kimiExtractText,
  extractUsage: kimiExtractUsage,
} = require("./kimi.js");
const {
  runCursor,
  extractAssistantText: cursorExtractText,
  extractUsage: cursorExtractUsage,
} = require("./cursor.js");
const {
  getProvider,
  resolveBin,
  isBinAvailable,
} = require("./providers.js");
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
const { guardrailsEnabled } = require("./guardrails.js");
const { insertBeforeLast } = require("./guardrail-hook-core.js");
const {
  materializeCursorPinPlugin,
  cursorPinPluginDir,
} = require("./cursorPinTaskParent.js");
const {
  materializeCursorGuardrailPlugin,
  cursorGuardrailPluginDir,
} = require("./cursor-guardrail.js");
const { materializeCodexGuardrailHome } = require("./codex-guardrail.js");
const { materializeOpencodeGuardrailDir } = require("./opencode-guardrail.js");
const {
  runOpencode,
  extractTextPart: opencodeExtractText,
  extractSessionId: opencodeExtractSessionId,
  extractToolEvent: opencodeExtractTool,
} = require("./opencode.js");

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
 * Truncate a string to max chars.
 * @param {unknown} s
 * @param {number} max
 */
function truncate(s, max) {
  const str = String(s ?? "");
  return str.length <= max ? str : str.slice(0, max);
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
 * Spawn a one-shot claude-stream agent (no --resume).
 * Reuses the claude NDJSON parser for any provider with kind "claude-stream"
 * (claude, grok, ...). Arg builders stay per-provider; --mcp-config is
 * injected only for the claude provider id.
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
  } = opts;

  let text = "";
  let resultText = "";
  let usage = null;
  let finished = false;

  /** @type {(value: object) => void} */
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function finish(payload) {
    if (finished) return;
    finished = true;
    resolveDone(payload);
  }

  const entry = providerEntry || getProvider("claude");
  const baseArgs = entry
    ? entry.buildArgs({
        prompt,
        sessionId: null,
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
    sessionId: null,
    model: model || null,
    interactive,
    envExtra:
      entry && entry.id === "grok" ? mergeGrokSpawnEnv(undefined) : undefined,
    onEvent: (ev) => {
      if (!ev || typeof ev !== "object") return;
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
 * Spawn a one-shot Codex JSONL agent (no resume).
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
    userDataPath,
    threadId,
    skipOverlay,
  } = opts;

  let text = "";
  let usage = null;
  let finished = false;

  /** @type {(value: object) => void} */
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function finish(payload) {
    if (finished) return;
    finished = true;
    resolveDone(payload);
  }

  const entry = providerEntry || getProvider("codex");
  const args = entry.buildArgs({
    prompt,
    sessionId: null,
    model: model || null,
    reasoningEffort: reasoningEffort || null,
    webSearch: webSearch === true,
    permissionMode: permissionMode || "default",
  });
  const codexMcpArgs = getCodexMcpArgs({ projectPath: cwd });
  if (codexMcpArgs.length > 0) {
    args.unshift(...codexMcpArgs);
  }
  /** @type {Record<string, string>} */
  const envExtra = { ...getCodexMcpEnv() };
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
  }

  const handle = runCodex({
    binary: binary || resolveBin(entry),
    args,
    cwd,
    envExtra,
    onEvent: (ev) => {
      if (!ev || typeof ev !== "object") return;
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
 * Spawn a one-shot Kimi stream-json agent (no resume / no -c).
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
  } = opts;

  let text = "";
  let usage = null;
  let finished = false;
  let fullStdout = "";
  let gotJson = false;

  /** @type {(value: object) => void} */
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function finish(payload) {
    if (finished) return;
    finished = true;
    resolveDone(payload);
  }

  const entry = providerEntry || getProvider("kimi");
  const args = entry.buildArgs({
    prompt,
    sessionId: null,
    model: model || null,
    reasoningEffort: reasoningEffort || null,
  });

  // Same overlay runner uses for normal kimi turns (#671 / #699): isolated
  // KIMI_CODE_HOME so the phase cannot inherit foreign MCP, and so
  // flipKimiEffort writes a local config.toml. Nested under threadId so
  // parallel phase agents do not race one file and reclaim still keys off
  // the thread. Skipped for ssh/WSL and when userDataPath is unset (tests).
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
  }

  const handle = runKimi({
    binary: binary || resolveBin(entry),
    args,
    cwd,
    env: kimiEnv,
    reasoningEffort: reasoningEffort || null,
    onEvent: (ev) => {
      gotJson = true;
      if (!ev || typeof ev !== "object") return;
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
 * Spawn a one-shot Cursor stream-json agent (no resume).
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
    userDataPath,
    skipOverlay,
  } = opts;

  let text = "";
  let usage = null;
  let finished = false;
  let fullStdout = "";
  let gotJson = false;

  /** @type {(value: object) => void} */
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function finish(payload) {
    if (finished) return;
    finished = true;
    resolveDone(payload);
  }

  const entry = providerEntry || getProvider("cursor");
  const args = entry.buildArgs({
    prompt,
    sessionId: null,
    model: model || null,
    reasoningEffort: reasoningEffort || null,
    permissionMode: permissionMode || "default",
  });

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
  }

  const handle = runCursor({
    binary: binary || resolveBin(entry),
    args,
    cwd,
    onEvent: (ev) => {
      gotJson = true;
      if (!ev || typeof ev !== "object") return;
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
 * Spawn a one-shot OpenCode NDJSON agent (no resume).
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
    userDataPath,
    skipOverlay,
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

  /** @type {(value: object) => void} */
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function finish(payload) {
    if (finished) return;
    finished = true;
    resolveDone(payload);
  }

  function rebuild() {
    return partOrder.map((id) => partTextById.get(id) || "").join("");
  }

  const entry = providerEntry || getProvider("opencode");
  const args = entry.buildArgs({
    prompt,
    sessionId: null,
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
  }

  const handle = runOpencode({
    binary: binary || resolveBin(entry),
    args,
    cwd,
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
      // sessionID captured but workflow one-shots do not resume
      opencodeExtractSessionId(ev);
      opencodeExtractTool(ev);
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
      userDataPath,
      threadId,
      skipOverlay,
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
      userDataPath,
      skipOverlay,
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
      userDataPath,
      skipOverlay,
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

    // One bounded retry on the same slot / overlay. The work-log line is
    // in-progress for the second spawn only (#823).
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
