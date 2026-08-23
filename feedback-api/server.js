"use strict";
/**
 * Solenta feedback endpoint (issue #681).
 *
 * POST /api/feedback {text, version?, platform?} -> a row in postgres.
 * GET  /api/feedback (bearer ADMIN_TOKEN)        -> the newest rows as JSON.
 *
 * Postgres rather than a bucket or a log because Girder backs it up: losing
 * what someone took the trouble to write is the one failure that matters here.
 * Deployed as a Girder app; run with `node server.js`.
 *
 * We deliberately do NOT store the sender's IP. The rate limiter needs it in
 * memory for an hour; the record does not need it at all.
 */

const http = require("node:http");
const { timingSafeEqual } = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

/** Bigger than any honest bug report, small enough that a bot gains nothing. */
const MAX_BODY_BYTES = 8 * 1024;
const MAX_TEXT = 4000;
/** Per-IP submissions allowed per window. */
const RATE_MAX = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;
/** Read endpoint page size. */
const LIST_LIMIT = 200;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS feedback (
    id BIGSERIAL PRIMARY KEY,
    text TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

/**
 * Swapped wholesale in tests. The real one is installed by start().
 * @type {{ query: (sql: string, params?: unknown[]) => Promise<{rows: any[]}> } | null}
 */
let db = null;

/** @param {typeof db} next */
function setDb(next) {
  db = next;
}

/**
 * ponytail: in-memory, single instance. A restart forgives everyone and a
 * second replica doubles the allowance. Move to the shared redis service if
 * this ever gets abused enough to matter.
 * @type {Map<string, number[]>}
 */
const hits = new Map();

/** @param {string} ip */
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  // Bound the map: drop anyone whose window has fully expired.
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (!times.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(key);
    }
  }
  return false;
}

/**
 * Behind Traefik, so the socket address is the proxy. Trust the first
 * X-Forwarded-For hop and nothing else.
 * @param {import("node:http").IncomingMessage} req
 */
function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : String(fwd || "").split(",")[0];
  return first.trim() || req.socket.remoteAddress || "unknown";
}

/**
 * Constant-time bearer check, so the read endpoint cannot be brute-forced by
 * timing. An unset ADMIN_TOKEN denies everything rather than allowing it.
 * @param {import("node:http").IncomingMessage} req
 */
function authorized(req) {
  if (!ADMIN_TOKEN) return false;
  const header = String(req.headers.authorization || "");
  const offered = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(offered);
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Sentinel for a body over the cap, so the caller gets 413 and not 400. */
const TOO_LARGE = Symbol("too-large");

/**
 * Read at most MAX_BODY_BYTES. Resolves TOO_LARGE past the cap and null for
 * anything that is not JSON.
 *
 * Past the cap we pause instead of destroying: buffering stops either way, but
 * a destroyed socket cannot carry the 413 back and the client just sees a
 * dropped connection.
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.pause();
        resolve(TOO_LARGE);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

/** @param {import("node:http").ServerResponse} res */
function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    // The desktop app is not a browser origin, but the site might post later.
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
  });
  res.end(body);
}

/** @param {import("node:http").IncomingMessage} req */
async function handlePost(req, res) {
  if (rateLimited(clientIp(req))) {
    return send(res, 429, { error: "Too much feedback too fast. Try later." });
  }

  const body = await readJson(req);
  if (body === TOO_LARGE) {
    send(res, 413, { error: "Feedback is too long" });
    // The rest of the upload is unread; let the response flush, then drop it.
    res.on("finish", () => req.destroy());
    return;
  }
  if (!body || typeof body.text !== "string") {
    return send(res, 400, { error: "Expected JSON {text}" });
  }
  const text = body.text.trim().slice(0, MAX_TEXT);
  if (!text) return send(res, 400, { error: "Feedback is empty" });

  if (!db) {
    console.error("no database; dropped feedback:", text);
    return send(res, 503, { error: "Feedback is not configured yet" });
  }

  try {
    const { rows } = await db.query(
      "INSERT INTO feedback (text, version, platform) VALUES ($1, $2, $3) RETURNING id",
      [
        text,
        typeof body.version === "string" ? body.version.slice(0, 40) : "",
        typeof body.platform === "string" ? body.platform.slice(0, 40) : "",
      ],
    );
    // Also to the log, so `girder app_logs` shows feedback arriving live.
    console.log(`feedback #${rows[0].id}:`, text.replace(/\s+/g, " ").slice(0, 120));
    return send(res, 200, { ok: true, id: String(rows[0].id) });
  } catch (err) {
    // The text is in the log even when the insert fails, so nothing is lost.
    console.error("insert failed; feedback was:", text, err);
    return send(res, 502, { error: "Could not store your feedback" });
  }
}

async function handleList(req, res) {
  if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
  if (!db) return send(res, 503, { error: "no database" });
  try {
    const { rows } = await db.query(
      `SELECT id, text, version, platform, created_at
         FROM feedback ORDER BY id DESC LIMIT $1`,
      [LIST_LIMIT],
    );
    return send(res, 200, { count: rows.length, items: rows });
  } catch (err) {
    console.error("list failed", err);
    return send(res, 502, { error: "Could not read feedback" });
  }
}

const server = http.createServer(async (req, res) => {
  const path = String(req.url || "").split("?")[0];
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (path === "/health") return send(res, 200, { ok: true });
  if (path !== "/api/feedback") return send(res, 404, { error: "not found" });
  if (req.method === "POST") return handlePost(req, res);
  if (req.method === "GET") return handleList(req, res);
  return send(res, 405, { error: "use POST" });
});

/** Connect, ensure the table, then listen. */
async function start() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(SCHEMA);
    setDb(pool);
  } else {
    console.error("DATABASE_URL unset — POSTs will answer 503");
  }
  server.listen(PORT, () => console.log(`feedback-api on :${PORT}`));
}

if (require.main === module) {
  start().catch((err) => {
    console.error("boot failed", err);
    process.exit(1);
  });
}

module.exports = { server, setDb, rateLimited, authorized, RATE_MAX, SCHEMA };
