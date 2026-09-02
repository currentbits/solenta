"use strict";

const path = require("node:path");
const { execFileSync: defaultExecFileSync, execFile: defaultExecFile } = require("node:child_process");
const { wslTarget, buildWslCommand } = require("./wsl.js");

/** @type {typeof defaultExecFileSync} */
let execFileSyncImpl = defaultExecFileSync;
/** @type {typeof defaultExecFile} */
let execFileImpl = defaultExecFile;

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
 * Test hook: swap execFile (async git/ssh) for a fake spawn. Pass
 * null/undefined to restore the real implementation.
 * @param {typeof defaultExecFile | null | undefined} fn
 */
function setExecFile(fn) {
  execFileImpl = typeof fn === "function" ? fn : defaultExecFile;
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
 * A binary that must resolve on the OTHER side of a boundary: keep the CLI
 * name, drop any local absolute path (it does not exist over there).
 * @param {string} bin
 */
function basenameBin(bin) {
  return typeof bin === "string" && (bin.includes("/") || bin.includes("\\"))
    ? path.basename(bin)
    : bin;
}

/**
 * Valid `env KEY=value` tokens for the far side of wrapCommand.
 * @param {Record<string, string> | null | undefined} env
 * @returns {string[]}
 */
function envPairs(env) {
  if (!env || typeof env !== "object") return [];
  const out = [];
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    if (v == null) continue;
    out.push(`${k}=${String(v)}`);
  }
  return out;
}

/**
 * argv as the other side should see it. When env is set, prefix
 * `env KEY=value` so CODEX_HOME / OPENCODE_CONFIG_DIR survive ssh/WSL —
 * process env on this host is not forwarded.
 * @param {string} bin
 * @param {string[]} argv
 * @param {Record<string, string> | null | undefined} env
 * @returns {string[]}
 */
function boundaryArgv(bin, argv, env) {
  const rest = Array.isArray(argv) ? argv : [];
  const pairs = envPairs(env);
  if (!pairs.length) return [basenameBin(bin), ...rest];
  return ["env", ...pairs, basenameBin(bin), ...rest];
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
 * The single wrap seam for both boundary kinds. If the project lives on an
 * ssh remote, wrap bin+argv as an ssh command; if it lives on the WSL side of
 * a Windows machine (#397), wrap it as `wsl.exe -d ... --cd ... --`. Plain
 * local projects are returned unchanged.
 *
 * A local absolute binary path will not exist on the other side, so both
 * wraps use the basename (the CLI name that PATH over there provides).
 *
 * @param {{ remoteHost?: string, remotePath?: string, path?: string } | null | undefined} project
 * @param {string} bin
 * @param {string[]} argv
 * @param {NodeJS.Platform} [platform]  injected so win32 WSL wrapping is testable off Windows
 * @param {Record<string, string> | null | undefined} [env]  forwarded as `env KEY=value` on the far side
 * @returns {{ bin: string, args: string[] }}
 */
function wrapCommand(project, bin, argv, platform, env) {
  if (!project || !project.remoteHost) {
    const wsl = wslTarget(project, platform);
    if (!wsl) return { bin, args: Array.isArray(argv) ? argv : [] };
    return buildWslCommand(
      wsl.distro,
      wsl.linuxPath,
      boundaryArgv(bin, argv, env),
    );
  }
  const remotePath = project.remotePath || project.path || "";
  return buildSshCommand(
    project.remoteHost,
    remotePath,
    boundaryArgv(bin, argv, env),
  );
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
// ponytail: keep the sync export. worktrees.js still calls this.
function execCommand(project, bin, argv, execOpts) {
  const cmd = wrapCommand(project, bin, argv);
  const opts = { ...(execOpts || {}) };
  if (opts.timeout == null) opts.timeout = SYNC_TIMEOUT_MS;
  // A UNC \\wsl$ path is not a valid cwd for a Windows child process, and the
  // local project path does not exist on an ssh remote. Both wraps carry the
  // directory themselves (--cd / cd &&), so drop cwd for either.
  if ((project && project.remoteHost) || wslTarget(project)) {
    delete opts.cwd;
  }
  return execFileSyncImpl(cmd.bin, cmd.args, opts);
}

/**
 * Async counterpart of execCommand. Same wrap/cwd/timeout rules, but uses
 * execFile so the main-process event loop stays free while git/ssh runs.
 *
 * @param {{ remoteHost?: string, remotePath?: string, path?: string } | null | undefined} project
 * @param {string} bin
 * @param {string[]} argv
 * @param {import("node:child_process").ExecFileOptions} [execOpts]
 * @returns {Promise<string | Buffer>}
 */
function execCommandAsync(project, bin, argv, execOpts) {
  const cmd = wrapCommand(project, bin, argv);
  const opts = { ...(execOpts || {}) };
  if (opts.timeout == null) opts.timeout = SYNC_TIMEOUT_MS;
  // A UNC \\wsl$ path is not a valid cwd for a Windows child process, and the
  // local project path does not exist on an ssh remote. Both wraps carry the
  // directory themselves (--cd / cd &&), so drop cwd for either.
  if ((project && project.remoteHost) || wslTarget(project)) {
    delete opts.cwd;
  }
  return new Promise((resolve, reject) => {
    execFileImpl(cmd.bin, cmd.args, opts, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

module.exports = {
  posixQuote,
  buildSshCommand,
  wrapCommand,
  execCommand,
  execCommandAsync,
  setExecFileSync,
  setExecFile,
  SYNC_TIMEOUT_MS,
  envPairs,
  boundaryArgv,
};
