"use strict";

/**
 * Round 52: REAL wireClient against REAL webBridge over a REAL socket.
 *
 * Wave 1 tested each half against a fake of the other. This file is the
 * missing pair: createWireCoder (imports src/shared/wire.ts) talking to
 * startWebServer / attachWebBridge (hardcoded kind tags) on localhost.
 */

const { describe, it, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");
const { WebSocket } = require("ws");

// ipc.js requires("electron") at load. Stub before any web module.
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

// Browser wireClient reads the global WebSocket. Node's built-in exists
// too; the spec asks for the `ws` package so both ends share one impl.
globalThis.WebSocket = WebSocket;

const { startWebServer } = require("../webServer.js");
const { WS_PATH } = require("../webBridge.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (predicate()) return resolve();
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** @type {typeof import("../../src/wireClient.ts").createWireCoder} */
let createWireCoder;

before(async () => {
  const mod = await import(
    pathToFileURL(path.join(__dirname, "../../src/wireClient.ts")).href
  );
  createWireCoder = mod.createWireCoder;
  assert.equal(typeof createWireCoder, "function");
});

describe("wireClient × webBridge over a real socket", () => {
  let tmp;
  let store;
  let server;
  let ctx;
  let runner;
  let prevSimulate;
  let hub;
  /** When false, injected clocks do not reconnect (stops leaked retries). */
  let allowReconnect;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    process.env.CODER_SIMULATE = "1";
    allowReconnect = false;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-web-int-"));
    store = new Store(path.join(tmp, "store.json"));
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);
    const project = await services.addProject(store, repo);
    services.createThread(store, { projectId: project.id, title: "alpha" });

    hub = {
      broadcast(channel, payload) {
        if (server) server.broadcast(channel, payload);
      },
    };

    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    runner = createRunner({
      store,
      core,
      pushFn: (channel, payload) => hub.broadcast(channel, payload),
      tickMs: 15,
      userDataPath: tmp,
    });

    const ipc = require("../ipc.js");
    ctx = ipc.makeCtx({
      dialog: {},
      store,
      runner,
      broadcast: (channel, payload) => hub.broadcast(channel, payload),
      worktreeBase: "",
      userDataPath: tmp,
    });

    server = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      token: "secret-token",
      ctx,
      handlers: ipc.IPC_HANDLERS,
    });
  });

  afterEach(async () => {
    allowReconnect = false;
    if (runner) {
      try {
        runner.stopAll();
      } catch {
        // ignore
      }
      runner = null;
    }
    if (server) {
      await server.close();
      server = null;
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
  });

  function wsUrl() {
    return `ws://127.0.0.1:${server.port}${WS_PATH}`;
  }

  function makeClient(token = "secret-token", extra = {}) {
    return createWireCoder({
      url: wsUrl(),
      token,
      // Do not pass WebSocket: the client must use the global we installed.
      setTimeout:
        extra.setTimeout ??
        ((fn, ms) => {
          if (!allowReconnect) return { unref() {} };
          return setTimeout(fn, 0);
        }),
    });
  }

  it("threads.list() through createWireCoder deepEquals services.listThreads", async () => {
    const api = makeClient();
    const listed = await api.threads.list();
    assert.deepEqual(listed, services.listThreads(store));
    assert.equal(listed.length, 1);
    assert.equal(listed[0].title, "alpha");
  });

  it("projects.list, threads.get, and a throwing channel keep error-string parity", async () => {
    const api = makeClient();
    const projects = await api.projects.list();
    assert.deepEqual(projects, services.listProjects(store));
    assert.equal(projects.length, 1);

    const thread = services.listThreads(store)[0];
    const detail = await api.threads.get(thread.id);
    assert.equal(detail.thread.id, thread.id);
    assert.equal(detail.thread.title, "alpha");
    assert.ok(Array.isArray(detail.messages));

    const { IPC_HANDLERS } = require("../ipc.js");
    let direct = "";
    try {
      await IPC_HANDLERS["git:setupWorktree"](ctx, { threadId: thread.id });
    } catch (err) {
      direct = err.message;
    }
    assert.equal(direct, "worktreeBase is not configured");
    await assert.rejects(
      () => api.git.setupWorktree({ threadId: thread.id }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, direct);
        return true;
      },
    );
  });

  it("wrong token surfaces a clear failure, not a hang", { timeout: 4000 }, async () => {
    const api = makeClient("nope", {
      setTimeout: () => ({ unref() {} }),
    });
    const started = Date.now();
    await assert.rejects(
      () => api.threads.list(),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(
          err.message,
          /auth|disconnect|fail|close|unauthor/i,
          `expected a clear auth/transport error, got: ${err.message}`,
        );
        return true;
      },
    );
    assert.ok(
      Date.now() - started < 3500,
      "wrong-token must reject, not sit on the queue until timeout",
    );
  });

  it("simulate run streams thread:updated to the real client; unauthed sees nothing", async () => {
    const api = makeClient();
    const thread = services.listThreads(store)[0];
    const updates = [];
    api.on("thread:updated", (detail) => {
      updates.push(detail);
    });

    const stranger = new WebSocket(wsUrl());
    await new Promise((resolve, reject) => {
      stranger.once("open", resolve);
      stranger.once("error", reject);
    });
    let strangerPushed = false;
    stranger.on("message", () => {
      strangerPushed = true;
    });

    const { runId } = await api.runs.start({
      threadId: thread.id,
      prompt: "stream me a transcript",
    });
    assert.ok(runId);

    await waitFor(() => updates.length >= 2);
    await waitFor(() => {
      const last = updates[updates.length - 1];
      return last && last.thread && last.thread.status === "done";
    });

    const first = updates[0];
    const last = updates[updates.length - 1];
    assert.ok(first.thread, "push payload is a ThreadDetail");
    assert.ok(Array.isArray(first.messages));
    assert.ok(Array.isArray(last.messages));
    assert.ok(
      last.messages.length > first.messages.length ||
        (last.workLog &&
          first.workLog &&
          last.workLog.length > first.workLog.length) ||
        last.thread.status === "done",
      "later updates must grow the transcript or reach done",
    );
    assert.ok(
      last.messages.some((m) => m.role === "user" || m.role === "assistant"),
      "streamed detail carries conversation text",
    );
    assert.equal(strangerPushed, false, "unauthed socket must not see pushes");
    stranger.close();
  });

  it("reconnect: server drop → re-auth → threads:list resync + synthetic threads:changed", async () => {
    const delays = [];
    const api = makeClient("secret-token", {
      setTimeout: (fn, ms) => {
        delays.push(ms);
        if (!allowReconnect) return { unref() {} };
        // Fire immediately; do not change production MIN_BACKOFF_MS (1000).
        const t = setTimeout(fn, 0);
        return t;
      },
    });

    // Establish first session.
    assert.deepEqual(await api.threads.list(), services.listThreads(store));

    const resynced = [];
    api.on("threads:changed", (threads) => {
      resynced.push(threads);
    });

    allowReconnect = true;
    const clients = [...server.bridge.wss.clients];
    assert.ok(clients.length >= 1, "client socket must be on the server");
    for (const c of clients) c.close();

    await waitFor(() => resynced.length >= 1);
    // invoke() also schedules INVOKE_TIMEOUT_MS (120s) on the same clock, so
    // the backoff is no longer delays[0].
    assert.ok(
      delays.includes(1000),
      `production first backoff is still 1s (got ${delays.join(",")})`,
    );
    assert.deepEqual(resynced[0], services.listThreads(store));

    // Live invoke after resync still hits the same store.
    const again = await api.threads.list();
    assert.deepEqual(again, services.listThreads(store));
  });
});
