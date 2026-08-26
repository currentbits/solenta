"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { Readable, PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const { startWebServer, pipeArtifactStream } = require("../webServer.js");

const ARTIFACT_SECURITY_HEADERS = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function assertArtifactSecurityHeaders(headers, msg = "") {
  for (const [key, value] of Object.entries(ARTIFACT_SECURITY_HEADERS)) {
    assert.equal(headers[key], value, `${msg}${key}`);
  }
}

function httpRequest(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("web run-artifacts route", () => {
  let tmp;
  let server;
  let token;
  let artifactPath;
  let artifactStore;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-web-artifacts-"));
    token = "test-token-value";
    artifactPath = path.join(tmp, "artifact.bin");
    fs.writeFileSync(artifactPath, Buffer.from("0123456789"));

    artifactStore = {
      open: async ({ id, threadId }) => {
        if (id !== "art1" || threadId !== "t1") return null;
        return {
          info: { mimeType: "application/octet-stream" },
          path: artifactPath,
          size: 10,
        };
      },
    };

    const staticDir = path.join(tmp, "static");
    fs.mkdirSync(staticDir);
    fs.writeFileSync(
      path.join(staticDir, "index.html"),
      "<!doctype html><html><body>spa</body></html>",
    );

    server = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      token,
      ctx: {},
      staticDir,
      artifactStore,
    });
  });

  afterEach(async () => {
    if (server) await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function url(pathname, query = "") {
    const port = server.port;
    return `http://127.0.0.1:${port}${pathname}${query}`;
  }

  it("requires a valid token", async () => {
    const noToken = await httpRequest(url("/api/run-artifacts/t1/art1"));
    assert.equal(noToken.status, 401);
    assertArtifactSecurityHeaders(noToken.headers, "no token ");

    const wrongToken = await httpRequest(
      url("/api/run-artifacts/t1/art1", "?token=wrong"),
    );
    assert.equal(wrongToken.status, 401);
    assertArtifactSecurityHeaders(wrongToken.headers, "wrong token ");
  });

  it("returns 404 for wrong thread", async () => {
    const res = await httpRequest(
      url("/api/run-artifacts/t2/art1", `?token=${encodeURIComponent(token)}`),
    );
    assert.equal(res.status, 404);
    assertArtifactSecurityHeaders(res.headers);
  });

  it("serves full content and HEAD without bytes", async () => {
    const get = await httpRequest(
      url("/api/run-artifacts/t1/art1", `?token=${encodeURIComponent(token)}`),
    );
    assert.equal(get.status, 200);
    assert.equal(get.headers["content-type"], "application/octet-stream");
    assert.equal(get.headers["accept-ranges"], "bytes");
    assert.equal(get.headers["content-length"], "10");
    assertArtifactSecurityHeaders(get.headers);
    assert.equal(get.body.toString(), "0123456789");

    const head = await httpRequest(
      url("/api/run-artifacts/t1/art1", `?token=${encodeURIComponent(token)}`),
      { method: "HEAD" },
    );
    assert.equal(head.status, 200);
    assert.equal(head.headers["content-length"], "10");
    assert.equal(head.body.length, 0);
    assertArtifactSecurityHeaders(head.headers);

    const headRange = await httpRequest(
      url("/api/run-artifacts/t1/art1", `?token=${encodeURIComponent(token)}`),
      { method: "HEAD", headers: { Range: "bytes=2-5" } },
    );
    assert.equal(headRange.status, 206);
    assert.equal(headRange.headers["content-length"], "4");
    assert.equal(headRange.headers["content-range"], "bytes 2-5/10");
    assert.equal(headRange.body.length, 0);
    assertArtifactSecurityHeaders(headRange.headers);
  });

  it("serves byte ranges and rejects unsatisfiable ranges", async () => {
    const ranged = await httpRequest(
      url("/api/run-artifacts/t1/art1", `?token=${encodeURIComponent(token)}`),
      { headers: { Range: "bytes=2-5" } },
    );
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers["content-type"], "application/octet-stream");
    assert.equal(ranged.headers["accept-ranges"], "bytes");
    assert.equal(ranged.headers["content-length"], "4");
    assert.equal(ranged.headers["content-range"], "bytes 2-5/10");
    assert.equal(ranged.body.toString(), "2345");

    const unsatisfiable = await httpRequest(
      url("/api/run-artifacts/t1/art1", `?token=${encodeURIComponent(token)}`),
      { headers: { Range: "bytes=20-30" } },
    );
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers["content-type"], "application/octet-stream");
    assert.equal(unsatisfiable.headers["accept-ranges"], "bytes");
    assert.equal(unsatisfiable.headers["content-length"], "0");
    assert.equal(unsatisfiable.headers["content-range"], "bytes */10");
    assertArtifactSecurityHeaders(unsatisfiable.headers);
  });

  it("serves zero-byte artifacts without opening a read stream", async () => {
    const emptyPath = path.join(tmp, "empty.bin");
    fs.writeFileSync(emptyPath, "");
    let streamOpened = false;
    artifactStore.open = async ({ id, threadId }) => {
      if (id !== "empty" || threadId !== "t1") return null;
      return {
        info: { mimeType: "application/octet-stream" },
        path: emptyPath,
        size: 0,
      };
    };

    await server.close();
    server = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      token,
      ctx: {},
      staticDir: path.join(tmp, "static"),
      artifactStore,
      createReadStream: (...args) => {
        streamOpened = true;
        return fs.createReadStream(...args);
      },
    });

    const res = await httpRequest(
      url("/api/run-artifacts/t1/empty", `?token=${encodeURIComponent(token)}`),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-length"], "0");
    assert.equal(res.body.length, 0);
    assert.equal(streamOpened, false);
    assertArtifactSecurityHeaders(res.headers);
  });

  it("returns 503 when artifact store is absent", async () => {
    await server.close();
    server = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      token,
      ctx: {},
      staticDir: path.join(tmp, "static"),
      artifactStore: null,
    });

    const res = await httpRequest(
      url("/api/run-artifacts/t1/art1", `?token=${encodeURIComponent(token)}`),
    );
    assert.equal(res.status, 503);
    assertArtifactSecurityHeaders(res.headers);
    assert.notEqual(res.body.toString(), "<!doctype html><html><body>spa</body></html>");
  });

  it("returns a generic 500 when artifactStore.open rejects", async () => {
    artifactStore.open = async () => {
      throw new Error("/secret/host/path failed");
    };
    const res = await httpRequest(
      url("/api/run-artifacts/t1/art1", `?token=${encodeURIComponent(token)}`),
    );
    assert.equal(res.status, 500);
    assertArtifactSecurityHeaders(res.headers);
    assert.equal(res.body.toString(), "");
    assert.doesNotMatch(res.body.toString(), /secret|host|path/i);
  });

  it("destroys the source stream on client abort", async () => {
    let destroyed = false;
    const stream = new Readable({
      read() {
        this.push("chunk");
      },
    });
    const origDestroy = stream.destroy.bind(stream);
    stream.destroy = (...args) => {
      destroyed = true;
      return origDestroy(...args);
    };

    const req = new EventEmitter();
    const res = new PassThrough();

    const pumping = pipeArtifactStream(req, res, stream);
    req.emit("aborted");
    await pumping;

    assert.equal(destroyed, true);
  });

  it("completes with 500 when the source stream errors after open", async () => {
    const missingPath = path.join(tmp, "missing-after-open.bin");
    artifactStore.open = async ({ id, threadId }) => {
      if (id !== "art1" || threadId !== "t1") return null;
      return {
        info: { mimeType: "application/octet-stream" },
        path: missingPath,
        size: 10,
      };
    };

    const res = await httpRequest(
      url("/api/run-artifacts/t1/art1", `?token=${encodeURIComponent(token)}`),
    );
    assert.equal(res.status, 500);
    assertArtifactSecurityHeaders(res.headers);
    assert.equal(res.body.toString(), "");
  });

  it("does not fall back to the SPA for artifact routes", async () => {
    const res = await httpRequest(
      url("/api/run-artifacts/t1/missing", `?token=${encodeURIComponent(token)}`),
    );
    assert.equal(res.status, 404);
    assert.notEqual(res.body.toString(), "<!doctype html><html><body>spa</body></html>");
  });
});
