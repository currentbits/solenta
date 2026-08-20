"use strict";

/**
 * Round 51: Solenta Web server (webBridge + webServer).
 *
 * Auth table, invoke vs real services, error-string parity, push fan-out,
 * static serve, token 0600, no-flag port probe.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");
const { WebSocket } = require("ws");

// ipc.js requires("electron") at load. This machine's Electron postinstall is
// often a stub, so install a process-wide mock BEFORE loading web modules.
{
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") {
      return {
        ipcMain: { handle() {} },
        BrowserWindow: { getAllWindows: () => [] },
        dialog: {},
        shell: {},
        app: { getPath: () => os.tmpdir() },
      };
    }
    return origLoad.apply(this, arguments);
  };
}

const {
  parseServeWebArgs,
  loadOrCreateToken,
  startWebServer,
  TOKEN_FILENAME,
  DEFAULT_HOST,
  DEFAULT_PORT,
  HOST_FLAG_HELP,
} = require("../webServer.js");
const { WS_PATH, attachWebBridge } = require("../webBridge.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

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

function dummyRunner() {
  return {
    isRunning: () => false,
    startRun: async () => ({ runId: "r" }),
    startWorkflowRun: async () => ({ runId: "r" }),
    stopRun: async () => {},
    getActiveWorkflow: () => null,
  };
}

describe("parseServeWebArgs", () => {
  it("defaults to disabled, 127.0.0.1, port 4620", () => {
    const got = parseServeWebArgs(["/path/to/Electron", "."]);
    assert.equal(got.enabled, false);
    assert.equal(got.host, "127.0.0.1");
    assert.equal(got.port, 4620);
    assert.equal(got.host, DEFAULT_HOST);
    assert.equal(got.port, DEFAULT_PORT);
  });

  it("enables on --serve-web[=port] and --serve-host", () => {
    const bare = parseServeWebArgs(["--serve-web"]);
    assert.equal(bare.enabled, true);
    assert.equal(bare.port, 4620);
    const eq = parseServeWebArgs(["app", "--serve-web=9000", "--serve-host=0.0.0.0"]);
    assert.equal(eq.enabled, true);
    assert.equal(eq.port, 9000);
    assert.equal(eq.host, "0.0.0.0");
    const space = parseServeWebArgs(["--serve-web", "--serve-host", "10.0.0.4"]);
    assert.equal(space.enabled, true);
    assert.equal(space.host, "10.0.0.4");
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

  it("persists userData/web-token at 0600 and reuses it", () => {
    const a = loadOrCreateToken(tmp);
    const b = loadOrCreateToken(tmp);
    assert.equal(a, b);
    assert.ok(a.length >= 32);
    const file = path.join(tmp, TOKEN_FILENAME);
    assert.equal(TOKEN_FILENAME, "web-token");
    assert.equal(fs.readFileSync(file, "utf8").trim(), a);
    assert.equal(path.dirname(file), tmp);
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });
});

describe("auth table + invoke + push (real socket)", () => {
  let tmp;
  let server;
  let ctx;
  let store;
  let services;

  beforeEach(async () => {
    await withStubbedElectron(async () => {
      delete require.cache[require.resolve("../ipc.js")];
      const ipc = require("../ipc.js");
      services = require("../services.js");
      const { Store } = require("../store.js");
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-web-"));
      fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><title>web-ok</title>");
      fs.writeFileSync(path.join(tmp, "app.js"), "window.x=1;");
      const repo = path.join(tmp, "repo");
      fs.mkdirSync(repo);
      git(repo, ["init"]);
      git(repo, ["config", "user.email", "t@example.com"]);
      git(repo, ["config", "user.name", "t"]);
      fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
      git(repo, ["add", "README.md"]);
      git(repo, ["commit", "-m", "init"]);
      store = new Store(path.join(tmp, "store.json"));
      const project = await services.addProject(store, repo);
      services.createThread(store, { projectId: project.id, title: "alpha" });
      ctx = ipc.makeCtx({
        dialog: {},
        store,
        runner: dummyRunner(),
        broadcast() {},
        worktreeBase: "",
        userDataPath: tmp,
      });
      server = await startWebServer({
        host: "127.0.0.1",
        port: 0,
        token: "secret-token",
        ctx,
        handlers: ipc.IPC_HANDLERS,
        staticDir: tmp,
      });
    });
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function wsUrl() {
    return `ws://127.0.0.1:${server.port}${WS_PATH}`;
  }

  it("auth table: good → auth-ok; bad → close; invoke-first → error + drop", async () => {
    const good = await connect(wsUrl());
    good.send(JSON.stringify({ kind: "auth", token: "secret-token" }));
    assert.deepEqual(await onceMessage(good), { kind: "auth-ok" });
    good.close();
    await onceClose(good);

    const bad = await connect(wsUrl());
    const badClosed = onceClose(bad);
    bad.send(JSON.stringify({ kind: "auth", token: "nope" }));
    await badClosed;

    const first = await connect(wsUrl());
    const closed = onceClose(first);
    let reply = null;
    first.on("message", (data) => {
      reply = JSON.parse(String(data));
    });
    first.send(
      JSON.stringify({ kind: "invoke", id: 1, channel: "threads:list", args: [] }),
    );
    await closed;
    assert.ok(reply, "invoke-first must get an error reply before drop");
    assert.equal(reply.kind, "reply");
    assert.equal(reply.id, 1);
    assert.equal(reply.error, "Not authenticated");
  });

  it("threads:list over the socket equals services.listThreads", async () => {
    const ws = await connect(wsUrl());
    ws.send(JSON.stringify({ kind: "auth", token: "secret-token" }));
    assert.deepEqual(await onceMessage(ws), { kind: "auth-ok" });
    ws.send(
      JSON.stringify({ kind: "invoke", id: 9, channel: "threads:list", args: [] }),
    );
    const reply = await onceMessage(ws);
    assert.equal(reply.kind, "reply");
    assert.equal(reply.id, 9);
    assert.equal(reply.error, undefined);
    assert.deepEqual(reply.result, services.listThreads(store));
    assert.ok(Array.isArray(reply.result));
    assert.equal(reply.result.length, 1);
    assert.equal(reply.result[0].title, "alpha");
    ws.close();
    await onceClose(ws);
  });

  it("error-string parity: WS error === IPC_HANDLERS throw message", async () => {
    const { IPC_HANDLERS } = require("../ipc.js");
    let direct = "";
    try {
      await IPC_HANDLERS["git:setupWorktree"](ctx, { threadId: "missing" });
    } catch (err) {
      direct = err.message;
    }
    assert.equal(direct, "worktreeBase is not configured");

    const ws = await connect(wsUrl());
    ws.send(JSON.stringify({ kind: "auth", token: "secret-token" }));
    await onceMessage(ws);
    ws.send(
      JSON.stringify({
        kind: "invoke",
        id: 3,
        channel: "git:setupWorktree",
        args: [{ threadId: "missing" }],
      }),
    );
    const reply = await onceMessage(ws);
    assert.equal(reply.kind, "reply");
    assert.equal(reply.id, 3);
    assert.equal(reply.error, direct);
    ws.close();
    await onceClose(ws);
  });

  it("push fan-out: 2 authed sockets see one broadcast; unauthed sees nothing", async () => {
    const a = await connect(wsUrl());
    const b = await connect(wsUrl());
    const stranger = await connect(wsUrl());
    a.send(JSON.stringify({ kind: "auth", token: "secret-token" }));
    b.send(JSON.stringify({ kind: "auth", token: "secret-token" }));
    assert.deepEqual(await onceMessage(a), { kind: "auth-ok" });
    assert.deepEqual(await onceMessage(b), { kind: "auth-ok" });

    const gotA = onceMessage(a);
    const gotB = onceMessage(b);
    let strangerPushed = false;
    stranger.on("message", () => {
      strangerPushed = true;
    });

    server.broadcast("threads:changed", [{ id: "t1" }]);

    const pa = await gotA;
    const pb = await gotB;
    assert.deepEqual(pa, {
      kind: "push",
      channel: "threads:changed",
      payload: [{ id: "t1" }],
    });
    assert.deepEqual(pb, pa);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(strangerPushed, false);

    a.close();
    b.close();
    stranger.close();
    await Promise.all([onceClose(a), onceClose(b), onceClose(stranger)]);
  });

  it("static serve: index, asset MIME, SPA fallback", async () => {
    const index = await httpGet(`http://127.0.0.1:${server.port}/`);
    assert.equal(index.status, 200);
    assert.match(index.type, /text\/html/);
    assert.match(index.body, /<title>web-ok<\/title>/);

    const js = await httpGet(`http://127.0.0.1:${server.port}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.type, /javascript/);
    assert.match(js.body, /window\.x=1/);

    const spa = await httpGet(`http://127.0.0.1:${server.port}/thread/abc`);
    assert.equal(spa.status, 200);
    assert.match(spa.type, /text\/html/);
    assert.match(spa.body, /<title>web-ok<\/title>/);
  });
});

describe("no-flag → no listeners (port probe)", () => {
  it("requiring the modules does not bind the default port", async () => {
    const args = parseServeWebArgs(process.argv);
    assert.equal(args.enabled, false, "this test process has no --serve-web");
    assert.equal(DEFAULT_PORT, 4620);

    await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once("error", (err) => {
        reject(
          new Error(
            `default port ${DEFAULT_PORT} is already bound (no-flag must leave it free): ${err.message}`,
          ),
        );
      });
      s.listen(DEFAULT_PORT, "127.0.0.1", () => {
        s.close(() => resolve());
      });
    });
  });
});

describe("one map, two transports + packaging", () => {
  it("registerIpc and webBridge both walk the exported IPC_HANDLERS object", () => {
    const ipcSrc = fs.readFileSync(path.join(__dirname, "../ipc.js"), "utf8");
    const bridgeSrc = fs.readFileSync(
      path.join(__dirname, "../webBridge.js"),
      "utf8",
    );
    assert.match(ipcSrc, /const IPC_HANDLERS = \{/);
    assert.match(ipcSrc, /Object\.entries\(IPC_HANDLERS\)/);
    assert.match(bridgeSrc, /require\("\.\/ipc\.js"\)/);
    assert.match(bridgeSrc, /IPC_HANDLERS/);
    assert.match(bridgeSrc, /fn\(ctx, \.\.\.args\)/);
  });

  it("covers every channel preload invokes", async () => {
    await withStubbedElectron(() => {
      delete require.cache[require.resolve("../ipc.js")];
      const { IPC_HANDLERS } = require("../ipc.js");
      const preload = fs.readFileSync(
        path.join(__dirname, "../preload.js"),
        "utf8",
      );
      const ipcSrc = fs.readFileSync(path.join(__dirname, "../ipc.js"), "utf8");
      const channels = [...preload.matchAll(/invoke\("([^"]+)"/g)].map(
        (m) => m[1],
      );
      // Native Menu.popup needs the sender window, so registerIpc wires
      // these outside IPC_HANDLERS — the web bridge must never pop a menu.
      const desktopOnly = new Set(["contextMenu:show"]);
      assert.ok(channels.length > 20);
      for (const ch of new Set(channels)) {
        if (desktopOnly.has(ch)) {
          assert.match(
            ipcSrc,
            new RegExp(`ipcMain\\.handle\\("${ch}"`),
            `registerIpc must still handle desktop-only ${ch}`,
          );
          continue;
        }
        assert.equal(
          typeof IPC_HANDLERS[ch],
          "function",
          `IPC_HANDLERS must own ${ch}`,
        );
      }
    });
  });

  it("package-app.sh copies electron/*.js and node_modules/ws", () => {
    const sh = fs.readFileSync(
      path.join(__dirname, "../../scripts/package-app.sh"),
      "utf8",
    );
    assert.match(sh, /electron\/\*\.js/);
    // ws ships via ROOT_NM_PKGS + `cp node_modules/$pkg`, not a hardcoded
    // `node_modules/ws` path (that string lives in verify-package.sh).
    assert.match(sh, /ROOT_NM_PKGS=\(ws /);
    assert.match(sh, /node_modules\/\$pkg/);
    assert.match(sh, /cross-spawn/);
    assert.ok(fs.existsSync(path.join(__dirname, "../webBridge.js")));
    assert.ok(fs.existsSync(path.join(__dirname, "../webServer.js")));
    const verify = fs.readFileSync(
      path.join(__dirname, "../../scripts/verify-package.sh"),
      "utf8",
    );
    assert.match(verify, /node_modules\/ws/);
    assert.match(verify, /cross-spawn/);
    assert.match(verify, /webBridge\.js/);
  });

  it("main.js starts only on --serve-web via shared ctx", () => {
    const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
    assert.match(main, /parseServeWebArgs/);
    assert.match(main, /startWebServer/);
    assert.match(main, /loadOrCreateToken/);
    assert.match(main, /serveOpts\.enabled/);
    assert.match(main, /registered\.ctx/);
    assert.match(main, /HOST_FLAG_HELP/);
    assert.doesNotMatch(main, /parseServeArgs\(/);
    assert.match(main, /process\.stdout\.write\(`solenta-web: token/);
  });

  it("main.js survives a web-server bind failure and still opens a window", async () => {
    const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
    // EADDRINUSE on the fixed port must not reject out of whenReady, or
    // createWindow() never runs: app up, no window, no error anywhere.
    assert.match(main, /try \{\s*webServer = await startWebServer\(/);
    const guard = main.slice(
      main.indexOf("webServer = await startWebServer("),
      main.indexOf("createWindow();"),
    );
    assert.match(guard, /\} catch \(err\) \{/);
    assert.match(guard, /serveOpts\.enabled = false/);
  });

  it("ws is a pinned production dependency", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
    );
    assert.equal(pkg.dependencies.ws, "8.21.3");
  });
});

describe("heartbeat + backpressure (attachWebBridge)", () => {
  async function listenBridge(opts) {
    const httpServer = http.createServer();
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const bridge = attachWebBridge(httpServer, {
      token: "secret-token",
      ctx: {},
      handlers: {},
      ...opts,
    });
    const { port } = httpServer.address();
    return {
      httpServer,
      bridge,
      url: `ws://127.0.0.1:${port}${WS_PATH}`,
    };
  }

  async function shutdown(httpServer, bridge) {
    await bridge.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }

  it("heartbeat terminates a client that does not pong", async () => {
    const { httpServer, bridge, url } = await listenBridge({
      pingIntervalMs: 30,
    });
    try {
      const ws = new WebSocket(url, { autoPong: false });
      await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      ws.send(JSON.stringify({ kind: "auth", token: "secret-token" }));
      assert.deepEqual(await onceMessage(ws), { kind: "auth-ok" });

      const deadline = Date.now() + 3000;
      while (ws.readyState !== WebSocket.CLOSED || bridge.wss.clients.size > 0) {
        if (Date.now() > deadline) {
          throw new Error(
            `heartbeat did not terminate client (readyState=${ws.readyState}, clients=${bridge.wss.clients.size})`,
          );
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      await shutdown(httpServer, bridge);
    }
  });

  it("backpressure terminates a client past maxBufferedBytes", async () => {
    const { httpServer, bridge, url } = await listenBridge({
      maxBufferedBytes: 1,
    });
    try {
      const ws = await connect(url);
      ws.send(JSON.stringify({ kind: "auth", token: "secret-token" }));
      assert.deepEqual(await onceMessage(ws), { kind: "auth-ok" });

      // pause() only stops reads; cork() keeps the first send in
      // _writableState so bufferedAmount stays above the 1-byte ceiling.
      for (const client of bridge.wss.clients) {
        client._socket.cork();
      }

      const closed = onceClose(ws);
      bridge.broadcast("threads:changed", { n: 1 });
      bridge.broadcast("threads:changed", { n: 2 });
      await Promise.race([
        closed,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("backpressure did not terminate client")),
            2000,
          ),
        ),
      ]);
      assert.equal(bridge.wss.clients.size, 0);

      bridge.broadcast("threads:changed", { n: 3 });
      assert.equal(ws.readyState, WebSocket.CLOSED);
      assert.equal(bridge.wss.clients.size, 0);
    } finally {
      await shutdown(httpServer, bridge);
    }
  });
});
