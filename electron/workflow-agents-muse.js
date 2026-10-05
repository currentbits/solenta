"use strict";

const os = require("node:os");
const path = require("node:path");
const {
  getProvider,
  resolveBin,
} = require("./providers.js");
const { kimiMcpServersForRun } = require("./memory-sup.js");
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
const {
  crossesBoundary,
  resolveWorkflowSpawn,
  notePhaseGuardrail,
  realSessionId,
} = require("./workflow-spawn.js");

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

module.exports = { spawnAgentMuse };
