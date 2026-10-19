"use strict";

/**
 * Thrash detector (issue #391): spot an agent retrying the same failing fix.
 *
 * Pure tracker, no IO. The runner seam (runner-thrash.js) feeds it every
 * finished tool call and every verify failure and acts on a hit.
 *
 * An attempt is "the same command failed with the same error, and the agent
 * changed code since the last time it saw that". A re-run with no edit in
 * between is not a new attempt, and a different error is progress, so it
 * restarts the count.
 */

/** Identical failures (with an edit between each) before the detector fires. */
const THRASH_ATTEMPTS = 3;
/** ponytail: cap per thread so a long-lived thread cannot grow without bound. */
const MAX_KEYS = 50;
const MAX_SIGNATURE = 300;

// Same names guardrails.js WRITE_TOOLS and recap.js treat as file writes,
// plus Codex's file-change card ("Edit").
const EDIT_TOOL =
  /^(edit|multiedit|write|notebookedit|str_replace_editor|strreplace|search_replace|apply_patch|edit_file|write_file|create_file)$/i;

const ERROR_LINE =
  /error|fail|exception|cannot|can't|unable|not found|no such|denied|refused|undefined|expected|assert|panic|traceback|✗|✖/i;

function isEditTool(name) {
  return EDIT_TOOL.test(String(name || "").trim());
}

/**
 * What the tool was asked to do, minus the parts that vary between identical
 * retries (Claude's Bash `description`, whitespace).
 * @param {string} name
 * @param {unknown} input - pretty JSON (Claude, Cursor) or a bare command (Codex)
 */
function commandKey(name, input) {
  const raw = typeof input === "string" ? input : "";
  let what = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      what =
        parsed.command ?? parsed.cmd ?? parsed.file_path ?? parsed.path ?? raw;
      if (Array.isArray(what)) what = what.join(" ");
    }
  } catch {
    // bare command string
  }
  return `${String(name || "tool")}: ${String(what).replace(/\s+/g, " ").trim()}`;
}

/**
 * First few error-looking lines with the run-to-run noise (durations,
 * timestamps, ids) stripped. Paths and quoted names stay: "Cannot find
 * module 'a'" and "'b'" are different errors.
 * @param {unknown} text
 */
function failureSignature(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const errors = lines.filter((l) => ERROR_LINE.test(l)).slice(0, 3);
  const picked = errors.length ? errors : lines.slice(-1);
  return picked
    .join(" | ")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<ts>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds)\b/gi, "<dur>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\s+/g, " ")
    .slice(0, MAX_SIGNATURE);
}

/**
 * @typedef {{ key: string, signature: string, count: number }} ThrashHit
 */

function createThrashTracker() {
  /** @type {Map<string, { edits: number, keys: Map<string, { signature: string, count: number, mark: number }>, recovered: boolean }>} */
  const threads = new Map();

  function stateFor(threadId) {
    let s = threads.get(threadId);
    if (!s) {
      s = { edits: 0, keys: new Map(), recovered: false };
      threads.set(threadId, s);
    }
    return s;
  }

  return {
    noteEdit(threadId) {
      stateFor(threadId).edits++;
    },

    /** The command worked: whatever loop it was in is over. */
    noteOk(threadId, key) {
      const s = threads.get(threadId);
      if (s) s.keys.delete(key);
    },

    /**
     * @param {string} threadId
     * @param {string} key - commandKey(...) or "verify: <cmd>"
     * @param {unknown} text - tool output / verify log
     * @returns {ThrashHit | null}
     */
    noteFailure(threadId, key, text) {
      const s = stateFor(threadId);
      const signature = failureSignature(text);
      const prev = s.keys.get(key);
      if (!prev || prev.signature !== signature) {
        s.keys.delete(key); // re-insert so the oldest key is evicted first
        s.keys.set(key, { signature, count: 1, mark: s.edits });
        if (s.keys.size > MAX_KEYS) s.keys.delete(s.keys.keys().next().value);
        return null;
      }
      if (s.edits === prev.mark) return null;
      prev.count++;
      prev.mark = s.edits;
      if (prev.count < THRASH_ATTEMPTS) return null;
      s.keys.clear();
      return { key, signature, count: prev.count };
    },

    /** One automatic recovery per problem; see markRecovered / noteSuccess. */
    recovered(threadId) {
      return Boolean(threads.get(threadId)?.recovered);
    },
    markRecovered(threadId) {
      stateFor(threadId).recovered = true;
    },
    /** A turn landed green, so the next thrash is a new problem. */
    noteSuccess(threadId) {
      const s = threads.get(threadId);
      if (s) s.recovered = false;
    },
  };
}

module.exports = {
  THRASH_ATTEMPTS,
  isEditTool,
  commandKey,
  failureSignature,
  createThrashTracker,
};
