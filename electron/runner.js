"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
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
const codexParse = require("./codex.js");
const { runCodex } = codexParse;
const kimiParse = require("./kimi.js");
const { runKimi } = kimiParse;
const {
  getProvider,
  resolveBin,
  isBinAvailable,
  listProviders,
} = require("./providers.js");
const orchcommands = require("./orchcommands.js");
const ask = require("./ask.js");
const {
  getClaudeMcpArgs,
  getCodexMcpArgs,
  getCodexMcpEnv,
  getMemoryStatus,
} = require("./memory-sup.js");
const opencodeParse = require("./opencode.js");
const { runOpencode } = opencodeParse;
const { recordRunOutcome } = require("./memory-record.js");
const { createOtel } = require("./otel.js");
const { extractImages, saveToolImages } = require("./tool-images.js");
const {
  createSessionRecorder,
  mapMessageRole,
} = require("./session-record.js");
const workflowEngine = require("./workflow.js");
const { wrapCommand } = require("./ssh.js");
const { wslTarget } = require("./wsl.js");
const { resolveSandbox } = require("./sandbox.js");
const { killTree } = require("./proc.js");
const {
  runVerifyCommand,
  buildFixPrompt,
  normalizeCommand,
  MAX_FIX_ATTEMPTS,
} = require("./verify.js");
const { maybeApplyFmTitle } = require("./fm-title.js");
const { classifyTool } = require("./guardrails.js");
const {
  decideQuotaWait,
  formatQuotaWaitClock,
  quotaWaitEnabled,
} = require("./quotaWait.js");

const KIMI_PUSH_THROTTLE_MS = 250;

/** Plan markdown shown in the approval panel; long enough for a real plan. */
const PLAN_TRUNCATE = 20000;

/**
 * Approved plan kept on the thread for its plan card. Tighter than the prompt's
 * budget: this one rides every threads:changed push, for every thread.
 */
const PLAN_STORE = 4000;

// Issue #213: keep only the newest N worker threads per orchestrator so
// fan-out cannot grow the store without bound. No settings knob; skipped
// threads still occupy a keep slot.
const MAX_WORKERS_PER_ORCHESTRATOR = 20;

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
 * @param {object | null | undefined} usage
 * @returns {number | undefined}
 */
function claudeContextTokens(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  if (
    usage.cache_read_input_tokens == null &&
    usage.cache_creation_input_tokens == null
  ) {
    return undefined;
  }
  const total =
    (Number(usage.input_tokens) || 0) +
    (Number(usage.cache_read_input_tokens) || 0) +
    (Number(usage.cache_creation_input_tokens) || 0) +
    (Number(usage.output_tokens) || 0);
  return total > 0 ? total : undefined;
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
  if (!shown.length) text = "Run error";
  else if (shown.length === 1) text = `Run error: ${shown[0]}`;
  else text = `Run error\n${shown.join("\n")}`;
  if (sessionLost) {
    text += "\nSession reset; the next message starts fresh.";
  }
  return { kind: "fail", text, sessionLost: Boolean(sessionLost) };
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
 * @returns {{ binary: string, args: string[], cwd: string }}
 */
function resolveSpawn(project, binary, args, localCwd) {
  if (!crossesBoundary(project)) {
    return { binary, args, cwd: localCwd };
  }
  const wrapped = wrapCommand(project, binary, args);
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
 * @param {string} [opts.userDataPath] - for memory auto-record
 * @param {() => { running: boolean, adopted: boolean, port: number | null }} [opts.getMemoryStatus]
 * @param {(opts: object) => Promise<{ text: string, source: string } | null>} [opts.askComplete] - Ask mode seam (issue #392)
 * @param {(query: string, projectPath: string) => Promise<object[]>} [opts.searchMemory] - Ask mode memory seam
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
  } = opts;

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

  /**
   * Live interactive Claude CLI processes per thread, kept across turns so
   * harness background tasks survive turn settle and the permission channel
   * never closes mid-request (issue #8). Reused when the spawn parameters
   * still match; killed on param change, thread delete, idle timeout, or
   * app quit. `dispatch` rebinds to the current turn's handlers on reuse.
   * @type {Map<string, { handle: object, dispatch: { onEvent: Function, onExit: Function, onError: Function }, key: string, idleTimer: ReturnType<typeof setTimeout> | null }>}
   */
  const claudeSessions = new Map();

  // ponytail: fixed idle ceiling — background work longer than this must
  // detach (nohup); add child-process introspection if that ever hurts.
  const CLAUDE_IDLE_REAP_MS = 30 * 60 * 1000;
  // A reused warm CLI answers a stdin turn in milliseconds (measured on 2.1.219:
  // command_lifecycle at 0ms, system/init at ~31-46ms), so this is ~1000x the
  // real ACK. Read at arm time so a test can shorten the window.
  const CLAUDE_ACK_MS = 60_000;

  // ponytail: fixed LRU cap — an 8-worker fan-out otherwise leaves 8 idle CLIs
  // resident for the full half hour (issue #36). Make it a setting if 3 chafes.
  const CLAUDE_IDLE_MAX = 3;

  /** Kill and forget a thread's kept-alive Claude CLI (if any). */
  function disposeClaudeSession(threadId) {
    const sess = claudeSessions.get(threadId);
    if (!sess) return;
    claudeSessions.delete(threadId);
    if (sess.idleTimer) clearTimeout(sess.idleTimer);
    try {
      if (sess.handle) sess.handle.kill();
    } catch {
      // already dead
    }
    finishRunningSubagents(threadId);
  }

  /**
   * In-session subagents spawned via the Agent tool (issue #21). The CLI
   * runs them internally, so the only trace is its stream: the spawning
   * tool_use, its tool_result, and — for background agents — a later
   * <task-notification> user text. Rows live on the thread record (keyed by
   * tool_use id) so the Agents panel can list them; capped to the newest 20
   * so a long thread never accumulates unbounded rows.
   */
  const SUBAGENT_ROWS_MAX = 20;

  function subagentRows(threadId) {
    const thread = store.getThread(threadId);
    return thread && Array.isArray(thread.subagents) ? thread.subagents : [];
  }

  function addSubagentRow(threadId, row) {
    if (!store.getThread(threadId)) return;
    store.updateThread(threadId, {
      subagents: [...subagentRows(threadId), row].slice(-SUBAGENT_ROWS_MAX),
    });
  }

  /** Flip a running row's status; false when no such row (not a subagent). */
  function setSubagentStatus(threadId, toolUseId, status) {
    const rows = subagentRows(threadId);
    if (!rows.some((r) => r.id === toolUseId && r.status === "running")) {
      return false;
    }
    store.updateThread(threadId, {
      subagents: rows.map((r) =>
        r.id === toolUseId ? { ...r, status } : r,
      ),
    });
    return true;
  }

  /**
   * A <task-notification> block pairs back to the Agent call that spawned
   * the finished background agent via its <tool-use-id>.
   */
  function applyTaskNotifications(threadId, text) {
    let changed = false;
    const blocks = text.matchAll(
      /<task-notification>([\s\S]*?)<\/task-notification>/g,
    );
    for (const [, body] of blocks) {
      const id = body.match(/<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/);
      if (!id) continue;
      const status = body.match(/<status>\s*([^<\s]+)\s*<\/status>/);
      const failed = status ? /fail|error|cancel|kill/i.test(status[1]) : false;
      changed =
        setSubagentStatus(threadId, id[1], failed ? "failed" : "done") ||
        changed;
    }
    return changed;
  }

  /**
   * CLI death (idle reap, param change, thread delete, quit) takes its
   * background subagents with it — settle any still-running rows so the
   * panel never shows a live badge for a dead agent.
   */
  function finishRunningSubagents(threadId) {
    const rows = subagentRows(threadId);
    if (!rows.some((r) => r.status === "running")) return;
    store.updateThread(threadId, {
      subagents: rows.map((r) =>
        r.status === "running" ? { ...r, status: "done" } : r,
      ),
    });
    store.save();
    pushDetail(threadId, null);
  }

  /** Arm the idle reaper after a turn settles; disarmed on reuse. */
  function scheduleClaudeIdleReap(threadId) {
    const sess = claudeSessions.get(threadId);
    if (!sess || sess.idleTimer) return;
    sess.idleTimer = setTimeout(
      () => disposeClaudeSession(threadId),
      CLAUDE_IDLE_REAP_MS,
    );
    // Never hold the process open for a reap timer.
    if (typeof sess.idleTimer.unref === "function") sess.idleTimer.unref();
    // Re-insert so Map order reads least → most recently idled, then reap
    // everything past the cap. Sessions mid-turn have no timer: never counted,
    // never killed.
    claudeSessions.delete(threadId);
    claudeSessions.set(threadId, sess);
    const idle = [...claudeSessions]
      .filter(([, s]) => s.idleTimer)
      .map(([id]) => id);
    for (const id of idle.slice(0, Math.max(0, idle.length - CLAUDE_IDLE_MAX))) {
      disposeClaudeSession(id);
    }
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

  /** Batched session transcript recorder (POST /api/session). */
  const sessionRecorder = createSessionRecorder({
    userDataPath,
    getStatus: getMemStatus,
  });

  /**
   * Whether this thread should be mirrored into shared session history.
   * Never record simulate-provider runs (env override or thread provider).
   * @param {object | null | undefined} thread
   * @param {string} [providerOverride]
   */
  function shouldRecordSession(thread, providerOverride) {
    if (!thread) return false;
    if (process.env.CODER_SIMULATE === "1") return false;
    const provider =
      providerOverride != null
        ? String(providerOverride)
        : String(thread.provider || "");
    if (provider === "simulate") return false;
    return true;
  }

  /**
   * Build base session fields from thread + project at record time.
   * @param {object} thread
   */
  function sessionBaseFields(thread) {
    const project = store.getProject(thread.projectId);
    return {
      sessionId: thread.id,
      // Raw repo path; the memory server canonicalizes it (see project-key.js there).
      project: project && project.path ? String(project.path) : null,
      threadTitle: thread.title != null ? String(thread.title) : "",
      agent: thread.provider != null ? String(thread.provider) : "unknown",
    };
  }

  /**
   * Record user/event messages immediately on append (batched HTTP).
   * Assistant/tool are deferred to run-terminal (see notifyRunTerminal).
   * @param {string} threadId
   * @param {string} role
   * @param {string} text
   */
  function recordSessionOnAppend(threadId, role, text) {
    try {
      if (role !== "user" && role !== "event") return;
      const thread = store.getThread(threadId);
      if (!shouldRecordSession(thread)) return;
      const mapped = mapMessageRole(role);
      if (!mapped) return;
      const content = text == null ? "" : String(text);
      if (!content) return;
      sessionRecorder.recordTranscript([
        {
          ...sessionBaseFields(thread),
          role: mapped,
          content,
        },
      ]);
    } catch {
      // never affect the run path
    }
  }

  /**
   * Record final assistant + tool messages for a run once at terminal.
   * @param {string} threadId
   * @param {string | null | undefined} runId
   * @param {object} thread
   */
  function recordSessionAtTerminal(threadId, runId, thread) {
    try {
      if (!shouldRecordSession(thread)) return;
      const base = sessionBaseFields(thread);
      const msgs = store.getMessages(threadId) || [];
      /** @type {object[]} */
      const entries = [];
      for (const m of msgs) {
        if (!m || (m.role !== "assistant" && m.role !== "tool")) continue;
        // Prefer this run's messages when runId is known.
        if (runId && m.runId && m.runId !== runId) continue;
        if (runId && !m.runId) continue;
        const mapped = mapMessageRole(m.role);
        if (!mapped) continue;
        const content = m.text == null ? "" : String(m.text);
        if (!content) continue;
        entries.push({
          ...base,
          role: mapped,
          content,
        });
      }
      if (entries.length > 0) {
        sessionRecorder.recordTranscript(entries);
      }
    } catch {
      // never affect the run path
    }
  }

  /**
   * Pending wake-ups: threadId -> notice lines. Worker-finished notices,
   * peer messages, and task-unblock pokes share this one queue. Idle
   * threads start a run immediately; a running thread flushes at its own
   * terminal. The orchestrator no longer needs the user to relay.
   * @type {Map<string, string[]>}
   */
  const orchNotices = new Map();

  /**
   * Consecutive machine-delivered turns per thread (issue #277). A notice
   * flush increments; a user-initiated startRun resets to 0. At
   * CREW_AUTO_TURN_CAP the next flush is refused through the same
   * undeliverable path as the orchestration-budget gate.
   * @type {Map<string, number>}
   */
  const autoTurns = new Map();

  /**
   * Append a line to the notice queue. Caller already checked the thread
   * exists. Does not flush.
   * @param {string} threadId
   * @param {string} line
   */
  function enqueueNotice(threadId, line) {
    const notes = orchNotices.get(threadId) || [];
    notes.push(line);
    orchNotices.set(threadId, notes);
  }

  /**
   * Queue a line for a thread and try to deliver it as a run. Same rules as
   * worker-finished notices: idle threads start immediately, a running
   * thread flushes at its own terminal. The caller owns the prefix (peer
   * lines arrive as `[peer from …]`); do not add `[orchestration]`.
   * Unknown threadId is a silent no-op. Never throws.
   * @param {{ threadId?: unknown, line?: unknown }} [input]
   */
  function deliverNotice(input) {
    try {
      const threadId =
        input && input.threadId != null ? String(input.threadId) : "";
      if (!threadId || !store.getThread(threadId)) return;
      const line = input && input.line != null ? String(input.line) : "";
      if (!line) return;
      enqueueNotice(threadId, line);
      flushOrchNotices(threadId);
    } catch {
      // silent
    }
  }

  /**
   * Queue a worker-finished notice for the worker's orchestrator, then try
   * to deliver. No-op for non-workers. Never throws.
   * @param {string} threadId - the worker whose run just landed
   * @param {"done" | "failed"} status
   */
  function queueOrchNotice(threadId, status) {
    const thread = store.getThread(threadId);
    if (!thread || !thread.orchWorker || !thread.handoffFrom) return;
    const parentId = String(thread.handoffFrom);
    if (!store.getThread(parentId)) return;
    let line = "";
    const msgs = store.getMessages(threadId) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === "assistant" && m.text != null && String(m.text)) {
        line = String(m.text).split(/\r?\n/)[0];
        break;
      }
    }
    const title = thread.title ? ` ("${thread.title}")` : "";
    // Its commits are on its own branch and nowhere else until the lead lands
    // them, and nothing else ever will — say so at the one moment the lead is
    // awake and looking at this worker.
    const merge =
      status === "done" && thread.worktreePath
        ? ` Its work is still only on branch ${thread.branch || "(its own)"}:` +
          ` check it, then call thread_merge with workerThreadId ${threadId}` +
          ` to land it and clean up its worktree.`
        : "";
    enqueueNotice(
      parentId,
      `Worker thread ${threadId}${title} finished with status ${status}.` +
        (line ? ` Last reply: ${line}` : "") +
        merge,
    );
    flushOrchNotices(parentId);
  }

  /**
   * Join queued lines into the run prompt. Lines that already start with
   * `[` (peer / caller-prefixed) keep that prefix; worker-finished lines
   * still get `[orchestration]`.
   * @param {string[]} notes
   * @returns {string}
   */
  function noticePrompt(notes) {
    const body = notes.join("\n");
    const headed = /^\s*\[/.test(body) ? body : "[orchestration] " + body;
    return headed + "\nContinue orchestrating; thread_status has full details.";
  }

  /**
   * Deliver queued worker notices as one run on the orchestrator thread.
   * Skips while the orchestrator is mid-run (every terminal path calls
   * clearRun before this hook, so its own terminal re-flushes). Never throws.
   * @param {string} threadId - the orchestrator thread
   */
  function flushOrchNotices(threadId) {
    const notes = orchNotices.get(threadId);
    if (!notes || notes.length === 0) return;
    if (active.has(threadId)) return;
    orchNotices.delete(threadId);
    if (!store.getThread(threadId)) return;
    const prompt = noticePrompt(notes);
    // Per-orchestration ceiling (issue #67) and consecutive auto-turn cap
    // (issue #277): refuse the wake-up here, not in startRun, so user-sent
    // turns (and "Retry turn" after raising a cap) still run. The catch
    // below surfaces the refusal exactly like the daily-budget gate.
    Promise.resolve()
      .then(() => {
        services.assertUnderOrchestrationBudget(store, threadId);
        const n = autoTurns.get(threadId) || 0;
        if (n >= services.CREW_AUTO_TURN_CAP) {
          throw new Error(
            `Crew auto-turn cap reached (${services.CREW_AUTO_TURN_CAP} consecutive machine-delivered turns). A human turn resets it.`,
          );
        }
        autoTurns.set(threadId, n + 1);
        return startRun({ threadId, prompt, fromNotice: true });
      })
      .catch((err) => {
      // Undeliverable (budget gate, missing CLI): the orchestration stops
      // advancing right here, so say why and land the thread "failed" —
      // that badges the sidebar, arms "Retry turn", and fires the desktop
      // notification (issue #34). A quiet event alone reads as "still going".
      try {
        const reason = err && err.message ? String(err.message) : String(err);
        appendMessage(threadId, "event", `${prompt}\n\nNot delivered: ${reason}`);
        // A run that raced in after the active guard above owns the status;
        // only an idle orchestrator is really stalled.
        if (!active.has(threadId)) {
          store.updateThread(
            threadId,
            {
              status: "failed",
              lastError: shortError(`Not delivered: ${reason}`),
            },
            { touch: true },
          );
        }
        store.save();
        pushDetail(threadId, lastWorkflowByThread.get(threadId) || null);
        pushThreadsChanged();
      } catch {
        // silent
      }
    });
  }

  /**
   * Failed worker (or any failed terminal) queues a notice and delivers
   * whatever was waiting on this thread. Never throws.
   * @param {string} threadId
   */
  function afterFailedTurn(threadId) {
    try {
      const failed = store.getThread(threadId);
      const outcome =
        failed && failed.lastError ? String(failed.lastError) : "failed";
      services.releaseCrewTasks(store, { threadId, outcome });
    } catch {
      // silent
    }
    try {
      queueOrchNotice(threadId, "failed");
      flushOrchNotices(threadId);
    } catch {
      // silent
    }
    sweepDoneWorkers(threadId);
    maybeDrainQueued(threadId);
  }

  /**
   * After a successful turn lands status "done": best-effort worktree
   * checkpoint commit and orchestrator wake-up. Shared across every
   * provider path (and sim). Never throws into the run lifecycle.
   *
   * When the thread has a verifyCommand the gate runs here, after the
   * checkpoint so the evidence can pin to a sha that already exists.
   * Status flips back to "working" first: the thread must not sit green
   * while the command is in flight. Orch wake-up waits for the proof.
   * @param {string} threadId
   */
  function afterSuccessfulTurn(threadId) {
    // First completed assistant reply: best-effort fm title. Never blocks
    // checkpoint / verify; push if a title actually landed.
    void maybeApplyFmTitle(store, threadId)
      .then((title) => {
        if (!title) return;
        try {
          pushDetail(threadId);
          pushThreadsChanged();
        } catch {
          // silent
        }
      })
      .catch(() => {});

    let gated = false;
    try {
      gated = shouldVerify(threadId);
    } catch {
      gated = false;
    }
    if (gated) {
      try {
        // runStartedAt was cleared at the terminal; restamp it or the
        // sidebar shows "Working" with no elapsed time for however many
        // minutes the verify command takes.
        store.updateThread(
          threadId,
          { status: "working", runStartedAt: Date.now() },
          { touch: true },
        );
        store.save();
        pushThreadsChanged();
      } catch {
        // still try to run the command
      }
      void (async () => {
        let sha = null;
        try {
          const { maybeCreateCheckpoint } = require("./worktrees.js");
          const ckpt = await maybeCreateCheckpoint(store, threadId);
          if (ckpt && ckpt.sha) sha = ckpt.sha;
        } catch {
          // silent
        }
        if (!sha) sha = await worktreeHeadSha(threadId);
        await runVerifyGate(threadId, sha);
      })().catch((err) => {
        try {
          settleVerifyCrash(threadId, err);
        } catch {
          // silent
        }
      });
      return;
    }
    try {
      const { maybeCreateCheckpoint } = require("./worktrees.js");
      void maybeCreateCheckpoint(store, threadId);
    } catch {
      // silent
    }
    finishSuccessfulTurn(threadId);
  }

  /**
   * Armed when the thread has a non-empty verifyCommand and this was not
   * a simulate run. Simulate settles on the agent's word alone.
   * @param {string} threadId
   */
  function shouldVerify(threadId) {
    const thread = store.getThread(threadId);
    if (!thread) return false;
    if (resolveProvider(thread) === "simulate") return false;
    return Boolean(normalizeCommand(thread.verifyCommand));
  }

  /**
   * HEAD of the thread worktree, or null. Used when the tree was already
   * clean so maybeCreateCheckpoint made no commit to pin to.
   *
   * Async on purpose: an execFileSync here blocks the main process for the
   * length of a git call on every gated turn, which is the freeze the PR
   * refresher was rewritten to avoid.
   * @param {string} threadId
   */
  async function worktreeHeadSha(threadId) {
    try {
      const thread = store.getThread(threadId);
      if (!thread || !thread.worktreePath) return null;
      const { gitTryAsync } = require("./worktrees.js");
      const rev = await gitTryAsync(thread.worktreePath, ["rev-parse", "HEAD"]);
      if (!rev.ok || !rev.stdout) return null;
      return String(rev.stdout).trim() || null;
    } catch {
      return null;
    }
  }

  function lastRunIdFor(threadId) {
    const msgs = store.getMessages(threadId) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].runId) return String(msgs[i].runId);
    }
    return "unknown";
  }

  /**
   * Attempt 0 on a fresh user turn. Increment only when the stored verify
   * is a failure from this same turn (the last user message is the fix
   * prompt we handed back). A new user prompt resets the counter so a
   * thread's whole life does not accumulate toward the cap.
   * @param {object} thread
   */
  function nextVerifyAttempt(thread) {
    const prev = thread.verify;
    if (!prev || prev.ok) return 0;
    const msgs = store.getMessages(thread.id) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== "user") continue;
      if (String(msgs[i].text || "").startsWith("[verification failed]")) {
        return (Number(prev.attempt) || 0) + 1;
      }
      return 0;
    }
    return 0;
  }

  function finishSuccessfulTurn(threadId) {
    try {
      queueOrchNotice(threadId, "done");
      flushOrchNotices(threadId);
    } catch {
      // silent
    }
    sweepDoneWorkers(threadId);
    maybeDrainQueued(threadId);
  }

  function settleVerifyCrash(threadId, err) {
    const reason = err && err.message ? String(err.message) : String(err);
    appendMessage(threadId, "event", `Verification error: ${reason}`);
    store.updateThread(
      threadId,
      {
        status: "failed",
        runStartedAt: null,
        lastError: shortError(`Verification error: ${reason}`),
      },
      { touch: true },
    );
    store.save();
    pushThreadsChanged();
    afterFailedTurn(threadId);
  }

  /**
   * Run the thread's verify command and settle or hand a fix turn back.
   * Never rejects to the caller: spawn failures become an ok:false result.
   * @param {string} threadId
   * @param {string | null} sha
   */
  async function runVerifyGate(threadId, sha) {
    const thread = store.getThread(threadId);
    if (!thread) return;
    const command = normalizeCommand(thread.verifyCommand);
    // Cleared mid-flight: settle as if the gate was never armed.
    if (!command) {
      store.updateThread(
        threadId,
        { status: "done", runStartedAt: null },
        { touch: true },
      );
      store.save();
      finishSuccessfulTurn(threadId);
      return;
    }
    const project = store.getProject(thread.projectId);
    const cwd =
      thread.worktreePath || (project && project.path) || process.cwd();
    const attempt = nextVerifyAttempt(thread);
    const runId = lastRunIdFor(threadId);
    let raw;
    try {
      raw = await runVerifyCommand({ command, cwd, project });
    } catch (err) {
      raw = {
        ok: false,
        exitCode: null,
        timedOut: false,
        log: err && err.message ? String(err.message) : String(err),
        durationMs: 0,
      };
    }
    const latest = store.getThread(threadId);
    if (!latest || !normalizeCommand(latest.verifyCommand)) {
      if (latest) {
        store.updateThread(
        threadId,
        { status: "done", runStartedAt: null },
        { touch: true },
      );
        store.save();
        finishSuccessfulTurn(threadId);
      }
      return;
    }
    /** @type {import('../src/shared/ipc').VerifyResult} */
    const result = {
      runId,
      command,
      ok: Boolean(raw.ok),
      exitCode: raw.exitCode,
      timedOut: Boolean(raw.timedOut),
      log: raw.log || "",
      sha,
      durationMs: Number(raw.durationMs) || 0,
      at: Date.now(),
      attempt,
    };

    if (result.ok) {
      const secs = Math.round(result.durationMs / 1000);
      appendMessage(
        threadId,
        "event",
        `Verified: ${command} passed in ${secs}s`,
      );
      store.updateThread(
        threadId,
        { verify: result, status: "done", runStartedAt: null },
        { touch: true },
      );
      store.save();
      pushDetail(threadId);
      pushThreadsChanged();
      finishSuccessfulTurn(threadId);
      return;
    }

    // `attempt` is how many fix prompts already went back, so this hands
    // out exactly MAX_FIX_ATTEMPTS of them — matching the "Fix attempt N
    // of M" line buildFixPrompt shows the agent.
    if (attempt < MAX_FIX_ATTEMPTS) {
      appendMessage(threadId, "event", `Verification failed: ${command}`);
      store.updateThread(threadId, { verify: result }, { touch: true });
      store.save();
      pushDetail(threadId);
      pushThreadsChanged();
      const prompt = buildFixPrompt(result);
      Promise.resolve()
        .then(() => startRun({ threadId, prompt }))
        .catch((err) => {
          try {
            const reason =
              err && err.message ? String(err.message) : String(err);
            appendMessage(
              threadId,
              "event",
              `${prompt}\n\nNot delivered: ${reason}`,
            );
            if (!active.has(threadId)) {
              store.updateThread(
                threadId,
                {
                  status: "failed",
                  lastError: shortError(`Not delivered: ${reason}`),
                },
                { touch: true },
              );
            }
            store.save();
            pushDetail(threadId, lastWorkflowByThread.get(threadId) || null);
            pushThreadsChanged();
          } catch {
            // silent
          }
        });
      return;
    }

    appendMessage(threadId, "event", `Verification failed: ${command}`);
    store.updateThread(
      threadId,
      {
        verify: result,
        status: "failed",
        runStartedAt: null,
        lastError: shortError(`Verification failed: ${command}`),
      },
      { touch: true },
    );
    store.save();
    pushDetail(threadId);
    pushThreadsChanged();
    afterFailedTurn(threadId);
  }

  /**
   * Archive one orchestrator's finished workers once its crew is quiet.
   * "Quiet" means no crew member has a LIVE run: a worker left at "working"
   * by a crash or a CLI that never lands would otherwise pin the whole crew
   * open forever (issue #15).
   * @param {string} threadId - the orchestrator thread
   */
  function sweepCrew(threadId) {
    const crew = store
      .getThreads()
      .filter((t) => t.orchWorker && t.handoffFrom === threadId);
    if (crew.length === 0) return;
    // Every terminal path calls clearRun before this hook, so a worker that
    // just landed is already out of `active`.
    if (crew.some((t) => t.status === "working" && active.has(t.id))) return;
    let changed = false;
    for (const t of crew) {
      // "idle" is a terminal too: stopped runs and app-quit interrupts land
      // there (grok CLIs often end "cancelled" after finishing their work).
      // pendingFork idle means the worker never ran — leave it visible.
      const finished =
        t.status === "done" || (t.status === "idle" && !t.pendingFork);
      if (finished && !t.archived) {
        // Not real activity: no touch, same as threads:setArchived.
        store.updateThread(t.id, { archived: true });
        changed = true;
      }
    }
    // Newest first. Equal createdAt (same-ms forks) break ties by insertion
    // index so the later-minted worker is kept.
    const indexed = crew.map((t, i) => ({ t, i }));
    indexed.sort((a, b) => (b.t.createdAt - a.t.createdAt) || (b.i - a.i));
    for (let i = MAX_WORKERS_PER_ORCHESTRATOR; i < indexed.length; i++) {
      const t = indexed[i].t;
      if (
        t.status !== "done" &&
        t.status !== "failed" &&
        t.status !== "stopped"
      ) {
        continue;
      }
      if (active.has(t.id) || t.worktreePath || t.pinnedAt) continue;
      services.purgeThread(store, t.id);
      changed = true;
    }
    if (changed) {
      store.save();
      pushThreadsChanged();
    }
  }

  /**
   * Sweep the crews this run terminal can settle: the thread's own workers
   * (it is an orchestrator) and, when the thread is itself a worker, its
   * orchestrator's crew — the orchestrator can be finished for good, in
   * which case its terminal never comes again and waiting for it leaves the
   * workers open forever (issue #15). Never throws.
   * @param {string} threadId
   */
  function sweepDoneWorkers(threadId) {
    try {
      sweepCrew(threadId);
      const self = store.getThread(threadId);
      if (self && self.orchWorker && self.handoffFrom) {
        sweepCrew(String(self.handoffFrom));
      }
    } catch {
      // silent
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
    // Checkpoint first so every provider that signals done through here is
    // covered by one call site (generic/claude/codex/kimi/opencode/workflow).
    if (status === "done") {
      afterSuccessfulTurn(threadId);
    } else if (status === "failed") {
      const parked = store.getThread(threadId);
      if (parked && parked.status === "quota-wait") {
        // Parked on a reset clock: not a failure. Skip orch wake-up, crew
        // release, and the queued drain — those belong to a real terminal.
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
        !(status === "failed" && thread.status === "quota-wait")
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
      const runId =
        extras.runId !== undefined
          ? extras.runId
          : active.get(threadId)
            ? active.get(threadId).runId
            : null;
      // active is often already cleared before notifyRunTerminal; prefer
      // extras.runId when callers pass it. Fall back to last assistant's runId.
      let resolvedRunId = runId;
      if (resolvedRunId == null) {
        const msgs = store.getMessages(threadId) || [];
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].runId) {
            resolvedRunId = msgs[i].runId;
            break;
          }
        }
      }
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
    // Verify restamps status "working"; skip so we don't start the queued
    // prompt on top of the gate. The verify settle path drains instead.
    // A parked quota-wait is not a terminal — don't drain onto it.
    const settled = store.getThread(threadId);
    if (!settled || settled.status !== "quota-wait") {
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
        prompt: taken.prompt,
        attachments: taken.attachments,
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
    void drainQueued(threadId);
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
   * Index of the first element that differs, by reference. The store patches
   * messages/work-log items immutably ({...old, ...patch}), so an unchanged
   * item keeps its identity and everything before the first difference is
   * already on the renderer.
   * @param {unknown[] | undefined} prev
   * @param {unknown[]} next
   */
  function firstChanged(prev, next) {
    if (!prev) return 0;
    const n = Math.min(prev.length, next.length);
    let i = 0;
    while (i < n && prev[i] === next[i]) i++;
    return i;
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
        workflow.__opencode
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

  /**
   * Oldest unanswered permission prompt of the thread's active run, shaped
   * for the renderer (no rawInput), or null.
   * @param {string} threadId
   * @returns {{
   *   requestId: string,
   *   toolName: string,
   *   summary: string,
   *   input: string,
   *   questions: ReturnType<typeof questionInfo>,
   *   plan: ReturnType<typeof planText>,
   *   guardrail: { rule: string | null, reason: string } | null,
   * } | null}
   */
  function getPendingPermission(threadId) {
    const e = active.get(threadId);
    if (!e || e.kind !== "claude" || !Array.isArray(e.pendingPermissions)) {
      return null;
    }
    const p = e.pendingPermissions[0];
    if (!p) return null;
    return {
      requestId: p.id,
      toolName: p.toolName,
      summary: p.summary,
      input: p.input,
      questions: questionInfo(p.toolName, p.rawInput),
      plan: planText(p.toolName, p.rawInput),
      guardrail: p.guardrail || null,
    };
  }

  /**
   * ExitPlanMode input -> the plan markdown for the renderer's plan card, or
   * null when this permission isn't a plan approval. Plans are prose, not tool
   * args, so they get their own (larger) budget than the JSON preview.
   * @param {string} toolName
   * @param {Record<string, unknown>} rawInput
   */
  function planText(toolName, rawInput) {
    if (toolName !== "ExitPlanMode") return null;
    const plan = rawInput && typeof rawInput.plan === "string" ? rawInput.plan : "";
    return plan ? truncate(plan, PLAN_TRUNCATE) : null;
  }

  /**
   * AskUserQuestion input -> sanitized questions for the renderer's option
   * picker, or null when this permission isn't a question prompt.
   * @param {string} toolName
   * @param {Record<string, unknown>} rawInput
   */
  function questionInfo(toolName, rawInput) {
    if (toolName !== "AskUserQuestion") return null;
    const qs = rawInput && Array.isArray(rawInput.questions) ? rawInput.questions : [];
    const out = [];
    for (const q of qs) {
      if (!q || typeof q.question !== "string" || !Array.isArray(q.options)) {
        continue;
      }
      const options = q.options
        .filter((o) => o && typeof o.label === "string" && o.label)
        .map((o) => ({
          label: o.label,
          description: typeof o.description === "string" ? o.description : "",
        }));
      if (options.length === 0) continue;
      out.push({
        question: q.question,
        header: typeof q.header === "string" ? q.header : "",
        multiSelect: q.multiSelect === true,
        options,
      });
    }
    return out.length > 0 ? out : null;
  }

  /**
   * Answer a pending permission prompt. For question prompts, `answers`
   * (question text -> chosen label) rides back as updatedInput.answers.
   * @param {{ threadId: string, requestId: string, decision: "allow" | "allowAlways" | "deny", answers?: Record<string, string> }} input
   */
  function respondPermission(input) {
    const { threadId, requestId, decision, answers } = input || {};
    const e = active.get(threadId);
    if (!e || e.kind !== "claude" || !e.handle) {
      throw new Error("No active agent run for this thread");
    }
    const idx = e.pendingPermissions.findIndex((p) => p.id === requestId);
    if (idx < 0) {
      throw new Error("Permission request no longer pending");
    }
    const [pending] = e.pendingPermissions.splice(idx, 1);
    const answerMap =
      answers && typeof answers === "object" && !Array.isArray(answers)
        ? answers
        : null;
    const isPlan = pending.toolName === "ExitPlanMode";
    let response;
    if (decision === "allow" || decision === "allowAlways") {
      response = {
        behavior: "allow",
        updatedInput: answerMap
          ? { ...pending.rawInput, answers: answerMap }
          : pending.rawInput,
      };
      if (decision === "allowAlways") {
        // "Accept all": stop asking for this tool for the rest of the CLI
        // session (matches Claude Code's own "don't ask again" scope).
        response.updatedPermissions = [
          {
            type: "addRules",
            rules: [{ toolName: pending.toolName }],
            behavior: "allow",
            destination: "session",
          },
        ];
      }
    } else {
      response = {
        behavior: "deny",
        message: isPlan
          ? "Plan rejected by user in Coder; keep planning"
          : "Denied by user in Coder",
      };
    }
    e.handle.respond(pending.id, response);
    if (isPlan && decision !== "deny") {
      const t = store.getThread(threadId);
      const patch = {};
      // The approved plan outlives this prompt: the thread's plan card shows
      // it once the prompt is answered and gone (issue #75).
      const approved = planText(pending.toolName, pending.rawInput);
      if (approved) patch.plan = truncate(approved, PLAN_STORE);
      // Approving the plan leaves plan mode, so the next run must not re-enter
      // it — the CLI only exits for the process that asked.
      if (t && t.permissionMode === "plan") patch.permissionMode = "default";
      if (t && Object.keys(patch).length > 0) {
        store.updateThread(threadId, patch);
      }
    }
    const label = isPlan
      ? decision === "deny"
        ? "Plan rejected"
        : "Plan approved"
      : decision === "deny"
        ? `Denied: ${pending.summary}`
        : answerMap
          ? `Answered: ${truncate(Object.values(answerMap).join("; "), 200)}`
          : decision === "allowAlways"
            ? `Allowed for session: ${pending.summary}`
            : `Allowed: ${pending.summary}`;
    appendMessage(threadId, "event", label, e.runId);
    if (e.pendingPermissions.length === 0) {
      store.updateThread(threadId, { awaitingInput: false });
    }
    store.save();
    pushDetail(threadId, e.claudeState);
    pushThreadsChanged();
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
   */
  function appendMessage(
    threadId,
    role,
    text,
    runId = null,
    tool = null,
    attachments = null,
  ) {
    /** @type {{ id: string, role: string, text: string, createdAt: number, runId?: string, tool?: object, attachments?: object[] }} */
    const msg = {
      id: randomUUID(),
      role,
      text,
      createdAt: Date.now(),
    };
    if (runId) msg.runId = runId;
    if (tool) msg.tool = tool;
    if (attachments && attachments.length) msg.attachments = attachments;
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
   * Quota-wait (#462): one timer per parked thread. Wake once; a second
   * quota error on the same prompt fails. Distinct from #286 / #294.
   * @type {Map<string, ReturnType<typeof setTimeout>>}
   */
  const quotaTimers = new Map();

  function cancelQuotaWake(threadId) {
    const t = quotaTimers.get(threadId);
    if (!t) return;
    clearTimeout(t);
    quotaTimers.delete(threadId);
  }

  function lastUserOnThread(threadId) {
    const msgs = store.getMessages(threadId) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && msgs[i].role === "user") return msgs[i];
    }
    return null;
  }

  /**
   * Park or fail. Call instead of writing status:"failed" on a provider
   * turn so the first threads:changed never flashes Failed.
   * @param {string} threadId
   * @param {string} errText
   * @param {object} [extraPatch]
   * @returns {{ parked: boolean, until?: number }}
   */
  function markRunFailed(threadId, errText, extraPatch) {
    const park = decideQuotaWait({
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
          lastError: shortError(errText),
          quotaWaitUntil: park.until,
        },
        { touch: true },
      );
      appendMessage(
        threadId,
        "event",
        `Quota wait: usage limit reached. Resuming at ${formatQuotaWaitClock(park.until)}.`,
      );
      scheduleQuotaWake(threadId, park.until);
      return { parked: true, until: park.until };
    }
    store.updateThread(
      threadId,
      {
        ...(extraPatch || {}),
        status: "failed",
        runStartedAt: null,
        lastError: shortError(errText),
      },
      { touch: true },
    );
    return { parked: false };
  }

  function scheduleQuotaWake(threadId, until) {
    cancelQuotaWake(threadId);
    const delay = Math.max(1000, Number(until) + 2000 - Date.now());
    const cap = Math.min(delay, 2147483647);
    const timer = setTimeout(() => {
      quotaTimers.delete(threadId);
      void fireQuotaWake(threadId);
    }, cap);
    if (typeof timer.unref === "function") timer.unref();
    quotaTimers.set(threadId, timer);
  }

  async function fireQuotaWake(threadId) {
    const thread = store.getThread(threadId);
    if (!thread || thread.status !== "quota-wait") return;
    if (!quotaWaitEnabled(thread, store.getSettings())) return;
    if (active.has(threadId)) return;
    const user = lastUserOnThread(threadId);
    if (!user || !String(user.text || "").trim()) {
      store.updateThread(
        threadId,
        {
          status: "failed",
          quotaWaitUntil: null,
          lastError: shortError("Quota wait: nothing to resume"),
        },
        { touch: true },
      );
      store.save();
      pushDetail(threadId);
      pushThreadsChanged();
      return;
    }
    try {
      await startRun({
        threadId,
        prompt: user.text,
        attachments: user.attachments,
        fromQuotaWait: true,
      });
    } catch (err) {
      const reason = err && err.message ? String(err.message) : String(err);
      store.updateThread(
        threadId,
        {
          status: "failed",
          quotaWaitUntil: null,
          quotaWaitResumed: true,
          lastError: shortError(`Quota wait: resume failed: ${reason}`),
        },
        { touch: true },
      );
      appendMessage(
        threadId,
        "event",
        `Quota wait: resume failed: ${reason}`,
      );
      store.save();
      pushDetail(threadId);
      pushThreadsChanged();
    }
  }

  /**
   * Resume a parked quota-wait now (banner / IPC). Counts as the one-shot.
   * @param {{ threadId: string }} input
   */
  async function resumeQuotaWait(input) {
    const threadId = input && input.threadId;
    const thread = store.getThread(threadId);
    if (!thread) throw new Error(`Unknown thread: ${threadId}`);
    if (thread.status !== "quota-wait") {
      throw new Error("Thread is not waiting on a provider quota reset");
    }
    cancelQuotaWake(threadId);
    if (active.has(threadId)) {
      throw new Error("A run is already active on this thread");
    }
    const user = lastUserOnThread(threadId);
    if (!user || !String(user.text || "").trim()) {
      throw new Error("Quota wait: nothing to resume");
    }
    return startRun({
      threadId,
      prompt: user.text,
      attachments: user.attachments,
      fromQuotaWait: true,
    });
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
    if (thread && (thread.stalledAt != null || thread.lastEventAt != null)) {
      store.updateThread(threadId, { stalledAt: null, lastEventAt: null });
    }
  }

  /**
   * Start a simulated multi-phase @coder/core ticker run.
   */
  function startSimulatedRun(threadId, prompt, runId, name) {
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
        markRunFailed(threadId, errText);
        appendMessage(threadId, "event", errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, current);
        pushThreadsChanged();
        afterFailedTurn(threadId);
      }
    }, tickMs);

    const entry = {
      kind: "sim",
      timer,
      runId,
      phaseItemIds,
      phaseSettled,
    };
    Object.defineProperty(entry, "workflow", {
      get() {
        return current;
      },
      enumerable: true,
    });
    active.set(threadId, entry);

    return { runId };
  }

  /**
   * Start a real generic agent child-process run (CODER_AGENT_CMD).
   */
  function startGenericRun(threadId, prompt, runId, name) {
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

    store.save();
    pushThreadsChanged();
    pushDetail(threadId, realState);

    /** @type {string | null} */
    let assistantMsgId = null;

    const localCwd = thread.worktreePath || project.path;

    const entry = {
      kind: "generic",
      runId,
      stopping: false,
      handle: null,
      startingId,
      respondingId,
      realState,
    };
    Object.defineProperty(entry, "workflow", {
      get() {
        return realState;
      },
      enumerable: true,
    });
    active.set(threadId, entry);

    const crossing = crossesBoundary(project);
    const spawn = crossing
      ? resolveSpawn(project, command, [...args, String(prompt ?? "")], localCwd)
      : { binary: command, args, cwd: localCwd };
    const handle = runAgent({
      command: spawn.binary,
      args: spawn.args,
      prompt,
      appendPrompt: !crossing,
      cwd: spawn.cwd,
      onChunk: (text) => {
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;

        realState.charCount = text.length;

        if (!assistantMsgId) {
          assistantMsgId = appendMessage(threadId, "assistant", text, runId);
        } else {
          store.updateMessage(threadId, assistantMsgId, { text });
        }

        store.save();
        pushDetail(threadId, realState);
      },
      onDone: (exitCode, fullText, stderrText) => {
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "generic") return;

        clearRun(threadId);

        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.respondingId);

        if (fullText && fullText.length > 0) {
          if (!assistantMsgId) {
            assistantMsgId = appendMessage(
              threadId,
              "assistant",
              fullText,
              runId,
            );
          } else {
            store.updateMessage(threadId, assistantMsgId, { text: fullText });
          }
          realState.charCount = fullText.length;
        }

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
        const stderrTail = String(stderrText || "")
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-8)
          .join("\n");
        const errText = stderrTail
          ? `Run error (exit ${exitCode}):\n${stderrTail}`
          : `Run error (exit ${exitCode == null ? "?" : exitCode})`;
        appendMessage(threadId, "event", errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        markRunFailed(threadId, errText);
        store.save();
        pushDetail(threadId, realState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", errText);
      },
      onError: (err) => {
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "generic") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.respondingId);
        realState.agentStatus = "failed";
        const msg = err && err.message ? err.message : String(err);
        const errText = `Run error: ${msg}`;
        appendMessage(threadId, "event", errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        markRunFailed(threadId, errText);
        store.save();
        pushDetail(threadId, realState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", errText);
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
  function startClaudeRun(threadId, prompt, runId, providerEntry) {
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

    const localCwd = thread.worktreePath || project.path;
    const binary = resolveBin(entryDef);
    const args = entryDef.buildArgs({
      prompt,
      sessionId: thread.sessionId || null,
      permissionMode: thread.permissionMode || "default",
      model: thread.model || null,
      reasoningEffort: thread.reasoningEffort || null,
    });
    // Claude runs interactively: prompt over stdin, permission prompts via
    // the control protocol. Other claude-stream providers (e.g. grok) keep
    // the argv prompt and their own MCP injection.
    const interactive = entryDef.id === "claude";
    if (interactive) {
      // No trailing prompt in interactive argv, so appending is safe.
      args.push(...getClaudeMcpArgs());
    }
    const spawn = resolveSpawn(project, binary, args, localCwd);

    const entry = {
      kind: "claude",
      runId,
      stopping: false,
      handle: null,
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
    };
    Object.defineProperty(entry, "workflow", {
      get() {
        return claudeState;
      },
      enumerable: true,
    });
    active.set(threadId, entry);

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
      appendMessage(threadId, "event", failText, runId);
      appendDoneWorkLog(threadId, runId, "Run error");
      markRunFailed(threadId, failText, { sessionId: capturedSessionId });
      store.save();
      clearRun(threadId);
      scheduleClaudeIdleReap(threadId);
      pushDetail(threadId, claudeState);
      pushThreadsChanged();
      notifyRunTerminal(threadId, "failed", failText, {
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
        if (type === "user" && ev.message) {
          const c = ev.message.content;
          const texts =
            typeof c === "string"
              ? [c]
              : Array.isArray(c)
                ? c
                    .filter(
                      (b) =>
                        b &&
                        b.type === "text" &&
                        typeof b.text === "string",
                    )
                    .map((b) => b.text)
                : [];
          let changed = false;
          for (const t of texts) {
            if (t.includes("<task-notification>")) {
              changed = applyTaskNotifications(threadId, t) || changed;
            }
          }
          if (changed) {
            store.save();
            pushDetail(threadId, claudeState);
          }
        }

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
          for (const block of ev.message.content) {
            if (!block || typeof block !== "object") continue;
            if (block.type === "text" && typeof block.text === "string") {
              if (block.text) markTurnContent();
              assistantText += block.text;
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
            } else if (block.type === "tool_use") {
              markTurnContent();
              const toolId = String(block.id || randomUUID());
              const toolName = String(block.name || "tool");
              const inputObj = block.input != null ? block.input : {};
              let inputStr;
              try {
                inputStr = truncate(
                  JSON.stringify(inputObj, null, 2),
                  INPUT_TRUNCATE,
                );
              } catch {
                inputStr = truncate(String(inputObj), INPUT_TRUNCATE);
              }
              const summary = toolSummary(toolName, inputObj);
              const tool = {
                id: toolId,
                name: toolName,
                input: inputStr,
                output: null,
                isError: false,
                done: false,
              };
              const msgId = appendMessage(
                threadId,
                "tool",
                summary,
                runId,
                tool,
              );
              toolMsgById.set(toolId, msgId);
              // The agent's todo list IS its working plan: mirror it onto the
              // thread so the Planboard shows live steps without the agent
              // filing GitHub issues for them (issue #76).
              if (toolName === "TodoWrite") {
                savePlanSteps(threadId, inputObj.todos);
              }
              // "Task" is the Agent tool's name in older Claude Code CLIs.
              if (toolName === "Agent" || toolName === "Task") {
                addSubagentRow(threadId, {
                  id: toolId,
                  description:
                    typeof inputObj.description === "string" &&
                    inputObj.description
                      ? inputObj.description
                      : summary,
                  agentType:
                    typeof inputObj.subagent_type === "string"
                      ? inputObj.subagent_type
                      : null,
                  status: "running",
                });
              }
              // Post-tool text starts a fresh message so the final answer
              // renders below the tool calls, not merged into the first
              // (earlier-timestamped) bubble.
              assistantMsgId = null;
              assistantText = "";
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
          // prompt or stays unset when the event omitted cache fields (#317).
          assignContextUsage(nextUsage, prev, claudeContextTokens(usage));
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
              appendMessage(threadId, "event", failText, runId);
              appendDoneWorkLog(threadId, runId, "Run error");
              markRunFailed(threadId, failText, {
                sessionId: classified.sessionLost ? null : capturedSessionId,
              });
              terminalStatus = "failed";
              terminalText = failText;
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

        const stderrTail = String(stderr || "")
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-8)
          .join("\n");
        const errText = stderrTail
          ? `Run error (exit ${code == null ? "?" : code}):\n${stderrTail}`
          : `Run error (exit ${code == null ? "?" : code})`;
        appendMessage(threadId, "event", errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        markRunFailed(threadId, errText);
        store.save();
        pushDetail(threadId, claudeState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", errText, {
          tokensIn: runUsage.tokensIn,
          tokensOut: runUsage.tokensOut,
          costUsd: runUsage.costUsd,
        });
    };

    const onError = (err) => {
        disarmAck();
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "claude") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);
        const msg = err && err.message ? err.message : String(err);
        const errText = `Run error: ${msg}`;
        appendMessage(threadId, "event", errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        markRunFailed(threadId, errText);
        store.save();
        pushDetail(threadId, claudeState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", errText, {
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

    // Reuse key: everything a spawn bakes into argv/env EXCEPT the session
    // id (--resume changes after turn one; the live process needs no resume).
    const sessionKey = JSON.stringify({
      cwd: localCwd,
      remote: project.remoteHost || null,
      binary,
      model: thread.model || null,
      permissionMode: thread.permissionMode || "default",
      reasoningEffort: thread.reasoningEffort || null,
      mcp: interactive ? getClaudeMcpArgs() : [],
      otelEnv: otelEnv || null,
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
          envExtra: otelEnv,
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
          envExtra: otelEnv,
          onEvent,
          onExit,
          onError,
        });
      }
      trackLiveClaudeChild(handle.child);
      const own = active.get(threadId);
      if (own && own.runId === runId) own.handle = handle;
    }

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

  /**
   * Start a Codex JSONL session turn.
   * @param {string} threadId
   * @param {string} prompt
   * @param {string} runId
   * @param {import('./providers').ProviderEntry} providerEntry
   */
  function startCodexRun(threadId, prompt, runId, providerEntry) {
    const thread = store.getThread(threadId);
    const project = store.getProject(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project for thread: ${threadId}`);
    }

    assertProviderBinary(providerEntry, project);

    const codexState = {
      __codex: true,
      runId,
    };

    const startingId = beginWorkLogStep(threadId, runId, "Starting agent");
    const workingId = beginWorkLogStep(threadId, runId, "Agent working");

    store.save();
    pushThreadsChanged();
    pushDetail(threadId, codexState);

    /** @type {string | null} */
    let assistantMsgId = null;
    /** @type {string} */
    let assistantText = "";
    /** command item id -> message id */
    /** @type {Map<string, string>} */
    const toolMsgById = new Map();
    /** @type {string | null} */
    let capturedSessionId = thread.sessionId || null;
    let sawTerminalUsage = false;
    let finishedFromStream = false;
    /** Run-local usage for memory footers (not cumulative store totals). */
    const runUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

    const localCwd = thread.worktreePath || project.path;
    const binary = resolveBin(providerEntry);
    const args = providerEntry.buildArgs({
      prompt,
      sessionId: thread.sessionId || null,
      permissionMode: thread.permissionMode || "default",
      model: thread.model || null,
      reasoningEffort: thread.reasoningEffort || null,
    });
    // Leading -c MCP override when memory server is healthy. The matching
    // bearer tokens ride the child's env, never argv (issue #125).
    const codexMcpArgs = getCodexMcpArgs();
    if (codexMcpArgs.length > 0) {
      args.unshift(...codexMcpArgs);
    }
    const codexMcpEnv = getCodexMcpEnv();
    const spawn = resolveSpawn(project, binary, args, localCwd);

    const entry = {
      kind: "codex",
      runId,
      stopping: false,
      handle: null,
      startingId,
      workingId,
      codexState,
      runUsage,
    };
    Object.defineProperty(entry, "workflow", {
      get() {
        return codexState;
      },
      enumerable: true,
    });
    active.set(threadId, entry);

    function guard() {
      const e = active.get(threadId);
      if (!e || e.stopping || e.runId !== runId) return null;
      if (e.kind !== "codex") return null;
      return e;
    }

    function ensureAssistant(text) {
      if (!assistantMsgId) {
        assistantMsgId = appendMessage(threadId, "assistant", text, runId);
      } else {
        store.updateMessage(threadId, assistantMsgId, { text });
      }
    }

    function applyUsage(usageInfo) {
      if (!usageInfo) return;
      const prev = store.getUsage(threadId) || {
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        turns: 0,
      };
      const costDelta = Number(usageInfo.costUsd) || 0;
      const inDelta = Number(usageInfo.inputTokens) || 0;
      const outDelta = Number(usageInfo.outputTokens) || 0;
      // token_count.total_token_usage is session-cumulative. Replacing
      // rather than adding is what stops the ring from double-counting (#317).
      const snapshot = Boolean(usageInfo.snapshot);
      if (snapshot) {
        runUsage.tokensIn = inDelta;
        runUsage.tokensOut = outDelta;
        runUsage.costUsd += costDelta;
      } else {
        runUsage.tokensIn += inDelta;
        runUsage.tokensOut += outDelta;
        runUsage.costUsd += costDelta;
      }
      const nextUsage = {
        model: usageInfo.model || prev.model || thread.model || null,
        inputTokens: snapshot ? inDelta : prev.inputTokens + inDelta,
        outputTokens: snapshot ? outDelta : prev.outputTokens + outDelta,
        costUsd: prev.costUsd + costDelta,
        turns: snapshot && prev.turns > 0 ? prev.turns : prev.turns + 1,
      };
      assignContextUsage(
        nextUsage,
        prev,
        usageInfo.contextTokens,
        usageInfo.contextWindow,
      );
      store.setUsage(threadId, nextUsage);
      if (costDelta > 0) {
        store.recordSpend(costDelta);
      }
      const billedIn = snapshot
        ? Math.max(0, inDelta - prev.inputTokens)
        : inDelta;
      const billedOut = snapshot
        ? Math.max(0, outDelta - prev.outputTokens)
        : outDelta;
      store.recordUsage({
        provider: thread.provider,
        model: usageInfo.model || prev.model || thread.model || null,
        costUsd: costDelta,
        inputTokens: billedIn,
        outputTokens: billedOut,
        threadId,
        projectId: thread.projectId,
        projectName: store.getProject(thread.projectId)?.name,
        title: thread.title,
      });
      sawTerminalUsage = true;
    }

    const handle = runCodex({
      binary: spawn.binary,
      args: spawn.args,
      cwd: spawn.cwd,
      envExtra: codexMcpEnv,
      onEvent: (ev) => {
        if (!guard()) return;

        // Session / thread id
        if (
          codexParse.isSessionStartEvent(ev) ||
          codexParse.extractSessionId(ev)
        ) {
          const sid = codexParse.extractSessionId(ev);
          if (sid) {
            capturedSessionId = sid;
            store.updateThread(threadId, { sessionId: sid });
            completeWorkLogStep(threadId, startingId);
            store.save();
            pushDetail(threadId, codexState);
            pushThreadsChanged();
          }
        }

        // Agent message growth (replace with latest full text when item.completed,
        // append deltas when msg carries delta only).
        const agentText = codexParse.extractAgentMessageText(ev);
        if (agentText != null) {
          const type = String(ev.type || "");
          const isDelta =
            (ev.msg &&
              typeof ev.msg === "object" &&
              /delta/i.test(String(ev.msg.type || ""))) ||
            /delta/i.test(type);
          if (isDelta) {
            assistantText += agentText;
          } else if (
            type === "item.completed" ||
            type === "item_completed" ||
            (ev.item && ev.item.type === "agent_message")
          ) {
            // Full message on completed item
            assistantText = agentText;
          } else if (!assistantText) {
            assistantText = agentText;
          } else if (!assistantText.endsWith(agentText)) {
            assistantText += agentText;
          }
          ensureAssistant(assistantText);
          store.save();
          pushDetail(threadId, codexState);
        }

        // Command execution -> tool messages
        const cmd = codexParse.extractCommandItem(ev);
        if (cmd) {
          if (cmd.phase === "started") {
            const tool = {
              id: cmd.id,
              name: "Command",
              input: truncate(cmd.command, INPUT_TRUNCATE),
              output: null,
              isError: false,
              done: false,
            };
            const summary = cmd.command
              ? `Command: ${cmd.command.length > 80 ? `${cmd.command.slice(0, 80)}…` : cmd.command}`
              : "Command";
            const msgId = appendMessage(
              threadId,
              "tool",
              summary,
              runId,
              tool,
            );
            toolMsgById.set(cmd.id, msgId);
            // Post-tool text starts a fresh message below the tool call.
            assistantMsgId = null;
            assistantText = "";
          } else if (cmd.phase === "completed") {
            let msgId = toolMsgById.get(cmd.id);
            if (!msgId) {
              const tool = {
                id: cmd.id,
                name: "Command",
                input: truncate(cmd.command, INPUT_TRUNCATE),
                output: null,
                isError: false,
                done: false,
              };
              const summary = cmd.command
                ? `Command: ${cmd.command.length > 80 ? `${cmd.command.slice(0, 80)}…` : cmd.command}`
                : "Command";
              msgId = appendMessage(threadId, "tool", summary, runId, tool);
              toolMsgById.set(cmd.id, msgId);
              assistantMsgId = null;
              assistantText = "";
            }
            const existing = store
              .getMessages(threadId)
              .find((m) => m.id === msgId);
            if (existing && existing.tool) {
              const isError =
                cmd.exitCode != null && Number(cmd.exitCode) !== 0;
              store.updateMessage(threadId, msgId, {
                tool: {
                  ...existing.tool,
                  input: truncate(
                    cmd.command || existing.tool.input,
                    INPUT_TRUNCATE,
                  ),
                  output: truncate(cmd.output || "", OUTPUT_TRUNCATE),
                  isError,
                  done: true,
                },
              });
              noteToolSpan(
                threadId,
                runId,
                existing.tool.id,
                existing.tool.name,
                isError,
              );
            }
          }
          store.save();
          pushDetail(threadId, codexState);
        }

        // Usage
        const usageInfo = codexParse.extractUsage(ev);
        if (usageInfo) {
          applyUsage(usageInfo);
          store.save();
          pushDetail(threadId, codexState);
        }
      },
      onExit: ({ code, stderr }) => {
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "codex") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);

        if (capturedSessionId) {
          store.updateThread(threadId, { sessionId: capturedSessionId });
        }

        // If we never saw usage, still count a turn with zero tokens when ok
        if (!sawTerminalUsage && code === 0) {
          applyUsage({ inputTokens: 0, outputTokens: 0, model: thread.model });
        }

        if (code === 0) {
          store.updateThread(
            threadId,
            {
              status: "done",
              sessionId: capturedSessionId,
              runStartedAt: null,
            },
            { touch: true },
          );
          store.save();
          pushDetail(threadId, codexState);
          pushThreadsChanged();
          finishedFromStream = true;
          notifyRunTerminal(
            threadId,
            "done",
            lastAssistantText(threadId, runId),
            {
              tokensIn: runUsage.tokensIn,
              tokensOut: runUsage.tokensOut,
              costUsd: runUsage.costUsd,
            },
          );
          return;
        }

        const stderrTail = String(stderr || "")
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-8)
          .join("\n");
        const errText = stderrTail
          ? `Run error (exit ${code == null ? "?" : code}):\n${stderrTail}`
          : `Run error (exit ${code == null ? "?" : code})`;
        appendMessage(threadId, "event", errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        markRunFailed(threadId, errText);
        store.save();
        pushDetail(threadId, codexState);
        pushThreadsChanged();
        void finishedFromStream;
        notifyRunTerminal(threadId, "failed", errText, {
          tokensIn: runUsage.tokensIn,
          tokensOut: runUsage.tokensOut,
          costUsd: runUsage.costUsd,
        });
      },
      onError: (err) => {
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "codex") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);
        const msg = err && err.message ? err.message : String(err);
        const errText = `Run error: ${msg}`;
        appendMessage(threadId, "event", errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        markRunFailed(threadId, errText);
        store.save();
        pushDetail(threadId, codexState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", errText, {
          tokensIn: runUsage.tokensIn,
          tokensOut: runUsage.tokensOut,
          costUsd: runUsage.costUsd,
        });
      },
    });

    entry.handle = handle;
    store.save();
    pushDetail(threadId, codexState);

    return { runId };
  }

  /**
   * Start a Kimi stream-json (with plain-text fallback) session turn.
   * After a successful turn, sessionId is the captured resume id, or the
   * prior real id. A hint-less turn stores null (never the old "cwd"
   * sentinel): -c is per-directory, so two no-worktree kimi threads in the
   * same project would resume each other's session (issue #220).
   * @param {string} threadId
   * @param {string} prompt
   * @param {string} runId
   * @param {import('./providers').ProviderEntry} providerEntry
   */
  function startKimiRun(threadId, prompt, runId, providerEntry) {
    const thread = store.getThread(threadId);
    const project = store.getProject(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project for thread: ${threadId}`);
    }

    assertProviderBinary(providerEntry, project);

    const kimiState = {
      __kimi: true,
      runId,
    };

    const startingId = beginWorkLogStep(threadId, runId, "Starting agent");
    const workingId = beginWorkLogStep(threadId, runId, "Agent working");

    store.save();
    pushThreadsChanged();
    pushDetail(threadId, kimiState);

    /** @type {string | null} */
    let assistantMsgId = null;
    /** @type {string} */
    let assistantText = "";
    /** @type {Map<string, string>} */
    const toolMsgById = new Map();
    let sawUsage = false;
    let lastPushAt = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let pushTimer = null;
    /** Run-local usage for memory footers (not cumulative store totals). */
    const runUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
    /**
     * Real session id from the stream's meta resume hint. Null when the
     * CLI emits none: we do not invent a per-cwd sentinel (issue #220).
     * @type {string | null}
     */
    let capturedKimiSessionId = null;

    const localCwd = thread.worktreePath || project.path;
    const binary = resolveBin(providerEntry);
    const args = providerEntry.buildArgs({
      prompt,
      sessionId: thread.sessionId || null,
      permissionMode: thread.permissionMode || "default",
      model: thread.model || null,
      reasoningEffort: thread.reasoningEffort || null,
    });
    const spawn = resolveSpawn(project, binary, args, localCwd);

    const entry = {
      kind: "kimi",
      runId,
      stopping: false,
      handle: null,
      startingId,
      workingId,
      kimiState,
      runUsage,
    };
    Object.defineProperty(entry, "workflow", {
      get() {
        return kimiState;
      },
      enumerable: true,
    });
    active.set(threadId, entry);

    function guard() {
      const e = active.get(threadId);
      if (!e || e.stopping || e.runId !== runId) return null;
      if (e.kind !== "kimi") return null;
      return e;
    }

    function flushPush() {
      pushTimer = null;
      lastPushAt = Date.now();
      if (!guard()) return;
      store.save();
      pushDetail(threadId, kimiState);
    }

    function throttledPush() {
      const now = Date.now();
      const elapsed = now - lastPushAt;
      if (elapsed >= KIMI_PUSH_THROTTLE_MS) {
        if (pushTimer) {
          clearTimeout(pushTimer);
          pushTimer = null;
        }
        flushPush();
        return;
      }
      if (!pushTimer) {
        pushTimer = setTimeout(flushPush, KIMI_PUSH_THROTTLE_MS - elapsed);
      }
    }

    function ensureAssistant(text) {
      if (!assistantMsgId) {
        assistantMsgId = appendMessage(threadId, "assistant", text, runId);
      } else {
        store.updateMessage(threadId, assistantMsgId, { text });
      }
    }

    function applyUsage(usageInfo) {
      if (!usageInfo) return;
      const prev = store.getUsage(threadId) || {
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        turns: 0,
      };
      const costDelta = Number(usageInfo.costUsd) || 0;
      const inDelta = Number(usageInfo.inputTokens) || 0;
      const outDelta = Number(usageInfo.outputTokens) || 0;
      runUsage.tokensIn += inDelta;
      runUsage.tokensOut += outDelta;
      runUsage.costUsd += costDelta;
      const nextUsage = {
        model: prev.model || thread.model || null,
        inputTokens: prev.inputTokens + inDelta,
        outputTokens: prev.outputTokens + outDelta,
        costUsd: prev.costUsd + costDelta,
        turns: prev.turns + 1,
      };
      // Kimi reports billable in/out at best, never a full prompt. Leave
      // contextTokens unset rather than write an undefendable number (#317).
      assignContextUsage(nextUsage, prev, undefined, undefined);
      store.setUsage(threadId, nextUsage);
      if (costDelta > 0) {
        store.recordSpend(costDelta);
      }
      store.recordUsage({
        provider: thread.provider,
        model: prev.model || thread.model || null,
        costUsd: costDelta,
        inputTokens: inDelta,
        outputTokens: outDelta,
        threadId,
        projectId: thread.projectId,
        projectName: store.getProject(thread.projectId)?.name,
        title: thread.title,
      });
      sawUsage = true;
    }

    completeWorkLogStep(threadId, startingId);

    const handle = runKimi({
      binary: spawn.binary,
      args: spawn.args,
      cwd: spawn.cwd,
      // No argv route for kimi effort; runKimi flips config.toml (effortVia).
      reasoningEffort: thread.reasoningEffort || null,
      onEvent: (ev) => {
        if (!guard()) return;

        const sid = kimiParse.extractSessionId(ev);
        if (sid) {
          capturedKimiSessionId = sid;
        }

        const text = kimiParse.extractAssistantText(ev);
        if (text != null) {
          assistantText += text;
          ensureAssistant(assistantText);
          throttledPush();
        }

        for (const tool of kimiParse.extractToolEvents(ev)) {
          if (tool.phase === "start") {
            const toolMeta = {
              id: tool.id,
              name: tool.name,
              input: tool.input,
              output: null,
              isError: false,
              done: false,
            };
            const summary = tool.input
              ? `${tool.name}: ${tool.input.length > 80 ? `${tool.input.slice(0, 80)}…` : tool.input}`
              : tool.name;
            const msgId = appendMessage(
              threadId,
              "tool",
              summary,
              runId,
              toolMeta,
            );
            toolMsgById.set(tool.id, msgId);
            // Post-tool text starts a fresh message below the tool call.
            assistantMsgId = null;
            assistantText = "";
          } else if (tool.phase === "end") {
            let msgId = toolMsgById.get(tool.id);
            if (!msgId) {
              const toolMeta = {
                id: tool.id,
                name: tool.name,
                input: tool.input,
                output: null,
                isError: false,
                done: false,
              };
              msgId = appendMessage(
                threadId,
                "tool",
                tool.name,
                runId,
                toolMeta,
              );
              toolMsgById.set(tool.id, msgId);
              assistantMsgId = null;
              assistantText = "";
            }
            const existing = store
              .getMessages(threadId)
              .find((m) => m.id === msgId);
            if (existing && existing.tool) {
              store.updateMessage(threadId, msgId, {
                tool: {
                  ...existing.tool,
                  input: tool.input || existing.tool.input,
                  output: tool.output,
                  isError: tool.isError,
                  done: true,
                },
              });
              noteToolSpan(threadId, runId, tool.id, tool.name, tool.isError);
            }
          } else {
            // single fire-and-complete
            const toolMeta = {
              id: tool.id,
              name: tool.name,
              input: tool.input,
              output: tool.output,
              isError: tool.isError,
              done: true,
            };
            appendMessage(threadId, "tool", tool.name, runId, toolMeta);
            // Post-tool text starts a fresh message below the tool call.
            assistantMsgId = null;
            assistantText = "";
          }
          throttledPush();
        }

        const usageInfo = kimiParse.extractUsage(ev);
        if (usageInfo) {
          applyUsage(usageInfo);
          throttledPush();
        }
      },
      onExit: ({ code, stderr, fullStdout, gotJson }) => {
        if (pushTimer) {
          clearTimeout(pushTimer);
          pushTimer = null;
        }
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "kimi") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);

        // Hard fallback: no parsable JSON -> entire stdout as plain text.
        if (!gotJson && fullStdout && fullStdout.length > 0) {
          assistantText = fullStdout.replace(/\s+$/, "");
          ensureAssistant(assistantText);
        }

        if (!sawUsage && code === 0) {
          applyUsage({ inputTokens: 0, outputTokens: 0 });
        }

        if (code === 0) {
          // Prefer the real session id from the resume hint (-S on later
          // turns); keep a prior REAL id. Never stamp "cwd": -c is per
          // directory, not per thread (issue #220).
          const prior =
            thread.sessionId && thread.sessionId !== "cwd"
              ? thread.sessionId
              : null;
          store.updateThread(
            threadId,
            {
              status: "done",
              sessionId: capturedKimiSessionId || prior,
              runStartedAt: null,
            },
            { touch: true },
          );
          store.save();
          pushDetail(threadId, kimiState);
          pushThreadsChanged();
          notifyRunTerminal(
            threadId,
            "done",
            assistantText || lastAssistantText(threadId, runId),
            {
              tokensIn: runUsage.tokensIn,
              tokensOut: runUsage.tokensOut,
              costUsd: runUsage.costUsd,
            },
          );
          return;
        }

        const stderrTail = String(stderr || "")
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-8)
          .join("\n");
        const errText = stderrTail
          ? `Run error (exit ${code == null ? "?" : code}):\n${stderrTail}`
          : `Run error (exit ${code == null ? "?" : code})`;
        appendMessage(threadId, "event", errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        markRunFailed(threadId, errText);
        store.save();
        pushDetail(threadId, kimiState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", errText, {
          tokensIn: runUsage.tokensIn,
          tokensOut: runUsage.tokensOut,
          costUsd: runUsage.costUsd,
        });
      },
      onError: (err) => {
        if (pushTimer) {
          clearTimeout(pushTimer);
          pushTimer = null;
        }
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "kimi") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);
        const msg = err && err.message ? err.message : String(err);
        const errText = `Run error: ${msg}`;
        appendMessage(threadId, "event", errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        markRunFailed(threadId, errText);
        store.save();
        pushDetail(threadId, kimiState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", errText, {
          tokensIn: runUsage.tokensIn,
          tokensOut: runUsage.tokensOut,
          costUsd: runUsage.costUsd,
        });
      },
    });

    entry.handle = handle;
    store.save();
    pushDetail(threadId, kimiState);

    return { runId };
  }

  /**
   * Start an OpenCode NDJSON (--format json) session turn with resume via -s.
   * @param {string} threadId
   * @param {string} prompt
   * @param {string} runId
   * @param {import('./providers').ProviderEntry} providerEntry
   */
  function startOpencodeRun(threadId, prompt, runId, providerEntry) {
    const thread = store.getThread(threadId);
    const project = store.getProject(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project for thread: ${threadId}`);
    }

    assertProviderBinary(providerEntry, project);

    const opencodeState = {
      __opencode: true,
      runId,
    };

    const startingId = beginWorkLogStep(threadId, runId, "Starting agent");
    const workingId = beginWorkLogStep(threadId, runId, "Agent working");

    store.save();
    pushThreadsChanged();
    pushDetail(threadId, opencodeState);

    /** @type {string | null} */
    let assistantMsgId = null;
    /** Ordered part ids for text reconstruction. */
    /** @type {string[]} */
    const partOrder = [];
    /** @type {Map<string, string>} */
    const partTextById = new Map();
    let anonPartSeq = 0;
    /** @type {Map<string, string>} */
    const toolMsgById = new Map();
    /** @type {string | null} */
    let capturedSessionId = thread.sessionId || null;
    let lastPushAt = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let pushTimer = null;
    /** Run-local usage for memory footers (not cumulative store totals). */
    const runUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

    const localCwd = thread.worktreePath || project.path;
    const binary = resolveBin(providerEntry);
    const args = providerEntry.buildArgs({
      prompt,
      sessionId: thread.sessionId || null,
      permissionMode: thread.permissionMode || "default",
      model: thread.model || null,
      reasoningEffort: thread.reasoningEffort || null,
    });
    const spawn = resolveSpawn(project, binary, args, localCwd);

    const entry = {
      kind: "opencode",
      runId,
      stopping: false,
      handle: null,
      startingId,
      workingId,
      opencodeState,
      runUsage,
    };
    Object.defineProperty(entry, "workflow", {
      get() {
        return opencodeState;
      },
      enumerable: true,
    });
    active.set(threadId, entry);

    function guard() {
      const e = active.get(threadId);
      if (!e || e.stopping || e.runId !== runId) return null;
      if (e.kind !== "opencode") return null;
      return e;
    }

    function rebuildAssistantText() {
      return partOrder.map((id) => partTextById.get(id) || "").join("");
    }

    function flushPush() {
      pushTimer = null;
      lastPushAt = Date.now();
      if (!guard()) return;
      store.save();
      pushDetail(threadId, opencodeState);
    }

    function throttledPush() {
      const now = Date.now();
      const elapsed = now - lastPushAt;
      if (elapsed >= KIMI_PUSH_THROTTLE_MS) {
        if (pushTimer) {
          clearTimeout(pushTimer);
          pushTimer = null;
        }
        flushPush();
        return;
      }
      if (!pushTimer) {
        pushTimer = setTimeout(flushPush, KIMI_PUSH_THROTTLE_MS - elapsed);
      }
    }

    function ensureAssistant(text) {
      if (!assistantMsgId) {
        assistantMsgId = appendMessage(threadId, "assistant", text, runId);
      } else {
        store.updateMessage(threadId, assistantMsgId, { text });
      }
    }

    function applyUsage(usageInfo) {
      if (!usageInfo) return;
      const prev = store.getUsage(threadId) || {
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        turns: 0,
      };
      const costDelta = Number(usageInfo.costUsd) || 0;
      const inDelta = Number(usageInfo.inputTokens) || 0;
      const outDelta = Number(usageInfo.outputTokens) || 0;
      runUsage.tokensIn += inDelta;
      runUsage.tokensOut += outDelta;
      runUsage.costUsd += costDelta;
      store.setUsage(threadId, {
        model: usageInfo.model || prev.model || thread.model || null,
        inputTokens: prev.inputTokens + inDelta,
        outputTokens: prev.outputTokens + outDelta,
        costUsd: prev.costUsd + costDelta,
        turns: prev.turns + 1,
      });
      if (costDelta > 0) {
        store.recordSpend(costDelta);
      }
      store.recordUsage({
        provider: thread.provider,
        model: usageInfo.model || prev.model || thread.model || null,
        costUsd: costDelta,
        inputTokens: inDelta,
        outputTokens: outDelta,
        threadId,
        projectId: thread.projectId,
        projectName: store.getProject(thread.projectId)?.name,
        title: thread.title,
      });
    }

    completeWorkLogStep(threadId, startingId);

    const handle = runOpencode({
      binary: spawn.binary,
      args: spawn.args,
      cwd: spawn.cwd,
      onEvent: (ev) => {
        if (!guard()) return;

        const sid = opencodeParse.extractSessionId(ev);
        if (sid && !capturedSessionId) {
          capturedSessionId = sid;
          store.updateThread(threadId, { sessionId: sid });
          store.save();
          pushThreadsChanged();
          throttledPush();
        } else if (sid && sid !== capturedSessionId) {
          capturedSessionId = sid;
          store.updateThread(threadId, { sessionId: sid });
          store.save();
          pushThreadsChanged();
        }

        const textPart = opencodeParse.extractTextPart(ev);
        if (textPart) {
          const partId =
            textPart.id != null && textPart.id !== ""
              ? textPart.id
              : `__anon_${anonPartSeq++}`;
          if (!partTextById.has(partId)) {
            partOrder.push(partId);
          }
          // Dedupe: repeating part.id with fuller text replaces that contribution.
          const prev = partTextById.get(partId) || "";
          if (
            !prev ||
            textPart.text.length >= prev.length ||
            !prev.startsWith(textPart.text)
          ) {
            partTextById.set(partId, textPart.text);
          }
          ensureAssistant(rebuildAssistantText());
          throttledPush();
        }

        const tool = opencodeParse.extractToolEvent(ev);
        if (tool) {
          if (tool.phase === "start") {
            const toolMeta = {
              id: tool.id,
              name: tool.name,
              input: tool.input,
              output: null,
              isError: false,
              done: false,
            };
            const summary = tool.input
              ? `${tool.name}: ${tool.input.length > 80 ? `${tool.input.slice(0, 80)}…` : tool.input}`
              : tool.name;
            const msgId = appendMessage(
              threadId,
              "tool",
              summary,
              runId,
              toolMeta,
            );
            toolMsgById.set(tool.id, msgId);
            // Post-tool text starts a fresh message below the tool call.
            // Clearing parts is safe: opencode completes text parts before tools.
            assistantMsgId = null;
            partOrder.length = 0;
            partTextById.clear();
          } else if (tool.phase === "end") {
            let msgId = toolMsgById.get(tool.id);
            if (!msgId) {
              const toolMeta = {
                id: tool.id,
                name: tool.name,
                input: tool.input,
                output: null,
                isError: false,
                done: false,
              };
              msgId = appendMessage(
                threadId,
                "tool",
                tool.name,
                runId,
                toolMeta,
              );
              toolMsgById.set(tool.id, msgId);
              assistantMsgId = null;
              partOrder.length = 0;
              partTextById.clear();
            }
            const existing = store
              .getMessages(threadId)
              .find((m) => m.id === msgId);
            if (existing && existing.tool) {
              store.updateMessage(threadId, msgId, {
                tool: {
                  ...existing.tool,
                  input: tool.input || existing.tool.input,
                  output: tool.output,
                  isError: tool.isError,
                  done: true,
                },
              });
              noteToolSpan(threadId, runId, tool.id, tool.name, tool.isError);
            }
          } else {
            const toolMeta = {
              id: tool.id,
              name: tool.name,
              input: tool.input,
              output: tool.output,
              isError: tool.isError,
              done: true,
            };
            appendMessage(threadId, "tool", tool.name, runId, toolMeta);
            // Post-tool text starts a fresh message below the tool call.
            // Clearing parts is safe: opencode completes text parts before tools.
            assistantMsgId = null;
            partOrder.length = 0;
            partTextById.clear();
          }
          throttledPush();
        }
      },
      onExit: ({ code, stderr, fullStdout, gotJson }) => {
        if (pushTimer) {
          clearTimeout(pushTimer);
          pushTimer = null;
        }
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "opencode") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);

        let assistantText =
          rebuildAssistantText() || lastAssistantText(threadId, runId);

        // Hard fallback: zero JSON lines parse -> whole stdout as text.
        if (!gotJson && fullStdout && fullStdout.length > 0) {
          assistantText = fullStdout.replace(/\s+$/, "");
          ensureAssistant(assistantText);
        }

        // Usage unknown: estimate tokens like text kind.
        if (code === 0) {
          const tokens = Math.ceil((assistantText || "").length / 4) || 0;
          applyUsage({
            inputTokens: 0,
            outputTokens: tokens,
            costUsd: 0,
            model: thread.model || null,
          });

          store.updateThread(
            threadId,
            {
              status: "done",
              sessionId: capturedSessionId || thread.sessionId || null,
              runStartedAt: null,
            },
            { touch: true },
          );
          store.save();
          pushDetail(threadId, opencodeState);
          pushThreadsChanged();
          notifyRunTerminal(
            threadId,
            "done",
            assistantText || lastAssistantText(threadId, runId),
            {
              tokensIn: runUsage.tokensIn,
              tokensOut: runUsage.tokensOut,
              costUsd: runUsage.costUsd,
            },
          );
          return;
        }

        const stderrTail = String(stderr || "")
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-8)
          .join("\n");
        const errText = stderrTail
          ? `Run error (exit ${code == null ? "?" : code}):\n${stderrTail}`
          : `Run error (exit ${code == null ? "?" : code})`;
        appendMessage(threadId, "event", errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        markRunFailed(threadId, errText);
        store.save();
        pushDetail(threadId, opencodeState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", errText, {
          tokensIn: runUsage.tokensIn,
          tokensOut: runUsage.tokensOut,
          costUsd: runUsage.costUsd,
        });
      },
      onError: (err) => {
        if (pushTimer) {
          clearTimeout(pushTimer);
          pushTimer = null;
        }
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "opencode") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);
        const msg = err && err.message ? err.message : String(err);
        const errText = `Run error: ${msg}`;
        appendMessage(threadId, "event", errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        markRunFailed(threadId, errText);
        store.save();
        pushDetail(threadId, opencodeState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", errText, {
          tokensIn: runUsage.tokensIn,
          tokensOut: runUsage.tokensOut,
          costUsd: runUsage.costUsd,
        });
      },
    });

    entry.handle = handle;
    store.save();
    pushDetail(threadId, opencodeState);

    return { runId };
  }

  /**
   * @param {{ threadId: string, prompt: string, attachments?: { kind: "image" | "folder", path: string, name: string }[] }} input
   * @returns {Promise<{ runId: string }>}
   */
  /**
   * Create or rematerialize the worktree for a thread that asked for one.
   * No-op for plain checkout threads. Throws on setup failure so the run
   * never silently drops the isolation the user asked for (#511).
   * @param {string} threadId
   */
  function materializePendingWorktree(threadId) {
    const thread = store.getThread(threadId);
    if (!thread) return;
    const wantsWorktree =
      Boolean(thread.pendingWorktree) || Boolean(thread.worktreePath);
    if (!wantsWorktree) return;
    if (!userDataPath) {
      throw new Error("worktreeBase is not configured");
    }
    const { prepareThreadWorktree } = require("./worktrees.js");
    prepareThreadWorktree({
      store,
      threadId,
      worktreeBase: path.join(userDataPath, "worktrees"),
      broadcast: pushFn,
    });
  }

  /**
   * Record a worktree-setup failure in the thread (user prompt + verbatim
   * git stderr event + status failed) so Retry-turn can fire, then throw
   * so callers (fork, drainQueued) know the agent never started.
   * @param {string} threadId
   * @param {string} prompt
   * @param {{ kind: string, path: string, name: string }[] | undefined} attachments
   * @param {any} err
   * @param {{ fromQuotaWait?: boolean }} [opts]
   */
  function failWorktreeSetup(threadId, prompt, attachments, err, opts) {
    const errText = String((err && err.message) || err);
    const live = store.getThread(threadId);
    const runId = randomUUID();
    otel.startRun({
      threadId,
      runId,
      provider: live ? resolveProvider(live) : "claude",
      model: (live && live.model) || null,
    });
    if (!(opts && opts.fromQuotaWait)) {
      appendMessage(threadId, "user", prompt, runId, null, attachments);
    }
    appendMessage(threadId, "event", errText, runId);
    store.updateThread(
      threadId,
      {
        status: "failed",
        runStartedAt: null,
        lastError: shortError(errText),
      },
      { touch: true },
    );
    store.save();
    pushDetail(threadId);
    pushThreadsChanged();
    otel.endRun({
      threadId,
      runId,
      status: "failed",
      error: shortError(errText),
    });
    throw err instanceof Error ? err : new Error(errText);
  }

  /**
   * Keep only well-formed image/folder attachments (absolute paths). The web
   * bridge is remote-controlled, so never trust the wire shape.
   * @param {unknown} input
   * @returns {{ kind: "image" | "folder", path: string, name: string }[]}
   */
  function sanitizeAttachments(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    for (const a of input) {
      if (!a || typeof a !== "object") continue;
      const kind = a.kind === "folder" ? "folder" : a.kind === "image" ? "image" : null;
      const p = typeof a.path === "string" ? a.path : "";
      if (!kind || !p || !path.isAbsolute(p)) continue;
      out.push({
        kind,
        path: p,
        name: typeof a.name === "string" && a.name ? a.name : path.basename(p),
      });
    }
    return out;
  }

  /**
   * CLI-only section listing the user's attachments. The transcript message
   * keeps the raw prompt; agents read the paths with their own file tools.
   * @param {{ kind: string, path: string }[]} attachments
   * @returns {string}
   */
  function attachmentPromptSection(attachments) {
    if (!attachments.length) return "";
    const lines = attachments.map(
      (a) => `- ${a.kind === "folder" ? "Folder" : "Image"}: ${a.path}`,
    );
    return (
      "\n\n[The user attached the following items. Inspect them with your " +
      "file tools as needed.\n" +
      lines.join("\n") +
      "]"
    );
  }

  /**
   * Dispatch one orchestration command (issue #338): fork a worker per
   * provider, start each with its role prompt, and let the ordinary
   * worker-finished notices wake this thread with the results.
   *
   * Only `/handoff` gets a worktree. `/advisor` and `/committee` are
   * read-only by contract and a worker worktree branches from the default
   * branch — a second opinion on the default branch is not a second opinion
   * on the work in progress — so they run in the project checkout instead
   * and are pointed at the caller's checkout in the prompt.
   *
   * @param {string} threadId - the lead thread
   * @param {any} thread
   * @param {import('./orchcommands.js').OrchCommand} cmd
   * @param {string} prompt - the raw prompt, kept verbatim in the transcript
   * @param {{ kind: string, path: string, name: string }[]} attachments
   */
  async function dispatchOrchCommand(
    threadId,
    thread,
    cmd,
    prompt,
    attachments,
  ) {
    // Fork every worker BEFORE starting any: committee members argue with
    // each other directly, so each one's prompt needs its peers' ids.
    const workers = cmd.providers.map((provider) =>
      services.forkWorkerThread(store, {
        threadId,
        provider,
        worktree: cmd.kind === "handoff",
      }),
    );
    const ids = workers.map((w) => w.id);
    const where =
      cmd.kind !== "handoff" && thread.worktreePath
        ? `\n\nThe thread that asked works in ${thread.worktreePath}. Inspect that checkout — do not edit it.`
        : "";

    // The fan-out is a span of the lead thread and parents every worker run,
    // so the crew reads as one trace tree (same shape as the pendingFork hop).
    const forkRunId = randomUUID();
    otel.startRun({
      threadId,
      runId: forkRunId,
      provider: resolveProvider(thread),
      model: thread.model || null,
    });

    let started = null;
    /** @type {string[]} */
    const failures = [];
    for (let i = 0; i < workers.length; i++) {
      const workerPrompt =
        orchcommands.workerPrompt(cmd.kind, cmd.task, {
          index: i,
          total: workers.length,
          peerIds: ids.filter((_, j) => j !== i),
        }) + where;
      try {
        const run = await startRun({
          threadId: workers[i].id,
          prompt: workerPrompt,
          attachments,
          parentRunId: forkRunId,
        });
        started = started || run;
      } catch (err) {
        // A worker that never started is an orphan: drop it, same contract
        // as the pendingFork path. Peers that DID start keep running — they
        // are real work, and killing them to report a clean failure would
        // throw away more than it explains.
        failures.push(
          `${workers[i].provider}: ${shortError(String((err && err.message) || err))}`,
        );
        try {
          services.deleteThread(store, { threadId: workers[i].id });
        } catch {
          /* best effort */
        }
      }
    }

    if (!started) {
      otel.endRun({
        threadId,
        runId: forkRunId,
        status: "failed",
        error: shortError(failures.join("; ")),
      });
      pushThreadsChanged();
      throw new Error(
        `/${cmd.kind} dispatched no workers — ${failures.join("; ")}`,
      );
    }

    otel.endRun({ threadId, runId: forkRunId, status: "done" });
    appendMessage(threadId, "user", prompt, forkRunId, null, attachments);
    const live = workers.filter((w) => store.getThread(w.id));
    appendMessage(
      threadId,
      "event",
      orchcommands.dispatchNote(
        cmd.kind,
        live.map((w) => ({ id: w.id, provider: w.provider })),
      ) + (failures.length ? `\nNot dispatched — ${failures.join("; ")}` : ""),
      forkRunId,
    );
    store.updateThread(
      threadId,
      { ...services.clearSettledOnActivity(thread) },
      { touch: true },
    );
    pushDetail(threadId);
    pushThreadsChanged();
    return started;
  }

  /**
   * Ask-mode turn (issue #392): no budget, no worktree, no tool loop, no
   * usage row. fm → print-mode → retrieval-only. Returns { runId } the
   * same way every other start*Run does; completion is async.
   *
   * @param {object} input
   * @param {object} thread
   */
  async function startAskRun(input, thread) {
    const { threadId, prompt } = input;
    const attachments = sanitizeAttachments(input.attachments);
    const project = store.getProject(thread.projectId);
    const repoRoot = (project && project.path) || "";
    if (userDataPath && repoRoot) {
      try {
        require("./codeindex.js").maybeRefreshIndex({ userDataPath, repoRoot });
      } catch {
        /* never block */
      }
    }

    const runId = randomUUID();
    otel.startRun({
      threadId,
      runId,
      provider: "ask",
      model: thread.model || null,
      parentRunId: input.parentRunId || null,
    });
    if (!input.fromQuotaWait) {
      appendMessage(threadId, "user", prompt, runId, null, attachments);
    }

    let title = thread.title;
    if (title === "New Thread") {
      const firstLine = String(prompt).split(/\r?\n/)[0].trim();
      const max = services.THREAD_TITLE_MAX || 60;
      title = firstLine.slice(0, max) || "New Thread";
    }
    store.updateThread(
      threadId,
      {
        status: "working",
        title,
        runStartedAt: Date.now(),
        awaitingInput: false,
        lastEventAt: null,
        stalledAt: null,
        quotaWaitUntil: null,
        quotaWaitResumed: input.fromQuotaWait === true,
        pendingWorktree: false,
        ...services.clearSettledOnActivity(thread),
      },
      { touch: true },
    );
    store.save();
    pushDetail(threadId);
    pushThreadsChanged();

    /** @type {{ kill?: () => void }} */
    const handle = {};
    const entry = {
      kind: "ask",
      runId,
      handle: {
        kill() {
          if (typeof handle.kill === "function") handle.kill();
        },
      },
    };
    active.set(threadId, entry);

    const index = userDataPath && repoRoot
      ? tryReadCodeIndex(userDataPath, repoRoot)
      : null;
    const indexNote = services.codeIndexNoteFor(index);
    const matchNote = ask.formatMatchingFiles(index, prompt);
    const digestNote = ask.formatThreadDigest(store.getMessages(threadId));

    void (async () => {
      let memoryNote = "";
      try {
        const search =
          searchMemory ||
          (async (query, projectPath) => {
            if (!userDataPath) return [];
            const { createMemoryProxy } = require("./memory-proxy.js");
            const proxy = createMemoryProxy({ userDataPath });
            return await proxy.search({
              query,
              project: projectPath || undefined,
            });
          });
        const hits = await search(String(prompt || ""), repoRoot);
        memoryNote = ask.formatMemoryHits(hits);
      } catch {
        memoryNote = "";
      }

      const pack = {
        question: String(prompt || ""),
        indexNote,
        memoryNote,
        digestNote,
        matchNote,
      };
      const askPrompt = ask.buildAskPrompt(pack);

      let answer = "";
      let source = "retrieval";
      try {
        const result = await askComplete({
          prompt: askPrompt,
          provider: resolveProvider(thread),
          model: thread.model,
          onHandle: (h) => {
            handle.kill = h && h.kill;
          },
        });
        if (result && result.text) {
          answer = result.text;
          source = result.source || "print";
        }
      } catch {
        answer = "";
      }
      if (!answer) answer = ask.retrievalFallback(pack);

      if (!active.has(threadId) || active.get(threadId) !== entry) return;
      if (entry.stopping) return;

      appendMessage(threadId, "assistant", answer, runId);
      if (source === "retrieval") {
        appendMessage(
          threadId,
          "event",
          "Answered from the repo map and memory (no model).",
          runId,
        );
      }
      clearRun(threadId);
      store.updateThread(
        threadId,
        { status: "done", runStartedAt: null },
        { touch: true },
      );
      store.save();
      pushDetail(threadId);
      pushThreadsChanged();
      otel.endRun({ threadId, runId, status: "done" });
      // Skip notifyRunTerminal: that path checkpoints the worktree and
      // records agent spend. Ask must do neither.
      finishSuccessfulTurn(threadId);
    })().catch((err) => {
      if (!active.has(threadId) || active.get(threadId) !== entry) return;
      const errText = `Ask error: ${err && err.message ? err.message : String(err)}`;
      appendMessage(threadId, "event", errText, runId);
      clearRun(threadId);
      markRunFailed(threadId, errText);
      store.save();
      pushDetail(threadId);
      pushThreadsChanged();
      otel.endRun({
        threadId,
        runId,
        status: "failed",
        error: shortError(errText),
      });
    });

    return { runId };
  }

  async function startRun(input) {
    const { threadId, prompt } = input;
    const attachments = sanitizeAttachments(input.attachments);
    if (active.has(threadId)) {
      throw new Error("A run is already active on this thread");
    }

    const thread = store.getThread(threadId);
    if (!thread) {
      throw new Error(`Unknown thread: ${threadId}`);
    }

    // Machine-delivered turns increment autoTurns in flushOrchNotices.
    // Anything else (user send, retry, verify fix) is a human in the loop.
    if (!input.fromNotice && !input.fromQuotaWait) autoTurns.set(threadId, 0);
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
    if (!input.fromNotice && String(prompt).trimStart().startsWith("/")) {
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

    // Orchestrator thread (issue #202): the first prompt is not run here. It
    // is forked to a worker that holds the worktree and does the work; from
    // the second prompt on the flag is gone and this thread runs its own LLM,
    // supervising the crew through the coder-threads tools. The gates below
    // belong to the run that actually happens — the worker's — so they are
    // deliberately skipped on this hop.
    if (thread.pendingFork) {
      // Promote the title BEFORE forking so the worker is "Fork: <task>"
      // rather than "Fork: New Thread".
      let forkTitle = thread.title;
      if (forkTitle === "New Thread") {
        const firstLine = String(prompt).split(/\r?\n/)[0].trim();
        forkTitle =
          firstLine.slice(0, services.THREAD_TITLE_MAX || 60) || "New Thread";
      }
      if (forkTitle !== thread.title) {
        store.updateThread(threadId, { title: forkTitle }, { touch: true });
      }

      const worker = services.forkWorkerThread(store, { threadId });
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
        started = await startRun({
          threadId: worker.id,
          prompt,
          attachments,
          parentRunId: forkRunId,
        });
      } catch (err) {
        // The worker could not start (missing CLI, budget gate, worktree
        // setup): drop the orphan and keep pendingFork so the next prompt
        // retries the fork, the same contract as a failed lazy worktree.
        try {
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
    services.assertUnderDailyBudget(store);

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
    try {
      materializePendingWorktree(threadId);
    } catch (err) {
      failWorktreeSetup(threadId, prompt, attachments, err, {
        fromQuotaWait: input.fromQuotaWait,
      });
    }

    // Prefix is CLI-only and must see the retained tail BEFORE this turn's
    // user message is appended (rewind replay would otherwise digest itself).
    const prefix = services.buildHandoffPrefix(thread, (id) =>
      store.getMessages(id),
    );
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
    if (!input.fromQuotaWait) {
      appendMessage(threadId, "user", prompt, runId, null, attachments);
    }

    let title = thread.title;
    if (title === "New Thread") {
      const firstLine = String(prompt).split(/\r?\n/)[0].trim();
      const max = services.THREAD_TITLE_MAX || 60;
      title = firstLine.slice(0, max) || "New Thread";
    }

    // Real activity clears a stale "settled" pin (t3 rule). An explicit
    // "active" pin survives so the user can keep a thread out of auto-settle.
    // Shared with workflow start via services.clearSettledOnActivity.
    store.updateThread(
      threadId,
      {
        status: "working",
        title,
        runStartedAt: Date.now(),
        awaitingInput: false,
        lastEventAt: null,
        stalledAt: null,
        quotaWaitUntil: null,
        quotaWaitResumed: input.fromQuotaWait === true,
        ...services.clearSettledOnActivity(thread),
      },
      { touch: true },
    );

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
    const dispatchPrompt =
      prefix +
      String(prompt ?? "") +
      attachmentPromptSection(attachments) +
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
      services.crewTaskNoteFor(store, dispatchThread) +
      services.codeIndexNoteFor(
        userDataPath && repoRoot
          ? tryReadCodeIndex(userDataPath, repoRoot)
          : null,
      );

    const name = workflowNameFromThreadId(threadId);

    if (provider === "simulate") {
      return startSimulatedRun(threadId, dispatchPrompt, runId, name);
    }
    if (provider === "generic") {
      return startGenericRun(threadId, dispatchPrompt, runId, name);
    }

    const entryDef = getProvider(provider) || getProvider("claude");
    if (entryDef.kind === "claude-stream") {
      return startClaudeRun(threadId, dispatchPrompt, runId, entryDef);
    }
    if (entryDef.kind === "codex-json") {
      return startCodexRun(threadId, dispatchPrompt, runId, entryDef);
    }
    if (entryDef.kind === "kimi-stream") {
      return startKimiRun(threadId, dispatchPrompt, runId, entryDef);
    }
    if (entryDef.kind === "opencode-json") {
      return startOpencodeRun(threadId, dispatchPrompt, runId, entryDef);
    }
    return startClaudeRun(
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
    });
  }

  /**
   * Stop is sacred (issue #32): stopping an orchestrator takes its crew with
   * it. Depth-first, so a worker that is itself an orchestrator brings its own
   * crew down too. Every stopped worker lands as "stopped", which queues no
   * wake-up notice, and pending ones are demoted to an event once the crew is
   * down, so nothing restarts the orchestrator the user just stopped.
   * @param {string} threadId - the orchestrator being stopped
   * @param {Set<string>} seen - guards a handoffFrom cycle
   * @returns {Promise<{ stopped: number, traced: boolean }>} workers whose
   *   live run was stopped, and whether a notice trace was written
   */
  async function stopCrew(threadId, seen) {
    if (seen.has(threadId)) return { stopped: 0, traced: false };
    seen.add(threadId);
    const crew = store
      .getThreads()
      .filter((t) => t.orchWorker && String(t.handoffFrom) === threadId);
    let stopped = 0;
    for (const worker of crew) {
      const id = String(worker.id);
      const wasActive = active.has(id);
      await stopRun({ threadId: id }, seen);
      if (wasActive) stopped++;
    }
    const pending = orchNotices.get(threadId);
    orchNotices.delete(threadId);
    if (pending && pending.length > 0) {
      // Same trace as flushOrchNotices' undeliverable path: the orchestrator
      // still sees what its crew did, as an event that starts no run.
      const body = pending.join("\n");
      const headed = /^\s*\[/.test(body) ? body : "[orchestration] " + body;
      appendMessage(threadId, "event", headed);
    }
    return { stopped, traced: !!(pending && pending.length > 0) };
  }

  /**
   * @param {{ threadId: string }} input
   * @param {Set<string>} [seen] - internal: crew cascade cycle guard
   */
  async function stopRun(input, seen = new Set()) {
    const { threadId } = input;
    // Cascade first: a worker outliving its stopped orchestrator keeps
    // burning tokens and re-wakes the parent through queueOrchNotice. Doing
    // it before this thread's own terminal also means a notice that races in
    // during the kills is stopped again by the run below.
    const crew = await stopCrew(String(threadId), seen);
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
        entry.kind === "real" ||
        entry.kind === "ask") &&
      entry.handle
    ) {
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
      entry.kind === "opencode"
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

    const wasSimulate = entry.kind === "sim";
    const stopUsage = entry.runUsage || {
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    };
    clearRun(threadId);
    appendMessage(threadId, "event", "Run stopped", runId);
    appendDoneWorkLog(threadId, runId, "Run stopped");
    store.updateThread(
      threadId,
      { status: "idle", runStartedAt: null },
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
      // queued while this thread was an orchestrator mid-run.
      try {
        flushOrchNotices(threadId);
      } catch {
        // silent
      }
      maybeDrainQueued(threadId);
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

  function refreshQuotaWait(threadId) {
    const thread = store.getThread(threadId);
    if (!thread || thread.status !== "quota-wait" || !thread.quotaWaitUntil) {
      cancelQuotaWake(threadId);
      return;
    }
    if (!quotaWaitEnabled(thread, store.getSettings())) {
      cancelQuotaWake(threadId);
      return;
    }
    scheduleQuotaWake(threadId, thread.quotaWaitUntil);
  }

  function refreshAllQuotaWaits() {
    for (const t of store.getThreads()) {
      if (t.status === "quota-wait") refreshQuotaWait(t.id);
    }
  }

  function stopAll() {
    clearInterval(stallTimer);
    // Clean app quit (main.js before-quit). Mark each active run idle with an
    // interruption event so the next launch's recoverInterruptedRuns (crash
    // path only) does not re-stamp them as generic failures. Kill + flush
    // below are unchanged battle-tested behavior — only marking is added.
    let marked = false;
    for (const threadId of [...active.keys()]) {
      const entry = active.get(threadId);
      const runId = entry && entry.runId ? entry.runId : null;
      if (entry && entry.kind === "workflow") {
        workflowEngine.stopWorkflowEntry(entry);
      } else if (
        entry &&
        (entry.kind === "generic" ||
          entry.kind === "claude" ||
          entry.kind === "codex" ||
          entry.kind === "kimi" ||
          entry.kind === "opencode" ||
          entry.kind === "real" ||
          entry.kind === "ask") &&
        entry.handle
      ) {
        entry.stopping = true;
        try {
          entry.handle.kill();
        } catch {
          // ignore
        }
      }
      clearRun(threadId);
      // Mirror stopRun's terminal shape (idle + event), quit-specific wording.
      appendMessage(
        threadId,
        "event",
        "Run interrupted by app quit",
        runId,
      );
      store.updateThread(
        threadId,
        { status: "idle", runStartedAt: null },
        { touch: true },
      );
      marked = true;
    }
    for (const id of [...quotaTimers.keys()]) {
      cancelQuotaWake(id);
    }
    // Kept-alive Claude sessions (idle between turns): kill + clear timers.
    for (const threadId of [...claudeSessions.keys()]) {
      disposeClaudeSession(threadId);
    }
    // Reap claude children that emitted result (clearRun) then hung: no longer
    // reachable via active Map handles.
    for (const child of [...liveClaudeChildren]) {
      killTree(child, 3000);
    }
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
      workflow.__opencode
    ) {
      if (workflow.__real) return buildRealWorkflowView(workflow);
      return null;
    }
    return mapWorkflowView(workflow, core);
  }

  // Boot: nothing runs yet, so every crew is quiet. Archives workers whose
  // sweep never came — the app died mid-orchestration, or a sibling hung and
  // the orchestrator was already finished for good (issue #15).
  for (const t of store.getThreads()) {
    if (t.orchWorker && t.handoffFrom) sweepCrew(String(t.handoffFrom));
  }

  /**
   * Advisory stall sweep (issue #314). Scans every thread, not just `active`:
   * a working row with no live run is the zombie this issue names. Never
   * kills the CLI — a slow-but-alive stream clears stalledAt via stampLastEvent.
   * STALL_MS is read at check time so a test can shorten the window.
   */
  function checkStalls() {
    const stallMs = Number(process.env.CODER_STALL_MS) || 10 * 60 * 1000;
    const now = Date.now();
    for (const thread of store.getThreads()) {
      if (thread.status !== "working") continue;
      if (thread.awaitingInput) continue;
      if (thread.stalledAt) continue;
      const last = thread.lastEventAt ?? thread.runStartedAt ?? now;
      if (now - last <= stallMs) continue;
      store.updateThread(thread.id, { stalledAt: now });
      const provider = resolveProvider(thread);
      const mins = Math.max(1, Math.round((now - last) / 60000));
      appendMessage(
        thread.id,
        "event",
        `No output from the ${provider} CLI for ${mins} min — the turn may be hung. Stop and retry if it stays quiet.`,
      );
      store.save();
      pushDetail(thread.id, undefined, { skipStamp: true });
      pushThreadsChanged();
    }
  }

  // Native timer (not setIntervalFn): tests replace that hook for sim ticks.
  const stallTimer = setInterval(() => {
    try {
      checkStalls();
    } catch {
      // never break the runner
    }
  }, 15_000);
  if (typeof stallTimer.unref === "function") stallTimer.unref();

  refreshAllQuotaWaits();

  return {
    startRun,
    startWorkflowRun,
    stopRun,
    resumeQuotaWait,
    refreshQuotaWait,
    refreshAllQuotaWaits,
    getActiveWorkflow,
    isRunning,
    stopAll,
    flushTranscripts,
    workflowNameFromThreadId,
    toWorkflowView,
    resolveProvider,
    getPendingPermission,
    respondPermission,
    disposeClaudeSession,
    deliverNotice,
    checkStalls,
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
  /** @internal test/diagnostics */
  liveClaudeChildren,
};
