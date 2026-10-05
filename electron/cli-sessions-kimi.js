"use strict";

/**
 * Kimi Code session reader (KIMI_CODE_HOME/sessions wire.jsonl). See cli-sessions.js.
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
} = require("./cli-sessions-shared.js");

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

module.exports = {
  resolveKimiHome,
  parseKimiWire,
  absorbKimiSessionTurns,
  listKimiSessions,
  importKimiSession,
};
