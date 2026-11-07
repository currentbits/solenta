"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
// cross-spawn, not child_process: on Windows npm is npm.cmd and Node
// refuses to exec .cmd shims without a shell. Same reason as agent.js (#442).
const spawn = require("cross-spawn");
const { wrapCommand } = require("./ssh.js");
const { wslTarget } = require("./wsl.js");
const {
  withChromiumUserDataDir,
  rewriteChromiumScriptBody,
  looksLikeProcessWrapper,
  electronIdentityEnv,
} = require("./worktreeEnv.js");
const { readRepoJson } = require("./repoConfig.js");
const { isLoopbackHost } = require("./links.js");
const { runVerifyCommand, normalizeCommand } = require("./verify.js");

const PREFERRED_SCRIPTS = ["dev", "start", "serve"];
const RING_LIMIT = 50;
const PENDING_LIMIT = 4096;
const DEAD_TTL_MS = 5 * 60_000;
const KILL_FALLBACK_MS = 3_000;
const PROBE_INTERVAL_MS = 500;
const PROBE_ATTEMPT_MS = 5_000;
const PROBE_TIMEOUT_MS = 120_000;

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
 * Body of `scripts[name]` in package.json at `root`, or "".
 *
 * @param {string} root
 * @param {string} script
 * @returns {string}
 */
function scriptCommand(root, script) {
  try {
    if (!root || !script) return "";
    const raw = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    const value =
      pkg && pkg.scripts && typeof pkg.scripts === "object"
        ? pkg.scripts[script]
        : "";
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/**
 * @typedef {{ kind: "tcp" | "http" | "exec", target: string, timeoutMs: number }} ReadyProbe
 * @typedef {{
 *   kind?: "tcp" | "http" | "exec",
 *   target?: string,
 *   status: "waiting" | "ready" | "failed",
 *   lastError?: string,
 *   readyAt?: number,
 * }} ProbeState
 */

/**
 * `$PORT` / `${PORT}` from the dev server's own env, so a lane's port is
 * what gets probed. An unset variable is an error, not an empty string.
 *
 * @param {string} text
 * @param {NodeJS.ProcessEnv} env
 */
function expandEnv(text, env) {
  return text.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, a, b) => {
    const name = a || b;
    const value = env[name];
    if (value == null || value === "") throw new Error(`${name} is not set`);
    return value;
  });
}

/**
 * `devServer.ready` from solenta.json (#282): exactly one of
 *   { "tcp": 5173 | "$PORT" }
 *   { "http": "http://localhost:$PORT/health" }   (loopback only)
 *   { "exec": "test -f /tmp/ready" }
 * plus an optional `timeoutMs`. Absent → null. Invalid → `{ error }`.
 *
 * `exec` needs no solenta.json approval: it only runs after the user
 * clicked Start on a repo npm script, which already runs repo code.
 *
 * @param {unknown} json parsed solenta.json
 * @param {NodeJS.ProcessEnv} env
 * @returns {ReadyProbe | { error: string } | null}
 */
function parseReadyProbe(json, env) {
  const dev = json && typeof json === "object" ? /** @type {any} */ (json).devServer : null;
  const ready = dev && typeof dev === "object" ? dev.ready : undefined;
  if (ready === undefined) return null;
  const bad = (/** @type {string} */ msg) => ({ error: `solenta.json: devServer.ready ${msg}` });
  if (!ready || typeof ready !== "object" || Array.isArray(ready)) return bad("must be an object");
  const kinds = /** @type {const} */ (["tcp", "http", "exec"]).filter((k) => ready[k] !== undefined);
  if (kinds.length !== 1) return bad("needs exactly one of tcp, http, exec");
  const kind = kinds[0];
  const timeoutMs = ready.timeoutMs === undefined ? PROBE_TIMEOUT_MS : Number(ready.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) return bad("timeoutMs must be an integer ≥ 1000");
  try {
    if (kind === "exec") {
      const command = normalizeCommand(ready.exec);
      if (!command) return bad("exec must be a non-empty command string");
      return { kind, target: command, timeoutMs };
    }
    if (kind === "tcp") {
      const port = Number(typeof ready.tcp === "string" ? expandEnv(ready.tcp, env) : ready.tcp);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return bad("tcp must be a port");
      return { kind, target: `localhost:${port}`, timeoutMs };
    }
    const url = new URL(expandEnv(String(ready.http), env));
    if (!/^https?:$/.test(url.protocol) || !isLoopbackHost(url.hostname)) {
      return bad("http must be a localhost http(s) URL");
    }
    return { kind, target: url.href, timeoutMs };
  } catch (err) {
    return bad(`${kind}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * One probe attempt. Resolves null when ready, else why not.
 *
 * @param {ReadyProbe} probe
 * @param {{ root: string, env: NodeJS.ProcessEnv, project: any, platform: NodeJS.Platform }} ctx
 * @returns {Promise<string | null>}
 */
async function probeOnce(probe, ctx) {
  if (probe.kind === "tcp") {
    const port = Number(probe.target.slice(probe.target.lastIndexOf(":") + 1));
    return new Promise((resolve) => {
      const sock = net.connect({ host: "localhost", port });
      const done = (/** @type {string | null} */ why) => {
        sock.destroy();
        resolve(why);
      };
      sock.setTimeout(PROBE_ATTEMPT_MS, () => done("timed out"));
      sock.once("connect", () => done(null));
      sock.once("error", (err) => done(/** @type {any} */ (err).code || err.message));
    });
  }
  if (probe.kind === "http") {
    try {
      const res = await fetch(probe.target, {
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_ATTEMPT_MS),
      });
      await res.body?.cancel();
      return res.status >= 200 && res.status < 400 ? null : `HTTP ${res.status}`;
    } catch (err) {
      const cause = /** @type {any} */ (err).cause;
      return (cause && (cause.code || cause.message)) || /** @type {any} */ (err).message;
    }
  }
  const res = await runVerifyCommand({
    command: probe.target,
    cwd: ctx.root,
    timeoutMs: PROBE_ATTEMPT_MS,
    env: ctx.env,
    project: ctx.project,
    platform: ctx.platform,
  });
  if (res.ok) return null;
  const tail = res.log.trim().split("\n").pop();
  return res.timedOut ? "timed out" : tail || `exit ${res.exitCode}`;
}

/**
 * @typedef {{
 *   pid: number,
 *   root?: string,
 *   keepLog?: boolean,
 *   script: string,
 *   startedAt: number,
 *   url: string | null,
 *   lines: string[],
 *   pending: string,
 *   dead: boolean,
 *   deadAt: number | null,
 *   platform: NodeJS.Platform,
 *   probe?: ProbeState,
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
 * @returns {{ running: boolean, script?: string, url?: string, startedAt?: number, lastLines?: string[], probe?: ProbeState }}
 */
function toState(rec) {
  const running = !rec.dead && isAlive(rec.pid);
  if (!running) markDead(rec);
  /** @type {{ running: boolean, script?: string, url?: string, startedAt?: number, lastLines?: string[], probe?: ProbeState }} */
  const state = { running, script: rec.script, startedAt: rec.startedAt };
  // A declared probe gates the URL: the Browser pane auto-loads it.
  if (rec.url && (!rec.probe || rec.probe.status === "ready")) state.url = rec.url;
  if (rec.probe) state.probe = { ...rec.probe };
  const lines = lastLinesOf(rec);
  if (lines.length) state.lastLines = lines;
  return state;
}

/**
 * Poll the declared probe until it passes, the server dies or is replaced,
 * or `timeoutMs` runs out. Ready is sticky: no ongoing health checks.
 *
 * @param {string} threadId
 * @param {DevServerRecord} rec
 * @param {ReadyProbe | { error: string }} probe
 * @param {{ root: string, env: NodeJS.ProcessEnv, project: any, platform: NodeJS.Platform, intervalMs: number }} ctx
 */
function watchReady(threadId, rec, probe, ctx) {
  if ("error" in probe) {
    rec.probe = { status: "failed", lastError: probe.error };
    return;
  }
  /** @type {ProbeState} */
  const state = { kind: probe.kind, target: probe.target, status: "waiting" };
  rec.probe = state;
  const gone = () => rec.dead || records.get(threadId) !== rec;
  const tick = async () => {
    if (gone()) return;
    const why = await probeOnce(probe, ctx);
    if (gone()) return;
    if (why === null) {
      state.status = "ready";
      state.readyAt = Date.now();
      delete state.lastError;
      return;
    }
    state.lastError = why;
    if (Date.now() - rec.startedAt >= probe.timeoutMs) {
      state.status = "failed";
      return;
    }
    schedule();
  };
  const schedule = () => {
    const timer = setTimeout(() => void tick(), ctx.intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  };
  schedule();
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
 *   env?: NodeJS.ProcessEnv,
 *   project?: { remoteHost?: string, remotePath?: string, path?: string } | null,
 *   probeIntervalMs?: number,
 *   onExit?: () => void,
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
  const extraEnv = {
    ...(opts.env && typeof opts.env === "object" ? opts.env : {}),
  };
  // WSL-side only — do not wrap ssh remotes (would change macOS behaviour).
  const wsl = wslTarget(project, platform);
  const raw = { bin: "npm", args: ["run", script] };
  let wrapped = wsl
    ? wrapCommand(project, raw.bin, raw.args, platform, extraEnv)
    : { bin: raw.bin, args: [...raw.args] };
  const command = scriptCommand(root, script) || script;
  const rewritten = rewriteChromiumScriptBody(command, extraEnv);
  if (rewritten !== command && looksLikeProcessWrapper(command)) {
    const posix = Boolean(wsl) || platform !== "win32";
    const join = posix ? path.posix.join.bind(path.posix) : path.join;
    const delimiter = posix ? ":" : ";";
    const launchRoot =
      wsl && project && typeof project.remotePath === "string" && project.remotePath
        ? project.remotePath
        : root;
    const binDir = join(launchRoot, "node_modules", ".bin");
    extraEnv.PATH = `${binDir}${delimiter}${extraEnv.PATH || process.env.PATH || ""}`;
    if (wsl) {
      wrapped = wrapCommand(project, "sh", ["-c", rewritten], platform, extraEnv);
    } else if (platform === "win32") {
      wrapped = { bin: "cmd.exe", args: ["/d", "/s", "/c", rewritten] };
    } else {
      wrapped = { bin: "sh", args: ["-c", rewritten] };
    }
  } else {
    wrapped.args = withChromiumUserDataDir(wrapped.args, extraEnv, command);
  }
  Object.assign(
    extraEnv,
    electronIdentityEnv(extraEnv, command, {
      platform,
      path: extraEnv.PATH,
    }),
  );
  let child;
  try {
    child = spawnFn(wrapped.bin, wrapped.args, {
      cwd: wsl ? undefined : root,
      detached: true,
      env: { ...process.env, ...extraEnv },
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
    root,
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
    if (opts.onExit) opts.onExit();
  });
  if (typeof child.unref === "function") child.unref();

  if (pid) {
    const env = { ...process.env, ...extraEnv };
    // Unreadable solenta.json → no probe; the project settings show that error.
    const repo = readRepoJson(root);
    const probe = repo && !repo.error ? parseReadyProbe(repo.json, env) : null;
    if (probe) {
      watchReady(threadId, rec, probe, {
        root,
        env,
        project,
        platform,
        intervalMs: opts.probeIntervalMs || PROBE_INTERVAL_MS,
      });
    }
  }

  return toState(rec);
}

/**
 * Kill the process group and drop the record.
 *
 * @param {string} threadId
 */
function stop(threadId, opts = {}) {
  const rec = records.get(threadId);
  if (!rec) return { running: false };
  if (rec.pid && !rec.dead && isAlive(rec.pid)) killProcessGroup(rec.pid, rec.platform);
  if (opts.preserveLog) {
    if (!rec.dead) appendLog(rec, "\n[settle] stopped managed dev server\n");
    markDead(rec);
    rec.keepLog = true;
    return toState(rec);
  }
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
  if (!rec.keepLog && rec.dead && rec.deadAt && Date.now() - rec.deadAt > DEAD_TTL_MS) {
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

/** Thread ids with a still-running managed server. Dead records do not count. */
function listLive() {
  const ids = [];
  for (const [id, rec] of records) {
    if (rec && !rec.dead && isAlive(rec.pid)) ids.push(id);
  }
  return ids;
}

module.exports = {
  captureServerUrl,
  parseReadyProbe,
  detectScripts,
  scriptsFromPackageJson,
  appendLog,
  start,
  stop,
  status,
  killAll,
  listLive,
  rootFor: (threadId) => records.get(threadId)?.root,
};
