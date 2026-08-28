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
