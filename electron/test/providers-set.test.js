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
const { getProvider } = require("../providers.js");

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

describe("setProvider lock semantics", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-setprov-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = services.addProject(store, repo);
    services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects unknown provider id", () => {
    const thread = store.getThreads()[0];
    assert.throws(
      () =>
        services.setProvider(store, {
          threadId: thread.id,
          provider: "not-a-real-provider",
        }),
      /Unknown provider/i,
    );
  });

  it("allows provider switch before sessionId is set", () => {
    const thread = store.getThreads()[0];
    assert.equal(thread.sessionId, null);
    const updated = services.setProvider(store, {
      threadId: thread.id,
      provider: "codex",
    });
    assert.equal(updated.provider, "codex");
    assert.equal(store.getThread(thread.id).provider, "codex");
  });

  it("rejects provider change after sessionId is set", () => {
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, { sessionId: "sess-locked" });
    store.save();
    assert.throws(
      () =>
        services.setProvider(store, {
          threadId: thread.id,
          provider: "codex",
        }),
      /already has a claude session/i,
    );
    assert.equal(store.getThread(thread.id).provider, "claude");
  });

  it("allows model-only change for claude with sessionId", () => {
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, { sessionId: "sess-1" });
    const before = store.getThread(thread.id).updatedAt;
    const updated = services.setProvider(store, {
      threadId: thread.id,
      model: "claude-sonnet-5",
    });
    assert.equal(updated.model, "claude-sonnet-5");
    assert.equal(updated.provider, "claude");
    assert.equal(updated.sessionId, "sess-1");
    assert.equal(store.getThread(thread.id).updatedAt, before);
  });

  it("accepts any non-empty custom model for providers with empty models list (codex)", () => {
    const thread = store.getThreads()[0];
    services.setProvider(store, { threadId: thread.id, provider: "codex" });
    const updated = services.setProvider(store, {
      threadId: thread.id,
      model: "o3-pro-custom",
    });
    assert.equal(updated.model, "o3-pro-custom");
    assert.equal(store.getThread(thread.id).model, "o3-pro-custom");
  });

  it("trims custom model and rejects whitespace-only with exact message", () => {
    const thread = store.getThreads()[0];
    services.setProvider(store, { threadId: thread.id, provider: "codex" });
    const updated = services.setProvider(store, {
      threadId: thread.id,
      model: "  gpt-5-custom  ",
    });
    assert.equal(updated.model, "gpt-5-custom");

    assert.throws(
      () =>
        services.setProvider(store, {
          threadId: thread.id,
          model: "   ",
        }),
      { message: "Model must be a non-empty string" },
    );
    assert.throws(
      () =>
        services.setProvider(store, {
          threadId: thread.id,
          model: "\t\n",
        }),
      { message: "Model must be a non-empty string" },
    );
  });

  it("rejects custom model longer than 100 chars for empty models list", () => {
    const thread = store.getThreads()[0];
    services.setProvider(store, { threadId: thread.id, provider: "codex" });
    const long = "m".repeat(101);
    assert.throws(
      () =>
        services.setProvider(store, {
          threadId: thread.id,
          model: long,
        }),
      /100|at most|too long/i,
    );
  });

  it("enforces membership for claude and kimi (non-empty models list)", () => {
    const thread = store.getThreads()[0];
    assert.throws(
      () =>
        services.setProvider(store, {
          threadId: thread.id,
          model: "not-a-claude-model",
        }),
      /model|not in|unknown/i,
    );
    assert.equal(store.getThread(thread.id).model, null);

    services.setProvider(store, { threadId: thread.id, provider: "kimi" });
    assert.throws(
      () =>
        services.setProvider(store, {
          threadId: thread.id,
          model: "not-a-kimi-model",
        }),
      /model|not in|unknown/i,
    );
    // Valid kimi model still accepted
    const ok = services.setProvider(store, {
      threadId: thread.id,
      model: "k3",
    });
    assert.equal(ok.model, "k3");
  });

  it("does not bump updatedAt on setProvider", () => {
    const thread = store.getThreads()[0];
    const fixed = 1_700_000_000_000;
    store.updateThread(thread.id, { updatedAt: fixed });
    services.setProvider(store, {
      threadId: thread.id,
      provider: "grok",
    });
    assert.equal(store.getThread(thread.id).updatedAt, fixed);
  });

  it("createThread defaults model to null", () => {
    const thread = store.getThreads()[0];
    assert.equal(thread.model, null);
  });

  it("clears model when switching provider so it does not leak into new argv", () => {
    const thread = store.getThreads()[0];
    services.setProvider(store, {
      threadId: thread.id,
      model: "claude-opus-5",
    });
    assert.equal(store.getThread(thread.id).model, "claude-opus-5");

    const updated = services.setProvider(store, {
      threadId: thread.id,
      provider: "codex",
    });
    assert.equal(updated.provider, "codex");
    assert.equal(updated.model, null);
    assert.equal(store.getThread(thread.id).model, null);

    // Codex buildArgs must not include -m from the stale claude model.
    const args = getProvider("codex").buildArgs({
      prompt: "hi",
      model: store.getThread(thread.id).model,
    });
    assert.ok(!args.includes("-m"), `unexpected -m in ${JSON.stringify(args)}`);
    assert.deepEqual(args, [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "hi",
    ]);
  });
});

describe("store migrates model: null", () => {
  it("adds model null without changing updatedAt", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-mig-model-"));
    const filePath = path.join(tmpDir, "s.json");
    try {
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          projects: [],
          threads: [
            {
              id: "t1",
              projectId: "p1",
              title: "L",
              branch: null,
              prNumber: null,
              status: "idle",
              createdAt: 1,
              updatedAt: 2,
              provider: "claude",
              sessionId: null,
              permissionMode: "default",
              worktreePath: null,
            },
          ],
          messagesByThread: {},
          workLogByThread: {},
        }),
        "utf8",
      );
      const store = new Store(filePath);
      const t = store.getThreads()[0];
      assert.equal(t.model, null);
      assert.equal(t.updatedAt, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("unavailable provider rejection", () => {
  let tmpDir;
  let store;
  let runner;
  let prevSimulate;
  let prevAgentCmd;
  let prevClaudeBin;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevClaudeBin = process.env.CODER_CLAUDE_BIN;
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    // Point claude at a missing absolute path so availability fails
    process.env.CODER_CLAUDE_BIN = path.join(
      os.tmpdir(),
      "coder-definitely-missing-claude-bin",
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-unavail-"));
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
    const project = services.addProject(store, repo);
    services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    if (prevClaudeBin === undefined) delete process.env.CODER_CLAUDE_BIN;
    else process.env.CODER_CLAUDE_BIN = prevClaudeBin;
  });

  it("startRun rejects when provider binary is unavailable, naming the binary", async () => {
    const thread = store.getThreads()[0];
    await assert.rejects(
      () =>
        runner.startRun({
          threadId: thread.id,
          prompt: "nope",
        }),
      (err) => {
        assert.match(String(err && err.message), /not found|binary/i);
        assert.match(
          String(err && err.message),
          /coder-definitely-missing-claude-bin/,
        );
        return true;
      },
    );
    // Should not have left the thread working
    assert.notEqual(store.getThread(thread.id).status, "working");
  });
});

describe("claude --model flag propagation", () => {
  let tmpDir;
  let store;
  let runner;
  let prevSimulate;
  let prevAgentCmd;
  let prevClaudeBin;
  let prevScenario;
  let prevArgvFile;
  let argvFile;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevClaudeBin = process.env.CODER_CLAUDE_BIN;
    prevScenario = process.env.CODER_FAKE_CLAUDE_SCENARIO;
    prevArgvFile = process.env.CODER_FAKE_CLAUDE_ARGV_FILE;
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-model-"));
    // Reuse claude test fake via inline minimal success script
    const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
if (process.env.CODER_FAKE_CLAUDE_ARGV_FILE) {
  fs.writeFileSync(process.env.CODER_FAKE_CLAUDE_ARGV_FILE, JSON.stringify(process.argv.slice(1)), "utf8");
}
function emit(o){process.stdout.write(JSON.stringify(o)+"\\n");}
emit({type:"system",subtype:"init",session_id:"s1",model:"m"});
emit({type:"result",subtype:"success",result:"ok",usage:{input_tokens:1,output_tokens:1},total_cost_usd:0,session_id:"s1"});
process.exit(0);
`;
    const fake = path.join(tmpDir, "fake-claude");
    fs.writeFileSync(fake, body, { mode: 0o755 });
    argvFile = path.join(tmpDir, "argv.json");
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
    const project = services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "M",
    });
    services.setProvider(store, {
      threadId: thread.id,
      model: "claude-sonnet-5",
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    if (prevClaudeBin === undefined) delete process.env.CODER_CLAUDE_BIN;
    else process.env.CODER_CLAUDE_BIN = prevClaudeBin;
    if (prevScenario === undefined) delete process.env.CODER_FAKE_CLAUDE_SCENARIO;
    else process.env.CODER_FAKE_CLAUDE_SCENARIO = prevScenario;
    if (prevArgvFile === undefined) delete process.env.CODER_FAKE_CLAUDE_ARGV_FILE;
    else process.env.CODER_FAKE_CLAUDE_ARGV_FILE = prevArgvFile;
  });

  it("passes --model <thread.model> in claude argv", async () => {
    const thread = store.getThreads()[0];
    assert.equal(thread.model, "claude-sonnet-5");
    await runner.startRun({ threadId: thread.id, prompt: "with model" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const idx = argv.indexOf("--model");
    assert.ok(idx >= 0, `expected --model in ${JSON.stringify(argv)}`);
    assert.equal(argv[idx + 1], "claude-sonnet-5");
  });
});

describe("grok structured provider args shape (smoke via setProvider)", () => {
  let tmpDir;
  let store;
  let runner;
  let prevSimulate;
  let prevAgentCmd;
  let prevGrok;
  let argvFile;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevGrok = process.env.CODER_GROK_BIN;
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-grok-"));
    argvFile = path.join(tmpDir, "argv.json");
    // Minimal streaming-messages-json fake (claude-stream shape).
    const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
if (process.env.CODER_FAKE_GROK_ARGV_FILE) {
  fs.writeFileSync(process.env.CODER_FAKE_GROK_ARGV_FILE, JSON.stringify(process.argv.slice(1)), "utf8");
}
function emit(o){process.stdout.write(JSON.stringify(o)+"\\n");}
emit({type:"system",subtype:"init",session_id:"g-set-1",model:"grok-4.5"});
emit({type:"assistant",message:{content:[{type:"text",text:"grok-ok"}]}});
emit({type:"result",subtype:"success",is_error:false,result:"grok-ok",usage:{input_tokens:1,output_tokens:2},total_cost_usd:0,num_turns:1,session_id:"g-set-1"});
process.exit(0);
`;
    const fake = path.join(tmpDir, "fake-grok");
    fs.writeFileSync(fake, body, { mode: 0o755 });
    process.env.CODER_GROK_BIN = fake;
    process.env.CODER_FAKE_GROK_ARGV_FILE = argvFile;

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
    const project = services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "G",
    });
    services.setProvider(store, { threadId: thread.id, provider: "grok" });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    if (prevGrok === undefined) delete process.env.CODER_GROK_BIN;
    else process.env.CODER_GROK_BIN = prevGrok;
    delete process.env.CODER_FAKE_GROK_ARGV_FILE;
  });

  it("spawns grok via claude-stream with structured argv and captures session", async () => {
    const entry = getProvider("grok");
    assert.equal(entry.kind, "claude-stream");
    assert.equal(entry.supportsResume, true);

    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "hey grok" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const pIdx = argv.indexOf("-p");
    assert.ok(pIdx >= 0, `expected -p in ${JSON.stringify(argv)}`);
    assert.equal(argv[pIdx + 1], "hey grok");
    assert.ok(argv.includes("streaming-messages-json"));
    assert.ok(!argv.includes("--verbose"));
    assert.ok(!argv.includes("--mcp-config"));

    const assistants = store
      .getMessages(thread.id)
      .filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].text, "grok-ok");
    assert.equal(store.getThread(thread.id).sessionId, "g-set-1");
  });
});
