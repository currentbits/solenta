# First-party Site Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Plausible on solenta.app with a first-party collector and a token-gated dashboard at stats.solenta.app.

**Architecture:** `stats-api/` is a Node `http` + `pg` Girder app, copied from `feedback-api/`. The static site serves `site/stats.js`, which `sendBeacon`s text/plain JSON to `POST /e`. Uniques are a daily HMAC of IP + UA; IP is never stored. The dashboard is server-rendered HTML on the stats host.

**Tech Stack:** Node 22 `node:http` / `node:crypto` / `node:test`, `pg`, two-stage `node:22-alpine` Docker, Girder (postgres, custom domain), jsdom site tests.

**Spec:** `docs/superpowers/specs/2026-08-28-first-party-site-analytics-design.md` (issue #747).

## Global Constraints

- Public site: no cookies, no personal data, no consent banner.
- Never write IP, User-Agent, full URL, or query string to Postgres.
- `POST /e` always returns 204, including on every drop.
- Event names allowlist: `pageview`, `Download`, `Docs`, `Changelog`, `GitHub Repo`, `GitHub Star`, `All downloads`.
- Origins allowlist: `https://solenta.app`, `https://www.solenta.app`.
- Visitor hash: `HMAC-SHA256(Buffer.from(salt,"hex"), ip + "\\n" + ua).hex.slice(0, 16)` with a per-UTC-day 32-byte salt.
- Range "Visitors" is the **sum of per-day distinct hashes**, not `COUNT(DISTINCT visitor)` over the range.
- Honor `DNT: 1` and `Sec-GPC: 1` (drop).
- Rate limit: 60 events per IP per rolling minute, in memory.
- Body cap: 2 KB.
- Dashboard: paper-and-ink tokens (`--paper #f5f5f2`, `--ink #191918`, `--accent #f2e51f`), no Chart.js, no dashboard JS, no webfont files.
- Cookie name `solenta_stats`, HttpOnly / Secure / SameSite=Strict / Path=/ / Max-Age=30 days.
- Unset `ADMIN_TOKEN` denies the dashboard.
- One dependency: `pg`. Dockerfile copies `feedback-api/` (two-stage, npm stripped).
- Visible copy: no em dashes.
- Do not mix this into `feedback-api/` or the site nginx image.
- Do not add countries, devices, realtime, funnels, UTMs, or docs/changelog nav tags.

## File structure

| File | Responsibility |
|---|---|
| `stats-api/server.js` | Collector, auth, `/api/stats`, dashboard HTML |
| `stats-api/test.js` | node:test against a fake db |
| `stats-api/package.json` | `pg`, `test` script with `--test-concurrency=1` |
| `stats-api/package-lock.json` | Docker-reproducible install |
| `stats-api/Dockerfile` | Two-stage image, `USER node`, `PORT=3000` |
| `site/stats.js` | Tracker (pageview + `[data-event]` clicks) |
| `site/index.html` | Drop Plausible; `data-event` / `data-platform`; load stats.js |
| `site/docs.html` / `site/changelog.html` | Drop Plausible; load stats.js |
| `site/main.js` | Hero button writes `data-platform` |
| `electron/test/site-stats.test.js` | HTML + tracker contract |
| `electron/test/site-downloads.test.js` | `data-platform` assertion |
| `package.json` | `test:stats` on the root `test` script |
| `docs/ARCHITECTURE.md` | Stats section next to Feedback |

---

### Task 1: Scaffold and health

**Files:**
- Create: `stats-api/package.json`
- Create: `stats-api/Dockerfile`
- Create: `stats-api/server.js`
- Create: `stats-api/test.js`
- Create: `stats-api/package-lock.json` (via `npm install`)

**Interfaces:**
- Consumes: nothing.
- Produces: `server` (`http.Server`), `setDb(next)`, `SCHEMA` (SQL string), `GET /health` -> 200 `{ok:true}` with or without a database.

- [ ] **Step 1: Write the failing health test**

Create `stats-api/test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert");

process.env.ADMIN_TOKEN = "secret-token";
const { server, setDb } = require("./server");

function listen() {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("GET /health is 200 without a database", async (t) => {
  const port = await listen();
  setDb(null);
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run:

```bash
node --test --test-concurrency=1 stats-api/test.js
```

Expected: FAIL, `Cannot find module './server'`.

- [ ] **Step 3: Scaffold the app**

Create `stats-api/package.json`:

```json
{
  "name": "solenta-stats-api",
  "private": true,
  "version": "1.0.0",
  "description": "First-party site analytics for solenta.app (issue #747)",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node --test --test-concurrency=1 test.js"
  },
  "dependencies": {
    "pg": "^8.13.1"
  }
}
```

Copy `feedback-api/Dockerfile` to `stats-api/Dockerfile` unchanged.

Create `stats-api/server.js`:

```js
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

/** @param {typeof db} next */
function setDb(next) {
  db = next;
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

const server = http.createServer(async (req, res) => {
  const path = String(req.url || "").split("?")[0];
  if (path === "/health") return json(res, 200, { ok: true });
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

module.exports = { server, setDb, SCHEMA };
```

Then:

```bash
cd stats-api && npm install
```

Expected: `stats-api/package-lock.json` exists and lists `pg`.

- [ ] **Step 4: Run the health test**

Run:

```bash
node --test --test-concurrency=1 stats-api/test.js
```

Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add stats-api/package.json stats-api/package-lock.json stats-api/Dockerfile stats-api/server.js stats-api/test.js
git commit -m "stats-api: scaffold health endpoint for first-party analytics"
```

---

### Task 2: Collector `POST /e`

**Files:**
- Modify: `stats-api/server.js`
- Modify: `stats-api/test.js`
- Modify: `package.json` (add `test:stats` to the root `test` script)

**Interfaces:**
- Consumes: Task 1 `server`, `setDb`, `SCHEMA`.
- Produces: `POST /e` always 204. `setNow(fn)`, `resetHits()`. Insert params are `(name, path, referrer, visitor, propsJson)` with no IP/UA. `RATE_MAX = 60`. Names, origin, path, referrer, DNT/GPC, bots, 2 KB cap, daily visitor HMAC as in Global Constraints.

- [ ] **Step 1: Replace `stats-api/test.js` with the collector tests**

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createHmac } = require("node:crypto");

process.env.ADMIN_TOKEN = "secret-token";
const { server, setDb, setNow, resetHits, RATE_MAX } = require("./server");

function fakeDb(opts = {}) {
  const salts = new Map(opts.salts || []);
  const events = [];
  const calls = [];
  return {
    calls,
    salts,
    events,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (opts.throws) throw new Error("connection refused");
      if (/INSERT INTO salts/i.test(sql)) {
        if (!salts.has(params[0])) salts.set(params[0], params[1]);
        return { rows: [] };
      }
      if (/FROM salts/i.test(sql)) {
        const salt = salts.get(params[0]);
        return { rows: salt ? [{ salt }] : [] };
      }
      if (/INSERT INTO events/i.test(sql)) {
        events.push({
          name: params[0],
          path: params[1],
          referrer: params[2],
          visitor: params[3],
          props: params[4],
        });
        return { rows: [{ id: events.length }] };
      }
      return { rows: opts.rows || [] };
    },
  };
}

function listen() {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function post(port, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/e`, {
    method: "POST",
    headers: {
      "content-type": "text/plain;charset=UTF-8",
      "x-forwarded-for": "203.0.113.10",
      "user-agent": "Mozilla/5.0",
      origin: "https://solenta.app",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const PAGE = {
  n: "pageview",
  u: "https://solenta.app/",
  r: "https://www.producthunt.com/posts/solenta",
};

test("GET /health is 200 without a database", async (t) => {
  const port = await listen();
  setDb(null);
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("POST /e stores a pageview and never writes IP or UA", async (t) => {
  resetHits();
  const port = await listen();
  const db = fakeDb();
  setDb(db);
  t.after(() => {
    server.close();
    setDb(null);
  });

  const res = await post(port, PAGE);
  assert.equal(res.status, 204);
  const insert = db.calls.find((c) => /INSERT INTO events/i.test(c.sql));
  assert.ok(insert, "expected an events insert");
  assert.equal(insert.params[0], "pageview");
  assert.equal(insert.params[1], "/");
  assert.equal(insert.params[2], "www.producthunt.com");
  assert.match(insert.params[3], /^[0-9a-f]{16}$/);
  assert.equal(insert.params[4], "{}");
  const blob = JSON.stringify(insert.params);
  assert.equal(blob.includes("203.0.113.10"), false);
  assert.equal(blob.includes("Mozilla/5.0"), false);
});

test("same IP+UA same UTC day reuse the visitor; a new day does not", async (t) => {
  resetHits();
  const port = await listen();
  const db = fakeDb();
  setDb(db);
  t.after(() => {
    server.close();
    setDb(null);
    setNow(null);
  });

  setNow(() => Date.UTC(2026, 7, 28, 12));
  assert.equal((await post(port, PAGE, { "x-forwarded-for": "198.51.100.1" })).status, 204);
  assert.equal((await post(port, PAGE, { "x-forwarded-for": "198.51.100.1" })).status, 204);
  const firstDay = db.events.filter((e) => e.path === "/").map((e) => e.visitor);
  assert.equal(firstDay[0], firstDay[1]);

  setNow(() => Date.UTC(2026, 7, 29, 12));
  assert.equal((await post(port, PAGE, { "x-forwarded-for": "198.51.100.1" })).status, 204);
  assert.notEqual(db.events[2].visitor, firstDay[0]);
});

test("normalizes path, strips self-referrer, drops junk with 204", async (t) => {
  resetHits();
  const port = await listen();
  const db = fakeDb();
  setDb(db);
  t.after(() => {
    server.close();
    setDb(null);
  });

  assert.equal(
    (
      await post(port, {
        n: "pageview",
        u: "https://solenta.app/index.html?x=1#h",
        r: "https://solenta.app/docs.html",
      })
    ).status,
    204,
  );
  assert.equal(db.events[0].path, "/");
  assert.equal(db.events[0].referrer, "");

  const droppedStart = db.events.length;
  assert.equal((await post(port, "not json")).status, 204);
  assert.equal((await post(port, { n: "pageview", u: "https://evil.test/" })).status, 204);
  assert.equal((await post(port, { n: "Hack", u: "https://solenta.app/" })).status, 204);
  assert.equal((await post(port, PAGE, { "user-agent": "Googlebot/2.1" })).status, 204);
  assert.equal((await post(port, PAGE, { dnt: "1" })).status, 204);
  assert.equal((await post(port, PAGE, { "sec-gpc": "1" })).status, 204);
  assert.equal((await post(port, "x".repeat(3000))).status, 204);
  assert.equal(db.events.length, droppedStart);

  assert.equal(
    (await post(port, { n: "Download", u: "https://solenta.app/", p: { platform: "beos" } })).status,
    204,
  );
  assert.equal(db.events.at(-1).name, "Download");
  assert.equal(db.events.at(-1).props, "{}");
});

test("rate limit lets RATE_MAX through then drops", async (t) => {
  resetHits();
  const port = await listen();
  const db = fakeDb();
  setDb(db);
  t.after(() => {
    server.close();
    setDb(null);
  });
  for (let i = 0; i < RATE_MAX; i++) {
    assert.equal(
      (await post(port, PAGE, { "x-forwarded-for": "192.0.2.9" })).status,
      204,
    );
  }
  assert.equal(db.events.length, RATE_MAX);
  assert.equal((await post(port, PAGE, { "x-forwarded-for": "192.0.2.9" })).status, 204);
  assert.equal(db.events.length, RATE_MAX);
  assert.equal((await post(port, PAGE, { "x-forwarded-for": "192.0.2.10" })).status, 204);
  assert.equal(db.events.length, RATE_MAX + 1);
});

test("database failure still answers 204", async (t) => {
  resetHits();
  const port = await listen();
  setDb(fakeDb({ throws: true }));
  t.after(() => {
    server.close();
    setDb(null);
  });
  assert.equal((await post(port, PAGE)).status, 204);
});

test("HMAC matches the spec encoding", () => {
  const salt = "aa".repeat(32);
  const ip = "203.0.113.10";
  const ua = "Mozilla/5.0";
  const expected = createHmac("sha256", Buffer.from(salt, "hex"))
    .update(`${ip}\n${ua}`)
    .digest("hex")
    .slice(0, 16);
  const { hashVisitor } = require("./server");
  assert.equal(hashVisitor(ip, ua, salt), expected);
});
```

- [ ] **Step 2: Run collector tests and confirm they fail**

Run:

```bash
node --test --test-concurrency=1 stats-api/test.js
```

Expected: FAIL on `setNow` / `resetHits` / `RATE_MAX` / `hashVisitor` not exported, and `/e` 404.

- [ ] **Step 3: Implement the collector in `stats-api/server.js`**

Replace `stats-api/server.js` with:

```js
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
```

- [ ] **Step 4: Run collector tests**

Run:

```bash
node --test --test-concurrency=1 stats-api/test.js
```

Expected: PASS.

- [ ] **Step 5: Wire `test:stats` into the root suite**

In root `package.json`, add `"test:stats": "node --test --test-concurrency=1 stats-api/test.js"` and change `"test"` to:

```
npm run test:core && npm run test:renderer && npm run test:electron && npm run test:memory && npm run test:stats
```

- [ ] **Step 6: Commit**

```bash
git add stats-api/server.js stats-api/test.js package.json
git commit -m "stats-api: collect pageviews and tagged events without storing IP"
```

---

### Task 3: Dashboard auth

**Files:**
- Modify: `stats-api/server.js`
- Modify: `stats-api/test.js`

**Interfaces:**
- Consumes: Task 2 `server`, `adminToken()`, `COOKIE` (`solenta_stats`).
- Produces: `authorized(req) -> boolean`. `POST /login` (`application/x-www-form-urlencoded` field `password`) sets the cookie and 302s to `/`. `POST /logout` clears it. Bearer `Authorization: Bearer <ADMIN_TOKEN>` also works. Unset `ADMIN_TOKEN` denies. Cookie flags: HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000.

- [ ] **Step 1: Append auth tests to `stats-api/test.js`**

```js
const { authorized, COOKIE } = require("./server");

function reqOf(headers) {
  return { headers };
}

test("bearer and cookie auth reject near-misses; unset token denies", () => {
  assert.equal(authorized(reqOf({ authorization: "Bearer secret-token" })), true);
  assert.equal(authorized(reqOf({ cookie: `${COOKIE}=secret-token` })), true);
  assert.equal(authorized(reqOf({ authorization: "Bearer secret-toke" })), false);
  assert.equal(authorized(reqOf({ authorization: "Bearer secret-tokenX" })), false);
  assert.equal(authorized(reqOf({ authorization: "secret-token" })), false);
  assert.equal(authorized(reqOf({})), false);
  const prev = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  assert.equal(authorized(reqOf({ authorization: "Bearer secret-token" })), false);
  process.env.ADMIN_TOKEN = prev;
});

test("POST /login sets the cookie; wrong password does not", async (t) => {
  const port = await listen();
  t.after(() => server.close());
  const bad = await fetch(`http://127.0.0.1:${port}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=nope",
    redirect: "manual",
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get("set-cookie") == null, true);

  const ok = await fetch(`http://127.0.0.1:${port}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=secret-token",
    redirect: "manual",
  });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get("location"), "/");
  const cookie = ok.headers.get("set-cookie") || "";
  assert.match(cookie, new RegExp(`${COOKIE}=secret-token`));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Strict/i);
});
```

- [ ] **Step 2: Run and confirm FAIL**

```bash
node --test --test-concurrency=1 stats-api/test.js
```

Expected: FAIL, `authorized is not a function` or `/login` 404.

- [ ] **Step 3: Add auth helpers and routes**

Add to `stats-api/server.js` (next to `adminToken`):

```js
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
```

Update the request handler:

```js
const server = http.createServer(async (req, res) => {
  const path = String(req.url || "").split("?")[0];
  if (path === "/health") return json(res, 200, { ok: true });
  if (path === "/e" && req.method === "OPTIONS") return noContent(req, res);
  if (path === "/e" && req.method === "POST") return handleEvent(req, res);
  if (path === "/login" && req.method === "POST") return handleLogin(req, res);
  if (path === "/logout" && req.method === "POST") return handleLogout(req, res);
  res.writeHead(404);
  res.end();
});
```

Export `authorized` (COOKIE is already exported).

- [ ] **Step 4: Run tests**

```bash
node --test --test-concurrency=1 stats-api/test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add stats-api/server.js stats-api/test.js
git commit -m "stats-api: token-gate the dashboard with bearer and a cookie"
```

---

### Task 4: `GET /api/stats`

**Files:**
- Modify: `stats-api/server.js`
- Modify: `stats-api/test.js`

**Interfaces:**
- Consumes: `authorized(req)`, event rows `{ts, name, path, referrer, visitor, props}`.
- Produces: `buildStats(rows, days, nowMs) -> { days, visitors, pageviews, downloads, githubStars, series, pages, referrers, events }`. `series` is one UTC day per slot including zeros, oldest first. `visitors` is the sum of per-day distinct visitor hashes. `events[].platform` is `null` when absent. Invalid `days` becomes 30. `GET /api/stats` is 401 without auth, 503 without db, 200 JSON with auth.

- [ ] **Step 1: Add aggregation tests**

```js
const { buildStats } = require("./server");

test("visitors sum daily distinct hashes, not range-wide distinct", () => {
  const day1 = "2026-08-01T10:00:00.000Z";
  const day2 = "2026-08-02T10:00:00.000Z";
  const rows = [
    { ts: day1, name: "pageview", path: "/", referrer: "producthunt.com", visitor: "aaa", props: {} },
    { ts: day1, name: "pageview", path: "/", referrer: "", visitor: "aaa", props: {} },
    { ts: day2, name: "pageview", path: "/docs.html", referrer: "", visitor: "aaa", props: {} },
    { ts: day2, name: "Download", path: "/", referrer: "", visitor: "bbb", props: { platform: "mac" } },
    { ts: day2, name: "GitHub Star", path: "/", referrer: "", visitor: "bbb", props: {} },
  ];
  const now = Date.parse("2026-08-02T12:00:00.000Z");
  const stats = buildStats(rows, 2, now);
  assert.equal(stats.days, 2);
  assert.equal(stats.pageviews, 3);
  assert.equal(stats.downloads, 1);
  assert.equal(stats.githubStars, 1);
  assert.equal(stats.visitors, 3, "two uniques on day1-2 split: day1 has 1, day2 has 2");
  assert.equal(stats.series.length, 2);
  assert.equal(stats.series[0].day, "2026-08-01");
  assert.equal(stats.series[0].visitors, 1);
  assert.equal(stats.series[0].pageviews, 2);
  assert.equal(stats.series[1].visitors, 2);
  assert.equal(stats.pages[0].path, "/");
  assert.equal(stats.referrers[0].host, "producthunt.com");
  const dl = stats.events.find((e) => e.name === "Download");
  assert.equal(dl.platform, "mac");
  assert.equal(dl.count, 1);
});

test("GET /api/stats needs auth and uses buildStats", async (t) => {
  const port = await listen();
  const db = fakeDb({
    rows: [
      {
        ts: "2026-08-28T10:00:00.000Z",
        name: "pageview",
        path: "/",
        referrer: "",
        visitor: "abc",
        props: {},
      },
    ],
  });
  setDb(db);
  t.after(() => {
    server.close();
    setDb(null);
  });
  const url = `http://127.0.0.1:${port}/api/stats?days=1`;
  assert.equal((await fetch(url)).status, 401);
  const ok = await fetch(url, { headers: { authorization: "Bearer secret-token" } });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.pageviews, 1);
  assert.equal(body.visitors, 1);
});
```

Extend `fakeDb` so a `SELECT` that is not salts returns `opts.rows`:

```js
if (/FROM salts/i.test(sql)) { /* existing */ }
if (/^\s*SELECT/i.test(sql)) return { rows: opts.rows || [] };
```

- [ ] **Step 2: Run and confirm FAIL**

```bash
node --test --test-concurrency=1 stats-api/test.js
```

Expected: FAIL, `buildStats is not a function`.

- [ ] **Step 3: Implement `buildStats` and `GET /api/stats`**

```js
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
```

In the request handler, before the 404:

```js
  if (path === "/api/stats" && req.method === "GET") {
    const days = clampDays(new URL(req.url, "http://x").searchParams.get("days"));
    return handleStats(req, res, days);
  }
```

Export `buildStats`.

Fix the visitors test if needed: day1 has visitor `aaa` twice = 1 unique; day2 has `aaa` and `bbb` = 2; sum = 3. Download and GitHub Star also add `bbb` to day2's seen set, already counted.

- [ ] **Step 4: Run tests**

```bash
node --test --test-concurrency=1 stats-api/test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add stats-api/server.js stats-api/test.js
git commit -m "stats-api: aggregate daily visitors, pages, referrers, and events"
```

---

### Task 5: HTML dashboard

**Files:**
- Modify: `stats-api/server.js`
- Modify: `stats-api/test.js`

**Interfaces:**
- Consumes: `buildStats`, `authorized`, `loginForm`.
- Produces: `GET /` 200 login HTML without auth; 200 dashboard HTML with auth; 503 one sentence if the db throws. Range links `/?days=1|7|30`. Copy: "Visitors", "Pageviews", "Downloads", "GitHub stars", empty "No events in this range." Zero JS. Paper-and-ink tokens. No em dashes.

- [ ] **Step 1: Add dashboard tests**

```js
test("GET / is a password form until authorized", async (t) => {
  const port = await listen();
  t.after(() => server.close());
  const anon = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(anon.status, 200);
  const html = await anon.text();
  assert.match(html, /name="password"/);
  assert.equal(html.includes("chart.js"), false);
  assert.equal(html.includes("\u2014"), false);
});

test("GET / with bearer renders totals and the empty sentence", async (t) => {
  const port = await listen();
  setDb(fakeDb({ rows: [] }));
  t.after(() => {
    server.close();
    setDb(null);
  });
  const res = await fetch(`http://127.0.0.1:${port}/?days=7`, {
    headers: { authorization: "Bearer secret-token" },
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Visitors/);
  assert.match(html, /Pageviews/);
  assert.match(html, /Downloads/);
  assert.match(html, /GitHub stars/);
  assert.match(html, /No events in this range\./);
  assert.match(html, /\?days=1/);
  assert.match(html, /\?days=30/);
  assert.equal(html.includes("<script"), false);
});

test("GET / is 503 with one sentence when the db throws", async (t) => {
  const port = await listen();
  setDb(fakeDb({ throws: true }));
  t.after(() => {
    server.close();
    setDb(null);
  });
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { authorization: "Bearer secret-token" },
  });
  assert.equal(res.status, 503);
  const html = await res.text();
  assert.match(html, /Could not read stats/);
  assert.equal(html.includes("at "), false);
});
```

- [ ] **Step 2: Run and confirm FAIL**

```bash
node --test --test-concurrency=1 stats-api/test.js
```

Expected: FAIL, `GET /` is 404.

- [ ] **Step 3: Render the dashboard**

```js
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
```

In the request handler, before 404:

```js
  if (path === "/" && req.method === "GET") return handleHome(req, res);
```

The 503 test looks for `at ` as a stack-trace leak. Keep the HTML to the one sentence. `fakeDb({ throws: true })` throws on every query including salts; `handleHome` hits SELECT events and catches it.

- [ ] **Step 4: Run tests**

```bash
node --test --test-concurrency=1 stats-api/test.js
```

Expected: PASS. If `html.includes("<script")` fails because of none, good. Login form also has no script.

- [ ] **Step 5: Commit**

```bash
git add stats-api/server.js stats-api/test.js
git commit -m "stats-api: paper-and-ink dashboard for visitors, pages, and events"
```

---

### Task 6: Site tracker

**Files:**
- Create: `site/stats.js`
- Create: `electron/test/site-stats.test.js`
- Modify: `site/index.html`
- Modify: `site/docs.html`
- Modify: `site/changelog.html`
- Modify: `site/main.js`
- Modify: `electron/test/site-downloads.test.js`

**Interfaces:**
- Consumes: collector `POST https://stats.solenta.app/e` text/plain JSON `{n,u,r,p?}`.
- Produces: `site/stats.js` sends only when `location.hostname` is `solenta.app` or `www.solenta.app`. Pageview on load. Click `[data-event]` uses `sendBeacon`, no `preventDefault`. `data-event` values match the allowlist. `site/main.js` sets `data-platform` on `#hero-dl`.

- [ ] **Step 1: Write the failing site tests**

Create `electron/test/site-stats.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SITE = path.join(__dirname, "..", "..", "site");
const PAGES = ["index.html", "docs.html", "changelog.html"];

function read(name) {
  return fs.readFileSync(path.join(SITE, name), "utf8");
}

test("every public page dropped Plausible and loads stats.js", () => {
  for (const name of PAGES) {
    const html = read(name);
    assert.equal(html.includes("plausible.io"), false, name);
    assert.equal(html.includes("plausible-event-"), false, name);
    assert.match(html, /src="stats\.js"/, name);
  }
});

test("homepage CTAs use data-event and data-platform", () => {
  const html = read("index.html");
  assert.match(html, /data-event="Docs"/);
  assert.match(html, /data-event="Changelog"/);
  assert.match(html, /data-event="GitHub Repo"/);
  assert.match(html, /data-event="Download"/);
  assert.match(html, /data-event="GitHub Star"/);
  assert.match(html, /data-event="All downloads"/);
  assert.match(html, /data-platform="mac"/);
  assert.match(html, /id="hero-dl"[^>]*data-platform="unknown"/);
});

function loadStats(url) {
  const html = read("index.html");
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  const beacons = [];
  dom.window.navigator.sendBeacon = (endpoint, body) => {
    beacons.push({ endpoint, body: String(body) });
    return true;
  };
  dom.window.eval(fs.readFileSync(path.join(SITE, "stats.js"), "utf8"));
  return { window: dom.window, document: dom.window.document, beacons };
}

test("stats.js beacons a pageview and a tagged click on solenta.app", () => {
  const { document, beacons } = loadStats("https://solenta.app/");
  assert.equal(beacons.length, 1);
  const page = JSON.parse(beacons[0].body);
  assert.equal(page.n, "pageview");
  assert.equal(beacons[0].endpoint, "https://stats.solenta.app/e");
  const star = document.querySelector('[data-event="GitHub Star"]');
  star.dispatchEvent(new document.defaultView.MouseEvent("click", { bubbles: true }));
  assert.equal(beacons.length, 2);
  const ev = JSON.parse(beacons[1].body);
  assert.equal(ev.n, "GitHub Star");
});

test("stats.js is inert off the production host", () => {
  const local = loadStats("http://127.0.0.1:8080/");
  assert.equal(local.beacons.length, 0);
  const preview = loadStats("https://solenta-preview.platform.rungirder.com/");
  assert.equal(preview.beacons.length, 0);
});
```

In `electron/test/site-downloads.test.js` change the two class assertions to:

```js
  assert.equal(hero.getAttribute("data-platform"), "mac");
  assert.notEqual(hero.getAttribute("data-platform"), "unknown");
```

- [ ] **Step 2: Run and confirm FAIL**

```bash
node --test electron/test/site-stats.test.js electron/test/site-downloads.test.js
```

Expected: FAIL on leftover `plausible.io` and missing `stats.js`.

- [ ] **Step 3: Add `site/stats.js`**

```js
(() => {
  const HOSTS = { "solenta.app": 1, "www.solenta.app": 1 };
  if (!HOSTS[location.hostname]) return;
  const ENDPOINT = "https://stats.solenta.app/e";

  const send = (n, extra) => {
    const payload = {
      n,
      u: location.href,
      r: document.referrer || "",
      ...extra,
    };
    const body = JSON.stringify(payload);
    try {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "text/plain;charset=UTF-8" }));
    } catch {
      fetch(ENDPOINT, {
        method: "POST",
        body,
        headers: { "content-type": "text/plain;charset=UTF-8" },
        keepalive: true,
      }).catch(() => {});
    }
  };

  send("pageview");

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-event]");
    if (!el) return;
    const n = el.getAttribute("data-event");
    if (!n) return;
    const platform = el.getAttribute("data-platform");
    send(n, platform ? { p: { platform } } : {});
  });
})();
```

- [ ] **Step 4: Swap Plausible for attributes**

On `site/index.html`, `site/docs.html`, `site/changelog.html` replace the Plausible comment + script with:

```html
  <!-- First-party stats: no cookies, no personal data, so no consent banner.
       stats.js beacons pageviews and data-event clicks to stats.solenta.app. -->
  <script src="stats.js" defer></script>
```

On `site/index.html` only, rewrite classes:

| From | To |
|---|---|
| `class="plausible-event-name=Docs"` | `data-event="Docs"` |
| `class="plausible-event-name=Changelog"` | `data-event="Changelog"` |
| `class="plausible-event-name=GitHub+Repo"` | `data-event="GitHub Repo"` |
| `class="btn btn-primary plausible-event-name=Download plausible-event-platform=unknown"` | `class="btn btn-primary" data-event="Download" data-platform="unknown"` |
| `class="btn btn-ghost plausible-event-name=GitHub+Star"` | `class="btn btn-ghost" data-event="GitHub Star"` |
| `class="plausible-event-name=Download plausible-event-platform=mac"` | `data-event="Download" data-platform="mac"` |
| same for `win` / `linux` | `data-platform="win"` / `"linux"` |
| `class="btn btn-ghost btn-block plausible-event-name=Download plausible-event-platform=mac"` | `class="btn btn-ghost btn-block" data-event="Download" data-platform="mac"` |
| same for win/linux install cards | keep `btn` classes, add data attrs |
| `class="plausible-event-name=All+downloads"` | `data-event="All downloads"` |
| `class="btn btn-ghost btn-lg plausible-event-name=Docs"` | `class="btn btn-ghost btn-lg" data-event="Docs"` |
| `class="btn btn-ghost btn-lg plausible-event-name=GitHub+Star"` | `class="btn btn-ghost btn-lg" data-event="GitHub Star"` |
| footer `GitHub+Repo` / `All+downloads` | `data-event="GitHub Repo"` / `data-event="All downloads"` |

Do not add `data-event` to docs.html or changelog.html nav.

In `site/main.js` replace the two classList lines with:

```js
        btn.removeAttribute("data-platform");
        btn.setAttribute("data-platform", os);
```

Leave `data-platform="unknown"` in the HTML as the no-JS default; detection overwrites it.

- [ ] **Step 5: Run site tests**

```bash
node --test electron/test/site-stats.test.js electron/test/site-downloads.test.js
```

Expected: PASS. If the hero `id="hero-dl"` regex fails because attributes are reordered, assert with jsdom: `document.getElementById("hero-dl").getAttribute("data-platform") === "unknown"` on the raw HTML (before main.js).

- [ ] **Step 6: Commit**

```bash
git add site/stats.js site/index.html site/docs.html site/changelog.html site/main.js \
  electron/test/site-stats.test.js electron/test/site-downloads.test.js
git commit -m "site: replace Plausible with first-party stats.js beacons"
```

---

### Task 7: Architecture note and Girder deploy

**Files:**
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: live `stats-api/` and `site/stats.js` from Tasks 1-6.
- Produces: Girder app `solenta-stats` (stack `solenta`), domain `stats.solenta.app`, postgres, `ADMIN_TOKEN`, grafted `stats-api/` and site. Issue #747 closed after a live Download event is visible on the dashboard. #683 analytics checkbox done.

- [ ] **Step 1: Document the service**

Insert a `## Site analytics` section in `docs/ARCHITECTURE.md` immediately after `## Feedback`:

```markdown
## Site analytics

Issue #747. Replaces Plausible on solenta.app. The public site stays
cookieless: `site/stats.js` beacons `{n,u,r,p?}` as text/plain to
`POST https://stats.solenta.app/e`. The collector always answers 204.
IP is used in memory to HMAC a daily visitor id and to rate-limit; it is
never written. DNT and GPC drops the event.

| Piece | Path |
|-------|------|
| Tracker | `site/stats.js` (index, docs, changelog) |
| Endpoint | `stats-api/` , Girder app `solenta-stats` (stats.solenta.app) |
| Dashboard | `GET /` cookie or bearer `ADMIN_TOKEN`; `GET /api/stats?days=1\|7\|30` |

```
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://stats.solenta.app/api/stats?days=7"
```

- [ ] **Step 2: Commit the doc**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: first-party site analytics next to feedback"
```

- [ ] **Step 3: Create the Girder app and services**

Using the girder MCP (not a public git host):

1. `create_app` `{ "name": "solenta-stats", "stack": "solenta" }`
2. `services_add` `{ "app": "solenta-stats", "type": "postgres" }`
3. Generate a token, then `app_env_set` `{ "app": "solenta-stats", "key": "ADMIN_TOKEN", "value": "<32-byte hex>" }`
4. `domains_add` `{ "app": "solenta-stats", "host": "stats.solenta.app" }`
5. `app_config` `{ "app": "solenta-stats", "key": "healthPath", "value": "/health" }`

Generate the token with `openssl rand -hex 32`. Do not commit it. Do not paste it into the GitHub issue. Keep it in the operator's password store. Set it **before** the first deploy.

- [ ] **Step 4: Graft `stats-api/`**

```bash
git remote add girder-stats ssh://git@100.112.17.24:2222/solenta-stats.git 2>/dev/null || true
TREE=$(git rev-parse HEAD:stats-api)
if git fetch girder-stats main; then
  PARENT=$(git rev-parse girder-stats/main)
  SHA=$(git commit-tree "$TREE" -p "$PARENT" -F - <<'EOF'
stats-api: first-party collector and private dashboard
EOF
)
else
  SHA=$(git commit-tree "$TREE" -F - <<'EOF'
stats-api: first-party collector and private dashboard
EOF
)
fi
git push girder-stats "$SHA":refs/heads/main
```

Expected: Docker build succeeds, trivy reports 0 HIGH/CRITICAL, `/health` on `https://stats.solenta.app/health` is 200.

- [ ] **Step 5: Graft the site**

```bash
git fetch girder main
TREE=$(git rev-parse HEAD:site)
PARENT=$(git rev-parse girder/main)
SHA=$(git commit-tree "$TREE" -p "$PARENT" -F - <<'EOF'
site: first-party stats.js, drop Plausible
EOF
)
git push girder "$SHA":main
```

Expected: live `https://solenta.app/` HTML contains `stats.js` and no `plausible.io`.

- [ ] **Step 6: Prove a live event**

Open `https://solenta.app/`, click a Download button, then:

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://stats.solenta.app/api/stats?days=1"
```

Expected: `downloads` >= 1 (or `pageviews` >= 1 if the click was DNT-filtered on your browser; in that case click from a browser with DNT off, or POST a synthetic `{n:"Download",u:"https://solenta.app/",p:{platform:"mac"}}` from your machine). Open `https://stats.solenta.app`, log in, see the bar.

- [ ] **Step 7: Close the planboard issues**

```bash
gh issue comment 747 --body "Live: stats.solenta.app is collecting. Plausible is gone from solenta.app."
gh issue close 747 --reason completed
gh issue comment 683 --body "Analytics: first-party collector at stats.solenta.app (#747), Plausible removed."
```

If #683's only leftover was analytics, close it too. If the download-flow remainder is still open, leave #683 open and just tick the analytics checkbox in the body.

---

## Self-review

**Spec coverage**

| Spec section | Task |
|---|---|
| Architecture, Girder app, domain, postgres | 1, 7 |
| Privacy, HMAC, daily salt, no IP column | 2 |
| Allowlist, origin, path `/index.html` -> `/`, referrer host | 2 |
| DNT/GPC, bots, 60/min, 2 KB, always 204 | 2 |
| CORS text/plain, OPTIONS /e | 2 |
| Cookie + bearer auth, unset token denies | 3 |
| `/api/stats` JSON, sum of daily uniques | 4 |
| Dashboard HTML, CSS bars, empty sentence, 503 | 5 |
| `site/stats.js`, hostname gate, data-event | 6 |
| `test:stats` on `npm test` | 2 |
| `docs/ARCHITECTURE.md` | 7 |
| Live probe, close #747 | 7 |
| Non-goals (no UTMs, no docs nav tags, no Umami) | not implemented, tests forbid leftover Plausible |

**Placeholders:** none.

**Names:** `COOKIE=solenta_stats`, `RATE_MAX=60`, `hashVisitor`, `buildStats`, `setNow`, `resetHits`, endpoints `/e`, `/health`, `/login`, `/logout`, `/api/stats`, `/`.
