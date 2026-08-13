"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PREFERRED_SCRIPTS = ["dev", "start", "serve"];
const RING_LIMIT = 50;
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
 * @param {string} chunk
 */
function appendLog(rec, chunk) {
  const text = String(chunk);
  if (!rec.url) {
    rec.url = captureServerUrl(rec.pending + text) || captureServerUrl(text);
  }
  rec.pending += text;
  const parts = rec.pending.split(/\r?\n/);
  rec.pending = parts.pop() || "";
  for (const line of parts) {
    rec.lines.push(line);
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
  if (!running) rec.dead = true;
  /** @type {{ running: boolean, script?: string, url?: string, startedAt?: number, lastLines?: string[] }} */
  const state = { running, script: rec.script, startedAt: rec.startedAt };
  if (rec.url) state.url = rec.url;
  const lines = lastLinesOf(rec);
  if (lines.length) state.lastLines = lines;
  return state;
}

/**
 * @param {number} pid
 */
function killProcessGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
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
      process.kill(-pid, "SIGKILL");
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
 * @param {string} threadId
 * @param {string} root
 * @param {string} script
 */
function start(threadId, root, script) {
  const existing = records.get(threadId);
  if (existing && !existing.dead && isAlive(existing.pid)) {
    return toState(existing);
  }
  if (existing) records.delete(threadId);

  let child;
  try {
    child = spawn("npm", ["run", script], {
      cwd: root,
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
    rec.dead = true;
  });
  child.on("exit", () => {
    const current = records.get(threadId);
    if (current === rec) rec.dead = true;
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
  if (rec.pid) killProcessGroup(rec.pid);
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
  return toState(rec);
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
  start,
  stop,
  status,
  killAll,
};
