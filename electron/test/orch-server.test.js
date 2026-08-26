const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const {
  createOrchServer,
  createToolHandlers,
  INSTRUCTIONS,
} = require("../orchServer.js");
const { knownProviderIds } = require("../providers.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const {
  createMemorySupervisor,
  getClaudeMcpArgs,
  getCodexMcpArgs,
  getCodexMcpEnv,
  ensureKimiMcpConfig,
  registerMcpServer,
  unregisterMcpServer,
  resetMemorySupForTests,
} = require("../memory-sup.js");

const APP_PATH = path.join(__dirname, "..", "..");

function waitFor(predicate, { timeoutMs = 10000, intervalMs = 30 } = {}) {
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

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

/** Fake store over plain data, matching the Store read API. */
function makeFakeStore() {
  // t1/t2 in one project, t3 in another: the cross-project guard needs a
  // thread on the far side of a project boundary to reject (issue #109).
  const projects = {
    p1: { id: "p1", name: "Alpha", path: "/tmp/alpha" },
    p2: { id: "p2", name: "Beta", path: "/tmp/beta" },
  };
  const threads = [
    {
      id: "t1",
      title: "First",
      provider: "claude",
      status: "idle",
      handoffFrom: null,
      projectId: "p1",
    },
    {
      id: "t2",
      title: "Second",
      provider: "codex",
      status: "working",
      handoffFrom: "t1",
      projectId: "p1",
    },
    {
      id: "t3",
      title: "Broken",
      provider: "grok",
      status: "failed",
      handoffFrom: null,
      projectId: "p2",
    },
  ];
  const messagesByThread = {
    t1: [
      { role: "user", text: "hello" },
      { role: "assistant", text: "first line\nsecond line" },
    ],
    t2: [{ role: "user", text: "only user" }],
    t3: [
      { role: "user", text: "do it" },
      { role: "assistant", text: "starting" },
      { role: "event", text: "Allowed: something" },
      { role: "event", text: "Run error: result subtype error_during_execution" },
    ],
  };
  return {
    getThreads: () => threads,
    getThread: (id) => threads.find((t) => t.id === id) || null,
    getProject: (id) => projects[id] || null,
    getProjects: () => Object.values(projects),
    getMessages: (id) => messagesByThread[id] || [],
    updateThread: (id, patch) => {
      const t = threads.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
      return t || null;
    },
    save: () => {},
    getSettings: () => ({
      subagentPool: { defaultAlias: null, force: false, entries: [] },
    }),
    threads,
  };
}

function makeDeps() {
  const runs = [];
  const forks = [];
  const stopped = [];
  const retired = [];
  const asked = [];
  const broadcasts = [];
  const inbounds = [];
  const simulatorCalls = [];
  /** @type {string[]} */
  const logs = [];
  const store = makeFakeStore();
  const simulator = {
    async releaseThread(input) {
      simulatorCalls.push(["releaseThread", input.threadId]);
      if (simulator.releaseThreadError) throw simulator.releaseThreadError;
      return Object.freeze({ released: true });
    },
    async releaseProject(input) {
      simulatorCalls.push(["releaseProject", input.projectId]);
      return Object.freeze({ released: true });
    },
    releaseThreadError: null,
  };
  const deps = {
    store,
    runner: {
      startRun: async (input) => {
        runs.push(input);
        return { runId: "r" + runs.length };
      },
      stopRun: async (input) => {
        stopped.push(input);
        return { stopped: 1 };
      },
      disposeClaudeSession: (id) => {
        retired.push(id);
      },
      askUser: (input) => {
        asked.push(input);
        return { asked: true, questions: input.questions.length };
      },
      isRunning: (id) => {
        const t = store.getThread(id);
        return Boolean(t && t.status === "working");
      },
      appendInbound: (id, payload) => {
        inbounds.push({ threadId: id, ...payload });
      },
    },
    forkThread: (store, input) => {
      forks.push(input);
      const fork = { id: "fork-" + forks.length, archived: false };
      store.threads.push(fork);
      return fork;
    },
    getProvider: (id) =>
      knownProviderIds().includes(id) ? { id } : null,
    broadcast: (channel, payload) => {
      broadcasts.push({ channel, payload });
    },
    getIosSimulator: () => simulator,
    log: (msg) => logs.push(String(msg)),
    simulator,
    simulatorCalls,
    logs,
    runs,
    forks,
    stopped,
    retired,
    asked,
    broadcasts,
    inbounds,
  };
  return deps;
}

describe("preview MCP tool (issue #155)", () => {
  it("requires the same-project thread and forwards screenshot", async () => {
    const shots = [];
    const deps = makeDeps();
    deps.preview = {
      screenshot: async (input) => {
        shots.push(input);
        return {
          url: "http://localhost:5173/",
          title: "app",
          canGoBack: false,
          canGoForward: false,
          dataUrl: "data:image/png;base64,aaa",
        };
      },
    };
    const h = createToolHandlers(deps);
    const out = await h.preview({
      threadId: "t1",
      projectId: "p1",
      action: "screenshot",
    });
    assert.equal(out.dataUrl.startsWith("data:image/png"), true);
    assert.deepEqual(shots, [{ threadId: "t1" }]);

    await assert.rejects(
      h.preview({ threadId: "t3", projectId: "p1", action: "info" }),
      /not to/,
    );
  });

  it("rejects an unknown action", async () => {
    const h = createToolHandlers(makeDeps());
    await assert.rejects(
      h.preview({ threadId: "t1", projectId: "p1", action: "explode" }),
      /Unknown preview action/,
    );
  });
});

describe("orch-server tool handlers", () => {
  it("instructions tell the orchestrator it is woken when workers finish", () => {
    assert.match(INSTRUCTIONS, /woken on a new turn/);
    assert.match(INSTRUCTIONS, /do not sit idle waiting for the user/);
    assert.match(INSTRUCTIONS, /hypothesis_record/);
    assert.match(INSTRUCTIONS, /teach_review/);
    assert.match(INSTRUCTIONS, /TODO\(human\)/);
    assert.match(INSTRUCTIONS, /task_claim/);
    assert.match(INSTRUCTIONS, /peer_send/);
    assert.match(INSTRUCTIONS, /git show/);
    assert.match(INSTRUCTIONS, /Pass pool=<alias>/);
    assert.match(INSTRUCTIONS, /Do not pass a raw model id/);
    assert.match(INSTRUCTIONS, /thread_archive/);
    assert.match(INSTRUCTIONS, /thread_settle/);
    assert.match(INSTRUCTIONS, /thread_stop/);
    assert.match(INSTRUCTIONS, /thread_rename/);
    assert.match(INSTRUCTIONS, /fromThreadId/);
    assert.match(INSTRUCTIONS, /delivered \(started a turn\)/);
    assert.doesNotMatch(INSTRUCTIONS, /poll thread_status until/);
    assert.match(INSTRUCTIONS, /THIS project only/);
    assert.doesNotMatch(INSTRUCTIONS, /this server sees all of them/);
    assert.match(INSTRUCTIONS, /preview drives the Browser pane/);
    assert.match(INSTRUCTIONS, /Do not claim the UI works without a screenshot/);
  });

  it("threads_list maps id, title, provider, status, handoffFrom, project, later fields", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const list = await h.threads_list({ projectId: "p1" });
    assert.deepEqual(list, [
      {
        id: "t1",
        title: "First",
        provider: "claude",
        status: "idle",
        handoffFrom: null,
        projectId: "p1",
        projectName: "Alpha",
        archived: false,
        settledOverride: null,
        snoozedUntil: null,
      },
      {
        id: "t2",
        title: "Second",
        provider: "codex",
        status: "working",
        handoffFrom: "t1",
        projectId: "p1",
        projectName: "Alpha",
        archived: false,
        settledOverride: null,
        snoozedUntil: null,
      },
    ]);
  });

  it("threads_list requires projectId and never returns another project", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    await assert.rejects(() => h.threads_list(), /projectId is required/);
    await assert.rejects(() => h.threads_list({}), /projectId is required/);
    const p2 = await h.threads_list({ projectId: "p2" });
    assert.deepEqual(
      p2.map((t) => t.id),
      ["t3"],
    );
    const p1 = await h.threads_list({ projectId: "p1" });
    assert.ok(!p1.some((t) => t.id === "t3"));
  });

  it("bound projectId wins over a claimed foreign projectId (issue #671)", async () => {
    const deps = makeDeps();
    deps.boundProjectId = "p1";
    const h = createToolHandlers(deps);
    const list = await h.threads_list({ projectId: "p2" });
    assert.deepEqual(
      list.map((t) => t.id),
      ["t1", "t2"],
      "URL-bound p1 must not list p2 even when args claim p2",
    );
    await assert.rejects(
      () => h.thread_fork({ threadId: "t3", projectId: "p2", prompt: "x" }),
      /belongs to "Beta".*not to "Alpha"/s,
    );
    assert.equal(deps.forks.length, 0);
    await assert.rejects(
      () => h.thread_status({ threadId: "t3", projectId: "p2" }),
      /belongs to "Beta"/,
    );
  });

  it("threads_list surfaces archived, settledOverride, and snoozedUntil", async () => {
    const deps = makeDeps();
    Object.assign(deps.store.getThread("t1"), {
      archived: true,
      settledOverride: "settled",
      snoozedUntil: 1_800_000_000_000,
    });
    const h = createToolHandlers(deps);
    const row = (await h.threads_list({ projectId: "p1" })).find(
      (t) => t.id === "t1",
    );
    assert.equal(row.archived, true);
    assert.equal(row.settledOverride, "settled");
    assert.equal(row.snoozedUntil, 1_800_000_000_000);
  });

  it("thread_fork forks then starts a run on the new thread", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const out = await h.thread_fork({
      threadId: "t1",
      projectId: "p1",
      provider: "codex",
      prompt: "take over",
    });
    assert.deepEqual(out, { threadId: "fork-1" });
    assert.deepEqual(deps.forks, [{ threadId: "t1", provider: "codex" }]);
    assert.deepEqual(deps.runs, [{ threadId: "fork-1", prompt: "take over" }]);
  });

  it("thread_fork omits provider key when not given", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    await h.thread_fork({ threadId: "t1", projectId: "p1", prompt: "go" });
    assert.deepEqual(deps.forks, [{ threadId: "t1" }]);
  });

  it("thread_fork resolves a pool alias to provider and model", async () => {
    const deps = makeDeps();
    deps.store.getSettings = () => ({
      subagentPool: {
        defaultAlias: "fast",
        force: false,
        entries: [
          {
            alias: "fast",
            provider: "kimi",
            model: "kimi-for-coding-highspeed",
            description: "Fast and cheap. Good for small edits.",
          },
          {
            alias: "strong",
            provider: "claude",
            model: null,
            description: "Strong at hard problems.",
          },
        ],
      },
    });
    const h = createToolHandlers(deps);
    await h.thread_fork({
      threadId: "t1",
      projectId: "p1",
      pool: "strong",
      prompt: "go",
    });
    assert.deepEqual(deps.forks, [
      { threadId: "t1", provider: "claude", model: null },
    ]);
  });

  it("thread_fork rejects an unknown pool alias", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    await assert.rejects(
      () =>
        h.thread_fork({
          threadId: "t1",
          projectId: "p1",
          pool: "nope",
          prompt: "x",
        }),
      /Unknown pool alias: nope/,
    );
    assert.equal(deps.forks.length, 0);
  });

  it("thread_fork marks the new thread as an orchestration worker", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    await h.thread_fork({ threadId: "t1", projectId: "p1", prompt: "go" });
    const fork = deps.store.getThread("fork-1");
    assert.equal(fork.orchWorker, true);
  });

  it("thread_fork isolates the worker in its own worktree by default", async () => {
    // Real dir with a .git entry: the repo check is fs-based (issue #30).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-wt-"));
    fs.mkdirSync(path.join(dir, ".git"));
    const projects = { p1: { id: "p1", path: dir } };
    /** @param {object} project */
    const forkInto = async (project, args) => {
      const deps = makeDeps();
      projects.p1 = project;
      deps.store.getThread("t1").projectId = "p1";
      deps.store.getProject = (id) => projects[id] || null;
      const h = createToolHandlers(deps);
      await h.thread_fork({ threadId: "t1", projectId: "p1", prompt: "go", ...args });
      return deps.store.getThread("fork-1");
    };

    try {
      assert.equal((await forkInto(projects.p1, {})).pendingWorktree, true);
      // Opt-out, remote project and non-repo all share the project checkout.
      assert.equal(
        (await forkInto(projects.p1, { worktree: false })).pendingWorktree,
        undefined,
      );
      assert.equal(
        (await forkInto({ id: "p1", path: dir, remoteHost: "box" }, {}))
          .pendingWorktree,
        undefined,
      );
      assert.equal(
        (await forkInto({ id: "p1", path: path.join(dir, "not-a-repo") }, {}))
          .pendingWorktree,
        undefined,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("thread_send unarchives a re-dispatched archived worker", async () => {
    const deps = makeDeps();
    deps.store.threads.push({
      id: "w1",
      title: "Worker",
      provider: "claude",
      status: "done",
      handoffFrom: "t1",
      orchWorker: true,
      archived: true,
      projectId: "p1",
    });
    const h = createToolHandlers(deps);
    await h.thread_send({ threadId: "w1", projectId: "p1", prompt: "more work" });
    assert.equal(deps.store.getThread("w1").archived, false);
    // Non-worker archived threads are left alone.
    deps.store.threads.push({ id: "a1", archived: true, projectId: "p1" });
    await h.thread_send({ threadId: "a1", projectId: "p1", prompt: "x" });
    assert.equal(deps.store.getThread("a1").archived, true);
  });

  it("thread_fork rejects unknown thread and unknown provider", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    await assert.rejects(
      () => h.thread_fork({ threadId: "nope", projectId: "p1", prompt: "x" }),
      /Unknown thread: nope/,
    );
    await assert.rejects(
      () => h.thread_fork({ threadId: "t1", projectId: "p1", provider: "nope", prompt: "x" }),
      /Unknown provider: nope/,
    );
    assert.equal(deps.forks.length, 0);
    assert.equal(deps.runs.length, 0);
  });

  it("thread_send starts a run; rejects unknown thread", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const out = await h.thread_send({ threadId: "t1", projectId: "p1", prompt: "ping" });
    assert.equal(out.outcome, "delivered");
    assert.equal(out.threadId, "t1");
    assert.equal(deps.runs.length, 1);
    assert.equal(deps.runs[0].threadId, "t1");
    assert.equal(deps.runs[0].prompt, "ping");
    await assert.rejects(
      () => h.thread_send({ threadId: "ghost", projectId: "p1", prompt: "x" }),
      /Unknown thread: ghost/,
    );
  });

  it("thread_send queues on a running thread instead of starting (issue #551)", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const out = await h.thread_send({
      threadId: "t2",
      projectId: "p1",
      fromThreadId: "t1",
      prompt: "steer left",
    });
    assert.deepEqual(out, { outcome: "queued", threadId: "t2" });
    assert.equal(deps.runs.length, 0);
    assert.equal(deps.store.getThread("t2").queued.prompt, "steer left");
    assert.equal(deps.store.getThread("t2").queued.inbound, true);
    assert.deepEqual(deps.inbounds, [
      {
        threadId: "t2",
        text: "steer left",
        fromThread: { id: "t1", title: "First" },
      },
    ]);
  });

  it("thread_send queue-only holds on an idle thread without starting", async () => {
    const deps = makeDeps();
    deps.store.getThread("t1").crossThreadInbound = "queue-only";
    const h = createToolHandlers(deps);
    const out = await h.thread_send({
      threadId: "t1",
      projectId: "p1",
      fromThreadId: "t2",
      prompt: "later",
    });
    assert.equal(out.outcome, "queued");
    assert.equal(deps.runs.length, 0);
    assert.equal(deps.store.getThread("t1").queued.inbound, true);
  });

  it("thread_send refuses when the receiver's inbound policy is refuse", async () => {
    const deps = makeDeps();
    deps.store.getThread("t1").crossThreadInbound = "refuse";
    const h = createToolHandlers(deps);
    const out = await h.thread_send({
      threadId: "t1",
      projectId: "p1",
      fromThreadId: "t2",
      prompt: "hi",
    });
    assert.deepEqual(out, {
      outcome: "refused",
      threadId: "t1",
      reason: "inbound refuse",
    });
    assert.equal(deps.runs.length, 0);
  });

  it("thread_send reports archived non-workers as undeliverable", async () => {
    const deps = makeDeps();
    deps.store.threads.push({
      id: "a1",
      archived: true,
      projectId: "p1",
      title: "Old",
    });
    const h = createToolHandlers(deps);
    const out = await h.thread_send({
      threadId: "a1",
      projectId: "p1",
      fromThreadId: "t1",
      prompt: "x",
    });
    assert.equal(out.outcome, "undeliverable");
    assert.equal(out.reason, "archived");
    assert.equal(deps.runs.length, 0);
    assert.equal(deps.store.getThread("a1").archived, true);
  });

  it("thread_send attributes the delivered prompt to the sender", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const out = await h.thread_send({
      threadId: "t1",
      projectId: "p1",
      fromThreadId: "t2",
      prompt: "the schema landed",
    });
    assert.equal(out.outcome, "delivered");
    assert.equal(
      deps.runs[0].prompt,
      '[from thread t2 ("Second")]\nthe schema landed',
    );
    assert.equal(deps.runs[0].displayPrompt, "the schema landed");
    assert.deepEqual(deps.runs[0].fromThread, { id: "t2", title: "Second" });
  });

  it("thread_send does not deliver to or from an unattended thread", async () => {
    const deps = makeDeps();
    deps.store.getThread("t1").automationId = "auto-1";
    const h = createToolHandlers(deps);
    const asReceiver = await h.thread_send({
      threadId: "t1",
      projectId: "p1",
      fromThreadId: "t2",
      prompt: "x",
    });
    assert.equal(asReceiver.outcome, "undeliverable");
    deps.store.getThread("t1").automationId = null;
    deps.store.getThread("t2").automationId = "auto-1";
    const asSender = await h.thread_send({
      threadId: "t1",
      projectId: "p1",
      fromThreadId: "t2",
      prompt: "x",
    });
    assert.equal(asSender.reason, "unattended sender");
    assert.equal(deps.runs.length, 0);
  });

  it("thread_archive of another thread requires approved:true", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    await assert.rejects(
      () =>
        h.thread_archive({
          threadId: "t2",
          projectId: "p1",
          archived: true,
          fromThreadId: "t1",
        }),
      /user's decision/,
    );
    assert.equal(deps.store.getThread("t2").archived, undefined);
    const out = await h.thread_archive({
      threadId: "t2",
      projectId: "p1",
      archived: true,
      fromThreadId: "t1",
      approved: true,
    });
    assert.equal(out.archived, true);
  });

  it("thread_stop of another thread requires approved:true", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    await assert.rejects(
      () =>
        h.thread_stop({
          threadId: "t2",
          projectId: "p1",
          fromThreadId: "t1",
        }),
      /user's decision/,
    );
    assert.equal(deps.stopped.length, 0);
    await h.thread_stop({
      threadId: "t2",
      projectId: "p1",
      fromThreadId: "t1",
      approved: true,
    });
    assert.deepEqual(deps.stopped, [{ threadId: "t2" }]);
  });

  // Issue #109: an agent in one project forked a thread it picked off
  // threads_list by title, spawning workers on another project's repo.
  it("thread_fork and thread_send reject a thread in another project", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);

    // t3 lives in p2; a caller working in p1 must not reach it.
    await assert.rejects(
      () => h.thread_fork({ threadId: "t3", projectId: "p1", prompt: "x" }),
      /belongs to "Beta".*not to "Alpha"/s,
    );
    await assert.rejects(
      () => h.thread_send({ threadId: "t3", projectId: "p1", prompt: "x" }),
      /belongs to "Beta".*not to "Alpha"/s,
    );
    // Rejected before anything is forked or started.
    assert.equal(deps.forks.length, 0);
    assert.equal(deps.runs.length, 0);

    // Same project still works, including a sibling thread that is not the
    // caller's own: the guard blocks the boundary, not ordinary forking.
    await h.thread_fork({ threadId: "t2", projectId: "p1", prompt: "go" });
    assert.equal(deps.forks.length, 1);
    assert.equal(deps.runs.length, 1);
  });

  it("thread_archive archives via setArchived, retires the CLI, and broadcasts", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const out = await h.thread_archive({
      threadId: "t1",
      projectId: "p1",
      archived: true,
    });
    assert.deepEqual(out, { threadId: "t1", archived: true });
    assert.equal(deps.store.getThread("t1").archived, true);
    assert.deepEqual(deps.retired, ["t1"]);
    assert.equal(deps.broadcasts.length, 1);
    assert.equal(deps.broadcasts[0].channel, "threads:changed");
    assert.ok(Array.isArray(deps.broadcasts[0].payload));
    assert.equal(
      deps.broadcasts[0].payload.find((t) => t.id === "t1").archived,
      true,
    );
    // Fire-and-forget release is queued during setArchived; flush it.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(deps.simulatorCalls, [["releaseThread", "t1"]]);
  });

  it("thread_archive still mutates when broadcast is omitted", async () => {
    const deps = makeDeps();
    delete deps.broadcast;
    const h = createToolHandlers(deps);
    await h.thread_archive({
      threadId: "t1",
      projectId: "p1",
      archived: true,
    });
    assert.equal(deps.store.getThread("t1").archived, true);
    assert.deepEqual(deps.retired, ["t1"]);
  });

  it("thread_archive unarchives without retiring the CLI", async () => {
    const deps = makeDeps();
    deps.store.getThread("t1").archived = true;
    const h = createToolHandlers(deps);
    const out = await h.thread_archive({
      threadId: "t1",
      projectId: "p1",
      archived: false,
    });
    assert.deepEqual(out, { threadId: "t1", archived: false });
    assert.equal(deps.store.getThread("t1").archived, false);
    assert.deepEqual(deps.retired, []);
    assert.equal(deps.broadcasts.length, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(deps.simulatorCalls, []);
  });

  it("thread_archive keeps archived:true when release throws", async () => {
    const deps = makeDeps();
    deps.simulator.releaseThreadError = new Error("release blew up");
    const h = createToolHandlers(deps);
    const out = await h.thread_archive({
      threadId: "t1",
      projectId: "p1",
      archived: true,
    });
    assert.deepEqual(out, { threadId: "t1", archived: true });
    assert.equal(deps.store.getThread("t1").archived, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(deps.simulatorCalls, [["releaseThread", "t1"]]);
    assert.equal(deps.logs.length, 1);
    assert.match(deps.logs[0], /ios-simulator: releaseThread cleanup failed/);
    assert.equal(deps.logs[0].includes("release blew up"), false);
  });

  it("thread_archive of a working thread matches IPC (retire, no extra policy)", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const out = await h.thread_archive({
      threadId: "t2",
      projectId: "p1",
      archived: true,
    });
    assert.equal(out.archived, true);
    assert.equal(deps.store.getThread("t2").archived, true);
    assert.equal(deps.store.getThread("t2").status, "working");
    assert.deepEqual(deps.retired, ["t2"]);
    assert.equal(deps.stopped.length, 0);
  });

  it("thread_archive rejects unknown and other-project threads", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    await assert.rejects(
      () =>
        h.thread_archive({
          threadId: "ghost",
          projectId: "p1",
          archived: true,
        }),
      /Unknown thread: ghost/,
    );
    await assert.rejects(
      () =>
        h.thread_archive({
          threadId: "t3",
          projectId: "p1",
          archived: true,
        }),
      /belongs to "Beta".*not to "Alpha"/s,
    );
    assert.equal(deps.store.getThread("t3").archived, undefined);
    assert.equal(deps.retired.length, 0);
    assert.equal(deps.broadcasts.length, 0);
  });

  it("thread_settle settles via setSettled, retires, and broadcasts", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const out = await h.thread_settle({
      threadId: "t1",
      projectId: "p1",
      override: "settled",
    });
    assert.equal(out.threadId, "t1");
    assert.equal(out.settledOverride, "settled");
    assert.equal(deps.store.getThread("t1").settledOverride, "settled");
    assert.deepEqual(deps.retired, ["t1"]);
    assert.equal(deps.broadcasts[0].channel, "threads:changed");
  });

  it("thread_settle('active') does not retire; working threads are rejected", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const out = await h.thread_settle({
      threadId: "t1",
      projectId: "p1",
      override: "active",
    });
    assert.equal(out.settledOverride, "active");
    assert.deepEqual(deps.retired, []);
    const cleared = await h.thread_settle({
      threadId: "t1",
      projectId: "p1",
      override: null,
    });
    assert.equal(cleared.settledOverride, null);
    assert.equal(deps.store.getThread("t1").settledOverride, null);
    await assert.rejects(
      () =>
        h.thread_settle({
          threadId: "t2",
          projectId: "p1",
          override: "settled",
        }),
      /Cannot settle a thread while a run is active/,
    );
    assert.equal(deps.store.getThread("t2").settledOverride, undefined);
  });

  it("thread_settle rejects unknown and other-project threads", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    await assert.rejects(
      () =>
        h.thread_settle({
          threadId: "ghost",
          projectId: "p1",
          override: "settled",
        }),
      /Unknown thread: ghost/,
    );
    await assert.rejects(
      () =>
        h.thread_settle({
          threadId: "t3",
          projectId: "p1",
          override: "settled",
        }),
      /belongs to "Beta".*not to "Alpha"/s,
    );
    assert.equal(deps.broadcasts.length, 0);
  });

  it("thread_stop stops a run; rejects unknown and other-project threads", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const out = await h.thread_stop({ threadId: "t2", projectId: "p1" });
    assert.deepEqual(out, { threadId: "t2" });
    assert.deepEqual(deps.stopped, [{ threadId: "t2" }]);
    await assert.rejects(
      () => h.thread_stop({ threadId: "ghost", projectId: "p1" }),
      /Unknown thread: ghost/,
    );
    await assert.rejects(
      () => h.thread_stop({ threadId: "t3", projectId: "p1" }),
      /belongs to "Beta".*not to "Alpha"/s,
    );
    assert.equal(deps.stopped.length, 1);
  });

  it("thread_rename persists the title and broadcasts", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const out = await h.thread_rename({
      threadId: "t1",
      projectId: "p1",
      title: "  Ship checklist  ",
    });
    assert.deepEqual(out, { threadId: "t1", title: "Ship checklist" });
    assert.equal(deps.store.getThread("t1").title, "Ship checklist");
    assert.equal(deps.broadcasts[0].channel, "threads:changed");
  });

  it("thread_rename rejects empty, unknown, and other-project threads", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    await assert.rejects(
      () =>
        h.thread_rename({ threadId: "t1", projectId: "p1", title: "   " }),
      /Thread title cannot be empty/,
    );
    await assert.rejects(
      () =>
        h.thread_rename({ threadId: "ghost", projectId: "p1", title: "x" }),
      /Unknown thread: ghost/,
    );
    await assert.rejects(
      () =>
        h.thread_rename({ threadId: "t3", projectId: "p1", title: "x" }),
      /belongs to "Beta".*not to "Alpha"/s,
    );
    assert.equal(deps.store.getThread("t1").title, "First");
    assert.equal(deps.store.getThread("t3").title, "Broken");
    assert.equal(deps.broadcasts.length, 0);
  });

  it("thread_status returns first line of last assistant text", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    assert.deepEqual(await h.thread_status({ threadId: "t1" }), {
      status: "idle",
      title: "First",
      provider: "claude",
      lastAssistantText: "first line",
      lastError: null,
      awaitingInput: false,
      awaitingPermission: null,
    });
    // No assistant message: null.
    assert.deepEqual(await h.thread_status({ threadId: "t2" }), {
      status: "working",
      title: "Second",
      provider: "codex",
      lastAssistantText: null,
      lastError: null,
      awaitingInput: false,
      awaitingPermission: null,
    });
    await assert.rejects(
      () => h.thread_status({ threadId: "ghost" }),
      /Unknown thread: ghost/,
    );
  });

  it("thread_status surfaces the Run error event on failed threads", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    assert.deepEqual(await h.thread_status({ threadId: "t3" }), {
      status: "failed",
      title: "Broken",
      provider: "grok",
      lastAssistantText: "starting",
      lastError: "Run error: result subtype error_during_execution",
      awaitingInput: false,
      awaitingPermission: null,
    });
  });

  it("thread_status reports a worker blocked on a permission prompt", async () => {
    const deps = makeDeps();
    deps.runner.getPendingPermission = (id) =>
      id === "t2" ? { toolName: "Bash", summary: "Bash(rm -rf build)" } : null;
    deps.store.getThread("t2").awaitingInput = true;
    const h = createToolHandlers(deps);
    const status = await h.thread_status({ threadId: "t2" });
    assert.equal(status.awaitingInput, true);
    assert.equal(status.awaitingPermission, "Bash(rm -rf build)");

    // Flag left behind by a run that died mid-prompt must not read as blocked.
    deps.store.getThread("t3").awaitingInput = true;
    const dead = await h.thread_status({ threadId: "t3" });
    assert.equal(dead.awaitingInput, false);
    assert.equal(dead.awaitingPermission, null);
  });

  it("ask_user posts the question and returns without waiting (#647)", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const questions = [
      {
        question: "Merge or PR?",
        options: [{ label: "Merge" }, { label: "PR" }],
      },
    ];
    const out = await h.ask_user({
      threadId: "t1",
      projectId: "p1",
      questions,
    });
    assert.deepEqual(deps.asked, [{ threadId: "t1", questions }]);
    assert.equal(out.asked, true);
    // The whole contract: the agent must stop here rather than guess.
    assert.match(out.note, /End your turn/);
    assert.match(out.note, /next turn/);
  });

  it("ask_user rejects unknown and other-project threads (#647)", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const questions = [
      { question: "Which?", options: [{ label: "A" }, { label: "B" }] },
    ];
    await assert.rejects(
      () => h.ask_user({ threadId: "nope", projectId: "p1", questions }),
      /Unknown thread/,
    );
    // t3 lives in p2: an agent must not open a card on another project.
    await assert.rejects(
      () => h.ask_user({ threadId: "t3", projectId: "p1", questions }),
      /can only drive threads in its own project/,
    );
    assert.deepEqual(deps.asked, []);
  });

  it("instructions point every CLI at ask_user, not its own tool (#647)", () => {
    assert.match(INSTRUCTIONS, /ask_user/);
    assert.match(INSTRUCTIONS, /instead of your CLI's own question tool/);
    assert.match(INSTRUCTIONS, /does not block/);
  });
});

/**
 * POST a JSON-RPC message to /mcp and parse the SSE response payload.
 * @returns {Promise<{ status: number, body: unknown }>}
 */
async function mcpPost(
  port,
  token,
  message,
  { auth = "bearer", query = "" } = {},
) {
  const qs = query ? (query.startsWith("?") ? query : `?${query}`) : "";
  const url =
    auth === "query"
      ? `http://127.0.0.1:${port}/mcp?token=${token}${qs ? `&${qs.slice(1)}` : ""}`
      : `http://127.0.0.1:${port}/mcp${qs}`;
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (auth === "bearer") headers.authorization = `Bearer ${token}`;
  if (auth === "wrong") headers.authorization = "Bearer wrong-token";
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
  const text = await res.text();
  let body = null;
  const dataLine = text
    .split("\n")
    .find((l) => l.startsWith("data:"));
  if (dataLine) {
    body = JSON.parse(dataLine.slice("data:".length).trim());
  } else if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

describe("orch-server HTTP", () => {
  let tmpDir;
  let logs;
  let prevEnv;
  /** @type {Array<ReturnType<typeof createOrchServer>>} */
  let servers;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-orch-"));
    logs = [];
    servers = [];
    prevEnv = {
      CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_GROK_BIN: process.env.CODER_GROK_BIN,
      CODER_GROK_CONFIG_PATH: process.env.CODER_GROK_CONFIG_PATH,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
    };
    // Keep provider side effects inside the test dir / turned off.
    process.env.CODER_KIMI_MCP_PATH = path.join(tmpDir, "kimi-mcp.json");
    process.env.CODER_KIMI_BIN = path.join(tmpDir, "no-kimi");
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = path.join(tmpDir, "no-grok-not-a-real-binary");
    // A fake grok still triggers the post-add chmod; keep it off the real file.
    process.env.CODER_GROK_CONFIG_PATH = path.join(tmpDir, "grok-config.toml");
    resetMemorySupForTests();
  });

  afterEach(() => {
    for (const s of servers) {
      try {
        s.stop();
      } catch {
        // ignore
      }
    }
    resetMemorySupForTests();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startOrch(overrides = {}) {
    const deps = makeDeps();
    const orch = createOrchServer({
      store: deps.store,
      runner: deps.runner,
      userDataPath: tmpDir,
      appPath: APP_PATH,
      log: (m) => logs.push(m),
      forkThread: deps.forkThread,
      getProvider: deps.getProvider,
      broadcast: deps.broadcast,
      ...overrides,
    });
    servers.push(orch);
    await orch.start();
    return { orch, deps };
  }

  it("persists orch-server.json and serves /health without auth", async () => {
    const { orch } = await startOrch();
    const st = orch.getStatus();
    assert.equal(st.running, true);
    assert.ok(st.port > 0);

    const cfgPath = path.join(tmpDir, "orch-server.json");
    assert.ok(fs.existsSync(cfgPath));
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.equal(cfg.port, st.port);
    assert.ok(cfg.token.length >= 16);

    const health = await fetch(`http://127.0.0.1:${st.port}/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
  });

  it("keeps the port but mints a fresh token every start", async () => {
    const cfgPath = path.join(tmpDir, "orch-server.json");
    const { orch } = await startOrch();
    const first = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    orch.stop();

    // A token that leaked into a user-global CLI config must be dead by the
    // next launch, even if cleanup never ran (issue #125).
    const { orch: again } = await startOrch();
    const second = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.equal(second.port, first.port, "port is stable across launches");
    assert.notEqual(second.token, first.token);
    assert.equal((fs.statSync(cfgPath).mode & 0o777).toString(8), "600");

    const stale = await fetch(`http://127.0.0.1:${again.getStatus().port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${first.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(stale.status, 401);
  });

  it("rejects /mcp without a token or with a wrong token", async () => {
    const { orch } = await startOrch();
    const st = orch.getStatus();
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    };
    assert.equal((await mcpPost(st.port, "", init, { auth: "none" })).status, 401);
    assert.equal(
      (await mcpPost(st.port, "", init, { auth: "wrong" })).status,
      401,
    );
  });

  it("serves initialize and tools/list with bearer or query token", async () => {
    const { orch } = await startOrch();
    const st = orch.getStatus();
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "orch-server.json"), "utf8"),
    );

    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    };
    const viaBearer = await mcpPost(st.port, cfg.token, init);
    assert.equal(viaBearer.status, 200);
    assert.equal(viaBearer.body.result.serverInfo.name, "coder-threads");

    const viaQuery = await mcpPost(st.port, cfg.token, init, {
      auth: "query",
    });
    assert.equal(viaQuery.status, 200);

    const list = await mcpPost(st.port, cfg.token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    assert.equal(list.status, 200);
    const names = list.body.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "ask_user",
      "hypothesis_record",
      "peer_send",
      "preview",
      "spec_submit",
      "task_add",
      "task_claim",
      "task_complete",
      "task_list",
      "task_release",
      "teach_review",
      "thread_archive",
      "thread_fork",
      "thread_merge",
      "thread_pr",
      "thread_rename",
      "thread_send",
      "thread_settle",
      "thread_status",
      "thread_stop",
      "threads_list",
      "work_suggest",
    ]);
  });

  it("tools/call threads_list runs the handler over HTTP", async () => {
    const { orch } = await startOrch();
    const st = orch.getStatus();
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "orch-server.json"), "utf8"),
    );
    const res = await mcpPost(st.port, cfg.token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "threads_list", arguments: { projectId: "p1" } },
    });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body.result.content[0].text);
    assert.equal(payload.length, 2);
    assert.equal(payload[0].id, "t1");
    assert.equal(payload[0].archived, false);
    assert.ok(!payload.some((t) => t.id === "t3"));
  });

  it("tools/call threads_list bound via ?projectId= ignores a claimed foreign project", async () => {
    const { orch } = await startOrch();
    const st = orch.getStatus();
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "orch-server.json"), "utf8"),
    );
    const res = await mcpPost(
      st.port,
      cfg.token,
      {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "threads_list", arguments: { projectId: "p2" } },
      },
      { query: "projectId=p1" },
    );
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body.result.content[0].text);
    assert.deepEqual(
      payload.map((t) => t.id),
      ["t1", "t2"],
    );

    const fork = await mcpPost(
      st.port,
      cfg.token,
      {
        jsonrpc: "2.0",
        id: 32,
        method: "tools/call",
        params: {
          name: "thread_fork",
          arguments: { threadId: "t3", projectId: "p2", prompt: "x" },
        },
      },
      { query: "projectId=p1" },
    );
    assert.equal(fork.status, 200);
    assert.equal(fork.body.result.isError, true);
    assert.match(JSON.stringify(fork.body.result), /belongs to/);
  });

  it("tools/call thread_archive archives over HTTP", async () => {
    const { orch, deps } = await startOrch();
    const st = orch.getStatus();
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "orch-server.json"), "utf8"),
    );
    const res = await mcpPost(st.port, cfg.token, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "thread_archive",
        arguments: { threadId: "t1", projectId: "p1", archived: true },
      },
    });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body.result.content[0].text);
    assert.deepEqual(payload, { threadId: "t1", archived: true });
    assert.equal(deps.store.getThread("t1").archived, true);
    assert.deepEqual(deps.retired, ["t1"]);
  });

  it("fails soft on a corrupt config: logs once, stays down", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "orch-server.json"),
      "{ not json !!!",
      "utf8",
    );
    const { orch } = await startOrch();
    assert.equal(orch.getStatus().running, false);
    assert.ok(logs.some((m) => /orch-server: invalid config/.test(String(m))));
  });

  it("fails soft when the persisted port cannot bind", async () => {
    // Occupy a port, persist a config pointing at it, then start.
    const port = await freePort();
    const blocker = http.createServer();
    await new Promise((r) => blocker.listen(port, "127.0.0.1", r));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "orch-server.json"),
        JSON.stringify({ port, token: "t".repeat(32) }),
        "utf8",
      );
      const { orch } = await startOrch();
      assert.equal(orch.getStatus().running, false);
      assert.ok(
        logs.some((m) => /orch-server: cannot bind/.test(String(m))),
        `expected bind-failure log, got: ${JSON.stringify(logs)}`,
      );
      // No server registered: no claude/codex args from the orch side.
      assert.equal(getClaudeMcpArgs().length, 0);
      assert.equal(getCodexMcpArgs().length, 0);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });
});

describe("orch-server provider injection", () => {
  let tmpDir;
  let logs;
  let prevEnv;
  let servers;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-orch-inj-"));
    logs = [];
    servers = [];
    prevEnv = {
      CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_GROK_BIN: process.env.CODER_GROK_BIN,
      CODER_GROK_CONFIG_PATH: process.env.CODER_GROK_CONFIG_PATH,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
    };
    process.env.CODER_KIMI_MCP_PATH = path.join(tmpDir, "kimi-mcp.json");
    process.env.CODER_KIMI_BIN = path.join(tmpDir, "no-kimi");
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = path.join(tmpDir, "no-grok-not-a-real-binary");
    // A fake grok still triggers the post-add chmod; keep it off the real file.
    process.env.CODER_GROK_CONFIG_PATH = path.join(tmpDir, "grok-config.toml");
    resetMemorySupForTests();
  });

  afterEach(() => {
    for (const s of servers) {
      try {
        s.stop();
      } catch {
        // ignore
      }
    }
    resetMemorySupForTests();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Adopt a fake memory server so coder-memory is healthy too. */
  async function adoptMemory(port, token) {
    fs.writeFileSync(
      path.join(tmpDir, "memory-server.json"),
      JSON.stringify({ port, token, dbPath: path.join(tmpDir, "db") }),
      "utf8",
    );
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/health") {
        const body = { ok: true };
        const nonce = url.searchParams.get("nonce");
        if (nonce) {
          body.proof = crypto
            .createHmac("sha256", token)
            .update(nonce)
            .digest("hex");
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    const sup = createMemorySupervisor({
      userDataPath: tmpDir,
      appPath: tmpDir,
      log: (m) => logs.push(m),
    });
    await sup.start();
    return { sup, server };
  }

  async function startOrch(env) {
    const deps = makeDeps();
    const orch = createOrchServer({
      store: deps.store,
      runner: deps.runner,
      userDataPath: tmpDir,
      appPath: APP_PATH,
      log: (m) => logs.push(m),
      env,
      forkThread: deps.forkThread,
      getProvider: deps.getProvider,
    });
    servers.push(orch);
    await orch.start();
    return orch;
  }

  it("claude config and args list both servers; stop drops coder-threads", async () => {
    const memPort = await freePort();
    const memToken = "mem-tok";
    const { sup, server } = await adoptMemory(memPort, memToken);
    try {
      const orch = await startOrch();
      const orchPort = orch.getStatus().port;
      const orchToken = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "orch-server.json"), "utf8"),
      ).token;

      const args = getClaudeMcpArgs();
      assert.equal(args.length, 2);
      assert.equal(
        args[1],
        "--allowedTools=mcp__coder-memory__* mcp__coder-threads__*",
      );
      const mcpPath = args[0].slice("--mcp-config=".length);
      const doc = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      assert.equal(
        doc.mcpServers["coder-memory"].url,
        `http://127.0.0.1:${memPort}/mcp`,
      );
      assert.deepEqual(doc.mcpServers["coder-threads"], {
        type: "http",
        url: `http://127.0.0.1:${orchPort}/mcp`,
        headers: { Authorization: `Bearer ${orchToken}` },
      });

      orch.stop();
      const after = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      assert.ok(after.mcpServers["coder-memory"]);
      assert.equal(after.mcpServers["coder-threads"], undefined);
      assert.equal(
        getClaudeMcpArgs()[1],
        "--allowedTools=mcp__coder-memory__*",
      );
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });

  it("codex args carry one -c pair per server", async () => {
    const memPort = await freePort();
    const memToken = "mem-tok";
    const { sup, server } = await adoptMemory(memPort, memToken);
    try {
      const orch = await startOrch();
      const orchPort = orch.getStatus().port;
      const orchToken = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "orch-server.json"), "utf8"),
      ).token;
      // URLs in argv, tokens in env: `ps` shows argv to every local user and
      // the coder-threads token drives arbitrary agent runs (issue #125).
      assert.deepEqual(getCodexMcpArgs(), [
        "-c",
        `mcp_servers.coder-memory.url="http://127.0.0.1:${memPort}/mcp"`,
        "-c",
        'mcp_servers.coder-memory.bearer_token_env_var="CODER_MCP_TOKEN_CODER_MEMORY"',
        "-c",
        `mcp_servers.coder-threads.url="http://127.0.0.1:${orchPort}/mcp"`,
        "-c",
        'mcp_servers.coder-threads.bearer_token_env_var="CODER_MCP_TOKEN_CODER_THREADS"',
      ]);
      assert.deepEqual(getCodexMcpEnv(), {
        CODER_MCP_TOKEN_CODER_MEMORY: memToken,
        CODER_MCP_TOKEN_CODER_THREADS: orchToken,
      });
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });

  it("kimi mcp.json merge gains coder-threads alongside coder-memory", async () => {
    const memPort = await freePort();
    const { sup, server } = await adoptMemory(memPort, "mem-tok");
    try {
      const orch = await startOrch();
      const orchPort = orch.getStatus().port;
      const orchToken = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "orch-server.json"), "utf8"),
      ).token;
      const ok = ensureKimiMcpConfig({
        log: (m) => logs.push(m),
        isKimiAvailable: () => true,
      });
      assert.equal(ok, true);
      const doc = JSON.parse(
        fs.readFileSync(process.env.CODER_KIMI_MCP_PATH, "utf8"),
      );
      assert.equal(
        doc.mcpServers["coder-memory"].url,
        `http://127.0.0.1:${memPort}/mcp`,
      );
      assert.equal(
        doc.mcpServers["coder-threads"].url,
        `http://127.0.0.1:${orchPort}/mcp`,
      );
      assert.equal(
        doc.mcpServers["coder-threads"].headers.Authorization,
        `Bearer ${orchToken}`,
      );
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });

  it("grok mcp add runs once per server", async () => {
    const argvFile = path.join(tmpDir, "grok-argv.jsonl");
    const fakeGrok = writeFakeBin(
      path.join(tmpDir, "fake-grok"),
      `#!/usr/bin/env node
"use strict";
const fs = require("fs");
fs.appendFileSync(
  ${JSON.stringify(argvFile)},
  JSON.stringify(process.argv.slice(2)) + "\\n",
  "utf8",
);
process.exit(0);
`,
    );

    const memPort = await freePort();
    const { sup, server } = await adoptMemory(memPort, "mem-tok");
    try {
      const env = { ...process.env, CODER_GROK_BIN: fakeGrok };
      delete env.CODER_GROK_MCP_DISABLE;
      const orch = await startOrch(env);
      assert.equal(orch.getStatus().running, true);

      await waitFor(() => {
        if (!fs.existsSync(argvFile)) return false;
        const lines = fs
          .readFileSync(argvFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean);
        return lines.length >= 2;
      });
      const adds = fs
        .readFileSync(argvFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      for (const args of adds) {
        assert.deepEqual(args.slice(0, 4), [
          "mcp",
          "add",
          "--transport",
          "http",
        ]);
      }
      const names = adds.map((a) => a[4]).sort();
      assert.deepEqual(names, ["coder-memory", "coder-threads"]);
      const threadsAdd = adds.find((a) => a[4] === "coder-threads");
      assert.ok(
        threadsAdd[5].startsWith(
          `http://127.0.0.1:${orch.getStatus().port}/mcp`,
        ),
      );
      assert.ok(threadsAdd.includes("--scope"));
      assert.ok(threadsAdd.includes("user"));
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });

  // The self-id note is the only channel by which an agent learns its own
  // thread/project id — without it, calling the guarded tools is a guess.
  it("selfIdNoteFor states the ids, and only while coder-threads is up", () => {
    const services = require("../services.js");
    const thread = { id: "t1", projectId: "p1" };
    const project = { name: "Alpha" };

    // Server down: nothing to pass ids to, so no note.
    assert.equal(services.selfIdNoteFor(thread, project, "/tmp/alpha"), "");

    assert.equal(
      registerMcpServer({
        name: "coder-threads",
        port: 1234,
        token: "tok",
        userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), "orch-note-")),
      }),
      true,
    );
    try {
      const note = services.selfIdNoteFor(thread, project, "/tmp/alpha");
      assert.match(note, /thread t1/);
      assert.match(note, /projectId p1/);
      assert.match(note, /"Alpha"/);
      assert.match(note, /\/tmp\/alpha/);
      // A thread with no project cannot state ids at all.
      assert.equal(services.selfIdNoteFor({ id: "t1" }, project, null), "");
    } finally {
      unregisterMcpServer("coder-threads");
    }
    assert.equal(services.selfIdNoteFor(thread, project, "/tmp/alpha"), "");
  });

  it("register/unregister validate input and keep memory-only output stable", () => {
    assert.equal(registerMcpServer({ name: "", port: 1, token: "x" }), false);
    assert.equal(
      registerMcpServer({ name: "coder-memory", port: 1, token: "x" }),
      false,
    );
    assert.equal(
      registerMcpServer({ name: "coder-threads", port: 0, token: "x" }),
      false,
    );
    assert.equal(
      registerMcpServer({ name: "coder-threads", port: 1234, token: "" }),
      false,
    );
    assert.equal(unregisterMcpServer("coder-threads"), false);
    // Nothing healthy, nothing registered: no args.
    assert.equal(getClaudeMcpArgs().length, 0);
    assert.equal(getCodexMcpArgs().length, 0);
  });
});
