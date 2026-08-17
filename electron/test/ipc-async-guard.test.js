/**
 * The git:syncInfo / git:repoInfo / git:pull handlers document "never throws":
 * failures come back in-band as { hasUpstream: false } / { ok: false }.
 *
 * Issue #124 made services.gitSyncInfo & co. async. A bare `return fn(...)`
 * inside try/catch settles the promise OUTSIDE the try, so the catch stops
 * seeing rejections and the handler rejects instead of answering in-band —
 * silently, because the functions currently catch their own errors, so nothing
 * fails today. These tests pin the contract at the seam so a future throw path
 * inside services cannot quietly break it.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

/** Stub the electron module so ipc.js loads in plain node. */
async function withStubbedElectron(fn) {
  const handlers = new Map();
  const stub = {
    ipcMain: {
      handle(channel, cb) {
        handlers.set(channel, cb);
      },
    },
    app: { getPath: () => os.tmpdir(), getVersion: () => "0.0.0-test" },
    dialog: {},
    shell: {},
    BrowserWindow: class {},
  };
  const origResolve = Module._resolveFilename;
  const origLoad = Module._load;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "electron") return "electron";
    return origResolve.call(this, request, ...rest);
  };
  Module._load = function (request, ...rest) {
    if (request === "electron") return stub;
    return origLoad.call(this, request, ...rest);
  };
  try {
    return await fn({ handlers });
  } finally {
    Module._resolveFilename = origResolve;
    Module._load = origLoad;
  }
}

describe("ipc git handlers answer in-band when services reject", () => {
  /** @type {string} */
  let tmp;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-ipc-async-"));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Register ipc against a store holding one project + one thread, with the
   * named services functions replaced by rejecting stubs.
   * @param {string[]} rejectFns
   */
  async function withRejectingServices(rejectFns, run) {
    return withStubbedElectron(async ({ handlers }) => {
      for (const m of ["../ipc.js", "../services.js", "../store.js"]) {
        delete require.cache[require.resolve(m)];
      }
      const services = require("../services.js");
      const { registerIpc } = require("../ipc.js");
      const { Store } = require("../store.js");

      const saved = {};
      for (const name of rejectFns) {
        saved[name] = services[name];
        services[name] = async () => {
          throw new Error(`boom: ${name}`);
        };
      }

      const s = new Store(path.join(tmp, `store-${rejectFns.join("-")}.json`));
      s.setProjects([{ id: "p1", name: "proj", path: tmp }]);
      s.setThreads([{ id: "t1", projectId: "p1", title: "t" }]);

      registerIpc({
        ipcMain: require("electron").ipcMain,
        dialog: {},
        store: s,
        runner: { start() {}, stop() {}, stopAll() {} },
        broadcast() {},
        worktreeBase: path.join(tmp, "wt"),
        userDataPath: tmp,
      });

      try {
        return await run({ handlers });
      } finally {
        for (const name of rejectFns) services[name] = saved[name];
      }
    });
  }

  it("git:syncInfo returns { hasUpstream: false } instead of rejecting", async () => {
    await withRejectingServices(["gitSyncInfo"], async ({ handlers }) => {
      const h = handlers.get("git:syncInfo");
      assert.ok(h, "git:syncInfo must be registered");
      const out = await h({}, { threadId: "t1" });
      assert.deepEqual(out, { hasUpstream: false });
    });
  });

  it("git:repoInfo returns { ok: false } instead of rejecting", async () => {
    await withRejectingServices(["gitRepoInfo"], async ({ handlers }) => {
      const h = handlers.get("git:repoInfo");
      assert.ok(h, "git:repoInfo must be registered");
      const out = await h({}, { threadId: "t1" });
      assert.equal(out.ok, false);
    });
  });

  it("git:pull returns { ok: false, reason } instead of rejecting", async () => {
    await withRejectingServices(["gitPull"], async ({ handlers }) => {
      const h = handlers.get("git:pull");
      assert.ok(h, "git:pull must be registered");
      const out = await h({}, { threadId: "t1" });
      assert.equal(out.ok, false);
      assert.match(out.reason, /boom/);
    });
  });
});
