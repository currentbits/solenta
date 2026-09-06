"use strict";

/**
 * #972: threads.listCliSessions / threads.importCliSession IPC for Grok.
 * Home is GROK_HOME on the main process — the renderer cannot point the scan.
 *
 * Run: node --test electron/test/cli-sessions-ipc.test.js
 */

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

const { Store } = require("../store.js");
const { IPC_HANDLERS } = require("../ipc.js");
const { parseGrokChatHistory } = require("../cli-sessions.js");

const SESSION_A = "01a07579-aaaa-7000-8000-aaaaaaaaaaaa";
const SESSION_B = "01a07579-bbbb-7000-8000-bbbbbbbbbbbb";
const GROK_CWD = "/tmp/solenta-grok-wt";

function writeGrokSession(home, cwd, sessionId, records) {
  const dir = path.join(home, "sessions", encodeURIComponent(String(cwd)), sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "chat_history.jsonl");
  fs.writeFileSync(
    file,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return file;
}

describe("Grok session import IPC (#972)", () => {
  let home;
  let tmpDir;
  let store;
  let ctx;
  let projectId;
  let prevHome;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "coder-grok-sess-ipc-home-"));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-grok-sess-ipc-store-"));
    store = new Store(path.join(tmpDir, "store.json"));
    projectId = "proj-import";
    store.setProjects([
      {
        id: projectId,
        slug: "demo",
        name: "demo",
        path: path.join(tmpDir, "demo"),
      },
    ]);
    ctx = {
      store,
      broadcast: () => {},
    };
    prevHome = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists both sessions and importing one does not pick up the sibling", async () => {
    const fileA = writeGrokSession(home, GROK_CWD, SESSION_A, [
      { type: "user", content: "prompt a" },
      { type: "assistant", content: "reply a" },
    ]);
    writeGrokSession(home, "/tmp/other-wt", SESSION_B, [
      { type: "user", content: "prompt b" },
      { type: "assistant", content: "reply b" },
    ]);

    const listed = await IPC_HANDLERS["threads:listCliSessions"](ctx, {
      provider: "grok",
    });
    assert.equal(listed.length, 2);
    assert.deepEqual(
      listed.map((s) => s.sessionId).sort(),
      [SESSION_A, SESSION_B].sort(),
    );

    const thread = await IPC_HANDLERS["threads:importCliSession"](ctx, {
      provider: "grok",
      sessionId: SESSION_A,
      projectId,
      home: path.join(tmpDir, "evil-home"),
    });
    assert.equal(thread.provider, "grok");
    assert.equal(thread.sessionId, SESSION_A);
    const expected = parseGrokChatHistory(fs.readFileSync(fileA, "utf8"));
    assert.deepEqual(
      store.getMessages(thread.id).map((m) => `${m.role}:${m.text}`),
      expected.map((t) => `${t.role}:${t.text}`),
    );
    assert.equal(
      store.getMessages(thread.id).some((m) => m.text === "prompt b"),
      false,
    );
  });
});
