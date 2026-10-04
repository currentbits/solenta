"use strict";

/**
 * Local per-thread provider home overlays: `<userDataPath>/<bucket>/<threadId>/`
 * (cursor-homes #700, grok-homes #706, kimi-homes #675, muse-homes #873).
 * Overlays are mostly symlinks into the user's real config dirs, so removal
 * must never follow a link.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * Overlay must stay: a CLI child may still be reading it. Matches worktree
 * GC's live-thread skip.
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
 * Remove `target` without following symlinks. Unlink a symlink (even one
 * pointing at a directory) instead of descending into the target — overlay
 * links go into the user's real provider config.
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
    // directory on Windows, and following it would wipe the real config.
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
 * Reclaim stale overlays under `<userDataPath>/<bucket>/`. Called from
 * scheduleRetention so boot / archive / merge / the 6h sweeper pick them
 * up — not a new timer. Skips a thread that is working or in quota-wait.
 *
 * @param {object} opts
 * @param {string} [opts.userDataPath]
 * @param {{ getThread?: (id: string) => { status?: string } | null }} [opts.store]
 * @param {string} bucket - e.g. "cursor-homes"
 * @param {(dest: string) => void} [beforeRemove] - runs inside the same
 *   try as the removal; a throw skips that overlay until the next pass
 * @returns {{ removed: string[], skipped: string[] }}
 */
function reclaimOverlayHomes(opts, bucket, beforeRemove) {
  const userDataPath = String((opts && opts.userDataPath) || "");
  if (!userDataPath) return { removed: [], skipped: [] };
  const store = opts && opts.store;
  // Without a store we cannot tell a live turn from a stale overlay.
  // Refuse rather than risk deleting an in-use home.
  if (!store || typeof store.getThread !== "function") {
    return { removed: [], skipped: [] };
  }
  const base = path.join(userDataPath, bucket);
  let baseStat;
  try {
    baseStat = fs.lstatSync(base);
  } catch (err) {
    if (err && err.code === "ENOENT") return { removed: [], skipped: [] };
    throw err;
  }
  // A symlinked bucket would make readdir walk the target. Refuse.
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
    // crafted name with a separator must never walk outside the bucket.
    if (!name || name !== path.basename(name)) continue;
    const dest = path.join(base, name);
    if (isLiveOverlayThread(store, name)) {
      skipped.push(dest);
      continue;
    }
    try {
      if (beforeRemove) beforeRemove(dest);
      rmWithoutFollowing(dest);
      removed.push(dest);
    } catch {
      // housekeeping; a busy overlay is retried on the next pass
    }
  }
  return { removed, skipped };
}

module.exports = {
  isLiveOverlayThread,
  rmWithoutFollowing,
  reclaimOverlayHomes,
};
