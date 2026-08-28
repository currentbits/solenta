"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createHmac } = require("node:crypto");

process.env.ADMIN_TOKEN = "secret-token";
const {
  server,
  setDb,
  setNow,
  resetHits,
  RATE_MAX,
  parseCountry,
  parseBrowser,
  parseUtms,
} = require("./server");

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
      if (/^\s*SELECT/i.test(sql)) return { rows: opts.rows || [] };
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
  assert.deepEqual(JSON.parse(insert.params[4]), { browser: "Other" });
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
  const junkProps = JSON.parse(db.events.at(-1).props);
  assert.equal(junkProps.platform, undefined);
  assert.equal(junkProps.browser, "Other");
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
  setNow(() => Date.parse("2026-08-28T12:00:00.000Z"));
  t.after(() => {
    server.close();
    setDb(null);
    setNow(null);
  });
  const url = `http://127.0.0.1:${port}/api/stats?days=1`;
  assert.equal((await fetch(url)).status, 401);
  const ok = await fetch(url, { headers: { authorization: "Bearer secret-token" } });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.pageviews, 1);
  assert.equal(body.visitors, 1);
});

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

test("parseCountry accepts ISO codes and drops XX", () => {
  assert.equal(parseCountry("NL"), "NL");
  assert.equal(parseCountry("us"), "US");
  assert.equal(parseCountry("XX"), "");
  assert.equal(parseCountry(""), "");
  assert.equal(parseCountry(undefined), "");
});

test("parseBrowser classifies Edge before Chrome", () => {
  assert.equal(parseBrowser("Mozilla/5.0 Edg/120.0"), "Edge");
  assert.equal(parseBrowser("Mozilla/5.0 Chrome/120.0"), "Chrome");
  assert.equal(parseBrowser("Mozilla/5.0 CriOS/120.0"), "Chrome");
  assert.equal(parseBrowser("Mozilla/5.0 Firefox/120.0"), "Firefox");
  assert.equal(parseBrowser("Mozilla/5.0 FxiOS/120.0"), "Firefox");
  assert.equal(
    parseBrowser("Mozilla/5.0 Version/17.0 Safari/605.1.15"),
    "Safari",
  );
  assert.equal(parseBrowser("curl/8.0"), "Other");
  assert.equal(parseBrowser(""), "");
});

test("parseUtms keeps three keys and drops the rest", () => {
  const utm = parseUtms(
    "https://solenta.app/?utm_source=ph&utm_medium=social&utm_campaign=launch&foo=1",
  );
  assert.deepEqual(utm, {
    utm_source: "ph",
    utm_medium: "social",
    utm_campaign: "launch",
  });
  assert.equal(JSON.stringify(utm).includes("foo"), false);
  assert.deepEqual(parseUtms("https://solenta.app/?utm_source=bad value"), {});
});

test("POST /e stores country browser utm and never IP or UA", async (t) => {
  resetHits();
  const port = await listen();
  const db = fakeDb();
  setDb(db);
  t.after(() => {
    server.close();
    setDb(null);
  });
  const res = await post(
    port,
    {
      n: "pageview",
      u: "https://solenta.app/?utm_source=ph&utm_medium=social&foo=1",
      r: "",
    },
    {
      "cf-ipcountry": "NL",
      "user-agent": "Mozilla/5.0 Edg/120.0",
    },
  );
  assert.equal(res.status, 204);
  const insert = db.calls.find((c) => /INSERT INTO events/i.test(c.sql));
  const props = JSON.parse(insert.params[4]);
  assert.equal(props.country, "NL");
  assert.equal(props.browser, "Edge");
  assert.equal(props.utm_source, "ph");
  assert.equal(props.utm_medium, "social");
  assert.equal(props.foo, undefined);
  const blob = JSON.stringify(insert.params);
  assert.equal(blob.includes("203.0.113.10"), false);
  assert.equal(blob.includes("Mozilla/5.0"), false);
  assert.equal(blob.includes("Edg/120"), false);
});

test("POST /e omits XX country and still inserts", async (t) => {
  resetHits();
  const port = await listen();
  const db = fakeDb();
  setDb(db);
  t.after(() => {
    server.close();
    setDb(null);
  });
  assert.equal((await post(port, PAGE, { "cf-ipcountry": "XX" })).status, 204);
  const props = JSON.parse(db.events[0].props);
  assert.equal(props.country, undefined);
});
