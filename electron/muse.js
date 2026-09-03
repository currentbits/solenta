"use strict";

/**
 * Per-run Muse XDG overlay (issue #873).
 *
 * Muse stores MCP and hooks in user-global ~/.config/muse/settings.json, so
 * a Solenta muse turn in project A would inherit every other project's
 * servers. Overlay: symlink auth.json + sessions, write a fresh
 * settings.json with schema_version 1 and only Solenta MCP. Child env is
 * XDG_CONFIG_HOME + XDG_DATA_HOME (no first-party MUSE_HOME; do not rewrite
 * process-wide HOME). Never follow those symlinks on reclaim.
 */

const spawn = require("cross-spawn");
const fs = require("node:fs");
const path = require("node:path");
const { killTree, agentSpawnOptions } = require("./proc.js");
const { posixQuote } = require("./ssh.js");
const {
  injectMuseGuardrailHooks,
  museGuardrailHookCommand,
} = require("./muse-guardrail-hook.js");
const remoteOverlay = require("./remote-overlay.js");

const SIGKILL_AFTER_MS = 3000;
const STDERR_TAIL_CHARS = 64 * 1024;

function linkOrSkip(src, dst) {
  if (!fs.existsSync(src) || fs.existsSync(dst)) return;
  try {
    fs.symlinkSync(src, dst);
  } catch {
    // Windows without symlink privilege: isolation still holds; resume/auth
    // just will not share with the user's real home.
  }
}

/**
 * Map Solenta/kimiMcpServersForRun entries onto Muse settings.json
 * mcp_servers. HTTP becomes streamable_http; stdio stays stdio.
 * @param {Record<string, object> | null | undefined} solentaServers
 * @returns {Record<string, object>}
 */
function toMuseMcpServers(solentaServers) {
  const mcp_servers = {};
  for (const [name, entry] of Object.entries(solentaServers || {})) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "stdio") {
      mcp_servers[name] = {
        transport: "stdio",
        command: entry.command || "",
        args: Array.isArray(entry.args) ? entry.args : [],
        enabled: true,
        mode: "optional",
      };
      continue;
    }
    mcp_servers[name] = {
      transport: "streamable_http",
      url: entry.url || "",
      headers: entry.headers || {},
      enabled: true,
      mode: "optional",
    };
  }
  return mcp_servers;
}

/**
 * @param {object} opts
 * @param {string} opts.dest
 * @param {string} [opts.sourceConfigDir]
 * @param {string} [opts.sourceDataDir]
 * @param {Record<string, object>} [opts.mcpServers]
 * @param {string} [opts.hookCommand]
 * @returns {string} dest
 */
function materializeMuseHome(opts) {
  const dest = String(opts.dest || "");
  if (!dest) throw new Error("materializeMuseHome: dest required");
  const configDir = path.join(dest, "config", "muse");
  const dataDir = path.join(dest, "share", "muse");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const srcCfg = String(opts.sourceConfigDir || "");
  const srcData = String(opts.sourceDataDir || "");
  if (srcCfg) {
    linkOrSkip(path.join(srcCfg, "auth.json"), path.join(configDir, "auth.json"));
  }
  if (srcData) {
    linkOrSkip(path.join(srcData, "sessions"), path.join(dataDir, "sessions"));
  }
  const settings = {
    schema_version: 1,
    mcp_servers: toMuseMcpServers(opts.mcpServers),
  };
  if (opts.hookCommand) {
    const hooksPath = path.join(dest, "solenta-hooks.json");
    settings.managed_hooks_path = hooksPath;
    fs.writeFileSync(
      hooksPath,
      injectMuseGuardrailHooks("", opts.hookCommand, 15),
    );
    for (const name of [
      "muse-guardrail-hook.js",
      "guardrail-hook-core.js",
      "guardrails.js",
    ]) {
      fs.copyFileSync(path.join(__dirname, name), path.join(dest, name));
    }
  }
  fs.writeFileSync(
    path.join(configDir, "settings.json"),
    JSON.stringify(settings, null, 2) + "\n",
    { mode: 0o600 },
  );
  return dest;
}

/**
 * Child-only env for an isolated overlay. Do not set HOME.
 * @param {string} dest
 * @returns {{ XDG_CONFIG_HOME: string, XDG_DATA_HOME: string }}
 */
function museChildEnv(dest) {
  return {
    XDG_CONFIG_HOME: path.join(dest, "config"),
    XDG_DATA_HOME: path.join(dest, "share"),
  };
}

/**
 * Deploy the XDG overlay onto an ssh/WSL host (#873).
 * Returns the remote dest path. Throws if dest is unusable.
 *
 * Far-side child env is XDG_CONFIG_HOME / XDG_DATA_HOME (no MUSE_HOME).
 * Auth/sessions are symlinked from the remote user's XDG muse dirs.
 *
 * @param {object} opts
 * @param {{ remoteHost?: string, path?: string } | null} opts.project
 * @param {string} opts.threadId
 * @returns {string | null}
 */
function deployMuseGuardrailOverlay(opts) {
  const project = opts && opts.project;
  const threadId = opts && opts.threadId;
  if (!project || !threadId) return null;
  const dest = remoteOverlay.remoteOverlayDest(
    remoteOverlay.probeRemoteHome(project),
    threadId,
    "muse-homes",
  );
  if (!dest) throw new Error("remote muse overlay dest unusable");
  const hookDest = `${dest}/muse-guardrail-hook.js`;
  const command = museGuardrailHookCommand({
    nodePath: "node",
    hookPath: hookDest,
    posix: true,
  });
  const hooksPath = `${dest}/solenta-hooks.json`;
  const settings = {
    schema_version: 1,
    mcp_servers: {},
    managed_hooks_path: hooksPath,
  };
  remoteOverlay.writeRemoteOverlay(
    project,
    dest,
    {
      "muse-guardrail-hook.js": fs.readFileSync(
        path.join(__dirname, "muse-guardrail-hook.js"),
        "utf8",
      ),
      "guardrails.js": fs.readFileSync(
        path.join(__dirname, "guardrails.js"),
        "utf8",
      ),
      "guardrail-hook-core.js": fs.readFileSync(
        path.join(__dirname, "guardrail-hook-core.js"),
        "utf8",
      ),
      "solenta-hooks.json": injectMuseGuardrailHooks("", command, 15),
      "config/muse/settings.json": JSON.stringify(settings, null, 2) + "\n",
    },
    [
      `if [ -n "$XDG_CONFIG_HOME" ]; then src="$XDG_CONFIG_HOME/muse/auth.json"; else src="$HOME/.config/muse/auth.json"; fi; dst=${posixQuote(`${dest}/config/muse/auth.json`)}; mkdir -p ${posixQuote(`${dest}/config/muse`)}; if [ -e "$src" ] && [ ! -e "$dst" ]; then ln -s "$src" "$dst"; fi`,
      `if [ -n "$XDG_DATA_HOME" ]; then src="$XDG_DATA_HOME/muse/sessions"; else src="$HOME/.local/share/muse/sessions"; fi; dst=${posixQuote(`${dest}/share/muse/sessions`)}; mkdir -p ${posixQuote(`${dest}/share/muse`)}; if [ -e "$src" ] && [ ! -e "$dst" ]; then ln -s "$src" "$dst"; fi`,
    ],
  );
  return dest;
}

/**
 * True when the overlay must stay on disk: a muse child may still be
 * reading it. Matches worktree GC's live-thread skip.
 * @param {object | null | undefined} store
 * @param {string} threadId
 */
function isLiveMuseThread(store, threadId) {
  if (!store || typeof store.getThread !== "function") return false;
  const thread = store.getThread(threadId);
  if (!thread) return false;
  return thread.status === "working" || thread.status === "quota-wait";
}

/**
 * Remove `target` without following symlinks. Unlink a symlink (even one
 * pointing at a directory) instead of descending into the target — the
 * overlay's auth.json/sessions links go into ~/.config/muse and
 * ~/.local/share/muse.
 * @param {string} target
 */
function rmWithoutFollowing(target) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  for (const ent of entries) {
    const child = path.join(target, ent.name);
    // isSymbolicLink first: a junction/link-to-dir can also report as a
    // directory on Windows, and following it would wipe ~/.config/muse.
    if (ent.isSymbolicLink() || !ent.isDirectory()) {
      try {
        fs.unlinkSync(child);
      } catch {
        // best-effort
      }
    } else {
      rmWithoutFollowing(child);
    }
  }
  fs.rmdirSync(target);
}

/**
 * Reclaim stale Muse XDG overlays (#873).
 *
 * One dir per thread that has ever run muse, under
 * `<userDataPath>/muse-homes/<threadId>/`. Called from scheduleRetention
 * so boot / archive / merge / the 6h sweeper pick them up — not a new
 * timer. Skips a thread that is currently working or in quota-wait.
 *
 * @param {object} opts
 * @param {string} [opts.userDataPath]
 * @param {{ getThread?: (id: string) => { status?: string } | null }} [opts.store]
 * @returns {{ removed: string[], skipped: string[] }}
 */
function reclaimMuseHomes(opts) {
  const userDataPath = String((opts && opts.userDataPath) || "");
  if (!userDataPath) return { removed: [], skipped: [] };
  const store = opts && opts.store;
  // Without a store we cannot tell a live muse turn from a stale overlay.
  // Refuse rather than risk deleting an in-use home.
  if (!store || typeof store.getThread !== "function") {
    return { removed: [], skipped: [] };
  }
  const base = path.join(userDataPath, "muse-homes");
  let baseStat;
  try {
    baseStat = fs.lstatSync(base);
  } catch (err) {
    if (err && err.code === "ENOENT") return { removed: [], skipped: [] };
    throw err;
  }
  // A symlinked muse-homes/ would make readdir walk the target. Refuse.
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
    return { removed: [], skipped: [] };
  }

  const removed = [];
  const skipped = [];
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return { removed, skipped };
  }
  for (const name of names) {
    // path.basename guard: readdir cannot return ".." on POSIX, but a
    // crafted name with a separator must never walk outside muse-homes.
    if (!name || name !== path.basename(name)) continue;
    const dest = path.join(base, name);
    if (isLiveMuseThread(store, name)) {
      skipped.push(dest);
      continue;
    }
    try {
      rmWithoutFollowing(dest);
      removed.push(dest);
    } catch {
      // housekeeping; a busy overlay is retried on the next pass
    }
  }
  return { removed, skipped };
}

/**
 * Resume handle from echo-hello.jsonl: obj.stream.id when
 * obj.stream.kind === "session". Top-level obj.id restarts per session.
 * @param {object} obj
 * @returns {string | null}
 */
function extractSessionId(obj) {
  if (!obj || typeof obj !== "object") return null;
  const stream = obj.stream;
  if (!stream || typeof stream !== "object") return null;
  if (stream.kind !== "session") return null;
  return typeof stream.id === "string" && stream.id ? stream.id : null;
}

/**
 * Assistant text from echo-hello.jsonl: payload.text on
 * run.output.delta and run.terminal.completed.
 * @param {object} obj
 * @returns {string | null}
 */
function extractAssistantText(obj) {
  if (!obj || typeof obj !== "object") return null;
  const type = obj.payload_type;
  if (type !== "run.output.delta" && type !== "run.terminal.completed") {
    return null;
  }
  const payload = obj.payload;
  if (!payload || typeof payload !== "object") return null;
  return typeof payload.text === "string" && payload.text ? payload.text : null;
}

/**
 * echo-hello.jsonl / echo-tools.jsonl have no thinking payload.
 * @param {object} obj
 * @returns {string | null}
 */
function extractThinking(obj) {
  if (!obj || typeof obj !== "object") return null;
  return null;
}

/**
 * echo-hello.jsonl / echo-tools.jsonl have no tool start/result.
 * Unknown objects return null; do not invent a Spark tool shape.
 * @param {object} obj
 * @returns {{ phase: string, id: string, name: string, input?: unknown, output?: unknown } | null}
 */
function extractToolEvent(obj) {
  if (!obj || typeof obj !== "object") return null;
  return null;
}

/**
 * echo-hello.jsonl / echo-tools.jsonl have no usage fields.
 * @param {object} obj
 * @returns {{ inputTokens: number, outputTokens: number, costUsd?: number } | null}
 */
function extractUsage(obj) {
  if (!obj || typeof obj !== "object") return null;
  return null;
}

/**
 * Tool cards are stream-scoped because record ids restart per session.
 * @param {string} streamId
 * @param {string} recordId
 * @returns {string}
 */
function toolCardKey(streamId, recordId) {
  return `${streamId}:${recordId}`;
}

/**
 * Spawn muse exec --json and parse stdout JSONL.
 * @param {object} opts
 * @param {string} [opts.binary]
 * @param {string[]} [opts.args]
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {(obj: object) => void} [opts.onEvent]
 * @param {(info: { code: number | null, stderr: string, fullStdout: string, gotJson: boolean }) => void} [opts.onExit]
 * @param {(err: Error) => void} [opts.onError]
 * @returns {{ kill: () => void }}
 */
function runMuse(opts) {
  const {
    binary = process.env.CODER_MUSE_BIN || "muse",
    args = [],
    cwd,
    env: envOverride,
    onEvent,
    onExit,
    onError,
  } = opts;
  const childEnv = envOverride
    ? { ...process.env, ...envOverride }
    : undefined;

  let stderrText = "";
  let fullStdout = "";
  let lineBuf = "";
  let finished = false;
  let killTimer = null;
  let killed = false;
  let gotJson = false;

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!obj || typeof obj !== "object") return;
    gotJson = true;
    emitEvent(obj);
  }

  /**
   * @param {object} obj
   */
  function emitEvent(obj) {
    if (typeof onEvent !== "function") return;
    try {
      onEvent(obj);
    } catch {
      // defensive: never crash the parser
    }
  }

  function finish(code) {
    if (finished) return;
    finished = true;
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    if (lineBuf.trim()) {
      handleLine(lineBuf);
      lineBuf = "";
    }
    if (typeof onExit === "function") {
      onExit({
        code,
        stderr: stderrText,
        fullStdout,
        gotJson,
      });
    }
  }

  let child;
  try {
    child = spawn(
      binary,
      args,
      agentSpawnOptions({
        cwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (typeof onError === "function") onError(error);
    if (typeof onExit === "function") {
      onExit({
        code: 1,
        stderr: error.message,
        fullStdout: "",
        gotJson: false,
      });
    }
    return { kill() {} };
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    const str = String(chunk);
    fullStdout += str;
    lineBuf += str;
    let nl;
    while ((nl = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      handleLine(line);
    }
  });

  child.stderr.on("data", (chunk) => {
    const str = String(chunk);
    stderrText = (stderrText + str).slice(-STDERR_TAIL_CHARS);
  });

  child.on("error", (err) => {
    if (typeof onError === "function") onError(err);
    finish(1);
  });

  child.on("close", (code) => {
    finish(code);
  });

  return {
    kill() {
      if (killed || finished) return;
      killed = true;
      killTimer = killTree(child, SIGKILL_AFTER_MS);
    },
  };
}

module.exports = {
  materializeMuseHome,
  museChildEnv,
  deployMuseGuardrailOverlay,
  reclaimMuseHomes,
  toMuseMcpServers,
  extractSessionId,
  extractAssistantText,
  extractThinking,
  extractToolEvent,
  extractUsage,
  toolCardKey,
  runMuse,
};
