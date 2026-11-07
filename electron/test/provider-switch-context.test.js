"use strict";

/**
 * Issue #1493: a provider switch (manual or quota failover) drops the old
 * CLI's session, so the next run must replay the thread's own tail instead
 * of starting with no history.
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
const { getProvider } = require("../providers.js");
const { createRunner } = require("../runner.js");
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

/**
 * Generic agent (CODER_AGENT_CMD gets the prompt as its last argv): logs each
 * prompt as a JSON line, fails the first call with `firstError` when given.
 * Hex + eval because parseAgentCommand splits on spaces.
 */
function agentCmd(logFile, firstError) {
  const src = `
const fs = require("fs");
const log = ${JSON.stringify(logFile)};
const first = !fs.existsSync(log);
fs.appendFileSync(log, JSON.stringify(process.argv[process.argv.length - 1]) + "\\n");
if (first && ${JSON.stringify(firstError || "")}) {
  process.stderr.write(${JSON.stringify(firstError || "")});
  process.exit(1);
}
process.stdout.write("ok");
`;
  const hex = Buffer.from(src, "utf8").toString("hex");
  return `${process.execPath} -e eval(Buffer.from('${hex}','hex').toString())`;
}

// Only complete lines: the fake agent may still be appending the last one, and
// waitFor polls this under load, so a half-written tail must not throw.
function readPrompts(logFile) {
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .slice(0, -1)
    .map((l) => JSON.parse(l));
}

describe("provider switch keeps context (#1493)", () => {
  let tmpDir;
  let store;
  let runner;
  let project;
  let logFile;
  let prevSimulate;
  let prevAgentCmd;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-switch-ctx-"));
    logFile = path.join(tmpDir, "prompts.jsonl");
    store = new Store(path.join(tmpDir, "store.json"));
    runner = createRunner({
      store,
      core: await loadCore(),
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
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
  });

  /** A claude thread mid-task: one finished turn and a live session. */
  function threadWithHistory() {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Mid-task",
    });
    store.setMessages(thread.id, [
      { id: "u1", role: "user", text: "refactor the parser", createdAt: 1 },
      { id: "a1", role: "assistant", text: "PARSER HALF DONE", createdAt: 2 },
    ]);
    store.updateThread(thread.id, { sessionId: "sess-claude" });
    store.saveNow();
    return store.getThread(thread.id);
  }

  it("fresh context retains visible history and identity across reload without old handoff", async () => {
    const thread = threadWithHistory();
    store.updateThread(thread.id, { handoffFrom: "old-source", replayContext: true,
      forkSessionAt: "old-cut", interruptedAt: Date.now(), quotaFailoverPending: true,
      recap: { text: "OLD RECAP", at: 1 } });
    store.setUsage(thread.id, { model: "old", inputTokens: 100, outputTokens: 20,
      costUsd: 3, turns: 2, contextTokens: 9000, contextWindow: 10000, contextCompaction: {} });
    const before = store.getMessages(thread.id).slice();
    runner.freshAgentContext({ threadId: thread.id });
    const fresh = store.getThread(thread.id);
    assert.equal(fresh.sessionId, null);
    for (const field of ["projectId", "provider", "providerInstance", "model", "permissionMode", "reasoningEffort", "worktreePath", "branch", "settledOverride"]) {
      assert.deepEqual(fresh[field], thread[field], `${field} is preserved`);
    }
    assert.equal(fresh.forkSessionAt, null);
    assert.equal(fresh.replayContext, false);
    assert.equal(fresh.interruptedAt, null);
    assert.equal(fresh.quotaFailoverPending, false);
    assert.equal(fresh.handoffFrom, "old-source", "orchestration provenance survives");
    assert.deepEqual(store.getMessages(thread.id).slice(0, before.length), before);
    assert.deepEqual(store.getContextMessages(thread.id), []);
    assert.deepEqual(store.getUsage(thread.id), { model: null, inputTokens: 100, outputTokens: 20, costUsd: 3, turns: 2 });
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    assert.equal(reloaded.getThread(thread.id).contextBoundaryId, fresh.contextBoundaryId);
    assert.equal(reloaded.getMessages(thread.id).at(-1).sessionBoundary, true);
    assert.deepEqual(reloaded.getContextMessages(thread.id), []);
    await assert.rejects(runner.startRun({ threadId: thread.id, prompt: "old automatic continuation", fromNotice: true }), /waiting for a user/);
    process.env.CODER_AGENT_CMD = agentCmd(logFile);
    await runner.startRun({ threadId: thread.id, prompt: "new task" });
    await waitFor(() => !runner.isRunning(thread.id));
    assert.doesNotMatch(readPrompts(logFile)[0], /PARSER HALF DONE|refactor the parser|OLD RECAP|Hand-off context/);
    assert.equal(store.getThread(thread.id).freshContextPending, false);
    services.setProvider(store, { threadId: thread.id, provider: "grok" });
    store.updateThread(thread.id, { replayContext: true });
    const prefix = services.buildHandoffPrefix(store.getThread(thread.id), id => store.getMessages(id), id => store.getThread(id));
    assert.match(prefix, /new task/);
    assert.doesNotMatch(prefix, /PARSER HALF DONE|refactor the parser|OLD RECAP/);
    const fork = services.forkThread(store, { threadId: thread.id, messageId: store.getContextMessages(thread.id).find(m => m.role === "assistant").id });
    assert.doesNotMatch(JSON.stringify(store.getMessages(fork.id)), /PARSER HALF DONE|refactor the parser/);
    const earlierFork = services.forkThread(store, { threadId: thread.id, messageId: "a1" });
    assert.match(JSON.stringify(store.getMessages(earlierFork.id)), /PARSER HALF DONE/);
    assert.equal(earlierFork.sessionId, null, "an explicit older cut cannot resume the new session");
  });

  it("explicit rewind can select earlier context and undo restores the fresh boundary", async () => {
    const thread = threadWithHistory();
    runner.freshAgentContext({ threadId: thread.id });
    const boundary = store.getThread(thread.id).contextBoundaryId;
    store.appendMessage(thread.id, { id: "new-user", role: "user", text: "NEW REQUEST", createdAt: Date.now() });
    await services.rewindThread(store, { threadId: thread.id, messageId: "new-user", prompt: "edited" });
    assert.equal(store.getThread(thread.id).contextBoundaryId, boundary);
    assert.doesNotMatch(services.buildHandoffPrefix(store.getThread(thread.id), id => store.getMessages(id)), /PARSER HALF DONE/);
    await services.rewindThread(store, { threadId: thread.id, undo: true });
    await services.rewindThread(store, { threadId: thread.id, messageId: "u1", prompt: "older edit" });
    assert.equal(store.getThread(thread.id).contextBoundaryId, null);
    assert.equal(store.getThread(thread.id).freshContextPending, false);
    assert.equal(store.getThread(thread.id).sessionId, null);
    await services.rewindThread(store, { threadId: thread.id, undo: true });
    assert.equal(store.getThread(thread.id).contextBoundaryId, boundary);
    assert.equal(store.getThread(thread.id).freshContextPending, true);
    assert.deepEqual(store.getContextMessages(thread.id).map(m => m.id), ["new-user"]);
    store.saveNow();
    assert.equal(new Store(path.join(tmpDir, "store.json")).getThread(thread.id).contextBoundaryId, boundary);
  });

  it("Ask retrieval keeps project memory but excludes earlier transcript from the prompt", async () => {
    const thread = threadWithHistory();
    store.updateThread(thread.id, { ask: true });
    runner.stopAll();
    let outbound;
    runner = createRunner({ store, core: await loadCore(), pushFn() {},
      askComplete: async ({ prompt }) => { outbound = prompt; return { text: "fresh answer", source: "print" }; },
      searchMemory: async () => [{ title: "Project rule", body: "PROJECT MEMORY RETAINED", type: "convention" }],
    });
    runner.freshAgentContext({ threadId: thread.id });
    await runner.startRun({ threadId: thread.id, prompt: "new question" });
    await waitFor(() => !runner.isRunning(thread.id));
    assert.match(outbound, /new question/);
    assert.match(outbound, /PROJECT MEMORY RETAINED/);
    assert.doesNotMatch(outbound, /PARSER HALF DONE|refactor the parser/);
    assert.equal(store.getThread(thread.id).freshContextPending, false);
  });

  it("disposed warm Claude callbacks cannot reattach session identity or usage", () => {
    const { createClaudeSessions } = require("../runner-claude-sessions.js");
    const thread = threadWithHistory();
    const sessions = createClaudeSessions({ active: new Map(), store, finishRunningSubagents() {} });
    let killed = false;
    const session = { idleTimer: null, handle: { kill() { killed = true; } }, dispatch: {
      onEvent() { store.updateThread(thread.id, { sessionId: "stale-session" }); },
      onExit() { store.setUsage(thread.id, { contextTokens: 999 }); },
      onError() { throw new Error("stale callback"); },
    } };
    sessions.claudeSessions.set(thread.id, session);
    const lateEvent = () => session.dispatch.onEvent({});
    sessions.disposeClaudeSession(thread.id);
    store.updateThread(thread.id, { sessionId: null });
    lateEvent();
    session.dispatch.onExit({});
    session.dispatch.onError(new Error("old process"));
    assert.equal(killed, true);
    assert.equal(store.getThread(thread.id).sessionId, null);
    assert.equal(store.getUsage(thread.id), null);
  });

  it("fresh context refuses pending questions and queued work without mutating history", () => {
    const thread = threadWithHistory();
    for (const patch of [{ pendingQuestion: { id: "question" } }, { queued: { prompt: "later" } }, { status: "working" }]) {
      store.updateThread(thread.id, patch);
      assert.throws(() => runner.freshAgentContext({ threadId: thread.id }), /Finish or stop/);
      assert.equal(store.getThread(thread.id).sessionId, "sess-claude");
      assert.equal(store.getMessages(thread.id).length, 2);
      store.updateThread(thread.id, { pendingQuestion: null, queued: null, status: "idle" });
    }
  });

  it("manual switch: next run's prompt carries the thread's own tail", async () => {
    const thread = threadWithHistory();
    const switched = services.setProvider(store, {
      threadId: thread.id,
      provider: "codex",
    });
    assert.equal(switched.sessionId, null);
    assert.equal(store.getThread(thread.id).replayContext, true);

    process.env.CODER_AGENT_CMD = agentCmd(logFile);
    await runner.startRun({ threadId: thread.id, prompt: "keep going" });
    await waitFor(() => !runner.isRunning(thread.id));

    const [prompt] = readPrompts(logFile);
    assert.ok(prompt.startsWith("[Hand-off context:"), prompt.slice(0, 80));
    assert.ok(prompt.includes("PARSER HALF DONE"));
    assert.ok(prompt.includes("[End context]\n\nkeep going"));
    // One-shot: cleared once the run starts.
    assert.ok(!store.getThread(thread.id).replayContext);
    const users = store.getMessages(thread.id).filter((m) => m.role === "user");
    assert.equal(users[users.length - 1].text, "keep going");
  });

  it("quota failover: the resumed run on the new provider carries the tail", async () => {
    const thread = threadWithHistory();
    services.setSettings(store, { quotaFailover: ["grok"] });
    process.env.CODER_AGENT_CMD = agentCmd(
      logFile,
      "account quota or balance is exhausted. Please top up.",
    );
    await runner.startRun({ threadId: thread.id, prompt: "keep going" });
    await waitFor(
      () =>
        fs.existsSync(logFile) &&
        readPrompts(logFile).length >= 2 &&
        !runner.isRunning(thread.id),
    );

    const [before, after] = readPrompts(logFile);
    // The original session was live, so the first attempt needed no prefix.
    assert.ok(before.startsWith("keep going"), before.slice(0, 80));
    assert.equal(store.getThread(thread.id).provider, "grok");
    assert.ok(after.startsWith("[Hand-off context:"), after.slice(0, 80));
    assert.ok(after.includes("PARSER HALF DONE"));
    assert.ok(after.includes("[End context]\n\nkeep going"));
    assert.ok(!store.getThread(thread.id).replayContext);
  });

  it("brand-new thread: switch sets no replay and the run has no prefix", async () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Fresh",
    });
    services.setProvider(store, { threadId: thread.id, provider: "codex" });
    assert.ok(!store.getThread(thread.id).replayContext);

    process.env.CODER_AGENT_CMD = agentCmd(logFile);
    await runner.startRun({ threadId: thread.id, prompt: "hello" });
    await waitFor(() => !runner.isRunning(thread.id));
    const prompts = readPrompts(logFile);
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].startsWith("hello"), prompts[0].slice(0, 80));
  });

  it("model switch on a session-pinning provider replays too", () => {
    const codex = getProvider("codex");
    const prev = codex.sessionPinsModel;
    codex.sessionPinsModel = true;
    try {
      const thread = threadWithHistory();
      services.setProvider(store, { threadId: thread.id, provider: "codex" });
      store.updateThread(thread.id, {
        sessionId: "sess-codex",
        replayContext: false,
      });
      const other = codex.models.find(
        (m) => (typeof m === "string" ? m : m.id) !== store.getThread(thread.id).model,
      );
      services.setProvider(store, {
        threadId: thread.id,
        model: typeof other === "string" ? other : other.id,
      });
      const t = store.getThread(thread.id);
      assert.equal(t.sessionId, null);
      assert.equal(t.replayContext, true);
      assert.match(
        services.buildHandoffPrefix(t, (id) => store.getMessages(id)),
        /PARSER HALF DONE/,
      );
    } finally {
      codex.sessionPinsModel = prev;
    }
  });

  it("moving a session-bearing thread to a new worktree replays too", () => {
    const thread = threadWithHistory();
    store.updateThread(thread.id, { worktreePath: path.join(tmpDir, "wt") });
    const t = store.getThread(thread.id);
    assert.equal(t.sessionId, null);
    assert.equal(t.replayContext, true);
  });
});
