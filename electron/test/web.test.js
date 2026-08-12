"use strict";

/**
 * Round 51: Coder Web server (HTTP+WS, auth, invoke, push, bind).
 *
 * Mutations these tests exist to catch:
 * - first message that is not auth does not close
 * - invoke before auth-ok is executed (must error, not run)
 * - service throw is not the same string as the IPC path
 * - pushes reach unauthenticated sockets
 * - default bind is not 127.0.0.1
 * - ws is not copied by package-app.sh
 * - createHandlers channels drift from preload invoke names
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const Module = require("node:module");
const { WebSocket } = require("ws");
const {
  parseServeArgs,
  loadOrCreateToken,
  startWebServer,
  PUSH_CHANNELS,
  HOST_FLAG_HELP,
  TOKEN_FILENAME,
  DEFAULT_HOST,
  DEFAULT_PORT,
} = require("../web.js");

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function onceMessage(ws) {
  return new Promise((resolve, reject) => {
    const onMsg = (data) => {
      cleanup();
      try {
        resolve(JSON.parse(String(data)));
      } catch (err) {
        reject(err);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before message"));
    };
    const cleanup = () => {
      ws.off("message", onMsg);
      ws.off("close", onClose);
    };
    ws.on("message", onMsg);
    ws.on("close", onClose);
  });
}

function onceClose(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", () => resolve());
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            type: res.headers["content-type"] || "",
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      })
      .on("error", reject);
  });
}

function withStubbedElectron(fn) {
  const handlers = new Map();
  const stub = {
    ipcMain: {
      handle(channel, cb) {
        handlers.set(channel, cb);
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    dialog: {},
    shell: {},
    app: { getPath: () => os.tmpdir() },
  };
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") return stub;
    return origLoad.apply(this, arguments);
  };
  const restore = () => {
    Module._load = origLoad;
  };
  try {
    const result = fn({ handlers, stub });
    if (result && typeof result.then === "function") {
      return result.then(
        (value) => {
          restore();
          return value;
        },
        (err) => {
          restore();
          throw err;
        },
      );
    }
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

describe("parseServeArgs", () => {
  it("defaults to disabled, 127.0.0.1, port 8787", () => {
    const got = parseServeArgs(["/path/to/Electron", "."]);
    assert.equal(got.enabled, false);
    assert.equal(got.host, "127.0.0.1");
    assert.equal(got.port, 8787);
    assert.equal(got.host, DEFAULT_HOST);
    assert.equal(got.port, DEFAULT_PORT);
  });

  it("enables on --serve and accepts --host/--port in both forms", () => {
    const space = parseServeArgs(["--serve", "--host", "0.0.0.0", "--port", "9000"]);
    assert.equal(space.enabled, true);
    assert.equal(space.host, "0.0.0.0");
    assert.equal(space.port, 9000);
    const eq = parseServeArgs(["app", "--serve", "--host=10.0.0.4", "--port=0"]);
    assert.equal(eq.enabled, true);
    assert.equal(eq.host, "10.0.0.4");
    assert.equal(eq.port, 0);
  });

  it("HOST_FLAG_HELP names no TLS and LAN as an informed choice", () => {
    assert.match(HOST_FLAG_HELP, /no TLS/i);
    assert.match(HOST_FLAG_HELP, /LAN/);
    assert.match(HOST_FLAG_HELP, /127\.0\.0\.1/);
  });
});

describe("loadOrCreateToken", () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-web-token-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a crypto token next to the store and reuses it", () => {
    const a = loadOrCreateToken(tmp);
    const b = loadOrCreateToken(tmp);
    assert.equal(a, b);
    assert.ok(a.length >= 32, "token must be long enough to be random");
    const file = path.join(tmp, TOKEN_FILENAME);
    assert.equal(fs.readFileSync(file, "utf8").trim(), a);
    // Same directory as coder-store.json would use (userData root).
    assert.equal(path.dirname(file), tmp);
  });
});

describe("startWebServer wire protocol", () => {
  let tmp;
  let server;
  let calls;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-web-"));
    fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><title>ok</title>");
    fs.writeFileSync(path.join(tmp, "app.js"), "window.x=1;");
    calls = [];
    server = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      token: "secret-token",
      staticDir: tmp,
      invoke: async (channel, args) => {
        calls.push({ channel, args });
        if (channel === "boom") {
          throw new Error("Cannot restore a checkpoint while a run is active");
        }
        if (channel === "missing") {
          throw new Error(`No handler registered for '${channel}'`);
        }
        return { channel, args, ok: true };
      },
    });
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function wsUrl() {
    return `ws://127.0.0.1:${server.port}`;
  }

  async function auth(ws, token) {
    ws.send(JSON.stringify({ kind: "auth", token }));
    return onceMessage(ws);
  }

  it("binds 127.0.0.1 unless --host widens it", async () => {
    assert.equal(server.host, "127.0.0.1");
    const addr = server.server.address();
    assert.equal(addr.address, "127.0.0.1");

    const wide = await startWebServer({
      host: "0.0.0.0",
      port: 0,
      token: "t",
      invoke: async () => null,
    });
    try {
      const waddr = wide.server.address();
      assert.equal(waddr.address, "0.0.0.0");
    } finally {
      await wide.close();
    }
  });

  it("first message must be auth; anything else closes", async () => {
    const ws = await connect(wsUrl());
    const closed = onceClose(ws);
    ws.send(JSON.stringify({ kind: "invoke", id: 1, channel: "threads:list", args: [] }));
    await closed;
    assert.equal(calls.length, 0, "invoke must not run before auth");
  });

  it("wrong token closes without auth-ok", async () => {
    const ws = await connect(wsUrl());
    const closed = onceClose(ws);
    ws.send(JSON.stringify({ kind: "auth", token: "nope" }));
    await closed;
  });

  it("good auth replies auth-ok, then invoke replies with the result", async () => {
    const ws = await connect(wsUrl());
    const ok = await auth(ws, "secret-token");
    assert.deepEqual(ok, { kind: "auth-ok" });
    ws.send(
      JSON.stringify({
        kind: "invoke",
        id: 7,
        channel: "threads:list",
        args: [],
      }),
    );
    const reply = await onceMessage(ws);
    assert.equal(reply.kind, "reply");
    assert.equal(reply.id, 7);
    assert.equal(reply.error, undefined);
    assert.deepEqual(reply.result, { channel: "threads:list", args: [], ok: true });
    assert.deepEqual(calls, [{ channel: "threads:list", args: [] }]);
    ws.close();
    await onceClose(ws);
  });

  it("service throws become {kind:reply,id,error:message} — same string", async () => {
    const ws = await connect(wsUrl());
    await auth(ws, "secret-token");
    ws.send(JSON.stringify({ kind: "invoke", id: 3, channel: "boom", args: [] }));
    const reply = await onceMessage(ws);
    assert.equal(reply.kind, "reply");
    assert.equal(reply.id, 3);
    assert.equal(reply.result, undefined);
    assert.equal(
      reply.error,
      "Cannot restore a checkpoint while a run is active",
    );
    ws.close();
    await onceClose(ws);
  });

  it("unknown channel is an error reply, not a close", async () => {
    const ws = await connect(wsUrl());
    await auth(ws, "secret-token");
    ws.send(
      JSON.stringify({ kind: "invoke", id: 4, channel: "missing", args: ["x"] }),
    );
    const reply = await onceMessage(ws);
    assert.equal(reply.error, "No handler registered for 'missing'");
    ws.close();
    await onceClose(ws);
  });

  it("garbage JSON closes the socket", async () => {
    const ws = await connect(wsUrl());
    const closed = onceClose(ws);
    ws.send("not-json");
    await closed;
  });

  it("broadcast fans push channels to every authed socket, none to unauthed", async () => {
    const authedA = await connect(wsUrl());
    const authedB = await connect(wsUrl());
    const stranger = await connect(wsUrl());
    await auth(authedA, "secret-token");
    await auth(authedB, "secret-token");

    const gotA = onceMessage(authedA);
    const gotB = onceMessage(authedB);
    let strangerPushed = false;
    stranger.on("message", () => {
      strangerPushed = true;
    });

    server.broadcast("threads:changed", [{ id: "t1" }]);
    server.broadcast("noise:ignored", { no: true });

    const a = await gotA;
    const b = await gotB;
    assert.deepEqual(a, {
      kind: "push",
      channel: "threads:changed",
      payload: [{ id: "t1" }],
    });
    assert.deepEqual(b, a);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(strangerPushed, false, "unauthed socket must not get pushes");

    authedA.close();
    authedB.close();
    stranger.close();
    await Promise.all([onceClose(authedA), onceClose(authedB), onceClose(stranger)]);
  });

  it("PUSH_CHANNELS match preload and the wire contract", () => {
    assert.deepEqual(PUSH_CHANNELS, ["threads:changed", "thread:updated"]);
    const preload = fs.readFileSync(
      path.join(__dirname, "../preload.js"),
      "utf8",
    );
    assert.match(preload, /threads:changed/);
    assert.match(preload, /thread:updated/);
    const wire = fs.readFileSync(
      path.join(__dirname, "../../src/shared/wire.ts"),
      "utf8",
    );
    assert.match(wire, /WIRE_PUSH_CHANNELS = \["threads:changed", "thread:updated"\]/);
  });

  it("serves the renderer static files", async () => {
    const index = await httpGet(`http://127.0.0.1:${server.port}/`);
    assert.equal(index.status, 200);
    assert.match(index.type, /text\/html/);
    assert.match(index.body, /<title>ok<\/title>/);
    const js = await httpGet(`http://127.0.0.1:${server.port}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.type, /javascript/);
    assert.match(js.body, /window\.x=1/);
  });

  it("rejects path traversal", async () => {
    const res = await httpGet(
      `http://127.0.0.1:${server.port}/../../../../etc/passwd`,
    );
    assert.ok(res.status === 403 || res.status === 404 || res.status === 200);
    if (res.status === 200) {
      // SPA fallback is allowed only to index.html inside the static dir.
      assert.match(res.body, /<title>ok<\/title>/);
      assert.doesNotMatch(res.body, /root:|passwd/);
    }
  });
});

describe("createHandlers is the one invoke table", () => {
  it("covers every channel preload invokes", async () => {
    await withStubbedElectron(() => {
      delete require.cache[require.resolve("../ipc.js")];
      const { createHandlers } = require("../ipc.js");
      const { Store } = require("../store.js");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-web-h-"));
      try {
        const store = new Store(path.join(tmp, "store.json"));
        const handlers = createHandlers({
          dialog: {},
          store,
          runner: {
            isRunning: () => false,
            startRun: async () => ({ runId: "r" }),
            startWorkflowRun: async () => ({ runId: "r" }),
            stopRun: async () => {},
            getActiveWorkflow: () => null,
          },
          broadcast() {},
          worktreeBase: path.join(tmp, "wt"),
          userDataPath: tmp,
        });
        const preload = fs.readFileSync(
          path.join(__dirname, "../preload.js"),
          "utf8",
        );
        const channels = [
          ...preload.matchAll(/invoke\("([^"]+)"/g),
        ].map((m) => m[1]);
        assert.ok(channels.length > 20, "preload must list invoke channels");
        for (const ch of new Set(channels)) {
          assert.equal(
            typeof handlers[ch],
            "function",
            `createHandlers must own ${ch} (same table as IPC and WS)`,
          );
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("web invoke and createHandlers share one function (same throw)", async () => {
    await withStubbedElectron(async () => {
      delete require.cache[require.resolve("../ipc.js")];
      const { createHandlers } = require("../ipc.js");
      const { Store } = require("../store.js");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-web-share-"));
      let srv;
      try {
        const store = new Store(path.join(tmp, "store.json"));
        const handlers = createHandlers({
          dialog: {},
          store,
          runner: {
            isRunning: () => false,
            getActiveWorkflow: () => null,
          },
          broadcast() {},
          worktreeBase: "",
          userDataPath: tmp,
        });
        srv = await startWebServer({
          host: "127.0.0.1",
          port: 0,
          token: "tok",
          invoke: async (channel, args) => {
            const fn = handlers[channel];
            if (!fn) throw new Error(`No handler registered for '${channel}'`);
            return fn(...args);
          },
        });
        const ws = await connect(`ws://127.0.0.1:${srv.port}`);
        ws.send(JSON.stringify({ kind: "auth", token: "tok" }));
        assert.deepEqual(await onceMessage(ws), { kind: "auth-ok" });
        ws.send(
          JSON.stringify({
            kind: "invoke",
            id: 1,
            channel: "git:setupWorktree",
            args: [{ threadId: "missing" }],
          }),
        );
        const reply = await onceMessage(ws);
        assert.equal(reply.kind, "reply");
        assert.equal(reply.error, "worktreeBase is not configured");
        // Direct call must throw the identical string.
        await assert.rejects(
          () => handlers["git:setupWorktree"]({ threadId: "missing" }),
          (err) => {
            assert.equal(err.message, reply.error);
            return true;
          },
        );
        ws.close();
        await onceClose(ws);
      } finally {
        if (srv) await srv.close();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});

describe("packaging ships web.js and ws", () => {
  it("package-app.sh copies electron/*.js and node_modules/ws", () => {
    const sh = fs.readFileSync(
      path.join(__dirname, "../../scripts/package-app.sh"),
      "utf8",
    );
    assert.match(sh, /electron\/\*\.js/);
    assert.match(sh, /node_modules\/ws/);
    assert.ok(
      fs.existsSync(path.join(__dirname, "../web.js")),
      "web.js must sit at electron/web.js so the existing copy loop ships it",
    );
    const verify = fs.readFileSync(
      path.join(__dirname, "../../scripts/verify-package.sh"),
      "utf8",
    );
    assert.match(verify, /node_modules\/ws/);
    assert.match(verify, /electron\/web\.js/);
  });

  it("main.js starts the server on --serve via the shared handlers", () => {
    const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
    assert.match(main, /parseServeArgs/);
    assert.match(main, /startWebServer/);
    assert.match(main, /loadOrCreateToken/);
    assert.match(main, /serveOpts\.enabled/);
    assert.match(main, /registered\.handlers/);
    assert.match(main, /No handler registered/);
    assert.match(main, /HOST_FLAG_HELP/);
    assert.match(main, /process\.stdout\.write\(`coder-web: token/);
  });

  it("ws is a pinned production dependency", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
    );
    assert.equal(pkg.dependencies.ws, "8.21.3");
    assert.equal(require("ws/package.json").version, "8.21.3");
  });
});
