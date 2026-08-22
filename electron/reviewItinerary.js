"use strict";

/**
 * Review itinerary extras (issue #421): finishing-agent annotation file,
 * code-index symbols for the reuse scan, and accepted-hunk hashes.
 */

const fs = require("node:fs");
const path = require("node:path");

const REVIEW_ITINERARY_FILE = ".solenta/review-itinerary.json";
const REVIEW_ITINERARY_DIR = ".solenta/review-itinerary";
const REVIEW_ACCEPTED_MAX = 500;
const SYMBOLS_MAX = 4000;

/**
 * @param {unknown} threadId
 * @returns {string}
 */
function sanitizeThreadId(threadId) {
  const id = String(threadId || "").trim();
  if (!id || id !== path.basename(id)) return "";
  if (id === "." || id === "..") return "";
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) return "";
  return id;
}

/**
 * Per-thread annotation path (#621). Empty when the id is missing or unsafe.
 * @param {unknown} threadId
 * @returns {string}
 */
function reviewItineraryPathFor(threadId) {
  const id = sanitizeThreadId(threadId);
  if (!id) return "";
  return `${REVIEW_ITINERARY_DIR}/${id}.json`;
}

/**
 * @param {string} relPath
 * @returns {string}
 */
function reviewItineraryNoteText(relPath) {
  return (
    "\n\n[Review itinerary] Before you finish a turn that changes files, write " +
    "`" +
    relPath +
    "` annotating your own diff: the order a " +
    "reviewer should read (never alphabetical), rationale per functional chunk, " +
    "and risks you found while annotating. Authors catch their own bugs while " +
    "annotating. Shape: {\"version\":1,\"readOrder\":[\"ci-config\"|\"tests\"|\"critical\"|\"impl\"|\"docs\"],\"chunks\":[{\"area\",\"rationale\",\"risks\":[]}],\"risks\":[]}."
  );
}

const REVIEW_ITINERARY_NOTE = reviewItineraryNoteText;

/**
 * Standing note on coding threads. Empty when the thread has no worktree
 * (nothing to annotate) or no id (nowhere to write).
 *
 * @param {{ id?: string, worktreePath?: string | null, pendingWorktree?: boolean } | null | undefined} thread
 * @returns {string}
 */
function reviewItineraryNoteFor(thread) {
  if (!thread) return "";
  if (!thread.worktreePath && !thread.pendingWorktree) return "";
  const rel = reviewItineraryPathFor(thread.id);
  if (!rel) return "";
  return reviewItineraryNoteText(rel);
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
 * @param {string} file
 * @returns {object | null}
 */
function tryParseAnnotationFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Current thread's annotation, then the legacy flat file so in-flight
 * branches that still write `.solenta/review-itinerary.json` keep working.
 *
 * @param {string | null | undefined} cwd
 * @param {string | null | undefined} [threadId]
 * @returns {object | null}
 */
function readAnnotation(cwd, threadId) {
  if (!cwd) return null;
  const rel = reviewItineraryPathFor(threadId);
  if (rel) {
    const perThread = tryParseAnnotationFile(path.join(String(cwd), rel));
    if (perThread) return perThread;
  }
  return tryParseAnnotationFile(path.join(String(cwd), REVIEW_ITINERARY_FILE));
}

/**
 * @param {object[]} bodies
 * @returns {object | null}
 */
function concatAnnotations(bodies) {
  const chunks = [];
  const risks = [];
  const seenRisk = new Set();
  /** @type {string[]} */
  let readOrder = [];
  for (const raw of bodies) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (
      !readOrder.length &&
      Array.isArray(raw.readOrder) &&
      raw.readOrder.length
    ) {
      readOrder = raw.readOrder.map((x) => String(x || "")).filter(Boolean);
    }
    if (Array.isArray(raw.chunks)) {
      for (const chunk of raw.chunks) {
        if (!chunk || typeof chunk !== "object") continue;
        chunks.push(chunk);
      }
    }
    if (Array.isArray(raw.risks)) {
      for (const risk of raw.risks) {
        const text = String(risk || "").trim();
        if (!text || seenRisk.has(text)) continue;
        seenRisk.add(text);
        risks.push(text);
      }
    }
  }
  if (!chunks.length && !risks.length && !readOrder.length) return null;
  return { version: 1, readOrder, chunks, risks };
}

/**
 * Reviewer-facing: every per-thread file in the directory, plus the legacy
 * flat path. Chunks are concatenated (same `area` from two threads is kept).
 *
 * @param {string | null | undefined} cwd
 * @returns {object | null}
 */
function readAnnotations(cwd) {
  if (!cwd) return null;
  const files = [];
  const dir = path.join(String(cwd), REVIEW_ITINERARY_DIR);
  try {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      if (name !== path.basename(name)) continue;
      files.push(path.join(dir, name));
    }
  } catch {
    // missing directory
  }
  files.push(path.join(String(cwd), REVIEW_ITINERARY_FILE));
  const bodies = [];
  for (const file of files) {
    const parsed = tryParseAnnotationFile(file);
    if (parsed) bodies.push(parsed);
  }
  return concatAnnotations(bodies);
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
  const annotation = project.remoteHost ? null : readAnnotations(cwd);
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
  REVIEW_ITINERARY_DIR,
  REVIEW_ITINERARY_NOTE,
  REVIEW_ACCEPTED_MAX,
  reviewItineraryPathFor,
  reviewItineraryNoteFor,
  normalizeAcceptedHunks,
  readAnnotation,
  readAnnotations,
  flattenSymbols,
  loadReviewContext,
  setReviewAccepted,
};
