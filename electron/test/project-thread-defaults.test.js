/**
 * Per-project new-thread defaults (#1501): precedence, validation
 * fallbacks, "last used", and existing threads untouched.
 * Run: npm run test:electron -- --test-name-pattern "project thread defaults"
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store");
const services = require("../services");
const { normalizeThreadDefaults } = require("../projectCommands.js");

const BIN_ENVS = ["CODER_GROK_BIN", "CODER_KIMI_BIN"];

describe("project thread defaults (#1501)", () => {
  let tmpDir;
  let store;
  let project;
  /** @type {Record<string, string | undefined>} */
  let savedEnv;

  /** Any existing absolute path counts as an installed CLI. */
  const install = (env) => {
    process.env[env] = process.execPath;
  };
  const uninstall = (env) => {
    process.env[env] = path.join(tmpDir, "missing-cli");
  };
  const setDefaults = (threadDefaults) =>
    services.updateProject(store, project.id, { threadDefaults });
  const create = (extra = {}) =>
    services.createThread(store, { projectId: project.id, title: "T", ...extra });

  beforeEach(async () => {
    savedEnv = Object.fromEntries(BIN_ENVS.map((k) => [k, process.env[k]]));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-proj-defaults-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    project = await services.addProject(store, repo);
    install("CODER_GROK_BIN");
    install("CODER_KIMI_BIN");
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("normalizes shape and survives a store reload", () => {
    assert.equal(normalizeThreadDefaults(null), null);
    assert.equal(normalizeThreadDefaults({ model: "x", permissionMode: "nope" }), null);
    assert.deepEqual(
      normalizeThreadDefaults({
        provider: " grok ",
        model: " grok-4.6 ",
        reasoningEffort: "high",
        permissionMode: "plan",
        lastUsed: "yes",
      }),
      { provider: "grok", model: "grok-4.6", reasoningEffort: "high", permissionMode: "plan" },
    );
    setDefaults({ provider: "grok", model: "grok-4.6", lastUsed: true });
    store.saveNow();
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    assert.deepEqual(reloaded.getProject(project.id).threadDefaults, {
      provider: "grok",
      model: "grok-4.6",
      lastUsed: true,
    });
    const cleared = setDefaults(null);
    assert.equal(cleared.threadDefaults, undefined);
  });

  it("applies all four fields to a new thread", () => {
    setDefaults({
      provider: "grok",
      model: "grok-4.6",
      reasoningEffort: "high",
      permissionMode: "plan",
    });
    const t = create();
    assert.equal(t.provider, "grok");
    assert.equal(t.model, "grok-4.6");
    assert.equal(t.reasoningEffort, "high");
    assert.equal(t.permissionMode, "plan");
  });

  it("precedence: project default beats the global setting", () => {
    services.setSettings(store, { defaultProvider: "kimi", defaultModel: "kimi-code/k3" });
    setDefaults({ provider: "grok" });
    const t = create();
    assert.equal(t.provider, "grok");
    assert.equal(t.model, null, "the global model belongs to a different provider");
  });

  it("precedence: explicit provider beats the project default, and the project model does not follow", () => {
    setDefaults({
      provider: "grok",
      model: "grok-4.6",
      reasoningEffort: "high",
      permissionMode: "plan",
    });
    const t = create({ provider: "claude" });
    assert.equal(t.provider, "claude");
    assert.equal(t.model, null);
    // Effort and mode are not model details: they still apply when honoured.
    assert.equal(t.reasoningEffort, "high");
    assert.equal(t.permissionMode, "plan");
  });

  it("precedence: explicit model beats the project model", () => {
    setDefaults({ provider: "grok", model: "grok-4.6" });
    assert.equal(create({ model: "grok-4.7" }).model, "grok-4.7");
    assert.equal(create({ model: null }).model, null);
  });

  it("precedence: an agent profile applied after create wins", () => {
    setDefaults({ provider: "grok", reasoningEffort: "high", permissionMode: "plan" });
    const t = create();
    // Same steps as Composer.pickProfile / the issue starter.
    services.setProvider(store, { threadId: t.id, provider: "claude", model: "claude-opus-5-5" });
    services.setReasoningEffort(store, { threadId: t.id, effort: "low" });
    services.setPermissionMode(store, { threadId: t.id, mode: "acceptEdits" });
    const after = store.getThread(t.id);
    assert.equal(after.provider, "claude");
    assert.equal(after.model, "claude-opus-5-5");
    assert.equal(after.reasoningEffort, "low");
    assert.equal(after.permissionMode, "acceptEdits");
  });

  it("precedence: worker pool and plain forks ignore project defaults", () => {
    const source = create();
    setDefaults({
      provider: "grok",
      model: "grok-4.6",
      reasoningEffort: "high",
      permissionMode: "plan",
    });
    const fork = services.forkThread(store, { threadId: source.id });
    assert.equal(fork.provider, "claude");
    assert.equal(fork.model, null);
    assert.equal(fork.reasoningEffort, null);
    assert.equal(fork.permissionMode, "default");

    services.setSettings(store, {
      subagentPool: {
        defaultAlias: null,
        force: false,
        entries: [{ alias: "k", provider: "kimi", model: "kimi-code/k3", description: "kimi" }],
      },
    });
    const worker = services.forkWorkerThread(store, {
      threadId: source.id,
      pool: "k",
      worktree: false,
    });
    assert.equal(worker.provider, "kimi");
    assert.equal(worker.model, "kimi-code/k3");
    assert.equal(worker.reasoningEffort, null);
  });

  it("automation and memory threads skip project defaults", () => {
    setDefaults({ provider: "grok", permissionMode: "plan" });
    for (const extra of [{ automationId: "a1" }, { memoryConsolidate: true }]) {
      const t = create(extra);
      assert.equal(t.provider, "claude");
      assert.equal(t.permissionMode, "default");
    }
  });

  it("validation: an uninstalled provider falls back to the global default", () => {
    uninstall("CODER_GROK_BIN");
    services.setSettings(store, { defaultProvider: "kimi", defaultModel: "kimi-code/k3" });
    setDefaults({ provider: "grok", model: "grok-4.6" });
    const t = create();
    assert.equal(t.provider, "kimi");
    assert.equal(t.model, "kimi-code/k3");
  });

  it("validation: unknown provider ids fall back; remote projects skip the local install check", () => {
    setDefaults({ provider: "not-a-cli", model: "x" });
    assert.equal(create().provider, "claude");

    uninstall("CODER_GROK_BIN");
    services.updateProject(store, project.id, {
      remoteHost: "me@box",
      remotePath: "/srv/app",
      threadDefaults: { provider: "grok" },
    });
    assert.equal(create().provider, "grok");
  });

  it("validation: effort and permission mode snap to what the provider honours", () => {
    // grok lists low..xhigh and only plan / bypassPermissions.
    setDefaults({ provider: "grok", reasoningEffort: "max", permissionMode: "acceptEdits" });
    const t = create();
    assert.equal(t.reasoningEffort, null);
    assert.equal(t.permissionMode, "bypassPermissions");
  });

  it("never changes existing threads", () => {
    const before = create();
    setDefaults({ provider: "grok", reasoningEffort: "high", permissionMode: "plan" });
    const after = store.getThread(before.id);
    assert.equal(after.provider, "claude");
    assert.equal(after.reasoningEffort, null);
    assert.equal(after.permissionMode, "default");
  });

  describe("last used", () => {
    it("records the user's pick on a not-yet-run thread", () => {
      setDefaults({ lastUsed: true });
      const t = create();
      services.setProvider(store, { threadId: t.id, provider: "grok", model: "grok-4.7" });
      services.setReasoningEffort(store, { threadId: t.id, effort: "low" });
      assert.equal(services.recordLastUsedDefaults(store, t.id), true);
      assert.deepEqual(store.getProject(project.id).threadDefaults, {
        lastUsed: true,
        provider: "grok",
        model: "grok-4.7",
        reasoningEffort: "low",
        // setProvider snapped "default" to what grok honours.
        permissionMode: "bypassPermissions",
      });
      const next = create();
      assert.equal(next.provider, "grok");
      assert.equal(next.model, "grok-4.7");
      assert.equal(next.reasoningEffort, "low");
    });

    it("the IPC setters (user picks) record it", async () => {
      const handlers = require("../ipc-threads.js");
      const ctx = { store, broadcast() {}, runner: {} };
      setDefaults({ lastUsed: true });
      const t = create();
      await handlers["threads:setProvider"](ctx, { threadId: t.id, provider: "kimi" });
      assert.equal(store.getProject(project.id).threadDefaults.provider, "kimi");
      await handlers["threads:setReasoningEffort"](ctx, { threadId: t.id, effort: "high" });
      assert.equal(store.getProject(project.id).threadDefaults.reasoningEffort, "high");
      await handlers["threads:setPermissionMode"](ctx, {
        threadId: t.id,
        mode: "bypassPermissions",
      });
      assert.equal(
        store.getProject(project.id).threadDefaults.permissionMode,
        "bypassPermissions",
      );
    });

    it("ignores threads that already ran, workers, and projects with it off", () => {
      setDefaults({ lastUsed: true, provider: "grok" });
      const ran = create();
      store.appendMessage(ran.id, { id: "m1", role: "user", text: "hi", createdAt: 1 });
      services.setProvider(store, { threadId: ran.id, provider: "kimi" });
      assert.equal(services.recordLastUsedDefaults(store, ran.id), false);

      const worker = services.forkWorkerThread(store, {
        threadId: create().id,
        provider: "kimi",
        worktree: false,
      });
      assert.equal(services.recordLastUsedDefaults(store, worker.id), false);
      assert.equal(store.getProject(project.id).threadDefaults.provider, "grok");

      setDefaults({ provider: "grok" });
      const t = create();
      services.setProvider(store, { threadId: t.id, provider: "kimi" });
      assert.equal(services.recordLastUsedDefaults(store, t.id), false);
      assert.equal(store.getProject(project.id).threadDefaults.provider, "grok");
    });
  });
});
