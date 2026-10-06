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
