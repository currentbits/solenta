"use strict";

/**
 * Cursor agent session reader (~/.cursor/projects agent-transcripts). See cli-sessions.js.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  isInside,
  isInjectedUserText,
  contentText,
  absorbTurns,
  commitImportedTurns,
  isPathSafeSessionId,
} = require("./cli-sessions-shared.js");

/**
 * @param {string | null | undefined} home
 * @returns {string}
 */
function resolveCursorHome(home) {
  if (home != null && String(home) !== "") return String(home);
  if (process.env.CURSOR_HOME) return process.env.CURSOR_HOME;
  return path.join(os.homedir(), ".cursor");
}

/**
 * Prefer <user_query> inner text; skip remaining XML-wrapped blobs.
 * Cursor agent-transcripts wrap the prompt the same way Grok does.
 * @param {string} text
 * @returns {string}
 */
function cursorUserText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const query = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (query) return query[1].trim();
  if (isInjectedUserText(raw)) return "";
  return raw;
}

/**
 * Cursor CLI transcripts are JSONL at
 * `projects/<group>/agent-transcripts/<sessionId>/<sessionId>.jsonl`.
 * @param {string} text JSONL
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function parseCursorJsonl(text) {
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
    if (!obj || (obj.role !== "user" && obj.role !== "assistant")) continue;
    const message = obj.message;
    if (!message || typeof message !== "object") continue;
    const role = obj.role === "assistant" ? "assistant" : "user";
    let textValue = contentText(message.content).trim();
    if (role === "user") textValue = cursorUserText(textValue);
    if (!textValue) continue;
    if (role === "user" && isInjectedUserText(textValue)) continue;
    turns.push({ role, text: textValue, createdAt: 0 });
  }
  return turns;
}

/**
 * Walk `projects/<group>/agent-transcripts/<sessionId>/<sessionId>.jsonl`.
 * Does not recurse past that depth. The walk cannot leave `projects/`.
 *
 * @param {string | null | undefined} home
 * @param {(info: { sessionId: string, file: string, mtimeMs: number }) => void} onFile
 */
function walkCursorSessions(home, onFile) {
  const projectsDir = path.resolve(resolveCursorHome(home), "projects");
  let groups;
  try {
    groups = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const group of groups) {
    if (!group.isDirectory() && !group.isSymbolicLink()) continue;
    const groupDir = path.join(projectsDir, group.name);
    if (!isInside(projectsDir, groupDir)) continue;
    const transcriptsDir = path.join(groupDir, "agent-transcripts");
    if (!isInside(projectsDir, transcriptsDir)) continue;
    let ids;
    try {
      ids = fs.readdirSync(transcriptsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of ids) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const sessionId = entry.name;
      if (!isPathSafeSessionId(sessionId)) continue;
      const file = path.join(transcriptsDir, sessionId, `${sessionId}.jsonl`);
      if (!isInside(projectsDir, file)) continue;
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
 * List candidate Cursor sessions under CURSOR_HOME/projects.
 * Newest mtime wins when the same sessionId appears twice.
 *
 * @param {string | null | undefined} home
 * @returns {{ sessionId: string, mtimeMs: number }[]}
 */
function listCursorSessions(home) {
  /** @type {Map<string, { sessionId: string, mtimeMs: number }>} */
  const byId = new Map();
  walkCursorSessions(home, (info) => {
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
 * Locate one sessionId jsonl under projects/. Newest mtime wins.
 * Shared by import and reclaim; both scan by sessionId, not cwd.
 *
 * @param {string | null | undefined} home
 * @param {string} sessionId
 * @returns {string | null}
 */
function findCursorImportFile(home, sessionId) {
  const id = String(sessionId || "");
  if (!isPathSafeSessionId(id)) return null;
  let found = null;
  let foundMtime = -1;
  walkCursorSessions(home, (info) => {
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
function readCursorImportTurns(home, sessionId) {
  const file = findCursorImportFile(home, sessionId);
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseCursorJsonl(text);
}

/**
 * Create a Solenta thread from one Cursor agent-transcript jsonl.
 * Idempotent on provider=cursor + sessionId so re-import does not duplicate.
 * Re-import absorbs turns added on disk since the last import.
 * Does not copy ~/.cursor. Reclaim uses absorbCursorSessionTurns.
 *
 * @param {import("./store").Store} store
 * @param {{ sessionId: string, projectId: string, home?: string | null }} input
 */
function importCursorSession(store, input) {
  const sessionId = String((input && input.sessionId) || "");
  if (!isPathSafeSessionId(sessionId)) {
    throw new Error("Invalid Cursor session id");
  }
  const projectId = input && input.projectId;
  if (!projectId) {
    throw new Error("projectId is required");
  }
  const home = resolveCursorHome(input && input.home);
  if (!findCursorImportFile(home, sessionId)) {
    throw new Error(`Cursor session not found: ${sessionId}`);
  }
  const existing = (store.getThreads() || []).find(
    (t) => t && t.provider === "cursor" && t.sessionId === sessionId,
  );
  return commitImportedTurns(store, {
    existing,
    projectId,
    provider: "cursor",
    sessionId,
    turns: readCursorImportTurns(home, sessionId),
    defaultTitle: "Imported Cursor session",
  });
}

/**
 * Reclaim: re-read the Cursor jsonl by sessionId (import-path scan, not
 * cwd) and append turns that are not already in the Solenta transcript.
 *
 * @param {import("./store").Store} store
 * @param {object} thread
 * @param {string} home
 * @returns {number}
 */
function absorbCursorSessionTurns(store, thread, home) {
  if (!thread || thread.provider !== "cursor") return 0;
  const sessionId = thread.sessionId;
  if (!sessionId) return 0;
  return absorbTurns(store, thread.id, readCursorImportTurns(home, sessionId));
}

module.exports = {
  resolveCursorHome,
  parseCursorJsonl,
  listCursorSessions,
  importCursorSession,
  absorbCursorSessionTurns,
};
