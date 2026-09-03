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

const fs = require("node:fs");
const path = require("node:path");
const { injectMuseGuardrailHooks } = require("./muse-guardrail-hook.js");

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

module.exports = {
  materializeMuseHome,
  museChildEnv,
  reclaimMuseHomes,
  toMuseMcpServers,
};
