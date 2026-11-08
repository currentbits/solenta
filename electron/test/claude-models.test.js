"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const models = require("../claudeModels.js");
const { getProvider } = require("../providers.js");
const { fetchProviderModels } = require("../providerModels.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { createRunner } = require("../runner.js");

const rows = (id, efforts = ["low", "high"]) => [
  { value: "sonnet", resolvedModel: id, displayName: "Sonnet alias", supportsEffort: true, supportedEffortLevels: efforts },
  { value: id, displayName: "Account model", description: "Installed CLI model", supportsEffort: true, supportedEffortLevels: efforts, supportsFastMode: true },
];

describe("Claude installed CLI model discovery (#1932)", () => {
  let dir;
  let opts;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-claude-models-"));
    opts = { home: dir, env: { HOME: dir, PATH: process.env.PATH }, which: () => "/fake/claude", userDataPath: dir };
    models.reset();
  });
  afterEach(async () => { models.reset(); await rmTree(dir); });

  it("deduplicates resolved aliases and preserves explicit empty effort support", () => {
    const parsed = models.parseModels([
      ...rows("private-model"),
      { value: "haiku", resolvedModel: "fast-model", displayName: "Fast", supportsEffort: false, supportedEffortLevels: ["high"] },
    ], getProvider("claude"));
    assert.deepEqual(parsed.models, ["private-model", "fast-model"]);
    assert.equal(parsed.modelInfo[0].label, "Account model");
    assert.deepEqual(parsed.modelInfo[0].efforts, ["low", "high"]);
    assert.deepEqual(parsed.modelInfo[1].efforts, []);
    assert.equal(parsed.aliases.sonnet, "private-model");
    assert.throws(() => models.parseModels([], getProvider("claude")), /models list/);
  });

  it("uses the selected default/named/isolated account and invalidates changed gateway or computer scope", async () => {
    const settings = { defaultAccounts: { claude: "work" }, providerInstances: [
      { id: "work", name: "work", provider: "claude", configDir: path.join(dir, "work"), env: { ANTHROPIC_BASE_URL: "https://work.invalid", ANTHROPIC_AUTH_TOKEN: "fake-work-token" } },
      { id: "iso", name: "iso", provider: "claude", isolatedHome: true, env: {} },
    ] };
    const calls = [];
    const runInitialize = async (target) => { calls.push(target); return rows(target.env.ANTHROPIC_BASE_URL || "isolated-model"); };
    await models.refresh(settings, "claude", { ...opts, runInitialize });
    await models.refresh(settings, "claude:work", { ...opts, runInitialize });
    assert.equal(calls.length, 1, "base row uses the account its default label names");
    assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, path.join(dir, "work"));
    assert.equal(calls[0].env.ANTHROPIC_AUTH_TOKEN, "fake-work-token");
    await models.refresh(settings, "claude:iso", { ...opts, runInitialize });
    assert.equal(calls[1].env.CLAUDE_CONFIG_DIR, path.join(dir, "provider-homes", "iso", "claude"));
    assert.equal(calls[1].env.ANTHROPIC_AUTH_TOKEN, undefined);
    settings.providerInstances[0].env.ANTHROPIC_BASE_URL = "https://changed.invalid";
    await models.refresh(settings, "claude:work", { ...opts, runInitialize });
    await models.refresh(settings, "claude:work", { ...opts, home: path.join(dir, "other-computer"), runInitialize });
    assert.equal(calls.length, 4);
    assert.equal(opts.env.ANTHROPIC_AUTH_TOKEN, undefined, "never mutates inherited env");
  });

  it("keeps the first list nonblocking, shares cold discovery, and preserves custom models on later lists", async () => {
    const store = new Store(path.join(dir, "store.json"));
    store.setSettings({
      defaultAccounts: { claude: "work" },
      providerInstances: [{ id: "work", name: "work", provider: "claude", configDir: path.join(dir, "work"), env: {} }],
      providerModels: { claude: { favorites: ["custom-model"], custom: ["custom-model", "sonnet"] } },
    });
    let release;
    let calls = 0;
    const runInitialize = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
    const first = await services.listProvidersForApi(store, { ...opts, runInitialize });
    assert.equal(calls, 1, "default account and named row share one in-flight request");
    assert.ok(first.find((p) => p.id === "claude").models.includes("custom-model"));
    const second = services.listProvidersForApi(store, { ...opts, runInitialize });
    release(rows("gateway-new-model", ["medium", "max"]));
    const listed = await second;
    const base = listed.find((p) => p.id === "claude");
    const work = listed.find((p) => p.id === "claude:work");
    assert.deepEqual(base.models, ["custom-model", "gateway-new-model"]);
    assert.deepEqual(work.models, ["gateway-new-model"]);
    assert.deepEqual(base.modelInfo[1].efforts, ["medium", "max"]);
    assert.equal(JSON.parse(JSON.stringify(base)).modelAliases.sonnet, "gateway-new-model", "alias capabilities survive IPC serialization");
    assert.equal(getProvider("claude").models.includes("gateway-new-model"), false, "account data never mutates the signed shared catalog");
  });

  it("refreshes cache after TTL/explicit refresh and keeps a successful catalog on failed refresh", async () => {
    let now = 0;
    let calls = 0;
    const runInitialize = async () => rows(`model-${++calls}`);
    const timed = { ...opts, runInitialize, now: () => now };
    await models.refresh({}, "claude", timed);
    await models.refresh({}, "claude", timed);
    assert.equal(calls, 1);
    now = models.TTL_MS + 1;
    await models.refresh({}, "claude", timed);
    assert.equal(calls, 2);
    await models.refresh({}, "claude", { ...timed, force: true });
    assert.equal(calls, 3);
    await assert.rejects(models.refresh({}, "claude", { ...timed, force: true, runInitialize: async () => { throw new Error("offline"); } }), /offline/);
    assert.deepEqual(models.cachedProvider(getProvider("claude"), {}, "claude", opts).models, ["model-3"]);
  });

  it("restarts an in-flight list after account credentials/gateway configuration change", async () => {
    const store = new Store(path.join(dir, "store.json"));
    const account = (gateway) => [{ id: "work", provider: "claude", name: "work", configDir: path.join(dir, "work"), env: { ANTHROPIC_BASE_URL: gateway } }];
    store.setSettings({ providerInstances: account("https://before.invalid") });
    let release;
    let calls = 0;
    const runInitialize = (target) => {
      calls++;
      if (target.env.ANTHROPIC_BASE_URL === "https://before.invalid") return new Promise((resolve) => { release = resolve; });
      return Promise.resolve(rows("after-change"));
    };
    // Existing providers.list state means a later picker must await even a
    // newly encountered account/config scope, unlike the first boot list.
    const listing = services.listProvidersForApi(store, { ...opts, runInitialize });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    store.setSettings({ providerInstances: account("https://after.invalid") });
    release(rows("before-change"));
    const list = await listing;
    assert.deepEqual(list.find((p) => p.id === "claude:work").models, ["after-change"]);
    assert.ok(calls >= 2);
  });

  it("fetches CLI-only login models without an API key and emits only supported explicit launch effort", async () => {
    const model = "gateway-model";
    await fetchProviderModels({}, "claude", { ...opts, runInitialize: async () => rows(model, ["high"]) });
    const entry = models.cachedProvider(getProvider("claude"), {}, "claude", opts);
    const args = (effort) => entry.buildArgs({ prompt: "fixture", model, reasoningEffort: effort, modelCapabilities: entry, fast: true });
    assert.ok(args("high").includes("--effort"));
    assert.equal(args("max").includes("--effort"), false);
    assert.equal(args(null).includes("--effort"), false, "Default delegates to the CLI, not an invented level");
    assert.ok(args("high").includes('{"fastMode":true}'));
    assert.ok(entry.buildArgs({ prompt: "fixture", model: "sonnet", reasoningEffort: "high", modelCapabilities: entry }).includes("--effort"), "stored aliases use canonical capabilities");
    await models.refresh({}, "claude", { ...opts, force: true, runInitialize: async () => rows(model, ["xhigh"]) });
    const updated = models.cachedProvider(getProvider("claude"), {}, "claude", opts);
    const ultra = updated.buildArgs({ prompt: "fixture", model, ultracode: true, cliSupportsUltracode: true, modelCapabilities: updated });
    assert.equal(ultra[ultra.indexOf("--effort") + 1], "xhigh");
    assert.ok(ultra.some((arg) => arg.includes('"ultracode":true')), "both Ultracode settings and effort use refreshed capabilities");
  });

  it("preserves the selected account's API fallback when its CLI does not support discovery", async () => {
    const settings = { defaultAccounts: { claude: "work" }, providerInstances: [{ id: "work", provider: "claude", name: "work", configDir: path.join(dir, "work"), env: { ANTHROPIC_BASE_URL: "https://gateway.invalid", ANTHROPIC_API_KEY: "fixture-key" } }] };
    let requested;
    const result = await fetchProviderModels(settings, "claude", {
      ...opts, runInitialize: async () => { throw new Error("unsupported"); },
      fetch: async (url) => { requested = url; return { ok: true, json: async () => ({ data: [{ id: "fallback-model" }] }) }; },
    });
    assert.equal(requested, "https://gateway.invalid/v1/models?limit=1000");
    assert.deepEqual(result, [{ id: "fallback-model", label: "fallback-model" }]);
    assert.match(models.fallbackNote(settings, "claude", opts), /Showing the catalog/);
  });

  it("runs the initialize protocol against a fake installed CLI with no user frames, prompt argv, hooks or MCP servers", async () => {
    const capture = path.join(dir, "capture.json");
    const binary = writeFakeBin(path.join(dir, "claude"), `
const fs = require('node:fs');
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.type !== 'control_request' || request.request.subtype !== 'initialize') process.exit(41);
  fs.writeFileSync(process.env.CAPTURE, JSON.stringify({ argv: process.argv.slice(2), request, env: { config: process.env.CLAUDE_CONFIG_DIR, gateway: process.env.ANTHROPIC_BASE_URL, parent: process.env.CLAUDECODE } }));
  const response = { type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { models: [{ value: 'sonnet', resolvedModel: 'fixture-gateway', displayName: 'Fixture', supportsEffort: false }] } } };
  const text = JSON.stringify(response) + '\\n';
  process.stdout.write(text.slice(0, 20));
  setTimeout(() => process.stdout.write(text.slice(20)), 5);
});
`);
    const settings = { providerInstances: [{ id: "work", provider: "claude", name: "work", configDir: path.join(dir, "work"), env: { ANTHROPIC_BASE_URL: "https://fixture.invalid", CAPTURE: capture }, extraArgs: ["accidental prompt", "--settings", '{"availableModels":["fixture-gateway"]}'] }] };
    const value = await models.refresh(settings, "claude:work", { ...opts, env: { ...opts.env, CODER_CLAUDE_BIN: binary, CLAUDECODE: "1" }, runInitialize: models.runInitialize });
    assert.deepEqual(value.models, ["fixture-gateway"]);
    const captured = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.deepEqual(captured.request.request, { subtype: "initialize" });
    assert.equal(captured.argv.includes("accidental prompt"), false);
    assert.ok(captured.argv.includes("--no-session-persistence"));
    assert.ok(captured.argv.includes("--strict-mcp-config"));
    const settingsArg = captured.argv[captured.argv.indexOf("--settings") + 1];
    assert.deepEqual(JSON.parse(settingsArg), { availableModels: ["fixture-gateway"], disableAllHooks: true });
    assert.deepEqual(captured.env, { config: path.join(dir, "work"), gateway: "https://fixture.invalid" });
  });

  it("returns a safe fallback error on unsupported initialize or a stalled CLI", async () => {
    const binary = writeFakeBin(path.join(dir, "unsupported"), "process.stdin.resume(); setInterval(() => {}, 1000);");
    await assert.rejects(models.refresh({}, "claude", { ...opts, env: { ...opts.env, CODER_CLAUDE_BIN: binary }, runInitialize: models.runInitialize, timeoutMs: 50 }), /timed out/);
    assert.equal(models.cachedProvider(getProvider("claude"), {}, "claude", { ...opts, env: { ...opts.env, CODER_CLAUDE_BIN: binary } }), getProvider("claude"));
  });

  it("uses the same catalog fallback in picker and validation for SSH, WSL and project-only environment", async () => {
    const settings = {};
    const entry = getProvider("claude");
    await models.refresh(settings, "claude", { ...opts, runInitialize: async () => rows("account-only") });
    const thread = { id: "t", projectId: "p", provider: "claude", providerInstance: null };
    let project = { id: "p", name: "fixture", path: dir, remoteHost: "fixture@remote" };
    const store = { filePath: path.join(dir, "store.json"), getSettings: () => settings, getProject: () => project, getThread: () => thread };
    for (const variant of [
      { path: dir, remoteHost: "fixture@remote" },
      { path: "\\\\wsl$\\Ubuntu\\home\\fixture" },
      { path: dir, env: { ANTHROPIC_BASE_URL: "https://project.invalid" } },
    ]) {
      project = { id: "p", name: "fixture", ...variant };
      const context = { ...opts, platform: "win32" };
      assert.equal(models.forThread(entry, store, thread, context), entry);
      const list = await services.listProvidersForApi(store, { ...context, threadId: "t", runInitialize: async () => { assert.fail("project-only scope must not probe the account CLI"); } });
      assert.equal(list.find((p) => p.id === "claude").models.includes("account-only"), false);
    }
    project = { id: "p", name: "fixture", path: dir };
    fs.mkdirSync(path.join(dir, ".devcontainer"));
    const envFile = path.join(dir, ".devcontainer", "devcontainer.json");
    fs.writeFileSync(envFile, JSON.stringify({ containerEnv: { ANTHROPIC_MODEL: "repo-model" } }));
    assert.equal(models.forThread(entry, store, thread, opts), entry, "unresolved repository env uses fallback without executing it");
    fs.unlinkSync(envFile);
    fs.writeFileSync(path.join(dir, ".envrc"), "export ANTHROPIC_BASE_URL=https://direnv.invalid");
    assert.equal(models.forThread(entry, store, thread, opts), entry, "unresolved direnv never borrows the account catalog");
    fs.unlinkSync(path.join(dir, ".envrc"));
    fs.mkdirSync(path.join(dir, ".claude"));
    fs.writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://project-settings.invalid" } }));
    assert.equal(models.forThread(entry, store, thread, opts), entry, "project Claude settings cannot borrow another gateway's capabilities");
  });

  it("does not resolve project-relative --settings against a different discovery directory", async () => {
    const settings = { providerInstances: [{ id: "work", name: "work", provider: "claude", configDir: dir, env: {}, extraArgs: ["--settings", "gateway.json"] }] };
    await assert.rejects(models.refresh(settings, "claude:work", { ...opts, runInitialize: () => assert.fail("must not run against the wrong settings file") }), /absolute --settings path/);
  });

  it("carries refreshed account capabilities through service validation to the actual fake Claude spawn", async () => {
    const names = ["HOME", "CODER_CLAUDE_BIN", "CODER_SIMULATE", "CODER_AGENT_CMD"];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    let runner;
    try {
      process.env.HOME = dir;
      delete process.env.CODER_SIMULATE;
      delete process.env.CODER_AGENT_CMD;
      const capture = path.join(dir, "run.json");
      process.env.CODER_CLAUDE_BIN = writeFakeBin(path.join(dir, "runner-claude"), `
const fs = require('node:fs');
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type !== 'user') return;
  fs.writeFileSync(process.env.CAPTURE_RUN, JSON.stringify({ argv: process.argv.slice(2), config: process.env.CLAUDE_CONFIG_DIR }));
  emit({ type: 'system', subtype: 'init', session_id: 'model-fixture', model: 'gateway-new' });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'fixture response' }] } });
  emit({ type: 'result', subtype: 'success', session_id: 'model-fixture', result: 'fixture response' });
});
`);
      const store = new Store(path.join(dir, "store.json"));
      const repo = path.join(dir, "repo");
      fs.mkdirSync(repo);
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      const project = await services.addProject(store, repo);
      const configDir = path.join(dir, "account");
      store.setSettings({ providerInstances: [{ id: "work", name: "work", provider: "claude", configDir, env: { CAPTURE_RUN: capture } }] });
      await models.refresh(store.getSettings(), "claude:work", { userDataPath: dir, runInitialize: async () => rows("gateway-new", ["high"]) });
      const thread = services.createThread(store, { projectId: project.id, title: "fixture", provider: "claude:work", model: "gateway-new" });
      assert.throws(() => services.setReasoningEffort(store, { threadId: thread.id, effort: "max" }), /does not support/);
      services.setReasoningEffort(store, { threadId: thread.id, effort: "high" });
      services.setFast(store, { threadId: thread.id, fast: true });
      const core = await import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
      runner = createRunner({ store, core, pushFn() {}, userDataPath: dir, tickMs: 15 });
      await runner.startRun({ threadId: thread.id, prompt: "fixture only" });
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(capture) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      const launched = JSON.parse(fs.readFileSync(capture, "utf8"));
      assert.equal(launched.argv[launched.argv.indexOf("--model") + 1], "gateway-new");
      assert.equal(launched.argv[launched.argv.indexOf("--effort") + 1], "high");
      assert.ok(launched.argv.some((arg) => arg.includes('"fastMode":true')));
      assert.equal(launched.config, configDir);
      // Project-only gateway configuration must use the same bundled
      // capability fallback during creation/default validation as launch.
      store.setProjects(store.getProjects().map((p) => ({ ...p, env: { ANTHROPIC_BASE_URL: "https://project.invalid" }, threadDefaults: { provider: "claude:work", model: "claude-haiku-4-5", reasoningEffort: "high" } })));
      const fromDefaults = services.createThread(store, { projectId: project.id, title: "project defaults" });
      assert.equal(fromDefaults.model, "claude-haiku-4-5");
      assert.equal(fromDefaults.reasoningEffort, null, "create sees the project identity and rejects an effort outside its launch catalog");
      assert.throws(() => services.setReasoningEffort(store, { threadId: fromDefaults.id, effort: "high" }), /does not support/);
    } finally {
      runner?.stopAll();
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
      }
    }
  });
});
