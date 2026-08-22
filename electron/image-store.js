"use strict";

/**
 * Prune userData/tool-images and userData/attachments (issue #145).
 *
 * Live (non-archived) threads keep their files. Archived and deleted threads
 * lose theirs. Legacy flat tool-images files (no thread dir) are dropped when
 * no live thread still names them — that check hydrates live transcripts only,
 * never archived ones.
 *
 * After the thread pass, a global size cap deletes oldest remaining files.
 */

const fs = require("node:fs");
const path = require("node:path");
const { DIR_NAME: TOOL_DIR, SAFE_ID_RE } = require("./tool-images.js");
const { DIR_NAME: ATTACH_DIR } = require("./attachments.js");

/** Backstop so live-thread screenshots cannot grow userData without bound. */
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * @param {import("./store").Store | { filePath?: string }} store
 * @returns {string}
 */
function userDataPathFromStore(store) {
  if (!store || !store.filePath) return "";
  return path.dirname(store.filePath);
}

/**
 * @param {string} dir
 * @returns {Promise<import("node:fs").Dirent[]>}
 */
async function readDirents(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * @param {string} full
 * @returns {Promise<number>}
 */
async function treeSize(full) {
  try {
    const st = await fs.promises.stat(full);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
  } catch {
    return 0;
  }
  const ents = await readDirents(full);
  let n = 0;
  for (const e of ents) n += await treeSize(path.join(full, e.name));
  return n;
}

/**
 * @param {string} full
 * @returns {Promise<{ bytes: number, removed: number }>}
 */
async function unlinkTree(full) {
  let st;
  try {
    st = await fs.promises.stat(full);
  } catch {
    return { bytes: 0, removed: 0 };
  }
  const bytes = st.isFile() ? st.size : await treeSize(full);
  try {
    await fs.promises.rm(full, { recursive: true, force: true });
    return { bytes, removed: 1 };
  } catch {
    return { bytes: 0, removed: 0 };
  }
}

/**
 * @param {object} store
 * @returns {Set<string>}
 */
function liveThreadIds(store) {
  const ids = new Set();
  const threads = store && typeof store.getThreads === "function"
    ? store.getThreads()
    : [];
  for (const t of threads) {
    if (!t || t.archived) continue;
    const id = String(t.id || "");
    if (SAFE_ID_RE.test(id)) ids.add(id);
  }
  return ids;
}

/**
 * Filenames stored on live tool messages (`uuid.png` or `tid/uuid.png`).
 * Hydrates live threads only.
 * @param {object} store
 * @param {Set<string>} live
 * @returns {Set<string>}
 */
function referencedToolImages(store, live) {
  const names = new Set();
  if (!store || typeof store.getMessages !== "function") return names;
  for (const id of live) {
    const msgs = store.getMessages(id) || [];
    for (const m of msgs) {
      const images = m && m.tool && m.tool.images;
      if (!Array.isArray(images)) continue;
      for (const n of images) {
        if (n) names.add(String(n).replace(/\\/g, "/"));
      }
    }
  }
  return names;
}

/**
 * @param {string} dir
 * @returns {Promise<{ path: string, size: number, mtimeMs: number }[]>}
 */
async function listFilesRecursive(dir) {
  const out = [];
  const ents = await readDirents(dir);
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const nested = await listFilesRecursive(full);
      for (const n of nested) out.push(n);
      continue;
    }
    if (!e.isFile()) continue;
    try {
      const st = await fs.promises.stat(full);
      out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // vanished between readdir and stat
    }
  }
  return out;
}

/**
 * @param {{ userDataPath: string, store: object, maxBytes?: number }} opts
 * @returns {Promise<{ removed: number, bytes: number }>}
 */
async function pruneImageStores(opts) {
  const userDataPath = opts && opts.userDataPath;
  const store = opts && opts.store;
  const maxBytes =
    opts && Number.isFinite(opts.maxBytes) && opts.maxBytes >= 0
      ? opts.maxBytes
      : DEFAULT_MAX_BYTES;
  if (!userDataPath || !store) return { removed: 0, bytes: 0 };

  const live = liveThreadIds(store);
  let removed = 0;
  let bytes = 0;

  const attachRoot = path.join(userDataPath, ATTACH_DIR);
  for (const e of await readDirents(attachRoot)) {
    if (!e.isDirectory()) continue;
    if (!SAFE_ID_RE.test(e.name) || live.has(e.name)) continue;
    const drop = await unlinkTree(path.join(attachRoot, e.name));
    bytes += drop.bytes;
    removed += drop.removed;
  }

  const toolRoot = path.join(userDataPath, TOOL_DIR);
  const toolEnts = await readDirents(toolRoot);
  const rootFiles = [];
  for (const e of toolEnts) {
    if (e.isDirectory()) {
      if (!SAFE_ID_RE.test(e.name) || live.has(e.name)) continue;
      const drop = await unlinkTree(path.join(toolRoot, e.name));
      bytes += drop.bytes;
      removed += drop.removed;
      continue;
    }
    if (e.isFile()) rootFiles.push(e.name);
  }

  if (rootFiles.length > 0) {
    const referenced = referencedToolImages(store, live);
    for (const name of rootFiles) {
      if (referenced.has(name)) continue;
      const drop = await unlinkTree(path.join(toolRoot, name));
      bytes += drop.bytes;
      removed += drop.removed;
    }
  }

  const remaining = [
    ...(await listFilesRecursive(toolRoot)),
    ...(await listFilesRecursive(attachRoot)),
  ];
  let total = 0;
  for (const f of remaining) total += f.size;
  if (total <= maxBytes) return { removed, bytes };

  remaining.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  for (const f of remaining) {
    if (total <= maxBytes) break;
    const drop = await unlinkTree(f.path);
    if (drop.removed === 0) continue;
    total -= drop.bytes;
    bytes += drop.bytes;
    removed += drop.removed;
  }

  return { removed, bytes };
}

/**
 * Retention-style wrapper: never throws.
 * @param {{ userDataPath: string, store: object, maxBytes?: number }} opts
 * @returns {Promise<{ removed: number, bytes: number }>}
 */
async function scheduleImagePrune(opts) {
  try {
    return await pruneImageStores(opts);
  } catch (err) {
    console.warn("image prune:", err && err.message ? err.message : err);
    return { removed: 0, bytes: 0 };
  }
}

/**
 * Fire-and-forget from sync service paths (delete / archive / remove project).
 * @param {import("./store").Store} store
 * @returns {Promise<{ removed: number, bytes: number }>}
 */
function scheduleImagePruneFromStore(store) {
  const userDataPath = userDataPathFromStore(store);
  if (!userDataPath) return Promise.resolve({ removed: 0, bytes: 0 });
  return scheduleImagePrune({ store, userDataPath });
}

module.exports = {
  DEFAULT_MAX_BYTES,
  pruneImageStores,
  scheduleImagePrune,
  scheduleImagePruneFromStore,
  userDataPathFromStore,
};
