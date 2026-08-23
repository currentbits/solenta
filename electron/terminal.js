"use strict";

/**
 * Per-thread shell session for the Terminal pane (#147).
 *
 * ponytail: pipes, not a PTY. node-pty is a native module and
 * scripts/package-app.sh hand-copies prod deps with no electron-rebuild
 * step, so a real tty costs the release pipeline more than the feature is
 * worth today. Known ceiling: no interactive prompts (`gh auth login`
 * hangs), no curses apps, no per-command exit code, Ctrl-C is "restart the
 * session". Upgrade path is node-pty + xterm.js behind these same four
 * calls; nothing outside this file assumes pipes.
 *
 * One long-lived shell per thread means `cd` and shell state persist
 * between commands, which is the whole point over one-shot spawns.
 */

// cross-spawn, not child_process: on Windows COMSPEC resolution and .cmd
// shims need it. Same reason as devservers.js (#442).
const spawn = require("cross-spawn");
const { wrapCommand } = require("./ssh.js");
const { wslTarget } = require("./wsl.js");

/** Committed output kept per session. Older text is dropped from the front. */
const BUFFER_LIMIT = 200_000;
/** Longest partial (no newline yet) line kept, so a runaway \r bar can't grow. */
const PENDING_LIMIT = 4096;
const KILL_FALLBACK_MS = 3_000;

// CSI (colours, cursor moves) and OSC (window title) sequences. Output is
// rendered as plain text, so strip rather than interpret.
const ANSI_RE = new RegExp(
  "\\u001B\\[[0-?]*[ -\\/]*[@-~]" + // CSI: colours, cursor moves
    "|\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\\\)" + // OSC: window title
    "|\\u001B[@-Z\\\\-_]", // single-character escapes
  "g",
);

/**
 * @typedef {{
 *   pid: number,
 *   cwd: string,
 *   shell: string,
 *   child: import("node:child_process").ChildProcess | null,
 *   committed: string,
 *   base: number,
 *   pending: string,
 *   dead: boolean,
 *   startedAt: number,
 *   platform: NodeJS.Platform,
 * }} TerminalSession
 */

/** @type {Map<string, TerminalSession>} */
const sessions = new Map();

/**
 * Login shell for this platform. SHELL is what the user actually uses;
 * /bin/sh is the POSIX fallback, COMSPEC the Windows one.
 *
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function defaultShell(platform, env) {
  if (platform === "win32") return env.COMSPEC || "cmd.exe";
  return env.SHELL || "/bin/sh";
}

/**
 * Strip ANSI, then collapse `\r` rewrites the way a terminal would: within
 * a line, only what follows the last carriage return is still visible.
 *
 * @param {TerminalSession} sess
 * @param {string} chunk
 */
function append(sess, chunk) {
  sess.pending += String(chunk).replace(ANSI_RE, "");
  const parts = sess.pending.split("\n");
  sess.pending = parts.pop() || "";
  for (const line of parts) {
    // \r\n is a newline, not a blank rewrite: drop the trailing \r first.
    const shown = line.replace(/\r+$/, "");
    commit(sess, shown.slice(shown.lastIndexOf("\r") + 1) + "\n");
  }
  const cr = sess.pending.lastIndexOf("\r");
  if (cr >= 0) sess.pending = sess.pending.slice(cr + 1);
  if (sess.pending.length > PENDING_LIMIT) {
    sess.pending = sess.pending.slice(-PENDING_LIMIT);
  }
}

/**
 * Append complete text to the scrollback, dropping from the front past the
 * cap. `base` is the absolute offset of committed[0] so a reader's cursor
 * stays meaningful across trims.
 *
 * @param {TerminalSession} sess
 * @param {string} text
 */
function commit(sess, text) {
  sess.committed += text;
  const over = sess.committed.length - BUFFER_LIMIT;
  if (over > 0) {
    sess.committed = sess.committed.slice(over);
    sess.base += over;
  }
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delta for a reader that last saw `since` absolute chars. A missing or
 * trimmed-away cursor replays the whole buffer with `reset` set.
 *
 * @param {TerminalSession} sess
 * @param {number | null | undefined} since
 * @returns {import("../src/shared/ipc").TerminalState}
 */
function toState(sess, since) {
  const end = sess.base + sess.committed.length;
  const stale = typeof since !== "number" || since < sess.base || since > end;
  return {
    running: !sess.dead && isAlive(sess.pid),
    cwd: sess.cwd,
    shell: sess.shell,
    cursor: end,
    text: stale ? sess.committed : sess.committed.slice(since - sess.base),
    pending: sess.pending,
    reset: stale,
    startedAt: sess.startedAt,
  };
}

/** @returns {import("../src/shared/ipc").TerminalState} */
function emptyState() {
  return {
    running: false,
    cwd: "",
    shell: "",
    cursor: 0,
    text: "",
    pending: "",
    reset: true,
    startedAt: 0,
  };
}

/**
 * @param {number} pid
 * @param {NodeJS.Platform} platform
 */
function killProcessGroup(pid, platform) {
  if (!pid) return;
  // Windows has no POSIX process groups; process.kill(-pid) throws there.
  const target = platform === "win32" ? pid : -pid;
  try {
    process.kill(target, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const timer = setTimeout(() => {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }, KILL_FALLBACK_MS);
  if (typeof timer.unref === "function") timer.unref();
}

/**
 * Start (or re-attach to) the thread's shell, cwd'd at `root`.
 *
 * @param {string} threadId
 * @param {string} root
 * @param {{
 *   platform?: NodeJS.Platform,
 *   spawn?: typeof spawn,
 *   env?: NodeJS.ProcessEnv,
 *   project?: { remoteHost?: string, remotePath?: string, path?: string } | null,
 * }} [opts]
 * @returns {import("../src/shared/ipc").TerminalState}
 */
function open(threadId, root, opts = {}) {
  const existing = sessions.get(threadId);
  if (existing && !existing.dead && isAlive(existing.pid)) {
    return toState(existing, null);
  }
  if (existing) sessions.delete(threadId);

  const platform = opts.platform || process.platform;
  const spawnFn = opts.spawn || spawn;
  const env = opts.env || process.env;
  const project = opts.project || { path: root };
  // WSL-side roots run the shell inside the distro. As in devservers.js the
  // wrapper cd's to the PROJECT root, not the worktree — wsl.exe --cd takes
  // the translated project path and there is no worktree translation yet.
  const wsl = wslTarget(project, platform);
  const shell = wsl ? "bash" : defaultShell(platform, env);
  const wrapped = wsl
    ? wrapCommand(project, shell, [], platform)
    : { bin: shell, args: [] };

  /** @type {TerminalSession} */
  const sess = {
    pid: 0,
    cwd: root,
    shell,
    child: null,
    committed: "",
    base: 0,
    pending: "",
    dead: false,
    startedAt: Date.now(),
    platform,
  };
  sessions.set(threadId, sess);

  let child;
  try {
    child = spawnFn(wrapped.bin, wrapped.args, {
      cwd: wsl ? undefined : root,
      detached: platform !== "win32",
      // TERM=dumb keeps tools from emitting escape sequences we only strip
      // again. There is no tty, so nothing here is a real terminal anyway.
      env: { ...env, TERM: "dumb" },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    append(sess, `${(err && err.message) || String(err)}\n`);
    sess.dead = true;
    return toState(sess, null);
  }

  sess.child = child;
  sess.pid = child.pid || 0;
  if (!sess.pid) sess.dead = true;

  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => append(sess, chunk));
  }
  child.on("error", (err) => {
    append(sess, `${(err && err.message) || String(err)}\n`);
    sess.dead = true;
  });
  child.on("exit", (code) => {
    if (sessions.get(threadId) !== sess) return;
    append(sess, `\n[${shell} exited${code == null ? "" : ` (${code})`}]\n`);
    sess.dead = true;
  });
  if (child.stdin) {
    // The shell dies with its stdin; a broken pipe must not crash main.
    child.stdin.on("error", () => {});
  }

  return toState(sess, null);
}

/**
 * Feed one command line to the shell. The line is echoed into the
 * scrollback first — without a tty the shell prints no prompt and no echo,
 * so this is the only record of what was run.
 *
 * @param {string} threadId
 * @param {string} data
 * @param {number | null} [since]
 * @returns {import("../src/shared/ipc").TerminalState}
 */
function write(threadId, data, since = null) {
  const sess = sessions.get(threadId);
  if (!sess) return emptyState();
  const line = String(data ?? "");
  if (sess.dead || !sess.child || !sess.child.stdin) {
    append(sess, `$ ${line}\n[session is not running]\n`);
    return toState(sess, since);
  }
  append(sess, `$ ${line}\n`);
  try {
    sess.child.stdin.write(`${line}\n`);
  } catch {
    append(sess, "[write failed]\n");
    sess.dead = true;
  }
  return toState(sess, since);
}

/**
 * @param {string} threadId
 * @param {number | null} [since]
 * @returns {import("../src/shared/ipc").TerminalState}
 */
function read(threadId, since = null) {
  const sess = sessions.get(threadId);
  if (!sess) return emptyState();
  return toState(sess, since);
}

/**
 * Kill the shell and drop the session. Scrollback goes with it: the pane
 * re-opens on a fresh shell, which is also how Ctrl-C is spelled here.
 *
 * @param {string} threadId
 * @returns {import("../src/shared/ipc").TerminalState}
 */
function close(threadId) {
  const sess = sessions.get(threadId);
  if (!sess) return emptyState();
  sessions.delete(threadId);
  if (sess.pid) killProcessGroup(sess.pid, sess.platform);
  return emptyState();
}

/** Kill every session. Called from the app quit path. */
function killAll() {
  for (const threadId of [...sessions.keys()]) close(threadId);
}

module.exports = { open, write, read, close, killAll, BUFFER_LIMIT };
