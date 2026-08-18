"use strict";

const fs = require("node:fs");
const path = require("node:path");
// cross-spawn, not child_process: on Windows npm is npm.cmd and Node
// refuses to exec .cmd shims without a shell. Same reason as agent.js (#442).
const spawn = require("cross-spawn");
const { wrapCommand } = require("./ssh.js");
const { wslTarget } = require("./wsl.js");

const PREFERRED_SCRIPTS = ["dev", "start", "serve"];
const RING_LIMIT = 50;
const PENDING_LIMIT = 4096;
const DEAD_TTL_MS = 5 * 60_000;
const KILL_FALLBACK_MS = 3_000;

/** @type {RegExp} */
const SERVER_URL_RE =
  /https?:\/\/(?:\[[^\]]+\]|[^/\s"'<>:]+):(\d{1,5})[^\s"'<>]*/i;

/**
 * First http(s) URL that includes a port. Vite/Next-style banners:
 *   "  Local: http://localhost:5173/"
 *   "ready on http://0.0.0.0:3000"
 *
 * @param {string} text
 * @returns {string | null}
 */
function captureServerUrl(text) {
  const m = String(text || "").match(SERVER_URL_RE);
  if (!m) return null;
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return m[0].replace(/[.,;!?)]+$/, "");
}

/**
 * Runnable scripts present on a parsed package.json, in preference order.
 *
 * @param {unknown} pkg
 * @returns {string[]}
 */
function scriptsFromPackageJson(pkg) {
  if (!pkg || typeof pkg !== "object") return [];
  const scripts = /** @type {{ scripts?: unknown }} */ (pkg).scripts;
  if (!scripts || typeof scripts !== "object") return [];
  const map = /** @type {Record<string, unknown>} */ (scripts);
  return PREFERRED_SCRIPTS.filter((name) => {
    const value = map[name];
    return typeof value === "string" && value.trim() !== "";
  });
}

/**
 * Read package.json at `root` and return runnable dev scripts
 * (dev, start, serve) in that preference order. Missing or invalid
 * package.json yields [].
 *
 * @param {string} root
 * @returns {string[]}
 */
function detectScripts(root) {
  try {
    if (!root) return [];
    const raw = fs.readFileSync(path.join(root, "package.json"), "utf8");
    return scriptsFromPackageJson(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * @typedef {{
 *   pid: number,
 *   script: string,
 *   startedAt: number,
 *   url: string | null,
 *   lines: string[],
 *   pending: string,
 *   dead: boolean,
 *   deadAt: number | null,
 *   platform: NodeJS.Platform,
 * }} DevServerRecord
 */

/** @type {Map<string, DevServerRecord>} */
const records = new Map();

/** pid → SIGKILL fallback timer, so stop() can drop the record immediately. */
/** @type {Map<number, NodeJS.Timeout>} */
const pendingKills = new Map();

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
 * @param {DevServerRecord} rec
 */
function markDead(rec) {
  rec.dead = true;
  if (!rec.deadAt) rec.deadAt = Date.now();
}

/**
 * @param {DevServerRecord} rec
 * @param {string} chunk
 */
function appendLog(rec, chunk) {
  const text = String(chunk);
  if (!rec.url) {
    rec.url = captureServerUrl(rec.pending + text) || captureServerUrl(text);
  }
  rec.pending += text;
  const parts = rec.pending.split("\n");
  rec.pending = parts.pop() || "";
  for (const line of parts) {
    // \r rewrites the line, so keep only what a terminal would still show.
    // Strip a trailing \r first (\r\n is just a newline, not a blank rewrite).
    const shown = line.replace(/\r+$/, "");
    rec.lines.push(shown.slice(shown.lastIndexOf("\r") + 1));
  }
  const cr = rec.pending.lastIndexOf("\r");
  if (cr >= 0) rec.pending = rec.pending.slice(cr + 1);
  if (rec.pending.length > PENDING_LIMIT) {
    // ponytail: tail-truncate; a URL banner is far shorter than 4 KiB.
    rec.pending = rec.pending.slice(-PENDING_LIMIT);
  }
  if (rec.lines.length > RING_LIMIT) {
    rec.lines.splice(0, rec.lines.length - RING_LIMIT);
  }
}

/**
 * @param {DevServerRecord} rec
 */
function lastLinesOf(rec) {
  const lines = rec.lines.slice();
  if (rec.pending.trim()) lines.push(rec.pending);
  if (lines.length > RING_LIMIT) {
    return lines.slice(lines.length - RING_LIMIT);
  }
  return lines;
}

/**
 * @param {DevServerRecord} rec
 * @returns {{ running: boolean, script?: string, url?: string, startedAt?: number, lastLines?: string[] }}
 */
function toState(rec) {
  const running = !rec.dead && isAlive(rec.pid);
  if (!running) markDead(rec);
  /** @type {{ running: boolean, script?: string, url?: string, startedAt?: number, lastLines?: string[] }} */
  const state = { running, script: rec.script, startedAt: rec.startedAt };
  if (rec.url) state.url = rec.url;
  const lines = lastLinesOf(rec);
  if (lines.length) state.lastLines = lines;
  return state;
}

/**
 * @param {number} pid
 * @param {NodeJS.Platform} [platform]
 */
function killProcessGroup(pid, platform = process.platform) {
  if (!pid) return;
  // Windows has no POSIX process groups; process.kill(-pid) throws and
  // SIGTERM is terminate. Kill the pid directly instead of failing closed
  // through the catch.
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
  if (pendingKills.has(pid)) return;
  const timer = setTimeout(() => {
    pendingKills.delete(pid);
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
  pendingKills.set(pid, timer);
}

/**
 * Spawn `npm run <script>` for this thread. Already-running returns
 * the current state without spawning again.
 *
 * No /bin/sh: the command is argv (`npm`, `run`, script), not a user
 * shell string. On win32, cross-spawn finds npm.cmd. A WSL-side root
 * is wrapped through ssh.js so npm runs inside the distro.
 *
 * @param {string} threadId
 * @param {string} root
 * @param {string} script
 * @param {{
 *   platform?: NodeJS.Platform,
 *   spawn?: typeof spawn,
 *   project?: { remoteHost?: string, remotePath?: string, path?: string } | null,
 * }} [opts]
 */
function start(threadId, root, script, opts = {}) {
  const existing = records.get(threadId);
  if (existing && !existing.dead && isAlive(existing.pid)) {
    return toState(existing);
  }
  if (existing) records.delete(threadId);

  const platform = opts.platform || process.platform;
  const spawnFn = opts.spawn || spawn;
  const project = opts.project || { path: root };
  // WSL-side only — do not wrap ssh remotes (would change macOS behaviour).
  const wsl = wslTarget(project, platform);
  const raw = { bin: "npm", args: ["run", script] };
  const wrapped = wsl
    ? wrapCommand(project, raw.bin, raw.args, platform)
    : raw;

  let child;
  try {
    child = spawnFn(wrapped.bin, wrapped.args, {
      cwd: wsl ? undefined : root,
      detached: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const rec = {
      pid: 0,
      script,
      startedAt: Date.now(),
      url: null,
      lines: [message],
      pending: "",
      dead: true,
      deadAt: Date.now(),
      platform,
    };
    records.set(threadId, rec);
    return toState(rec);
  }

  const pid = child.pid || 0;
  /** @type {DevServerRecord} */
  const rec = {
    pid,
    script,
    startedAt: Date.now(),
    url: null,
    lines: [],
    pending: "",
    dead: !pid,
    deadAt: !pid ? Date.now() : null,
    platform,
  };
  records.set(threadId, rec);

  if (child.stdout) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => appendLog(rec, chunk));
  }
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => appendLog(rec, chunk));
  }
  child.on("error", (err) => {
    appendLog(rec, err && err.message ? err.message : String(err));
    markDead(rec);
  });
  child.on("exit", () => {
    const current = records.get(threadId);
    if (current === rec) markDead(rec);
  });
  if (typeof child.unref === "function") child.unref();

  return toState(rec);
}

/**
 * Kill the process group and drop the record.
 *
 * @param {string} threadId
 */
function stop(threadId) {
  const rec = records.get(threadId);
  if (!rec) return { running: false };
  if (rec.pid) killProcessGroup(rec.pid, rec.platform);
  records.delete(threadId);
  return { running: false };
}

/**
 * Live status. Dead pids are marked stopped but kept so lastLines remain.
 *
 * @param {string} threadId
 */
function status(threadId) {
  const rec = records.get(threadId);
  if (!rec) return { running: false };
  const state = toState(rec);
  if (rec.dead && rec.deadAt && Date.now() - rec.deadAt > DEAD_TTL_MS) {
    records.delete(threadId);
  }
  return state;
}

/** Stop every tracked server. Wired into app quit. */
function killAll() {
  for (const id of [...records.keys()]) {
    stop(id);
  }
}

module.exports = {
  captureServerUrl,
  detectScripts,
  scriptsFromPackageJson,
  appendLog,
  start,
  stop,
  status,
  killAll,
};
