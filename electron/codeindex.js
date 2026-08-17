"use strict";

/**
 * Shared per-repo code index (issue #377).
 *
 * ONE index per repo, keyed on the project's main checkout, read by every
 * thread — including threads running in worktrees, which do NOT get their own
 * index. Each worktree re-deriving the same map by grep is exactly the cost
 * this exists to remove.
 *
 * Contract only in this commit: two workers build against these signatures.
 *
 * ponytail: a JSON file, not SQLite, and a line-based extractor, not
 * tree-sitter. The whole index is read at once to build one note, so there is
 * no query to optimise and no native dep to package. Move to node:sqlite +
 * tree-sitter when per-symbol queries (find-references, #249 blast radius)
 * actually land.
 *
 * ponytail: refreshed from the dispatch path (debounced, async), not a file
 * watcher. Staleness ceiling is one refresh interval; add a watcher if the map
 * being a minute behind ever costs an agent something.
 *
 * @typedef {object} IndexedFile
 * @property {string} path - repo-relative, posix separators
 * @property {number} mtimeMs
 * @property {number} size - bytes, as stat reports
 * @property {number} lines
 * @property {string[]} symbols - top-level definition names, file order
 * @property {number} rank - higher is more central; ordering only, no unit
 *
 * @typedef {object} CodeIndex
 * @property {number} version - INDEX_VERSION it was written with
 * @property {string} repoRoot - absolute path of the main checkout
 * @property {number} updatedAt - epoch ms of the last refresh
 * @property {number} fileCount
 * @property {number} symbolCount
 * @property {number} lineCount
 * @property {IndexedFile[]} files - sorted by rank, descending
 */

/**
 * Bump when the on-disk shape or the extractor changes materially: readIndex
 * treats an older file as absent, so the next refresh rebuilds it.
 */
const INDEX_VERSION = 1;

/** A repo with fewer indexed files than this gets no note (nothing to orient). */
const MIN_FILES_FOR_NOTE = 20;

/** Per-repo floor between refreshes kicked off by maybeRefreshIndex. */
const REFRESH_MIN_INTERVAL_MS = 60_000;

/**
 * Where this repo's index lives. Stable for a given repoRoot so every
 * worktree of that repo resolves to the same file.
 *
 * @param {string} userDataPath
 * @param {string} repoRoot
 * @returns {string}
 */
function indexPathFor(userDataPath, repoRoot) {
  throw new Error("not implemented");
}

/**
 * Read the index off disk. Synchronous and cheap: it runs on the dispatch
 * path, so it must never scan the repo. null when the file is missing,
 * unreadable, malformed, or written by an older INDEX_VERSION.
 *
 * @param {string} userDataPath
 * @param {string} repoRoot
 * @returns {CodeIndex | null}
 */
function readIndex(userDataPath, repoRoot) {
  throw new Error("not implemented");
}

/**
 * Rebuild the index for one repo and write it. Incremental: a file whose
 * mtimeMs and size still match the stored row keeps its symbols instead of
 * being re-read; files that disappeared are dropped. Resolves to the index it
 * wrote, or null when repoRoot is not a usable git checkout.
 *
 * @param {{ userDataPath: string, repoRoot: string }} opts
 * @returns {Promise<CodeIndex | null>}
 */
async function refreshIndex(opts) {
  throw new Error("not implemented");
}

/**
 * Fire-and-forget refresh for the dispatch path. Debounced per repo to
 * REFRESH_MIN_INTERVAL_MS, never throws, never blocks the caller, and does
 * nothing when CODER_CODEINDEX_DISABLE=1.
 *
 * @param {{ userDataPath: string, repoRoot: string }} opts
 * @returns {void}
 */
function maybeRefreshIndex(opts) {
  throw new Error("not implemented");
}

module.exports = {
  INDEX_VERSION,
  MIN_FILES_FOR_NOTE,
  REFRESH_MIN_INTERVAL_MS,
  indexPathFor,
  readIndex,
  refreshIndex,
  maybeRefreshIndex,
};
