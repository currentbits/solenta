"use strict";

const path = require("node:path");
const {
  getProvider,
  resolveBin,
} = require("./providers.js");
const { guardrailsEnabled } = require("./guardrails.js");
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
  crossesBoundary,
  resolveWorkflowSpawn,
  notePhaseGuardrail,
  realSessionId,
} = require("./workflow-spawn.js");

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

module.exports = { spawnAgentOpencode };
