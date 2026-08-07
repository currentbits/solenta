/**
 * appStatus's real /health socket path (below the deps.health seam).
 *
 * These pin the three hardening rules that a live probe proved but no test held:
 * an absolute deadline, a body cap, and non-200 not counting as health. Without
 * them a misbehaving local memory server can wedge or balloon the status call.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { Store } = require("../store.js");
const services = require("../services.js");
const { resetMemorySupForTests } = require("../memory-sup.js");

/** @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler */
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port }),
    );
  });
}

describe("appStatus /health transport", () => {
  let dir;
  let store;
  /** @type {http.Server | null} */
  let server = null;
  /** Timers a fake server armed; cleared centrally so an aborted test cannot
      leave the event loop alive and hang the whole run. */
  const timers = [];

  beforeEach(() => {
    resetMemorySupForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-health-"));
    store = new Store(path.join(dir, "store.json"));
  });

  afterEach(() => {
    for (const t of timers.splice(0)) clearInterval(t);
    if (server) {
      // close() alone leaves established sockets open, which keeps node alive.
      server.closeAllConnections();
      server.close();
    }
    server = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** @param {number} port */
  const statusFor = (port) =>
    services.appStatus(store, {
      status: () => ({ running: true, adopted: false, port }),
    });

  it("reads counts and janitor errors over a real socket", async () => {
    const started = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          entryCount: 42,
          vectors: { count: 40 },
          janitor: { lastError: { step: "embed", message: "model missing" } },
        }),
      );
    });
    server = started.server;

    const status = await statusFor(started.port);
    assert.equal(status.memory.entries, 42);
    assert.equal(status.memory.vectors, 40);
    assert.equal(status.memory.lastError, "embed: model missing");
  });

  it("gives up on a dribbling server instead of hanging forever", async () => {
    // Socket `timeout` is INACTIVITY: a byte every 400ms resets it forever.
    const started = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      timers.push(setInterval(() => res.write(" "), 400));
    });
    server = started.server;

    // Race rather than await: with the deadline gone the status promise never
    // settles, and a test that awaits it would hang the run instead of failing.
    const t0 = Date.now();
    let guard;
    const status = await Promise.race([
      statusFor(started.port),
      new Promise((r) => {
        guard = setTimeout(() => r("NEVER_SETTLED"), 5000);
        timers.push(guard);
      }),
    ]);
    clearTimeout(guard);

    assert.notEqual(
      status,
      "NEVER_SETTLED",
      "absolute deadline must bound the wait on a dribbling server",
    );
    assert.equal(status.memory.entries, null);
    assert.ok(Date.now() - t0 < 4000, "must give up in about 2s");
  });

  it("does not accept a 500 whose body happens to be JSON", async () => {
    const started = await listen((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ entryCount: 99, vectors: { count: 5 } }));
    });
    server = started.server;

    const status = await statusFor(started.port);
    assert.equal(status.memory.entries, null);
    assert.equal(status.memory.vectors, null);
  });

  it("refuses to buffer a runaway body", async () => {
    // The payload must be VALID JSON and otherwise healthy, or the assertion
    // passes for the wrong reason: garbage fails JSON.parse with or without
    // the cap, so only a parseable giant proves the cap is what rejected it.
    const started = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          entryCount: 7,
          vectors: { count: 7 },
          pad: "x".repeat(400 * 1024),
        }),
      );
    });
    server = started.server;

    const status = await statusFor(started.port);
    assert.equal(
      status.memory.entries,
      null,
      "a 400KB health document must be refused, not parsed",
    );
  });

  it("never rejects on an unreachable or invalid port", async () => {
    for (const port of [1, 99999, 0]) {
      const status = await statusFor(port);
      assert.equal(status.memory.entries, null);
      assert.equal(status.memory.running, true, "status still reports the port");
    }
  });
});
