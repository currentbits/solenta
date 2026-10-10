"use strict";

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
} = require("./providers.js");
const { guardrailsEnabled } = require("./guardrails.js");
const { withProjectEnv } = require("./worktreeEnv.js");
const { insertBeforeLast } = require("./guardrail-hook-core.js");
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
  crossesBoundary,
  resolveWorkflowSpawn,
  notePhaseGuardrail,
  realSessionId,
} = require("./workflow-spawn.js");

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
    env: withProjectEnv(project, undefined),
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

module.exports = { spawnAgentCursor };
