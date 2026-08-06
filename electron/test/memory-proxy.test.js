const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createMemoryProxy } = require("../memory-proxy.js");

const TOKEN = "test-bearer-token-64chars-abcdefghijklmnopqrstuvwxyz012345";
const NOT_RUNNING = "Memory server is not running.";

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

/**
 * Fake memory HTTP server with auth + the four API endpoints.
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.token
 * @param {(req: http.IncomingMessage, body: string) => {status: number, json: unknown} | null} [opts.handler]
 * @param {boolean} [opts.hang] - never respond (for timeout tests)
 */
function startFakeServer(opts) {
  const { port, token, hang = false } = opts;
  /** @type {http.IncomingMessage[]} */
  const requests = [];

  const server = http.createServer((req, res) => {
    requests.push(req);
    if (hang) {
      // never respond; leave connection open until client times out
      return;
    }

    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      if (opts.handler) {
        const custom = opts.handler(req, body);
        if (custom) {
          res.writeHead(custom.status, { "content-type": "application/json" });
          res.end(JSON.stringify(custom.json));
          return;
        }
      }

      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/api/recent") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              id: "e-recent-1",
              type: "knowledge",
              title: "Recent camel",
              body: "excerpt recent",
              project: "proj-a",
              importance: 3,
              createdAt: "2026-08-01T10:00:00.000Z",
              updatedAt: "2026-08-02T11:00:00.000Z",
            },
            {
              id: "e-recent-2",
              type: "task",
              title: "Recent snake",
              body: "excerpt snake",
              project: null,
              importance: 2,
              created_at: "2026-08-01T12:00:00.000Z",
              updated_at: "2026-08-02T13:00:00.000Z",
            },
          ]),
        );
        return;
      }

      if (req.method === "GET" && pathname === "/api/search") {
        const q = url.searchParams.get("query") || "";
        const project = url.searchParams.get("project");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              id: "e-search-1",
              type: "convention",
              title: `Hit for ${q}`,
              body: "search excerpt",
              project: project || null,
              importance: 5,
              created_at: "2026-07-01T00:00:00.000Z",
              updated_at: "2026-07-02T00:00:00.000Z",
            },
          ]),
        );
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/api/entry/")) {
        const id = decodeURIComponent(pathname.slice("/api/entry/".length));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            type: "knowledge",
            title: "Full entry",
            body: "full body content here",
            project: "my-project",
            importance: 4,
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-02T00:00:00.000Z",
          }),
        );
        return;
      }

      if (req.method === "POST" && pathname === "/api/store") {
        let parsed = {};
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid json" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "stored-" + (parsed.title || "x") }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        requests,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
    server.on("error", reject);
  });
}

describe("memory-proxy", () => {
  let tmpDir;
  /** @type {{ running: boolean, adopted: boolean, port: number | null }} */
  let status;
  let port;
  let fake;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-memproxy-"));
    port = await freePort();
    status = { running: true, adopted: true, port };
    fs.writeFileSync(
      path.join(tmpDir, "memory-server.json"),
      JSON.stringify({
        port,
        token: TOKEN,
        dbPath: path.join(tmpDir, "mem.db"),
      }),
      "utf8",
    );
  });

  afterEach(async () => {
    if (fake) {
      await fake.close();
      fake = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function proxy(overrides = {}) {
    return createMemoryProxy({
      userDataPath: tmpDir,
      getStatus: () => status,
      timeoutMs: 5000,
      ...overrides,
    });
  }

  it("recent: happy path normalizes camelCase and snake_case timestamps", async () => {
    fake = await startFakeServer({ port, token: TOKEN });
    const p = proxy();
    const entries = await p.recent({ limit: 10 });
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
      id: "e-recent-1",
      type: "knowledge",
      title: "Recent camel",
      body: "excerpt recent",
      project: "proj-a",
      importance: 3,
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-02T11:00:00.000Z",
    });
    assert.deepEqual(entries[1], {
      id: "e-recent-2",
      type: "task",
      title: "Recent snake",
      body: "excerpt snake",
      project: null,
      importance: 2,
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-02T13:00:00.000Z",
    });
    // Auth header present
    assert.ok(fake.requests.length >= 1);
    assert.equal(fake.requests[0].headers.authorization, `Bearer ${TOKEN}`);
  });

  it("search: happy path with query and project", async () => {
    fake = await startFakeServer({ port, token: TOKEN });
    const p = proxy();
    const entries = await p.search({ query: "em dash", project: "coder" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, "e-search-1");
    assert.equal(entries[0].type, "convention");
    assert.equal(entries[0].title, "Hit for em dash");
    assert.equal(entries[0].project, "coder");
    assert.equal(entries[0].createdAt, "2026-07-01T00:00:00.000Z");
    assert.equal(entries[0].updatedAt, "2026-07-02T00:00:00.000Z");
    assert.equal(typeof entries[0].importance, "number");
    assert.equal(typeof entries[0].body, "string");
  });

  it("get: returns full-body MemoryEntryInfo", async () => {
    fake = await startFakeServer({ port, token: TOKEN });
    const p = proxy();
    const entry = await p.get({ id: "entry-42" });
    assert.deepEqual(entry, {
      id: "entry-42",
      type: "knowledge",
      title: "Full entry",
      body: "full body content here",
      project: "my-project",
      importance: 4,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
    });
  });

  it("store: posts JSON and returns { id }", async () => {
    let capturedBody = null;
    fake = await startFakeServer({
      port,
      token: TOKEN,
      handler(req, body) {
        if (req.method === "POST" && (req.url || "").startsWith("/api/store")) {
          capturedBody = JSON.parse(body);
          return { status: 200, json: { id: "new-id-99" } };
        }
        return null;
      },
    });
    const p = proxy();
    const result = await p.store({
      type: "knowledge",
      title: "A fact",
      body: "durable detail",
      project: "my-proj",
    });
    assert.deepEqual(result, { id: "new-id-99" });
    assert.deepEqual(capturedBody, {
      type: "knowledge",
      title: "A fact",
      body: "durable detail",
      project: "my-proj",
    });
  });

  it("sends Authorization: Bearer <token> on every request", async () => {
    fake = await startFakeServer({ port, token: TOKEN });
    const p = proxy();
    await p.recent();
    await p.search({ query: "x" });
    await p.get({ id: "1" });
    await p.store({ type: "run", title: "t", body: "b" });
    assert.ok(fake.requests.length >= 4);
    for (const req of fake.requests) {
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    }
  });

  it("rejects with exact not-running message when status.running is false", async () => {
    fake = await startFakeServer({ port, token: TOKEN });
    status = { running: false, adopted: false, port: null };
    const p = proxy();
    await assert.rejects(() => p.recent(), { message: NOT_RUNNING });
    await assert.rejects(() => p.search({ query: "q" }), {
      message: NOT_RUNNING,
    });
    await assert.rejects(() => p.get({ id: "1" }), { message: NOT_RUNNING });
    await assert.rejects(
      () => p.store({ type: "run", title: "t", body: "b" }),
      { message: NOT_RUNNING },
    );
  });

  it("rejects with exact not-running message when config is missing", async () => {
    fake = await startFakeServer({ port, token: TOKEN });
    fs.rmSync(path.join(tmpDir, "memory-server.json"));
    const p = proxy();
    await assert.rejects(() => p.recent(), { message: NOT_RUNNING });
  });

  it("rejects on request timeout", async () => {
    fake = await startFakeServer({ port, token: TOKEN, hang: true });
    const p = proxy({ timeoutMs: 80 });
    await assert.rejects(() => p.recent({ limit: 1 }), (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        /timeout|timed out|ETIMEDOUT|aborted/i.test(err.message) ||
          err.message === NOT_RUNNING,
        `unexpected timeout error: ${err.message}`,
      );
      return true;
    });
  });

  it("propagates server {error} on non-2xx", async () => {
    fake = await startFakeServer({
      port,
      token: TOKEN,
      handler(req) {
        if ((req.url || "").startsWith("/api/search")) {
          return { status: 400, json: { error: "query too short" } };
        }
        return null;
      },
    });
    const p = proxy();
    await assert.rejects(() => p.search({ query: "x" }), {
      message: "query too short",
    });
  });

  it("never throws synchronously", () => {
    status = { running: false, adopted: false, port: null };
    const p = proxy();
    // Calling must return a Promise, not throw
    let threw = false;
    let ret;
    try {
      ret = p.search({ query: "q" });
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
    assert.ok(ret && typeof ret.then === "function");
    // drain rejection
    return ret.then(
      () => assert.fail("expected reject"),
      (err) => assert.equal(err.message, NOT_RUNNING),
    );
  });
});
