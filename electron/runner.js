"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { randomUUID, createHash } = require("node:crypto");
const services = require("./services.js");
const { runAgent, parseAgentCommand } = require("./agent.js");
const {
  runClaude,
  truncate,
  toolSummary,
  flattenContent,
  INPUT_TRUNCATE,
  OUTPUT_TRUNCATE,
} = require("./claude.js");
const { runCodexAppServerTurn } = require("./codex-appserver.js");
const { materializeGrokHome, deployGrokGuardrailOverlay } = require("./grok.js");
const { heartbeatLane } = require("./mergeQueue.js");
const { createWatchdogs } = require("./runner-watchdogs.js");
const { createAskRuns } = require("./runner-ask-runs.js");
const { createTurnSetup } = require("./runner-turn-setup.js");
const { createSubagents } = require("./runner-subagents.js");
const { createSessionRecording } = require("./runner-session-recording.js");
const { createClaudeSessions } = require("./runner-claude-sessions.js");
const { createVerifyGate } = require("./runner-verify-gate.js");
const { createQuotaWait } = require("./runner-quota-wait.js");
const { createOrchNotices } = require("./runner-orch-notices.js");
const { createPermissions } = require("./runner-permissions.js");
const { createCodexRun } = require("./runner-provider-codex.js");
const { createCursorRun } = require("./runner-provider-cursor.js");
const { createKimiRun } = require("./runner-provider-kimi.js");
const { createOpencodeRun } = require("./runner-provider-opencode.js");
const { createMuseRun } = require("./runner-provider-muse.js");
const {
  getProvider,
  resolveBin,
  isBinAvailable,
  listProviders,
  codexModelAcceptsImages,
} = require("./providers.js");
const orchcommands = require("./orchcommands.js");
const cliCommands = require("./cliCommands.js");
const ask = require("./ask.js");
const btw = require("./btw.js");
const {
  getClaudeMcpArgs,
  mergeGrokSpawnEnv,
  getMemoryStatus,
  looksGrokConfigCorrupt,
  grokConfigCorruptMessage,
  kimiMcpServersForRun,
  ensureGrokMcpConfig,
  whenGrokMcpIdle,
} = require("./memory-sup.js");
const {
  isMemoryConsolidateTool,
  recordConsolidateOutcome,
} = require("./memory-consolidate.js");
const { recordRunOutcome } = require("./memory-record.js");
const { createOtel } = require("./otel.js");
const { extractImages, saveToolImages } = require("./tool-images.js");
const workflowEngine = require("./workflow.js");
const { wrapCommand } = require("./ssh.js");
const { wslTarget } = require("./wsl.js");
const { resolveSandbox } = require("./sandbox.js");
const { killTree } = require("./proc.js");
const { stop: stopDevServer } = require("./devservers.js");
const { classifyTool } = require("./guardrails.js");
const {
  inspectWriterLock,
  formatWriterLockDiagnosis,
  releaseWriterLockHolder,
  killPidTree,
} = require("./codexWriterLock.js");
const { grokGuardrailNotice } = require("./grok-guardrail-hook.js");
const {
  classifyContextOverflow,
  classifyCliUpgrade,
  classifyWriterLock,
  decideQuotaWait,
  formatQuotaWaitClock,
} = require("./quotaWait.js");
const { startWithPoolFailover } = require("./subagentPool.js");
const {
  formatQueuedPrompt,
  firstChanged,
  cancelCodexServerRequests,
  sanitizeAttachments,
  attachmentPromptSection,
} = require("./runnerHelpers.js");

const PUSH_THROTTLE_MS = 250;
const THINKING_TRUNCATE = 8000;

/**
 * Unwrap a Messages-API partial (`stream_event` wrapper or bare
 * content_block_* / message_*). Null when `ev` is a whole message.
 * @param {object} ev
 * @returns {object | null}
 */
function unwrapStreamEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  if (ev.type === "stream_event" && ev.event && typeof ev.event === "object") {
    return ev.event;
  }
  if (
    ev.type === "content_block_start" ||
    ev.type === "content_block_delta" ||
    ev.type === "content_block_stop" ||
    ev.type === "message_start" ||
    ev.type === "message_delta" ||
    ev.type === "message_stop"
  ) {
    return ev;
  }
  return null;
}

/**
 * Create or grow a thinking card (issue #751). Shared by claude-stream,
 * cursor, kimi, and opencode so the transcript paints one Thinking row.
 * @param {{ id: string | null, text: string }} state
 * @param {string} chunk
 * @param {boolean} [replace]
 * @returns {boolean}
 */
function upsertThinkingCard(appendMessage, store, threadId, runId, state, chunk, replace) {
  if (chunk == null) return false;
  if (replace) state.text = String(chunk);
  else state.text += String(chunk);
  const body = truncate(state.text, THINKING_TRUNCATE);
  if (!body) return false;
  if (!state.id) {
    state.id = appendMessage(
      threadId,
      "event",
      body,
      runId,
      null,
      null,
      { thinking: true },
    );
  } else {
    store.updateMessage(threadId, state.id, { text: body });
  }
  return true;
}

/** Badge tooltip: first ~2 lines, ~300 chars. */
function shortError(text) {
  const s = String(text ?? "").trim();
  const two = s.split(/\r?\n/, 2).join("\n").trim();
  return two.length > 300 ? two.slice(0, 300) : two;
}

/**
 * Full prompt size for the context ring. Claude's input_tokens excludes
 * cache_read/cache_creation; omitting those reads as ~0% then jumps (#317).
 * Returns undefined when the event does not report the cache fields — an
 * inaccurate number is worse than none.
 *
 * Grok uses the same stream but often omits the cache keys (fixtures; some
 * CLI versions). Its input_tokens is still the uncached bucket. When cache
 * keys are absent, treat them as 0 rather than hiding the ring (#704).
 * Prefer usage.total_tokens when the CLI reports it.
 *
 * @param {object | null | undefined} usage
 * @param {{ allowMissingCache?: boolean }} [opts]
 * @returns {number | undefined}
 */
function claudeContextTokens(usage, opts) {
  if (!usage || typeof usage !== "object") return undefined;
  const allowMissingCache = Boolean(opts && opts.allowMissingCache);
  if (
    usage.cache_read_input_tokens == null &&
    usage.cache_creation_input_tokens == null &&
    !allowMissingCache
  ) {
    return undefined;
  }
  const reportedTotal = Number(usage.total_tokens);
  if (Number.isFinite(reportedTotal) && reportedTotal > 0) return reportedTotal;
  const total =
    (Number(usage.input_tokens) || 0) +
    (Number(usage.cache_read_input_tokens) || 0) +
    (Number(usage.cache_creation_input_tokens) || 0) +
    (Number(usage.output_tokens) || 0);
  return total > 0 ? total : undefined;
}

/**
 * CLI-reported window from grok's modelUsage row (the same figure grok uses
 * for auto-compaction). Absent when the CLI omitted it.
 * @param {object | null | undefined} ev
 * @returns {number | undefined}
 */
function reportedModelUsageWindow(ev) {
  const mu = ev && ev.modelUsage;
  if (!mu || typeof mu !== "object") return undefined;
  for (const row of Object.values(mu)) {
    if (!row || typeof row !== "object") continue;
    const w = Number(row.contextWindow);
    if (Number.isFinite(w) && w > 0) return w;
  }
  return undefined;
}

/**
 * Carry forward measured context fields; never invent a 0.
 * @param {object} next
 * @param {object} prev
 * @param {number | undefined} contextTokens
 * @param {number | undefined} contextWindow
 */
function assignContextUsage(next, prev, contextTokens, contextWindow) {
  const ctx = contextTokens != null ? Number(contextTokens) : NaN;
  if (Number.isFinite(ctx) && ctx > 0) next.contextTokens = ctx;
  else if (prev.contextTokens != null) next.contextTokens = prev.contextTokens;
  const win = contextWindow != null ? Number(contextWindow) : NaN;
  if (Number.isFinite(win) && win > 0) next.contextWindow = win;
  else if (prev.contextWindow != null) next.contextWindow = prev.contextWindow;
}

/**
 * A kept-alive/resumed Claude CLI can emit a result that is not the answer to
 * the turn we just sent: settling a leftover background-task notification or
 * "Continue from where you left off." self-turn first (issue #17). Those
 * phantom results are success-typed with empty text and arrive before the
 * real turn streams anything. We hold such a result instead of finalizing;
 * real turn activity discards it and the real result finalizes the run. The
 * held result only becomes a failure when the process EXITS without ever
 * answering — the one piece of evidence that the turn is really over. A
 * wall-clock grace window cannot stand in for that: the CLI's first token
 * legitimately lands minutes later (observed: 48s of thinking on a large
 * resumed session), and failing early both fabricates an error and drops the
 * whole real turn, which is issue #17's "nothing happens".
 */
// ponytail: shape-based phantom detection (empty success before any content);
// switch to a per-turn correlation id if the CLI protocol ever grows one.

/** Empty success with no streamed turn content: leftover, not this turn. */
function isPhantomClaudeResult(ev, sawTurnContent) {
  if (sawTurnContent) return false;
  if (!ev || ev.subtype !== "success") return false;
  const text = typeof ev.result === "string" ? ev.result.trim() : "";
  return !text;
}

/** CLI-side interrupt token. Exact match only — "Write cancelled" stays a fail. */
function isBareCancelError(text) {
  return /^(cancelled|canceled)$/i.test(String(text || "").trim());
}

function asErrorList(errors) {
  return (Array.isArray(errors) ? errors : [])
    .map((e) => String(e).trim())
    .filter(Boolean);
}

function stderrTailLines(stderr) {
  return String(stderr || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-8);
}

function looksSessionLost(text) {
  return /No conversation found/i.test(String(text || ""));
}

/**
 * Codex thread-store single-writer conflict (openai/codex#37403).
 * Match the explicit conflict text only, never generic JSON-RPC -32600.
 * Broader than classifyWriterLock: also "live local writer".
 * @param {unknown} text
 */
function looksWriterLock(text) {
  const s = String(text || "");
  if (!s) return false;
  return (
    classifyWriterLock(s) != null ||
    /already has a live local writer/i.test(s)
  );
}

/**
 * Map a claude-stream result event's errors[] (+ optional result/stderr) into
 * a user-facing terminal. Bare `cancelled` is a stop (same idea as stopRun),
 * not a crash. Remaining failures keep the CLI text and drop the adapter
 * subtype from copy (issue #549).
 *
 * @param {{ errors?: unknown, stderr?: string, result?: unknown }} [input]
 * @returns {{ kind: "stop" } | { kind: "fail", text: string, sessionLost: boolean }}
 */
function classifyClaudeResultError(input) {
  const src = input && typeof input === "object" ? input : {};
  const errors = asErrorList(src.errors);
  const resultText = typeof src.result === "string" ? src.result.trim() : "";
  const stderr = stderrTailLines(src.stderr);
  const sessionLost =
    errors.some(looksSessionLost) ||
    looksSessionLost(resultText) ||
    stderr.some(looksSessionLost);

  const remaining = errors.filter((e) => !isBareCancelError(e));
  // errors[] is authoritative. A partial result payload (streamed assistant
  // text echoed on the error event) must not turn a bare cancel into a fail.
  const cancelFromErrors =
    remaining.length === 0 && errors.some(isBareCancelError);
  const cancelFromResult =
    errors.length === 0 && isBareCancelError(resultText);
  if (!sessionLost && (cancelFromErrors || cancelFromResult)) {
    return { kind: "stop" };
  }

  const primary = remaining.slice(-3);
  const shown = [];
  const pushUnique = (line) => {
    if (!line || isBareCancelError(line)) return;
    if (shown.some((d) => d === line || d.includes(line) || line.includes(d))) {
      return;
    }
    shown.push(line);
  };
  for (const e of primary) pushUnique(e);
  if (!shown.length && resultText) pushUnique(resultText);
  for (const line of stderr) pushUnique(line);

  let text;
  if (
    looksGrokConfigCorrupt(shown.join("\n")) ||
    looksGrokConfigCorrupt(resultText)
  ) {
    text = grokConfigCorruptMessage();
  } else if (!shown.length) text = "Run error";
  else if (shown.length === 1) text = `Run error: ${shown[0]}`;
  else text = `Run error\n${shown.join("\n")}`;
  if (sessionLost) {
    text += "\nSession reset; the next message starts fresh.";
  }
  return { kind: "fail", text, sessionLost: Boolean(sessionLost) };
}

/**
 * Nonzero-exit copy. A grok config parse failure is a torn ~/.grok/config.toml,
 * not a generic "Run error (exit 1)" (#626 / #549).
 *
 * @param {number | null | undefined} code
 * @param {string} [stderr]
 * @returns {string}
 */
function formatRunExitError(code, stderr) {
  const stderrTail = String(stderr || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-8)
    .join("\n");
  if (looksGrokConfigCorrupt(stderrTail)) {
    return grokConfigCorruptMessage();
  }
  return stderrTail
    ? `Run error (exit ${code == null ? "?" : code}):\n${stderrTail}`
    : `Run error (exit ${code == null ? "?" : code})`;
}

/**
 * Claude children that outlive their active Map slot (result event clears the
 * run before process exit). stopAll reaps the process group with SIGTERM.
 * @type {Set<import('node:child_process').ChildProcess>}
 */
const liveClaudeChildren = new Set();

/**
 * @param {import('node:child_process').ChildProcess | null | undefined} child
 */
function trackLiveClaudeChild(child) {
  if (!child || typeof child.kill !== "function") return;
  liveClaudeChildren.add(child);
  const drop = () => {
    liveClaudeChildren.delete(child);
  };
  child.once("exit", drop);
  child.once("error", drop);
}

/**
 * Codex app-server pids that may outlive their `active` slot (writer-lock
 * leftover, killTree lag). Used to tell "ours" from Desktop on inspect.
 * @type {Set<number>}
 */
const liveCodexPids = new Set();

function trackLiveCodexPid(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return;
  liveCodexPids.add(n);
}

function dropLiveCodexPid(pid) {
  liveCodexPids.delete(Number(pid));
}

const ADJECTIVES = [
  "INTEGER",
  "COPPER",
  "SILENT",
  "RAPID",
  "CRIMSON",
  "NOBLE",
  "BRIGHT",
  "ANCIENT",
  "FROZEN",
  "GOLDEN",
  "HIDDEN",
  "VIVID",
  "QUIET",
  "STARK",
  "LUNAR",
  "SOLAR",
];

const NOUNS = [
  "SAFARI",
  "RIVER",
  "FORGE",
  "PULSE",
  "ORBIT",
  "LANTERN",
  "CIPHER",
  "MIRROR",
  "HAVEN",
  "SPARK",
  "ANCHOR",
  "NEXUS",
  "VECTOR",
  "PHOENIX",
  "COMPASS",
  "SUMMIT",
];

/**
 * Deterministic ADJECTIVE-NOUN from threadId hash.
 * @param {string} threadId
 * @returns {string}
 */
function workflowNameFromThreadId(threadId) {
  let h = 0;
  for (let i = 0; i < threadId.length; i++) {
    h = (Math.imul(31, h) + threadId.charCodeAt(i)) | 0;
  }
  const adj = ADJECTIVES[Math.abs(h) % ADJECTIVES.length];
  const noun = NOUNS[Math.abs(h >>> 8) % NOUNS.length];
  return `${adj}-${noun}`;
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
 * Map core Workflow + progress helpers to WorkflowView (ipc contract).
 * @param {object} workflow
 * @param {object} coreApi
 */
function mapWorkflowView(workflow, coreApi) {
  const progress = coreApi.workflowProgress(workflow);
  return {
    id: workflow.id,
    name: workflow.name,
    phases: workflow.phases.map((phase) => ({
      name: phase.name,
      pipelined: Boolean(phase.pipelined),
      agents: phase.agents.map((agent) => ({
        id: agent.id,
        model: agent.model,
        status: agent.status,
        tokensUsed: agent.tokensUsed,
      })),
    })),
    settled: progress.settled,
    total: progress.total,
    tokensTotal: progress.tokensTotal,
    complete: coreApi.isComplete(workflow),
  };
}

/**
 * Build a real-run WorkflowView (single phase, one agent).
 * Kept for generic agent path internal tracking; contract says workflow
 * is only for simulate, so pushDetail passes null for real providers.
 * @param {object} state
 */
function buildRealWorkflowView(state) {
  const tokensUsed = Math.ceil((state.charCount || 0) / 4);
  const agentStatus = state.agentStatus || "running";
  const settled =
    agentStatus === "settled" || agentStatus === "failed" ? 1 : 0;
  return {
    id: state.runId,
    name: state.name,
    phases: [
      {
        name: "run",
        pipelined: false,
        agents: [
          {
            id: "agent:0",
            model: state.model,
            status: agentStatus,
            tokensUsed,
          },
        ],
      },
    ],
    settled,
    total: 1,
    tokensTotal: tokensUsed,
    complete: settled === 1,
  };
}

/**
 * Resolve which provider handles this startRun.
 * Env overrides win for tests/smoke: CODER_SIMULATE, CODER_AGENT_CMD.
 * @param {object} thread
 */
function resolveProvider(thread) {
  if (process.env.CODER_SIMULATE === "1") return "simulate";
  if (process.env.CODER_AGENT_CMD) return "generic";
  const p = thread && thread.provider;
  if (p === "generic" || p === "simulate") return p;
  if (p && getProvider(p)) return p;
  return "claude";
}

/** Quota-wait resume and quota failover replay the same user turn. */
function isReplayTurn(input) {
  return Boolean(
    input && (input.fromQuotaWait === true || input.fromQuotaFailover === true),
  );
}

function providerBinAvailable(providerId) {
  const entry = getProvider(providerId);
  if (!entry || entry.kind === "simulate") return true;
  return isBinAvailable(resolveBin(entry));
}

/**
 * Ensure the provider CLI binary is available; throw a clear Error if not.
 * Across a boundary the CLI runs on the other side (the ssh host, or inside
 * the WSL distro), so a missing local binary is fine.
 * @param {import('./providers').ProviderEntry} entry
 * @param {{ remoteHost?: string, path?: string } | null} [project]
 */
function assertProviderBinary(entry, project) {
  if (crossesBoundary(project)) return;
  if (!entry || entry.kind === "simulate") return;
  const bin = resolveBin(entry);
  if (!isBinAvailable(bin)) {
    throw new Error(
      `Provider binary not found: ${bin}. Install it or set ${entry.binEnv || "the provider binary env var"}.`,
    );
  }
}

/**
 * Collapsed Cursor tool-card title. Claude already uses toolSummary so
 * Task shows `Task: <description>` instead of the args JSON. Cursor was
 * slicing the stringified blob, which made Sol's subagent `model` field
 * look like the parent session (issue #685).
 * @param {string} name
 * @param {string} input
 * @param {Record<string, unknown> | null} args
 */
function cursorToolCardSummary(name, input, args) {
  if (!args) {
    return input
      ? `${name}: ${input.length > 80 ? `${input.slice(0, 80)}…` : input}`
      : name;
  }
  let summary = toolSummary(name, args);
  if (
    (name === "Task" || name === "Agent") &&
    typeof args.model === "string" &&
    args.model
  ) {
    summary = `${summary} (${args.model})`;
  }
  return summary;
}

/**
 * Single spawn seam: when the project sits across a boundary — an ssh remote
 * or the WSL side of a Windows machine (#397) — spawn the wrapper with the
 * wrapped CLI argv instead of the local binary. Plain local projects are
 * unchanged. Across a boundary cwd is process.cwd(), because the project path
 * is not a directory this process can chdir into (another host, or a UNC
 * \\wsl$ path); the wrap carries the real directory itself.
 *
 * @param {{ remoteHost?: string, remotePath?: string, path?: string } | null} project
 * @param {string} binary
 * @param {string[]} args
 * @param {string} localCwd
 * @param {Record<string, string> | null | undefined} [env]  far-side `env KEY=value` via wrapCommand
 * @returns {{ binary: string, args: string[], cwd: string }}
 */
function resolveSpawn(project, binary, args, localCwd, env) {
  if (!crossesBoundary(project)) {
    return { binary, args, cwd: localCwd };
  }
  const wrapped = wrapCommand(project, binary, args, undefined, env);
  return { binary: wrapped.bin, args: wrapped.args, cwd: process.cwd() };
}

/**
 * True when this project's commands must run through a wrapper (ssh or
 * wsl.exe) rather than as a plain local child. The one predicate every
 * boundary-sensitive branch in the runner should use.
 * @param {{ remoteHost?: string, path?: string } | null | undefined} project
 */
function crossesBoundary(project) {
  return Boolean(project && (project.remoteHost || wslTarget(project)));
}

/**
 * Best-effort read of the shared per-repo index. A missing, corrupt, or
 * not-yet-implemented index must never break a dispatch.
 * @param {string} userDataPath
 * @param {string} repoRoot
 * @returns {import('./codeindex.js').CodeIndex | null}
 */
function tryReadCodeIndex(userDataPath, repoRoot) {
  try {
    return require("./codeindex.js").readIndex(userDataPath, repoRoot);
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {object} opts.core - @coder/core API
 * @param {(channel: string, payload: unknown) => void} opts.pushFn
 * @param {number} [opts.tickMs]
 * @param {typeof setInterval} [opts.setIntervalFn]
 * @param {typeof clearInterval} [opts.clearIntervalFn]
 * @param {() => number} [opts.now] - injectable clock (lane heartbeat, #346)
 * @param {string} [opts.userDataPath] - for memory auto-record
 * @param {() => { running: boolean, adopted: boolean, port: number | null }} [opts.getMemoryStatus]
 * @param {(opts: object) => Promise<{ text: string, source: string } | null>} [opts.askComplete] - Ask mode seam (issue #392)
 * @param {(query: string, projectPath: string) => Promise<object[]>} [opts.searchMemory] - Ask mode memory seam
 * @param {(projectPath: string) => Promise<object>} [opts.bootstrapMemory] - Prefetch memory_bootstrap (issue #710)
 */
function createRunner(opts) {
  const {
    store,
    core,
    pushFn,
    tickMs = 700,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    userDataPath = "",
    getMemoryStatus: getMemStatus = getMemoryStatus,
    askComplete = ask.completeAsk,
    searchMemory = null,
    bootstrapMemory = null,
    runAgentFn = runAgent,
    runCodexFn = runCodexAppServerTurn,
    inspectCodexWriterLockFn = inspectWriterLock,
    killWriterLockPidFn = killPidTree,
    // Null until main has finished simulator crash recovery, so it is resolved
    // per call rather than captured.
    getIosSimulator = () => null,
  } = opts;
  // Lane beats (#346). Missing this binding threw inside the heartbeat
  // try/catch, so lastBeat never moved and the wedge watchdog could
  // recycle a live run.
  const nowFn = typeof opts.now === "function" ? opts.now : () => Date.now();

  /**
   * @type {Map<string, object>}
   */
  const active = new Map();
  // OTel GenAI spans (issue #280). Inert while settings.otel.endpoint is null,
  // and every method swallows its own failures, so no call site below guards.
  const otel = createOtel({
    getSettings: () => store.getSettings().otel,
    getThread: (id) => store.getThread(id),
  });

  /**
   * Tool span start times, keyed `runId:toolId`. A tool_use and its result are
   * two separate stream events, so the start is only knowable at the first —
   * and only the adapters see it. Drained by noteToolSpan and clearRun.
   * @type {Map<string, number>}
   */
  const toolStartedAt = new Map();

  /**
   * Close the span for one tool call. Fire-and-forget; a tool whose start was
   * never seen gets a zero-duration span rather than an invented one.
   */
  function noteToolSpan(threadId, runId, toolId, name, isError) {
    if (!toolId || !runId) return;
    const key = `${runId}:${toolId}`;
    const startedAt = toolStartedAt.get(key);
    toolStartedAt.delete(key);
    const at = Date.now();
    otel.toolCall({
      threadId,
      runId,
      toolId: String(toolId),
      name: String(name || "tool"),
      startedAt: startedAt == null ? at : startedAt,
      endedAt: at,
      isError: Boolean(isError),
    });
  }

  /** Last known workflow (core Workflow or real state) per thread. */
  /** @type {Map<string, object>} */
  const lastWorkflowByThread = new Map();

  /**
   * Arrays as last pushed per thread, for the tail diff in pushDetail, plus
   * the push counter the renderer uses to spot dropped pushes. Holds element
   * references only (the arrays are store slices), never clones.
   * @type {Map<string, { messages: object[], workLog: object[], seq: number }>}
   */
  const lastPushByThread = new Map();

  /**
   * The run id this terminal belongs to. `active` is often already cleared by
   * the time a terminal is announced (stopRun clears before notifying), so
   * fall back to the caller's id and then to the last message this run wrote.
   * @param {string} threadId
   * @param {{ runId?: string | null }} extras
   */
  function resolveTerminalRunId(threadId, extras) {
    let runId =
      extras && extras.runId !== undefined
        ? extras.runId
        : active.get(threadId)
          ? active.get(threadId).runId
          : null;
    if (runId == null) {
      const msgs = store.getMessages(threadId) || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].runId) {
          runId = msgs[i].runId;
          break;
        }
      }
    }
    return runId;
  }

  /**
   * Retire a simulator recording this run started. The service decides what
   * matches and revokes it synchronously, so a manual recording or the next
   * run's recording is never stopped by a terminal that is not theirs.
   * @param {string} threadId
   * @param {string} status
   * @param {string | null} runId
   */
  function notifySimulatorRunTerminal(threadId, status, runId) {
    try {
      const simulator = getIosSimulator();
      if (!simulator || typeof simulator.onRunTerminal !== "function") return;
      void Promise.resolve(
        simulator.onRunTerminal({
          threadId: String(threadId),
          runId: runId == null ? null : String(runId),
          status,
        }),
      ).catch(() => {});
    } catch {
      // never affect the run path
    }
  }

  /**
   * Fire-and-forget memory record for a real run terminal. Never throws.
   * Skips simulate-provider runs.
   *
   * @param {string} threadId
   * @param {"done" | "failed" | "stopped"} status
   * @param {string} [text]
   * @param {object} [extras]
   * @param {string} [extras.provider]
   * @param {string | null} [extras.model]
   * @param {number} [extras.tokensIn]
   * @param {number} [extras.tokensOut]
   * @param {number} [extras.costUsd]
   * @param {boolean} [extras.skip] - force skip (simulate path)
   * @param {string | null} [extras.runId] - when set, only that run's msgs
   */
  function notifyRunTerminal(threadId, status, text, extras = {}) {
    // First, while the run identity is still recoverable: everything below
    // (checkpointing, crew sweeps, the queued drain) can append messages and
    // start the next turn.
    const terminalRunId = resolveTerminalRunId(threadId, extras);
    notifySimulatorRunTerminal(threadId, status, terminalRunId);
    // #1384: hidden consolidation passes report their outcome on the project.
    recordConsolidateOutcome(store, threadId, status, text);
    // Plan-mode CLIs without ExitPlanMode: persist an approval card from
    // the last assistant text before anything drains the type-ahead queue
    // (issue #707). Done and CLI-cancelled both count; a failed turn does not.
    if (status === "done" || status === "stopped") {
      maybePersistPlanApproval(threadId, text);
    }
    // Checkpoint first so every provider that signals done through here is
    // covered by one call site (generic/claude/codex/kimi/opencode/workflow).
    if (status === "done") {
      afterSuccessfulTurn(threadId);
    } else if (status === "failed") {
      const parked = store.getThread(threadId);
      if (
        parked &&
        (parked.status === "quota-wait" || parked.quotaFailoverPending === true)
      ) {
        // Parked on a reset clock, or mid quota-failover retry: not a
        // terminal failure. Skip orch wake-up, crew release, and the
        // queued drain — those belong to a real terminal.
      } else {
        afterFailedTurn(threadId);
      }
    } else {
      // stopped (and any other terminal): deliver notices that queued
      // while this thread was the orchestrator mid-run.
      try {
        flushOrchNotices(threadId);
      } catch {
        // silent
      }
      // A stopped orchestrator still tidies its crew (done/failed paths
      // sweep inside afterSuccessfulTurn/afterFailedTurn, which the sim
      // path calls directly without ever reaching notifyRunTerminal).
      sweepDoneWorkers(threadId);
    }
    try {
      if (extras && extras.skip) return;
      const thread = store.getThread(threadId);
      if (!thread) return;
      const provider =
        extras.provider != null ? String(extras.provider) : thread.provider;
      if (provider === "simulate") return;
      if (
        (status === "failed" || status === "stopped") &&
        !(
          status === "failed" &&
          (thread.status === "quota-wait" || thread.quotaFailoverPending === true)
        )
      ) {
        const model =
          (store.getUsage(threadId) && store.getUsage(threadId).model) ||
          thread.model ||
          "unknown";
        store.recordWastedSpend({
          provider,
          model,
          threadId,
          costUsd: extras.costUsd,
          projectId: thread.projectId,
          projectName: store.getProject(thread.projectId)?.name,
          title: thread.title,
        });
      }
      const project = store.getProject(thread.projectId);
      void recordRunOutcome(
        {
          thread,
          project,
          outcome: {
            status,
            text: text || "",
            provider,
            model:
              extras.model !== undefined ? extras.model : thread.model,
            tokensIn: extras.tokensIn,
            tokensOut: extras.tokensOut,
            costUsd: extras.costUsd,
          },
        },
        {
          userDataPath,
          getStatus: getMemStatus,
        },
      );
      // Session transcript: final assistant + tool messages once per terminal.
      // Re-resolved here rather than reusing the value taken on entry: the
      // steps above may have appended this run's messages.
      const resolvedRunId = resolveTerminalRunId(threadId, extras);
      recordSessionAtTerminal(threadId, resolvedRunId, thread);
      // One span close for every provider that signals done through here.
      if (resolvedRunId) {
        otel.endRun({
          threadId,
          runId: resolvedRunId,
          status: status === "done" || status === "failed" ? status : "stopped",
          error: status === "failed" ? text || "" : undefined,
          provider,
          model: extras.model !== undefined ? extras.model : thread.model,
          tokensIn: extras.tokensIn,
          tokensOut: extras.tokensOut,
          costUsd: extras.costUsd,
        });
      }
    } catch {
      // never affect the run path
    }
    // Remote #835 overlays are unused once this CLI exits. Reclaim before
    // a queued drain re-spawns (that turn re-deploys). Never throw.
    try {
      if (!(extras && extras.skip)) {
        const overlayThread = store.getThread(threadId);
        if (overlayThread && overlayThread.provider !== "simulate") {
          const { reclaimRemoteOverlays } = require("./remote-overlay.js");
          reclaimRemoteOverlays({ store, threadId });
        }
      }
    } catch {
      // housekeeping
    }
    // Verify restamps status "working"; skip so we don't start the queued
    // prompt on top of the gate. The verify settle path drains instead.
    // A parked quota-wait is not a terminal — don't drain onto it.
    // Failed and user-stopped turns must not auto-start a leftover
    // follow-up as if the work landed (issue #1203).
    const settled = store.getThread(threadId);
    if (
      status !== "failed" &&
      status !== "stopped" &&
      (!settled ||
        (settled.status !== "quota-wait" &&
          settled.quotaFailoverPending !== true))
    ) {
      maybeDrainQueued(threadId);
    }
  }

  /**
   * Deliver a type-ahead prompt that survived the just-finished turn
   * (issue #314). take-and-clear so the same prompt cannot fire twice.
   * On throw, put it back with error so the renderer can Retry.
   */
  async function drainQueued(threadId) {
    let taken;
    try {
      taken = services.takeQueued(store, { threadId });
    } catch {
      return;
    }
    if (!taken) return;
    try {
      await startRun({
        threadId,
        prompt: formatQueuedPrompt(taken),
        displayPrompt: taken.prompt,
        attachments: taken.attachments,
        fromThread: taken.fromThread || null,
        skipUserAppend: taken.posted === true,
        fromInbound: taken.inbound === true,
        fromQueue: true,
      });
    } catch (err) {
      store.updateThread(threadId, {
        queued: {
          ...taken,
          error: shortError(String((err && err.message) || err)),
        },
      });
      store.save();
      pushDetail(threadId);
      pushThreadsChanged();
    }
  }

  function maybeDrainQueued(threadId) {
    const thread = store.getThread(threadId);
    if (!thread || thread.status === "working") return;
    if (services.isTrashed(thread)) return;
    // A persisted plan card is a mode switch, not a message. Hold the
    // type-ahead until the user approves or keeps planning so a queued
    // "implement it" does not run still in plan mode (issue #707).
    if (thread.pendingPlan) return;
    const queued = thread.queued;
    if (queued && queued.inbound) {
      const { normalizeInboundPolicy } = require("./crossThread.js");
      const policy = normalizeInboundPolicy(thread.crossThreadInbound);
      if (policy === "queue-only") return;
      if (policy === "refuse") {
        try {
          services.setQueued(store, { threadId, prompt: null });
        } catch {
          /* ignore */
        }
        return;
      }
    }
    void drainQueued(threadId);
  }

  /**
   * Persist an inbound cross-thread card in the transcript now (issue #551),
   * so the receiver sees it while the current turn is still running.
   * @param {string} threadId
   * @param {{ text: string, fromThread?: { id: string, title?: string } | null }} payload
   */
  function appendInbound(threadId, payload) {
    if (!store.getThread(threadId)) return;
    appendMessage(
      threadId,
      "user",
      String(payload && payload.text ? payload.text : ""),
      null,
      null,
      null,
      payload && payload.fromThread
        ? { fromThread: payload.fromThread }
        : null,
    );
    pushDetail(threadId);
    pushThreadsChanged();
  }

  /**
   * Last assistant message text for a run (or any), for stop/partial bodies.
   * @param {string} threadId
   * @param {string | null} [runId]
   */
  function lastAssistantText(threadId, runId) {
    const msgs = store.getMessages(threadId) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "assistant") continue;
      if (runId && m.runId && m.runId !== runId) continue;
      return m.text || "";
    }
    return "";
  }

  /**
   * Activity stamp for the turn watchdog (issue #314). Persist lastEventAt
   * at most every ~5s so the write does not re-sort the sidebar (no touch)
   * on every stream chunk. Clearing a stall is always written — a live CLI
   * must drop the flag on the next event.
   */
  function stampLastEvent(threadId) {
    const thread = store.getThread(threadId);
    if (!thread) return;
    const now = Date.now();
    const lastStored = thread.lastEventAt;
    const clearingStall = thread.stalledAt != null;
    if (!clearingStall && lastStored != null && now - lastStored <= 5000) {
      return;
    }
    store.updateThread(threadId, {
      lastEventAt: now,
      ...(clearingStall ? { stalledAt: null } : {}),
    });
  }

  function pushDetail(threadId, workflow, opts) {
    // Deleted threads must not resurrect via late agent/sim pushes.
    if (threadId == null || !store.getThread(threadId)) {
      lastPushByThread.delete(threadId);
      return null;
    }
    // skipStamp: the stall sweep's own push must not count as activity
    // or it would clear stalledAt in the same turn it set it.
    if (active.has(threadId) && !(opts && opts.skipStamp)) {
      stampLastEvent(threadId);
    }
    if (workflow) {
      lastWorkflowByThread.set(threadId, workflow);
    }
    let view = null;
    if (workflow) {
      if (workflow.__orchestrated) {
        // Real multi-phase workflow: already a WorkflowView shape.
        view = workflowEngine.toPublicView(workflow);
      } else if (workflow.__real) {
        // Contract: workflow only for simulate / orchestrated
        view = null;
      } else if (
        workflow.__claude ||
        workflow.__codex ||
        workflow.__kimi ||
        workflow.__opencode ||
        workflow.__cursor ||
        workflow.__muse
      ) {
        view = null;
      } else {
        view = mapWorkflowView(workflow, core);
      }
    }
    // Background refresh must never stamp lastVisitedAt — only IPC threads:get
    // (user selection) marks a thread visited. See services.getThreadDetail.
    const detail = services.getThreadDetail(store, threadId, view, {
      markVisited: false,
      pendingPermission: getPendingPermission(threadId),
    });
    // Stream tails, not the transcript: this runs on every chunk and even
    // capped threads (store.js retention cap) are large. The renderer merges
    // (src/threadPatch.ts); a cap drop shifts every index, so the prefix diff
    // falls back to a full push, which the overflow slack keeps rare.
    const prev = lastPushByThread.get(threadId);
    const messagesFrom = firstChanged(prev && prev.messages, detail.messages);
    const workLogFrom = firstChanged(prev && prev.workLog, detail.workLog);
    const seq = (prev ? prev.seq : 0) + 1;
    // Retained per thread for the next diff; element refs are shared with the
    // store (getThreadDetail shallow-slices) and counts are bounded by the
    // store's per-thread retention caps, so this stays flat per thread.
    lastPushByThread.set(threadId, {
      messages: detail.messages,
      workLog: detail.workLog,
      seq,
    });
    pushFn("thread:updated", {
      ...detail,
      messages: detail.messages.slice(messagesFrom),
      messagesFrom,
      workLog: detail.workLog.slice(workLogFrom),
      workLogFrom,
      seq,
    });
    return detail;
  }

  function pushThreadsChanged() {
    pushFn("threads:changed", services.listThreads(store));
  }

  /**
   * Re-push the open thread's detail without waiting for the next stream
   * tick. Used by work_suggest so a chip appears as soon as the MCP tool
   * writes (issue #550). Keeps the last workflow so a mid-run refresh
   * does not blank the progress pane.
   * @param {string} threadId
   */
  function refreshDetail(threadId) {
    pushDetail(threadId, lastWorkflowByThread.get(threadId) || null);
  }

  /**
   * Persist the agent's todo list as the thread's plan (Planboard steps).
   * No-op when it parses to nothing or hasn't changed — this rides every
   * threads:changed push.
   * @param {string} threadId
   * @param {unknown} todos
   */
  function savePlanSteps(threadId, todos) {
    const steps = services.planStepsFrom(todos);
    if (!steps) return;
    const thread = store.getThread(threadId);
    if (!thread) return;
    if (JSON.stringify(thread.planSteps || null) === JSON.stringify(steps)) {
      return;
    }
    store.updateThread(threadId, { planSteps: steps });
    pushThreadsChanged();
  }

  /**
   * Create a work-log step item (done:false). Returns its id.
   * @param {string} threadId
   * @param {string} runId
   * @param {string} label
   */
  function beginWorkLogStep(threadId, runId, label) {
    const id = randomUUID();
    store.appendWorkLog(threadId, {
      id,
      runId,
      label,
      done: false,
      timestamp: Date.now(),
    });
    return id;
  }

  /**
   * Flip an existing work-log step to done:true.
   * @param {string} threadId
   * @param {string} itemId
   */
  function completeWorkLogStep(threadId, itemId) {
    if (!itemId) return;
    store.updateWorkLogItem(threadId, itemId, { done: true });
  }

  /**
   * Append a terminal work-log item (already done).
   * @param {string} threadId
   * @param {string} runId
   * @param {string} label
   */
  function appendDoneWorkLog(threadId, runId, label) {
    store.appendWorkLog(threadId, {
      id: randomUUID(),
      runId,
      label,
      done: true,
      timestamp: Date.now(),
    });
  }

  /**
   * @param {string} threadId
   * @param {string} role
   * @param {string} text
   * @param {string | null} [runId]
   * @param {object | null} [tool]
   * @param {{ kind: string, path: string, name: string }[] | null} [attachments]
   * @param {{ fromThread?: { id: string, title?: string } | null, thinking?: boolean, fromNotice?: boolean, steer?: boolean }} [extra]
   */
  function appendMessage(
    threadId,
    role,
    text,
    runId = null,
    tool = null,
    attachments = null,
    extra = null,
  ) {
    /** @type {{ id: string, role: string, text: string, createdAt: number, runId?: string, tool?: object, attachments?: object[], fromThread?: { id: string, title: string }, thinking?: boolean, fromNotice?: boolean, steer?: boolean }} */
    const msg = {
      id: randomUUID(),
      role,
      text,
      createdAt: Date.now(),
    };
    if (runId) msg.runId = runId;
    if (tool) msg.tool = tool;
    if (attachments && attachments.length) msg.attachments = attachments;
    if (extra && extra.thinking) msg.thinking = true;
    if (extra && extra.fromNotice === true) msg.fromNotice = true;
    if (extra && extra.steer === true) msg.steer = true;
    if (extra && extra.fromThread && extra.fromThread.id) {
      msg.fromThread = {
        id: String(extra.fromThread.id),
        title:
          extra.fromThread.title != null ? String(extra.fromThread.title) : "",
      };
    }
    store.appendMessage(threadId, msg);
    // Every adapter mints its tool messages here, so this is the one place
    // that sees a tool call begin. Kimi/opencode also emit already-complete
    // tools in a single event — those span immediately (see noteToolSpan).
    if (tool && tool.id && runId) {
      if (tool.done) {
        noteToolSpan(threadId, runId, tool.id, tool.name, tool.isError);
      } else {
        toolStartedAt.set(`${runId}:${tool.id}`, msg.createdAt);
      }
    }
    // Session mirror: user + event immediately; assistant/tool at terminal.
    recordSessionOnAppend(threadId, role, text);
    return msg.id;
  }

  /**
   * Persist screenshot blobs the adapter harvested from a tool result.
   * Claude does this inline in its tool_result handler; Cursor/Kimi stamp
   * `tool.images` on the parsed event and land here.
   * @param {string} threadId
   * @param {{ mediaType: string, data: string }[] | undefined} blobs
   * @returns {{ images: string[] } | {}}
   */
  function persistToolImages(threadId, blobs) {
    if (!blobs || !blobs.length) return {};
    const images = saveToolImages(userDataPath, blobs, threadId);
    return images.length ? { images } : {};
  }

  /**
   * Record one provider failure event, then park quota failures or mark failed.
   * @param {string} threadId
   * @param {string} errText
   * @param {string | null | undefined} runId
   * @param {object} [extraPatch]
   * @returns {{
   *   parked: boolean,
   *   until?: number,
   *   text: string,
   *   kind: "context-overflow" | "writer-lock" | "cli-upgrade" | null
   * }}
   */
  function markRunFailed(threadId, errText, runId, extraPatch) {
    const overflow = classifyContextOverflow(errText);
    const writerLock = overflow ? null : classifyWriterLock(errText);
    const upgrade = overflow || writerLock ? null : classifyCliUpgrade(errText);
    const classified = overflow || writerLock || upgrade;
    let text = classified ? classified.text : errText;
    const kind = classified ? classified.kind : null;
    if (writerLock) {
      const thread = store.getThread(threadId);
      const overlayHome =
        userDataPath && threadId
          ? path.join(userDataPath, "codex-homes", threadId)
          : "";
      const overlayExists =
        overlayHome && require("node:fs").existsSync(overlayHome);
      const inspect = inspectCodexWriterLockFn({
        sessionId: (thread && thread.sessionId) || null,
        errText,
        codexHome: overlayExists
          ? overlayHome
          : process.env.CODEX_HOME ||
            path.join(require("node:os").homedir(), ".codex"),
        ourPids: liveCodexPids,
      });
      if (releaseWriterLockHolder(inspect, killWriterLockPidFn)) {
        dropLiveCodexPid(inspect.holderPid);
      }
      const diag = formatWriterLockDiagnosis(inspect);
      if (diag) text = `${text}\n${diag}`;
    }
    if (!classified) {
      const switched = tryQuotaFailover(threadId, errText, runId, extraPatch);
      if (switched) return { parked: false, failover: true, text, kind: null };
    }
    const park = classified
      ? null
      : decideQuotaWait({
          text: errText,
          thread: store.getThread(threadId),
          settings: store.getSettings(),
        });
    if (park) {
      store.updateThread(
        threadId,
        {
          ...(extraPatch || {}),
          status: "quota-wait",
          runStartedAt: null,
          lastError: shortError(text),
          lastErrorKind: null,
          quotaWaitUntil: park.until,
        },
        { touch: true },
      );
      appendMessage(threadId, "event", text, runId);
      appendMessage(
        threadId,
        "event",
        `Quota wait: usage limit reached. Resuming at ${formatQuotaWaitClock(park.until)}.`,
      );
      scheduleQuotaWake(threadId, park.until);
      return { parked: true, until: park.until, text, kind: null };
    }
    store.updateThread(
      threadId,
      {
        ...(extraPatch || {}),
        status: "failed",
        runStartedAt: null,
        lastError: shortError(text),
        lastErrorKind: kind,
      },
      { touch: true },
    );
    appendMessage(threadId, "event", text, runId);
    return { parked: false, failover: false, text, kind };
  }

  /**
   * Track phase transitions for simulated work log (one item per phase).
   * @param {string} threadId
   * @param {string} runId
   * @param {object} workflow
   * @param {Map<string, string>} phaseItemIds
   * @param {Set<string>} phaseSettled
   */
  function notePhaseEvents(threadId, runId, workflow, phaseItemIds, phaseSettled) {
    for (const phase of workflow.phases) {
      const hasRunning = phase.agents.some((a) => a.status === "running");
      const allTerminal = phase.agents.every(
        (a) => a.status === "settled" || a.status === "failed",
      );

      if (hasRunning && !phaseItemIds.has(phase.name)) {
        const id = beginWorkLogStep(
          threadId,
          runId,
          capitalize(phase.name),
        );
        phaseItemIds.set(phase.name, id);
      }

      if (
        allTerminal &&
        phase.agents.length > 0 &&
        !phaseSettled.has(phase.name)
      ) {
        phaseSettled.add(phase.name);
        completeWorkLogStep(threadId, phaseItemIds.get(phase.name));
      }
    }
  }

  function finishSuccessSim(threadId, runId, workflow) {
    const progress = core.workflowProgress(workflow);
    const phaseNames = workflow.phases.map((p) => p.name).join(", ");
    const agentCount = progress.total;
    const text = [
      `Run complete: workflow ${workflow.name}.`,
      `Phases: ${phaseNames}.`,
      `Agents: ${agentCount}.`,
      `Total tokens: ${progress.tokensTotal}.`,
    ].join(" ");

    appendMessage(threadId, "assistant", text, runId);
    store.updateThread(
      threadId,
      { status: "done", runStartedAt: null },
      { touch: true },
    );
    store.save();
    pushDetail(threadId, workflow);
    pushThreadsChanged();
    // Sim path does not call notifyRunTerminal; still checkpoint on success.
    afterSuccessfulTurn(threadId);
  }

  function clearRun(threadId) {
    const entry = active.get(threadId);
    if (!entry) return;
    if (typeof entry.flushStream === "function") {
      entry.flushStream();
    }
    if (entry.timer) {
      clearIntervalFn(entry.timer);
    }
    if (entry.ackTimer) {
      clearTimeout(entry.ackTimer);
      entry.ackTimer = null;
    }
    if (typeof entry.discardHeldPhantom === "function") {
      entry.discardHeldPhantom();
    }
    // A run killed mid-tool leaves start times nothing will ever close.
    if (entry.runId) {
      const prefix = `${entry.runId}:`;
      for (const key of toolStartedAt.keys()) {
        if (key.startsWith(prefix)) toolStartedAt.delete(key);
      }
    }
    active.delete(threadId);
    const thread = store.getThread(threadId);
    if (entry.kind === "codex") {
      if (entry.handle && entry.handle.pid) dropLiveCodexPid(entry.handle.pid);
      noteCodexRelease(
        (entry.sessionId != null && entry.sessionId) ||
          (thread && thread.sessionId) ||
          null,
      );
    }
    if (thread && (thread.stalledAt != null || thread.lastEventAt != null)) {
      store.updateThread(threadId, { stalledAt: null, lastEventAt: null });
    }
  }

  /**
   * True when this launch must not spawn: Stop already ran, a newer run
   * replaced us, the thread is gone, archived, or in Recently deleted.
   * #1228: first-turn prefetch used to sit outside `active`.
   */
  function launchWasCancelled(threadId, runId) {
    const entry = active.get(threadId);
    if (!entry || entry.runId !== runId || entry.stopping) return true;
    const thread = store.getThread(threadId);
    if (!thread || thread.archived || services.isTrashed(thread)) return true;
    return false;
  }

  /**
   * Finish a cancelled pre-spawn launch. stopRun may already have cleared
   * us; this is the post-await path for archive / delete / gone. A newer
   * run on the same thread is left alone.
   */
  function settleCancelledLaunch(threadId, runId) {
    const entry = active.get(threadId);
    if (entry && entry.runId !== runId) return;
    if (entry) {
      if (entry.kind === "generic" || entry.kind === "real") {
        completeWorkLogStep(threadId, entry.startingId);
        completeWorkLogStep(threadId, entry.respondingId);
      } else if (
        entry.kind === "claude" ||
        entry.kind === "codex" ||
        entry.kind === "kimi" ||
        entry.kind === "opencode" ||
        entry.kind === "cursor" ||
        entry.kind === "muse" ||
        entry.kind === "preparing"
      ) {
        completeWorkLogStep(threadId, entry.startingId);
        completeWorkLogStep(threadId, entry.workingId);
      } else if (
        (entry.kind === "sim" || entry.kind === "workflow") &&
        entry.phaseItemIds
      ) {
        for (const id of entry.phaseItemIds.values()) {
          completeWorkLogStep(threadId, id);
        }
      }
      clearRun(threadId);
    }
    const thread = store.getThread(threadId);
    if (!thread || thread.status !== "working") return;
    appendMessage(threadId, "event", "Run stopped", runId);
    appendDoneWorkLog(threadId, runId, "Run stopped");
    store.updateThread(
      threadId,
      { status: "idle", runStartedAt: null, stoppedAt: Date.now() },
      { touch: true },
    );
    store.save();
    pushDetail(threadId, lastWorkflowByThread.get(threadId) || null);
    pushThreadsChanged();
  }

  function abortIfCancelled(threadId, runId) {
    if (!launchWasCancelled(threadId, runId)) return false;
    settleCancelledLaunch(threadId, runId);
    return true;
  }

  /**
   * Upgrade the preparing `active` entry in place. No second active.set:
   * Stop holds the same object and sets `stopping` on it.
   * @returns {object | null}
   */
  function claimPreparingRun(threadId, runId, fields) {
    if (launchWasCancelled(threadId, runId)) return null;
    const existing = active.get(threadId);
    if (!existing || existing.runId !== runId) return null;
    Object.assign(existing, fields);
    return existing;
  }

  function stampPreparingSteps(threadId, runId, steps) {
    const pending = active.get(threadId);
    if (pending && pending.runId === runId) Object.assign(pending, steps);
  }

  /**
   * Start a simulated multi-phase @coder/core ticker run.
   */
  function startSimulatedRun(threadId, prompt, runId, name) {
    if (abortIfCancelled(threadId, runId)) return { runId };
    const workflow = core.createWorkflow({
      id: runId,
      name,
      phases: [
        { name: "seed", agentCount: 1 },
        { name: "analyze", agentCount: 4 },
        { name: "verify", agentCount: 4, pipelined: true },
        { name: "judge", agentCount: 3 },
        { name: "synthesize", agentCount: 1 },
      ],
    });

    store.save();
    pushThreadsChanged();

    /** @type {Map<string, string>} */
    const phaseItemIds = new Map();
    const phaseSettled = new Set();

    notePhaseEvents(threadId, runId, workflow, phaseItemIds, phaseSettled);
    pushDetail(threadId, workflow);

    let current = workflow;

    const timer = setIntervalFn(() => {
      try {
        current = core.tick(current);
        notePhaseEvents(threadId, runId, current, phaseItemIds, phaseSettled);
        store.save();
        pushDetail(threadId, current);

        if (core.isComplete(current)) {
          clearRun(threadId);
          finishSuccessSim(threadId, runId, current);
          return;
        }

        if (core.isFailed(current) || core.isStuck(current)) {
          clearRun(threadId);
          const errLabel = core.isFailed(current)
            ? "Run failed"
            : "Run stuck and cannot progress";
          store.updateThread(
            threadId,
            {
              status: "failed",
              runStartedAt: null,
              lastError: shortError(errLabel),
            },
            { touch: true },
          );
          appendMessage(threadId, "event", errLabel, runId);
          appendDoneWorkLog(threadId, runId, "Run error");
          store.save();
          pushDetail(threadId, current);
          pushThreadsChanged();
          afterFailedTurn(threadId);
        }
      } catch (err) {
        clearRun(threadId);
        const errText = `Run error: ${err && err.message ? err.message : String(err)}`;
        markRunFailed(threadId, errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, current);
        pushThreadsChanged();
        afterFailedTurn(threadId);
      }
    }, tickMs);

    const entry = claimPreparingRun(threadId, runId, {
      kind: "sim",
      timer,
      phaseItemIds,
      phaseSettled,
    });
    if (!entry) {
      clearIntervalFn(timer);
      settleCancelledLaunch(threadId, runId);
      return { runId };
    }
    Object.defineProperty(entry, "workflow", {
      get() {
        return current;
      },
      enumerable: true,
      configurable: true,
    });

    return { runId };
  }

  /**
   * Start a real generic agent child-process run (CODER_AGENT_CMD).
   */
  function startGenericRun(threadId, prompt, runId, name) {
    if (abortIfCancelled(threadId, runId)) return { runId };
    const thread = store.getThread(threadId);
    const project = store.getProject(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project for thread: ${threadId}`);
    }

    const { command, args } = parseAgentCommand(process.env.CODER_AGENT_CMD);
    const model = path.basename(command);

    /** Mutable real-run state (also used as lastWorkflow source). */
    const realState = {
      __real: true,
      runId,
      name,
      model,
      agentStatus: "running",
      charCount: 0,
    };

    const startingId = beginWorkLogStep(threadId, runId, "Starting agent");
    const respondingId = beginWorkLogStep(threadId, runId, "Agent responding");
    stampPreparingSteps(threadId, runId, { startingId, respondingId });

    store.save();
    pushThreadsChanged();
    pushDetail(threadId, realState);

    /** @type {string | null} */
    let assistantMsgId = null;
    /** Latest streamed text not yet written to the store. */
    let pendingText = null;
    let lastPushAt = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let pushTimer = null;

    const localCwd = thread.worktreePath || project.path;

    const entry = claimPreparingRun(threadId, runId, {
      kind: "generic",
      startingId,
      respondingId,
      realState,
    });
    if (!entry) {
      completeWorkLogStep(threadId, startingId);
      completeWorkLogStep(threadId, respondingId);
      settleCancelledLaunch(threadId, runId);
      return { runId };
    }
    Object.defineProperty(entry, "workflow", {
      get() {
        return realState;
      },
      enumerable: true,
      configurable: true,
    });

    function guard() {
      const e = active.get(threadId);
      if (!e || e.stopping || e.runId !== runId) return null;
      if (e.kind !== "generic") return null;
      return e;
    }

    function applyPendingText() {
      if (pendingText == null) return;
      const text = pendingText;
      pendingText = null;
      realState.charCount = text.length;
      if (!assistantMsgId) {
        assistantMsgId = appendMessage(threadId, "assistant", text, runId);
      } else {
        store.updateMessage(threadId, assistantMsgId, { text });
      }
    }

    function cancelPushTimer() {
      if (pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = null;
      }
    }

    function flushPush() {
      pushTimer = null;
      lastPushAt = Date.now();
      applyPendingText();
      if (!guard()) return;
      store.save();
      pushDetail(threadId, realState);
    }

    function throttledPush() {
      const now = Date.now();
      const elapsed = now - lastPushAt;
      if (elapsed >= PUSH_THROTTLE_MS) {
        cancelPushTimer();
        flushPush();
        return;
      }
      if (!pushTimer) {
        pushTimer = setTimeout(flushPush, PUSH_THROTTLE_MS - elapsed);
      }
    }

    // Stop/error/clearRun must land pending text before the terminal push.
    entry.flushStream = () => {
      cancelPushTimer();
      applyPendingText();
    };

    const crossing = crossesBoundary(project);
    const spawn = crossing
      ? resolveSpawn(project, command, [...args, String(prompt ?? "")], localCwd)
      : { binary: command, args, cwd: localCwd };
    if (abortIfCancelled(threadId, runId)) return { runId };
    const handle = runAgentFn({
      command: spawn.binary,
      args: spawn.args,
      prompt,
      appendPrompt: !crossing,
      cwd: spawn.cwd,
      onChunk: (text) => {
        if (!guard()) return;
        realState.charCount = text.length;
        pendingText = text;
        throttledPush();
      },
      onDone: (exitCode, fullText, stderrText) => {
        cancelPushTimer();
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "generic") return;

        if (fullText && fullText.length > 0) {
          pendingText = fullText;
        }
        applyPendingText();

        clearRun(threadId);

        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.respondingId);

        if (exitCode === 0) {
          realState.agentStatus = "settled";
          store.updateThread(
            threadId,
            { status: "done", runStartedAt: null },
            { touch: true },
          );
          store.save();
          pushDetail(threadId, realState);
          pushThreadsChanged();
          notifyRunTerminal(
            threadId,
            "done",
            fullText || lastAssistantText(threadId, runId),
          );
          return;
        }

        realState.agentStatus = "failed";
        const errText = formatRunExitError(exitCode, stderrText);
        const failure = markRunFailed(threadId, errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, realState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", failure.text);
      },
      onError: (err) => {
        cancelPushTimer();
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "generic") return;

        applyPendingText();
        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.respondingId);
        realState.agentStatus = "failed";
        const msg = err && err.message ? err.message : String(err);
        const errText = `Run error: ${msg}`;
        const failure = markRunFailed(threadId, errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, realState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", failure.text);
      },
    });

    entry.handle = handle;
    completeWorkLogStep(threadId, startingId);
    store.save();
    pushDetail(threadId, realState);

    return { runId };
  }

  /**
   * Start a Claude Code stream-json session turn.
   * @param {string} threadId
   * @param {string} prompt
   * @param {string} runId
   * @param {import('./providers').ProviderEntry} [providerEntry]
   */
  async function startClaudeRun(threadId, prompt, runId, providerEntry) {
    if (abortIfCancelled(threadId, runId)) return { runId };
    const thread = store.getThread(threadId);
    const project = store.getProject(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project for thread: ${threadId}`);
    }

    const entryDef = providerEntry || getProvider("claude");
    assertProviderBinary(entryDef, project);

    const claudeState = {
      __claude: true,
      runId,
    };

    const startingId = beginWorkLogStep(threadId, runId, "Starting agent");
    const workingId = beginWorkLogStep(threadId, runId, "Agent working");
    stampPreparingSteps(threadId, runId, { startingId, workingId });

    store.save();
    pushThreadsChanged();
    pushDetail(threadId, claudeState);

    /** @type {string | null} */
    let assistantMsgId = null;
    /** @type {string} */
    let assistantText = "";
    /** tool_use id -> message id */
    /** @type {Map<string, string>} */
    const toolMsgById = new Map();
    /** Tool ids we already posted a #812 Guardrail event for. */
    const grokGuardrailNoticed = new Set();
    /** @type {string | null} */
    let capturedModel = null;
    /** @type {string | null} */
    let capturedSessionId = thread.sessionId || null;
    let sawResult = false;
    let sawTurnContent = false;
    /** @type {object | null} */
    let heldPhantom = null;
    /** Run-local usage for memory footers (not cumulative store totals). */
    const runUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

    function discardHeldPhantom() {
      heldPhantom = null;
    }

    function markTurnContent() {
      sawTurnContent = true;
      discardHeldPhantom();
    }

    /** @type {string | null} */
    let thinkingMsgId = null;
    /** @type {string} */
    let thinkingText = "";
    let partialText = false;
    let partialThinking = false;
    /** @type {Map<number, { toolId: string, json: string, name: string }>} */
    const partialTools = new Map();
    /** @type {ReturnType<typeof setTimeout> | null} */
    let partialPushTimer = null;

    function schedulePartialPush() {
      if (partialPushTimer) return;
      partialPushTimer = setTimeout(() => {
        partialPushTimer = null;
        if (!guard()) return;
        store.save();
        pushDetail(threadId, claudeState);
      }, PUSH_THROTTLE_MS);
    }

    function flushPartialPush() {
      if (partialPushTimer) {
        clearTimeout(partialPushTimer);
        partialPushTimer = null;
      }
      store.save();
      pushDetail(threadId, claudeState);
    }

    function upsertThinking() {
      const text = truncate(thinkingText, THINKING_TRUNCATE);
      const body = text || "Thinking…";
      if (!thinkingMsgId) {
        if (!thinkingText) return;
        thinkingMsgId = appendMessage(
          threadId,
          "event",
          body,
          runId,
          null,
          null,
          { thinking: true },
        );
        return;
      }
      store.updateMessage(threadId, thinkingMsgId, { text: body });
    }

    function formatToolInput(input) {
      if (typeof input === "string") return truncate(input, INPUT_TRUNCATE);
      try {
        return truncate(JSON.stringify(input, null, 2), INPUT_TRUNCATE);
      } catch {
        return truncate(String(input), INPUT_TRUNCATE);
      }
    }

    /**
     * Create or update a tool card. Side effects (todos, questions, subagents)
     * run only when the row is first created.
     * @param {{ id?: unknown, name?: unknown, input?: unknown }} block
     * @returns {string}
     */
    function ingestToolUse(block) {
      const toolId = String(block.id || randomUUID());
      const toolName = String(block.name || "tool");
      const inputRaw = block.input != null ? block.input : {};
      const inputObj =
        inputRaw && typeof inputRaw === "object" && !Array.isArray(inputRaw)
          ? inputRaw
          : {};
      const inputStr = formatToolInput(inputRaw);
      const summary = toolSummary(
        toolName,
        inputRaw && typeof inputRaw === "object" ? inputRaw : {},
      );
      const existingId = toolMsgById.get(toolId);
      if (existingId) {
        const existing = store
          .getMessages(threadId)
          .find((m) => m.id === existingId);
        if (existing && existing.tool) {
          store.updateMessage(threadId, existingId, {
            text: summary,
            tool: { ...existing.tool, name: toolName, input: inputStr },
          });
        }
        if (toolName === "TodoWrite") {
          savePlanSteps(threadId, inputObj.todos);
        }
        if (toolName === "ask_user_question") {
          try {
            askUser({ threadId, questions: inputObj.questions });
          } catch {
            // Unanswerable shape: the tool card still shows what was asked.
          }
        }
        return toolId;
      }
      markTurnContent();
      const tool = {
        id: toolId,
        name: toolName,
        input: inputStr,
        output: null,
        isError: false,
        done: false,
      };
      const msgId = appendMessage(threadId, "tool", summary, runId, tool);
      toolMsgById.set(toolId, msgId);
      if (entryDef.id === "grok" && !grokGuardrailNoticed.has(toolId)) {
        const notice = grokGuardrailNotice({
          toolName,
          input: inputObj,
          worktreePath: thread.worktreePath || project.path,
        });
        if (notice) {
          grokGuardrailNoticed.add(toolId);
          appendMessage(threadId, "event", notice, runId);
        }
      }
      if (toolName === "TodoWrite") {
        savePlanSteps(threadId, inputObj.todos);
      }
      if (toolName === "ask_user_question") {
        try {
          askUser({ threadId, questions: inputObj.questions });
        } catch {
          // Unanswerable shape: the tool card still shows what was asked.
        }
      }
      if (toolName === "Agent" || toolName === "Task") {
        addSubagentRow(threadId, {
          id: toolId,
          description:
            typeof inputObj.description === "string" && inputObj.description
              ? inputObj.description
              : summary,
          agentType:
            typeof inputObj.subagent_type === "string"
              ? inputObj.subagent_type
              : null,
          status: "running",
        });
      }
      assistantMsgId = null;
      assistantText = "";
      return toolId;
    }

    function upsertAssistantText() {
      if (!assistantText) return;
      if (!assistantMsgId) {
        assistantMsgId = appendMessage(
          threadId,
          "assistant",
          assistantText,
          runId,
        );
      } else {
        store.updateMessage(threadId, assistantMsgId, { text: assistantText });
      }
    }

    /**
     * @param {object} p
     * @returns {boolean} true when consumed as a partial
     */
    function applyPartial(p) {
      if (!p || typeof p !== "object") return false;
      const ptype = p.type;
      if (ptype === "message_start") {
        thinkingMsgId = null;
        thinkingText = "";
        assistantMsgId = null;
        assistantText = "";
        partialText = false;
        partialThinking = false;
        return true;
      }
      if (ptype === "content_block_start") {
        const block = p.content_block && typeof p.content_block === "object"
          ? p.content_block
          : {};
        const index = p.index;
        if (block.type === "thinking" || block.type === "redacted_thinking") {
          thinkingText =
            typeof block.thinking === "string" ? block.thinking : "";
          partialThinking = true;
          if (thinkingText) upsertThinking();
          flushPartialPush();
        } else if (block.type === "tool_use") {
          const toolId = ingestToolUse(block);
          partialTools.set(Number(index), {
            toolId,
            json: "",
            name: String(block.name || "tool"),
          });
          flushPartialPush();
        } else if (block.type === "text") {
          partialText = true;
          if (typeof block.text === "string" && block.text) {
            markTurnContent();
            assistantText += block.text;
            upsertAssistantText();
          }
          flushPartialPush();
        }
        return true;
      }
      if (ptype === "content_block_delta") {
        const delta = p.delta && typeof p.delta === "object" ? p.delta : {};
        const index = p.index;
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          partialThinking = true;
          thinkingText += delta.thinking;
          upsertThinking();
          markTurnContent();
          schedulePartialPush();
        } else if (delta.type === "text_delta" && typeof delta.text === "string") {
          partialText = true;
          if (delta.text) markTurnContent();
          assistantText += delta.text;
          upsertAssistantText();
          schedulePartialPush();
        } else if (
          delta.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          const slot = partialTools.get(Number(index));
          if (slot) {
            slot.json += delta.partial_json;
            let input = slot.json;
            try {
              input = JSON.parse(slot.json);
            } catch {
              // incomplete JSON: show the raw fragment
            }
            ingestToolUse({ id: slot.toolId, name: slot.name, input });
            schedulePartialPush();
          }
        }
        return true;
      }
      if (ptype === "content_block_stop") {
        const slot = partialTools.get(Number(p.index));
        if (slot && slot.json) {
          let input = slot.json;
          try {
            input = JSON.parse(slot.json);
          } catch {
            // keep raw
          }
          ingestToolUse({ id: slot.toolId, name: slot.name, input });
          partialTools.delete(Number(p.index));
          flushPartialPush();
        }
        return true;
      }
      if (ptype === "message_delta" || ptype === "message_stop") {
        return true;
      }
      return false;
    }

    const localCwd = thread.worktreePath || project.path;
    const binary = resolveBin(entryDef);
    const args = entryDef.buildArgs({
      prompt,
      sessionId: thread.sessionId || null,
      permissionMode: thread.permissionMode || "default",
      model: thread.model || null,
      reasoningEffort: thread.reasoningEffort || null,
      webSearch: thread.webSearch === true,
    });
    // Claude runs interactively: prompt over stdin, permission prompts via
    // the control protocol. Other claude-stream providers (e.g. grok) keep
    // the argv prompt and their own MCP injection.
    const interactive = entryDef.id === "claude";
    const mcpArgs = getClaudeMcpArgs({
      projectPath: localCwd,
      projectId: thread.projectId,
      memoryOnly: thread.memoryConsolidate === true,
    });
    if (interactive) {
      // No trailing prompt in interactive argv, so appending is safe.
      args.push(...mcpArgs);
    }
    /** @type {NodeJS.ProcessEnv | undefined} */
    let grokHomeEnv;
    if (entryDef.id === "grok") {
      // Isolated GROK_HOME so this turn cannot inherit other projects'
      // MCP URLs or a user-global last-write-wins bind (issue #706).
      // Remote homes are deployed on the far side of SSH/WSL.
      if (userDataPath || crossesBoundary(project)) {
        try {
          const os = require("node:os");
          const dest = crossesBoundary(project)
            ? deployGrokGuardrailOverlay({
                project,
                threadId,
                sessionId: thread.sessionId || null,
              })
            : path.join(userDataPath, "grok-homes", threadId);
          if (!crossesBoundary(project)) {
            const sourceHome =
              process.env.GROK_HOME || path.join(os.homedir(), ".grok");
            materializeGrokHome({
              dest,
              sourceHome,
              sessionId: thread.sessionId || null,
              mcpServers: kimiMcpServersForRun({
                projectId: thread.projectId,
                projectPath: localCwd || project.path,
              }),
            });
          }
          grokHomeEnv = {
            GROK_HOME: dest,
            GROK_CLAUDE_MCPS_ENABLED: "false",
            GROK_CURSOR_MCPS_ENABLED: "false",
          };
        } catch (err) {
          completeWorkLogStep(threadId, startingId);
          completeWorkLogStep(threadId, workingId);
          const msg =
            "Grok MCP overlay failed: " +
            (err && err.message ? err.message : String(err));
          const failure = markRunFailed(threadId, msg, runId);
          appendDoneWorkLog(threadId, runId, "Run error");
          store.save();
          pushDetail(threadId, claudeState);
          pushThreadsChanged();
          notifyRunTerminal(threadId, "failed", failure.text);
          clearRun(threadId);
          return { runId };
        }
      } else {
        try {
          ensureGrokMcpConfig({
            projectPath: localCwd,
            projectId: thread.projectId,
          });
          await whenGrokMcpIdle();
        } catch {
          // Legacy path without userDataPath; failures stay on the MCP queue logs.
        }
      }
    }
    const spawn = resolveSpawn(project, binary, args, localCwd, grokHomeEnv);

    if (abortIfCancelled(threadId, runId)) return { runId };
    const entry = claimPreparingRun(threadId, runId, {
      kind: "claude",
      startingId,
      workingId,
      claudeState,
      runUsage,
      discardHeldPhantom,
      /**
       * Permission prompts awaiting a user decision, oldest first. Each is
       * { id, toolName, summary, input (pretty), rawInput (original object),
       *   guardrail?: { rule, reason } }.
       * Ephemeral: dies with the run entry; a killed CLI cannot be answered.
       */
      pendingPermissions: [],
    });
    if (!entry) {
      completeWorkLogStep(threadId, startingId);
      completeWorkLogStep(threadId, workingId);
      settleCancelledLaunch(threadId, runId);
      return { runId };
    }
    Object.defineProperty(entry, "workflow", {
      get() {
        return claudeState;
      },
      enumerable: true,
      configurable: true,
    });

    function guard() {
      const e = active.get(threadId);
      if (!e || e.stopping || e.runId !== runId) return null;
      if (e.kind !== "claude") return null;
      return e;
    }

    /** Held empty leftover result never produced a turn. Surface a failure. */
    function failEmptyPhantom(ev) {
      sawResult = true;
      discardHeldPhantom();
      if (!guard()) return;
      completeWorkLogStep(threadId, startingId);
      completeWorkLogStep(threadId, workingId);
      if (ev && typeof ev.session_id === "string" && ev.session_id) {
        capturedSessionId = ev.session_id;
      }
      const failText = "Run error: no output from agent";
      const failure = markRunFailed(threadId, failText, runId, {
        sessionId: capturedSessionId,
      });
      appendDoneWorkLog(threadId, runId, "Run error");
      store.save();
      clearRun(threadId);
      scheduleClaudeIdleReap(threadId);
      pushDetail(threadId, claudeState);
      pushThreadsChanged();
      notifyRunTerminal(threadId, "failed", failure.text, {
        tokensIn: runUsage.tokensIn,
        tokensOut: runUsage.tokensOut,
        costUsd: runUsage.costUsd,
      });
    }

    /** Assigned below (reused or freshly spawned) before any event fires. */
    let handle;
    /** This turn was delivered to a kept-alive CLI instead of a new spawn. */
    let reused = false;
    /** Any event at all reached this turn (the CLI is really taking it). */
    let sawAnyEvent = false;
    /** The dead-reuse respawn below fires at most once per turn. */
    let respawned = false;

    function disarmAck() {
      const e = active.get(threadId);
      if (e && e.ackTimer) {
        clearTimeout(e.ackTimer);
        e.ackTimer = null;
      }
    }

    const onEvent = (ev) => {
        sawAnyEvent = true;
        disarmAck();
        const type = ev && ev.type;

        // Background-subagent task notifications can land between turns on a
        // kept-alive CLI (guard() is null then), so scan user text first.
        ingestTaskNotifications(threadId, ev, claudeState);

        if (!guard()) {
          // Kept-alive CLI, no active turn (settling/idle): never leave a
          // permission request hanging or aborted — answer with an error the
          // agent can retry, distinct from a user deny ("Denied by user").
          if (type === "control_request" && ev.request_id && handle) {
            handle.respondError(
              String(ev.request_id),
              "No active turn in Solenta (run settling); retry on the next turn",
            );
          }
          return;
        }

        const partial = unwrapStreamEvent(ev);
        if (partial && applyPartial(partial)) return;

        if (type === "control_request") {
          const requestId = String(ev.request_id || "");
          const request = ev.request || {};
          if (request.subtype === "can_use_tool" && requestId) {
            const toolName = String(request.tool_name || "tool");
            const rawInput =
              request.input && typeof request.input === "object"
                ? request.input
                : {};
            let inputStr;
            try {
              inputStr = truncate(
                JSON.stringify(rawInput, null, 2),
                INPUT_TRUNCATE,
              );
            } catch {
              inputStr = truncate(String(rawInput), INPUT_TRUNCATE);
            }
            const e = guard();
            if (!e) return;
            markTurnContent();

            // #409: deny is answered here so an injected agent cannot
            // social-engineer a yes. classifyTool fails open; wrap anyway.
            /** @type {{ decision: string, rule: string | null, reason: string } | null} */
            let verdict = null;
            try {
              const live = store.getThread(threadId);
              const worktreePath =
                (live && live.worktreePath) ||
                (thread && thread.worktreePath) ||
                null;
              verdict = classifyTool({
                toolName,
                input: rawInput,
                worktreePath,
              });
            } catch {
              verdict = null;
            }

            if (verdict && verdict.decision === "deny") {
              const rule = verdict.rule || "policy";
              const reason = verdict.reason || "blocked";
              handle.respond(requestId, {
                behavior: "deny",
                message: `Blocked by Solenta guardrails (${rule}): ${reason}`,
              });
              appendMessage(
                threadId,
                "event",
                `Guardrail blocked ${toolName}: ${rule}: ${reason}`,
                e.runId,
              );
              store.save();
              pushDetail(threadId, claudeState);
              return;
            }

            if (
              thread.memoryConsolidate === true &&
              !isMemoryConsolidateTool(toolName)
            ) {
              handle.respond(requestId, {
                behavior: "deny",
                message:
                  "Memory consolidation may only call coder-memory tools",
              });
              appendMessage(
                threadId,
                "event",
                `Consolidation sandbox blocked ${toolName}`,
                e.runId,
              );
              store.save();
              pushDetail(threadId, claudeState);
              return;
            }

            const pending = {
              id: requestId,
              toolName,
              summary: toolSummary(toolName, rawInput),
              input: inputStr,
              rawInput,
            };
            if (verdict && verdict.decision === "ask") {
              pending.guardrail = {
                rule: verdict.rule,
                reason: verdict.reason,
              };
            }
            e.pendingPermissions.push(pending);
            if (e.pendingPermissions.length === 1) {
              // Run is now blocked on the user: flip the sidebar badge to
              // Waiting. touch: a prompt is real activity (drives unread).
              store.updateThread(
                threadId,
                { awaitingInput: true },
                { touch: true },
              );
              pushThreadsChanged();
            }
            pushDetail(threadId, claudeState);
          } else if (requestId) {
            // Unknown control request: answer so the CLI never hangs on us.
            handle.respondError(
              requestId,
              `Unsupported control request: ${String(request.subtype || "unknown")}`,
            );
          }
          return;
        }

        if (type === "system" && ev.subtype === "init") {
          if (typeof ev.session_id === "string" && ev.session_id) {
            capturedSessionId = ev.session_id;
            store.updateThread(threadId, { sessionId: ev.session_id });
          }
          if (typeof ev.model === "string" && ev.model) {
            capturedModel = ev.model;
          }
          completeWorkLogStep(threadId, startingId);
          store.save();
          pushDetail(threadId, claudeState);
          pushThreadsChanged();
          return;
        }

        if (type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
          // Complete assistant restates streamed partials: replace, don't append.
          if (partialText) {
            assistantText = "";
            partialText = false;
          }
          if (partialThinking) {
            thinkingText = "";
            partialThinking = false;
          } else {
            thinkingMsgId = null;
            thinkingText = "";
          }
          for (const block of ev.message.content) {
            if (!block || typeof block !== "object") continue;
            if (block.type === "text" && typeof block.text === "string") {
              if (block.text) markTurnContent();
              assistantText += block.text;
              upsertAssistantText();
            } else if (
              block.type === "thinking" ||
              block.type === "redacted_thinking"
            ) {
              markTurnContent();
              thinkingText +=
                block.type === "thinking" && typeof block.thinking === "string"
                  ? block.thinking
                  : "";
              upsertThinking();
            } else if (block.type === "tool_use") {
              ingestToolUse(block);
            }
          }
          store.save();
          pushDetail(threadId, claudeState);
          return;
        }

        if (type === "user" && ev.message && Array.isArray(ev.message.content)) {
          for (const block of ev.message.content) {
            if (!block || typeof block !== "object") continue;
            if (block.type !== "tool_result") continue;
            markTurnContent();
            const toolUseId = String(block.tool_use_id || "");
            // Subagent lifecycle: a sync Agent's result is its report →
            // done. A background launch acks with "Async agent launched"
            // and stays running until its task-notification (or CLI death).
            if (toolUseId) {
              if (block.is_error) {
                setSubagentStatus(threadId, toolUseId, "failed");
              } else if (
                !/async agent launched/i.test(flattenContent(block.content))
              ) {
                setSubagentStatus(threadId, toolUseId, "done");
              }
            }
            const msgId = toolMsgById.get(toolUseId);
            const existing = msgId
              ? store.getMessages(threadId).find((m) => m.id === msgId)
              : // Fall back: search messages for matching tool.id
                store
                  .getMessages(threadId)
                  .find(
                    (m) =>
                      m.role === "tool" && m.tool && m.tool.id === toolUseId,
                  );
            if (!existing || !existing.tool) continue;
            const output = truncate(
              flattenContent(block.content),
              OUTPUT_TRUNCATE,
            );
            // Screenshots and Read-of-an-image land here as base64 blocks;
            // keep the bytes on disk and the filenames in the message.
            const images = saveToolImages(
              userDataPath,
              extractImages(block.content),
              threadId,
            );
            store.updateMessage(threadId, existing.id, {
              tool: {
                ...existing.tool,
                output,
                isError: Boolean(block.is_error),
                done: true,
                ...(images.length ? { images } : {}),
              },
            });
            noteToolSpan(
              threadId,
              runId,
              existing.tool.id,
              existing.tool.name,
              block.is_error,
            );
          }
          store.save();
          pushDetail(threadId, claudeState);
          return;
        }

        if (type === "result") {
          if (partialPushTimer) {
            clearTimeout(partialPushTimer);
            partialPushTimer = null;
          }
          if (isPhantomClaudeResult(ev, sawTurnContent)) {
            if (heldPhantom) return;
            heldPhantom = ev;
            if (typeof ev.session_id === "string" && ev.session_id) {
              capturedSessionId = ev.session_id;
              store.updateThread(threadId, { sessionId: capturedSessionId });
              store.save();
            }
            return;
          }
          discardHeldPhantom();
          sawResult = true;
          if (!guard()) return;

          completeWorkLogStep(threadId, startingId);
          completeWorkLogStep(threadId, workingId);

          if (typeof ev.session_id === "string" && ev.session_id) {
            capturedSessionId = ev.session_id;
          }
          if (capturedSessionId) {
            store.updateThread(threadId, { sessionId: capturedSessionId });
          }

          // Accumulate usage
          const prev = store.getUsage(threadId) || {
            model: null,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            turns: 0,
          };
          const usage = ev.usage || {};
          const turnIn = Number(usage.input_tokens) || 0;
          const turnOut = Number(usage.output_tokens) || 0;
          const costDelta = Number(ev.total_cost_usd) || 0;
          runUsage.tokensIn += turnIn;
          runUsage.tokensOut += turnOut;
          runUsage.costUsd += costDelta;
          const inputTokens = prev.inputTokens + turnIn;
          const outputTokens = prev.outputTokens + turnOut;
          const costUsd = prev.costUsd + costDelta;
          const model =
            capturedModel || prev.model || null;
          const nextUsage = {
            model,
            inputTokens,
            outputTokens,
            costUsd,
            turns: prev.turns + 1,
          };
          // inputTokens stay billable (no cache). contextTokens is the full
          // prompt, or stays unset for Claude when cache fields are omitted
          // (#317). Grok is allowed to sum without those keys (#704).
          assignContextUsage(
            nextUsage,
            prev,
            claudeContextTokens(usage, {
              allowMissingCache: thread.provider === "grok",
            }),
            reportedModelUsageWindow(ev),
          );
          store.setUsage(threadId, nextUsage);
          if (costDelta > 0) {
            store.recordSpend(costDelta);
          }
          store.recordUsage({
            provider: thread.provider,
            model,
            costUsd: costDelta,
            inputTokens: turnIn,
            cachedInputTokens: Number(usage.cache_read_input_tokens) || 0,
            cacheWriteTokens: Number(usage.cache_creation_input_tokens) || 0,
            outputTokens: turnOut,
            threadId,
            projectId: thread.projectId,
            projectName: store.getProject(thread.projectId)?.name,
            title: thread.title,
          });

          const ok = ev.subtype === "success";
          // Assistant text from stream, or fall back to result field
          // (skip when result merely repeats the last streamed bubble).
          // Error/cancel results are not assistant copy (#549).
          if (
            ok &&
            !assistantText &&
            typeof ev.result === "string" &&
            ev.result &&
            ev.result !== lastAssistantText(threadId, runId)
          ) {
            assistantText = ev.result;
            if (!assistantMsgId) {
              assistantMsgId = appendMessage(
                threadId,
                "assistant",
                assistantText,
                runId,
              );
            } else {
              store.updateMessage(threadId, assistantMsgId, {
                text: assistantText,
              });
            }
          }

          /** @type {"done" | "failed" | "stopped"} */
          let terminalStatus;
          /** @type {string} */
          let terminalText;
          if (ok) {
            store.updateThread(
              threadId,
              {
                status: "done",
                sessionId: capturedSessionId,
                runStartedAt: null,
                lastError: null,
              },
              { touch: true },
            );
            terminalStatus = "done";
            terminalText =
              assistantText ||
              (typeof ev.result === "string" ? ev.result : "") ||
              lastAssistantText(threadId, runId);
          } else {
            const classified = classifyClaudeResultError({
              errors: ev.errors,
              result: typeof ev.result === "string" ? ev.result : "",
              stderr:
                handle && typeof handle.getStderr === "function"
                  ? handle.getStderr()
                  : "",
            });
            if (classified.kind === "stop") {
              appendMessage(threadId, "event", "Run stopped", runId);
              appendDoneWorkLog(threadId, runId, "Run stopped");
              store.updateThread(
                threadId,
                {
                  status: "idle",
                  sessionId: capturedSessionId,
                  runStartedAt: null,
                },
                { touch: true },
              );
              terminalStatus = "stopped";
              terminalText =
                lastAssistantText(threadId, runId) || "Run stopped";
            } else {
              const failText = classified.text;
              const failure = markRunFailed(threadId, failText, runId, {
                sessionId: classified.sessionLost ? null : capturedSessionId,
              });
              appendDoneWorkLog(threadId, runId, "Run error");
              terminalStatus = "failed";
              terminalText = failure.text;
            }
          }

          store.save();
          // Free the thread slot immediately so the next turn can start;
          // onExit will no-op via the runId identity guard.
          clearRun(threadId);
          // Process stays alive (keepAlive); reap it if no turn reuses it.
          scheduleClaudeIdleReap(threadId);
          pushDetail(threadId, claudeState);
          pushThreadsChanged();
          notifyRunTerminal(threadId, terminalStatus, terminalText, {
            tokensIn: runUsage.tokensIn,
            tokensOut: runUsage.tokensOut,
            costUsd: runUsage.costUsd,
          });
          return;
        }
    };

    const onExit = ({ code, stderr, gotResult }) => {
        if (partialPushTimer) {
          clearTimeout(partialPushTimer);
          partialPushTimer = null;
        }
        disarmAck();
        if (heldPhantom) {
          failEmptyPhantom(heldPhantom);
          return;
        }
        const e = active.get(threadId);
        // Result already cleared this run, or a newer run owns the slot.
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "claude") return;

        // A kept-alive CLI can be on its way out when this turn's send()
        // lands: the write succeeds (EPIPE is async), nothing reads it, and
        // the exit that follows belongs to the PREVIOUS turn. Nothing of ours
        // ever reached the CLI, so respawn instead of failing a turn the
        // agent never saw. Once only, and never once output has arrived.
        if (reused && !respawned && !sawAnyEvent && !sawResult && !gotResult) {
          respawned = true;
          spawnForTurn();
          return;
        }

        clearRun(threadId);

        // If WE finalized on a result event, close the work-log and stop.
        // gotResult is not that proof: claude.js sets it for any result line
        // including a leftover empty one we deliberately did not finalize on,
        // and trusting it checkmarks both steps with no message, no status and
        // no notification — issue #17's silent black hole.
        if (sawResult) {
          completeWorkLogStep(threadId, e.startingId);
          completeWorkLogStep(threadId, e.workingId);
          store.save();
          pushDetail(threadId, claudeState);
          pushThreadsChanged();
          return;
        }

        // Nonzero (or any) exit without result: failed
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);

        const errText = formatRunExitError(code, stderr);
        const failure = markRunFailed(threadId, errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, claudeState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", failure.text, {
          tokensIn: runUsage.tokensIn,
          tokensOut: runUsage.tokensOut,
          costUsd: runUsage.costUsd,
        });
    };

    const onError = (err) => {
        if (partialPushTimer) {
          clearTimeout(partialPushTimer);
          partialPushTimer = null;
        }
        disarmAck();
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "claude") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);
        const msg = err && err.message ? err.message : String(err);
        const errText = `Run error: ${msg}`;
        const failure = markRunFailed(threadId, errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, claudeState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", failure.text, {
          tokensIn: runUsage.tokensIn,
          tokensOut: runUsage.tokensOut,
          costUsd: runUsage.costUsd,
        });
    };

    // Claude Code's own OTel metrics (issue #280): pointing it at the same
    // collector our spans go to beats standing up a receiver. Env-only, so a
    // warm CLI predates the setting — hence it joins the reuse key below.
    // undefined rather than {} when export is off: claude.js only replaces the
    // inherited env when this is set, and an empty replacement is not the same.
    const claudeOtel = otel.claudeEnv();
    const otelEnv = Object.keys(claudeOtel).length > 0 ? claudeOtel : undefined;
    const grokMerged =
      entryDef.id === "grok"
        ? mergeGrokSpawnEnv({ ...(otelEnv || {}), ...(grokHomeEnv || {}) })
        : otelEnv;
    const spawnEnv =
      grokMerged && Object.keys(grokMerged).length > 0 ? grokMerged : undefined;

    // Reuse key: everything a spawn bakes into argv/env EXCEPT the session
    // id (--resume changes after turn one; the live process needs no resume).
    const sessionKey = JSON.stringify({
      cwd: localCwd,
      remote: project.remoteHost || null,
      binary,
      model: thread.model || null,
      permissionMode: thread.permissionMode || "default",
      reasoningEffort: thread.reasoningEffort || null,
      mcp: interactive ? mcpArgs : [],
      // The config path is stable; a warm process has already read its contents.
      mcpHash: interactive
        ? mcpArgs.filter((a) => a.startsWith("--mcp-config="))
          .map((a) => createHash("sha256").update(fs.readFileSync(a.slice("--mcp-config=".length))).digest("hex"))
        : [],
      otelEnv: spawnEnv || null,
    });

    const prevSess = claudeSessions.get(threadId);
    const prevChild =
      prevSess && prevSess.handle ? prevSess.handle.child : null;
    const prevAlive =
      prevChild && prevChild.exitCode === null && !prevChild.killed;

    /**
     * Spawn this turn's own CLI and take ownership of it. Also the respawn
     * path in onExit when a reused kept-alive process was already dying.
     */
    function spawnForTurn() {
      if (launchWasCancelled(threadId, runId)) return;
      if (interactive) {
        const sess = {
          handle: null,
          dispatch: { onEvent, onExit, onError },
          key: sessionKey,
          idleTimer: null,
        };
        claudeSessions.set(threadId, sess);
        handle = runClaude({
          binary: spawn.binary,
          args: spawn.args,
          prompt,
          cwd: spawn.cwd,
          permissionMode: thread.permissionMode || "default",
          sessionId: thread.sessionId || null,
          model: thread.model || null,
          interactive,
          keepAlive: true,
          envExtra: spawnEnv,
          onEvent: (ev) => sess.dispatch.onEvent(ev),
          onExit: (info) => {
            // Process death always retires the session, whatever turn (if
            // any) is current.
            if (claudeSessions.get(threadId) === sess) {
              if (sess.idleTimer) clearTimeout(sess.idleTimer);
              claudeSessions.delete(threadId);
            }
            sess.dispatch.onExit(info);
          },
          onError: (err) => sess.dispatch.onError(err),
        });
        sess.handle = handle;
      } else {
        // Non-interactive claude-stream (e.g. grok): unchanged per-turn CLI.
        handle = runClaude({
          binary: spawn.binary,
          args: spawn.args,
          prompt,
          cwd: spawn.cwd,
          permissionMode: thread.permissionMode || "default",
          sessionId: thread.sessionId || null,
          model: thread.model || null,
          interactive,
          envExtra: spawnEnv,
          onEvent,
          onExit,
          onError,
        });
      }
      trackLiveClaudeChild(handle.child);
      const own = active.get(threadId);
      if (own && own.runId === runId) own.handle = handle;
    }

    if (abortIfCancelled(threadId, runId)) return { runId };
    if (interactive && prevSess && prevAlive && prevSess.key === sessionKey) {
      // Same params, live process: deliver the turn on its stdin. Background
      // tasks from earlier turns keep running; the CLI reports their
      // completion within this session.
      if (prevSess.idleTimer) {
        clearTimeout(prevSess.idleTimer);
        prevSess.idleTimer = null;
      }
      prevSess.dispatch = { onEvent, onExit, onError };
      handle = prevSess.handle;
      reused = handle.send(prompt);
      if (reused) {
        // A reused process emits no second system/init; close the step now.
        completeWorkLogStep(threadId, startingId);
        // ponytail: any line from the CLI counts as the ACK (we deliberately
        // do not correlate per-turn uuids), so a stray background
        // task-notification from an earlier turn could satisfy it and mask
        // a hang (fail-safe direction). Upgrade path is the
        // command_lifecycle correlation id (set uuid on the user line in
        // electron/claude.js sendUser, match command_uuid) if that ever
        // matters.
        const own = active.get(threadId);
        if (own && own.runId === runId) {
          const ackMs = Number(process.env.CODER_CLAUDE_ACK_MS) || CLAUDE_ACK_MS;
          own.ackTimer = setTimeout(() => {
            if (!guard()) return;
            if (sawAnyEvent || sawResult) return;
            disposeClaudeSession(threadId);
          }, ackMs);
          if (typeof own.ackTimer.unref === "function") own.ackTimer.unref();
        }
      }
    }
    if (!reused) {
      // Params changed (cwd/model/mode/effort/mcp), process gone, or its
      // stdin already closed (send failed): replace it.
      if (prevSess) disposeClaudeSession(threadId);
      spawnForTurn();
    }

    entry.handle = handle;
    store.save();
    pushDetail(threadId, claudeState);

    return { runId };
  }

  async function startRun(input) {
    const { threadId } = input;
    let prompt = input.prompt;
    let attachments = sanitizeAttachments(input.attachments);
    let displayPrompt =
      input.displayPrompt != null ? input.displayPrompt : input.prompt;
    let fromThread = input.fromThread || null;
    const skipUserAppend = input.skipUserAppend === true;
    // Side question (issue #471): intercept BEFORE the "already active"
    // throw so a `/btw` typed during a run is not bounced and is not
    // queued as the next prompt. fromNotice is skipped so a worker
    // quoting `/btw` cannot open a card on itself. fromInbound is skipped
    // so a cross-thread body that happens to start with `/btw` is data.
    if (!input.fromNotice && !input.fromInbound) {
      const question = btw.parseBtwCommand(prompt);
      if (question) {
        const thread = await startBtw({ threadId, question });
        return { runId: null, thread };
      }
    }
    if (active.has(threadId)) {
      throw new Error("A run is already active on this thread");
    }

    const thread = store.getThread(threadId);
    if (!thread) {
      throw new Error(`Unknown thread: ${threadId}`);
    }
    if (services.isTrashed(thread)) {
      throw new Error("Cannot start a run on a deleted thread");
    }
    if (
      resolveProvider(thread) === "codex" &&
      thread.sessionId &&
      thread.ejected !== true &&
      codexSessionHeld(thread.sessionId, threadId)
    ) {
      throw new Error(
        "A Codex session writer is already running for this session in another Solenta thread",
      );
    }

    // Machine-delivered turns increment autoTurns in flushOrchNotices.
    // Anything else (user send, retry, verify fix) is a human in the loop.
    if (!input.fromNotice && !isReplayTurn(input)) autoTurns.set(threadId, 0);
    cancelQuotaWake(threadId);

    // Ask mode (issue #392): cheap no-tools Q&A. Intercept BEFORE orch
    // commands, budget, and worktree materialization so a `/advisor` on an
    // Ask thread is just a question and a defaultWorktree leftover cannot
    // touch the disk.
    if (thread.ask === true) {
      return startAskRun(input, thread);
    }

    // Orchestration commands (issue #338): `/handoff`, `/advisor` and
    // `/committee` are named compositions of the fork-and-notice machinery
    // below, so they are intercepted here instead of reaching a CLI. Never
    // on a machine-delivered turn — a worker quoting the command back would
    // otherwise fan out again — and the cheap `/` test keeps the provider
    // probe (`which`) off the ordinary send path.
    if (
      !input.fromNotice &&
      !input.fromInbound &&
      String(prompt).trimStart().startsWith("/")
    ) {
      const cmd = orchcommands.parseOrchCommand(prompt, {
        installed: listProviders()
          .filter((p) => p.available)
          .map((p) => p.id),
        current: resolveProvider(thread),
      });
      if (cmd) {
        return await dispatchOrchCommand(
          threadId,
          thread,
          cmd,
          prompt,
          attachments,
        );
      }
    }

    // Fold a held inbound (or leftover follow-up) into this turn so a
    // queue-only message sitting on an idle thread is actually read.
    // After intercepts: /btw, ask, and /handoff must not consume the queue.
    if (!input.fromQueue && !input.fromNotice && !isReplayTurn(input)) {
      let taken = null;
      try {
        taken = services.takeQueued(store, { threadId });
      } catch {
        taken = null;
      }
      if (taken && taken.prompt) {
        const takenCli = formatQueuedPrompt(taken);
        prompt = prompt ? `${takenCli}\n\n${prompt}` : takenCli;
        attachments = [
          ...(taken.attachments || []),
          ...attachments,
        ];
      }
    }

    // Orchestrator thread (issue #202): the first prompt is not run here. It
    // is forked to a worker that holds the worktree and does the work; from
    // the second prompt on the flag is gone and this thread runs its own LLM,
    // supervising the crew through the coder-threads tools. The gates below
    // belong to the run that actually happens — the worker's — so they are
    // deliberately skipped on this hop.
    if (thread.pendingFork) {
      // Promote the parent title BEFORE forking so the orchestrator is
      // named after the first prompt, not "New Thread". The worker gets
      // that same first line as its job title (no extra Fork: prefix).
      let forkTitle = thread.title;
      if (forkTitle === "New Thread") {
        const firstLine = String(prompt).split(/\r?\n/)[0].trim();
        forkTitle =
          firstLine.slice(0, services.THREAD_TITLE_MAX || 60) || "New Thread";
      }
      if (forkTitle !== thread.title) {
        store.updateThread(threadId, { title: forkTitle }, { touch: true });
      }

      const worker = services.forkWorkerThread(store, { threadId, prompt });
      // The fork itself is a span (issue #280 asks for thread/fork/tool), and
      // it parents the worker's run so the crew reads as one trace tree. It
      // closes as soon as the worker is launched — the worker outliving its
      // parent span is normal for an async hand-off.
      const forkRunId = randomUUID();
      otel.startRun({
        threadId,
        runId: forkRunId,
        provider: resolveProvider(thread),
        model: thread.model || null,
      });
      let started;
      try {
        started = await startWithPoolFailover({
          store,
          worker,
          prompt,
          extra: { attachments, parentRunId: forkRunId },
          startRun,
          setProvider: services.setProvider,
          isAvailable: providerBinAvailable,
          onFailover: (next, fromProvider) => {
            appendMessage(
              threadId,
              "event",
              `Pool failover: ${fromProvider || "provider"} unavailable, using ${next.alias} (${next.provider}).`,
            );
          },
        });
      } catch (err) {
        // The worker could not start (missing CLI, budget gate, worktree
        // setup): drop the orphan and keep pendingFork so the next prompt
        // retries the fork, the same contract as a failed lazy worktree.
        try {
          // Worker never started a run; no durable artifacts to reclaim.
          services.deleteThread(store, { threadId: worker.id });
        } catch {
          /* best effort */
        }
        pushThreadsChanged();
        otel.endRun({
          threadId,
          runId: forkRunId,
          status: "failed",
          error: shortError(String((err && err.message) || err)),
        });
        throw err;
      }

      otel.endRun({ threadId, runId: forkRunId, status: "done" });
      appendMessage(threadId, "user", prompt, forkRunId, null, attachments);
      appendMessage(
        threadId,
        "event",
        `[orchestration] Forked worker ${worker.id} for this prompt; it works in its own worktree and wakes this thread when it lands.`,
        forkRunId,
      );
      store.updateThread(
        threadId,
        { pendingFork: false, ...services.clearSettledOnActivity(thread) },
        { touch: true },
      );
      pushDetail(threadId);
      pushThreadsChanged();
      return started;
    }

    // Budget gate is start-time only; never kills an in-flight run.
    // Sleep-time consolidation is a system job (issue #722) and must not
    // stall behind a spent daily cap.
    if (thread.memoryConsolidate !== true) {
      services.assertUnderDailyBudget(store);
    }

    const provider = resolveProvider(thread);
    const projectForGate = store.getProject(thread.projectId);
    // Fail before mutating thread state when the CLI is missing.
    if (provider !== "simulate" && provider !== "generic") {
      const entryDef = getProvider(provider) || getProvider("claude");
      assertProviderBinary(entryDef, projectForGate);
    }

    // Lazy worktree (t3-style): pendingWorktree threads materialize their
    // worktree + branch at first run, so never-run threads leave nothing.
    // A missing folder rematerializes. Failure is recorded in-thread and
    // thrown — never a silent fallback to the project checkout (#511).
    // Consolidation is memory-tools-only: never mint a worktree.
    if (thread.memoryConsolidate === true) {
      if (thread.pendingWorktree) {
        store.updateThread(threadId, { pendingWorktree: false });
      }
    } else {
      try {
        materializePendingWorktree(threadId);
      } catch (err) {
        failWorktreeSetup(threadId, prompt, attachments, err, {
          fromQuotaWait: input.fromQuotaWait,
          fromQuotaFailover: input.fromQuotaFailover,
        });
      }
    }

    // Prefix is CLI-only and must see the retained tail BEFORE this turn's
    // user message is appended (rewind replay would otherwise digest itself).
    const prefix = services.buildHandoffPrefix(thread, (id) =>
      store.getMessages(id),
    );
    // Start is accepted: a later undo must not resurrect the dropped tail
    // (#1202). Clear before append so a crash mid-turn cannot roll back a
    // live run.
    services.clearRewindRestore(store, threadId);
    if (thread.replayContext) {
      store.updateThread(threadId, { replayContext: false });
    }

    const runId = randomUUID();
    otel.startRun({
      threadId,
      runId,
      provider,
      model: thread.model || null,
      parentRunId: input.parentRunId || null,
    });
    // Transcript stores the RAW user prompt. The hand-off / rewind context
    // block (if any) is CLI-only — applied once below when no sessionId
    // exists yet. A quota-wait resume is the SAME turn: do not append again.
    // skipUserAppend: inbound card was already posted while the previous
    // turn was running (issue #551).
    if (!isReplayTurn(input) && !skipUserAppend) {
      appendMessage(
        threadId,
        "user",
        displayPrompt != null ? displayPrompt : prompt,
        runId,
        null,
        attachments,
        {
          ...(fromThread ? { fromThread } : {}),
          ...(input.fromNotice === true ? { fromNotice: true } : {}),
        },
      );
    }

    let title = thread.title;
    if (title === "New Thread") {
      const firstLine = String(displayPrompt || prompt)
        .split(/\r?\n/)[0]
        .trim();
      const max = services.THREAD_TITLE_MAX || 60;
      title = firstLine.slice(0, max) || "New Thread";
    }

    // A machine-delivered turn is not the user answering, so it must not
    // erase an open question card (issue #647). grok/kimi end their turn when
    // they ask, which leaves the thread idle and every notice / cross-thread
    // send free to start a run over the card — measured on the live store:
    // 4 of 82 asks were wiped this way, one 2 s after it went up.
    const machineTurn = input.fromNotice === true || input.fromInbound === true;
    const keepQuestion = machineTurn ? thread.pendingQuestion || null : null;
    const keepPlan = machineTurn ? thread.pendingPlan || null : null;

    // Real activity clears a stale "settled" pin (t3 rule). An explicit
    // "active" pin survives so the user can keep a thread out of auto-settle.
    // Shared with workflow start via services.clearSettledOnActivity.
    store.updateThread(
      threadId,
      {
        status: "working",
        title,
        awaitingInput: keepQuestion != null || keepPlan != null ||
          ciWorkflowSignOffs.get(threadId)?.approved === false,
        runStartedAt: Date.now(),
        // Any user turn supersedes an open question card (issue #647):
        // answering it IS this message, and so is changing the subject.
        pendingQuestion: keepQuestion,
        pendingPlan: keepPlan,
        lastEventAt: null,
        stalledAt: null,
        stoppedAt: null,
        quotaWaitUntil: null,
        quotaWaitResumed: input.fromQuotaWait === true,
        quotaFailoverPending: false,
        quotaFailoverTried: isReplayTurn(input)
          ? thread.quotaFailoverTried || []
          : [],
        ...services.clearSettledOnActivity(thread),
      },
      { touch: true },
    );

    if (thread.lane) {
      try {
        heartbeatLane({ store, threadId, now: nowFn() });
      } catch {
        // never break a run for a lane stamp
      }
    }

    // A creation-time worktree starts on the placeholder branch
    // coder/new-thread-<id>; once the first prompt promotes the title, the
    // branch follows (T3-style). Best-effort: never throws, never blocks.
    if (title !== thread.title) {
      const { maybeRenameWorktreeBranch } = require("./worktrees.js");
      maybeRenameWorktreeBranch({ store, threadId, newTitle: title });
    }

    // Single finalization point for every provider path: prefix only goes to
    // the CLI (buildArgs / runAgent), never into the stored user message.
    // Live-session follow-ups (handle.send) receive this same string.
    // Re-read: materializePendingWorktree may have just set worktreePath, and
    // the self-id note quotes the cwd the CLI actually gets.
    const dispatchThread = store.getThread(threadId) || thread;
    // Index lives on the project's MAIN checkout, not this thread's worktree.
    const repoRoot = (projectForGate && projectForGate.path) || "";
    if (userDataPath && repoRoot) {
      try {
        require("./codeindex.js").maybeRefreshIndex({ userDataPath, repoRoot });
      } catch {
        /* never block dispatch */
      }
    }
    // Slash commands (#606): the TUI would expand `/skill args` before the
    // model sees them. Headless `-p` does not. Keep the raw `/name` in the
    // transcript (already appended above) and send the SKILL.md / command
    // body to the CLI. A leading `/` also stays FIRST in the CLI prompt so
    // unknown `/foo` is not buried under the hand-off prefix.
    const rawPrompt = String(prompt ?? "");
    let cliPrompt = rawPrompt;
    let slashExpanded = false;
    if (!input.fromNotice && rawPrompt.trimStart().startsWith("/")) {
      try {
        const hit = cliCommands.expandInvocableCommand(rawPrompt, {
          projectPath: projectForGate && projectForGate.path,
          provider: thread.provider,
        });
        if (hit) {
          cliPrompt = hit.prompt;
          slashExpanded = true;
        }
      } catch {
        /* discovery is best-effort; send the raw slash */
      }
    }
    const leadSlash =
      slashExpanded || rawPrompt.trimStart().startsWith("/");
    // Codex vision models take images as app-server UserInput localImage
    // (#1170 / #176). Spark is text-only (#1167) so its images stay in
    // the prompt-path list, as do folders/files (no native flag).
    const nativeImages =
      provider === "codex" &&
      codexModelAcceptsImages(dispatchThread.model)
        ? attachments.filter((a) => a.kind === "image").map((a) => a.path)
        : [];
    // OpenCode `run -f` attaches image/file paths natively (issue #176).
    // Folders stay in the prompt-path section: the CLI has no folder flag.
    const nativeFiles =
      provider === "opencode"
        ? attachments
            .filter((a) => a.kind === "image" || a.kind === "file")
            .map((a) => a.path)
        : [];
    const promptAttachments =
      provider === "opencode"
        ? attachments.filter((a) => a.kind === "folder")
        : nativeImages.length
          ? attachments.filter((a) => a.kind !== "image")
          : attachments;
    const promptPrefix =
      (leadSlash ? cliPrompt : prefix + cliPrompt) +
      attachmentPromptSection(promptAttachments) +
      (leadSlash ? prefix : "") +
      services.planboardNoteFor(projectForGate && projectForGate.path) +
      services.selfIdNoteFor(
        dispatchThread,
        projectForGate,
        dispatchThread.worktreePath ||
          (projectForGate && projectForGate.path) ||
          null,
      ) +
      services.suggestedWorkNoteFor() +
      services.subagentPoolNoteFor(
        store.getSettings && store.getSettings().subagentPool,
      ) +
      services.hypothesisNoteFor(dispatchThread, (id) => store.getThread(id)) +
      services.specNoteFor(
        dispatchThread,
        dispatchThread.worktreePath ||
          (projectForGate && projectForGate.path) ||
          null,
      ) +
      services.reviewItineraryNoteFor(dispatchThread) +
      services.teachNoteFor(dispatchThread) +
      services.askNoteFor(dispatchThread) +
      services.codexComputerUseNoteFor(dispatchThread.provider) +
      services.crewTaskNoteFor(store, dispatchThread) +
      services.codeIndexNoteFor(
        userDataPath && repoRoot
          ? tryReadCodeIndex(userDataPath, repoRoot)
          : null,
      );

    const pendingEntry = {
      kind: "preparing",
      runId,
      stopping: false,
      handle: {
        kill() {
          pendingEntry.stopping = true;
        },
      },
    };
    active.set(threadId, pendingEntry);

    const bootNote = await ask.prefetchBootstrapNote({
      userDataPath,
      projectPath:
        dispatchThread.worktreePath ||
        (projectForGate && projectForGate.path) ||
        "",
      firstTurn: !dispatchThread.sessionId,
      bootstrapMemory,
    });
    if (abortIfCancelled(threadId, runId)) return { runId };

    const dispatchPrompt = promptPrefix + bootNote;

    const name = workflowNameFromThreadId(threadId);

    if (provider === "simulate") {
      return startSimulatedRun(threadId, dispatchPrompt, runId, name);
    }
    if (provider === "generic") {
      return startGenericRun(threadId, dispatchPrompt, runId, name);
    }

    const entryDef = getProvider(provider) || getProvider("claude");
    if (entryDef.kind === "claude-stream") {
      return await startClaudeRun(threadId, dispatchPrompt, runId, entryDef);
    }
    if (entryDef.kind === "codex-json") {
      return startCodexRun(
        threadId,
        dispatchPrompt,
        runId,
        entryDef,
        nativeImages,
      );
    }
    if (entryDef.kind === "kimi-stream") {
      return startKimiRun(threadId, dispatchPrompt, runId, entryDef);
    }
    if (entryDef.kind === "opencode-json") {
      return startOpencodeRun(
        threadId,
        dispatchPrompt,
        runId,
        entryDef,
        nativeFiles,
      );
    }
    if (entryDef.kind === "cursor-stream") {
      return startCursorRun(threadId, dispatchPrompt, runId, entryDef);
    }
    if (entryDef.kind === "muse-json") {
      return await startMuseRun(threadId, dispatchPrompt, runId, entryDef);
    }
    return await startClaudeRun(
      threadId,
      dispatchPrompt,
      runId,
      getProvider("claude"),
    );
  }

  /**
   * Orchestrated multi-phase Build workflow from a user-defined template.
   * @param {{ threadId: string, prompt: string, templateId?: string }} input
   * @returns {Promise<{ runId: string }>}
   */
  async function startWorkflowRun(input) {
    try {
      materializePendingWorktree(input.threadId);
    } catch (err) {
      failWorktreeSetup(input.threadId, input.prompt, undefined, err);
    }
    return workflowEngine.startWorkflowRun({
      threadId: input.threadId,
      prompt: input.prompt,
      templateId: input.templateId,
      store,
      core,
      pushFn,
      active,
      clearRun,
      pushDetail,
      pushThreadsChanged,
      beginWorkLogStep,
      completeWorkLogStep,
      appendDoneWorkLog,
      appendMessage,
      notifyRunTerminal,
      userDataPath,
    });
  }

  /**
   * Re-spawn a failed workflow phase agent after the run ended (#825).
   * @param {{ threadId: string, agentId: string }} input
   * @returns {Promise<{ runId: string }>}
   */
  async function retryWorkflowAgent(input) {
    try {
      materializePendingWorktree(input.threadId);
    } catch (err) {
      failWorktreeSetup(input.threadId, "", undefined, err);
    }
    return workflowEngine.retryWorkflowAgent({
      threadId: input.threadId,
      agentId: input.agentId,
      view: lastWorkflowByThread.get(input.threadId) || null,
      store,
      core,
      pushFn,
      active,
      clearRun,
      pushDetail,
      pushThreadsChanged,
      beginWorkLogStep,
      completeWorkLogStep,
      appendDoneWorkLog,
      appendMessage,
      notifyRunTerminal,
      userDataPath,
    });
  }

  /**
   * Inject guidance into a live turn (issue #156). Writes a user line to
   * the running CLI's stdin and appends a `steer: true` user row on the
   * current runId — not a second run, not a queued follow-up.
   * @param {{ threadId: string, prompt: string, attachments?: object[] }} input
   * @returns {Promise<{ runId: string }>}
   */
  async function steerRun(input) {
    const threadId = input && input.threadId;
    const prompt = String((input && input.prompt) || "").trim();
    if (!threadId) throw new Error("threadId is required");
    if (!prompt) throw new Error("prompt is required");
    const thread = store.getThread(threadId);
    if (!thread) throw new Error(`Unknown thread: ${threadId}`);
    const entry = active.get(threadId);
    if (!entry || entry.stopping) {
      throw new Error("No live run to steer");
    }
    const provider = resolveProvider(thread);
    const providerEntry = getProvider(provider);
    if (!providerEntry || providerEntry.supportsSteer !== true) {
      const name = (providerEntry && providerEntry.name) || provider;
      throw new Error(`${name} cannot steer a live turn`);
    }
    if (!entry.handle || typeof entry.handle.send !== "function") {
      throw new Error("Live process is not accepting input");
    }
    const attachments = sanitizeAttachments(input.attachments);
    const sent = await Promise.resolve(
      entry.handle.send(prompt + attachmentPromptSection(attachments)),
    );
    if (!sent) {
      throw new Error("Live process is not accepting input");
    }
    appendMessage(
      threadId,
      "user",
      prompt,
      entry.runId,
      null,
      attachments,
      { steer: true },
    );
    store.save();
    pushDetail(threadId, entry.claudeState || null);
    return { runId: entry.runId };
  }

  /**
   * @param {{ threadId: string, cascadeCrew?: boolean }} input
   * @param {Set<string>} [seen] - internal: crew cascade cycle guard
   */
  async function stopRun(input, seen = new Set()) {
    const { threadId } = input;
    // Cascade first: a worker outliving its stopped orchestrator keeps
    // burning tokens and re-wakes the parent through queueOrchNotice. Doing
    // it before this thread's own terminal also means a notice that races in
    // during the kills is stopped again by the run below.
    // Eject (#960) passes cascadeCrew: false — only this session's writer
    // must be released; the crew keeps running.
    const cascadeCrew = input.cascadeCrew !== false;
    const crew = cascadeCrew
      ? await stopCrew(String(threadId), seen)
      : { stopped: 0, traced: false };
    // #315: Solenta-managed `npm run dev` is its own process group, so
    // killTree on the agent CLI never reaches it. Stop it here for both
    // live and idle threads. Crew workers keep their own servers unless
    // stopCrew walked them above.
    try {
      stopDevServer(String(threadId));
    } catch {
      // no sidecar
    }
    if (crew.stopped > 0) {
      const own = active.get(threadId);
      appendMessage(
        threadId,
        "event",
        `Stopped ${crew.stopped} worker thread${crew.stopped === 1 ? "" : "s"}`,
        own ? own.runId : null,
      );
    }
    if (!active.has(threadId)) {
      // Idle orchestrator whose crew was still running: no terminal follows,
      // so publish the crew-stop events here.
      if (crew.stopped > 0 || crew.traced) {
        store.save();
        pushDetail(threadId, lastWorkflowByThread.get(threadId) || null);
        pushThreadsChanged();
      }
      return;
    }

    const entry = active.get(threadId);
    const runId = entry.runId;
    const lastWorkflow =
      (entry && entry.workflow) ||
      lastWorkflowByThread.get(threadId) ||
      null;

    entry.stopping = true;

    if (entry.kind === "workflow") {
      workflowEngine.stopWorkflowEntry(entry);
    } else if (
      (entry.kind === "generic" ||
        entry.kind === "claude" ||
        entry.kind === "codex" ||
        entry.kind === "kimi" ||
        entry.kind === "opencode" ||
        entry.kind === "cursor" ||
        entry.kind === "muse" ||
        entry.kind === "real" ||
        entry.kind === "ask" ||
        entry.kind === "preparing") &&
      entry.handle
    ) {
      if (entry.kind === "codex") cancelCodexServerRequests(entry);
      try {
        entry.handle.kill();
      } catch {
        // ignore
      }
    }

    // Complete any open work-log steps for this run.
    if (entry.kind === "generic" || entry.kind === "real") {
      completeWorkLogStep(threadId, entry.startingId);
      completeWorkLogStep(threadId, entry.respondingId);
    } else if (
      entry.kind === "claude" ||
      entry.kind === "codex" ||
      entry.kind === "kimi" ||
      entry.kind === "opencode" ||
      entry.kind === "cursor" ||
      entry.kind === "muse" ||
      entry.kind === "preparing"
    ) {
      completeWorkLogStep(threadId, entry.startingId);
      completeWorkLogStep(threadId, entry.workingId);
      completeWorkLogStep(threadId, entry.respondingId);
    } else if (
      (entry.kind === "sim" || entry.kind === "workflow") &&
      entry.phaseItemIds
    ) {
      for (const id of entry.phaseItemIds.values()) {
        completeWorkLogStep(threadId, id);
      }
    }

    const wasSimulate = entry.kind === "sim";
    const stopUsage = entry.runUsage || {
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    };
    clearRun(threadId);
    // Cursor (and a killed Claude CLI) take in-session Task/Agent
    // subagents with them. Leave no running badge on a dead process.
    finishRunningSubagents(threadId);
    appendMessage(threadId, "event", "Run stopped", runId);
    appendDoneWorkLog(threadId, runId, "Run stopped");
    store.updateThread(
      threadId,
      // stoppedAt distinguishes a user-stopped worker from a fork that never
      // ran (both idle, runStartedAt null) so the parent's wait state can
      // count it (issue #183). Cleared when a new run starts on the thread.
      { status: "idle", runStartedAt: null, stoppedAt: Date.now() },
      { touch: true },
    );
    store.save();
    pushDetail(threadId, lastWorkflow);
    pushThreadsChanged();
    if (!wasSimulate) {
      notifyRunTerminal(
        threadId,
        "stopped",
        lastAssistantText(threadId, runId) || "Run stopped",
        {
          tokensIn: stopUsage.tokensIn || 0,
          tokensOut: stopUsage.tokensOut || 0,
          costUsd: stopUsage.costUsd || 0,
        },
      );
    } else {
      // Sim stop skips notifyRunTerminal; still deliver notices that
      // queued while this thread was an orchestrator mid-run. Do not
      // drain a leftover follow-up (issue #1203).
      try {
        flushOrchNotices(threadId);
      } catch {
        // silent
      }
    }
  }

  function getActiveWorkflow(threadId) {
    const entry = active.get(threadId);
    if (entry) return entry.workflow;
    return lastWorkflowByThread.get(threadId) || null;
  }

  function isRunning(threadId) {
    return active.has(threadId);
  }

  /** Thread ids with a live run. Warm idle provider processes are not listed. */
  function listActiveThreadIds() {
    return [...active.keys()];
  }

  function activeRunId(threadId) {
    const entry = active.get(String(threadId));
    return entry && typeof entry.runId === "string" ? entry.runId : null;
  }

  function stopAll() {
    disposeWatchdogs();
    stopAllBtw();
    // Clean app quit (main.js before-quit). Mark each active run idle with an
    // interruption event so the next launch's recoverInterruptedRuns (crash
    // path only) does not re-stamp them as generic failures. Kill + flush
    // below are unchanged battle-tested behavior — only marking is added.
    for (const threadId of [...active.keys()]) {
      const entry = active.get(threadId);
      const runId = entry && entry.runId ? entry.runId : null;
      if (entry) entry.stopping = true;
      if (entry && entry.kind === "workflow") {
        workflowEngine.stopWorkflowEntry(entry);
      } else if (
        entry &&
        (entry.kind === "generic" ||
          entry.kind === "claude" ||
          entry.kind === "codex" ||
          entry.kind === "kimi" ||
          entry.kind === "opencode" ||
          entry.kind === "cursor" ||
          entry.kind === "muse" ||
          entry.kind === "real" ||
          entry.kind === "ask" ||
          entry.kind === "preparing") &&
        entry.handle
      ) {
        try {
          entry.handle.kill();
        } catch {
          // ignore
        }
      }
      clearRun(threadId);
      // Mirror stopRun's terminal shape (idle + event), quit-specific wording.
      // stoppedAt included: a quit-interrupted worker never resumes on its own,
      // so without the stamp the parent's wait state under-reports the stall
      // exactly like a user stop does (issue #183).
      appendMessage(
        threadId,
        "event",
        "Run interrupted by app quit",
        runId,
      );
      store.updateThread(
        threadId,
        { status: "idle", runStartedAt: null, stoppedAt: Date.now() },
        { touch: true },
      );
    }
    cancelAllQuotaWakes();
    cancelAllOrchNotices();
    // Kept-alive Claude sessions (idle between turns): kill + clear timers.
    for (const threadId of [...claudeSessions.keys()]) {
      disposeClaudeSession(threadId);
    }
    // Reap claude children that emitted result (clearRun) then hung: no longer
    // reachable via active Map handles.
    for (const child of [...liveClaudeChildren]) {
      killTree(child, 3000);
    }
    for (const pid of [...liveCodexPids]) {
      killPidTree(pid);
    }
    liveCodexPids.clear();
    // Drain any pending session transcript posts before process exit.
    void sessionRecorder.flush();
    // App quit (main.js before-quit): save() only arms a 250 ms unref'd timer,
    // and a SIGTERM never runs the exit hook that flushes it, so the idle
    // marking above would be lost. Put the bytes on disk now.
    store.saveNow();
  }

  /**
   * Await drain of the fire-and-forget exporters (tests / app-quit): the
   * session transcript queue and buffered OTel spans.
   * @returns {Promise<void>}
   */
  async function flushTranscripts() {
    try {
      await sessionRecorder.flush();
    } catch {
      // silent
    }
    try {
      await otel.flush();
      otel.stop();
    } catch {
      // silent
    }
  }

  function toWorkflowView(workflow) {
    if (!workflow) return null;
    if (workflow.__orchestrated) {
      return workflowEngine.toPublicView(workflow);
    }
    if (
      workflow.__real ||
      workflow.__claude ||
      workflow.__codex ||
      workflow.__kimi ||
      workflow.__opencode ||
      workflow.__cursor ||
      workflow.__muse
    ) {
      if (workflow.__real) return buildRealWorkflowView(workflow);
      return null;
    }
    return mapWorkflowView(workflow, core);
  }

  // Shared context for the seam modules (`electron/runner-<seam>.js`, #1447).
  // Built here, after every owned const, so seam factories may destructure
  // it eagerly. Holds only what a seam consumes; the lazy-read rule is in
  // the header of electron/runner-watchdogs.js.
  const ctx = {
    store,
    active,
    nowFn,
    resolveProvider,
    appendMessage,
    pushDetail,
    pushThreadsChanged,
    userDataPath,
    askComplete,
    searchMemory,
    bootstrapMemory,
    otel,
    isReplayTurn,
    tryReadCodeIndex,
    clearRun,
    markRunFailed,
    pushFn,
    shortError,
    providerBinAvailable,
    startRun,
    getMemStatus,
    lastWorkflowByThread,
    maybeDrainQueued,
    getIosSimulator,
    looksWriterLock,
    stopRun,
    refreshDetail,
    lastAssistantText,
    PUSH_THROTTLE_MS,
    abortIfCancelled,
    appendDoneWorkLog,
    assertProviderBinary,
    beginWorkLogStep,
    claimPreparingRun,
    completeWorkLogStep,
    crossesBoundary,
    formatRunExitError,
    noteToolSpan,
    notifyRunTerminal,
    resolveSpawn,
    settleCancelledLaunch,
    stampPreparingSteps,
    upsertThinkingCard,
    persistToolImages,
    THINKING_TRUNCATE,
    assignContextUsage,
    cursorToolCardSummary,
    runCodexFn,
    savePlanSteps,
    trackLiveCodexPid,
  };

  const {
    autoTurns,
    noteCodexRelease,
    codexSessionHeld,
    deliverNotice,
    queueOrchNotice,
    flushOrchNotices,
    sweepCrew,
    sweepDoneWorkers,
    stopCrew,
    isAutoTurn,
    cancelAll: cancelAllOrchNotices,
  } = createOrchNotices(ctx);
  // Read lazily by runner-verify-gate.js.
  Object.assign(ctx, { queueOrchNotice, flushOrchNotices, sweepDoneWorkers });
  // createPermissions destructures this eagerly.
  ctx.isAutoTurn = isAutoTurn;

  const {
    ciWorkflowSignOffs,
    getPendingPermission,
    handleCodexServerRequest,
    respondPermission,
    askUser,
    requestCiWorkflowSignOff,
    clearQuestion,
    maybePersistPlanApproval,
  } = createPermissions(ctx);

  const {
    afterFailedTurn,
    afterSuccessfulTurn,
    finishSuccessfulTurn,
  } = createVerifyGate(ctx);
  // createAskRuns destructures this eagerly, so it must be set before that call.
  ctx.finishSuccessfulTurn = finishSuccessfulTurn;

  const {
    cancelQuotaWake,
    tryQuotaFailover,
    scheduleQuotaWake,
    resumeQuotaWait,
    refreshQuotaWait,
    refreshAllQuotaWaits,
    cancelAll: cancelAllQuotaWakes,
  } = createQuotaWait(ctx);

  const {
    startAskRun,
    startBtw,
    cancelBtw,
    promoteBtw,
    listActiveBtwCount,
    stopAllBtw,
  } = createAskRuns(ctx);

  const {
    materializePendingWorktree,
    failWorktreeSetup,
    dispatchOrchCommand,
  } = createTurnSetup(ctx);

  const {
    addSubagentRow,
    noteCursorSubagent,
    setSubagentStatus,
    ingestTaskNotifications,
    finishRunningSubagents,
  } = createSubagents(ctx);
  ctx.finishRunningSubagents = finishRunningSubagents;

  const {
    sessionRecorder,
    recordSessionOnAppend,
    recordSessionAtTerminal,
  } = createSessionRecording(ctx);

  const {
    claudeSessions,
    CLAUDE_ACK_MS,
    disposeClaudeSession,
    retireClaudeSession,
    scheduleClaudeIdleReap,
  } = createClaudeSessions(ctx);

  // Provider runs (runner-provider-*.js) destructure these eagerly.
  Object.assign(ctx, {
    ingestTaskNotifications,
    noteCursorSubagent,
    handleCodexServerRequest,
  });

  const { startMuseRun } = createMuseRun(ctx);

  const { startOpencodeRun } = createOpencodeRun(ctx);

  const { startKimiRun } = createKimiRun(ctx);

  const { startCursorRun } = createCursorRun(ctx);

  const { startCodexRun } = createCodexRun(ctx);

  // Boot: nothing runs yet, so every crew is quiet. Archives workers whose
  // sweep never came — the app died mid-orchestration, or a sibling hung and
  // the orchestrator was already finished for good (issue #15).
  for (const t of store.getThreads()) {
    if (t.orchWorker && t.handoffFrom) sweepCrew(String(t.handoffFrom));
  }

  const {
    checkStalls,
    heartbeatActiveLanes,
    dispose: disposeWatchdogs,
  } = createWatchdogs(ctx);

  refreshAllQuotaWaits();

  return {
    startRun,
    steerRun,
    startBtw,
    cancelBtw,
    promoteBtw,
    startWorkflowRun,
    retryWorkflowAgent,
    stopRun,
    resumeQuotaWait,
    refreshQuotaWait,
    refreshAllQuotaWaits,
    getActiveWorkflow,
    isRunning,
    listActiveThreadIds,
    listActiveBtwCount,
    activeRunId,
    isAutoTurn,
    stopAll,
    flushTranscripts,
    workflowNameFromThreadId,
    toWorkflowView,
    resolveProvider,
    getPendingPermission,
    requestCiWorkflowSignOff,
    handleCodexServerRequest,
    respondPermission,
    askUser,
    clearQuestion,
    disposeClaudeSession,
    retireClaudeSession,
    deliverNotice,
    appendInbound,
    checkStalls,
    heartbeatActiveLanes,
    drainQueued,
    refreshDetail,
  };
}

module.exports = {
  createRunner,
  workflowNameFromThreadId,
  toWorkflowView: mapWorkflowView,
  resolveProvider,
  resolveSpawn,
  resolveSandbox,
  ADJECTIVES,
  NOUNS,
  classifyClaudeResultError,
  formatRunExitError,
  looksWriterLock,
  /** @internal test/diagnostics */
  liveClaudeChildren,
  liveCodexPids,
};
