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
