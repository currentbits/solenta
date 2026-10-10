"use strict";

/**
 * Round 49: fork / hand-off (electron).
 * forkThread + buildHandoffPrefix + runner first-turn prefix.
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
const { rmTree } = require("./support/rmTree.js");

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

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

describe("forkThread + handoff (services)", () => {
  let tmpDir;
  let store;
  let project;
  let source;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-fork-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    project = await services.addProject(store, repo);
    source = services.createThread(store, {
      projectId: project.id,
      title: "Source work",
    });
    // Give the source a non-default config to copy.
    services.setProvider(store, {
      threadId: source.id,
      provider: "codex",
      model: "gpt-5",
    });
    services.setPermissionMode(store, {
      threadId: source.id,
      mode: "acceptEdits",
    });
    source = store.getThread(source.id);
  });

  afterEach(async () => {
    await rmTree(tmpDir);
  });

  it("copies provider/model/permissionMode and sets handoffFrom; empty transcript", () => {
    const before = deepClone(store.getThread(source.id));
    const forked = services.forkThread(store, { threadId: source.id });

    assert.notEqual(forked.id, source.id);
    assert.equal(forked.projectId, source.projectId);
    assert.equal(forked.provider, "codex");
    assert.equal(forked.model, "gpt-5");
    assert.equal(forked.permissionMode, "acceptEdits");
    assert.equal(forked.handoffFrom, source.id);
    assert.equal(forked.sessionId, null);
    assert.equal(forked.status, "idle");
    assert.equal(forked.lastVisitedAt, forked.createdAt);
    assert.equal(forked.title, "Fork: Source work");
    assert.deepEqual(store.getMessages(forked.id), []);

    // Source NEVER modified.
    assert.deepEqual(store.getThread(source.id), before);
  });

  it("applies provider/model overrides with setProvider rules", () => {
    const forked = services.forkThread(store, {
      threadId: source.id,
      provider: "claude",
      model: "claude-opus-4-20250514",
    });
    assert.equal(forked.provider, "claude");
    assert.equal(forked.model, "claude-opus-4-20250514");
    assert.equal(forked.handoffFrom, source.id);
    // Provider change without carrying old model when only provider given:
    const handoffOnly = services.forkThread(store, {
      threadId: source.id,
      provider: "claude",
    });
    assert.equal(handoffOnly.provider, "claude");
    assert.equal(handoffOnly.model, null);
  });

  it("rejects unknown source and bad provider/model with setProvider errors", () => {
    assert.throws(
      () => services.forkThread(store, { threadId: "nope" }),
      /Unknown thread: nope/,
    );
    assert.throws(
      () =>
        services.forkThread(store, {
          threadId: source.id,
          provider: "not-a-provider",
        }),
      (err) => {
        assert.equal(String(err.message), "Unknown provider: not-a-provider");
        return true;
      },
    );
    assert.throws(
      () =>
        services.forkThread(store, {
          threadId: source.id,
          model: "   ",
        }),
      /Model must be a non-empty string/,
    );
    assert.throws(
      () =>
        services.forkThread(store, {
          threadId: source.id,
          model: "x".repeat(101),
        }),
      /Model must be at most 100 characters/,
    );
  });

  it("title truncation matches createThread (THREAD_TITLE_MAX)", () => {
    const long = "L".repeat(80);
    services.setProvider(store, { threadId: source.id }); // no-op keep
    store.updateThread(source.id, { title: long });
    store.saveNow();
    const forked = services.forkThread(store, { threadId: source.id });
    assert.equal(forked.title.length, services.THREAD_TITLE_MAX);
    assert.ok(forked.title.startsWith("Fork: "));
    // createThread path alone also truncates:
    const direct = services.createThread(store, {
      projectId: project.id,
      title: "T".repeat(100),
    });
    assert.equal(direct.title.length, services.THREAD_TITLE_MAX);
  });

  it("forking an already-generated title does not stack Fork: prefixes", () => {
    const once = services.forkThread(store, { threadId: source.id });
    assert.equal(once.title, "Fork: Source work");
    const twice = services.forkThread(store, { threadId: once.id });
    assert.equal(twice.title, "Fork: Source work");
    const stacked = services.createThread(store, {
      projectId: project.id,
      title: "Fork: Fork: Fork: Build sidebar grouping",
    });
    const fromStacked = services.forkThread(store, { threadId: stacked.id });
    assert.equal(fromStacked.title, "Fork: Build sidebar grouping");
    assert.equal(fromStacked.handoffFrom, stacked.id);
    assert.equal(store.getThread(stacked.id).title, "Fork: Fork: Fork: Build sidebar grouping");
  });

  it("explicit title skips the Fork: prefix and keeps config/provenance", () => {
    const forked = services.forkThread(store, {
      threadId: source.id,
      provider: "claude",
      title: "Review permissions",
    });
    assert.equal(forked.title, "Review permissions");
    assert.equal(forked.provider, "claude");
    assert.equal(forked.model, null);
    assert.equal(forked.permissionMode, "acceptEdits");
    assert.equal(forked.handoffFrom, source.id);
    assert.equal(store.getThread(source.id).title, "Source work");
  });

  it("handoffFrom provenance persists across reload", () => {
    const forked = services.forkThread(store, { threadId: source.id });
    store.saveNow();
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    const t = reloaded.getThread(forked.id);
    assert.equal(t.handoffFrom, source.id);
    // migrate null default for legacy rows
    const legacyPath = path.join(tmpDir, "legacy.json");
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        projects: [],
        threads: [
          {
            id: "legacy",
            projectId: "p",
            title: "old",
            status: "idle",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        messagesByThread: {},
        workLogByThread: {},
        usageByThread: {},
      }),
      "utf8",
    );
    const legacy = new Store(legacyPath);
    assert.equal(legacy.getThread("legacy").handoffFrom, null);
  });

  describe("message-level fork (#158)", () => {
    function seed(threadId) {
      const msgs = [
        { id: "u1", role: "user", text: "remember APPLE", createdAt: 1 },
        { id: "a1", role: "assistant", text: "OK", createdAt: 2, claudeUuid: "uuid-a1" },
        { id: "u2", role: "user", text: "now BANANA", createdAt: 3 },
        { id: "a2", role: "assistant", text: "OK", createdAt: 4, claudeUuid: "uuid-a2" },
      ];
      store.setMessages(threadId, msgs);
      return msgs;
    }

    it("claude: copies the prefix and arms a native fork cut at that message", () => {
      services.setProvider(store, { threadId: source.id, provider: "claude" });
      store.updateThread(source.id, { sessionId: "sess-src" });
      seed(source.id);
      const beforeMsgs = deepClone(store.getMessages(source.id));

      const forked = services.forkThread(store, {
        threadId: source.id,
        messageId: "a1",
      });
      const copied = store.getMessages(forked.id);
      assert.deepEqual(copied.map((m) => m.text), ["remember APPLE", "OK"]);
      assert.ok(copied.every((m) => m.id !== "u1" && m.id !== "a1"));
      assert.equal(forked.sessionId, "sess-src");
      assert.equal(forked.forkSessionAt, "uuid-a1");
      assert.equal(forked.replayContext, false);
      assert.equal(forked.handoffFrom, source.id);
      // Session present → no hand-off digest on the first turn.
      assert.equal(
        services.buildHandoffPrefix(store.getThread(forked.id), (id) =>
          store.getMessages(id),
        ),
        "",
      );
      assert.equal(store.getThread(source.id).sessionId, "sess-src");
      assert.equal(store.getThread(source.id).forkSessionAt, null);
      assert.deepEqual(store.getMessages(source.id), beforeMsgs);
    });

    it("non-claude or no cut uuid: seeds a fresh session from the copied prefix", () => {
      store.updateThread(source.id, { sessionId: "codex-sess" });
      seed(source.id);
      const forked = services.forkThread(store, {
        threadId: source.id,
        messageId: "u2",
      });
      assert.equal(store.getMessages(forked.id).length, 3);
      assert.equal(forked.sessionId, null);
      assert.equal(forked.forkSessionAt, null);
      assert.equal(forked.replayContext, true);
      const prefix = services.buildHandoffPrefix(
        store.getThread(forked.id),
        (id) => store.getMessages(id),
      );
      assert.match(prefix, /remember APPLE/);
      assert.match(prefix, /now BANANA/);
    });

    it("hand-off away from claude never carries the claude session", () => {
      services.setProvider(store, { threadId: source.id, provider: "claude" });
      store.updateThread(source.id, { sessionId: "sess-src" });
      seed(source.id);
      const forked = services.forkThread(store, {
        threadId: source.id,
        messageId: "a1",
        provider: "codex",
      });
      assert.equal(forked.sessionId, null);
      assert.equal(forked.forkSessionAt, null);
      assert.equal(forked.replayContext, true);
    });

    it("rejects an unknown message id without creating a thread", () => {
      seed(source.id);
      const count = store.getThreads().length;
      assert.throws(
        () => services.forkThread(store, { threadId: source.id, messageId: "nope" }),
        /Unknown message: nope/,
      );
      assert.equal(store.getThreads().length, count);
    });

    it("claude buildArgs adds --fork-session --resume-session-at only with a session", () => {
      const { getProvider } = require("../providers.js");
      const claude = getProvider("claude");
      const args = claude.buildArgs({
        sessionId: "sess-src",
        forkSessionAt: "uuid-a1",
      });
      const i = args.indexOf("--resume");
      assert.deepEqual(args.slice(i, i + 5), [
        "--resume",
        "sess-src",
        "--fork-session",
        "--resume-session-at",
        "uuid-a1",
      ]);
      assert.ok(
        !claude.buildArgs({ sessionId: "s" }).includes("--fork-session"),
      );
      assert.ok(
        !claude.buildArgs({ forkSessionAt: "x" }).includes("--fork-session"),
      );
    });
  });
});

describe("buildHandoffPrefix", () => {
  it("digests the tail of the thread, both roles, oldest first", () => {
    const prefix = services.buildHandoffPrefix(
      { handoffFrom: "src", sessionId: null },
      () => [
        { role: "user", text: "hi" },
        { role: "assistant", text: "first" },
        { role: "user", text: "and then?" },
        { role: "assistant", text: "LAST ANSWER" },
      ],
    );
    assert.equal(
      prefix,
      "[Hand-off context: the last messages of the source thread, truncated — " +
        "not the full transcript]\n" +
        "user: hi\n\nassistant: first\n\nuser: and then?\n\n" +
        "assistant: LAST ANSWER\n[End context]\n\n",
    );
  });

  it("keeps at most HANDOFF_MESSAGE_COUNT messages, newest kept", () => {
    const msgs = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      text: `m${i}`,
    }));
    const prefix = services.buildHandoffPrefix(
      { handoffFrom: "src", sessionId: null },
      () => msgs,
    );
    const bodies = prefix
      .split("\n")
      .filter((l) => l.startsWith("user: ") || l.startsWith("assistant: "));
    assert.equal(bodies.length, services.HANDOFF_MESSAGE_COUNT);
    assert.ok(prefix.includes("assistant: m39"));
    assert.ok(!prefix.includes("user: m0\n"));
  });

  it("truncates a long message to HANDOFF_MESSAGE_MAX", () => {
    const long = "A".repeat(services.HANDOFF_MESSAGE_MAX + 50);
    const prefix = services.buildHandoffPrefix(
      { handoffFrom: "src", sessionId: null },
      () => [{ role: "assistant", text: long }],
    );
    assert.ok(
      prefix.includes(
        "assistant: " + "A".repeat(services.HANDOFF_MESSAGE_MAX) + "\n[…truncated]",
      ),
    );
    assert.ok(!prefix.includes("A".repeat(services.HANDOFF_MESSAGE_MAX + 1)));
  });

  it("skips silently when session exists, no assistant, or missing source", () => {
    assert.equal(
      services.buildHandoffPrefix(
        { handoffFrom: "src", sessionId: "sess-1" },
        () => [{ role: "assistant", text: "x" }],
      ),
      "",
    );
    assert.equal(
      services.buildHandoffPrefix(
        { handoffFrom: "src", sessionId: null },
        () => [{ role: "user", text: "only user" }],
      ),
      "",
    );
    assert.equal(
      services.buildHandoffPrefix(
        { handoffFrom: "src", sessionId: null },
        () => null,
      ),
      "",
    );
    assert.equal(
      services.buildHandoffPrefix({ handoffFrom: null, sessionId: null }, () => [
        { role: "assistant", text: "x" },
      ]),
      "",
    );
  });
});

describe("runner hand-off prefix on first turn only", () => {
  let tmpDir;
  let store;
  let runner;
  let project;
  let prevSimulate;
  let prevClaudeBin;
  let prevArgvFile;
  let argvFile;
  let argvLog;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevClaudeBin = process.env.CODER_CLAUDE_BIN;
    prevArgvFile = process.env.CODER_FAKE_CLAUDE_ARGV_FILE;
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-handoff-run-"));
    argvFile = path.join(tmpDir, "argv.json");
    argvLog = path.join(tmpDir, "argv-log.jsonl");
    // Captures each invocation's CLI prompt (delivered on stdin in
    // interactive mode) as a one-element array, and emits a session.
    const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
function emit(o){process.stdout.write(JSON.stringify(o)+"\\n");}
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  const nl = buf.indexOf("\\n");
  if (nl < 0) return;
  let prompt = "";
  try { prompt = JSON.parse(buf.slice(0, nl)).message.content; } catch {}
  if (process.env.CODER_FAKE_CLAUDE_ARGV_FILE) {
    fs.writeFileSync(process.env.CODER_FAKE_CLAUDE_ARGV_FILE, JSON.stringify([prompt]), "utf8");
  }
  if (process.env.CODER_FAKE_CLAUDE_ARGV_LOG) {
    fs.appendFileSync(process.env.CODER_FAKE_CLAUDE_ARGV_LOG, JSON.stringify([prompt]) + "\\n", "utf8");
  }
  emit({type:"system",subtype:"init",session_id:"sess-handoff-1",model:"m"});
  emit({type:"assistant",message:{content:[{type:"text",text:"ok"}]}});
  emit({type:"result",subtype:"success",result:"ok",usage:{input_tokens:1,output_tokens:1},total_cost_usd:0,session_id:"sess-handoff-1"});
  process.exit(0);
});
`;
    const fake = writeFakeBin(path.join(tmpDir, "fake-claude"), body);
    process.env.CODER_CLAUDE_BIN = fake;
    process.env.CODER_FAKE_CLAUDE_ARGV_FILE = argvFile;
    process.env.CODER_FAKE_CLAUDE_ARGV_LOG = argvLog;

    store = new Store(path.join(tmpDir, "store.json"));
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
    });
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    project = await services.addProject(store, repo);
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevClaudeBin === undefined) delete process.env.CODER_CLAUDE_BIN;
    else process.env.CODER_CLAUDE_BIN = prevClaudeBin;
    if (prevArgvFile === undefined) delete process.env.CODER_FAKE_CLAUDE_ARGV_FILE;
    else process.env.CODER_FAKE_CLAUDE_ARGV_FILE = prevArgvFile;
    delete process.env.CODER_FAKE_CLAUDE_ARGV_LOG;
  });

  function lastArgvPrompt() {
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    return argv[argv.length - 1];
  }

  it("turn 1 CLI prompt is prefixed; transcript stores raw; turn 2 unprefixed", async () => {
    const source = services.createThread(store, {
      projectId: project.id,
      title: "Has answer",
    });
    store.appendMessage(source.id, {
      id: "m-as",
      role: "assistant",
      text: "PRIOR CONTEXT FROM SOURCE",
      createdAt: Date.now(),
    });
    store.saveNow();

    const forked = services.forkThread(store, {
      threadId: source.id,
      provider: "claude",
    });
    assert.equal(forked.sessionId, null);
    assert.equal(forked.handoffFrom, source.id);

    const userPrompt = "continue the work";
    await runner.startRun({ threadId: forked.id, prompt: userPrompt });
    await waitFor(() => {
      const t = store.getThread(forked.id);
      return t && (t.status === "done" || t.status === "failed" || t.sessionId);
    });

    const cliPrompt1 = lastArgvPrompt();
    assert.ok(
      cliPrompt1.startsWith("[Hand-off context:"),
      `CLI must see prefix: ${cliPrompt1.slice(0, 80)}`,
    );
    assert.ok(cliPrompt1.includes("PRIOR CONTEXT FROM SOURCE"));
    assert.ok(cliPrompt1.endsWith(userPrompt));

    // Transcript stores RAW prompt only.
    const userMsgs = store
      .getMessages(forked.id)
      .filter((m) => m.role === "user");
    assert.equal(userMsgs.length, 1);
    assert.equal(userMsgs[0].text, userPrompt);
    assert.ok(!userMsgs[0].text.includes("[Hand-off context"));

    // sessionId stamped so turn 2 skips prefix.
    const after1 = store.getThread(forked.id);
    assert.ok(after1.sessionId, "first turn must stamp sessionId");
    assert.equal(after1.handoffFrom, source.id, "provenance retained");

    // Wait for idle-ish so we can start again.
    await waitFor(() => !runner.isRunning(forked.id));

    const prompt2 = "second turn plain";
    await runner.startRun({ threadId: forked.id, prompt: prompt2 });
    await waitFor(() => {
      const msgs = store.getMessages(forked.id).filter((m) => m.role === "user");
      return msgs.length >= 2 && !runner.isRunning(forked.id);
    });

    const cliPrompt2 = lastArgvPrompt();
    assert.equal(cliPrompt2, prompt2);
    assert.ok(!cliPrompt2.includes("[Hand-off context"));

    const allUser = store
      .getMessages(forked.id)
      .filter((m) => m.role === "user")
      .map((m) => m.text);
    assert.deepEqual(allUser, [userPrompt, prompt2]);
  });

  it("skips prefix when source has no assistant message", async () => {
    const source = services.createThread(store, {
      projectId: project.id,
      title: "Empty source",
    });
    const forked = services.forkThread(store, {
      threadId: source.id,
      provider: "claude",
    });
    await runner.startRun({ threadId: forked.id, prompt: "hello alone" });
    await waitFor(() => !runner.isRunning(forked.id));
    assert.equal(lastArgvPrompt(), "hello alone");
    assert.equal(
      store.getMessages(forked.id).find((m) => m.role === "user").text,
      "hello alone",
    );
  });

  it("skips prefix when source thread was deleted", async () => {
    const source = services.createThread(store, {
      projectId: project.id,
      title: "Doomed",
    });
    store.appendMessage(source.id, {
      id: "a1",
      role: "assistant",
      text: "gone soon",
      createdAt: Date.now(),
    });
    store.saveNow();
    const forked = services.forkThread(store, {
      threadId: source.id,
      provider: "claude",
    });
    // Delete source without touching the fork.
    store.removeThread(source.id);
    store.saveNow();
    await runner.startRun({ threadId: forked.id, prompt: "after delete" });
    await waitFor(() => !runner.isRunning(forked.id));
    assert.equal(lastArgvPrompt(), "after delete");
  });
});

describe("IPC seam threads:fork", () => {
  it("preload exposes fork and main registers threads:fork", () => {
    // Lightweight channel registration check matching pin/snooze pattern.
    const Module = require("module");
    const handlers = new Map();
    const bridge = {};
    const electronStub = {
      ipcMain: {
        handle(channel, fn) {
          handlers.set(channel, fn);
        },
      },
      contextBridge: {
        exposeInMainWorld(name, api) {
          bridge[name] = api;
        },
      },
      ipcRenderer: {
        invoke: async () => null,
        on: () => {},
      },
    };
    const orig = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (id === "electron") return electronStub;
      return orig.apply(this, arguments);
    };
    try {
      delete require.cache[require.resolve("../ipc.js")];
      delete require.cache[require.resolve("../preload.js")];
      const { registerIpc } = require("../ipc.js");
      const s = new Store(
        path.join(os.tmpdir(), `coder-fork-ipc-${Date.now()}.json`),
      );
      registerIpc({
        ipcMain: electronStub.ipcMain,
        dialog: {},
        store: s,
        runner: { start() {}, stop() {}, stopAll() {} },
        broadcast() {},
        worktreeBase: os.tmpdir(),
        userDataPath: os.tmpdir(),
      });
      require("../preload.js");
      assert.equal(typeof bridge.coder.threads.fork, "function");
      assert.ok(handlers.has("threads:fork"));
    } finally {
      Module.prototype.require = orig;
      delete require.cache[require.resolve("../ipc.js")];
      delete require.cache[require.resolve("../preload.js")];
    }
  });
});

describe("runner native claude fork at a message (#158)", () => {
  let tmpDir;
  let store;
  let runner;
  let project;
  let argvFile;
  const saved = {};
  const ENV = [
    "CODER_SIMULATE",
    "CODER_CLAUDE_BIN",
    "CODER_FAKE_ARGV",
    "CODER_FAKE_FAIL",
  ];

  beforeEach(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-native-fork-"));
    argvFile = path.join(tmpDir, "argv.json");
    // Records argv + stdin prompt; emits a uuid-stamped assistant entry.
    const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
function emit(o){process.stdout.write(JSON.stringify(o)+"\\n");}
if (process.env.CODER_FAKE_FAIL) {
  process.stderr.write("No message found with message.uuid\\n");
  process.exit(1);
}
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  const nl = buf.indexOf("\\n");
  if (nl < 0) return;
  let prompt = "";
  try { prompt = JSON.parse(buf.slice(0, nl)).message.content; } catch {}
  fs.writeFileSync(process.env.CODER_FAKE_ARGV, JSON.stringify({ argv: process.argv.slice(2), prompt }));
  emit({type:"system",subtype:"init",session_id:"sess-forked",model:"m"});
  emit({type:"assistant",uuid:"chain-1",message:{content:[{type:"text",text:"forked reply"}]}});
  emit({type:"result",subtype:"success",result:"ok",usage:{input_tokens:1,output_tokens:1},total_cost_usd:0,session_id:"sess-forked"});
  process.exit(0);
});
`;
    process.env.CODER_CLAUDE_BIN = writeFakeBin(path.join(tmpDir, "fake-claude"), body);
    process.env.CODER_FAKE_ARGV = argvFile;
    store = new Store(path.join(tmpDir, "store.json"));
    runner = createRunner({ store, core: await loadCore(), pushFn: () => {}, tickMs: 15 });
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    project = await services.addProject(store, repo);
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function forkAtAnswer() {
    const source = services.createThread(store, { projectId: project.id, title: "Src" });
    services.setProvider(store, { threadId: source.id, provider: "claude" });
    store.updateThread(source.id, { sessionId: "sess-src" });
    store.setMessages(source.id, [
      { id: "u1", role: "user", text: "q", createdAt: 1 },
      { id: "a1", role: "assistant", text: "GOOD ANSWER", createdAt: 2, claudeUuid: "cut-1" },
      { id: "u2", role: "user", text: "went wrong", createdAt: 3 },
    ]);
    return services.forkThread(store, { threadId: source.id, messageId: "a1" });
  }

  it("resumes the source session forked at the cut, then records its own session", async () => {
    const forked = forkAtAnswer();
    await runner.startRun({ threadId: forked.id, prompt: "try again" });
    await waitFor(() => !runner.isRunning(forked.id) && store.getThread(forked.id).sessionId === "sess-forked");

    const { argv, prompt } = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const i = argv.indexOf("--resume");
    assert.deepEqual(argv.slice(i, i + 5), [
      "--resume", "sess-src", "--fork-session", "--resume-session-at", "cut-1",
    ]);
    assert.equal(prompt, "try again", "native fork needs no hand-off digest");
    const t = store.getThread(forked.id);
    assert.equal(t.forkSessionAt, null);
    const reply = store.getMessages(forked.id).find((m) => m.text === "forked reply");
    assert.equal(reply.claudeUuid, "chain-1", "assistant text carries its chain uuid");
  });

  it("a failed native fork falls back to a seeded fresh session, never the source", async () => {
    process.env.CODER_FAKE_FAIL = "1";
    const forked = forkAtAnswer();
    await runner.startRun({ threadId: forked.id, prompt: "try again" }).catch(() => {});
    await waitFor(() => !runner.isRunning(forked.id) && store.getThread(forked.id).status === "failed");
    const t = store.getThread(forked.id);
    assert.equal(t.sessionId, null);
    assert.equal(t.forkSessionAt, null);
    assert.equal(t.replayContext, true);
  });
});
