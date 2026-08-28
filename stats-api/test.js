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
