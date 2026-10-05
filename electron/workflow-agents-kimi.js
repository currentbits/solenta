"use strict";

const os = require("node:os");
const path = require("node:path");
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
  getProvider,
  resolveBin,
} = require("./providers.js");
const { kimiMcpServersForRun } = require("./memory-sup.js");
const { guardrailsEnabled } = require("./guardrails.js");
const {
  crossesBoundary,
  resolveWorkflowSpawn,
  notePhaseGuardrail,
  realSessionId,
} = require("./workflow-spawn.js");

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

module.exports = { spawnAgentKimi };
