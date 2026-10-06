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
const { isNativeCompactTurn } = require("../compaction.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { writeFakeCodexBin } = require("./support/fakeCodexCli.js");
const { rmTree } = require("./support/rmTree.js");

const CLAUDE_FIXTURE = path.join(__dirname, "fixtures/claude-compact.jsonl");

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
}

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe("isNativeCompactTurn", () => {
  it("only claude and codex, only with a session, only a bare /compact", () => {
    assert.equal(isNativeCompactTurn("claude", " /compact\n", "s"), true);
    assert.equal(isNativeCompactTurn("codex", "/compact", "s"), true);
    assert.equal(isNativeCompactTurn("grok", "/compact", "s"), false);
    assert.equal(isNativeCompactTurn("claude", "/compact", null), false);
    assert.equal(isNativeCompactTurn("claude", "/compact keep tests", "s"), false);
  });
});

describe("native compaction runs (#318)", () => {
  const ENV = [
    "CODER_SIMULATE",
    "CODER_AGENT_CMD",
    "CODER_CLAUDE_BIN",
    "CODER_CODEX_BIN",
    "CODER_GROK_MCP_DISABLE",
  ];
  let saved;
  let tmpDir;
  let store;
  let runner;
  let thread;

  beforeEach(async () => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-compact-"));
    store = new Store(path.join(tmpDir, "store.json"));
    runner = createRunner({ store, core: await loadCore(), pushFn: () => {}, tickMs: 15 });
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    for (const args of [
      ["init"],
      ["config", "user.email", "t@t.com"],
      ["config", "user.name", "t"],
      ["commit", "--allow-empty", "-m", "init"],
    ]) {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    }
    await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: store.getProjects()[0].id,
      title: "Compact me",
    });
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function seed(sessionId, contextTokens) {
    store.updateThread(thread.id, { sessionId });
    store.setUsage(thread.id, {
      model: null,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      turns: 1,
      contextTokens,
    });
  }

  const events = () =>
    store
      .getMessages(thread.id)
      .filter((m) => m.role === "event")
      .map((m) => m.text);

  it("claude: sends a bare /compact and resets the ring from compact_boundary", async () => {
    const stdinFile = path.join(tmpDir, "stdin.txt");
    process.env.CODER_CLAUDE_BIN = writeFakeBin(
      path.join(tmpDir, "fake-claude.js"),
      `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
require("node:readline").createInterface({ input: process.stdin }).once("line", (line) => {
  fs.writeFileSync(${JSON.stringify(stdinFile)}, line);
  process.stdout.write(fs.readFileSync(${JSON.stringify(CLAUDE_FIXTURE)}, "utf8"));
  setTimeout(() => process.exit(0), 50);
});
`,
    );
    seed("74038ac0-c4c1-462a-aba4-583498cd3ccf", 27495);
    await runner.startRun({ threadId: thread.id, prompt: "/compact" });
    await waitFor(() => store.getThread(thread.id).status !== "working");

    const sent = JSON.parse(fs.readFileSync(stdinFile, "utf8"));
    assert.equal(sent.message.content, "/compact");
    // Empty success result must not be held as a phantom and failed.
    assert.equal(store.getThread(thread.id).status, "done");
    assert.ok(events().includes("Context compacted (27.5k → 5.6k tokens)"), events().join("\n"));
    assert.equal(store.getUsage(thread.id).contextTokens, 5562);
  });

  it("claude: auto-compaction mid-turn posts an event and the result's usage wins", async () => {
    process.env.CODER_CLAUDE_BIN = writeFakeBin(
      path.join(tmpDir, "fake-claude-auto.js"),
      `#!/usr/bin/env node
"use strict";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "system", subtype: "init", session_id: "s-auto", model: "m" });
emit({ type: "system", subtype: "compact_boundary", session_id: "s-auto",
  compact_metadata: { trigger: "auto", pre_tokens: 190000, post_tokens: 12000 } });
emit({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
emit({ type: "result", subtype: "success", result: "done", session_id: "s-auto",
  usage: { input_tokens: 2, cache_read_input_tokens: 12000, cache_creation_input_tokens: 500, output_tokens: 98 } });
setTimeout(() => process.exit(0), 50);
`,
    );
    seed("s-auto", 190000);
    await runner.startRun({ threadId: thread.id, prompt: "keep going" });
    await waitFor(() => store.getThread(thread.id).status !== "working");

    assert.equal(store.getThread(thread.id).status, "done");
    assert.ok(events().includes("Context auto-compacted (190k → 12k tokens)"), events().join("\n"));
    assert.equal(store.getUsage(thread.id).contextTokens, 2 + 12000 + 500 + 98);
  });

  it("codex: runs thread/compact/start and resets the ring from the next usage", async () => {
    process.env.CODER_CODEX_BIN = writeFakeCodexBin(tmpDir, writeFakeBin);
    services.setProvider(store, { threadId: thread.id, provider: "codex" });
    seed("codex-sess-001", 19440);
    await runner.startRun({ threadId: thread.id, prompt: "/compact" });
    await waitFor(() => store.getThread(thread.id).status !== "working");

    assert.equal(store.getThread(thread.id).status, "done");
    assert.ok(events().includes("Context compacted (19.4k → 5.6k tokens)"), events().join("\n"));
    assert.equal(store.getUsage(thread.id).contextTokens, 5579);
  });
});
