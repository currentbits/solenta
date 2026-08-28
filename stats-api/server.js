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

function tokensEqual(offered) {
  const token = adminToken();
  if (!token) return false;
  const a = Buffer.from(String(offered || ""));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieToken(req) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function authorized(req) {
  const header = String(req.headers.authorization || "");
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  return tokensEqual(bearer) || tokensEqual(cookieToken(req));
}

function cookieHeader(value, maxAge) {
  return `${COOKIE}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
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

async function readRaw(req) {
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
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

function loginForm() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Solenta stats</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { --paper:#f5f5f2; --ink:#191918; --accent:#f2e51f; }
html,body { background:var(--paper); color:var(--ink); font: 16px/1.4 system-ui, sans-serif; }
main { max-width: 28rem; margin: 12vh auto; padding: 0 1.5rem; }
label { display:block; margin-bottom:.5rem; }
input, button { font: inherit; }
input { width: 100%; padding: .5rem .6rem; }
button { margin-top: 1rem; background: var(--accent); border: 0; padding: .5rem 1rem; cursor: pointer; }
</style></head>
<body><main>
<form method="post" action="/login">
<label>Password <input type="password" name="password" autofocus></label>
<button type="submit">View stats</button>
</form>
</main></body></html>`;
}

function sendHtml(res, status, html, extra = {}) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    ...extra,
  });
  res.end(html);
}

async function handleLogin(req, res) {
  const raw = await readRaw(req);
  if (raw === TOO_LARGE) return sendHtml(res, 401, loginForm());
  const params = new URLSearchParams(String(raw || ""));
  if (!tokensEqual(params.get("password") || "")) {
    return sendHtml(res, 401, loginForm());
  }
  res.writeHead(302, {
    location: "/",
    "set-cookie": cookieHeader(adminToken(), 2592000),
  });
  res.end();
}

function handleLogout(req, res) {
  res.writeHead(302, {
    location: "/",
    "set-cookie": cookieHeader("", 0),
  });
  res.end();
}

function clampDays(raw) {
  const n = Number(raw);
  if (n === 1 || n === 7 || n === 30) return n;
  return 30;
}

function buildStats(rows, days, nowMs) {
  const end = new Date(nowMs);
  const endDay = utcDay(nowMs);
  const series = [];
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - (days - 1)));
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime());
    d.setUTCDate(start.getUTCDate() + i);
    const day = d.toISOString().slice(0, 10);
    series.push({ day, visitors: 0, pageviews: 0, seen: new Set() });
  }
  const byDay = new Map(series.map((s) => [s.day, s]));
  const pages = new Map();
  const referrers = new Map();
  const events = new Map();
  let pageviews = 0;
  let downloads = 0;
  let githubStars = 0;

  for (const row of rows) {
    const day = utcDay(new Date(row.ts).getTime());
    const slot = byDay.get(day);
    const name = row.name;
    const props = row.props && typeof row.props === "object" ? row.props : {};
    if (name === "pageview") {
      pageviews += 1;
      if (slot) {
        slot.pageviews += 1;
        if (row.visitor) slot.seen.add(row.visitor);
      }
      pages.set(row.path, (pages.get(row.path) || 0) + 1);
      if (row.referrer) referrers.set(row.referrer, (referrers.get(row.referrer) || 0) + 1);
    } else if (NAMES.has(name)) {
      if (slot && row.visitor) slot.seen.add(row.visitor);
      const platform = props.platform || null;
      const key = `${name}\0${platform || ""}`;
      events.set(key, (events.get(key) || 0) + 1);
      if (name === "Download") downloads += 1;
      if (name === "GitHub Star") githubStars += 1;
    }
  }

  for (const s of series) s.visitors = s.seen.size;
  const visitors = series.reduce((n, s) => n + s.visitors, 0);
  const top = (map) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20);

  return {
    days,
    visitors,
    pageviews,
    downloads,
    githubStars,
    series: series.map(({ day, visitors: v, pageviews: p }) => ({
      day,
      visitors: v,
      pageviews: p,
    })),
    pages: top(pages).map(([path, count]) => ({ path, count })),
    referrers: top(referrers).map(([host, count]) => ({ host, count })),
    events: [...events.entries()].map(([key, count]) => {
      const [name, platform] = key.split("\0");
      return { name, platform: platform || null, count };
    }),
  };
}

async function handleStats(req, res, days) {
  if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
  if (!db) return json(res, 503, { error: "no database" });
  const since = new Date(nowFn());
  since.setUTCDate(since.getUTCDate() - (days - 1));
  since.setUTCHours(0, 0, 0, 0);
  try {
    const { rows } = await db.query(
      `SELECT ts, name, path, referrer, visitor, props
         FROM events WHERE ts >= $1
         ORDER BY ts ASC`,
      [since.toISOString()],
    );
    return json(res, 200, buildStats(rows, days, nowFn()));
  } catch (err) {
    console.error("stats failed", err);
    return json(res, 503, { error: "Could not read stats" });
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderDashboard(stats, days) {
  const max = Math.max(1, ...stats.series.map((s) => s.visitors));
  const bars = stats.series
    .map((s) => {
      const h = Math.round((s.visitors / max) * 100);
      return `<div class="bar"><span style="height:${h}%"></span><small>${s.pageviews}</small><em>${escapeHtml(s.day.slice(5))}</em></div>`;
    })
    .join("");
  const list = (items, key) =>
    items.length
      ? `<ol>${items.map((it) => `<li><span>${escapeHtml(it[key])}</span><b>${it.count}</b></li>`).join("")}</ol>`
      : "";
  const ev = stats.events
    .map((e) => {
      const label = e.platform ? `${e.name} (${e.platform})` : e.name;
      return `<li><span>${escapeHtml(label)}</span><b>${e.count}</b></li>`;
    })
    .join("");
  const empty = stats.pageviews === 0 && stats.downloads === 0 && stats.githubStars === 0;
  const link = (n, label) =>
    `<a href="/?days=${n}"${n === days ? ' aria-current="page"' : ""}>${label}</a>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Solenta stats</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { --paper:#f5f5f2; --ink:#191918; --muted:#5d5d58; --accent:#f2e51f; --border:rgba(25,25,24,.12); }
html,body { margin:0; background:var(--paper); color:var(--ink); font: 16px/1.45 system-ui, sans-serif; }
a { color: inherit; }
header { display:flex; justify-content:space-between; align-items:center; padding:1.25rem 1.5rem; border-bottom:1px solid var(--border); }
nav a { margin-left: .8rem; }
nav a[aria-current="page"] { box-shadow: inset 0 -3px 0 var(--accent); }
.wrap { max-width: 960px; margin: 0 auto; padding: 1.5rem; }
.nums { display:grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; }
.num { background:#fcfcfa; border:1px solid var(--border); border-radius:14px; padding:1rem; }
.num b { display:block; font-size: 2rem; }
.num span { color: var(--muted); }
.chart { display:flex; align-items:flex-end; gap:4px; height:160px; margin: 2rem 0; }
.bar { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%; }
.bar span { display:block; width:100%; background:var(--ink); min-height:2px; }
.bar small, .bar em { font-size:10px; color:var(--muted); }
.cols { display:grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
ol { list-style:none; padding:0; }
li { display:flex; justify-content:space-between; padding:.35rem 0; border-bottom:1px solid var(--border); }
form { display:inline; }
button { font:inherit; background:none; border:0; cursor:pointer; text-decoration:underline; }
@media (max-width: 700px) { .nums, .cols { grid-template-columns: 1fr 1fr; } }
</style></head>
<body>
<header>
  <strong>Solenta stats</strong>
  <nav>${link(1, "Today")}${link(7, "7 days")}${link(30, "30 days")}
  <form method="post" action="/logout"><button>Log out</button></form></nav>
</header>
<main class="wrap">
  <section class="nums">
    <div class="num"><b>${stats.visitors}</b><span>Visitors</span></div>
    <div class="num"><b>${stats.pageviews}</b><span>Pageviews</span></div>
    <div class="num"><b>${stats.downloads}</b><span>Downloads</span></div>
    <div class="num"><b>${stats.githubStars}</b><span>GitHub stars</span></div>
  </section>
  ${empty ? "<p>No events in this range.</p>" : `<div class="chart">${bars}</div>
  <div class="cols">
    <section><h2>Pages</h2>${list(stats.pages, "path")}</section>
    <section><h2>Referrers</h2>${list(stats.referrers, "host")}</section>
  </div>
  <section><h2>Events</h2><ol>${ev}</ol></section>`}
</main>
</body></html>`;
}

async function handleHome(req, res) {
  if (!authorized(req)) return sendHtml(res, 200, loginForm());
  if (!db) return sendHtml(res, 503, "<p>Could not read stats.</p>");
  const days = clampDays(new URL(req.url, "http://x").searchParams.get("days"));
  const since = new Date(nowFn());
  since.setUTCDate(since.getUTCDate() - (days - 1));
  since.setUTCHours(0, 0, 0, 0);
  try {
    const { rows } = await db.query(
      `SELECT ts, name, path, referrer, visitor, props
         FROM events WHERE ts >= $1
         ORDER BY ts ASC`,
      [since.toISOString()],
    );
    return sendHtml(res, 200, renderDashboard(buildStats(rows, days, nowFn()), days));
  } catch (err) {
    console.error("dashboard failed", err);
    return sendHtml(res, 503, "<p>Could not read stats.</p>");
  }
}

const server = http.createServer(async (req, res) => {
  const path = String(req.url || "").split("?")[0];
  if (path === "/health") return json(res, 200, { ok: true });
  if (path === "/e" && req.method === "OPTIONS") return noContent(req, res);
  if (path === "/e" && req.method === "POST") return handleEvent(req, res);
  if (path === "/login" && req.method === "POST") return handleLogin(req, res);
  if (path === "/logout" && req.method === "POST") return handleLogout(req, res);
  if (path === "/api/stats" && req.method === "GET") {
    const days = clampDays(new URL(req.url, "http://x").searchParams.get("days"));
    return handleStats(req, res, days);
  }
  if (path === "/" && req.method === "GET") return handleHome(req, res);
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
  authorized,
  timingSafeEqual,
  buildStats,
};
