"use strict";
/**
 * Solenta site analytics (issue #747).
 *
 * POST /e  {n,u,r,p?}  -> 204 always. Never stores IP.
 * GET  /   HTML dashboard (cookie or bearer ADMIN_TOKEN)
 * GET  /api/stats      JSON for the same payload
 *
 * Deployed as Girder app solenta-stats (stats.solenta.app).
 */

const http = require("node:http");
const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 2 * 1024;
const RATE_MAX = 60;
const RATE_WINDOW_MS = 60 * 1000;
const COOKIE = "solenta_stats";
const NAMES = new Set([
  "pageview",
  "Download",
  "Docs",
  "Changelog",
  "GitHub Repo",
  "GitHub Star",
  "All downloads",
]);
const ORIGINS = new Set(["https://solenta.app", "https://www.solenta.app"]);
const HOSTS = new Set(["solenta.app", "www.solenta.app"]);
const PLATFORMS = new Set(["mac", "win", "linux"]);
const BOT_UA = /bot|crawler|spider|preview|slurp|facebookexternalhit|embedly/i;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS salts (
    day DATE PRIMARY KEY,
    salt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT NOT NULL,
    path TEXT NOT NULL DEFAULT '',
    referrer TEXT NOT NULL DEFAULT '',
    visitor TEXT NOT NULL DEFAULT '',
    props JSONB NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
  CREATE INDEX IF NOT EXISTS events_name_ts ON events (name, ts);
`;

/** @type {{ query: (sql: string, params?: unknown[]) => Promise<{rows: any[]}> } | null} */
let db = null;
/** @type {() => number} */
let nowFn = () => Date.now();
/** @type {Map<string, number[]>} */
const hits = new Map();
/** @type {{ day: string, salt: string } | null} */
let saltCache = null;

/** @param {typeof db} next */
function setDb(next) {
  db = next;
}

/** @param {(() => number) | null} fn */
function setNow(fn) {
  nowFn = fn || (() => Date.now());
  saltCache = null;
}

function resetHits() {
  hits.clear();
}

function adminToken() {
  return process.env.ADMIN_TOKEN || "";
}

function json(res, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

function corsHeaders(req) {
  const origin = String(req.headers.origin || "");
  if (!ORIGINS.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST",
  };
}

function noContent(req, res) {
  res.writeHead(204, { "content-length": "0", ...corsHeaders(req) });
  res.end();
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : String(fwd || "").split(",")[0];
  return first.trim() || req.socket.remoteAddress || "unknown";
}

function rateLimited(ip) {
  const now = nowFn();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (!times.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(key);
    }
  }
  return false;
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function hashVisitor(ip, ua, salt) {
  return createHmac("sha256", Buffer.from(salt, "hex"))
    .update(`${ip}\n${ua}`)
    .digest("hex")
    .slice(0, 16);
}

async function saltForToday() {
  const day = utcDay(nowFn());
  if (saltCache && saltCache.day === day) return saltCache.salt;
  if (!db) throw new Error("no db");
  const found = await db.query("SELECT salt FROM salts WHERE day = $1", [day]);
  if (found.rows[0]) {
    saltCache = { day, salt: found.rows[0].salt };
    return saltCache.salt;
  }
  const salt = randomBytes(32).toString("hex");
  try {
    await db.query("INSERT INTO salts (day, salt) VALUES ($1, $2)", [day, salt]);
    saltCache = { day, salt };
    return salt;
  } catch {
    const again = await db.query("SELECT salt FROM salts WHERE day = $1", [day]);
    saltCache = { day, salt: again.rows[0].salt };
    return saltCache.salt;
  }
}

function parsePath(u) {
  if (typeof u !== "string") return null;
  try {
    const url = new URL(u);
    if (url.protocol !== "https:") return null;
    if (!HOSTS.has(url.hostname)) return null;
    let p = url.pathname || "/";
    if (p === "/index.html") p = "/";
    return p.slice(0, 200);
  } catch {
    return null;
  }
}

function parseReferrer(r) {
  if (typeof r !== "string" || !r) return "";
  try {
    const host = new URL(r).hostname.toLowerCase();
    if (!host || HOSTS.has(host)) return "";
    return host.slice(0, 200);
  } catch {
    return "";
  }
}

const TOO_LARGE = Symbol("too-large");

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
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

async function handleEvent(req, res) {
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    console.log("drop: ratelimit");
    return noContent(req, res);
  }
  const ua = String(req.headers["user-agent"] || "");
  if (BOT_UA.test(ua)) {
    console.log("drop: bot");
    return noContent(req, res);
  }
  if (req.headers.dnt === "1" || req.headers["sec-gpc"] === "1") {
    console.log("drop: dnt");
    return noContent(req, res);
  }
  const body = await readBody(req);
  if (body === TOO_LARGE) {
    console.log("drop: size");
    res.on("finish", () => req.destroy());
    return noContent(req, res);
  }
  if (!body || typeof body !== "object") {
    console.log("drop: json");
    return noContent(req, res);
  }
  const name = typeof body.n === "string" ? body.n.slice(0, 40) : "";
  if (!NAMES.has(name)) {
    console.log("drop: name");
    return noContent(req, res);
  }
  const path = parsePath(body.u);
  if (!path) {
    console.log("drop: origin");
    return noContent(req, res);
  }
  const referrer = parseReferrer(body.r);
  let props = {};
  if (name !== "pageview" && body.p && typeof body.p === "object") {
    const platform = body.p.platform;
    if (PLATFORMS.has(platform)) props = { platform };
  }
  if (!db) {
    console.log("drop: db");
    return noContent(req, res);
  }
  try {
    const visitor = hashVisitor(ip, ua, await saltForToday());
    await db.query(
      "INSERT INTO events (name, path, referrer, visitor, props) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [name, path, referrer, visitor, JSON.stringify(props)],
    );
    console.log("event", name, path);
  } catch (err) {
    console.log("drop: db", err && err.message);
  }
  return noContent(req, res);
}

const server = http.createServer(async (req, res) => {
  const path = String(req.url || "").split("?")[0];
  if (path === "/health") return json(res, 200, { ok: true });
  if (path === "/e" && req.method === "OPTIONS") return noContent(req, res);
  if (path === "/e" && req.method === "POST") return handleEvent(req, res);
  res.writeHead(404);
  res.end();
});

async function start() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(SCHEMA);
    setDb(pool);
  } else {
    console.error("DATABASE_URL unset — POST /e will drop");
  }
  server.listen(PORT, () => console.log(`stats-api on :${PORT}`));
}

if (require.main === module) {
  start().catch((err) => {
    console.error("boot failed", err);
    process.exit(1);
  });
}

module.exports = {
  server,
  setDb,
  setNow,
  resetHits,
  hashVisitor,
  RATE_MAX,
  SCHEMA,
  COOKIE,
  adminToken,
  timingSafeEqual,
};
