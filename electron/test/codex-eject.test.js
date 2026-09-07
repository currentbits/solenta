"use strict";

/**
 * #554: persist thread.ejected and never resume that Codex sessionId.
 * Worker-finished notices stay parked. A user send may start fresh.
 *
 * Run: node --test electron/test/codex-eject.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { writeFakeBin } = require("./support/fakeBin.js");

const EJECTED_SESSION = "01a072f7-10e0-7fd2-b691-7d481327516f";

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
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

function userTexts(store, threadId) {
  return (store.getMessages(threadId) || [])
    .filter((m) => m.role === "user")
    .map((m) => String(m.text || ""));
}

function eventTexts(store, threadId) {
  return (store.getMessages(threadId) || [])
    .filter((m) => m.role === "event")
    .map((m) => String(m.text || ""));
}

async function writeFakeCodex(dir) {
  const filePath = path.join(dir, "fake-codex");
  return writeFakeBin(
    filePath,
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
if (process.env.CODER_FAKE_CODEX_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_CODEX_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
}
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
emit({ type: "thread.started", thread_id: "codex-sess-fresh" });
emit({
  type: "item.completed",
  item: { id: "item-msg-1", type: "agent_message", text: "Hello from codex" },
});
emit({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2 } });
process.exit(0);
`,
  );
}

describe("thread.ejected persist (#554)", () => {
  let tmpDir;
  let store;
  let threadId;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-eject-store-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    }).id;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("new threads are not ejected; true survives reload", () => {
    assert.equal(store.getThread(threadId).ejected, false);

    const before = store.getThread(threadId).updatedAt;
    const updated = services.setEjected(store, {
      threadId,
      ejected: true,
    });
    assert.equal(updated.ejected, true);
    assert.equal(updated.updatedAt, before);
    assert.equal(store.getThread(threadId).ejected, true);
    assert.equal(store.getThread(threadId).sessionId, null);

    store.saveNow();
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    assert.equal(reloaded.getThread(threadId).ejected, true);

    assert.equal(
      services.setEjected(store, { threadId, ejected: false }).ejected,
      false,
    );
  });

  it("migrateThread keeps only boolean true", () => {
    store.updateThread(threadId, { ejected: "yes" });
    store.setThreads(store.getThreads());
    assert.equal(store.getThread(threadId).ejected, false);

    store.updateThread(threadId, { ejected: true });
    store.setThreads(store.getThreads());
    assert.equal(store.getThread(threadId).ejected, true);
  });

  it("setEjected throws on an unknown thread", () => {
    assert.throws(
      () => services.setEjected(store, { threadId: "nope", ejected: true }),
      /Unknown thread/,
    );
  });
});

describe("ejected Codex lead does not resume (#554)", () => {
  let tmpDir;
  let store;
  let runner;
  let argvFile;
  let prevSimulate;
  let prevAgentCmd;
  let prevCodexBin;
  let prevArgvFile;
  let prevGrokMcpDisable;
  let prevGrokBin;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevCodexBin = process.env.CODER_CODEX_BIN;
    prevArgvFile = process.env.CODER_FAKE_CODEX_ARGV_FILE;
    prevGrokMcpDisable = process.env.CODER_GROK_MCP_DISABLE;
    prevGrokBin = process.env.CODER_GROK_BIN;

    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = "no-grok-not-a-real-binary";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-codex-eject-"));
    const fakeCodex = await writeFakeCodex(tmpDir);
    argvFile = path.join(tmpDir, "argv.json");
    process.env.CODER_CODEX_BIN = fakeCodex;
    process.env.CODER_FAKE_CODEX_ARGV_FILE = argvFile;

    store = new Store(path.join(tmpDir, "store.json"));
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 15,
    });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const lead = services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    });
    services.setProvider(store, { threadId: lead.id, provider: "codex" });
    store.updateThread(lead.id, {
      sessionId: EJECTED_SESSION,
      status: "done",
    });
    services.setEjected(store, { threadId: lead.id, ejected: true });
    const worker = services.forkThread(store, { threadId: lead.id });
    store.updateThread(worker.id, {
      orchWorker: true,
      title: "Worker A",
      provider: "simulate",
    });
    store.saveNow();
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    if (prevCodexBin === undefined) delete process.env.CODER_CODEX_BIN;
    else process.env.CODER_CODEX_BIN = prevCodexBin;
    if (prevArgvFile === undefined) delete process.env.CODER_FAKE_CODEX_ARGV_FILE;
    else process.env.CODER_FAKE_CODEX_ARGV_FILE = prevArgvFile;
    if (prevGrokMcpDisable === undefined) {
      delete process.env.CODER_GROK_MCP_DISABLE;
    } else process.env.CODER_GROK_MCP_DISABLE = prevGrokMcpDisable;
    if (prevGrokBin === undefined) delete process.env.CODER_GROK_BIN;
    else process.env.CODER_GROK_BIN = prevGrokBin;
  });

  function lead() {
    return store.getThreads().find((t) => !t.orchWorker);
  }

  function worker() {
    return store.getThreads().find((t) => t.orchWorker);
  }

  it("does not auto-resume an ejected Codex lead from a worker-finished notice", async () => {
    const orch = lead();
    const w = worker();
    await runner.startRun({ threadId: w.id, prompt: "worker task" });
    await waitFor(() => store.getThread(w.id).status === "done");
    await waitFor(
      () =>
        fs.existsSync(argvFile) ||
        eventTexts(store, orch.id).some((t) => /ejected/i.test(t)),
    );
    assert.equal(fs.existsSync(argvFile), false, "must not spawn exec resume");
    assert.equal(
      userTexts(store, orch.id).some((t) => t.includes("[orchestration]")),
      false,
    );
    assert.equal(store.getThread(orch.id).sessionId, EJECTED_SESSION);
    assert.equal(store.getThread(orch.id).ejected, true);
  });

  it("user send starts a fresh session and does not resume the ejected id", async () => {
    const orch = lead();
    await runner.startRun({ threadId: orch.id, prompt: "human turn" });
    await waitFor(() => fs.existsSync(argvFile));
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const execIdx = argv.indexOf("exec");
    assert.ok(execIdx >= 0, JSON.stringify(argv));
    assert.notEqual(argv[execIdx + 1], "resume", JSON.stringify(argv));
    assert.equal(argv.includes(EJECTED_SESSION), false, JSON.stringify(argv));
    await waitFor(() => store.getThread(orch.id).status === "done");
    const after = store.getThread(orch.id);
    assert.equal(after.ejected, false);
    assert.equal(after.sessionId, "codex-sess-fresh");
  });
});

const RECLAIM_SESSION = "01a07579-cccc-7000-8000-cccccccccccc";

function writeCodexRollout(home, sessionId, turns) {
  const dir = path.join(home, "sessions", "2026", "09", "06");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `rollout-2026-09-06T12-00-00-${sessionId}.jsonl`,
  );
  const records = [
    {
      timestamp: "2026-09-06T12:00:00.000Z",
      type: "session_meta",
      payload: { id: sessionId, session_id: sessionId },
    },
    ...turns.map((t, i) => ({
      timestamp: new Date(Date.UTC(2026, 8, 6, 12, 0, i + 1)).toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role: t.role,
        content: [
          {
            type: t.role === "assistant" ? "output_text" : "input_text",
            text: t.text,
          },
        ],
      },
    })),
  ];
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function roleTexts(store, threadId, role) {
  return (store.getMessages(threadId) || [])
    .filter((m) => m.role === role)
    .map((m) => String(m.text || ""));
}

describe("reclaim appends outside Codex turns (#554)", () => {
  let tmpDir;
  let store;
  let threadId;
  let codexHome;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-eject-reclaim-"));
    codexHome = path.join(tmpDir, "codex-home");
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    });
    threadId = thread.id;
    services.setProvider(store, { threadId, provider: "codex" });
    store.updateThread(threadId, { sessionId: RECLAIM_SESSION });
    store.appendMessage(threadId, {
      id: "m-user-1",
      role: "user",
      text: "hello inside",
      createdAt: 1,
    });
    store.appendMessage(threadId, {
      id: "m-asst-1",
      role: "assistant",
      text: "inside reply",
      createdAt: 2,
    });
    services.setEjected(store, { threadId, ejected: true });
    writeCodexRollout(codexHome, RECLAIM_SESSION, [
      { role: "user", text: "hello inside" },
      { role: "assistant", text: "inside reply" },
      { role: "user", text: "outside prompt" },
      { role: "assistant", text: "outside reply" },
    ]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends at least one outside assistant turn after reclaim", () => {
    const updated = services.setEjected(store, {
      threadId,
      ejected: false,
      home: codexHome,
    });
    assert.equal(updated.ejected, false);
    assert.equal(store.getThread(threadId).sessionId, RECLAIM_SESSION);
    const assistants = roleTexts(store, threadId, "assistant");
    assert.ok(
      assistants.includes("outside reply"),
      `expected outside assistant turn, got ${JSON.stringify(assistants)}`,
    );
    assert.ok(roleTexts(store, threadId, "user").includes("outside prompt"));
  });

  it("does not duplicate turns already in the Solenta transcript", () => {
    services.setEjected(store, {
      threadId,
      ejected: false,
      home: codexHome,
    });
    services.setEjected(store, { threadId, ejected: true });
    services.setEjected(store, {
      threadId,
      ejected: false,
      home: codexHome,
    });
    const assistants = roleTexts(store, threadId, "assistant");
    assert.equal(assistants.filter((t) => t === "inside reply").length, 1);
    assert.equal(assistants.filter((t) => t === "outside reply").length, 1);
    const users = roleTexts(store, threadId, "user");
    assert.equal(users.filter((t) => t === "hello inside").length, 1);
    assert.equal(users.filter((t) => t === "outside prompt").length, 1);
  });
});

function claudeProjectDir(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

function writeClaudeTranscript(home, cwd, sessionId, turns) {
  const dir = path.join(home, "projects", claudeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const records = turns.map((t, i) => {
    const timestamp = new Date(Date.UTC(2026, 8, 6, 12, 0, i + 1)).toISOString();
    if (t.role === "user") {
      return {
        type: "user",
        message: { role: "user", content: t.text },
        timestamp,
        sessionId,
      };
    }
    return {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: t.text }],
      },
      timestamp,
      sessionId,
    };
  });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

function writeGrokTranscript(home, cwd, sessionId, turns) {
  const dir = path.join(
    home,
    "sessions",
    encodeURIComponent(String(cwd)),
    sessionId,
  );
  fs.mkdirSync(dir, { recursive: true });
  const records = turns.map((t) => {
    if (t.role === "user" && t.wrapped) {
      return {
        type: "user",
        content: [
          {
            type: "text",
            text: `<user_info>\nOS\n</user_info>\n<user_query>\n${t.text}\n</user_query>`,
          },
        ],
      };
    }
    return { type: t.role, content: t.text };
  });
  fs.writeFileSync(
    path.join(dir, "chat_history.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

function reclaimFixture(provider) {
  return async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `coder-eject-reclaim-${provider}-`),
    );
    const providerHome = path.join(tmpDir, `${provider}-home`);
    const store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    });
    const threadId = thread.id;
    services.setProvider(store, { threadId, provider });
    store.updateThread(threadId, { sessionId: RECLAIM_SESSION });
    store.appendMessage(threadId, {
      id: "m-user-1",
      role: "user",
      text: "hello inside",
      createdAt: 1,
    });
    store.appendMessage(threadId, {
      id: "m-asst-1",
      role: "assistant",
      text: "inside reply",
      createdAt: 2,
    });
    services.setEjected(store, { threadId, ejected: true });
    const cwd = store.getThread(threadId).worktreePath || project.path;
    const turns = [
      { role: "user", text: "hello inside", wrapped: true },
      { role: "assistant", text: "inside reply" },
      { role: "user", text: "outside prompt" },
      { role: "assistant", text: "outside reply" },
    ];
    if (provider === "claude") {
      // Claude Code 2.1.219 GR() realpaths cwd before RA(); hash the
      // transcript the same way (macOS /var vs /private/var). Stored-cwd
      // RA() is still tried first; this GR() path is the fallback.
      let hashedCwd = String(cwd);
      try {
        hashedCwd = fs.realpathSync(cwd).normalize("NFC");
      } catch {
        hashedCwd = hashedCwd.normalize("NFC");
      }
      writeClaudeTranscript(providerHome, hashedCwd, RECLAIM_SESSION, turns);
    } else {
      writeGrokTranscript(providerHome, cwd, RECLAIM_SESSION, turns);
    }
    return { tmpDir, store, threadId, providerHome, cwd };
  };
}

for (const provider of ["claude", "grok"]) {
  describe(`reclaim appends outside ${provider} turns (#554)`, () => {
    let tmpDir;
    let store;
    let threadId;
    let providerHome;

    beforeEach(async () => {
      const fx = await reclaimFixture(provider)();
      tmpDir = fx.tmpDir;
      store = fx.store;
      threadId = fx.threadId;
      providerHome = fx.providerHome;
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("appends at least one outside assistant turn after reclaim", () => {
      const updated = services.setEjected(store, {
        threadId,
        ejected: false,
        home: providerHome,
      });
      assert.equal(updated.ejected, false);
      assert.equal(store.getThread(threadId).sessionId, RECLAIM_SESSION);
      const assistants = roleTexts(store, threadId, "assistant");
      assert.ok(
        assistants.includes("outside reply"),
        `expected outside assistant turn, got ${JSON.stringify(assistants)}`,
      );
      assert.ok(roleTexts(store, threadId, "user").includes("outside prompt"));
    });

    it("does not duplicate turns already in the Solenta transcript", () => {
      services.setEjected(store, {
        threadId,
        ejected: false,
        home: providerHome,
      });
      services.setEjected(store, { threadId, ejected: true });
      services.setEjected(store, {
        threadId,
        ejected: false,
        home: providerHome,
      });
      const assistants = roleTexts(store, threadId, "assistant");
      assert.equal(assistants.filter((t) => t === "inside reply").length, 1);
      assert.equal(assistants.filter((t) => t === "outside reply").length, 1);
      const users = roleTexts(store, threadId, "user");
      assert.equal(users.filter((t) => t === "hello inside").length, 1);
      assert.equal(users.filter((t) => t === "outside prompt").length, 1);
    });
  });
}

function cursorProjectDir(cwd) {
  return String(cwd)
    .replace(/^\//, "")
    .replace(/[^A-Za-z0-9]/g, "-");
}

function writeCursorTranscript(home, cwd, sessionId, turns) {
  const dir = path.join(
    home,
    "projects",
    cursorProjectDir(cwd),
    "agent-transcripts",
    sessionId,
  );
  fs.mkdirSync(dir, { recursive: true });
  const records = turns.map((t) => {
    if (t.role === "user") {
      return {
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: `<user_query>\n${t.text}\n</user_query>`,
            },
          ],
        },
      };
    }
    return {
      role: "assistant",
      message: { content: [{ type: "text", text: t.text }] },
    };
  });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

function writeOpenCodeTranscript(home, sessionId, turns) {
  const { DatabaseSync } = require("node:sqlite");
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
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO session (
      id, project_id, slug, directory, title, version, time_created, time_updated
    ) VALUES (?, 'p', '', '', ?, '', ?, ?)`,
  ).run(sessionId, "Lead", now, now);
  let i = 0;
  for (const turn of turns) {
    i += 1;
    const msgId = `msg_${sessionId}_${i}`;
    const t = now + i;
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

function writeKimiTranscript(home, sessionId, turns) {
  const dir = path.join(
    home,
    "sessions",
    "wd_reclaim",
    sessionId,
    "agents",
    "main",
  );
  fs.mkdirSync(dir, { recursive: true });
  let t = 1;
  let turnId = 0;
  const records = turns.map((turn) => {
    t += 1;
    if (turn.role === "user") {
      return {
        type: "turn.prompt",
        input: [{ type: "text", text: turn.text }],
        origin: { kind: "user" },
        time: t,
      };
    }
    const id = turn.turnId != null ? String(turn.turnId) : String(turnId++);
    return {
      type: "context.append_loop_event",
      event: {
        type: "content.part",
        turnId: id,
        part: { type: "text", text: turn.text },
      },
      time: t,
    };
  });
  const file = path.join(dir, "wire.jsonl");
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

function writeMuseTranscript(home, sessionId, turns) {
  const dir = path.join(home, "sessions", "2026", "09", "06", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  let t = 1;
  const records = turns.map((turn) => {
    t += 1;
    if (turn.role === "user") {
      return {
        payload_type: "runtime.session",
        payload: {
          kind: "run",
          event: { kind: "started", prompt: turn.text },
        },
        recorded_at: t,
      };
    }
    return {
      payload_type: "runtime.session",
      payload: {
        kind: "run",
        event: { kind: "assistant_message_committed", text: turn.text },
      },
      recorded_at: t,
    };
  });
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

function writeOpenCodeJsonTranscript(home, sessionId, turns) {
  const projectId = "proj_reclaim";
  const sessionDir = path.join(home, "storage", "session", projectId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, `${sessionId}.json`);
  const now = Date.now();
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      id: sessionId,
      projectID: projectId,
      title: "Lead",
      time: { created: now, updated: now },
    })}\n`,
  );
  let i = 0;
  for (const turn of turns) {
    i += 1;
    const msgId = `msg_${sessionId}_${i}`;
    const t = now + i;
    const msgDir = path.join(home, "storage", "message", sessionId);
    fs.mkdirSync(msgDir, { recursive: true });
    fs.writeFileSync(
      path.join(msgDir, `${msgId}.json`),
      `${JSON.stringify({
        id: msgId,
        sessionID: sessionId,
        role: turn.role,
        time: { created: t },
      })}\n`,
    );
    const partId = `prt_${sessionId}_${i}`;
    const partDir = path.join(home, "storage", "part", msgId);
    fs.mkdirSync(partDir, { recursive: true });
    fs.writeFileSync(
      path.join(partDir, `${partId}.json`),
      `${JSON.stringify({
        id: partId,
        messageID: msgId,
        sessionID: sessionId,
        type: "text",
        text: turn.text,
      })}\n`,
    );
  }
  return sessionFile;
}

const RECLAIM_TURNS = [
  { role: "user", text: "hello inside" },
  { role: "assistant", text: "inside reply" },
  { role: "user", text: "outside prompt" },
  { role: "assistant", text: "outside reply" },
];

/** Same inside pair twice so absorbTurns must count occurrences, not unique keys. */
const OCCURRENCE_TURNS = [
  { role: "user", text: "hello inside" },
  { role: "assistant", text: "inside reply" },
  { role: "assistant", text: "inside reply" },
  { role: "user", text: "outside prompt" },
  { role: "assistant", text: "outside reply" },
];

async function sessionScanReclaimFixture(provider, turns = RECLAIM_TURNS) {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `coder-eject-reclaim-${provider}-`),
  );
  const providerHome = path.join(tmpDir, `${provider}-home`);
  const store = new Store(path.join(tmpDir, "store.json"));
  const repo = path.join(tmpDir, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init"]);
  const project = await services.addProject(store, repo);
  const thread = services.createThread(store, {
    projectId: project.id,
    title: "Lead",
  });
  const threadId = thread.id;
  const providerId = provider === "opencode-json" ? "opencode" : provider;
  services.setProvider(store, { threadId, provider: providerId });
  store.updateThread(threadId, { sessionId: RECLAIM_SESSION });
  store.appendMessage(threadId, {
    id: "m-user-1",
    role: "user",
    text: "hello inside",
    createdAt: 1,
  });
  store.appendMessage(threadId, {
    id: "m-asst-1",
    role: "assistant",
    text: "inside reply",
    createdAt: 2,
  });
  services.setEjected(store, { threadId, ejected: true });
  let artifact;
  if (provider === "cursor") {
    // SessionId scan, not cwd: stash the jsonl under a group that is not
    // the thread's worktree / project path.
    artifact = writeCursorTranscript(
      providerHome,
      "/tmp/other-cursor-cwd",
      RECLAIM_SESSION,
      turns,
    );
  } else if (provider === "opencode-json") {
    artifact = writeOpenCodeJsonTranscript(
      providerHome,
      RECLAIM_SESSION,
      turns,
    );
  } else if (provider === "kimi") {
    artifact = writeKimiTranscript(
      providerHome,
      RECLAIM_SESSION,
      RECLAIM_TURNS,
    );
  } else if (provider === "muse") {
    artifact = writeMuseTranscript(
      providerHome,
      RECLAIM_SESSION,
      RECLAIM_TURNS,
    );
  } else {
    artifact = writeOpenCodeTranscript(
      providerHome,
      RECLAIM_SESSION,
      turns,
    );
  }
  return { tmpDir, store, threadId, providerHome, artifact };
}

function assertReclaimAbsorbed(store, threadId) {
  const assistants = roleTexts(store, threadId, "assistant");
  assert.ok(
    assistants.includes("outside reply"),
    `expected outside assistant turn, got ${JSON.stringify(assistants)}`,
  );
  assert.ok(roleTexts(store, threadId, "user").includes("outside prompt"));
}

function assertReclaimNoDupes(store, threadId) {
  const assistants = roleTexts(store, threadId, "assistant");
  assert.equal(assistants.filter((t) => t === "inside reply").length, 1);
  assert.equal(assistants.filter((t) => t === "outside reply").length, 1);
  const users = roleTexts(store, threadId, "user");
  assert.equal(users.filter((t) => t === "hello inside").length, 1);
  assert.equal(users.filter((t) => t === "outside prompt").length, 1);
}

for (const provider of ["cursor", "opencode"]) {
  describe(`reclaim appends outside ${provider} turns (#554)`, () => {
    let tmpDir;
    let store;
    let threadId;
    let providerHome;
    let artifact;

    beforeEach(async () => {
      const fx = await sessionScanReclaimFixture(provider);
      tmpDir = fx.tmpDir;
      store = fx.store;
      threadId = fx.threadId;
      providerHome = fx.providerHome;
      artifact = fx.artifact;
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("appends at least one outside assistant turn after reclaim", () => {
      const updated = services.setEjected(store, {
        threadId,
        ejected: false,
        home: providerHome,
      });
      assert.equal(updated.ejected, false);
      assert.equal(store.getThread(threadId).sessionId, RECLAIM_SESSION);
      assertReclaimAbsorbed(store, threadId);
      assert.equal(
        fs.existsSync(artifact),
        true,
        "must not copy or consume the provider store",
      );
    });

    it("does not duplicate turns already in the Solenta transcript", () => {
      services.setEjected(store, {
        threadId,
        ejected: false,
        home: providerHome,
      });
      services.setEjected(store, { threadId, ejected: true });
      services.setEjected(store, {
        threadId,
        ejected: false,
        home: providerHome,
      });
      assertReclaimNoDupes(store, threadId);
    });
  });
}

function rewriteSessionScanTranscript(provider, providerHome, turns) {
  if (provider === "kimi") {
    return writeKimiTranscript(providerHome, RECLAIM_SESSION, turns);
  }
  return writeMuseTranscript(providerHome, RECLAIM_SESSION, turns);
}

for (const provider of ["kimi", "muse"]) {
  describe(`reclaim appends outside ${provider} turns (#554)`, () => {
    let tmpDir;
    let store;
    let threadId;
    let providerHome;
    let artifact;

    beforeEach(async () => {
      const fx = await sessionScanReclaimFixture(provider);
      tmpDir = fx.tmpDir;
      store = fx.store;
      threadId = fx.threadId;
      providerHome = fx.providerHome;
      artifact = fx.artifact;
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("appends at least one outside assistant turn after reclaim", () => {
      const updated = services.setEjected(store, {
        threadId,
        ejected: false,
        home: providerHome,
      });
      assert.equal(updated.ejected, false);
      assert.equal(store.getThread(threadId).sessionId, RECLAIM_SESSION);
      assertReclaimAbsorbed(store, threadId);
      assert.equal(
        fs.existsSync(artifact),
        true,
        "must not copy or consume the provider store",
      );
    });

    it("does not duplicate turns already in the Solenta transcript", () => {
      services.setEjected(store, {
        threadId,
        ejected: false,
        home: providerHome,
      });
      services.setEjected(store, { threadId, ejected: true });
      services.setEjected(store, {
        threadId,
        ejected: false,
        home: providerHome,
      });
      assertReclaimNoDupes(store, threadId);
    });

    it("appends a second identical assistant turn once", () => {
      rewriteSessionScanTranscript(provider, providerHome, [
        { role: "user", text: "hello inside" },
        { role: "assistant", text: "inside reply" },
        { role: "assistant", text: "inside reply" },
        { role: "user", text: "outside prompt" },
        { role: "assistant", text: "outside reply" },
      ]);
      services.setEjected(store, {
        threadId,
        ejected: false,
        home: providerHome,
      });
      const afterFirst = roleTexts(store, threadId, "assistant").filter(
        (t) => t === "inside reply",
      );
      assert.equal(afterFirst.length, 2);
      services.setEjected(store, { threadId, ejected: true });
      services.setEjected(store, {
        threadId,
        ejected: false,
        home: providerHome,
      });
      const afterSecond = roleTexts(store, threadId, "assistant").filter(
        (t) => t === "inside reply",
      );
      assert.equal(afterSecond.length, 2);
    });
  });
}

function writeKimiFragmentWire(home, sessionId) {
  const dir = path.join(
    home,
    "sessions",
    "wd_reclaim",
    sessionId,
    "agents",
    "main",
  );
  fs.mkdirSync(dir, { recursive: true });
  const records = [
    {
      type: "turn.prompt",
      input: [{ type: "text", text: "hello inside" }],
      origin: { kind: "user" },
      time: 1,
    },
    {
      type: "context.append_loop_event",
      event: {
        type: "content.part",
        turnId: "0",
        part: { type: "text", text: "inside " },
      },
      time: 2,
    },
    {
      type: "context.append_loop_event",
      event: {
        type: "content.part",
        turnId: "0",
        part: { type: "think", think: "skip me" },
      },
      time: 3,
    },
    {
      type: "context.append_loop_event",
      event: {
        type: "content.part",
        turnId: "0",
        part: { type: "text", text: "reply" },
      },
      time: 4,
    },
    {
      type: "turn.prompt",
      input: [{ type: "text", text: "outside prompt" }],
      origin: { kind: "user" },
      time: 5,
    },
    {
      type: "context.append_loop_event",
      event: {
        type: "content.part",
        turnId: "1",
        part: { type: "text", text: "outside reply" },
      },
      time: 6,
    },
  ];
  const file = path.join(dir, "wire.jsonl");
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

describe("reclaim joins Kimi content.part fragments (#999)", () => {
  let tmpDir;
  let store;
  let threadId;
  let providerHome;

  beforeEach(async () => {
    const fx = await sessionScanReclaimFixture("kimi");
    tmpDir = fx.tmpDir;
    store = fx.store;
    threadId = fx.threadId;
    providerHome = fx.providerHome;
    writeKimiFragmentWire(providerHome, RECLAIM_SESSION);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not append fragments that concatenate to the stored assistant message", () => {
    services.setEjected(store, {
      threadId,
      ejected: false,
      home: providerHome,
    });
    const assistants = roleTexts(store, threadId, "assistant");
    assert.equal(
      assistants.filter((t) => t === "inside reply").length,
      1,
      `expected the concatenated assistant once, got ${JSON.stringify(assistants)}`,
    );
    assert.equal(
      assistants.filter((t) => t === "inside " || t === "inside" || t === "reply")
        .length,
      0,
      `did not expect on-disk fragments, got ${JSON.stringify(assistants)}`,
    );
    assert.ok(
      assistants.includes("outside reply"),
      `expected outside assistant turn, got ${JSON.stringify(assistants)}`,
    );
    assert.equal(
      assistants.some((t) => /skip me/.test(t)),
      false,
    );
    assert.ok(roleTexts(store, threadId, "user").includes("outside prompt"));
  });
});

describe("reclaim appends outside OpenCode JSON-fallback turns (#554)", () => {
  let tmpDir;
  let store;
  let threadId;
  let providerHome;
  let artifact;

  beforeEach(async () => {
    const fx = await sessionScanReclaimFixture("opencode-json");
    tmpDir = fx.tmpDir;
    store = fx.store;
    threadId = fx.threadId;
    providerHome = fx.providerHome;
    artifact = fx.artifact;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends at least one outside assistant turn after reclaim", () => {
    assert.equal(fs.existsSync(path.join(providerHome, "opencode.db")), false);
    const updated = services.setEjected(store, {
      threadId,
      ejected: false,
      home: providerHome,
    });
    assert.equal(updated.ejected, false);
    assert.equal(store.getThread(threadId).sessionId, RECLAIM_SESSION);
    assertReclaimAbsorbed(store, threadId);
    assert.equal(
      fs.existsSync(artifact),
      true,
      "must not copy or consume the OpenCode JSON store",
    );
  });

  it("does not duplicate turns already in the Solenta transcript", () => {
    services.setEjected(store, {
      threadId,
      ejected: false,
      home: providerHome,
    });
    services.setEjected(store, { threadId, ejected: true });
    services.setEjected(store, {
      threadId,
      ejected: false,
      home: providerHome,
    });
    assertReclaimNoDupes(store, threadId);
  });
});

for (const provider of ["cursor", "opencode", "opencode-json"]) {
  describe(`reclaim occurrence-matches ${provider} turns (#433)`, () => {
    let tmpDir;
    let store;
    let threadId;
    let providerHome;

    beforeEach(async () => {
      const fx = await sessionScanReclaimFixture(provider, OCCURRENCE_TURNS);
      tmpDir = fx.tmpDir;
      store = fx.store;
      threadId = fx.threadId;
      providerHome = fx.providerHome;
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("appends a second identical role+text turn that is not already in the transcript", () => {
      services.setEjected(store, {
        threadId,
        ejected: false,
        home: providerHome,
      });
      const assistants = roleTexts(store, threadId, "assistant");
      assert.equal(assistants.filter((t) => t === "inside reply").length, 2);
      assert.equal(assistants.filter((t) => t === "outside reply").length, 1);
      const users = roleTexts(store, threadId, "user");
      assert.equal(users.filter((t) => t === "hello inside").length, 1);
      assert.equal(users.filter((t) => t === "outside prompt").length, 1);
    });

    it("does not append a third copy on a second reclaim", () => {
      services.setEjected(store, {
        threadId,
        ejected: false,
        home: providerHome,
      });
      services.setEjected(store, { threadId, ejected: true });
      services.setEjected(store, {
        threadId,
        ejected: false,
        home: providerHome,
      });
      const assistants = roleTexts(store, threadId, "assistant");
      assert.equal(assistants.filter((t) => t === "inside reply").length, 2);
      assert.equal(assistants.filter((t) => t === "outside reply").length, 1);
    });
  });
}

describe("reclaim finds a Grok hashed cwd group (#964)", () => {
  const LONG_CWD = `/tmp/${"a".repeat(300)}`;
  const LONG_GROUP =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-b27d87e57e568d10";
  let tmpDir;
  let store;
  let threadId;
  let providerHome;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-eject-grok-long-"));
    providerHome = path.join(tmpDir, "grok-home");
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    });
    threadId = thread.id;
    services.setProvider(store, { threadId, provider: "grok" });
    store.updateThread(threadId, {
      sessionId: RECLAIM_SESSION,
      worktreePath: LONG_CWD,
    });
    store.appendMessage(threadId, {
      id: "m-user-1",
      role: "user",
      text: "hello inside",
      createdAt: 1,
    });
    store.appendMessage(threadId, {
      id: "m-asst-1",
      role: "assistant",
      text: "inside reply",
      createdAt: 2,
    });
    services.setEjected(store, { threadId, ejected: true });
    const dir = path.join(
      providerHome,
      "sessions",
      LONG_GROUP,
      RECLAIM_SESSION,
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "chat_history.jsonl"),
      [
        { type: "user", content: "hello inside" },
        { type: "assistant", content: "inside reply" },
        { type: "user", content: "outside prompt" },
        { type: "assistant", content: "outside reply" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends outside turns from the slug-hash group", () => {
    const updated = services.setEjected(store, {
      threadId,
      ejected: false,
      home: providerHome,
    });
    assert.equal(updated.ejected, false);
    const assistants = roleTexts(store, threadId, "assistant");
    assert.ok(
      assistants.includes("outside reply"),
      `expected outside assistant turn, got ${JSON.stringify(assistants)}`,
    );
  });
});

describe("reclaim finds a Claude hashed cwd project dir (#965)", () => {
  const LONG_CWD = `/tmp/${"a".repeat(300)}`;
  const LONG_GROUP =
    "-tmp-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-w6az8n";
  let tmpDir;
  let store;
  let threadId;
  let providerHome;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-eject-claude-long-"));
    providerHome = path.join(tmpDir, "claude-home");
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    });
    threadId = thread.id;
    services.setProvider(store, { threadId, provider: "claude" });
    store.updateThread(threadId, {
      sessionId: RECLAIM_SESSION,
      worktreePath: LONG_CWD,
    });
    store.appendMessage(threadId, {
      id: "m-user-1",
      role: "user",
      text: "hello inside",
      createdAt: 1,
    });
    store.appendMessage(threadId, {
      id: "m-asst-1",
      role: "assistant",
      text: "inside reply",
      createdAt: 2,
    });
    services.setEjected(store, { threadId, ejected: true });
    const dir = path.join(providerHome, "projects", LONG_GROUP);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${RECLAIM_SESSION}.jsonl`),
      [
        {
          type: "user",
          message: { role: "user", content: "hello inside" },
          timestamp: "2026-09-06T12:00:01.000Z",
          sessionId: RECLAIM_SESSION,
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "inside reply" }],
          },
          timestamp: "2026-09-06T12:00:02.000Z",
          sessionId: RECLAIM_SESSION,
        },
        {
          type: "user",
          message: { role: "user", content: "outside prompt" },
          timestamp: "2026-09-06T12:00:03.000Z",
          sessionId: RECLAIM_SESSION,
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "outside reply" }],
          },
          timestamp: "2026-09-06T12:00:04.000Z",
          sessionId: RECLAIM_SESSION,
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends outside turns from the truncated-hash project dir", () => {
    const updated = services.setEjected(store, {
      threadId,
      ejected: false,
      home: providerHome,
    });
    assert.equal(updated.ejected, false);
    const assistants = roleTexts(store, threadId, "assistant");
    assert.ok(
      assistants.includes("outside reply"),
      `expected outside assistant turn, got ${JSON.stringify(assistants)}`,
    );
  });
});

describe("reclaim finds a Claude prefix-sibling hashed dir (#966)", () => {
  const LONG_CWD = `/tmp/${"a".repeat(300)}`;
  const LONG_GROUP =
    "-tmp-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-w6az8n";
  const SIBLING_GROUP = `${LONG_GROUP.slice(0, 200)}-drift1`;
  let tmpDir;
  let store;
  let threadId;
  let providerHome;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-eject-claude-sib-"));
    providerHome = path.join(tmpDir, "claude-home");
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    });
    threadId = thread.id;
    services.setProvider(store, { threadId, provider: "claude" });
    store.updateThread(threadId, {
      sessionId: RECLAIM_SESSION,
      worktreePath: LONG_CWD,
    });
    store.appendMessage(threadId, {
      id: "m-user-1",
      role: "user",
      text: "hello inside",
      createdAt: 1,
    });
    store.appendMessage(threadId, {
      id: "m-asst-1",
      role: "assistant",
      text: "inside reply",
      createdAt: 2,
    });
    services.setEjected(store, { threadId, ejected: true });
    const dir = path.join(providerHome, "projects", SIBLING_GROUP);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${RECLAIM_SESSION}.jsonl`),
      [
        {
          type: "user",
          message: { role: "user", content: "hello inside" },
          timestamp: "2026-09-06T12:00:01.000Z",
          sessionId: RECLAIM_SESSION,
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "inside reply" }],
          },
          timestamp: "2026-09-06T12:00:02.000Z",
          sessionId: RECLAIM_SESSION,
        },
        {
          type: "user",
          message: { role: "user", content: "outside prompt" },
          timestamp: "2026-09-06T12:00:03.000Z",
          sessionId: RECLAIM_SESSION,
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "outside reply" }],
          },
          timestamp: "2026-09-06T12:00:04.000Z",
          sessionId: RECLAIM_SESSION,
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends outside turns from the prefix-sibling hashed dir", () => {
    assert.notEqual(SIBLING_GROUP, LONG_GROUP);
    const updated = services.setEjected(store, {
      threadId,
      ejected: false,
      home: providerHome,
    });
    assert.equal(updated.ejected, false);
    const assistants = roleTexts(store, threadId, "assistant");
    assert.ok(
      assistants.includes("outside reply"),
      `expected outside assistant turn, got ${JSON.stringify(assistants)}`,
    );
  });
});

describe("reclaim finds a Claude session via realpath cwd (#968)", () => {
  let tmpDir;
  let store;
  let threadId;
  let providerHome;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-eject-claude-realpath-"));
    providerHome = path.join(tmpDir, "claude-home");
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    });
    threadId = thread.id;
    services.setProvider(store, { threadId, provider: "claude" });
    const real = path.join(tmpDir, "real-wt");
    const link = path.join(tmpDir, "link-wt");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    const resolved = fs.realpathSync(link);
    assert.notEqual(link, resolved);
    store.updateThread(threadId, {
      sessionId: RECLAIM_SESSION,
      worktreePath: link,
    });
    store.appendMessage(threadId, {
      id: "m-user-1",
      role: "user",
      text: "hello inside",
      createdAt: 1,
    });
    store.appendMessage(threadId, {
      id: "m-asst-1",
      role: "assistant",
      text: "inside reply",
      createdAt: 2,
    });
    services.setEjected(store, { threadId, ejected: true });
    writeClaudeTranscript(providerHome, resolved, RECLAIM_SESSION, [
      { role: "user", text: "hello inside" },
      { role: "assistant", text: "inside reply" },
      { role: "user", text: "outside prompt" },
      { role: "assistant", text: "outside reply" },
    ]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends outside turns from RA(realpath) when stored cwd is a symlink", () => {
    const updated = services.setEjected(store, {
      threadId,
      ejected: false,
      home: providerHome,
    });
    assert.equal(updated.ejected, false);
    const assistants = roleTexts(store, threadId, "assistant");
    assert.ok(
      assistants.includes("outside reply"),
      `expected outside assistant turn, got ${JSON.stringify(assistants)}`,
    );
  });
});

describe("reclaim finds a Claude git-worktree hashed dir (#967)", () => {
  let tmpDir;
  let store;
  let threadId;
  let providerHome;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-eject-claude-e4l-"));
    providerHome = path.join(tmpDir, "claude-home");
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    const linked = path.join(tmpDir, "linked");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["commit", "--allow-empty", "-m", "init"]);
    git(repo, ["worktree", "add", "-b", "linked", linked]);
    const porcelain = execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=",
        "worktree",
        "list",
        "--porcelain",
      ],
      { cwd: repo, encoding: "utf8" },
    );
    const trees = porcelain
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice(9));
    const linkedPath = trees.find((p) => path.basename(p) === "linked");
    if (!linkedPath) {
      throw new Error(`expected linked worktree, got ${JSON.stringify(trees)}`);
    }
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    });
    threadId = thread.id;
    services.setProvider(store, { threadId, provider: "claude" });
    store.updateThread(threadId, { sessionId: RECLAIM_SESSION });
    store.appendMessage(threadId, {
      id: "m-user-1",
      role: "user",
      text: "hello inside",
      createdAt: 1,
    });
    store.appendMessage(threadId, {
      id: "m-asst-1",
      role: "assistant",
      text: "inside reply",
      createdAt: 2,
    });
    services.setEjected(store, { threadId, ejected: true });
    writeClaudeTranscript(providerHome, linkedPath, RECLAIM_SESSION, [
      { role: "user", text: "hello inside" },
      { role: "assistant", text: "inside reply" },
      { role: "user", text: "outside prompt" },
      { role: "assistant", text: "outside reply" },
    ]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends outside turns from the linked worktree RA() dir", () => {
    const updated = services.setEjected(store, {
      threadId,
      ejected: false,
      home: providerHome,
    });
    assert.equal(updated.ejected, false);
    const assistants = roleTexts(store, threadId, "assistant");
    assert.ok(
      assistants.includes("outside reply"),
      `expected outside assistant turn, got ${JSON.stringify(assistants)}`,
    );
  });
});

describe("reclaim finds a Claude realpath hashed dir (#969)", () => {
  let tmpDir;
  let store;
  let threadId;
  let providerHome;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-eject-claude-gr-"));
    providerHome = path.join(tmpDir, "claude-home");
    store = new Store(path.join(tmpDir, "store.json"));
    const real = path.join(tmpDir, "real");
    const link = path.join(tmpDir, "link");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    git(real, ["init"]);
    const realPath = fs.realpathSync(link).normalize("NFC");
    if (claudeProjectDir(link) === claudeProjectDir(realPath)) {
      throw new Error("symlink cwd hashed the same as realpath; GR() would be untestable");
    }
    const project = await services.addProject(store, link);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    });
    threadId = thread.id;
    services.setProvider(store, { threadId, provider: "claude" });
    store.updateThread(threadId, { sessionId: RECLAIM_SESSION });
    store.appendMessage(threadId, {
      id: "m-user-1",
      role: "user",
      text: "hello inside",
      createdAt: 1,
    });
    store.appendMessage(threadId, {
      id: "m-asst-1",
      role: "assistant",
      text: "inside reply",
      createdAt: 2,
    });
    services.setEjected(store, { threadId, ejected: true });
    writeClaudeTranscript(providerHome, realPath, RECLAIM_SESSION, [
      { role: "user", text: "hello inside" },
      { role: "assistant", text: "inside reply" },
      { role: "user", text: "outside prompt" },
      { role: "assistant", text: "outside reply" },
    ]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends outside turns from RA(realpath(cwd))", () => {
    const updated = services.setEjected(store, {
      threadId,
      ejected: false,
      home: providerHome,
    });
    assert.equal(updated.ejected, false);
    const assistants = roleTexts(store, threadId, "assistant");
    assert.ok(
      assistants.includes("outside reply"),
      `expected outside assistant turn, got ${JSON.stringify(assistants)}`,
    );
  });
});
