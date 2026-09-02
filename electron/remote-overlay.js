"use strict";

/**
 * Write / reclaim files on the other side of wrapCommand (ssh / WSL).
 * One `sh -c` so a stall is one timeout, not one per file.
 *
 * Dest is always `$HOME/.solenta/<kind>/<threadId>`. Never the user's
 * real ~/.codex or ~/.opencode (#838).
 */

const path = require("node:path");
const { execCommand, posixQuote } = require("./ssh.js");
const { wslTarget } = require("./wsl.js");

/** Overlay buckets written by #835 / #836 / #837. */
const REMOTE_OVERLAY_KINDS = [
  "codex-homes",
  "opencode-guardrails",
  "cursor-guardrails",
  "kimi-homes",
];

/**
 * Relative dest path: no absolute, no `.` / `..` segments.
 * @param {string} rel
 * @returns {string}
 */
function safeRelPath(rel) {
  const n = String(rel || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!n) return "";
  const parts = n.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return "";
  return parts.join("/");
}

/**
 * @param {string} remoteHome
 * @param {string} threadId
 * @param {string} kind  e.g. cursor-guardrails, kimi-homes
 * @returns {string}
 */
function remoteOverlayDest(remoteHome, threadId, kind) {
  const home = String(remoteHome || "").replace(/\/+$/, "");
  const id = path.posix.basename(String(threadId || ""));
  const bucket = String(kind || "");
  if (!home || !id || id !== String(threadId || "")) return "";
  if (!/^[A-Za-z0-9_-]+$/.test(bucket)) return "";
  return `${home}/.solenta/${bucket}/${id}`;
}

/**
 * @param {{ remoteHost?: string, path?: string } | null} project
 * @returns {string}
 */
function probeRemoteHome(project) {
  return String(
    execCommand(project, "sh", ["-c", 'printf %s "$HOME"'], {
      encoding: "utf8",
    }),
  ).trim();
}

/**
 * @param {{ remoteHost?: string, path?: string } | null} project
 * @param {string} dest
 * @param {Record<string, string>} files
 * @param {string[]} [extraCmds]
 */
function writeRemoteOverlay(project, dest, files, extraCmds) {
  const destClean = String(dest || "");
  if (!destClean || destClean.includes("..")) {
    throw new Error("writeRemoteOverlay: dest unusable");
  }
  const parts = [`mkdir -p ${posixQuote(destClean)}`];
  for (const [rel, body] of Object.entries(files || {})) {
    const safe = safeRelPath(rel);
    if (!safe) continue;
    const destFile = `${destClean}/${safe}`;
    const destDir = destFile.slice(0, destFile.lastIndexOf("/"));
    parts.push(`mkdir -p ${posixQuote(destDir)}`);
    const b64 = Buffer.from(String(body), "utf8").toString("base64");
    parts.push(
      `printf '%s' ${posixQuote(b64)} | base64 -d > ${posixQuote(destFile)}`,
    );
  }
  if (Array.isArray(extraCmds)) {
    for (const cmd of extraCmds) {
      if (cmd) parts.push(String(cmd));
    }
  }
  execCommand(project, "sh", ["-c", parts.join(" && ")], { encoding: "utf8" });
}

/**
 * True when this project's commands must run through ssh or wsl.exe.
 * Duplicates runner.crossesBoundary so this module does not require runner.
 * @param {{ remoteHost?: string, path?: string } | null | undefined} project
 */
function projectCrossesBoundary(project) {
  return Boolean(project && (project.remoteHost || wslTarget(project)));
}

/**
 * Overlay must stay: a remote CLI may still be reading it.
 * @param {object | null | undefined} store
 * @param {string} threadId
 */
function isLiveOverlayThread(store, threadId) {
  if (!store || typeof store.getThread !== "function") return false;
  const thread = store.getThread(threadId);
  if (!thread) return false;
  return thread.status === "working" || thread.status === "quota-wait";
}

/**
 * Safe thread id for a remote path segment.
 * @param {unknown} raw
 * @returns {string}
 */
function safeThreadId(raw) {
  const id = path.posix.basename(String(raw || ""));
  if (!id || id !== String(raw || "")) return "";
  return id;
}

/**
 * POSIX body that deletes `$HOME/.solenta/<kind>/<id>` for the #835
 * buckets without following overlay symlinks into ~/.codex / ~/.opencode.
 * `find` without `-L` does not descend into a directory symlink.
 * Never `rm -rf`.
 * @param {string[]} threadIds
 */
function remoteOverlayReclaimScript(threadIds) {
  const ids = [];
  for (const raw of threadIds || []) {
    const id = safeThreadId(raw);
    if (id) ids.push(id);
  }
  if (!ids.length) return "";
  const list = ids.map((id) => posixQuote(id)).join(" ");
  const kinds = REMOTE_OVERLAY_KINDS.map((k) => posixQuote(k)).join(" ");
  return [
    '[ -n "$HOME" ] || exit 0',
    `for id in ${list}; do`,
    `  for kind in ${kinds}; do`,
    '    dest="$HOME/.solenta/$kind/$id"',
    '    case "$dest" in',
    "      */.solenta/codex-homes/*|*/.solenta/opencode-guardrails/*|*/.solenta/cursor-guardrails/*|*/.solenta/kimi-homes/*) ;;",
    "      *) continue ;;",
    "    esac",
    '    if [ -L "$dest" ]; then',
    '      rm -f -- "$dest"',
    "      continue",
    "    fi",
    '    if [ ! -d "$dest" ]; then',
    "      continue",
    "    fi",
    '    find -P "$dest" \\( -type l -o -type f \\) -exec rm -f -- {} +',
    '    find -P "$dest" -depth -type d -exec rmdir -- {} +',
    "  done",
    "done",
  ].join("\n");
}

/**
 * Archived or explicitly settled thread that is not live.
 * @param {object | null | undefined} store
 * @param {object | null | undefined} thread
 */
function isReclaimableOnSweep(store, thread) {
  if (!thread || typeof thread !== "object") return false;
  const id = safeThreadId(thread.id);
  if (!id) return false;
  if (isLiveOverlayThread(store, id)) return false;
  return thread.archived === true || thread.settledOverride === "settled";
}

/**
 * Best-effort reclaim of remote #835 / #836 / #837 overlays (#838).
 *
 * One `sh -c` per crossing project via wrapCommand/execCommand. A dead
 * host or missing dest is swallowed so local kimi/cursor/grok reclaim
 * still runs.
 *
 * Pass `threadId` to reclaim one ended run (even if not archived).
 * Omit it to sweep archived / settled threads from scheduleRetention.
 *
 * @param {object} opts
 * @param {{
 *   getThreads?: () => Array<{ id?: string, projectId?: string, status?: string, archived?: boolean, settledOverride?: string | null }>,
 *   getThread?: (id: string) => { id?: string, projectId?: string, status?: string, archived?: boolean } | null,
 *   getProject?: (id: string) => { remoteHost?: string, path?: string } | null,
 * }} [opts.store]
 * @param {string} [opts.threadId]
 * @returns {{ removed: string[], skipped: string[] }}
 */
function reclaimRemoteOverlays(opts) {
  const removed = [];
  const skipped = [];
  const store = opts && opts.store;
  if (!store || typeof store.getProject !== "function") {
    return { removed, skipped };
  }

  const onlyId = safeThreadId(opts && opts.threadId);
  /** @type {Array<{ id?: string, projectId?: string, status?: string, archived?: boolean, settledOverride?: string | null }>} */
  let threads = [];
  if (onlyId) {
    if (isLiveOverlayThread(store, onlyId)) return { removed, skipped };
    const one =
      typeof store.getThread === "function" ? store.getThread(onlyId) : null;
    if (one) threads = [one];
  } else if (typeof store.getThreads === "function") {
    threads = store.getThreads() || [];
  }

  /** @type {Map<string, { project: object, ids: string[] }>} */
  const byKey = new Map();
  for (const thread of threads) {
    const id = safeThreadId(thread && thread.id);
    if (!id) continue;
    if (onlyId) {
      if (id !== onlyId) continue;
    } else if (!isReclaimableOnSweep(store, thread)) {
      continue;
    }
    const project = store.getProject(thread.projectId);
    if (!project || !projectCrossesBoundary(project)) continue;
    const key = String(project.id || project.remoteHost || project.path || "");
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { project, ids: [] };
      byKey.set(key, bucket);
    }
    bucket.ids.push(id);
  }

  for (const { project, ids } of byKey.values()) {
    const script = remoteOverlayReclaimScript(ids);
    if (!script) continue;
    try {
      execCommand(project, "sh", ["-c", script], { encoding: "utf8" });
      removed.push(...ids);
    } catch {
      // housekeeping; a busy or unreachable host is retried next pass
    }
  }
  return { removed, skipped };
}

module.exports = {
  REMOTE_OVERLAY_KINDS,
  safeRelPath,
  remoteOverlayDest,
  probeRemoteHome,
  writeRemoteOverlay,
  remoteOverlayReclaimScript,
  reclaimRemoteOverlays,
  projectCrossesBoundary,
};
