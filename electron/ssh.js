"use strict";

const path = require("node:path");
const { execFileSync: defaultExecFileSync } = require("node:child_process");

/** @type {typeof defaultExecFileSync} */
let execFileSyncImpl = defaultExecFileSync;

/**
 * Hard cap for synchronous git/ssh on the main process. execFileSync blocks
 * the event loop — agent streaming and every window — so one hung filesystem
 * or unreachable remote must kill the child instead of freezing the app.
 * ssh's ConnectTimeout=10 only bounds the connect, not the command.
 * Callers pass their own timeout for genuinely slow work (push, fetch).
 */
const SYNC_TIMEOUT_MS = 15_000;

/**
 * Test hook: swap execFileSync (git/ssh) for a fake spawn. Pass null/undefined
 * to restore the real implementation.
 * @param {typeof defaultExecFileSync | null | undefined} fn
 */
function setExecFileSync(fn) {
  execFileSyncImpl = typeof fn === "function" ? fn : defaultExecFileSync;
}

/**
 * POSIX single-quote escaping. Wraps value in single quotes and turns each
 * embedded `'` into `'\''` (end quote, escaped quote, reopen).
 * @param {unknown} value
 * @returns {string}
 */
function posixQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Build an ssh argv that cds into remotePath then runs argv on the host.
 *
 * BatchMode=yes + ConnectTimeout=10 fail a dead/unauthenticated host fast
 * instead of hanging on a password prompt.
 *
 * @param {string} remoteHost user@host
 * @param {string} remotePath absolute path on the remote
 * @param {string[]} argv command + args to run after cd
 * @returns {{ bin: "ssh", args: string[] }}
 */
function buildSshCommand(remoteHost, remotePath, argv) {
  const quotedPath = posixQuote(remotePath);
  const quotedArgv = (Array.isArray(argv) ? argv : []).map(posixQuote).join(" ");
  return {
    bin: "ssh",
    args: [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      String(remoteHost),
      `cd ${quotedPath} && ${quotedArgv}`,
    ],
  };
}

/**
 * If the project lives on a remote, wrap bin+argv as an ssh command.
 * Local projects are returned unchanged. Branch ONLY on project.remoteHost.
 *
 * A local absolute binary path will not exist on the remote, so remotes use
 * the basename (the CLI name the remote PATH is expected to provide).
 *
 * @param {{ remoteHost?: string, remotePath?: string, path?: string } | null | undefined} project
 * @param {string} bin
 * @param {string[]} argv
 * @returns {{ bin: string, args: string[] }}
 */
function wrapCommand(project, bin, argv) {
  if (!project || !project.remoteHost) {
    return { bin, args: Array.isArray(argv) ? argv : [] };
  }
  const remotePath = project.remotePath || project.path || "";
  const remoteBin =
    typeof bin === "string" && (bin.includes("/") || bin.includes("\\"))
      ? path.basename(bin)
      : bin;
  return buildSshCommand(project.remoteHost, remotePath, [
    remoteBin,
    ...(Array.isArray(argv) ? argv : []),
  ]);
}

/**
 * execFileSync through wrapCommand. Drops cwd on remotes (the local project
 * path is not a valid ssh cwd and often does not exist on this machine).
 *
 * @param {{ remoteHost?: string, remotePath?: string, path?: string } | null | undefined} project
 * @param {string} bin
 * @param {string[]} argv
 * @param {import("node:child_process").ExecFileSyncOptions} [execOpts]
 */
function execCommand(project, bin, argv, execOpts) {
  const cmd = wrapCommand(project, bin, argv);
  const opts = { ...(execOpts || {}) };
  if (opts.timeout == null) opts.timeout = SYNC_TIMEOUT_MS;
  if (project && project.remoteHost) {
    delete opts.cwd;
  }
  return execFileSyncImpl(cmd.bin, cmd.args, opts);
}

module.exports = {
  posixQuote,
  buildSshCommand,
  wrapCommand,
  execCommand,
  setExecFileSync,
  SYNC_TIMEOUT_MS,
};
