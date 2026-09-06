"use strict";

/**
 * #433 / #972 / #975 / #976: threads.listCliSessions / threads.importCliSession IPC.
 * Home is CODEX_HOME / GROK_HOME / CURSOR_HOME / OPENCODE_HOME on the main
 * process — the renderer cannot point the scan.
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
const {
  parseCodexRollout,
  parseGrokChatHistory,
  parseCursorJsonl,
  readOpenCodeImportTurns,
} = require("../cli-sessions.js");
const { DatabaseSync } = require("node:sqlite");

const SESSION_A = "01a07579-aaaa-7000-8000-aaaaaaaaaaaa";
const SESSION_B = "01a07579-bbbb-7000-8000-bbbbbbbbbbbb";
const GROK_CWD = "/tmp/solenta-grok-wt";

function writeRollout(home, sessionId, records, shard = ["2026", "09", "06"]) {
  const dir = path.join(home, "sessions", ...shard);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${shard[0]}-${shard[1]}-${shard[2]}T12-00-00`;
  const file = path.join(dir, `rollout-${stamp}-${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: "2026-09-06T12:00:00.000Z",
      type: "session_meta",
      payload: { id: sessionId, session_id: sessionId },
    }),
    ...records.map((r) => JSON.stringify(r)),
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function messageRecord(role, text, timestamp) {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [
        {
          type: role === "assistant" ? "output_text" : "input_text",
          text,
        },
      ],
    },
  };
}

function writeGrokSession(home, cwd, sessionId, records) {
  const dir = path.join(
    home,
    "sessions",
    encodeURIComponent(String(cwd)),
    sessionId,
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "chat_history.jsonl");
  fs.writeFileSync(
    file,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return file;
}

describe("CLI session import IPC (#433)", () => {
  let home;
  let tmpDir;
  let store;
  let ctx;
  let projectId;
  let prevHome;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "coder-cli-sess-ipc-home-"));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-cli-sess-ipc-store-"));
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
    prevHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists both rollouts and importing one does not pick up the sibling", async () => {
    const fileA = writeRollout(home, SESSION_A, [
      messageRecord("user", "prompt a", "2026-09-06T12:00:01.000Z"),
      messageRecord("assistant", "reply a", "2026-09-06T12:00:02.000Z"),
    ]);
    writeRollout(
      home,
      SESSION_B,
      [
        messageRecord("user", "prompt b", "2026-09-06T12:00:01.000Z"),
        messageRecord("assistant", "reply b", "2026-09-06T12:00:02.000Z"),
      ],
      ["2026", "08", "31"],
    );

    const listed = await IPC_HANDLERS["threads:listCliSessions"](ctx, {});
    assert.equal(listed.length, 2);
    assert.deepEqual(
      listed.map((s) => s.sessionId).sort(),
      [SESSION_A, SESSION_B].sort(),
    );

    const thread = await IPC_HANDLERS["threads:importCliSession"](ctx, {
      sessionId: SESSION_A,
      projectId,
      home: path.join(tmpDir, "evil-home"),
    });
    assert.equal(thread.provider, "codex");
    assert.equal(thread.sessionId, SESSION_A);
    const expected = parseCodexRollout(fs.readFileSync(fileA, "utf8"));
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

const CURSOR_CWD = "/tmp/solenta-cursor-wt";

function cursorProjectDir(cwd) {
  return String(cwd)
    .replace(/^\//, "")
    .replace(/[^A-Za-z0-9]/g, "-");
}

function writeCursorSession(home, cwd, sessionId, records) {
  const dir = path.join(
    home,
    "projects",
    cursorProjectDir(cwd),
    "agent-transcripts",
    sessionId,
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    file,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return file;
}

describe("Cursor session import IPC (#975)", () => {
  let home;
  let tmpDir;
  let store;
  let ctx;
  let projectId;
  let prevHome;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "coder-cursor-sess-ipc-home-"));
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "coder-cursor-sess-ipc-store-"),
    );
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
    prevHome = process.env.CURSOR_HOME;
    process.env.CURSOR_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CURSOR_HOME;
    else process.env.CURSOR_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists both sessions and importing one does not pick up the sibling", async () => {
    const fileA = writeCursorSession(home, CURSOR_CWD, SESSION_A, [
      {
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<user_query>\nprompt a\n</user_query>",
            },
          ],
        },
      },
      {
        role: "assistant",
        message: { content: [{ type: "text", text: "reply a" }] },
      },
    ]);
    writeCursorSession(home, "/tmp/other-wt", SESSION_B, [
      {
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<user_query>\nprompt b\n</user_query>",
            },
          ],
        },
      },
      {
        role: "assistant",
        message: { content: [{ type: "text", text: "reply b" }] },
      },
    ]);

    const listed = await IPC_HANDLERS["threads:listCliSessions"](ctx, {
      provider: "cursor",
    });
    assert.equal(listed.length, 2);
    assert.deepEqual(
      listed.map((s) => s.sessionId).sort(),
      [SESSION_A, SESSION_B].sort(),
    );

    const thread = await IPC_HANDLERS["threads:importCliSession"](ctx, {
      provider: "cursor",
      sessionId: SESSION_A,
      projectId,
      home: path.join(tmpDir, "evil-home"),
    });
    assert.equal(thread.provider, "cursor");
    assert.equal(thread.sessionId, SESSION_A);
    const expected = parseCursorJsonl(fs.readFileSync(fileA, "utf8"));
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

const OC_A = "ses_aaaa1111ffffABCDEFGHijkl";
const OC_B = "ses_bbbb2222ffffABCDEFGHijkl";

function writeOpenCodeSession(home, sessionId, turns, mtimeMs = Date.now()) {
  fs.mkdirSync(home, { recursive: true });
  const dbPath = path.join(home, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'p',
      slug TEXT NOT NULL DEFAULT '',
      directory TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '',
      cost REAL NOT NULL DEFAULT 0,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  const title =
    (turns.find((t) => t.role === "user") || {}).text || sessionId;
  db.prepare(
    `INSERT OR REPLACE INTO session (
      id, project_id, slug, directory, title, version, time_created, time_updated
    ) VALUES (?, 'p', '', '', ?, '', ?, ?)`,
  ).run(sessionId, title, mtimeMs, mtimeMs);
  let i = 0;
  for (const turn of turns) {
    i += 1;
    const msgId = `msg_${sessionId}_${i}`;
    const t = Number(turn.createdAt) || mtimeMs + i;
    db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(msgId, sessionId, t, t, JSON.stringify({ role: turn.role }));
    db.prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      `prt_${sessionId}_${i}`,
      msgId,
      sessionId,
      t,
      t,
      JSON.stringify({ type: "text", text: turn.text }),
    );
  }
  db.close();
  return dbPath;
}

describe("OpenCode session import IPC (#976)", () => {
  let home;
  let tmpDir;
  let store;
  let ctx;
  let projectId;
  let prevHome;

  beforeEach(() => {
    home = fs.mkdtempSync(
      path.join(os.tmpdir(), "coder-opencode-sess-ipc-home-"),
    );
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "coder-opencode-sess-ipc-store-"),
    );
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
    prevHome = process.env.OPENCODE_HOME;
    process.env.OPENCODE_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists both sessions and importing one does not pick up the sibling", async () => {
    writeOpenCodeSession(home, OC_A, [
      { role: "user", text: "prompt a" },
      { role: "assistant", text: "reply a" },
    ]);
    writeOpenCodeSession(home, OC_B, [
      { role: "user", text: "prompt b" },
      { role: "assistant", text: "reply b" },
    ]);

    const listed = await IPC_HANDLERS["threads:listCliSessions"](ctx, {
      provider: "opencode",
    });
    assert.equal(listed.length, 2);
    assert.deepEqual(
      listed.map((s) => s.sessionId).sort(),
      [OC_A, OC_B].sort(),
    );

    const thread = await IPC_HANDLERS["threads:importCliSession"](ctx, {
      provider: "opencode",
      sessionId: OC_A,
      projectId,
      home: path.join(tmpDir, "evil-home"),
    });
    assert.equal(thread.provider, "opencode");
    assert.equal(thread.sessionId, OC_A);
    const expected = readOpenCodeImportTurns(home, OC_A);
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
