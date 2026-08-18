"use strict";

/**
 * Issue #254: edit-and-resubmit rewind (electron).
 * rewindThread + store.truncateFromMessage + replayContext prefix.
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
const {
  setupWorktree,
  maybeCreateCheckpoint,
  listCheckpoints,
  CHECKPOINT_SUBJECT_PREFIX,
} = require("../worktrees.js");
const { createRunner } = require("../runner.js");
const { writeFakeBin } = require("./support/fakeBin.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

function seedTranscript(store, threadId) {
  store.setMessages(threadId, [
    { id: "u1", role: "user", text: "first", runId: "r1", createdAt: 1 },
    { id: "a1", role: "assistant", text: "RETAINED ANSWER", runId: "r1", createdAt: 2 },
    { id: "u2", role: "user", text: "second", runId: "r2", createdAt: 3 },
    { id: "a2", role: "assistant", text: "DROPPED ANSWER", runId: "r2", createdAt: 4 },
    { id: "u3", role: "user", text: "third", runId: "r3", createdAt: 5 },
    { id: "a3", role: "assistant", text: "also dropped", runId: "r3", createdAt: 6 },
  ]);
  store.setWorkLog(threadId, [
    { id: "w1", runId: "r1", label: "keep", done: true, timestamp: 1 },
    { id: "w2", runId: "r2", label: "drop-2", done: true, timestamp: 2 },
    { id: "w3", runId: "r3", label: "drop-3", done: true, timestamp: 3 },
    { id: "w0", runId: null, label: "no-run", done: true, timestamp: 0 },
  ]);
  store.setUsage(threadId, {
    model: "m",
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 1.25,
    turns: 3,
  });
  store.updateThread(threadId, { sessionId: "sess-before" });
  store.saveNow();
}

describe("rewindThread (services)", () => {
  let tmpDir;
  let store;
  let project;
  let thread;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-rewind-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "Rewind me",
    });
    seedTranscript(store, thread.id);
    thread = store.getThread(thread.id);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("truncates messages and work-log; usage and spend untouched", async () => {
    const usageBefore = structuredClone(store.getUsage(thread.id));
    const result = await services.rewindThread(store, {
      threadId: thread.id,
      messageId: "u2",
      prompt: "second, edited",
    });

    assert.equal(result.droppedMessages, 4);
    assert.equal(result.restoredSha, null);
    assert.deepEqual(
      store.getMessages(thread.id).map((m) => m.id),
      ["u1", "a1"],
    );
    assert.deepEqual(
      store.getWorkLog(thread.id).map((w) => w.id),
      ["w1", "w0"],
    );
    assert.deepEqual(store.getUsage(thread.id), usageBefore);
    assert.equal(result.thread.sessionId, null);
    assert.equal(result.thread.replayContext, true);
    const persisted = store.getThread(thread.id);
    assert.equal(persisted.sessionId, null);
    assert.equal(persisted.replayContext, true);
    // Rewind does not append the edited prompt.
    assert.equal(
      store.getMessages(thread.id).filter((m) => m.role === "user").length,
      1,
    );
  });

  it("replayContext persists across reload", async () => {
    await services.rewindThread(store, {
      threadId: thread.id,
      messageId: "u2",
      prompt: "edited",
    });
    // rewindThread saveNow()s; do not flush again so a debounce would fail this.
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    const t = reloaded.getThread(thread.id);
    assert.equal(t.sessionId, null);
    assert.equal(t.replayContext, true);
    assert.deepEqual(
      reloaded.getMessages(thread.id).map((m) => m.id),
      ["u1", "a1"],
    );
  });

  it("rejects while working / non-user / unknown message / empty prompt / unknown thread", async () => {
    store.updateThread(thread.id, { status: "working" });
    await assert.rejects(
      () =>
        services.rewindThread(store, {
          threadId: thread.id,
          messageId: "u2",
          prompt: "x",
        }),
      /Cannot rewind while a run is active/,
    );
    store.updateThread(thread.id, { status: "idle" });

    await assert.rejects(
      () =>
        services.rewindThread(store, {
          threadId: thread.id,
          messageId: "u2",
          prompt: "x",
        }, { isRunning: () => true }),
      /Cannot rewind while a run is active/,
    );

    await assert.rejects(
      () =>
        services.rewindThread(store, {
          threadId: thread.id,
          messageId: "a1",
          prompt: "x",
        }),
      /Not a user message: a1/,
    );
    await assert.rejects(
      () =>
        services.rewindThread(store, {
          threadId: thread.id,
          messageId: "nope",
          prompt: "x",
        }),
      /Unknown message: nope/,
    );
    await assert.rejects(
      () =>
        services.rewindThread(store, {
          threadId: thread.id,
          messageId: "u2",
          prompt: "   ",
        }),
      /Prompt cannot be empty/,
    );
    await assert.rejects(
      () =>
        services.rewindThread(store, {
          threadId: "missing",
          messageId: "u2",
          prompt: "x",
        }),
      /Unknown thread: missing/,
    );

    // Failed rejects leave the transcript intact.
    assert.equal(store.getMessages(thread.id).length, 6);
    assert.equal(store.getThread(thread.id).sessionId, "sess-before");
  });

  it("restoreFiles with no worktree returns restoredSha null", async () => {
    assert.equal(thread.worktreePath, null);
    const result = await services.rewindThread(store, {
      threadId: thread.id,
      messageId: "u2",
      prompt: "edited",
      restoreFiles: true,
    });
    assert.equal(result.restoredSha, null);
    assert.equal(result.droppedMessages, 4);
    assert.equal(result.thread.replayContext, true);
  });
});

describe("buildHandoffPrefix replayContext", () => {
  it("digests this thread's own tail when replayContext is set", () => {
    const prefix = services.buildHandoffPrefix(
      { id: "self", replayContext: true, sessionId: null },
      (id) => {
        assert.equal(id, "self");
        return [
          { role: "user", text: "kept" },
          { role: "assistant", text: "RETAINED ANSWER" },
        ];
      },
    );
    assert.ok(prefix.startsWith("[Hand-off context:"));
    assert.ok(prefix.includes("RETAINED ANSWER"));
    assert.ok(prefix.includes("user: kept"));
  });

  it("does not use handoffFrom when replaying (no self-cycle)", () => {
    const prefix = services.buildHandoffPrefix(
      {
        id: "self",
        handoffFrom: "other",
        replayContext: true,
        sessionId: null,
      },
      (id) => {
        assert.equal(id, "self");
        return [{ role: "assistant", text: "OWN TAIL" }];
      },
    );
    assert.ok(prefix.includes("OWN TAIL"));
  });

  it("skips when sessionId is set", () => {
    assert.equal(
      services.buildHandoffPrefix(
        { id: "self", replayContext: true, sessionId: "sess" },
        () => [{ role: "assistant", text: "x" }],
      ),
      "",
    );
  });
});

async function makeRewindWorktree() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-rewind-ckpt-"));
  const store = new Store(path.join(tmpDir, "store.json"));
  const worktreeBase = path.join(tmpDir, "worktrees");
  const repo = path.join(tmpDir, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);
  try {
    git(repo, ["checkout", "-b", "main"]);
  } catch {
    // already on main
  }
  const project = await services.addProject(store, repo);
  const thread = services.createThread(store, {
    projectId: project.id,
    title: "Ckpt rewind",
  });
  const setup = setupWorktree({
    store,
    threadId: thread.id,
    worktreeBase,
    broadcast: () => {},
  });
  return {
    tmpDir,
    store,
    thread,
    worktreePath: setup.worktreePath,
    file: path.join(setup.worktreePath, "tracked.txt"),
  };
}

function appendTurn(store, threadId, n, createdAt) {
  store.setMessages(threadId, [
    ...store.getMessages(threadId),
    { id: `u${n}`, role: "user", text: `turn ${n}`, runId: `r${n}`, createdAt },
    {
      id: `a${n}`,
      role: "assistant",
      text: `ok${n}`,
      runId: `r${n}`,
      createdAt: createdAt + 1,
    },
  ]);
}

describe("restoreFiles resets to the last retained turn", () => {
  let fx;

  afterEach(() => {
    if (fx) {
      try {
        fs.rmSync(fx.tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      fx = null;
    }
  });

  it("hard-resets the worktree to the checkpoint before the edited message", async () => {
    fx = await makeRewindWorktree();
    const { store, thread, file } = fx;

    appendTurn(store, thread.id, 1, Date.now());
    fs.writeFileSync(file, "v1\n");
    const c1 = await maybeCreateCheckpoint(store, thread.id);
    assert.ok(c1);
    assert.equal(c1.turn, 1);
    assert.equal(c1.message, `${CHECKPOINT_SUBJECT_PREFIX}1`);

    // Beat git %ct 1s granularity so u2.createdAt > c1.at and < c2.at.
    await sleep(1100);
    appendTurn(store, thread.id, 2, Date.now());
    await sleep(1100);
    fs.writeFileSync(file, "v2\n");
    const c2 = await maybeCreateCheckpoint(store, thread.id);
    assert.ok(c2);
    assert.equal(c2.turn, 2);

    await sleep(1100);
    appendTurn(store, thread.id, 3, Date.now());
    fs.writeFileSync(file, "v3\n");
    await maybeCreateCheckpoint(store, thread.id);
    assert.equal(fs.readFileSync(file, "utf8"), "v3\n");
    store.saveNow();

    const result = await services.rewindThread(store, {
      threadId: thread.id,
      messageId: "u2",
      prompt: "two, edited",
      restoreFiles: true,
    });

    assert.equal(result.droppedMessages, 4);
    assert.equal(result.restoredSha, c1.sha);
    assert.equal(fs.readFileSync(file, "utf8"), "v1\n");
    assert.deepEqual(
      store.getMessages(thread.id).map((m) => m.id),
      ["u1", "a1"],
    );
  });

  it("skips a clean middle turn and restores the files from the turn that precedes the edit", async () => {
    fx = await makeRewindWorktree();
    const { store, thread, file } = fx;

    appendTurn(store, thread.id, 1, Date.now());
    fs.writeFileSync(file, "v1\n");
    const c1 = await maybeCreateCheckpoint(store, thread.id);
    assert.ok(c1);
    assert.equal(c1.turn, 1);

    await sleep(1100);
    appendTurn(store, thread.id, 2, Date.now());
    const skipped = await maybeCreateCheckpoint(store, thread.id);
    assert.equal(skipped, null, "clean worktree must not consume a turn number");

    await sleep(1100);
    const u3At = Date.now();
    appendTurn(store, thread.id, 3, u3At);
    await sleep(1100);
    fs.writeFileSync(file, "v3\n");
    const c3 = await maybeCreateCheckpoint(store, thread.id);
    assert.ok(c3);
    assert.equal(c3.turn, 2, "second commit is numbered 2, not 3");
    assert.equal(fs.readFileSync(file, "utf8"), "v3\n");
    store.saveNow();

    const result = await services.rewindThread(store, {
      threadId: thread.id,
      messageId: "u3",
      prompt: "three, edited",
      restoreFiles: true,
    });

    assert.equal(result.droppedMessages, 2);
    assert.equal(result.restoredSha, c1.sha);
    assert.notEqual(result.restoredSha, c3.sha);
    assert.equal(fs.readFileSync(file, "utf8"), "v1\n");
    assert.deepEqual(
      store.getMessages(thread.id).map((m) => m.id),
      ["u1", "a1", "u2", "a2"],
    );
  });

  it("does not restore a checkpoint that arrived via merge", async () => {
    fx = await makeRewindWorktree();
    const { store, thread, worktreePath: wt } = fx;
    const ownFile = path.join(wt, "own.txt");
    const mergedFile = path.join(wt, "from-worker.txt");
    const branch = git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const t0 = Date.now();
    // Foreign committer time sits between this thread's own checkpoint and
    // the edited message, so a newest-at-or-before walk of ALL reachable
    // history would pick the worker's tree.
    const foreignAt = t0 + 60_000;
    const editAt = t0 + 120_000;

    git(wt, ["checkout", "-b", "foreign-worker"]);
    fs.writeFileSync(ownFile, "FORK-OVERWRITE\n");
    fs.writeFileSync(mergedFile, "worker-only\n");
    git(wt, ["add", "-A"]);
    const foreignDate = new Date(foreignAt).toISOString();
    execFileSync(
      "git",
      [
        "-c",
        "user.email=solenta@local",
        "-c",
        "user.name=Solenta",
        "commit",
        "-m",
        `${CHECKPOINT_SUBJECT_PREFIX}1`,
      ],
      {
        cwd: wt,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: foreignDate,
          GIT_COMMITTER_DATE: foreignDate,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const foreignSha = git(wt, ["rev-parse", "HEAD"]);
    git(wt, ["checkout", branch]);
    execFileSync(
      "git",
      [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test",
        "merge",
        "--no-ff",
        "-m",
        "merge worker",
        "foreign-worker",
      ],
      { cwd: wt, stdio: ["ignore", "pipe", "pipe"] },
    );

    fs.writeFileSync(ownFile, "thread-after-merge\n");
    const own = await maybeCreateCheckpoint(store, thread.id);
    assert.ok(own);
    assert.notEqual(own.sha, foreignSha);
    const ownAt =
      Number(git(wt, ["log", "-1", "--format=%ct", own.sha])) * 1000;
    assert.ok(
      ownAt < foreignAt,
      `own checkpoint (${ownAt}) must be older than the faked foreign at (${foreignAt})`,
    );
    assert.equal(fs.readFileSync(ownFile, "utf8"), "thread-after-merge\n");
    assert.equal(fs.readFileSync(mergedFile, "utf8"), "worker-only\n");

    appendTurn(store, thread.id, 1, editAt);
    appendTurn(store, thread.id, 2, editAt + 1);
    store.saveNow();

    const listed = await listCheckpoints({ store, threadId: thread.id });
    assert.ok(
      listed.every((c) => c.sha !== foreignSha),
      "merged-in worker checkpoint must not appear in listCheckpoints",
    );

    const result = await services.rewindThread(store, {
      threadId: thread.id,
      messageId: "u1",
      prompt: "one, edited",
      restoreFiles: true,
    });

    assert.equal(result.restoredSha, own.sha);
    assert.notEqual(result.restoredSha, foreignSha);
    assert.equal(fs.readFileSync(ownFile, "utf8"), "thread-after-merge\n");
    assert.equal(
      fs.readFileSync(mergedFile, "utf8"),
      "worker-only\n",
      "merged worker file must survive; reset landed on this thread, not the fork",
    );
    assert.notEqual(fs.readFileSync(ownFile, "utf8"), "FORK-OVERWRITE\n");
  });
});

describe("runner replayContext prefix on first turn only", () => {
  let tmpDir;
  let store;
  let runner;
  let project;
  let prevSimulate;
  let prevClaudeBin;
  let prevArgvFile;
  let argvFile;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevClaudeBin = process.env.CODER_CLAUDE_BIN;
    prevArgvFile = process.env.CODER_FAKE_CLAUDE_ARGV_FILE;
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-rewind-run-"));
    argvFile = path.join(tmpDir, "argv.json");
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
  emit({type:"system",subtype:"init",session_id:"sess-rewind-1",model:"m"});
  emit({type:"assistant",message:{content:[{type:"text",text:"ok"}]}});
  emit({type:"result",subtype:"success",result:"ok",usage:{input_tokens:1,output_tokens:1},total_cost_usd:0,session_id:"sess-rewind-1"});
  process.exit(0);
});
`;
    const fake = writeFakeBin(path.join(tmpDir, "fake-claude"), body);
    process.env.CODER_CLAUDE_BIN = fake;
    process.env.CODER_FAKE_CLAUDE_ARGV_FILE = argvFile;

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

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevClaudeBin === undefined) delete process.env.CODER_CLAUDE_BIN;
    else process.env.CODER_CLAUDE_BIN = prevClaudeBin;
    if (prevArgvFile === undefined) delete process.env.CODER_FAKE_CLAUDE_ARGV_FILE;
    else process.env.CODER_FAKE_CLAUDE_ARGV_FILE = prevArgvFile;
  });

  function lastArgvPrompt() {
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    return argv[argv.length - 1];
  }

  it("turn 1 CLI prompt is prefixed from retained tail; turn 2 is not", async () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Replay",
    });
    seedTranscript(store, thread.id);
    await services.rewindThread(store, {
      threadId: thread.id,
      messageId: "u2",
      prompt: "second, edited",
    });
    assert.equal(store.getThread(thread.id).replayContext, true);
    assert.equal(store.getThread(thread.id).sessionId, null);

    const edited = "second, edited";
    await runner.startRun({ threadId: thread.id, prompt: edited });
    await waitFor(() => {
      const t = store.getThread(thread.id);
      return t && (t.status === "done" || t.status === "failed" || t.sessionId);
    });

    const cliPrompt1 = lastArgvPrompt();
    assert.ok(
      cliPrompt1.startsWith("[Hand-off context:"),
      `CLI must see prefix: ${cliPrompt1.slice(0, 80)}`,
    );
    assert.ok(cliPrompt1.includes("RETAINED ANSWER"));
    assert.ok(!cliPrompt1.includes("DROPPED ANSWER"));
    assert.ok(cliPrompt1.endsWith(edited));

    const userMsgs = store
      .getMessages(thread.id)
      .filter((m) => m.role === "user");
    assert.equal(userMsgs.length, 2);
    assert.equal(userMsgs[1].text, edited);
    assert.ok(!userMsgs[1].text.includes("[Hand-off context"));

    const after1 = store.getThread(thread.id);
    assert.ok(after1.sessionId, "first turn must stamp sessionId");
    assert.equal(after1.replayContext, false);

    await waitFor(() => !runner.isRunning(thread.id));

    const prompt2 = "second turn plain";
    await runner.startRun({ threadId: thread.id, prompt: prompt2 });
    await waitFor(() => {
      const msgs = store.getMessages(thread.id).filter((m) => m.role === "user");
      return msgs.length >= 3 && !runner.isRunning(thread.id);
    });

    const cliPrompt2 = lastArgvPrompt();
    assert.equal(cliPrompt2, prompt2);
    assert.ok(!cliPrompt2.includes("[Hand-off context"));
    assert.equal(store.getThread(thread.id).replayContext, false);
  });
});

describe("IPC seam threads:rewind", () => {
  it("preload exposes rewind and main registers threads:rewind", () => {
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
        path.join(os.tmpdir(), `coder-rewind-ipc-${Date.now()}.json`),
      );
      registerIpc({
        ipcMain: electronStub.ipcMain,
        dialog: {},
        store: s,
        runner: { start() {}, stop() {}, stopAll() {}, isRunning() { return false; } },
        broadcast() {},
        worktreeBase: os.tmpdir(),
        userDataPath: os.tmpdir(),
      });
      require("../preload.js");
      assert.equal(typeof bridge.coder.threads.rewind, "function");
      assert.ok(handlers.has("threads:rewind"));
    } finally {
      Module.prototype.require = orig;
      delete require.cache[require.resolve("../ipc.js")];
      delete require.cache[require.resolve("../preload.js")];
    }
  });
});
