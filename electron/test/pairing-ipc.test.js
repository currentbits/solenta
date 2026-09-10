/**
 * pairing:* IPC (#157).
 * Run: node --test electron/test/pairing-ipc.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._resolveFilename = function (request, ...rest) {
  if (request === "electron") return "electron";
  return origResolve.call(this, request, ...rest);
};
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return {
      ipcMain: { handle() {} },
      app: { getPath: () => os.tmpdir(), getVersion: () => "0.0.0-test" },
      dialog: {},
      shell: {},
      nativeTheme: { themeSource: "system" },
      BrowserWindow: class {
        static getAllWindows() {
          return [];
        }
      },
    };
  }
  return origLoad.call(this, request, ...rest);
};

const { IPC_HANDLERS, makeCtx } = require("../ipc.js");

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-pairing-ipc-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("pairing IPC", () => {
  it("create/list/revoke round-trip without echoing the token on list", async () => {
    const ctx = makeCtx({
      userDataPath: tmp,
      store: {
        getThread: () => null,
        getThreads: () => [],
        getProjects: () => [],
      },
      getOrchStatus: () => ({ running: true, port: 7422 }),
    });
    const created = await IPC_HANDLERS["pairing:create"](ctx, {
      name: "Claude Desktop",
    });
    assert.equal(created.pairing.name, "Claude Desktop");
    assert.equal(created.token.length, 64);
    assert.equal(created.url, "http://127.0.0.1:7422/mcp");
    assert.match(created.claudeDesktopJson, /Authorization/);

    const listed = await IPC_HANDLERS["pairing:list"](ctx);
    assert.equal(listed.pairings.length, 1);
    assert.equal(listed.server.port, 7422);
    assert.equal(JSON.stringify(listed).includes(created.token), false);

    const revoked = await IPC_HANDLERS["pairing:revoke"](ctx, {
      id: created.pairing.id,
    });
    assert.ok(revoked.revokedAt);
    assert.equal((await IPC_HANDLERS["pairing:list"](ctx)).pairings.length, 0);
  });
});
