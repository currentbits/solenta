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

describe("runner contextTokens accuracy (#317, #704)", () => {
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
  let prevCursorBin;
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
    prevCursorBin = process.env.CODER_CURSOR_BIN;
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

  afterEach(async () => {
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
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
    if (prevCursorBin === undefined) delete process.env.CODER_CURSOR_BIN;
    else process.env.CODER_CURSOR_BIN = prevCursorBin;
    if (prevClaudeScenario === undefined) delete process.env.CODER_FAKE_CLAUDE_SCENARIO;
    else process.env.CODER_FAKE_CLAUDE_SCENARIO = prevClaudeScenario;
    if (prevCodexScenario === undefined) delete process.env.CODER_FAKE_CODEX_SCENARIO;
    else process.env.CODER_FAKE_CODEX_SCENARIO = prevCodexScenario;
    if (prevKimiScenario === undefined) delete process.env.CODER_FAKE_KIMI_SCENARIO;
    else process.env.CODER_FAKE_KIMI_SCENARIO = prevKimiScenario;
    delete process.env.CODER_FAKE_CODEX_EVENTS_FILE;
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

  it("Claude resolves compaction from the running account and refreshes a reused process", async () => {
    const binary = writeScript(tmpDir, "fake-claude-context.js", `
const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\\n");
let turns = 0;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "user") {
    if (!turns) emit({ type: "system", subtype: "init", model: "claude-opus-test", session_id: "sess-policy", claude_code_version: "2.1.318" });
    turns++;
    emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
    emit({ type: "result", subtype: "success", result: "ok", session_id: "sess-policy",
      usage: { input_tokens: 10, cache_read_input_tokens: 90000, cache_creation_input_tokens: 1000, output_tokens: 100 },
      modelUsage: { "claude-opus-test": { contextWindow: 1000000 } } });
  } else if (msg.request?.subtype === "get_context_usage") {
    const settings = JSON.parse(process.argv[process.argv.lastIndexOf("--settings") + 1]);
    emit({ type: "control_response", response: { subtype: "success", request_id: msg.request_id,
      response: { maxTokens: Number(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW),
        autoCompactThreshold: settings.autoCompactWindow - 33000, isAutoCompactEnabled: turns === 1 } } });
  }
});
`);
    process.env.CODER_CLAUDE_BIN = binary;
    store.setSettings({ providerInstances: [{ id: "work", name: "Work", provider: "claude", configDir: path.join(tmpDir, "account"),
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "150000" }, extraArgs: ["--settings", JSON.stringify({ autoCompactWindow: 150000 })] }] });
    const thread = services.createThread(store, { projectId: store.getProjects()[0].id, title: "Policy" });
    store.updateThread(thread.id, { providerInstance: "work" });
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await waitFor(() => store.getUsage(thread.id)?.contextCompaction);
    const usage = store.getUsage(thread.id);
    assert.deepEqual(usage.contextCompaction, { kind: "threshold", tokens: 117000, source: "reported" });
    assert.equal(usage.contextWindow, 1000000);
    assert.equal(usage.contextTokens, 91110);
    assert.equal(usage.inputTokens, 10);
    await runner.startRun({ threadId: thread.id, prompt: "again" });
    await waitFor(() => store.getUsage(thread.id)?.contextCompaction?.kind === "disabled");
    assert.equal(store.getUsage(thread.id).turns, 2);
    assert.equal(store.getUsage(thread.id).contextWindow, 1000000);
  });

  it("uses an idle streamed policy over a delayed summary estimate", async () => {
    process.env.CODER_CLAUDE_BIN = writeScript(tmpDir, "fake-claude-policy.js", `
const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "user") {
    emit({ type: "system", subtype: "init", model: "claude-opus-test", session_id: "sess-stream-policy", claude_code_version: "2.1.318" });
    emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
    emit({ type: "result", subtype: "success", result: "ok", session_id: "sess-stream-policy",
      usage: { input_tokens: 10, cache_read_input_tokens: 90000, cache_creation_input_tokens: 1000, output_tokens: 100 } });
  } else if (msg.request?.subtype === "get_context_usage") {
    emit({ type: "autocompact_state", value: { enabled: true, enforced: true, effective_window: 130000, threshold: 39000, source: "env" } });
    emit({ type: "control_response", response: { subtype: "success", request_id: msg.request_id,
      response: { maxTokens: 150000, autoCompactThreshold: 117000, isAutoCompactEnabled: true } } });
  }
});
`);
    const thread = services.createThread(store, { projectId: store.getProjects()[0].id, title: "Stream policy" });
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await waitFor(() => store.getUsage(thread.id)?.contextCompaction?.source === "enforced");
    assert.deepEqual(store.getUsage(thread.id).contextCompaction,
      { kind: "threshold", tokens: 39000, source: "enforced" });
    assert.equal(store.getThread(thread.id).status, "done");
  });

  it("drops a previous turn's policy and ignores a late summary on process reuse", async () => {
    const requests = path.join(tmpDir, "context-requests");
    process.env.CODER_CLAUDE_BIN = writeScript(tmpDir, "fake-claude-late-policy.js", `
const fs = require("node:fs");
const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\\n");
let turns = 0;
let pending;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "user") {
    turns++;
    if (turns === 1) emit({ type: "system", subtype: "init", model: "claude-opus-test", session_id: "sess-late", claude_code_version: "2.1.318" });
    if (pending) emit({ type: "control_response", response: { subtype: "success", request_id: pending,
      response: { maxTokens: 150000, autoCompactThreshold: 117000, isAutoCompactEnabled: true } } });
    emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
    emit({ type: "result", subtype: "success", result: "ok", session_id: "sess-late",
      usage: { input_tokens: 10, cache_read_input_tokens: 90000, cache_creation_input_tokens: 1000, output_tokens: 100 },
      modelUsage: { "claude-opus-test": { contextWindow: 1000000 } } });
  } else if (msg.request?.subtype === "get_context_usage") {
    fs.appendFileSync(${JSON.stringify(requests)}, "request\\n");
    if (turns === 1) pending = msg.request_id;
    else emit({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
  }
});
`);
    const thread = services.createThread(store, { projectId: store.getProjects()[0].id, title: "Late policy" });
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await waitFor(() => fs.existsSync(requests));
    // Simulate a persisted measurement, which must disappear on the next send.
    store.setUsage(thread.id, { ...store.getUsage(thread.id),
      contextCompaction: { kind: "threshold", tokens: 39000, source: "enforced" } });
    await runner.startRun({ threadId: thread.id, prompt: "again" });
    assert.equal(store.getUsage(thread.id).contextCompaction, undefined);
    await waitFor(() => store.getUsage(thread.id)?.turns === 2 &&
      fs.readFileSync(requests, "utf8").trim().split("\n").length === 2);
    assert.equal(store.getUsage(thread.id).contextCompaction, undefined);
    assert.equal(store.getUsage(thread.id).contextWindow, 1000000);
  });

  it("uses the model ceiling when a launched account has a known percentage override", async () => {
    const requests = path.join(tmpDir, "unexpected-context-request");
    const secondSend = path.join(tmpDir, "second-override-send");
    process.env.CODER_CLAUDE_BIN = writeScript(tmpDir, "fake-claude-override.js", `
const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\\n");
let turns = 0;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "user") {
    if (++turns === 2) require("node:fs").writeFileSync(${JSON.stringify(secondSend)}, "received");
    emit({ type: "system", subtype: "init", model: "claude-opus-test", session_id: "sess-override", claude_code_version: "2.1.318" });
    emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
    emit({ type: "result", subtype: "success", result: "ok", session_id: "sess-override",
      usage: { input_tokens: 10, cache_read_input_tokens: 90000, cache_creation_input_tokens: 1000, output_tokens: 100 },
      modelUsage: { "claude-opus-test": { contextWindow: 1000000 } } });
  } else if (msg.request?.subtype === "get_context_usage") {
    require("node:fs").writeFileSync(${JSON.stringify(requests)}, "unexpected");
  }
});
`);
    store.setSettings({ providerInstances: [{ id: "work", name: "Work", provider: "claude",
      env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "30" } }] });
    const thread = services.createThread(store, { projectId: store.getProjects()[0].id, title: "Override policy" });
    store.updateThread(thread.id, { providerInstance: "work" });
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await waitFor(() => store.getUsage(thread.id)?.turns === 1);
    await runner.startRun({ threadId: thread.id, prompt: "again" });
    // stdin is ordered: an erroneous summary request would be handled before
    // this second user message, so this negative assertion cannot race it.
    await waitFor(() => fs.existsSync(secondSend) && store.getUsage(thread.id)?.turns === 2);
    assert.equal(store.getUsage(thread.id).contextCompaction, undefined);
    assert.equal(store.getUsage(thread.id).contextWindow, 1000000);
    assert.equal(fs.existsSync(requests), false);
  });

  it("codex token_count captures contextWindow and does not add cumulative totals", async () => {
    const eventsFile = path.join(tmpDir, "codex-events.jsonl");
    fs.writeFileSync(
      eventsFile,
      [
        {
          type: "item.completed",
          item: { id: "m1", type: "agent_message", text: "hello" },
        },
        {
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
        },
        {
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
        },
      ]
        .map((ev) => JSON.stringify(ev))
        .join("\n"),
    );
    process.env.CODER_FAKE_CODEX_EVENTS_FILE = eventsFile;
    process.env.CODER_CODEX_BIN = require("./support/fakeCodexCli.js").writeFakeCodexBin(
      tmpDir,
      writeFakeBin,
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

  it("claude result without cache fields leaves contextTokens unset (#317)", async () => {
    process.env.CODER_CLAUDE_BIN = writeScript(
      tmpDir,
      "fake-claude-nocache.js",
      `#!/usr/bin/env node
"use strict";
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({ type: "system", subtype: "init", session_id: "sess-nocache", model: "claude-opus-test" });
emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
emit({
  type: "result",
  subtype: "success",
  result: "ok",
  session_id: "sess-nocache",
  usage: { input_tokens: 80, output_tokens: 40 },
  total_cost_usd: 0.01,
});
process.exit(0);
`,
    );

    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Claude no cache",
    });
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 80);
    assert.equal(usage.outputTokens, 40);
    assert.equal(usage.contextTokens, undefined);
  });

  it("grok result without cache fields still sets contextTokens (#704)", async () => {
    process.env.CODER_GROK_BIN = writeScript(
      tmpDir,
      "fake-grok.js",
      `#!/usr/bin/env node
"use strict";
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({ type: "system", subtype: "init", session_id: "grok-sess-ctx", model: "grok-4.6" });
emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
  session_id: "grok-sess-ctx",
  usage: { input_tokens: 80, output_tokens: 40 },
  total_cost_usd: 0.02,
});
process.exit(0);
`,
    );

    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Grok context",
    });
    services.setProvider(store, { threadId: thread.id, provider: "grok" });
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 80);
    assert.equal(usage.outputTokens, 40);
    assert.equal(usage.contextTokens, 120);
    assert.equal(usage.contextWindow, undefined);
  });

  it("grok cache fields and modelUsage.contextWindow land on SessionUsage (#704)", async () => {
    process.env.CODER_GROK_BIN = writeScript(
      tmpDir,
      "fake-grok-cache.js",
      `#!/usr/bin/env node
"use strict";
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({ type: "system", subtype: "init", session_id: "grok-sess-cache", model: "grok-4.6" });
emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
  session_id: "grok-sess-cache",
  usage: {
    input_tokens: 7210,
    cache_read_input_tokens: 41000,
    cache_creation_input_tokens: 0,
    output_tokens: 1893,
    total_tokens: 50103,
  },
  modelUsage: { "grok-4.6": { contextWindow: 500000 } },
  total_cost_usd: 0.0127,
});
process.exit(0);
`,
    );

    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Grok cache window",
    });
    services.setProvider(store, { threadId: thread.id, provider: "grok" });
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 7210);
    assert.equal(usage.outputTokens, 1893);
    assert.equal(usage.contextTokens, 50103);
    assert.equal(usage.contextWindow, 500000);
  });

  it("cursor result usage sets contextTokens from input+output (#704)", async () => {
    process.env.CODER_CURSOR_BIN = writeScript(
      tmpDir,
      "fake-cursor.js",
      `#!/usr/bin/env node
"use strict";
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({
  type: "system",
  subtype: "init",
  session_id: "cursor-sess-ctx",
  model: "Composer",
  permissionMode: "default",
});
emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
  session_id: "cursor-sess-ctx",
  usage: { input_tokens: 10, output_tokens: 4, cost: 0.02 },
});
process.exit(0);
`,
    );

    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Cursor context",
    });
    services.setProvider(store, { threadId: thread.id, provider: "cursor" });
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 10);
    assert.equal(usage.outputTokens, 4);
    assert.equal(usage.contextTokens, 14);
    assert.equal(usage.costUsd, 0.02);
    assert.equal(store.getSpendToday() > 0, true, "snake-case cost still bills spend");
  });

  it("cursor live camelCase cache fields fill contextTokens and do not invent USD (#703)", async () => {
    process.env.CODER_CURSOR_BIN = writeScript(
      tmpDir,
      "fake-cursor-live.js",
      `#!/usr/bin/env node
"use strict";
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({
  type: "system",
  subtype: "init",
  session_id: "cursor-sess-live",
  model: "Composer",
  permissionMode: "default",
});
emit({ type: "assistant", message: { content: [{ type: "text", text: "ping" }] } });
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ping",
  session_id: "cursor-sess-live",
  usage: {
    inputTokens: 11114,
    outputTokens: 43,
    cacheReadTokens: 6496,
    cacheWriteTokens: 0,
  },
});
process.exit(0);
`,
    );

    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Cursor live usage",
    });
    services.setProvider(store, { threadId: thread.id, provider: "cursor" });
    const spentBefore = store.getSpendToday();
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 11114);
    assert.equal(usage.outputTokens, 43);
    assert.equal(usage.contextTokens, 17653);
    assert.equal(usage.costUsd, 0);
    assert.equal(store.getSpendToday(), spentBefore, "no USD → no spend");

    const days = store.getUsageByDay();
    const dayCells = Object.values(days);
    assert.ok(dayCells.length > 0);
    const cursorCell = dayCells[0].cursor && Object.values(dayCells[0].cursor)[0];
    assert.ok(cursorCell, "pulse row exists");
    assert.equal(cursorCell.inputTokens, 11114);
    assert.equal(cursorCell.outputTokens, 43);
    assert.equal(cursorCell.cachedInputTokens, 6496);
    assert.equal(cursorCell.cacheWriteTokens, 0);
    assert.equal(cursorCell.costUsd, 0);
    assert.equal(cursorCell.turns, 1);
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

  it("kimi usage.record four-bucket fills contextTokens and does not invent USD (#696)", async () => {
    process.env.CODER_KIMI_BIN = writeScript(
      tmpDir,
      "fake-kimi-record",
      `#!/usr/bin/env node
"use strict";
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({ role: "assistant", content: "hi from kimi" });
emit({
  type: "usage.record",
  model: "kimi-code/k3",
  usage: { inputOther: 100, output: 20, inputCacheRead: 50, inputCacheCreation: 10 },
});
process.exit(0);
`,
    );

    const project = store.getProjects()[0];
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Kimi measurable",
    });
    services.setProvider(store, { threadId: thread.id, provider: "kimi" });
    const spentBefore = store.getSpendToday();
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.outputTokens, 20);
    assert.equal(usage.contextTokens, 180);
    assert.equal(usage.costUsd, 0);
    assert.equal(store.getSpendToday(), spentBefore);
  });
});
