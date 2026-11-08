"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { waitDataQuiescent, probeMemoryListener } = require("../server/dataQuiescence.js");
function directory(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-quiescent-"));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  fs.writeFileSync(path.join(data, "memory-server.json"), JSON.stringify({ port: 43210, token: "fixture-token" }));
  return data;
}
it("waits for delayed memory child exit before permitting a cold copy", async (t) => {
  const data = directory(t); let calls = 0;
  await waitDataQuiescent(data, { timeout: 100, interval: 1, probe: async () => ++calls >= 3 ? "closed" : "serving" });
  assert.equal(calls, 3);
});
it("persistent or unverifiable writers refuse a cold copy within a bounded wait", async (t) => {
  const data = directory(t);
  for (const state of ["serving", "unknown"]) await assert.rejects(waitDataQuiescent(data, { timeout: 10, interval: 1, probe: async () => state }), /No data snapshot or restoration was attempted/);
});
it("a data directory without a memory configuration needs no listener probe", async (t) => {
  const data = directory(t); fs.unlinkSync(path.join(data, "memory-server.json"));
  await waitDataQuiescent(data, { probe: () => assert.fail("no configured writer") });
});
it("health proof sends a nonce without credentials and waits until the real listener closes", async (t) => {
  const token = "private-fixture-token"; const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    const nonce = new URL(req.url, "http://127.0.0.1").searchParams.get("nonce");
    res.end(JSON.stringify({ ok: true, proof: crypto.createHmac("sha256", token).update(nonce).digest("hex") }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = { port: server.address().port, token };
  assert.equal(await probeMemoryListener(config), "serving");
  assert.equal(requests[0].authorization, undefined); assert.equal(requests[0].url.includes(token), false);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await probeMemoryListener(config), "closed");
});
