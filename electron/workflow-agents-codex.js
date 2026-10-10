"use strict";

const os = require("node:os");
const { withProjectEnv } = require("./worktreeEnv.js");
const path = require("node:path");
const {
  runCodex,
  extractAgentMessageText,
  extractUsage,
  extractSessionId: codexExtractSessionId,
  extractCommandItem,
} = require("./codex.js");
const {
  getProvider,
  resolveBin,
} = require("./providers.js");
const { planboardNoteFor, PLANBOARD_NOTE } = require("./services.js");
const { codexWorkspaceWriteArgs } = require("./codexWorkspaceWrite.js");
const {
  getCodexMcpArgs,
  getCodexMcpEnv,
} = require("./memory-sup.js");
const { guardrailsEnabled } = require("./guardrails.js");
const { insertBeforeLast } = require("./guardrail-hook-core.js");
const {
  materializeCodexGuardrailHome,
  deployCodexGuardrailOverlay,
} = require("./codex-guardrail.js");
const {
  crossesBoundary,
  resolveWorkflowSpawn,
  notePhaseGuardrail,
  realSessionId,
} = require("./workflow-spawn.js");

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
    fast,
    permissionMode,
    sessionId,
    userDataPath,
    threadId,
    skipOverlay,
    project,
    projectId,
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
    fast: fast === true,
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
      cwd,
      permissionMode: permissionMode || "default",
      allowNetwork: planboardNote === PLANBOARD_NOTE,
    }),
    ...getCodexMcpArgs({
      projectPath: cwd,
      projectId: projectId || (project && project.id),
    }),
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
    envExtra: withProjectEnv(project, envExtra),
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

module.exports = { spawnAgentCodex };
