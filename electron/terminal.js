"use strict";

/**
 * Per-thread shell sessions for the Terminal pane (#147, #1493).
 *
 * A real PTY via @lydell/node-pty (N-API prebuilds: darwin, linux, win32
 * ConPTY), so prompts, curses apps, colours and Ctrl-C work. When the addon
 * does not load the session falls back to pipes with a tiny cooked-mode line
 * editor in write(); `pty: false` on the state tells the pane.
 *
 * Several terminals per thread, keyed by (threadId, termId). Output is kept
 * raw (ANSI included) for xterm.js, capped at LINE_LIMIT lines, pushed to
 * the renderer in ~16 ms batches on "terminal:data", and flushed to
 * <userData>/terminals/<thread>/<term>.log so it replays after a restart.
 */

const fs = require("node:fs");
const path = require("node:path");
// cross-spawn, not child_process: on Windows COMSPEC resolution and .cmd
// shims need it. Same reason as devservers.js (#442).
const spawn = require("cross-spawn");
const { wrapCommand } = require("./ssh.js");
const { wslTarget } = require("./wsl.js");
const { safeId } = require("./worktreeEnv.js");

/** Scrollback lines kept per session (and replayed after a restart). */
const LINE_LIMIT = 5000;
/** Hard cap for output without newlines (full-screen apps redraw in place). */
const CHAR_LIMIT = 1_000_000;
const EMIT_MS = 16;
const FLUSH_MS = 1000;
const KILL_FALLBACK_MS = 3_000;
const DEFAULT_TERM = "1";
const TERM_ID_RE = /^[A-Za-z0-9]{1,16}$/;
/** Leave the alternate screen and reset attributes after replayed output. */
const RESTORE_MARK =
  "\x1b[?1049l\x1b[0m\r\n\x1b[2m[restored output from a previous session]\x1b[0m\r\n";

/**
 * @typedef {{
 *   threadId: string,
 *   termId: string,
 *   pid: number,
 *   cwd: string,
 *   shell: string,
 *   pty: boolean,
 *   proc: any,
 *   buf: string,
 *   base: number,
 *   lines: number,
 *   line: string,
 *   dead: boolean,
 *   startedAt: number,
 *   platform: NodeJS.Platform,
 *   logPath: string,
 *   broadcast: ((channel: string, payload: unknown) => void) | null,
 *   emitFrom: number,
 *   emitTimer: NodeJS.Timeout | null,
 *   flushTimer: NodeJS.Timeout | null,
 * }} TerminalSession
 */

/** @type {Map<string, TerminalSession>} */
const sessions = new Map();

/** @type {any} undefined = not tried yet, null = unavailable */
let ptyModule;
function loadPty() {
  if (ptyModule === undefined) {
    try {
      ptyModule = require("@lydell/node-pty");
    } catch {
      ptyModule = null;
    }
  }
  return ptyModule;
}

/** @param {unknown} termId */
function termIdOf(termId) {
  const id = termId == null || termId === "" ? DEFAULT_TERM : String(termId);
  if (!TERM_ID_RE.test(id)) throw new Error("Invalid terminal id");
  return id;
}

/** @param {string} threadId @param {string} termId */
function keyOf(threadId, termId) {
  return `${threadId}\u0000${termId}`;
}

/** @param {string} logDir @param {string} threadId */
function threadLogDir(logDir, threadId) {
  return path.join(logDir, safeId(threadId));
}

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
 * Append output, then trim from the front past LINE_LIMIT lines (with some
 * slack so a busy stream is not re-scanned per chunk) or CHAR_LIMIT chars.
 * `base` is the absolute offset of buf[0], so readers' cursors survive trims.
 *
 * @param {TerminalSession} sess
 * @param {string} text
 */
function commit(sess, text) {
  if (!text) return;
  if (sess.emitTimer == null) sess.emitFrom = sess.base + sess.buf.length;
  sess.buf += text;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) {
    sess.lines += 1;
  }
  let cut = 0;
  if (sess.lines > LINE_LIMIT + 500) {
    let drop = sess.lines - LINE_LIMIT;
    let at = -1;
    while (drop-- > 0) at = sess.buf.indexOf("\n", at + 1);
    cut = at + 1;
    sess.lines = LINE_LIMIT;
  }
  if (sess.buf.length - cut > CHAR_LIMIT) {
    const extra = sess.buf.length - cut - CHAR_LIMIT;
    let dropped = 0;
    for (let i = cut; i < cut + extra; i++) if (sess.buf[i] === "\n") dropped++;
    sess.lines -= dropped;
    cut += extra;
  }
  if (cut > 0) {
    sess.buf = sess.buf.slice(cut);
    sess.base += cut;
  }
  scheduleEmit(sess);
  scheduleFlush(sess);
}

/** @param {TerminalSession} sess */
function scheduleEmit(sess) {
  if (sess.emitTimer || !sess.broadcast) return;
  sess.emitTimer = setTimeout(() => emitNow(sess), EMIT_MS);
}

/** @param {TerminalSession} sess */
function emitNow(sess) {
  if (sess.emitTimer) clearTimeout(sess.emitTimer);
  sess.emitTimer = null;
  if (!sess.broadcast) return;
  const from = Math.max(sess.emitFrom, sess.base);
  sess.broadcast("terminal:data", {
    threadId: sess.threadId,
    termId: sess.termId,
    from,
    data: sess.buf.slice(from - sess.base),
    cursor: sess.base + sess.buf.length,
    running: isRunning(sess),
  });
  sess.emitFrom = sess.base + sess.buf.length;
}

/** @param {TerminalSession} sess */
function scheduleFlush(sess) {
  if (sess.flushTimer || !sess.logPath) return;
  sess.flushTimer = setTimeout(() => {
    sess.flushTimer = null;
    fs.mkdir(path.dirname(sess.logPath), { recursive: true }, () => {
      fs.writeFile(sess.logPath, sess.buf, () => {});
    });
  }, FLUSH_MS);
  if (typeof sess.flushTimer.unref === "function") sess.flushTimer.unref();
}

/** Synchronous flush for the quit path. @param {TerminalSession} sess */
function flushSync(sess) {
  if (sess.flushTimer) clearTimeout(sess.flushTimer);
  sess.flushTimer = null;
  if (!sess.logPath) return;
  try {
    fs.mkdirSync(path.dirname(sess.logPath), { recursive: true });
    fs.writeFileSync(sess.logPath, sess.buf);
  } catch {
    // best effort; losing scrollback must not block quit
  }
}

/** @param {number} pid */
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** @param {TerminalSession} sess */
function isRunning(sess) {
  return !sess.dead && isAlive(sess.pid);
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
  const end = sess.base + sess.buf.length;
  const stale = typeof since !== "number" || since < sess.base || since > end;
  return {
    termId: sess.termId,
    running: isRunning(sess),
    pty: sess.pty,
    cwd: sess.cwd,
    shell: sess.shell,
    cursor: end,
    text: stale ? sess.buf : sess.buf.slice(since - sess.base),
    reset: stale,
    startedAt: sess.startedAt,
    staleRoot: false,
  };
}

/** @param {string} [termId] @returns {import("../src/shared/ipc").TerminalState} */
function emptyState(termId = DEFAULT_TERM) {
  return {
    termId,
    running: false,
    pty: false,
    cwd: "",
    shell: "",
    cursor: 0,
    text: "",
    reset: true,
    startedAt: 0,
    staleRoot: false,
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

/** @param {TerminalSession} sess */
function killSession(sess) {
  if (sess.emitTimer) clearTimeout(sess.emitTimer);
  if (sess.flushTimer) clearTimeout(sess.flushTimer);
  sess.emitTimer = sess.flushTimer = null;
  // An exited shell's pid may already belong to an unrelated process.
  if (sess.dead) return;
  sess.dead = true;
  // A PTY child is a session leader (setsid), so its pid is the group id.
  // ConPTY has no groups; its own kill() tears down the console.
  if (sess.pty && sess.platform === "win32") {
    try {
      sess.proc.kill();
    } catch {
      // already gone
    }
  } else if (sess.pid) {
    killProcessGroup(sess.pid, sess.platform);
  }
}

/**
 * Start (or re-attach to) one of the thread's shells, cwd'd at `root`.
 *
 * @param {string} threadId
 * @param {string} root
 * @param {{
 *   termId?: string,
 *   cols?: number,
 *   rows?: number,
 *   platform?: NodeJS.Platform,
 *   spawn?: typeof spawn,
 *   pty?: any,
 *   env?: NodeJS.ProcessEnv,
 *   project?: { remoteHost?: string, remotePath?: string, path?: string } | null,
 *   logDir?: string,
 *   broadcast?: (channel: string, payload: unknown) => void,
 * }} [opts]
 * @returns {import("../src/shared/ipc").TerminalState}
 */
function open(threadId, root, opts = {}) {
  const termId = termIdOf(opts.termId);
  const key = keyOf(threadId, termId);
  const existing = sessions.get(key);
  if (existing && isRunning(existing)) {
    if (opts.broadcast) existing.broadcast = opts.broadcast;
    // #1183: never silently keep running in a checkout the thread left.
    return { ...toState(existing, null), staleRoot: existing.cwd !== root };
  }
  if (existing) {
    killSession(existing);
    sessions.delete(key);
  }

  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const project = opts.project || { path: root };
  const cols = clampSize(opts.cols, 80);
  const rows = clampSize(opts.rows, 24);
  const logPath = opts.logDir
    ? path.join(threadLogDir(opts.logDir, threadId), `${termId}.log`)
    : "";

  // WSL-side roots run the shell inside the distro. As in devservers.js the
  // wrapper cd's to the PROJECT root, not the worktree — wsl.exe --cd takes
  // the translated project path and there is no worktree translation yet.
  const wsl = wslTarget(project, platform);
  const shell = wsl ? "bash" : defaultShell(platform, env);
  const wrapped = wsl
    ? wrapCommand(project, shell, [], platform)
    : { bin: shell, args: [] };
  const ptyLib = opts.pty !== undefined ? opts.pty : loadPty();

  /** @type {TerminalSession} */
  const sess = {
    threadId,
    termId,
    pid: 0,
    cwd: root,
    shell,
    pty: Boolean(ptyLib),
    proc: null,
    buf: "",
    base: 0,
    lines: 0,
    line: "",
    dead: false,
    startedAt: Date.now(),
    platform,
    logPath,
    broadcast: opts.broadcast || null,
    emitFrom: 0,
    emitTimer: null,
    flushTimer: null,
  };
  sessions.set(key, sess);

  if (logPath) {
    try {
      const old = fs.readFileSync(logPath, "utf8");
      if (old) commit(sess, old + RESTORE_MARK);
    } catch {
      // no previous scrollback
    }
  }

  if (project.remoteHost) {
    // #1184: a remote project's shell must never silently run locally.
    commit(sess, "Terminal is not available for SSH projects yet.\r\n");
    sess.dead = true;
    return toState(sess, null);
  }

  try {
    if (ptyLib) {
      const proc = ptyLib.spawn(wrapped.bin, wrapped.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: wsl ? undefined : root,
        env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      });
      sess.proc = proc;
      sess.pid = proc.pid || 0;
      proc.onData((/** @type {string} */ d) => commit(sess, d));
      proc.onExit((/** @type {{ exitCode: number }} */ e) =>
        onExit(key, sess, e && e.exitCode),
      );
    } else {
      const spawnFn = opts.spawn || spawn;
      const child = spawnFn(wrapped.bin, wrapped.args, {
        cwd: wsl ? undefined : root,
        detached: platform !== "win32",
        // No tty: TERM=dumb keeps tools from emitting cursor escapes.
        env: { ...env, TERM: "dumb" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      sess.proc = child;
      sess.pid = child.pid || 0;
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        stream.setEncoding("utf8");
        stream.on("data", (/** @type {string} */ chunk) =>
          commit(sess, String(chunk).replace(/\r?\n/g, "\r\n")),
        );
      }
      child.on("error", (/** @type {Error} */ err) => {
        commit(sess, `${(err && err.message) || String(err)}\r\n`);
        sess.dead = true;
      });
      child.on("exit", (/** @type {number | null} */ code) => onExit(key, sess, code));
      // The shell dies with its stdin; a broken pipe must not crash main.
      if (child.stdin) child.stdin.on("error", () => {});
    }
  } catch (err) {
    commit(sess, `${(err && /** @type {Error} */ (err).message) || String(err)}\r\n`);
    sess.dead = true;
    return toState(sess, null);
  }
  if (!sess.pid) sess.dead = true;
  return toState(sess, null);
}

/**
 * @param {string} key
 * @param {TerminalSession} sess
 * @param {number | null | undefined} code
 */
function onExit(key, sess, code) {
  if (sessions.get(key) !== sess || sess.dead) return;
  sess.dead = true;
  commit(sess, `\r\n[${sess.shell} exited${code == null ? "" : ` (${code})`}]\r\n`);
  emitNow(sess);
}

/** @param {unknown} n @param {number} fallback */
function clampSize(n, fallback) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 2 ? Math.min(v, 1000) : fallback;
}

/**
 * Raw keystrokes. A PTY gets them verbatim; the pipe fallback runs a minimal
 * cooked mode (echo, backspace, Enter sends the line) since there is no tty
 * to do it.
 *
 * @param {string} threadId
 * @param {string} data
 * @param {string} [termId]
 * @returns {{ ok: boolean }}
 */
function write(threadId, data, termId) {
  const sess = sessions.get(keyOf(threadId, termIdOf(termId)));
  if (!sess || !isRunning(sess) || !sess.proc) return { ok: false };
  const text = String(data ?? "");
  try {
    if (sess.pty) {
      sess.proc.write(text);
      return { ok: true };
    }
    let echo = "";
    for (const ch of text) {
      if (ch === "\r" || ch === "\n") {
        echo += "\r\n";
        sess.proc.stdin.write(`${sess.line}\n`);
        sess.line = "";
      } else if (ch === "\x7f" || ch === "\b") {
        if (sess.line) {
          sess.line = sess.line.slice(0, -1);
          echo += "\b \b";
        }
      } else if (ch === "\x03") {
        echo += "^C (no PTY: use Restart to stop a command)\r\n";
        sess.line = "";
      } else if (ch >= " ") {
        sess.line += ch;
        echo += ch;
      }
    }
    commit(sess, echo);
    return { ok: true };
  } catch {
    commit(sess, "[write failed]\r\n");
    return { ok: false };
  }
}

/**
 * @param {string} threadId
 * @param {number} cols
 * @param {number} rows
 * @param {string} [termId]
 * @returns {{ ok: boolean }}
 */
function resize(threadId, cols, rows, termId) {
  const sess = sessions.get(keyOf(threadId, termIdOf(termId)));
  if (!sess || !sess.pty || !isRunning(sess)) return { ok: false };
  try {
    sess.proc.resize(clampSize(cols, 80), clampSize(rows, 24));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * @param {string} threadId
 * @param {number | null} [since]
 * @param {string} [termId]
 * @returns {import("../src/shared/ipc").TerminalState}
 */
function read(threadId, since = null, termId) {
  const id = termIdOf(termId);
  const sess = sessions.get(keyOf(threadId, id));
  if (!sess) return emptyState(id);
  return toState(sess, since);
}

/**
 * Terminals this thread has: live sessions plus scrollback left on disk by a
 * previous app run. Ordered by id so a split keeps its layout.
 *
 * @param {string} threadId
 * @param {string} [logDir]
 * @returns {string[]}
 */
function list(threadId, logDir) {
  const ids = new Set();
  for (const sess of sessions.values()) {
    if (sess.threadId === threadId) ids.add(sess.termId);
  }
  if (logDir) {
    try {
      for (const name of fs.readdirSync(threadLogDir(logDir, threadId))) {
        const id = name.replace(/\.log$/, "");
        if (name.endsWith(".log") && TERM_ID_RE.test(id)) ids.add(id);
      }
    } catch {
      // nothing persisted
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * Kill the shell and forget it, scrollback file included. The pane's
 * Restart is close + open.
 *
 * @param {string} threadId
 * @param {string} [termId]
 * @param {string} [logDir]
 * @returns {import("../src/shared/ipc").TerminalState}
 */
function close(threadId, termId, logDir) {
  const id = termIdOf(termId);
  const key = keyOf(threadId, id);
  const sess = sessions.get(key);
  if (sess) {
    sessions.delete(key);
    killSession(sess);
  }
  const logPath =
    (sess && sess.logPath) ||
    (logDir ? path.join(threadLogDir(logDir, threadId), `${id}.log`) : "");
  if (logPath) fs.rmSync(logPath, { force: true });
  return emptyState(id);
}

/** Quit path: flush every scrollback to disk, then kill every shell. */
function killAll() {
  for (const [key, sess] of [...sessions]) {
    flushSync(sess);
    sessions.delete(key);
    killSession(sess);
  }
}

/** One thread id per live shell (a thread with a split counts twice). */
function listLive() {
  const ids = [];
  for (const sess of sessions.values()) {
    if (isRunning(sess)) ids.push(sess.threadId);
  }
  return ids;
}

/** True when the native PTY addon loads in this process. */
function ptyAvailable() {
  return Boolean(loadPty());
}

module.exports = {
  open,
  write,
  resize,
  read,
  list,
  close,
  killAll,
  listLive,
  ptyAvailable,
  LINE_LIMIT,
  CHAR_LIMIT,
};
