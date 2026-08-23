"use strict";
/** Self-check for the feedback endpoint: `node --test feedback-api/test.js`. */

const test = require("node:test");
const assert = require("node:assert");

process.env.ADMIN_TOKEN = "secret-token";
const { server, setDb, rateLimited, authorized, RATE_MAX } = require("./server");

/** Records every statement so a test can assert on what reached the database. */
function fakeDb(opts = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (opts.throws) throw new Error("connection refused");
      if (/^\s*SELECT/i.test(sql)) return { rows: opts.rows || [] };
      return { rows: [{ id: 42 }] };
    },
  };
}

function listen() {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function post(port, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/api/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("rate limit lets RATE_MAX through then blocks", () => {
  for (let i = 0; i < RATE_MAX; i++) {
    assert.equal(rateLimited("1.2.3.4"), false, `attempt ${i} should pass`);
  }
  assert.equal(rateLimited("1.2.3.4"), true);
  assert.equal(rateLimited("5.6.7.8"), false, "other IPs are unaffected");
});

test("bearer check rejects near-misses", () => {
  const req = (authorization) => ({ headers: { authorization } });
  assert.equal(authorized(req("Bearer secret-token")), true);
  assert.equal(authorized(req("Bearer secret-toke")), false, "shorter");
  assert.equal(authorized(req("Bearer secret-tokenX")), false, "longer");
  assert.equal(authorized(req("secret-token")), false, "no Bearer prefix");
  assert.equal(authorized(req("")), false);
  assert.equal(authorized({ headers: {} }), false);
});

test("stores a report and rejects junk", async (t) => {
  const port = await listen();
  const db = fakeDb();
  setDb(db);
  t.after(() => {
    server.close();
    setDb(null);
  });

  assert.equal((await post(port, { nope: 1 }, { "x-forwarded-for": "10.0.0.1" })).status, 400);
  assert.equal((await post(port, "not json", { "x-forwarded-for": "10.0.0.2" })).status, 400);
  assert.equal((await post(port, { text: "   " }, { "x-forwarded-for": "10.0.0.3" })).status, 400);
  assert.equal(db.calls.length, 0, "nothing invalid reached the database");

  const oversize = await post(
    port,
    { text: "x".repeat(20000) },
    { "x-forwarded-for": "10.0.0.4" },
  );
  assert.equal(oversize.status, 413, "an over-cap body still gets an answer");

  const res = await post(
    port,
    { text: "  the sidebar flickers  ", version: "0.11.0", platform: "darwin arm64" },
    { "x-forwarded-for": "10.0.0.5" },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, id: "42" });

  const insert = db.calls.at(-1);
  assert.match(insert.sql, /INSERT INTO feedback/);
  assert.deepEqual(insert.params, ["the sidebar flickers", "0.11.0", "darwin arm64"]);
});

test("caps the stored text rather than refusing a long-ish report", async (t) => {
  const port = await listen();
  const db = fakeDb();
  setDb(db);
  t.after(() => {
    server.close();
    setDb(null);
  });
  // Under the 8 KB body cap, over the 4000-char text cap.
  const res = await post(port, { text: "y".repeat(5000) }, { "x-forwarded-for": "10.1.0.9" });
  assert.equal(res.status, 200);
  assert.equal(db.calls.at(-1).params[0].length, 4000);
});

test("a database failure does not leak, and the text survives in the log", async (t) => {
  const port = await listen();
  setDb(fakeDb({ throws: true }));
  t.after(() => {
    server.close();
    setDb(null);
  });
  const res = await post(port, { text: "hi" }, { "x-forwarded-for": "10.0.1.1" });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "Could not store your feedback" });
});

test("GET needs the bearer token", async (t) => {
  const port = await listen();
  setDb(fakeDb({ rows: [{ id: 1, text: "hello", version: "", platform: "" }] }));
  t.after(() => {
    server.close();
    setDb(null);
  });
  const url = `http://127.0.0.1:${port}/api/feedback`;

  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (await fetch(url, { headers: { authorization: "Bearer wrong-token" } })).status,
    401,
  );

  const ok = await fetch(url, { headers: { authorization: "Bearer secret-token" } });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.count, 1);
  assert.equal(body.items[0].text, "hello");
});

test("503 rather than a crash when there is no database", async (t) => {
  const port = await listen();
  setDb(null);
  t.after(() => server.close());
  const res = await post(port, { text: "hi" }, { "x-forwarded-for": "10.0.2.1" });
  assert.equal(res.status, 503);
});
