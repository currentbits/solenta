"use strict";

/**
 * Shared per-repo code index (issue #377).
 *
 * ONE index per repo, keyed on the project's main checkout, read by every
 * thread — including threads running in worktrees, which do NOT get their own
 * index. Each worktree re-deriving the same map by grep is exactly the cost
 * this exists to remove.
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

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { gitTryAsync } = require("./worktrees.js");

/**
 * Bump when the on-disk shape or the extractor changes materially: readIndex
 * treats an older file as absent, so the next refresh rebuilds it.
 */
const INDEX_VERSION = 1;

/** A repo with fewer indexed files than this gets no note (nothing to orient). */
const MIN_FILES_FOR_NOTE = 20;

/** Per-repo floor between refreshes kicked off by maybeRefreshIndex. */
const REFRESH_MIN_INTERVAL_MS = 60_000;

const SOURCE_EXT = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".sh",
]);

// ponytail: 20k files; raise if a monorepo's tail starts mattering to agents
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SYMBOLS_PER_FILE = 60;

const JS_HEAD_RE =
  /^(?:export\s+(?:default\s+)?)?(?:(?:async\s+)?function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const JS_BIND_RE =
  /^(?:export\s+(?:default\s+)?)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=(.*)$/;
const PY_RE = /^(?:def|class)\s+([A-Za-z_][\w]*)/;
const GO_FUNC_RE = /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)/;
const GO_TYPE_RE = /^type\s+([A-Za-z_][\w]*)/;
const RS_RE = /^(?:pub\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_][\w]*)/;

/** @type {Map<string, { at: number, pending: Promise<unknown> | null }>} */
const refreshByRepo = new Map();

/**
 * Where this repo's index lives. Stable for a given repoRoot so every
 * worktree of that repo resolves to the same file.
 *
 * @param {string} userDataPath
 * @param {string} repoRoot
 * @returns {string}
 */
function indexPathFor(userDataPath, repoRoot) {
  const id = crypto
    .createHash("sha1")
    .update(String(repoRoot ?? ""))
    .digest("hex")
    .slice(0, 16);
  return path.join(String(userDataPath ?? ""), "codeindex", `${id}.json`);
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
  try {
    const raw = fs.readFileSync(indexPathFor(userDataPath, repoRoot), "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    if (data.version !== INDEX_VERSION) return null;
    if (!Array.isArray(data.files)) return null;
    return data;
  } catch {
    return null;
  }
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
  try {
    const userDataPath = opts && opts.userDataPath;
    const repoRoot = opts && opts.repoRoot;
    if (!userDataPath || !repoRoot) return null;

    const listed = await gitTryAsync(repoRoot, ["ls-files", "-z"], { raw: true });
    if (!listed.ok) return null;

    const prev = readIndex(userDataPath, repoRoot);
    /** @type {Map<string, IndexedFile>} */
    const prevByPath = new Map();
    if (prev) {
      for (const row of prev.files) {
        if (row && row.path) prevByPath.set(row.path, row);
      }
    }

    const rels = [];
    for (const raw of String(listed.stdout || "").split("\0")) {
      if (!raw) continue;
      const rel = raw.replace(/\\/g, "/");
      if (!SOURCE_EXT.has(extOf(rel))) continue;
      rels.push(rel);
      if (rels.length >= MAX_FILES) break;
    }

    const touches = await touchCounts(repoRoot);
    /** @type {IndexedFile[]} */
    const files = [];
    for (const rel of rels) {
      const abs = path.join(repoRoot, rel);
      let st;
      try {
        st = await fs.promises.stat(abs);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;

      const stored = prevByPath.get(rel);
      if (
        stored &&
        stored.mtimeMs === st.mtimeMs &&
        stored.size === st.size &&
        Array.isArray(stored.symbols)
      ) {
        files.push({
          path: rel,
          mtimeMs: st.mtimeMs,
          size: st.size,
          lines: stored.lines,
          symbols: stored.symbols,
          rank: touches.get(rel) || 0,
        });
        continue;
      }

      let text;
      try {
        text = await fs.promises.readFile(abs, "utf8");
      } catch {
        continue;
      }
      files.push({
        path: rel,
        mtimeMs: st.mtimeMs,
        size: st.size,
        lines: countLines(text),
        symbols: extractSymbols(text, extOf(rel)),
        rank: touches.get(rel) || 0,
      });
    }

    files.sort(
      (a, b) => b.rank - a.rank || b.symbols.length - a.symbols.length,
    );

    let symbolCount = 0;
    let lineCount = 0;
    for (const row of files) {
      symbolCount += row.symbols.length;
      lineCount += row.lines;
    }

    /** @type {CodeIndex} */
    const index = {
      version: INDEX_VERSION,
      repoRoot: path.resolve(repoRoot),
      updatedAt: Date.now(),
      fileCount: files.length,
      symbolCount,
      lineCount,
      files,
    };

    const dest = indexPathFor(userDataPath, repoRoot);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(index));
    await fs.promises.rename(tmp, dest);
    return index;
  } catch {
    return null;
  }
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
  try {
    if (process.env.CODER_CODEINDEX_DISABLE === "1") return;
    if (!opts || !opts.userDataPath || !opts.repoRoot) return;
    const key = opts.repoRoot;
    let slot = refreshByRepo.get(key);
    if (!slot) {
      slot = { at: 0, pending: null };
      refreshByRepo.set(key, slot);
    }
    if (slot.pending) return;
    if (Date.now() - slot.at < REFRESH_MIN_INTERVAL_MS) return;
    slot.pending = refreshIndex(opts)
      .catch(() => null)
      .finally(() => {
        slot.at = Date.now();
        slot.pending = null;
      });
  } catch {
    // dispatch path: never throw
  }
}

/**
 * @param {string} rel
 * @returns {string}
 */
function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i < 0 ? "" : base.slice(i).toLowerCase();
}

/**
 * @param {string} text
 * @returns {number}
 */
function countLines(text) {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") n++;
  if (text[text.length - 1] !== "\n") n++;
  return n;
}

/**
 * Top-level definition names, file order, capped.
 *
 * @param {string} text
 * @param {string} ext
 * @returns {string[]}
 */
function extractSymbols(text, ext) {
  const symbols = [];
  for (const line of text.split(/\r?\n/)) {
    const name = symbolOnLine(line, ext);
    if (!name) continue;
    symbols.push(name);
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  return symbols;
}

/**
 * @param {string} line
 * @param {string} ext
 * @returns {string}
 */
function symbolOnLine(line, ext) {
  if (ext === ".py") {
    const m = PY_RE.exec(line);
    return m ? m[1] : "";
  }
  if (ext === ".go") {
    const fn = GO_FUNC_RE.exec(line);
    if (fn) return fn[1];
    const ty = GO_TYPE_RE.exec(line);
    return ty ? ty[1] : "";
  }
  if (ext === ".rs") {
    const m = RS_RE.exec(line);
    return m ? m[1] : "";
  }
  const head = JS_HEAD_RE.exec(line);
  if (head) return head[1];
  const bind = JS_BIND_RE.exec(line);
  if (bind && (bind[2].includes("=>") || /\bfunction\b/.test(bind[2]))) {
    return bind[1];
  }
  return "";
}

/**
 * How many of the last 300 commits touched each path.
 *
 * @param {string} repoRoot
 * @returns {Promise<Map<string, number>>}
 */
async function touchCounts(repoRoot) {
  const log = await gitTryAsync(
    repoRoot,
    ["log", "--format=%h", "--name-only", "-n", "300"],
    { raw: true },
  );
  /** @type {Map<string, number>} */
  const counts = new Map();
  if (!log.ok) return counts;
  let expectHash = true;
  for (const line of String(log.stdout || "").split("\n")) {
    if (!line) {
      expectHash = true;
      continue;
    }
    if (expectHash) {
      expectHash = false;
      continue;
    }
    const rel = line.replace(/\\/g, "/");
    counts.set(rel, (counts.get(rel) || 0) + 1);
  }
  return counts;
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
