"use strict";

const { wslTarget } = require("./wsl.js");
const { wrapCommand } = require("./ssh.js");
const { guardrailNotice } = require("./guardrail-hook-core.js");

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

module.exports = {
  crossesBoundary,
  resolveWorkflowSpawn,
  notePhaseGuardrail,
  realSessionId,
  claudeStreamSessionId,
};
