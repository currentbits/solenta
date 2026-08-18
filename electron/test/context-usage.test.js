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
const { extractUsage } = require("../codex.js");
const { writeFakeBin } = require("./support/fakeBin.js");

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

function writeScript(dir, name, body) {
  return writeFakeBin(path.join(dir, name), body);
}

describe("codex extractUsage token_count", () => {
  it("uses last_token_usage + model_context_window, not the cumulative total", () => {
    const u = extractUsage({
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 143888,
          cached_input_tokens: 21248,
          output_tokens: 8225,
          reasoning_output_tokens: 6092,
          total_tokens: 152113,
        },
        last_token_usage: {
          input_tokens: 20484,
          cached_input_tokens: 16768,
          output_tokens: 327,
          reasoning_output_tokens: 0,
          total_tokens: 20811,
        },
        model_context_window: 258400,
      },
    });
    assert.equal(u.inputTokens, 20484);
    assert.equal(u.outputTokens, 327);
    assert.equal(u.contextTokens, 20811);
    assert.equal(u.contextWindow, 258400);
    assert.equal(u.snapshot, undefined);
  });

  it("marks cumulative-only totals as a snapshot so applyUsage will not add them", () => {
    const u = extractUsage({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 10,
            total_tokens: 110,
          },
          model_context_window: 200000,
        },
      },
    });
    assert.equal(u.inputTokens, 100);
    assert.equal(u.outputTokens, 10);
    assert.equal(u.contextTokens, 110);
    assert.equal(u.contextWindow, 200000);
    assert.equal(u.snapshot, true);
  });

  it("returns null for a rate-limit-only token_count with no usage info", () => {
    assert.equal(
      extractUsage({
        type: "token_count",
        info: null,
        rate_limits: {
          limit_id: "premium",
          primary: { used_percent: 0, window_minutes: 300, resets_at: 1700000000 },
        },
      }),
      null,
    );
  });

  it("does not add cached_input_tokens on turn.completed (already inside input)", () => {
    const u = extractUsage({
      type: "turn.completed",
      usage: {
        input_tokens: 20484,
        cached_input_tokens: 16768,
        output_tokens: 327,
      },
    });
    assert.equal(u.inputTokens, 20484);
    assert.equal(u.outputTokens, 327);
    assert.equal(u.contextTokens, 20811);
  });
});

describe("runner contextTokens accuracy (#317)", () => {
  let tmpDir;
  let store;
  let runner;
  let prevSimulate;
  let prevAgentCmd;
  let prevGrokMcpDisable;
  let prevGrokBin;
  let prevClaudeBin;
  let prevCodexBin;
  let prevKimiBin;
  let prevClaudeScenario;
  let prevCodexScenario;
  let prevKimiScenario;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevGrokMcpDisable = process.env.CODER_GROK_MCP_DISABLE;
    prevGrokBin = process.env.CODER_GROK_BIN;
    prevClaudeBin = process.env.CODER_CLAUDE_BIN;
    prevCodexBin = process.env.CODER_CODEX_BIN;
    prevKimiBin = process.env.CODER_KIMI_BIN;
    prevClaudeScenario = process.env.CODER_FAKE_CLAUDE_SCENARIO;
    prevCodexScenario = process.env.CODER_FAKE_CODEX_SCENARIO;
    prevKimiScenario = process.env.CODER_FAKE_KIMI_SCENARIO;

    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = "no-grok-not-a-real-binary";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-ctx-"));
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
    git(repo, ["config", "user.email", "t@t.com"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    await services.addProject(store, repo);
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    if (prevGrokMcpDisable === undefined) delete process.env.CODER_GROK_MCP_DISABLE;
    else process.env.CODER_GROK_MCP_DISABLE = prevGrokMcpDisable;
    if (prevGrokBin === undefined) delete process.env.CODER_GROK_BIN;
    else process.env.CODER_GROK_BIN = prevGrokBin;
    if (prevClaudeBin === undefined) delete process.env.CODER_CLAUDE_BIN;
    else process.env.CODER_CLAUDE_BIN = prevClaudeBin;
    if (prevCodexBin === undefined) delete process.env.CODER_CODEX_BIN;
    else process.env.CODER_CODEX_BIN = prevCodexBin;
    if (prevKimiBin === undefined) delete process.env.CODER_KIMI_BIN;
    else process.env.CODER_KIMI_BIN = prevKimiBin;
    if (prevClaudeScenario === undefined) delete process.env.CODER_FAKE_CLAUDE_SCENARIO;
    else process.env.CODER_FAKE_CLAUDE_SCENARIO = prevClaudeScenario;
    if (prevCodexScenario === undefined) delete process.env.CODER_FAKE_CODEX_SCENARIO;
    else process.env.CODER_FAKE_CODEX_SCENARIO = prevCodexScenario;
    if (prevKimiScenario === undefined) delete process.env.CODER_FAKE_KIMI_SCENARIO;
    else process.env.CODER_FAKE_KIMI_SCENARIO = prevKimiScenario;
  });

  it("claude result with cache_read includes cache tokens in contextTokens only", async () => {
    process.env.CODER_CLAUDE_BIN = writeScript(
      tmpDir,
      "fake-claude.js",
      `#!/usr/bin/env node
"use strict";
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({ type: "system", subtype: "init", session_id: "sess-cache", model: "claude-opus-test" });
emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
emit({
  type: "result",
  subtype: "success",
  result: "ok",
  session_id: "sess-cache",
  usage: {
    input_tokens: 2,
    cache_read_input_tokens: 17028,
    cache_creation_input_tokens: 20661,
    output_tokens: 884,
  },
  total_cost_usd: 0.01,
});
process.exit(0);
`,
    );

    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Claude cache",
    });
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    // Billable in/out stay the cache-exclusive fields.
    assert.equal(usage.inputTokens, 2);
    assert.equal(usage.outputTokens, 884);
    assert.equal(usage.contextTokens, 2 + 17028 + 20661 + 884);
    assert.equal(usage.contextWindow, undefined);
  });

  it("codex token_count captures contextWindow and does not add cumulative totals", async () => {
    process.env.CODER_CODEX_BIN = writeScript(
      tmpDir,
      "fake-codex",
      `#!/usr/bin/env node
"use strict";
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({ type: "thread.started", thread_id: "codex-sess-ctx" });
emit({
  type: "item.completed",
  item: { id: "m1", type: "agent_message", text: "hello" },
});
emit({
  type: "token_count",
  info: {
    total_token_usage: {
      input_tokens: 100,
      cached_input_tokens: 40,
      output_tokens: 10,
      total_tokens: 110,
    },
    last_token_usage: {
      input_tokens: 100,
      cached_input_tokens: 40,
      output_tokens: 10,
      total_tokens: 110,
    },
    model_context_window: 258400,
  },
});
emit({
  type: "token_count",
  info: {
    total_token_usage: {
      input_tokens: 250,
      cached_input_tokens: 180,
      output_tokens: 20,
      total_tokens: 270,
    },
    last_token_usage: {
      input_tokens: 150,
      cached_input_tokens: 140,
      output_tokens: 10,
      total_tokens: 160,
    },
    model_context_window: 272000,
  },
});
process.exit(0);
`,
    );

    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Codex window",
    });
    services.setProvider(store, { threadId: thread.id, provider: "codex" });
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    // last + last, not total + total (100+250 would be 350).
    assert.equal(usage.inputTokens, 250);
    assert.equal(usage.outputTokens, 20);
    assert.equal(usage.contextTokens, 160);
    assert.equal(usage.contextWindow, 272000);
  });

  it("kimi usage without a full-prompt measurement leaves contextTokens unset", async () => {
    process.env.CODER_KIMI_BIN = writeScript(
      tmpDir,
      "fake-kimi",
      `#!/usr/bin/env node
"use strict";
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({ role: "assistant", content: "hi from kimi" });
emit({ type: "usage", input_tokens: 12, output_tokens: 8 });
process.exit(0);
`,
    );

    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Kimi unmeasurable",
    });
    services.setProvider(store, { threadId: thread.id, provider: "kimi" });
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 12);
    assert.equal(usage.outputTokens, 8);
    assert.equal(usage.contextTokens, undefined);
    assert.equal(usage.contextWindow, undefined);
  });
});
