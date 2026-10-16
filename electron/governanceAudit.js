"use strict";

/**
 * Governance audit log (#262): append-only JSONL under userData, each line
 * HMAC-chained to the previous one so an edit, deletion or reorder is caught
 * by a local offline verify. Only main-process governance code appends; the
 * renderer and the agent can read (listAudit) and verify, never write.
 *
 *   hmac = HMAC-SHA256(key, canonicalJSON(entry) + "\n" + prev)
 *
 * `layer`, `decision` and `actionHash` sit inside the signed entry. The key is
 * 32 random bytes in governance-audit.key (0600), created once; it is never
 * rotated in place, so a missing key with existing entries fails verify.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { redactSecrets } = require("./guardrails.js");

const GENESIS = "0".repeat(64);
const RING = 50;
const FIELD_MAX = 500;
/** Enough tail for the last RING rows at ~1 KB each. */
const TAIL_BYTES = 256 * 1024;

/** Sorted-key JSON, no whitespace. */
function canonicalJSON(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJSON(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function sign(key, entry, prev) {
  return crypto
    .createHmac("sha256", key)
    .update(`${canonicalJSON(entry)}\n${prev}`)
    .digest("hex");
}

/** @param {string | null} s */
function scrub(s) {
  if (typeof s !== "string") return null;
  const r = redactSecrets(s);
  return r.length > FIELD_MAX ? `${r.slice(0, FIELD_MAX)}…` : r;
}

/** @param {any} call */
function scrubCall(call) {
  if (!call) return null;
  return {
    tool: String(call.tool || ""),
    command: scrub(call.command),
    path: scrub(call.path),
    hosts: Array.isArray(call.hosts) ? call.hosts.map(String) : [],
  };
}

/** Renderer DTO: no hmac, no prev. */
function toListEntry(row) {
  const { hmac: _h, prev: _p, ...rest } = row;
  return rest;
}

/**
 * @param {{ dir: string, log?: (msg: string) => void }} opts
 */
function createAudit(opts) {
  const logPath = path.join(opts.dir, "governance-audit.jsonl");
  const keyPath = path.join(opts.dir, "governance-audit.key");
  const warn = opts.log || ((msg) => console.warn(msg));
  /** @type {{ seq: number, prev: string, ring: object[] } | null} */
  let state = null;
  /** @type {Buffer | null} */
  let key = null;

  function fileSize() {
    try {
      return fs.statSync(logPath).size;
    } catch {
      return 0;
    }
  }

  function readKey() {
    try {
      return fs.readFileSync(keyPath);
    } catch {
      return null;
    }
  }

  /** Last rows from the tail of the file; never reads the whole log. */
  function load() {
    const size = fileSize();
    if (size === 0) return { seq: 0, prev: GENESIS, ring: [] };
    const fd = fs.openSync(logPath, "r");
    let text;
    try {
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    const lines = text.split("\n").filter(Boolean);
    if (size > TAIL_BYTES) lines.shift(); // first line is likely cut
    const rows = [];
    for (const line of lines) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* a torn line: verify reports it */
      }
    }
    const last = rows[rows.length - 1];
    if (!last || typeof last.seq !== "number" || typeof last.hmac !== "string") {
      throw new Error("governance audit tail is unreadable");
    }
    return { seq: last.seq, prev: last.hmac, ring: rows.slice(-RING) };
  }

  function ensureKey() {
    if (key) return key;
    key = readKey();
    if (key) return key;
    if (fileSize() > 0) {
      // Never rotate under existing entries: that would launder history.
      throw new Error("governance audit key is missing; entries exist");
    }
    fs.mkdirSync(opts.dir, { recursive: true });
    const fresh = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, fresh, { mode: 0o600, flag: "wx" });
    key = fresh;
    return key;
  }

  /**
   * Append one decision. Returns the stored row, or null when the write
   * failed (logged). Callers never skip a deny because of this.
   * @param {{
   *   threadId: string, profileId: string | null, provider: string,
   *   toolName: string, actionHash: string, declared: object,
   *   executed: object | null, decision: string, layer: string,
   *   rule: string | null, reason: string,
   * }} e
   */
  function append(e) {
    try {
      const k = ensureKey();
      if (!state) state = load();
      const entry = {
        v: 1,
        seq: state.seq + 1,
        ts: Date.now(),
        prev: state.prev,
        threadId: String(e.threadId || ""),
        profileId: e.profileId || null,
        provider: String(e.provider || ""),
        toolName: String(e.toolName || ""),
        actionHash: String(e.actionHash || ""),
        declared: scrubCall(e.declared),
        executed: scrubCall(e.executed),
        decision: e.decision,
        layer: String(e.layer || ""),
        rule: e.rule == null ? null : String(e.rule),
        reason: scrub(String(e.reason || "")) || "",
      };
      const hmac = sign(k, entry, entry.prev);
      const row = { ...entry, hmac };
      fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      state.seq = entry.seq;
      state.prev = hmac;
      state.ring.push(row);
      if (state.ring.length > RING) state.ring.shift();
      return row;
    } catch (err) {
      warn(
        `governance audit: append failed: ${err && err.message ? err.message : err}`,
      );
      return null;
    }
  }

  /** @param {{ threadId?: string, limit?: number }} [input] */
  function list(input) {
    if (!state) {
      try {
        state = load();
      } catch {
        return [];
      }
    }
    const limit = Math.max(1, Math.min(RING, Number(input && input.limit) || RING));
    const threadId = input && input.threadId;
    return state.ring
      .filter((r) => !threadId || r.threadId === threadId)
      .slice(-limit)
      .reverse()
      .map(toListEntry);
  }

  /** Walk the whole file; first bad link fails. */
  function verify() {
    let text;
    try {
      text = fs.readFileSync(logPath, "utf8");
    } catch {
      return { ok: true, entries: 0 };
    }
    const lines = text.split("\n").filter(Boolean);
    if (lines.length === 0) return { ok: true, entries: 0 };
    const k = readKey();
    if (!k) return { ok: false, reason: "missing key" };
    let prev = GENESIS;
    for (let i = 0; i < lines.length; i++) {
      const seq = i + 1;
      let row;
      try {
        row = JSON.parse(lines[i]);
      } catch {
        return { ok: false, seq, reason: "unparseable line" };
      }
      const { hmac, ...entry } = row || {};
      if (entry.seq !== seq) return { ok: false, seq, reason: "sequence gap" };
      if (entry.prev !== prev) return { ok: false, seq, reason: "broken link" };
      if (typeof hmac !== "string" || sign(k, entry, prev) !== hmac) {
        return { ok: false, seq, reason: "hmac mismatch" };
      }
      prev = hmac;
    }
    return { ok: true, entries: lines.length };
  }

  return { append, list, verify, logPath, keyPath };
}

/** @type {ReturnType<typeof createAudit> | null} */
let defaultAudit = null;

/** Called once from main.js after userData is known. */
function configureGovernanceAudit(opts) {
  defaultAudit = opts && opts.dir ? createAudit(opts) : null;
}

/** No-op (null) until configured: tests and headless paths have no userData. */
function appendAudit(e) {
  return defaultAudit ? defaultAudit.append(e) : null;
}

function listAudit(input) {
  return defaultAudit ? defaultAudit.list(input) : [];
}

function verifyAudit() {
  return defaultAudit ? defaultAudit.verify() : { ok: true, entries: 0 };
}

module.exports = {
  canonicalJSON,
  createAudit,
  configureGovernanceAudit,
  appendAudit,
  listAudit,
  verifyAudit,
};
