"use strict";

/**
 * Review itinerary extras (issue #421): finishing-agent annotation file,
 * code-index symbols for the reuse scan, and accepted-hunk hashes.
 */

const fs = require("node:fs");
const path = require("node:path");

const REVIEW_ITINERARY_FILE = ".solenta/review-itinerary.json";
const REVIEW_ACCEPTED_MAX = 500;
const SYMBOLS_MAX = 4000;

const REVIEW_ITINERARY_NOTE =
  "\n\n[Review itinerary] Before you finish a turn that changes files, write " +
  "`.solenta/review-itinerary.json` annotating your own diff: the order a " +
  "reviewer should read (never alphabetical), rationale per functional chunk, " +
  "and risks you found while annotating. Authors catch their own bugs while " +
  "annotating. Shape: {\"version\":1,\"readOrder\":[\"ci-config\"|\"tests\"|\"critical\"|\"impl\"|\"docs\"],\"chunks\":[{\"area\",\"rationale\",\"risks\":[]}],\"risks\":[]}.";

/**
 * Standing note on coding threads. Empty when the thread has no worktree
 * (nothing to annotate).
 *
 * @param {{ worktreePath?: string | null, pendingWorktree?: boolean } | null | undefined} thread
 * @returns {string}
 */
function reviewItineraryNoteFor(thread) {
  if (!thread) return "";
  if (!thread.worktreePath && !thread.pendingWorktree) return "";
  return REVIEW_ITINERARY_NOTE;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeAcceptedHunks(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const h of value) {
    const s = String(h || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= REVIEW_ACCEPTED_MAX) break;
  }
  return out;
}

/**
 * @param {string | null | undefined} cwd
 * @returns {object | null}
 */
function readAnnotation(cwd) {
  if (!cwd) return null;
  try {
    const file = path.join(String(cwd), REVIEW_ITINERARY_FILE);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * @param {{ files?: Array<{ path?: string, symbols?: string[] }> } | null | undefined} index
 * @returns {Array<{ name: string, path: string }>}
 */
function flattenSymbols(index) {
  if (!index || !Array.isArray(index.files)) return [];
  const out = [];
  for (const file of index.files) {
    if (!file || !file.path || !Array.isArray(file.symbols)) continue;
    for (const name of file.symbols) {
      if (!name) continue;
      out.push({ name: String(name), path: String(file.path) });
      if (out.length >= SYMBOLS_MAX) return out;
    }
  }
  return out;
}

/**
 * @param {{ store: { getThread: Function, getProject: Function }, threadId: string, userDataPath?: string }} opts
 */
function loadReviewContext(opts) {
  const { store, threadId, userDataPath } = opts;
  const thread = store.getThread(threadId);
  if (!thread) throw new Error(`Unknown thread: ${threadId}`);
  const project = store.getProject(thread.projectId);
  if (!project) throw new Error(`Unknown project for thread: ${threadId}`);
  const cwd = project.remoteHost
    ? project.remotePath || project.path
    : thread.worktreePath || project.path;
  const annotation = project.remoteHost ? null : readAnnotation(cwd);
  let symbols = [];
  try {
    const { readIndex } = require("./codeindex.js");
    const repoRoot = project.path || "";
    if (userDataPath && repoRoot) {
      symbols = flattenSymbols(readIndex(userDataPath, repoRoot));
    }
  } catch {
    symbols = [];
  }
  return {
    annotation,
    symbols,
    acceptedHunks: normalizeAcceptedHunks(thread.reviewAcceptedHunks),
  };
}

/**
 * @param {{ updateThread: Function, getThread: Function }} store
 * @param {string} threadId
 * @param {unknown} hashes
 */
function setReviewAccepted(store, threadId, hashes) {
  const thread = store.getThread(threadId);
  if (!thread) throw new Error(`Unknown thread: ${threadId}`);
  return store.updateThread(threadId, {
    reviewAcceptedHunks: normalizeAcceptedHunks(hashes),
  });
}

module.exports = {
  REVIEW_ITINERARY_FILE,
  REVIEW_ITINERARY_NOTE,
  REVIEW_ACCEPTED_MAX,
  reviewItineraryNoteFor,
  normalizeAcceptedHunks,
  readAnnotation,
  flattenSymbols,
  loadReviewContext,
  setReviewAccepted,
};
