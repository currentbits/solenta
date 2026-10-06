"use strict";

/**
 * Helpers shared by the provider CLI session readers in cli-sessions-*.js:
 * path containment, injected-text filtering, content flattening, session-id
 * checks, and the absorb/commit path that appends imported turns to a thread.
 */

const path = require("node:path");
const { randomUUID } = require("node:crypto");

/**
 * @param {string} parent
 * @param {string} child
 */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Codex injects XML-wrapped user blobs (plugins, skills, env) into the
 * rollout. Those are not conversation turns.
 * @param {string} text
 */
function isInjectedUserText(text) {
  return /^<[a-zA-Z][\w-]*>/.test(text);
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (typeof part === "string") out += part;
    else if (part && typeof part === "object" && typeof part.text === "string") {
      out += part.text;
    }
  }
  return out;
}

/**
 * Append provider turns that are not already in the Solenta transcript.
 * Match by role+text occurrence count so reclaim is idempotent.
 *
 * @param {import("./store").Store} store
 * @param {string} threadId
 * @param {{ role: "user" | "assistant", text: string, createdAt: number }[]} turns
 * @returns {number} appended count
 */
function absorbTurns(store, threadId, turns) {
  if (!turns.length) return 0;
  /** @type {Map<string, number>} */
  const remaining = new Map();
  for (const msg of store.getMessages(threadId) || []) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const key = `${msg.role}\0${msg.text}`;
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  let appended = 0;
  for (const turn of turns) {
    const key = `${turn.role}\0${turn.text}`;
    const left = remaining.get(key) || 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      continue;
    }
    store.appendMessage(threadId, {
      id: randomUUID(),
      role: turn.role,
      text: turn.text,
      createdAt: turn.createdAt || Date.now(),
    });
    appended += 1;
  }
  return appended;
}

/**
 * Create a Solenta thread from parsed CLI turns, or absorb new turns into
 * the existing provider+sessionId thread. Re-import is the #433 sync path:
 * no second thread; occurrence-count match so already-imported turns stay.
 * Uses the import-path reader (sessionId scan), not reclaim's cwd lookup —
 * imported threads may live in a Solenta project whose path is not the
 * CLI session cwd.
 *
 * @param {import("./store").Store} store
 * @param {{
 *   existing?: object | null,
 *   projectId: string,
 *   provider: string,
 *   sessionId: string,
 *   turns: { role: "user" | "assistant", text: string, createdAt: number }[],
 *   defaultTitle: string,
 * }} opts
 */
function commitImportedTurns(store, opts) {
  const existing = opts.existing;
  const turns = opts.turns || [];
  if (existing) {
    const appended = absorbTurns(store, existing.id, turns);
    if (appended > 0) store.save();
    return store.getThread(existing.id) || existing;
  }
  const firstUser = turns.find((t) => t.role === "user");
  const titleLine = firstUser
    ? String(firstUser.text).split(/\r?\n/, 1)[0].trim()
    : "";
  const { createThread } = require("./services.js");
  const thread = createThread(store, {
    projectId: opts.projectId,
    title: titleLine || opts.defaultTitle,
    provider: opts.provider,
    projectDefaults: false,
  });
  store.updateThread(thread.id, { sessionId: opts.sessionId });
  absorbTurns(store, thread.id, turns);
  store.save();
  return store.getThread(thread.id);
}

function isPathSafeSessionId(sessionId) {
  return /^[0-9a-zA-Z-]+$/.test(String(sessionId || ""));
}

module.exports = {
  isInside,
  isInjectedUserText,
  contentText,
  absorbTurns,
  commitImportedTurns,
  isPathSafeSessionId,
};
