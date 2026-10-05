"use strict";

// Merge conflict detection, context, auto-resolution of generated artifacts, and conflict forecast.

const fs = require("node:fs");
const path = require("node:path");
const { GENERATED_MARKER } = require("./configDoctor.js");
// Legacy shared annotation. New threads write `.solenta/review-itinerary/<threadId>.json`
// (#621); this path only conflicts for in-flight branches still using it.
const { REVIEW_ITINERARY_FILE } = require("./reviewItinerary.js");
const { gitTry, splitLines, gitTryAsync } = require("./worktrees-git.js");
const { mergeBaseName, defaultBranchAsync } = require("./worktrees-branches.js");

const CONFLICT_MAX_FILES = 12;
const CONFLICT_MAX_FILE_BYTES = 16_000;
const CONFLICT_MAX_TOTAL_BYTES = 48_000;

/**
 * Paths with unmerged index entries (conflict markers on disk).
 * @param {string} cwd
 * @returns {string[]}
 */
function unmergedFiles(cwd) {
  const res = gitTry(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  if (!res.ok) return [];
  return splitLines(res.stdout);
}

/**
 * Unmerged paths that still carry conflict markers on disk. Editing the file
 * counts as resolved even without `git add` — the merge path stages with
 * `add -A` anyway, and requiring the stage would strand anyone resolving in an
 * editor.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
function unresolvedFiles(cwd) {
  return unmergedFiles(cwd).filter((file) => {
    try {
      return /^<{7}[ \t]/m.test(fs.readFileSync(path.join(cwd, file), "utf8"));
    } catch {
      // Binary or deleted (delete/modify): nothing to strip, let it through.
      return false;
    }
  });
}

/**
 * Conflict error carrying the file list. The MERGE_CONFLICT marker tells the
 * renderer to show a resolution block instead of a raw git dump (same trick as
 * WORKTREE_DIRTY).
 *
 * @param {string} headline
 * @param {string[]} files
 * @param {string|null} footer
 */
function conflictError(headline, files, footer) {
  const lines = [headline, ...files.map((f) => `  ${f}`)];
  if (footer) lines.push(footer);
  return new Error(`MERGE_CONFLICT:${lines.join("\n")}`);
}

/**
 * Unmerged worktree files plus capped on-disk snippets for the resolve
 * prompt (issue #163). The conflict is already replayed in the worktree;
 * this just reads it so the agent turn does not have to.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {number} [opts.maxFiles]
 * @param {number} [opts.maxFileBytes]
 * @param {number} [opts.maxTotalBytes]
 * @returns {{
 *   files: Array<{ path: string, content: string, truncated: boolean, binary: boolean }>,
 *   omitted: number,
 *   branch: string | null,
 *   baseBranch: string | null,
 * }}
 */
function conflictContext(opts) {
  const { store, threadId } = opts;
  const maxFiles =
    opts.maxFiles != null ? opts.maxFiles : CONFLICT_MAX_FILES;
  const maxFileBytes =
    opts.maxFileBytes != null ? opts.maxFileBytes : CONFLICT_MAX_FILE_BYTES;
  const maxTotalBytes =
    opts.maxTotalBytes != null ? opts.maxTotalBytes : CONFLICT_MAX_TOTAL_BYTES;

  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.worktreePath) {
    throw new Error(
      `Thread ${threadId} has no worktree; call setupWorktree first`,
    );
  }
  const project = store.getProject(thread.projectId);
  if (!project) {
    throw new Error(`Unknown project for thread: ${threadId}`);
  }

  const cwd = thread.worktreePath;
  const all = unmergedFiles(cwd);
  /** @type {Array<{ path: string, content: string, truncated: boolean, binary: boolean }>} */
  const files = [];
  let remaining = maxTotalBytes;
  for (const file of all) {
    if (files.length >= maxFiles || remaining <= 0) break;
    const cap = Math.min(maxFileBytes, remaining);
    const entry = readConflictFile(cwd, file, cap);
    files.push(entry);
    remaining -= entry.content.length;
  }
  let baseBranch = null;
  try {
    baseBranch = mergeBaseName(thread, project.path);
  } catch {
    baseBranch = null;
  }
  return {
    files,
    omitted: Math.max(0, all.length - files.length),
    branch: thread.branch || null,
    baseBranch,
  };
}

/**
 * @param {string} cwd
 * @param {string} file
 * @param {number} cap
 */
function readConflictFile(cwd, file, cap) {
  try {
    const raw = fs.readFileSync(path.join(cwd, file));
    if (raw.includes(0)) {
      return { path: file, content: "", truncated: false, binary: true };
    }
    let content = raw.toString("utf8");
    let truncated = false;
    if (cap >= 0 && content.length > cap) {
      content = content.slice(0, cap);
      truncated = true;
    }
    return { path: file, content, truncated, binary: false };
  } catch {
    return { path: file, content: "", truncated: false, binary: true };
  }
}

function parseItineraryJson(raw) {
  try {
    const value = JSON.parse(String(raw || ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Merge two review-itinerary JSON bodies. Dedupes chunks by `area` and
 * risks by text. Prefers ours for readOrder. Returns null if neither
 * side is valid JSON (caller should fall back).
 * @param {string} oursRaw
 * @param {string} theirsRaw
 * @returns {string | null}
 */
function combineReviewItineraries(oursRaw, theirsRaw) {
  const ours = parseItineraryJson(oursRaw);
  const theirs = parseItineraryJson(theirsRaw);
  if (!ours && !theirs) return null;
  if (!ours) {
    const t = String(theirsRaw || "");
    return t.endsWith("\n") ? t : `${t}\n`;
  }
  if (!theirs) {
    const o = String(oursRaw || "");
    return o.endsWith("\n") ? o : `${o}\n`;
  }
  const chunks = [];
  const seenArea = new Set();
  for (const chunk of [...(ours.chunks || []), ...(theirs.chunks || [])]) {
    if (!chunk || typeof chunk !== "object") continue;
    const area = String(chunk.area || "");
    if (area && seenArea.has(area)) continue;
    if (area) seenArea.add(area);
    chunks.push(chunk);
  }
  const risks = [];
  const seenRisk = new Set();
  for (const risk of [...(ours.risks || []), ...(theirs.risks || [])]) {
    const text = String(risk || "").trim();
    if (!text || seenRisk.has(text)) continue;
    seenRisk.add(text);
    risks.push(text);
  }
  const readOrder =
    Array.isArray(ours.readOrder) && ours.readOrder.length
      ? ours.readOrder
      : theirs.readOrder || ["critical", "impl", "tests", "docs"];
  return `${JSON.stringify({ version: 1, readOrder, chunks, risks }, null, 2)}\n`;
}

/** Combine both sides of the itinerary conflict onto disk. */
function resolveItineraryConflict(cwd) {
  const ours = gitTry(cwd, ["show", `:2:${REVIEW_ITINERARY_FILE}`]);
  const theirs = gitTry(cwd, ["show", `:3:${REVIEW_ITINERARY_FILE}`]);
  const combined = combineReviewItineraries(
    ours.ok ? ours.stdout : "",
    theirs.ok ? theirs.stdout : "",
  );
  if (!combined) {
    return gitTry(cwd, ["checkout", "--ours", "--", REVIEW_ITINERARY_FILE]).ok;
  }
  const dest = path.join(cwd, REVIEW_ITINERARY_FILE);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, combined, "utf8");
  return true;
}

/**
 * True when both sides of the conflict are config-doctor output (AGENTS.md /
 * CLAUDE.md / GEMINI.md regenerated from shared memory). Nobody hand-edits
 * those, and the marker is what tells a generated file from an authored one.
 * @param {string} cwd
 * @param {string} file
 */
function isGeneratedDocConflict(cwd, file) {
  return [":2:", ":3:"].every((stage) => {
    const side = gitTry(cwd, ["show", `${stage}${file}`]);
    return side.ok && side.stdout.includes(GENERATED_MARKER);
  });
}

/**
 * Resolve the conflicts in files the app itself writes: the legacy shared
 * review itinerary (in-flight branches) gets both sides combined, a generated
 * agent doc keeps ours (the next doctor run rewrites it from memory anyway).
 * Per-thread itineraries (#621) do not share a path, so they never land here.
 * Any other conflicted path is a real one and bails out. Returns true when
 * the index has no unmerged paths.
 *
 * @param {string} cwd
 * @returns {boolean}
 */
function autoResolveMergeArtifacts(cwd) {
  const files = unmergedFiles(cwd);
  if (!files.length) return false;
  for (const file of files) {
    if (file === REVIEW_ITINERARY_FILE) {
      if (!resolveItineraryConflict(cwd)) return false;
    } else if (isGeneratedDocConflict(cwd, file)) {
      if (!gitTry(cwd, ["checkout", "--ours", "--", file]).ok) return false;
    } else {
      return false;
    }
    if (!gitTry(cwd, ["add", "--", file]).ok) return false;
  }
  return unmergedFiles(cwd).length === 0;
}

/**
 * Per-checkpoint-pair shortstat for a thread worktree.
 * Checkpoint N diffs against N-1 (first checkpoint diffs against <sha>^).
 * Never throws: missing worktree / checkpoints / git failures return [].
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @returns {Promise<Array<{ sha: string, turn: number, files: number, additions: number, deletions: number }>>}
 */
// ponytail: 15s TTL per projectId. Ceiling: forecast can be stale for 15s
// after a thread edits. Invalidate on thread change instead of TTL if that
// lag matters.
const FORECAST_TTL_MS = 15_000;
/** @type {Map<string, { at: number, result: { pairs: Array<{ threadA: string, threadB: string, overlap: string[], conflicts: string[] }>, computedAt: number } }>} */
const forecastCache = new Map();

/**
 * Porcelain path from one `git status --porcelain` line. Renames use the
 * destination. Unparseable lines return null (never throw).
 * @param {string} line
 * @returns {string | null}
 */
function parsePorcelainPath(line) {
  if (!line || line.length < 4 || line[2] !== " ") return null;
  let rest = line.slice(3);
  const arrow = rest.indexOf(" -> ");
  if (arrow !== -1) rest = rest.slice(arrow + 4);
  rest = rest.trim();
  if (rest.length >= 2 && rest[0] === '"' && rest[rest.length - 1] === '"') {
    rest = rest.slice(1, -1);
  }
  return rest || null;
}

/**
 * Conflict forecast for a project (#249): which pairs of active worktree
 * threads have overlapping edits, and which of those would actually collide.
 * Never throws — a project without a repo returns no pairs.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.projectId
 * @returns {Promise<{ pairs: Array<{ threadA: string, threadB: string, overlap: string[], conflicts: string[] }>, computedAt: number }>}
 */
async function conflictForecast(opts) {
  try {
    const store = opts && opts.store;
    const projectId = opts && opts.projectId;
    if (!store || !projectId) return { pairs: [], computedAt: Date.now() };

    const hit = forecastCache.get(projectId);
    if (hit && Date.now() - hit.at < FORECAST_TTL_MS) return hit.result;

    const project = store.getProject(projectId);
    if (!project || !project.path) {
      return { pairs: [], computedAt: Date.now() };
    }

    const inside = await gitTryAsync(project.path, [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    if (!inside.ok || String(inside.stdout || "").trim() !== "true") {
      return { pairs: [], computedAt: Date.now() };
    }

    const { listThreads } = require("./services.js");
    const candidates = listThreads(store).filter(
      (t) =>
        t.projectId === projectId &&
        !t.archived &&
        t.branch &&
        t.worktreePath &&
        fs.existsSync(t.worktreePath),
    );
    if (candidates.length < 2) {
      const result = { pairs: [], computedAt: Date.now() };
      forecastCache.set(projectId, { at: Date.now(), result });
      return result;
    }

    const base = await defaultBranchAsync(project.path);
    /** @type {Map<string, Set<string>>} */
    const filesById = new Map();
    for (const t of candidates) {
      const files = new Set();
      const committed = await gitTryAsync(project.path, [
        "diff",
        "--name-only",
        `${base}...${t.branch}`,
      ]);
      if (committed.ok) {
        for (const line of String(committed.stdout || "").split("\n")) {
          const p = line.trim().replace(/^"|"$/g, "");
          if (p) files.add(p);
        }
      }
      const status = await gitTryAsync(
        t.worktreePath,
        ["status", "--porcelain"],
        { raw: true },
      );
      if (status.ok) {
        for (const line of String(status.stdout || "").split("\n")) {
          const p = parsePorcelainPath(line);
          if (p) files.add(p);
        }
      }
      filesById.set(t.id, files);
    }

    /** @type {Array<{ threadA: string, threadB: string, overlap: string[], conflicts: string[] }>} */
    const pairs = [];
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i];
        const b = candidates[j];
        const setA = filesById.get(a.id);
        const setB = filesById.get(b.id);
        const overlap = [];
        for (const p of setA) {
          if (setB.has(p)) overlap.push(p);
        }
        overlap.sort();
        if (!overlap.length) continue;

        const [threadA, threadB] =
          a.id < b.id ? [a, b] : [b, a];
        let conflicts = [];
        const merge = await gitTryAsync(
          project.path,
          [
            "merge-tree",
            "--write-tree",
            "--name-only",
            threadA.branch,
            threadB.branch,
          ],
          { raw: true },
        );
        const exit =
          merge.error && merge.error.code != null ? merge.error.code : 0;
        if (!merge.ok && exit === 1) {
          const known = new Set(overlap);
          const lines = String(merge.stdout || "").split("\n");
          for (let n = 1; n < lines.length; n++) {
            if (lines[n] === "") break;
            const p = lines[n].trim().replace(/^"|"$/g, "");
            if (p && known.has(p)) conflicts.push(p);
          }
          conflicts.sort();
        }

        pairs.push({
          threadA: threadA.id,
          threadB: threadB.id,
          overlap,
          conflicts,
        });
      }
    }
    pairs.sort(
      (p, q) =>
        p.threadA.localeCompare(q.threadA) ||
        p.threadB.localeCompare(q.threadB),
    );
    const result = { pairs, computedAt: Date.now() };
    forecastCache.set(projectId, { at: Date.now(), result });
    return result;
  } catch {
    return { pairs: [], computedAt: Date.now() };
  }
}

module.exports = {
  unmergedFiles,
  unresolvedFiles,
  conflictError,
  conflictContext,
  autoResolveMergeArtifacts,
  parsePorcelainPath,
  conflictForecast,
};
