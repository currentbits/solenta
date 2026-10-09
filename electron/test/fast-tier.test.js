/**
 * Issue #1529: Fast tier toggle and "Update <cli> to use <model>".
 * Run: node --test electron/test/fast-tier.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { getProvider, listProviders, modelSupportsFast } = require("../providers.js");
const catalog = require("../catalogDivergence.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { rmTree } = require("./support/rmTree.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { pathToFileURL } = require("node:url");
const { createRunner } = require("../runner.js");

const claude = getProvider("claude");
const codex = getProvider("codex");
const FAST_SETTINGS = JSON.stringify({ fastMode: true });

describe("fast tier: buildArgs", () => {
  it("claude sends --settings fastMode only on a fast model", () => {
    const on = claude.buildArgs({ prompt: "p", model: "claude-opus-5", fast: true });
    assert.equal(on[on.indexOf("--settings") + 1], FAST_SETTINGS);
    for (const args of [
      claude.buildArgs({ prompt: "p", model: "claude-opus-5", fast: false }),
      claude.buildArgs({ prompt: "p", model: "claude-haiku-4-5", fast: true }),
      claude.buildArgs({ prompt: "p", model: null, fast: true }),
    ]) {
      assert.ok(!args.includes("--settings"), JSON.stringify(args));
    }
  });

  it("codex sends service_tier=priority only on a fast model, prompt stays last", () => {
    // No cache under CODEX_HOME: the snapshot decides.
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "coder-fast-codex-"));
    try {
      const on = codex.buildArgs({ prompt: "P", model: "gpt-6.1-sol", fast: true });
      assert.ok(on.includes("service_tier=priority"));
      assert.equal(on[on.length - 1], "P");
      const spark = codex.buildArgs({ prompt: "P", model: "gpt-5.3-codex-spark", fast: true });
      assert.ok(!spark.includes("service_tier=priority"));
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
    }
  });

  it("codex spawn follows the live cache, the same source as the picker", () => {
    const opts = {
      env: { HOME: "/h" },
      readFile: () =>
        JSON.stringify({
          models: [
            { slug: "gpt-6.1-sol", service_tiers: [] },
            { slug: "gpt-6-terra", service_tiers: [{ id: "priority" }] },
          ],
        }),
    };
    assert.equal(modelSupportsFast(codex, "gpt-6.1-sol", opts), false, "tier dropped: never billed");
    assert.equal(modelSupportsFast(codex, "gpt-6-terra", opts), true, "tier added: toggle works");
    assert.equal(
      modelSupportsFast(codex, "gpt-6.1-sol", { env: { HOME: "/h" }, readFile: () => null }),
      true,
      "no cache: snapshot",
    );
  });
});

describe("fast tier: Codex live cache traits", () => {
  const cache = (json) => ({
    env: { HOME: "/h" },
    readFile: (p) => (p === path.join("/h", ".codex", "models_cache.json") ? JSON.stringify(json) : null),
  });

  it("re-derives fast from service_tiers and hints an update below minCli", () => {
    const out = listProviders({
      which: () => "/bin/x",
      ...cache({
        client_version: "0.155.0",
        models: [
          { slug: "gpt-6.1-sol", visibility: "list", service_tiers: [{ id: "priority" }] },
          { slug: "gpt-6-astra", visibility: "list", service_tiers: [] },
        ],
      }),
    });
    const info = out.find((p) => p.id === "codex").modelInfo;
    const sol = info.find((m) => m.id === "gpt-6.1-sol");
    assert.equal(sol.fast, true);
    assert.equal(sol.updateHint, "Update Codex to use GPT-6.1-Sol");
    assert.equal(info.find((m) => m.id === "gpt-6-astra").fast, undefined);
  });

  it("no hint once the CLI meets minCli; no cache keeps snapshot traits", () => {
    const out = listProviders({
      which: () => "/bin/x",
      ...cache({ client_version: "0.159.2", models: [] }),
    });
    assert.equal(
      out.find((p) => p.id === "codex").modelInfo.find((m) => m.id === "gpt-6.1-sol").updateHint,
      undefined,
    );
    const bare = listProviders({ which: () => "/bin/x", env: { HOME: "/h" }, readFile: () => null });
    assert.equal(bare.find((p) => p.id === "codex").modelInfo.find((m) => m.id === "gpt-6-astra").fast, true);
  });

  it("versionBelow compares dotted numbers", () => {
    assert.equal(catalog.versionBelow("0.155.0", "0.159.0"), true);
    assert.equal(catalog.versionBelow("0.159.0", "0.159.0"), false);
    assert.equal(catalog.versionBelow("0.160", "0.159.9"), false);
    assert.equal(catalog.versionBelow("1.0.0", "0.159.0"), false);
  });
});

describe("fast tier: setFast service", () => {
  let tmpDir;
  let store;
  let project;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-fast-svc-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    project = await services.addProject(store, repo);
  });

  afterEach(async () => {
    await rmTree(tmpDir);
  });

  it("defaults off, persists true on Claude, rejects a provider without a fast tier", () => {
    const thread = services.createThread(store, { projectId: project.id, title: "T" });
    assert.equal(thread.fast, false);
    assert.equal(services.setFast(store, { threadId: thread.id, fast: true }).fast, true);
    assert.equal(store.getThread(thread.id).fast, true);
    services.setProvider(store, { threadId: thread.id, provider: "grok" });
    assert.throws(
      () => services.setFast(store, { threadId: thread.id, fast: true }),
      /Grok has no fast tier/,
    );
    assert.equal(services.setFast(store, { threadId: thread.id, fast: false }).fast, false);
  });
});

/** Fake claude: records argv, refuses fast mode, then rejects the model. */
function writeRefusingClaude(dir) {
  return writeFakeBin(
    path.join(dir, "fake-claude"),
    `#!/usr/bin/env node
"use strict";
require("fs").writeFileSync(process.env.CODER_FAKE_ARGV, JSON.stringify(process.argv.slice(2)));
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "system", subtype: "init", session_id: "s1", model: "m",
  fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled" });
process.stdin.on("data", () => {
  emit({ type: "assistant", error: "model_not_found",
    message: { model: "<synthetic>", content: [{ type: "text", text: "There's an issue with the selected model." }] } });
  emit({ type: "result", subtype: "success", is_error: true, result: "There's an issue with the selected model.", session_id: "s1" });
});
setInterval(() => {}, 500);
`,
  );
}

describe("fast tier: Claude runner notices", () => {
  let tmpDir;
  let runner;
  const saved = {};
  const ENV = ["CODER_SIMULATE", "CODER_AGENT_CMD", "CODER_CLAUDE_BIN", "CODER_FAKE_ARGV"];

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-fast-run-"));
    process.env.CODER_CLAUDE_BIN = writeRefusingClaude(tmpDir);
    process.env.CODER_FAKE_ARGV = path.join(tmpDir, "argv.json");
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("sends fastMode, explains a refusal, and turns model_not_found into an update hint", async () => {
    const store = new Store(path.join(tmpDir, "store.json"));
    const core = await import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
    runner = createRunner({ store, core, pushFn() {}, tickMs: 15, userDataPath: tmpDir });
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, { projectId: project.id, title: "t" });
    services.setProvider(store, { threadId: thread.id, model: "claude-opus-5-5" });
    services.setFast(store, { threadId: thread.id, fast: true });
    store.saveNow();

    await runner.startRun({ threadId: thread.id, prompt: "hi" });
    const events = () =>
      store.getMessages(thread.id).filter((m) => m.role === "event").map((m) => m.text);
    const deadline = Date.now() + 15000;
    while (!events().some((t) => t.startsWith("Update Claude Code")) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const argv = JSON.parse(fs.readFileSync(process.env.CODER_FAKE_ARGV, "utf8"));
    assert.equal(argv[argv.indexOf("--settings") + 1], FAST_SETTINGS);
    const ev = events();
    assert.equal(
      ev.filter((t) => t === "Fast mode is off for this run (extra_usage_disabled).").length,
      1,
      JSON.stringify(ev),
    );
    assert.ok(
      ev.some((t) => t.startsWith("Update Claude Code to use Opus 5.5")),
      JSON.stringify(ev),
    );
  });
});

describe("fast tier: warm Claude reuse", () => {
  let tmpDir;
  let runner;
  const saved = {};
  const ENV = ["CODER_SIMULATE", "CODER_AGENT_CMD", "CODER_CLAUDE_BIN", "CODER_FAKE_SPAWNS"];

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-fast-warm-"));
    process.env.CODER_FAKE_SPAWNS = path.join(tmpDir, "spawns");
    process.env.CODER_CLAUDE_BIN = writeFakeBin(
      path.join(tmpDir, "fake-claude"),
      `#!/usr/bin/env node
"use strict";
require("fs").appendFileSync(process.env.CODER_FAKE_SPAWNS, JSON.stringify(process.argv.slice(2)) + "\\n");
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "system", subtype: "init", session_id: "s1", model: "m" });
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== "user") continue;
    emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
    emit({ type: "result", subtype: "success", result: "ok", usage: { input_tokens: 1, output_tokens: 1 }, session_id: "s1" });
  }
});
setInterval(() => {}, 500);
`,
    );
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("toggling Fast respawns the kept-alive CLI so --settings matches", async () => {
    const store = new Store(path.join(tmpDir, "store.json"));
    const core = await import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
    runner = createRunner({ store, core, pushFn() {}, tickMs: 15, userDataPath: tmpDir });
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, { projectId: project.id, title: "t" });
    services.setProvider(store, { threadId: thread.id, model: "claude-opus-5" });
    store.saveNow();

    const turn = async (prompt) => {
      const before = store.getUsage(thread.id)?.turns || 0;
      await runner.startRun({ threadId: thread.id, prompt });
      const deadline = Date.now() + 15000;
      while (
        !(store.getThread(thread.id).status === "done" && (store.getUsage(thread.id)?.turns || 0) > before) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await turn("one");
    services.setFast(store, { threadId: thread.id, fast: true });
    await turn("two");

    const spawns = fs.readFileSync(process.env.CODER_FAKE_SPAWNS, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(spawns.length, 2, "the Fast toggle must not ride the warm process");
    assert.ok(!spawns[0].includes("--settings"));
    assert.equal(spawns[1][spawns[1].indexOf("--settings") + 1], FAST_SETTINGS);
  });
});
