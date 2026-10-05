"use strict";

/**
 * Muse session reader (XDG_DATA_HOME/muse/sessions session.jsonl). See cli-sessions.js.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  isInside,
  isInjectedUserText,
  absorbTurns,
  isPathSafeSessionId,
} = require("./cli-sessions-shared.js");

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

module.exports = {
  resolveMuseHome,
  parseMuseJsonl,
  absorbMuseSessionTurns,
  listMuseSessions,
  importMuseSession,
};
