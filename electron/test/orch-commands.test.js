/**
 * Orchestration commands (issue #338): `/handoff`, `/advisor`, `/committee`
 * are intercepted in startRun and fanned out to workers.
 *
 * The parsing rules are unit-tested in orchcommands.test.js; this file tests
 * the JOIN — the real parser driving the real runner into the real store.
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

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
}

describe("orchestration commands", () => {
  let tmpDir;
  let store;
  let core;
  let runner;
  let thread;
  const prevEnv = {};

  beforeEach(async () => {
    // Simulate keeps the runs off real CLIs. The *_BIN overrides make the
    // installed set deterministic: parse only accepts an @provider argument
    // for a provider that resolves as available on this machine.
    for (const k of [
      "CODER_SIMULATE",
      "CODER_GROK_BIN",
      "CODER_CODEX_BIN",
      "CODER_CLAUDE_BIN",
    ]) {
      prevEnv[k] = process.env[k];
    }
    process.env.CODER_SIMULATE = "1";
    process.env.CODER_GROK_BIN = process.execPath;
    process.env.CODER_CODEX_BIN = process.execPath;
    process.env.CODER_CLAUDE_BIN = process.execPath;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-orchcmd-"));
    store = new Store(path.join(tmpDir, "store.json"));
    core = await loadCore();

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);

    const project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    });
    store.saveNow();
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    runner = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function makeRunner() {
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
      userDataPath: tmpDir,
    });
    return runner;
  }

  const workersOf = (id) =>
    store.getThreads().filter((t) => t.handoffFrom === id);
  const userTextOf = (id) =>
    (store.getMessages(id) || [])
      .filter((m) => m.role === "user")
      .map((m) => m.text)
      .join("\n");

  it("/committee forks two workers that know each other's thread ids", async () => {
    await makeRunner().startRun({
      threadId: thread.id,
      prompt: "/committee @grok @codex why does the reconnect test flake",
    });

    const workers = workersOf(thread.id);
    assert.equal(workers.length, 2);
    assert.deepEqual(workers.map((w) => w.provider).sort(), ["codex", "grok"]);
    for (const w of workers) {
      assert.equal(w.orchWorker, true);
      const peer = workers.find((o) => o.id !== w.id);
      const text = userTextOf(w.id);
      assert.ok(
        text.includes(peer.id),
        `worker ${w.id} was not told about peer ${peer.id}`,
      );
      assert.ok(text.includes("reconnect test flake"));
    }

    // The lead kept the raw prompt and never ran itself.
    const lead = store.getThread(thread.id);
    assert.equal(lead.status, "idle");
    const msgs = store.getMessages(thread.id) || [];
    assert.ok(
      msgs.some(
        (m) =>
          m.role === "user" &&
          m.text ===
            "/committee @grok @codex why does the reconnect test flake",
      ),
    );
    const event = msgs.find((m) => m.role === "event");
    assert.ok(event, "no event message on the lead");
    for (const w of workers) {
      assert.ok(
        String(event.text).includes(w.id.slice(0, 8)),
        "event does not name the workers",
      );
    }
  });

  it("/advisor runs read-only: one worker, no worktree", async () => {
    await makeRunner().startRun({
      threadId: thread.id,
      prompt: "/advisor @grok is the settle model right",
    });

    const workers = workersOf(thread.id);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].provider, "grok");
    assert.notEqual(workers[0].pendingWorktree, true);
    assert.equal(workers[0].worktreePath ?? null, null);
  });

  it("/handoff gets a worktree to implement in", async () => {
    await makeRunner().startRun({
      threadId: thread.id,
      prompt: "/handoff @codex implement the plan above",
    });

    const workers = workersOf(thread.id);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].provider, "codex");
    assert.ok(
      workers[0].worktreePath || workers[0].pendingWorktree,
      "handoff worker has no worktree",
    );
  });

  it("leaves an unknown slash command to the CLI", async () => {
    await makeRunner().startRun({
      threadId: thread.id,
      prompt: "/compact please",
    });
    assert.equal(workersOf(thread.id).length, 0);
    assert.equal(store.getThread(thread.id).status, "working");
  });

  it("never fans out on a machine-delivered turn", async () => {
    await makeRunner().startRun({
      threadId: thread.id,
      prompt: "/committee @grok @codex the worker quoted this back",
      fromNotice: true,
    });
    assert.equal(workersOf(thread.id).length, 0);
  });
});
