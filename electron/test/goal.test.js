/**
 * Issue #1531: `/goal` — the stored thread goal, the native-goal fold-back,
 * and the standing note appended to non-native providers' prompts.
 *
 * Run: node --test electron/test/goal.test.js
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
const { rmTree } = require("./support/rmTree.js");

async function seed(tmpDir) {
  const store = new Store(path.join(tmpDir, "store.json"));
  const repo = path.join(tmpDir, "app");
  fs.mkdirSync(repo);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  const project = await services.addProject(store, repo);
  const thread = services.createThread(store, {
    projectId: project.id,
    title: "New Thread",
  });
  return { store, thread };
}

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe("setGoal", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-goal-"));
  });
  afterEach(async () => {
    await rmTree(tmpDir);
  });

  it("sets an active goal, persists it, and clears it to null", async () => {
    const { store, thread } = await seed(tmpDir);
    const before = store.getThread(thread.id).updatedAt;
    const set = services.setGoal(store, { threadId: thread.id, goal: "  ship v2  " });
    assert.equal(set.goal.objective, "ship v2");
    assert.equal(set.goal.status, "active");
    assert.equal(store.getThread(thread.id).updatedAt, before, "never bumps updatedAt");

    store.saveNow();
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    assert.equal(reloaded.getThread(thread.id).goal.objective, "ship v2");

    const cleared = services.setGoal(store, { threadId: thread.id, goal: null });
    assert.equal(cleared.goal, null);
    assert.equal(services.setGoal(store, { threadId: thread.id, goal: "" }).goal, null);
  });

  it("re-setting a finished goal restarts it; an active one is a no-op", async () => {
    const { store, thread } = await seed(tmpDir);
    const first = services.setGoal(store, { threadId: thread.id, goal: "ship" });
    assert.equal(
      services.setGoal(store, { threadId: thread.id, goal: "ship" }).goal.setAt,
      first.goal.setAt,
    );
    store.updateThread(thread.id, { goal: { ...first.goal, status: "complete" } });
    assert.equal(
      services.setGoal(store, { threadId: thread.id, goal: "ship" }).goal.status,
      "active",
    );
  });

  it("rejects an unknown thread", () => {
    const store = new Store(path.join(tmpDir, "store.json"));
    assert.throws(() => services.setGoal(store, { threadId: "nope", goal: "x" }), /Unknown thread/);
  });
});

describe("applyNativeGoal", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-goal-native-"));
  });
  afterEach(async () => {
    await rmTree(tmpDir);
  });

  it("folds status and tokens into the matching goal, ignores a different objective", async () => {
    const { store, thread } = await seed(tmpDir);
    services.setGoal(store, { threadId: thread.id, goal: "ship" });
    assert.equal(
      services.applyNativeGoal(store, thread.id, { objective: "other", status: "complete" }),
      false,
    );
    assert.equal(
      services.applyNativeGoal(store, thread.id, { objective: "ship", status: "complete", tokensUsed: 12 }),
      true,
    );
    const goal = store.getThread(thread.id).goal;
    assert.equal(goal.status, "complete");
    assert.equal(goal.tokensUsed, 12);
    assert.equal(
      services.applyNativeGoal(store, thread.id, { objective: "ship", status: "complete", tokensUsed: 12 }),
      false,
      "unchanged report is a no-op",
    );
  });

  it("adopts a goal the agent created itself", async () => {
    const { store, thread } = await seed(tmpDir);
    services.applyNativeGoal(store, thread.id, { objective: "agent goal", status: "active" });
    assert.equal(store.getThread(thread.id).goal.objective, "agent goal");
  });
});

describe("goalNoteFor", () => {
  const goal = { objective: "ship v2", status: "active", setAt: 1 };
  it("is empty without a goal, for a finished goal, and on Codex (native)", () => {
    assert.equal(services.goalNoteFor({ provider: "claude" }), "");
    assert.equal(services.goalNoteFor({ provider: "claude", goal: null }), "");
    assert.equal(
      services.goalNoteFor({ provider: "claude", goal: { ...goal, status: "complete" } }),
      "",
    );
    assert.equal(services.goalNoteFor({ provider: "codex", goal }), "");
  });

  it("carries the objective for other providers", () => {
    assert.match(services.goalNoteFor({ provider: "grok", goal }), /\[Goal\][\s\S]*ship v2/);
  });
});

describe("goal note on dispatch", () => {
  let tmpDir;
  let runner;
  let prevSimulate;
  let prevAgentCmd;

  beforeEach(() => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-goal-run-"));
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
  });

  it("appends the goal to the CLI prompt, not the stored user message", async () => {
    const { store, thread } = await seed(tmpDir);
    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    runner = createRunner({ store, core, pushFn: () => {}, tickMs: 15 });
    const promptFile = path.join(tmpDir, "prompt.txt");
    // No spaces: parseAgentCommand whitespace-splits CODER_AGENT_CMD.
    const dump =
      `require('fs').writeFileSync(${JSON.stringify(promptFile)},process.argv[process.argv.length-1]);process.exit(0)`;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${dump}`;

    services.setGoal(store, { threadId: thread.id, goal: "all tests green" });
    await runner.startRun({ threadId: thread.id, prompt: "fix the parser" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const dumped = fs.readFileSync(promptFile, "utf8");
    assert.match(dumped, /fix the parser/);
    assert.match(dumped, /\[Goal\][\s\S]*all tests green/);
    const user = store.getMessages(thread.id).find((m) => m && m.role === "user");
    assert.equal(user.text, "fix the parser");
  });
});
