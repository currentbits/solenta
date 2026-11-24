"use strict";
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

describe("effective transcript configuration (#1927)", () => {
  let tmp, store, runner, project, calls, failLaunch, saved;
  beforeEach(async () => {
    saved = { ...process.env };
    for (const key of Object.keys(process.env)) if (key.startsWith("CODER_")) delete process.env[key];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-run-configuration-"));
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_CURSOR_MCP_DISABLE = "1";
    process.env.CODER_GUARDRAILS_PATH = path.join(tmp, "guardrails");
    process.env.CODER_CODEX_BIN = writeFakeBin(path.join(tmp, "codex"), "process.exit(0)");
    process.env.CODER_GROK_BIN = "missing-grok-for-test";
    calls = [];
    failLaunch = false;
    store = new Store(path.join(tmp, "store.json"));
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    project = await services.addProject(store, repo);
    const core = await import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
    runner = createRunner({ store, core, pushFn() {}, userDataPath: tmp,
      runCodexFn(options) {
        if (failLaunch) throw new Error("test launch refused");
        calls.push(options);
        return { kill() {}, send() { return true; } };
      },
    });
  });
  afterEach(async () => {
    runner?.stopAll();
    await rmTree(tmp);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  const makeThread = () => services.createThread(store, { projectId: project.id, provider: "codex", title: "history" }).id;
  const boundaries = (id) => store.getMessages(id).filter((m) => m.runConfiguration);
  function select(id, model = "gpt-6.1-sol", effort = "high") {
    services.setProvider(store, { threadId: id, model });
    services.setReasoningEffort(store, { threadId: id, effort });
  }
  const start = (id, prompt = "work") => runner.startRun({ threadId: id, prompt });

  it("records accepted settings, keeps live steering on that configuration, and switches at restart", async () => {
    const id = makeThread();
    select(id);
    const first = await start(id);
    assert.deepEqual(boundaries(id).map((m) => m.runConfiguration), [
      { provider: "codex", model: "gpt-6.1-sol", reasoningEffort: "high" },
    ]);
    select(id, "gpt-6-astra", "low");
    await runner.steerRun({ threadId: id, prompt: "also check this" });
    assert.equal(boundaries(id).length, 1, "picker and steering do not start a model change");
    assert.equal(store.getMessages(id).find((m) => m.steer).runId, first.runId);
    await runner.stopRun({ threadId: id });
    await start(id, "restart");
    assert.deepEqual(boundaries(id)[1].runConfiguration,
      { provider: "codex", model: "gpt-6-astra", reasoningEffort: "low" });
    assert.equal(calls[0].model, "gpt-6.1-sol");
    assert.equal(calls[1].model, "gpt-6-astra");
    store.saveNow();
    const loaded = new Store(path.join(tmp, "store.json"));
    assert.deepEqual(loaded.getMessages(id).filter((m) => m.runConfiguration), boundaries(id));
  });

  it("keeps a queued follow-up on its own dispatch boundary", async () => {
    const id = makeThread();
    select(id);
    const first = await start(id);
    services.setQueued(store, { threadId: id, prompt: "next task" });
    select(id, "gpt-6-astra", "low");
    assert.equal(boundaries(id).length, 1);
    await runner.stopRun({ threadId: id });
    await runner.sendQueued({ threadId: id });
    const history = boundaries(id).filter((m) => m.role === "event");
    assert.equal(history.length, 2);
    assert.notEqual(history[1].runId, first.runId);
    assert.deepEqual(history[1].runConfiguration,
      { provider: "codex", model: "gpt-6-astra", reasoningEffort: "low" });
    assert.equal(store.getMessages(id).filter((m) => m.role === "user" && m.text === "next task").length, 1);
  });

  it("snapshots a waiting run when it is admitted, without duplicating its prompt", async () => {
    store.setSettings({ maxConcurrentRuns: 1 });
    const busy = makeThread(), waiting = makeThread();
    select(waiting, "gpt-6.1-sol", "low");
    await start(busy);
    assert.equal((await start(waiting)).queued, true);
    assert.equal(boundaries(waiting).length, 0);
    select(waiting, "gpt-6-astra", "high");
    await runner.stopRun({ threadId: busy });
    for (let i = 0; i < 100 && !boundaries(waiting).length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(boundaries(waiting).map((m) => m.runConfiguration), [
      { provider: "codex", model: "gpt-6-astra", reasoningEffort: "high" },
    ]);
    assert.equal(store.getMessages(waiting).filter((m) => m.role === "user").length, 1);
  });

  it("discards an asynchronous failed-start marker but preserves attribution once the agent produced output", async () => {
    const id = makeThread();
    select(id);
    await start(id);
    calls[0].onError(new Error("transport refused before starting"));
    assert.equal(boundaries(id).length, 0);
    await start(id, "retry");
    calls[1].onEvent({ type: "item.completed", item: { id: "answer", type: "agent_message", text: "started working" } });
    calls[1].onError(new Error("transport failed later"));
    assert.equal(boundaries(id).filter((m) => m.role === "event").length, 1);
    assert.deepEqual(store.getMessages(id).find((m) => m.role === "assistant").runConfiguration,
      { provider: "codex", model: "gpt-6.1-sol", reasoningEffort: "high" });
    const tail = services.getThreadDetail(store, id, null, { limit: 2 });
    assert.ok(tail.messages.some((m) => m.runConfiguration), "paged history retains its output attribution");
  });

  it("records plan overrides and no false boundary on rejected launches or missing binaries", async () => {
    const id = makeThread();
    select(id, "gpt-6.1-sol", "low");
    services.setPlanModel(store, { threadId: id, model: "gpt-6-astra", effort: "high" });
    services.setPermissionMode(store, { threadId: id, mode: "plan" });
    failLaunch = true;
    await assert.rejects(start(id), /test launch refused/);
    assert.equal(boundaries(id).length, 0);
    assert.equal(runner.isRunning(id), false, "a failed launch releases its slot for Retry");
    failLaunch = false;
    await start(id);
    assert.deepEqual(boundaries(id)[0].runConfiguration,
      { provider: "codex", model: "gpt-6-astra", reasoningEffort: "high" });
    await runner.stopRun({ threadId: id });
    services.setProvider(store, { threadId: id, provider: "grok" });
    await assert.rejects(start(id), /not found|not installed|missing-grok/i);
    assert.equal(boundaries(id).length, 1);
    assert.equal(boundaries(id)[0].runConfiguration.provider, "codex", "handoff cannot rewrite prior attribution");
  });
});
