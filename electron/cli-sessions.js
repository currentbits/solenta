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
const {
  resolveOpenCodeHome,
  listOpenCodeSessions,
  readOpenCodeImportTurns,
  importOpenCodeSession,
  absorbOpenCodeSessionTurns,
} = require("./cli-sessions-opencode.js");

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
