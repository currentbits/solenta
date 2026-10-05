"use strict";

/**
 * Provider CLI session transcript reader.
 *
 * #433 / #972 / #970 / #975 / #976 import scans a sessions directory with this parser
 * (Codex: listCodexSessions / importCodexSession under CODEX_HOME/sessions;
 * Grok: listGrokSessions / importGrokSession under GROK_HOME/sessions;
 * Claude: listClaudeSessions / importClaudeSession under
 * CLAUDE_CONFIG_DIR/projects;
 * Cursor: listCursorSessions / importCursorSession under
 * ~/.cursor/projects/<group>/agent-transcripts/<id>/<id>.jsonl;
 * OpenCode: listOpenCodeSessions / importOpenCodeSession under
 * OPENCODE_HOME/opencode.db, default XDG_DATA_HOME/opencode. When the db
 * is missing or has no session table, walk the pre-1.14 JSON tree at
 * storage/session/<projectID>/<sessionID>.json plus message/ and part/;
 * Kimi: listKimiSessions / importKimiSession under
 * KIMI_CODE_HOME/sessions/<wd>/<id>/agents/main/wire.jsonl;
 * Muse: listMuseSessions / importMuseSession under
 * XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<id>/session.jsonl).
 * Re-import of the same provider+sessionId absorbs new turns (dedup sync)
 * instead of minting a second thread or returning a stale snapshot.
 * #554 reclaim points it at one known sessionId (Codex: date-tree suffix
 * match; Claude and Grok: direct cwd-encoded path, no directory scan;
 * Cursor and OpenCode: the same sessionId scan as import, not cwd;
 * Kimi and Muse: sessionId scan of wire.jsonl / session.jsonl, not cwd).
 * Claude import walks projects/<group>/<sessionId>.jsonl; reclaim still
 * uses cwd+sessionId only. Claude long cwds
 * use Claude Code 2.1.x's 200-char dash prefix plus abs(djb2).toString(36).
 * When that hashed dir misses, overflow lookup readdirs projects/ top-level
 * names that start with encoded.slice(0,200)+'-' and stats the known
 * sessionId jsonl (Claude Code 2.1.219 LM()) — not a walk of every project.
 * Claude Code 2.1.219 Nqe() realpaths cwd (GR: realpath then NFC) before
 * RA()/LM(); if RA(cwd) misses and GR(cwd) differs, retry that hashed name
 * and its overflow prefix siblings. After LM still misses, e4l lists git
 * worktrees of that cwd (porcelain, excluding cwd itself) and runs LM() +
 * jsonl stat in each. Grok long cwds use grok-build's slug+blake3 dirname.
 * Do not copy the provider store.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  isInside,
  isInjectedUserText,
  contentText,
  absorbTurns,
  commitImportedTurns,
  isPathSafeSessionId,
} = require("./cli-sessions-shared.js");
const {
  resolveCodexHome,
  findCodexSessionFile,
  parseCodexRollout,
  readCodexSessionTurns,
  listCodexSessions,
  importCodexSession,
  absorbCodexSessionTurns,
} = require("./cli-sessions-codex.js");
const {
  encodeClaudeProjectDir,
  resolveClaudeHome,
  findClaudeSessionFile,
  parseClaudeJsonl,
  readClaudeSessionTurns,
  listClaudeSessions,
  importClaudeSession,
  absorbClaudeSessionTurns,
} = require("./cli-sessions-claude.js");
const {
  encodeGrokSessionDir,
  resolveGrokHome,
  findGrokSessionFile,
  parseGrokChatHistory,
  readGrokSessionTurns,
  listGrokSessions,
  importGrokSession,
  absorbGrokSessionTurns,
} = require("./cli-sessions-grok.js");
const {
  resolveCursorHome,
  parseCursorJsonl,
  listCursorSessions,
  importCursorSession,
  absorbCursorSessionTurns,
} = require("./cli-sessions-cursor.js");

/**
 * OpenCode session ids are `ses_*` with letters, digits, `_`. Path-safe:
 * no slashes or `..`. Broader than isPathSafeSessionId (no underscore).
 * @param {string} sessionId
 */
function isOpenCodeSessionId(sessionId) {
  const id = String(sessionId || "");
  return id.length > 0 && /^[0-9A-Za-z_-]+$/.test(id);
}

/**
 * @param {string | null | undefined} home
 * @returns {string}
 */
function resolveOpenCodeHome(home) {
  if (home != null && String(home) !== "") return String(home);
  if (process.env.OPENCODE_HOME) return process.env.OPENCODE_HOME;
  const xdg =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "opencode");
}

/**
 * @param {string} dbPath
 * @returns {import("node:sqlite").DatabaseSync | null}
 */
function openOpenCodeDb(dbPath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return null;
  }
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} name
 */
function openCodeTableExists(db, name) {
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name);
  return Boolean(row);
}

/**
 * @param {import("node:sqlite").DatabaseSync | null} db
 */
function closeOpenCodeDb(db) {
  if (!db) return;
  try {
    db.close();
  } catch {
    // ignore
  }
}

/**
 * True when import should walk the pre-1.14 JSON tree instead of SQLite:
 * opencode.db is missing, is not a file, or has no session table.
 * A db file that exists but cannot be opened is not a fallback (avoids
 * double-counting leftover JSON next to a live locked db).
 *
 * @param {string} home
 */
function shouldUseOpenCodeJson(home) {
  const dbPath = path.join(home, "opencode.db");
  let st;
  try {
    st = fs.statSync(dbPath);
  } catch {
    return true;
  }
  if (!st.isFile()) return true;
  const db = openOpenCodeDb(dbPath);
  if (!db) return false;
  try {
    return !openCodeTableExists(db, "session");
  } finally {
    closeOpenCodeDb(db);
  }
}

/**
 * Walk `storage/session/<projectID>/<sessionID>.json`. The walk cannot
 * leave `storage/session`.
 *
 * @param {string} home
 * @param {(info: { sessionId: string, file: string, mtimeMs: number }) => void} onFile
 */
function walkOpenCodeJsonSessions(home, onFile) {
  const sessionRoot = path.resolve(String(home || ""), "storage", "session");
  let projects;
  try {
    projects = fs.readdirSync(sessionRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const project of projects) {
    if (!project.isDirectory() && !project.isSymbolicLink()) continue;
    if (!isOpenCodeSessionId(project.name)) continue;
    const projectDir = path.join(sessionRoot, project.name);
    if (!isInside(sessionRoot, projectDir)) continue;
    let names;
    try {
      names = fs.readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const sessionId = name.slice(0, -".json".length);
      if (!isOpenCodeSessionId(sessionId)) continue;
      const full = path.join(projectDir, name);
      if (!isInside(sessionRoot, full)) continue;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      let mtimeMs = st.mtimeMs;
      try {
        const raw = JSON.parse(fs.readFileSync(full, "utf8"));
        const updated = raw && raw.time && Number(raw.time.updated);
        if (Number.isFinite(updated) && updated > 0) mtimeMs = updated;
      } catch {
        // keep file mtime
      }
      onFile({ sessionId, file: full, mtimeMs });
    }
  }
}

/**
 * @param {string} home
 * @returns {{ sessionId: string, mtimeMs: number }[]}
 */
function listOpenCodeJsonSessions(home) {
  /** @type {Map<string, { sessionId: string, mtimeMs: number }>} */
  const byId = new Map();
  walkOpenCodeJsonSessions(home, (info) => {
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
 * Locate one sessionId JSON under storage/session/. Newest mtime wins.
 * Shared by import and reclaim.
 *
 * @param {string} home
 * @param {string} sessionId
 * @returns {string | null}
 */
function findOpenCodeJsonSessionFile(home, sessionId) {
  const id = String(sessionId || "");
  if (!isOpenCodeSessionId(id)) return null;
  let found = null;
  let foundMtime = -1;
  walkOpenCodeJsonSessions(home, (info) => {
    if (info.sessionId !== id) return;
    if (info.mtimeMs >= foundMtime) {
      found = info.file;
      foundMtime = info.mtimeMs;
    }
  });
  return found;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function openCodeJsonTime(value) {
  if (!value || typeof value !== "object") return 0;
  const created = Number(value.created);
  return Number.isFinite(created) ? created : 0;
}

/**
 * @param {string} dir
 * @param {string} bound
 * @returns {{ id: string, data: object, createdAt: number }[]}
 */
function readOpenCodeJsonDir(dir, bound) {
  if (!isInside(bound, dir)) return [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  /** @type {{ id: string, data: object, createdAt: number }[]} */
  const rows = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!isOpenCodeSessionId(id)) continue;
    const full = path.join(dir, name);
    if (!isInside(dir, full)) continue;
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    rows.push({
      id: typeof parsed.id === "string" && parsed.id ? parsed.id : id,
      data: parsed,
      createdAt: openCodeJsonTime(parsed.time) || st.mtimeMs,
    });
  }
  rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return rows;
}

/**
 * @param {string} home
 * @param {string} sessionId
 * @param {string} messageId
 */
function readOpenCodeJsonPartTexts(home, sessionId, messageId) {
  const storage = path.resolve(String(home || ""), "storage");
  const dirs = [
    path.join(storage, "part", messageId),
    path.join(storage, "part", sessionId, messageId),
  ];
  /** @type {{ id: string, data: object, createdAt: number }[]} */
  const parts = [];
  for (const dir of dirs) {
    parts.push(...readOpenCodeJsonDir(dir, storage));
  }
  parts.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const texts = [];
  for (const part of parts) {
    const text = openCodePartText(part.data);
    if (text) texts.push(text);
  }
  return texts;
}

/**
 * @param {string} home
 * @param {string} sessionId
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function readOpenCodeJsonTurns(home, sessionId) {
  const id = String(sessionId || "");
  if (!isOpenCodeSessionId(id)) return [];
  if (!findOpenCodeJsonSessionFile(home, id)) return [];
  const storage = path.resolve(String(home || ""), "storage");
  const msgDir = path.join(storage, "message", id);
  /** @type {{ role: "user" | "assistant", text: string, createdAt: number }[]} */
  const turns = [];
  for (const msg of readOpenCodeJsonDir(msgDir, storage)) {
    const role = msg.data.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = readOpenCodeJsonPartTexts(home, id, msg.id).join("\n").trim();
    if (!text) continue;
    turns.push({
      role,
      text,
      createdAt: msg.createdAt || 0,
    });
  }
  return turns;
}

/**
 * List candidate OpenCode sessions from OPENCODE_HOME/opencode.db.
 * Newest time_updated wins when the same sessionId appears twice.
 * Missing db or no session table → pre-1.14 JSON tree under storage/.
 * Does not copy ~/.opencode or ~/.local/share/opencode.
 *
 * @param {string | null | undefined} home
 * @returns {{ sessionId: string, mtimeMs: number }[]}
 */
function listOpenCodeSessions(home) {
  const resolved = resolveOpenCodeHome(home);
  if (shouldUseOpenCodeJson(resolved)) {
    return listOpenCodeJsonSessions(resolved);
  }
  const dbPath = path.join(resolved, "opencode.db");
  const db = openOpenCodeDb(dbPath);
  if (!db) return [];
  try {
    const rows = db.prepare("SELECT id, time_updated FROM session").all();
    /** @type {Map<string, { sessionId: string, mtimeMs: number }>} */
    const byId = new Map();
    for (const row of rows || []) {
      const sessionId = String(row.id || "");
      if (!isOpenCodeSessionId(sessionId)) continue;
      const mtimeMs = Number(row.time_updated) || 0;
      const prev = byId.get(sessionId);
      if (!prev || mtimeMs >= prev.mtimeMs) {
        byId.set(sessionId, { sessionId, mtimeMs });
      }
    }
    return [...byId.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
  } finally {
    closeOpenCodeDb(db);
  }
}

/**
 * @param {string | null | undefined} home
 * @param {string} sessionId
 */
function openCodeSessionExists(home, sessionId) {
  const id = String(sessionId || "");
  if (!isOpenCodeSessionId(id)) return false;
  const resolved = resolveOpenCodeHome(home);
  if (shouldUseOpenCodeJson(resolved)) {
    return Boolean(findOpenCodeJsonSessionFile(resolved, id));
  }
  const dbPath = path.join(resolved, "opencode.db");
  const db = openOpenCodeDb(dbPath);
  if (!db) return false;
  try {
    const row = db.prepare("SELECT 1 AS ok FROM session WHERE id = ?").get(id);
    return Boolean(row);
  } finally {
    closeOpenCodeDb(db);
  }
}

/**
 * @param {unknown} data
 * @returns {string}
 */
function openCodePartText(data) {
  if (!data || typeof data !== "object") return "";
  if (data.type !== "text") return "";
  return typeof data.text === "string" ? data.text.trim() : "";
}

/**
 * Read user/assistant text parts for one OpenCode sessionId.
 * Skips reasoning, tool, and step parts. Shared by import and reclaim.
 *
 * @param {string | null | undefined} home
 * @param {string} sessionId
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function readOpenCodeImportTurns(home, sessionId) {
  const id = String(sessionId || "");
  if (!isOpenCodeSessionId(id)) return [];
  const resolved = resolveOpenCodeHome(home);
  if (shouldUseOpenCodeJson(resolved)) {
    return readOpenCodeJsonTurns(resolved, id);
  }
  const dbPath = path.join(resolved, "opencode.db");
  const db = openOpenCodeDb(dbPath);
  if (!db) return [];
  try {
    if (
      !openCodeTableExists(db, "message") ||
      !openCodeTableExists(db, "part")
    ) {
      return [];
    }
    const messages = db
      .prepare(
        "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id",
      )
      .all(id);
    /** @type {{ role: "user" | "assistant", text: string, createdAt: number }[]} */
    const turns = [];
    for (const msg of messages || []) {
      let parsed;
      try {
        parsed = JSON.parse(String(msg.data || ""));
      } catch {
        continue;
      }
      const role = parsed && parsed.role;
      if (role !== "user" && role !== "assistant") continue;
      const parts = db
        .prepare(
          "SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id",
        )
        .all(msg.id);
      const texts = [];
      for (const part of parts || []) {
        let pdata;
        try {
          pdata = JSON.parse(String(part.data || ""));
        } catch {
          continue;
        }
        const text = openCodePartText(pdata);
        if (text) texts.push(text);
      }
      const text = texts.join("\n").trim();
      if (!text) continue;
      turns.push({
        role,
        text,
        createdAt: Number(msg.time_created) || 0,
      });
    }
    return turns;
  } finally {
    closeOpenCodeDb(db);
  }
}

/**
 * Create a Solenta thread from one OpenCode session row.
 * Idempotent on provider=opencode + sessionId so re-import does not duplicate.
 * Re-import absorbs turns added on disk since the last import.
 * Does not copy ~/.opencode or ~/.local/share/opencode.
 * Reclaim uses absorbOpenCodeSessionTurns.
 *
 * @param {import("./store").Store} store
 * @param {{ sessionId: string, projectId: string, home?: string | null }} input
 */
function importOpenCodeSession(store, input) {
  const sessionId = String((input && input.sessionId) || "");
  if (!isOpenCodeSessionId(sessionId)) {
    throw new Error("Invalid OpenCode session id");
  }
  const projectId = input && input.projectId;
  if (!projectId) {
    throw new Error("projectId is required");
  }
  const home = resolveOpenCodeHome(input && input.home);
  if (!openCodeSessionExists(home, sessionId)) {
    throw new Error(`OpenCode session not found: ${sessionId}`);
  }
  const existing = (store.getThreads() || []).find(
    (t) => t && t.provider === "opencode" && t.sessionId === sessionId,
  );
  return commitImportedTurns(store, {
    existing,
    projectId,
    provider: "opencode",
    sessionId,
    turns: readOpenCodeImportTurns(home, sessionId),
    defaultTitle: "Imported OpenCode session",
  });
}

/**
 * Reclaim: re-read the OpenCode session by sessionId (import-path reader,
 * sqlite or JSON fallback, not cwd) and append turns that are not already
 * in the Solenta transcript.
 *
 * @param {import("./store").Store} store
 * @param {object} thread
 * @param {string} home
 * @returns {number}
 */
function absorbOpenCodeSessionTurns(store, thread, home) {
  if (!thread || thread.provider !== "opencode") return 0;
  const sessionId = thread.sessionId;
  if (!sessionId) return 0;
  return absorbTurns(
    store,
    thread.id,
    readOpenCodeImportTurns(home, sessionId),
  );
}

/**
 * Kimi session ids are `session_<uuid>` (underscore). Path-safe: no
 * slashes or `..`. Broader than isPathSafeSessionId.
 * @param {string} sessionId
 */
function isKimiSessionId(sessionId) {
  const id = String(sessionId || "");
  return id.length > 0 && /^[0-9A-Za-z_-]+$/.test(id);
}

/**
 * @param {string | null | undefined} home
 * @returns {string}
 */
function resolveKimiHome(home) {
  if (home != null && String(home) !== "") return String(home);
  if (process.env.KIMI_CODE_HOME) return process.env.KIMI_CODE_HOME;
  return path.join(os.homedir(), ".kimi-code");
}

/**
 * @param {unknown} input
 * @returns {string}
 */
function kimiPromptText(input) {
  if (typeof input === "string") {
    const raw = input.trim();
    if (!raw) return "";
    try {
      return kimiPromptText(JSON.parse(raw));
    } catch {
      return raw;
    }
  }
  if (!Array.isArray(input)) return "";
  const parts = [];
  for (const part of input) {
    if (typeof part === "string") {
      if (part) parts.push(part);
      continue;
    }
    if (
      part &&
      typeof part === "object" &&
      part.type === "text" &&
      typeof part.text === "string"
    ) {
      parts.push(part.text);
    }
  }
  return parts.join("").trim();
}

/**
 * Kimi wire.jsonl: user `turn.prompt` (origin.kind user) and assistant
 * `context.append_loop_event` content.part type=text. Consecutive text
 * parts that share event.turnId (or, with no turnId, until the next
 * turn.prompt) join into one assistant turn so absorbTurns matches
 * Solenta's concatenated stream message. Skip think parts. Role-shaped
 * `{role, content}` lines are a fallback for older wires.
 *
 * @param {string} text JSONL
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function parseKimiWire(text) {
  /** @type {{ role: "user" | "assistant", text: string, createdAt: number }[]} */
  const turns = [];
  const raw = String(text || "");
  if (!raw) return turns;
  /** @type {{ text: string, createdAt: number, turnId: string | null } | null} */
  let pending = null;

  const flushPending = () => {
    if (!pending) return;
    const textValue = pending.text.trim();
    if (textValue) {
      turns.push({
        role: "assistant",
        text: textValue,
        createdAt: pending.createdAt,
      });
    }
    pending = null;
  };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const createdAt = Number(obj.time) || 0;
    if (obj.type === "turn.prompt") {
      flushPending();
      const origin = obj.origin;
      if (
        origin &&
        typeof origin === "object" &&
        origin.kind &&
        origin.kind !== "user"
      ) {
        continue;
      }
      const textValue = kimiPromptText(obj.input);
      if (!textValue) continue;
      if (isInjectedUserText(textValue)) continue;
      turns.push({ role: "user", text: textValue, createdAt });
      continue;
    }
    if (obj.type === "context.append_loop_event") {
      const ev = obj.event;
      if (!ev || typeof ev !== "object" || ev.type !== "content.part") {
        continue;
      }
      const part = ev.part;
      if (!part || typeof part !== "object" || part.type !== "text") continue;
      const piece = typeof part.text === "string" ? part.text : "";
      if (!piece) continue;
      const turnId = ev.turnId != null ? String(ev.turnId) : null;
      if (
        pending &&
        (pending.turnId == null || turnId == null || pending.turnId === turnId)
      ) {
        pending.text += piece;
        continue;
      }
      flushPending();
      pending = { text: piece, createdAt, turnId };
      continue;
    }
    if (obj.role === "user" || obj.role === "assistant") {
      flushPending();
      const textValue = contentText(obj.content).trim();
      if (!textValue) continue;
      if (obj.role === "user" && isInjectedUserText(textValue)) continue;
      turns.push({
        role: obj.role === "assistant" ? "assistant" : "user",
        text: textValue,
        createdAt,
      });
    }
  }
  flushPending();
  return turns;
}

/**
 * Locate one sessionId wire.jsonl under sessions/<wd>/<id>/agents/.
 * Prefer agents/main. Newest mtime wins. Shared by reclaim; scan by
 * sessionId, not cwd. Does not copy ~/.kimi-code.
 *
 * @param {string} home
 * @param {string} sessionId
 * @returns {string | null}
 */
function findKimiWireFile(home, sessionId) {
  const id = String(sessionId || "");
  if (!isKimiSessionId(id) || id === "cwd") return null;
  const sessionsDir = path.resolve(String(home || ""), "sessions");
  let wds;
  try {
    wds = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let found = null;
  let foundMtime = -1;
  let foundMain = false;
  for (const wd of wds) {
    if (!wd.isDirectory() && !wd.isSymbolicLink()) continue;
    const wdDir = path.join(sessionsDir, wd.name);
    if (!isInside(sessionsDir, wdDir)) continue;
    const agentsDir = path.join(wdDir, id, "agents");
    if (!isInside(sessionsDir, agentsDir)) continue;
    let agents;
    try {
      agents = fs.readdirSync(agentsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const agent of agents) {
      if (!agent.isDirectory() && !agent.isSymbolicLink()) continue;
      const wire = path.join(agentsDir, agent.name, "wire.jsonl");
      if (!isInside(sessionsDir, wire)) continue;
      let st;
      try {
        st = fs.statSync(wire);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const isMain = agent.name === "main";
      if (isMain) {
        if (!foundMain || st.mtimeMs >= foundMtime) {
          found = wire;
          foundMtime = st.mtimeMs;
          foundMain = true;
        }
      } else if (!foundMain && st.mtimeMs >= foundMtime) {
        found = wire;
        foundMtime = st.mtimeMs;
      }
    }
  }
  return found;
}

/**
 * @param {string | null | undefined} home
 * @param {string} sessionId
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function readKimiSessionTurns(home, sessionId) {
  const file = findKimiWireFile(resolveKimiHome(home), sessionId);
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseKimiWire(text);
}

/**
 * Reclaim: re-read the Kimi wire.jsonl by sessionId (not cwd) and append
 * turns that are not already in the Solenta transcript.
 *
 * @param {import("./store").Store} store
 * @param {object} thread
 * @param {string} home
 * @returns {number}
 */
function absorbKimiSessionTurns(store, thread, home) {
  if (!thread || thread.provider !== "kimi") return 0;
  const sessionId = thread.sessionId;
  if (!sessionId || sessionId === "cwd") return 0;
  return absorbTurns(store, thread.id, readKimiSessionTurns(home, sessionId));
}

/**
 * @param {string | null | undefined} home
 * @returns {string}
 */
function resolveMuseHome(home) {
  if (home != null && String(home) !== "") return String(home);
  const xdg =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "muse");
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function museRecordedAt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Live session.jsonl uses microseconds.
  return n > 1e14 ? Math.floor(n / 1000) : n;
}

/**
 * Muse session.jsonl: live files use runtime.session
 * event.kind started+prompt (user) and assistant_message_committed (assistant).
 * Echo/stream leftovers: turn.input.user and run.terminal.completed.
 * Skip run.output.delta (same snapshot as terminal).
 *
 * @param {string} text JSONL
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function parseMuseJsonl(text) {
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
    if (!obj || typeof obj !== "object") continue;
    const createdAt = museRecordedAt(obj.recorded_at);
    const type = obj.payload_type;
    const payload = obj.payload;
    if (type === "turn.input.user") {
      const prompt =
        payload && typeof payload.prompt === "string"
          ? payload.prompt.trim()
          : "";
      if (!prompt || isInjectedUserText(prompt)) continue;
      turns.push({ role: "user", text: prompt, createdAt });
      continue;
    }
    if (type === "run.terminal.completed") {
      const textValue =
        payload && typeof payload.text === "string"
          ? payload.text.trim()
          : "";
      if (!textValue) continue;
      turns.push({ role: "assistant", text: textValue, createdAt });
      continue;
    }
    if (type !== "runtime.session" || !payload || typeof payload !== "object") {
      continue;
    }
    const ev = payload.event;
    if (!ev || typeof ev !== "object") continue;
    if (ev.kind === "started" && typeof ev.prompt === "string") {
      const prompt = ev.prompt.trim();
      if (!prompt || isInjectedUserText(prompt)) continue;
      turns.push({ role: "user", text: prompt, createdAt });
      continue;
    }
    if (
      ev.kind === "assistant_message_committed" &&
      typeof ev.text === "string"
    ) {
      const textValue = ev.text.trim();
      if (!textValue) continue;
      turns.push({ role: "assistant", text: textValue, createdAt });
    }
  }
  return turns;
}

/**
 * Locate one sessionId session.jsonl under sessions/YYYY/MM/DD/<id>/.
 * Newest mtime wins. Scan by sessionId, not cwd. Does not copy the
 * XDG muse store. Never follows overlay dest.
 *
 * @param {string} home
 * @param {string} sessionId
 * @returns {string | null}
 */
function findMuseSessionFile(home, sessionId) {
  const id = String(sessionId || "");
  if (!isPathSafeSessionId(id)) return null;
  const sessionsDir = path.resolve(String(home || ""), "sessions");
  let years;
  try {
    years = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let found = null;
  let foundMtime = -1;
  for (const year of years) {
    if (!year.isDirectory() && !year.isSymbolicLink()) continue;
    if (!/^\d{4}$/.test(year.name)) continue;
    const yearDir = path.join(sessionsDir, year.name);
    if (!isInside(sessionsDir, yearDir)) continue;
    let months;
    try {
      months = fs.readdirSync(yearDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const month of months) {
      if (!month.isDirectory() && !month.isSymbolicLink()) continue;
      if (!/^(0[1-9]|1[0-2])$/.test(month.name)) continue;
      const monthDir = path.join(yearDir, month.name);
      if (!isInside(sessionsDir, monthDir)) continue;
      let days;
      try {
        days = fs.readdirSync(monthDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const day of days) {
        if (!day.isDirectory() && !day.isSymbolicLink()) continue;
        if (!/^(0[1-9]|[12]\d|3[01])$/.test(day.name)) continue;
        const file = path.join(monthDir, day.name, id, "session.jsonl");
        if (!isInside(sessionsDir, file)) continue;
        let st;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        if (st.mtimeMs >= foundMtime) {
          found = file;
          foundMtime = st.mtimeMs;
        }
      }
    }
  }
  return found;
}

/**
 * @param {string | null | undefined} home
 * @param {string} sessionId
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function readMuseSessionTurns(home, sessionId) {
  const file = findMuseSessionFile(resolveMuseHome(home), sessionId);
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseMuseJsonl(text);
}

/**
 * Reclaim: re-read the Muse session.jsonl by sessionId (date-sharded
 * scan, not cwd) and append turns that are not already in the Solenta
 * transcript.
 *
 * @param {import("./store").Store} store
 * @param {object} thread
 * @param {string} home
 * @returns {number}
 */
function absorbMuseSessionTurns(store, thread, home) {
  if (!thread || thread.provider !== "muse") return 0;
  const sessionId = thread.sessionId;
  if (!sessionId) return 0;
  return absorbTurns(store, thread.id, readMuseSessionTurns(home, sessionId));
}

/**
 * Walk `sessions/<wd>/<sessionId>/agents/main/wire.jsonl`. Does not
 * recurse into agent-0. The walk cannot leave `sessions/`.
 *
 * @param {string | null | undefined} home
 * @param {(info: { sessionId: string, file: string, mtimeMs: number }) => void} onFile
 */
function walkKimiSessions(home, onFile) {
  const sessionsDir = path.resolve(resolveKimiHome(home), "sessions");
  let wds;
  try {
    wds = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const wd of wds) {
    if (!wd.isDirectory() && !wd.isSymbolicLink()) continue;
    const wdDir = path.join(sessionsDir, wd.name);
    if (!isInside(sessionsDir, wdDir)) continue;
    let ids;
    try {
      ids = fs.readdirSync(wdDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of ids) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const sessionId = entry.name;
      if (!isKimiSessionId(sessionId) || sessionId === "cwd") continue;
      const file = path.join(
        wdDir,
        sessionId,
        "agents",
        "main",
        "wire.jsonl",
      );
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
 * List candidate Kimi sessions under KIMI_CODE_HOME/sessions.
 * Newest mtime wins when the same sessionId appears twice.
 *
 * @param {string | null | undefined} home
 * @returns {{ sessionId: string, mtimeMs: number }[]}
 */
function listKimiSessions(home) {
  /** @type {Map<string, { sessionId: string, mtimeMs: number }>} */
  const byId = new Map();
  walkKimiSessions(home, (info) => {
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
 * Create a Solenta thread from one Kimi main-agent wire.jsonl.
 * Idempotent on provider=kimi + sessionId so re-import does not duplicate.
 * Does not copy ~/.kimi-code. Does not absorb into an existing thread.
 *
 * @param {import("./store").Store} store
 * @param {{ sessionId: string, projectId: string, home?: string | null }} input
 */
function importKimiSession(store, input) {
  const sessionId = String((input && input.sessionId) || "");
  if (!isKimiSessionId(sessionId) || sessionId === "cwd") {
    throw new Error("Invalid Kimi session id");
  }
  const projectId = input && input.projectId;
  if (!projectId) {
    throw new Error("projectId is required");
  }
  const home = resolveKimiHome(input && input.home);
  if (!findKimiWireFile(home, sessionId)) {
    throw new Error(`Kimi session not found: ${sessionId}`);
  }
  const existing = (store.getThreads() || []).find(
    (t) => t && t.provider === "kimi" && t.sessionId === sessionId,
  );
  if (existing) return existing;

  const turns = readKimiSessionTurns(home, sessionId);
  const firstUser = turns.find((t) => t.role === "user");
  const titleLine = firstUser
    ? String(firstUser.text).split(/\r?\n/, 1)[0].trim()
    : "";
  const { createThread } = require("./services.js");
  const thread = createThread(store, {
    projectId,
    title: titleLine || "Imported Kimi session",
    provider: "kimi",
  });
  store.updateThread(thread.id, { sessionId });
  for (const turn of turns) {
    store.appendMessage(thread.id, {
      id: randomUUID(),
      role: turn.role,
      text: turn.text,
      createdAt: turn.createdAt || Date.now(),
    });
  }
  store.save();
  return store.getThread(thread.id);
}

/**
 * Walk `sessions/YYYY/MM/DD/<sessionId>/session.jsonl`. The walk cannot
 * leave `sessions/`. Overlay dest is not this home.
 *
 * @param {string | null | undefined} home
 * @param {(info: { sessionId: string, file: string, mtimeMs: number }) => void} onFile
 */
function walkMuseSessions(home, onFile) {
  const sessionsDir = path.resolve(resolveMuseHome(home), "sessions");
  let years;
  try {
    years = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const year of years) {
    if (!year.isDirectory() && !year.isSymbolicLink()) continue;
    if (!/^\d{4}$/.test(year.name)) continue;
    const yearDir = path.join(sessionsDir, year.name);
    if (!isInside(sessionsDir, yearDir)) continue;
    let months;
    try {
      months = fs.readdirSync(yearDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const month of months) {
      if (!month.isDirectory() && !month.isSymbolicLink()) continue;
      if (!/^(0[1-9]|1[0-2])$/.test(month.name)) continue;
      const monthDir = path.join(yearDir, month.name);
      if (!isInside(sessionsDir, monthDir)) continue;
      let days;
      try {
        days = fs.readdirSync(monthDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const day of days) {
        if (!day.isDirectory() && !day.isSymbolicLink()) continue;
        if (!/^(0[1-9]|[12]\d|3[01])$/.test(day.name)) continue;
        const dayDir = path.join(monthDir, day.name);
        if (!isInside(sessionsDir, dayDir)) continue;
        let ids;
        try {
          ids = fs.readdirSync(dayDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of ids) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          const sessionId = entry.name;
          if (!isPathSafeSessionId(sessionId)) continue;
          const file = path.join(dayDir, sessionId, "session.jsonl");
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
  }
}

/**
 * List candidate Muse sessions under XDG_DATA_HOME/muse/sessions.
 * Newest mtime wins when the same sessionId appears twice.
 *
 * @param {string | null | undefined} home
 * @returns {{ sessionId: string, mtimeMs: number }[]}
 */
function listMuseSessions(home) {
  /** @type {Map<string, { sessionId: string, mtimeMs: number }>} */
  const byId = new Map();
  walkMuseSessions(home, (info) => {
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
 * Create a Solenta thread from one Muse session.jsonl.
 * Idempotent on provider=muse + sessionId so re-import does not duplicate.
 * Does not copy the XDG muse store. Does not absorb into an existing thread.
 *
 * @param {import("./store").Store} store
 * @param {{ sessionId: string, projectId: string, home?: string | null }} input
 */
function importMuseSession(store, input) {
  const sessionId = String((input && input.sessionId) || "");
  if (!isPathSafeSessionId(sessionId)) {
    throw new Error("Invalid Muse session id");
  }
  const projectId = input && input.projectId;
  if (!projectId) {
    throw new Error("projectId is required");
  }
  const home = resolveMuseHome(input && input.home);
  if (!findMuseSessionFile(home, sessionId)) {
    throw new Error(`Muse session not found: ${sessionId}`);
  }
  const existing = (store.getThreads() || []).find(
    (t) => t && t.provider === "muse" && t.sessionId === sessionId,
  );
  if (existing) return existing;

  const turns = readMuseSessionTurns(home, sessionId);
  const firstUser = turns.find((t) => t.role === "user");
  const titleLine = firstUser
    ? String(firstUser.text).split(/\r?\n/, 1)[0].trim()
    : "";
  const { createThread } = require("./services.js");
  const thread = createThread(store, {
    projectId,
    title: titleLine || "Imported Muse session",
    provider: "muse",
  });
  store.updateThread(thread.id, { sessionId });
  for (const turn of turns) {
    store.appendMessage(thread.id, {
      id: randomUUID(),
      role: turn.role,
      text: turn.text,
      createdAt: turn.createdAt || Date.now(),
    });
  }
  store.save();
  return store.getThread(thread.id);
}

/**
 * Reclaim: re-read the known provider session and append outside turns.
 *
 * @param {import("./store").Store} store
 * @param {object} thread
 * @param {{ home?: string, cwd?: string }} [opts]
 * @returns {number}
 */
function absorbSessionTurns(store, thread, opts) {
  if (!thread) return 0;
  const home = opts && opts.home;
  const cwd = (opts && opts.cwd) || "";
  if (thread.provider === "codex") {
    return absorbCodexSessionTurns(store, thread, resolveCodexHome(home));
  }
  if (thread.provider === "claude") {
    return absorbClaudeSessionTurns(
      store,
      thread,
      resolveClaudeHome(home),
      cwd,
    );
  }
  if (thread.provider === "grok") {
    return absorbGrokSessionTurns(store, thread, resolveGrokHome(home), cwd);
  }
  if (thread.provider === "cursor") {
    return absorbCursorSessionTurns(store, thread, resolveCursorHome(home));
  }
  if (thread.provider === "opencode") {
    return absorbOpenCodeSessionTurns(
      store,
      thread,
      resolveOpenCodeHome(home),
    );
  }
  if (thread.provider === "kimi") {
    return absorbKimiSessionTurns(store, thread, resolveKimiHome(home));
  }
  if (thread.provider === "muse") {
    return absorbMuseSessionTurns(store, thread, resolveMuseHome(home));
  }
  return 0;
}

module.exports = {
  resolveCodexHome,
  findCodexSessionFile,
  parseCodexRollout,
  readCodexSessionTurns,
  listCodexSessions,
  importCodexSession,
  absorbCodexSessionTurns,
  resolveClaudeHome,
  encodeClaudeProjectDir,
  findClaudeSessionFile,
  parseClaudeJsonl,
  readClaudeSessionTurns,
  listClaudeSessions,
  importClaudeSession,
  absorbClaudeSessionTurns,
  resolveGrokHome,
  encodeGrokSessionDir,
  findGrokSessionFile,
  parseGrokChatHistory,
  readGrokSessionTurns,
  listGrokSessions,
  importGrokSession,
  absorbGrokSessionTurns,
  resolveCursorHome,
  parseCursorJsonl,
  listCursorSessions,
  importCursorSession,
  absorbCursorSessionTurns,
  resolveOpenCodeHome,
  listOpenCodeSessions,
  importOpenCodeSession,
  readOpenCodeImportTurns,
  absorbOpenCodeSessionTurns,
  parseKimiWire,
  listKimiSessions,
  importKimiSession,
  absorbKimiSessionTurns,
  parseMuseJsonl,
  listMuseSessions,
  importMuseSession,
  absorbMuseSessionTurns,
  absorbSessionTurns,
};
