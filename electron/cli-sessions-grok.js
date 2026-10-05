"use strict";

/**
 * Grok CLI session reader (GROK_HOME/sessions chat_history). See cli-sessions.js.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { blake3Hex } = require("./blake3.js");
const {
  isInside,
  isInjectedUserText,
  contentText,
  absorbTurns,
  commitImportedTurns,
  isPathSafeSessionId,
} = require("./cli-sessions-shared.js");

const GROK_ENCODED_CWD_DIR_MAX_BYTES = 255;
/**
 * Grok's dirname slug: lowercase ascii alnum, other runs become one dash,
 * trim dashes, take `maxLen` chars. Empty after that becomes "workspace"
 * at the call site.
 * @param {string} input
 * @param {number} maxLen
 * @returns {string}
 */
function slugifyGrok(input, maxLen) {
  let result = "";
  let prevDash = false;
  for (const c of String(input).toLowerCase()) {
    if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) {
      result += c;
      prevDash = false;
    } else if (!prevDash) {
      result += "-";
      prevDash = true;
    }
  }
  const trimmed = result.replace(/^-+|-+$/g, "");
  return [...trimmed].slice(0, maxLen).join("");
}

/**
 * Grok stores sessions at `sessions/<encoded-cwd>/<id>/`.
 * Short cwds: encodeURIComponent (Grok's urlencoding crate, same for
 * typical Unix paths). When that exceeds 255 bytes, Grok uses
 * `{slugify(basename, 40)|workspace}-{blake3(cwd)[:16]}` and writes
 * the original path to a `.cwd` file. Direct path only: no sessions/ scan.
 * @param {string | null | undefined} cwd
 * @returns {string}
 */
function encodeGrokSessionDir(cwd) {
  const raw = String(cwd || "");
  if (!raw) return "";
  const encoded = encodeURIComponent(raw);
  if (Buffer.byteLength(encoded, "utf8") <= GROK_ENCODED_CWD_DIR_MAX_BYTES) {
    return encoded;
  }
  const leaf = path.basename(raw) || "workspace";
  const slug = slugifyGrok(leaf, 40) || "workspace";
  return `${slug}-${blake3Hex(raw).slice(0, 16)}`;
}

/**
 * @param {string | null | undefined} home
 * @returns {string}
 */
function resolveGrokHome(home) {
  if (home != null && String(home) !== "") return String(home);
  if (process.env.GROK_HOME) return process.env.GROK_HOME;
  return path.join(os.homedir(), ".grok");
}

/**
 * Direct path to chat_history.jsonl. No sessions/ scan.
 * @param {string} home
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {string | null}
 */
function findGrokSessionFile(home, cwd, sessionId) {
  const id = String(sessionId || "");
  if (!isPathSafeSessionId(id)) return null;
  const encoded = encodeGrokSessionDir(cwd);
  if (!encoded) return null;
  const file = path.join(
    String(home || ""),
    "sessions",
    encoded,
    id,
    "chat_history.jsonl",
  );
  try {
    fs.statSync(file);
    return file;
  } catch {
    return null;
  }
}

/**
 * Prefer <user_query> inner text; skip remaining XML-wrapped blobs.
 * @param {string} text
 * @returns {string}
 */
function grokUserText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const query = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (query) return query[1].trim();
  if (isInjectedUserText(raw)) return "";
  return raw;
}

/**
 * @param {string} text JSONL
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function parseGrokChatHistory(text) {
  /** @type {{ role: "user" | "assistant", text: string, createdAt: number }[]} */
  const turns = [];
  const raw = String(text || "");
  if (!raw) return turns;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || (obj.type !== "user" && obj.type !== "assistant")) continue;
    if (obj.synthetic_reason) continue;
    const role = obj.type === "assistant" ? "assistant" : "user";
    let textValue = contentText(obj.content).trim();
    if (role === "user") textValue = grokUserText(textValue);
    if (!textValue) continue;
    turns.push({ role, text: textValue, createdAt: 0 });
  }
  return turns;
}

/**
 * @param {string} home
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function readGrokSessionTurns(home, cwd, sessionId) {
  const file = findGrokSessionFile(home, cwd, sessionId);
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseGrokChatHistory(text);
}

/**
 * Walk `sessions/<encoded-cwd>/<sessionId>/chat_history.jsonl`. Does not
 * recurse past that depth. The walk cannot leave `sessions/`. Distinct
 * from findGrokSessionFile (reclaim, cwd+sessionId, no scan).
 *
 * @param {string | null | undefined} home
 * @param {(info: { sessionId: string, file: string, mtimeMs: number }) => void} onFile
 */
function walkGrokSessions(home, onFile) {
  const sessionsDir = path.resolve(resolveGrokHome(home), "sessions");
  let groups;
  try {
    groups = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const group of groups) {
    if (!group.isDirectory() && !group.isSymbolicLink()) continue;
    const groupDir = path.join(sessionsDir, group.name);
    if (!isInside(sessionsDir, groupDir)) continue;
    let ids;
    try {
      ids = fs.readdirSync(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of ids) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const sessionId = entry.name;
      if (!isPathSafeSessionId(sessionId)) continue;
      const file = path.join(groupDir, sessionId, "chat_history.jsonl");
      if (!isInside(sessionsDir, file)) continue;
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      onFile({ sessionId, file, mtimeMs: st.mtimeMs });
    }
  }
}

/**
 * List candidate Grok sessions under GROK_HOME/sessions.
 * Newest mtime wins when the same sessionId appears twice.
 *
 * @param {string | null | undefined} home
 * @returns {{ sessionId: string, mtimeMs: number }[]}
 */
function listGrokSessions(home) {
  /** @type {Map<string, { sessionId: string, mtimeMs: number }>} */
  const byId = new Map();
  walkGrokSessions(home, (info) => {
    const prev = byId.get(info.sessionId);
    if (!prev || info.mtimeMs >= prev.mtimeMs) {
      byId.set(info.sessionId, {
        sessionId: info.sessionId,
        mtimeMs: info.mtimeMs,
      });
    }
  });
  return [...byId.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Import scan: locate one sessionId chat_history.jsonl under sessions/.
 * Newest mtime wins. Distinct from findGrokSessionFile (reclaim).
 *
 * @param {string | null | undefined} home
 * @param {string} sessionId
 * @returns {string | null}
 */
function findGrokImportFile(home, sessionId) {
  const id = String(sessionId || "");
  if (!isPathSafeSessionId(id)) return null;
  let found = null;
  let foundMtime = -1;
  walkGrokSessions(home, (info) => {
    if (info.sessionId !== id) return;
    if (info.mtimeMs >= foundMtime) {
      found = info.file;
      foundMtime = info.mtimeMs;
    }
  });
  return found;
}

/**
 * @param {string | null | undefined} home
 * @param {string} sessionId
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function readGrokImportTurns(home, sessionId) {
  const file = findGrokImportFile(home, sessionId);
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseGrokChatHistory(text);
}

/**
 * Create a Solenta thread from one Grok chat_history.jsonl.
 * Idempotent on provider=grok + sessionId so re-import does not duplicate.
 * Re-import absorbs turns added on disk since the last import.
 * Does not copy ~/.grok and does not touch reclaim.
 *
 * @param {import("./store").Store} store
 * @param {{ sessionId: string, projectId: string, home?: string | null }} input
 */
function importGrokSession(store, input) {
  const sessionId = String((input && input.sessionId) || "");
  if (!isPathSafeSessionId(sessionId)) {
    throw new Error("Invalid Grok session id");
  }
  const projectId = input && input.projectId;
  if (!projectId) {
    throw new Error("projectId is required");
  }
  const home = resolveGrokHome(input && input.home);
  if (!findGrokImportFile(home, sessionId)) {
    throw new Error(`Grok session not found: ${sessionId}`);
  }
  const existing = (store.getThreads() || []).find(
    (t) => t && t.provider === "grok" && t.sessionId === sessionId,
  );
  return commitImportedTurns(store, {
    existing,
    projectId,
    provider: "grok",
    sessionId,
    turns: readGrokImportTurns(home, sessionId),
    defaultTitle: "Imported Grok session",
  });
}

/**
 * @param {import("./store").Store} store
 * @param {object} thread
 * @param {string} home
 * @param {string} cwd
 * @returns {number}
 */
function absorbGrokSessionTurns(store, thread, home, cwd) {
  if (!thread || thread.provider !== "grok") return 0;
  const sessionId = thread.sessionId;
  if (!sessionId) return 0;
  return absorbTurns(
    store,
    thread.id,
    readGrokSessionTurns(home, cwd, sessionId),
  );
}

module.exports = {
  encodeGrokSessionDir,
  resolveGrokHome,
  findGrokSessionFile,
  parseGrokChatHistory,
  readGrokSessionTurns,
  listGrokSessions,
  importGrokSession,
  absorbGrokSessionTurns,
};
