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
const {
  extractSessionId,
  isSessionStartEvent,
  extractAgentMessageText,
  extractCommandItem,
  extractLiveItem,
  extractUsage,
} = require("../codex.js");
const { writeFakeBin } = require("./support/fakeBin.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
}

/**
 * `codex exec` / `exec resume` own `-c`. MCP overrides before `exec` are
 * dropped on resume, which re-denies first-party tools under never.
 * @param {string[]} argv
 * @param {{ url: string, resume?: false | string }} opts
 */
function assertCodexMcpOnExec(argv, opts) {
  const execIdx = argv.indexOf("exec");
  assert.ok(execIdx >= 0, `expected exec in ${JSON.stringify(argv)}`);
  if (opts.resume) {
    assert.equal(argv[execIdx + 1], "resume");
    assert.equal(argv[execIdx + 2], opts.resume);
  } else {
    assert.notEqual(argv[execIdx + 1], "resume");
  }
  const before = argv.slice(0, execIdx);
  for (let i = 0; i < before.length; i++) {
    if (before[i] === "-c") {
      assert.ok(
        !String(before[i + 1] || "").startsWith("mcp_servers."),
        `mcp -c must not sit before exec (resume drops it): ${JSON.stringify(argv)}`,
      );
    }
  }
  const after = argv.slice(execIdx, argv.length - 1);
  const values = [];
  for (let i = 0; i < after.length - 1; i++) {
    if (after[i] === "-c") values.push(after[i + 1]);
  }
  assert.ok(
    values.includes(opts.url),
    `missing bound MCP url after exec: ${JSON.stringify(argv)}`,
  );
  assert.ok(
    values.includes(
      'mcp_servers.coder-memory.default_tools_approval_mode="approve"',
    ),
    `missing MCP auto-approve after exec: ${JSON.stringify(argv)}`,
  );
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

/**
 * Fake codex CLI emitting representative JSONL.
 * @param {string} dir
 */
async function writeFakeCodex(dir) {
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");

if (process.env.CODER_FAKE_CODEX_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_CODEX_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
  // MCP bearer tokens must arrive by env, not argv (issue #125).
  fs.writeFileSync(
    process.env.CODER_FAKE_CODEX_ARGV_FILE + ".env.json",
    JSON.stringify(
      Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) =>
            k.startsWith("CODER_MCP_TOKEN_") ||
            k === "CODEX_HOME" ||
            k === "SOLENTA_WORKTREE",
        ),
      ),
    ),
    "utf8",
  );
}

const scenario = process.env.CODER_FAKE_CODEX_SCENARIO || "success";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

async function main() {
  if (scenario === "fail-exit") {
    process.stderr.write("codex-stderr-boom\\n");
    process.exit(2);
    return;
  }

  if (scenario === "structured-overflow") {
    emit({
      type: "turn.failed",
      error: {
        code: "context_length_exceeded",
        message:
          "Codex ran out of room in the model's context window. Start a new conversation.",
      },
    });
    process.exit(1);
    return;
  }

  if (scenario === "success" || scenario === "resume-turn") {
    emit({ type: "thread.started", thread_id: "codex-sess-001" });
    await delay(20);
    emit({
      type: "item.completed",
      item: {
        id: "item-msg-1",
        type: "agent_message",
        text: "Hello from codex",
      },
    });
    await delay(20);
    emit({
      type: "item.started",
      item: {
        id: "item-cmd-1",
        type: "command_execution",
        command: "echo hi",
      },
    });
    await delay(20);
    emit({
      type: "item.completed",
      item: {
        id: "item-cmd-1",
        type: "command_execution",
        command: "echo hi",
        aggregated_output: "hi\\n",
        exit_code: 0,
      },
    });
    await delay(20);
    emit({
      type: "turn.completed",
      usage: { input_tokens: 30, output_tokens: 12 },
    });
    process.exit(0);
    return;
  }

  // Issue #752: reasoning and file_change must be visible before the turn
  // settles; item.completed of the same ids must not duplicate cards.
  if (scenario === "thinking-then-tool") {
    emit({ type: "thread.started", thread_id: "codex-sess-live" });
    await delay(10);
    emit({
      type: "item.started",
      item: {
        id: "item-reason-1",
        type: "reasoning",
        text: "I should patch src/foo.ts first.",
      },
    });
    await delay(200);
    emit({
      type: "item.completed",
      item: {
        id: "item-reason-1",
        type: "reasoning",
        text: "I should patch src/foo.ts first.",
      },
    });
    emit({
      type: "item.started",
      item: {
        id: "item-edit-1",
        type: "file_change",
        changes: [{ path: "src/foo.ts", kind: "update" }],
        status: "in_progress",
      },
    });
    await delay(80);
    emit({
      type: "item.completed",
      item: {
        id: "item-edit-1",
        type: "file_change",
        changes: [{ path: "src/foo.ts", kind: "update" }],
        status: "completed",
      },
    });
    emit({
      type: "item.completed",
      item: {
        id: "item-msg-1",
        type: "agent_message",
        text: "Patched foo.ts.",
      },
    });
    emit({
      type: "turn.completed",
      usage: { input_tokens: 20, output_tokens: 8 },
    });
    process.exit(0);
    return;
  }

  // Issue #171: remaining item types + official completed-only file_change
  // / web_search (current exec --json never emits item.started for those).
  if (scenario === "dropped-items") {
    emit({ type: "thread.started", thread_id: "codex-sess-171" });
    await delay(10);
    emit({
      type: "item.started",
      item: {
        id: "item-todo-1",
        type: "todo_list",
        items: [
          { text: "Patch foo", completed: false },
          { text: "Run tests", completed: false },
        ],
      },
    });
    await delay(10);
    emit({
      type: "item.updated",
      item: {
        id: "item-todo-1",
        type: "todo_list",
        items: [
          { text: "Patch foo", completed: true },
          { text: "Run tests", completed: false },
        ],
      },
    });
    emit({
      type: "item.started",
      item: {
        id: "item-mcp-1",
        type: "mcp_tool_call",
        server: "github",
        tool: "get_issue",
        arguments: { number: 171 },
        status: "in_progress",
      },
    });
    await delay(20);
    emit({
      type: "item.completed",
      item: {
        id: "item-mcp-1",
        type: "mcp_tool_call",
        server: "github",
        tool: "get_issue",
        arguments: { number: 171 },
        result: {
          content: [{ type: "text", text: "open" }],
          structured_content: null,
        },
        status: "completed",
      },
    });
    emit({
      type: "item.completed",
      item: {
        id: "item-edit-1",
        type: "file_change",
        changes: [{ path: "src/foo.ts", kind: "update" }],
        status: "completed",
      },
    });
    emit({
      type: "item.completed",
      item: {
        id: "item-search-1",
        type: "web_search",
        query: "codex exec json",
      },
    });
    emit({
      type: "item.completed",
      item: {
        id: "item-todo-1",
        type: "todo_list",
        items: [
          { text: "Patch foo", completed: true },
          { text: "Run tests", completed: true },
        ],
      },
    });
    emit({
      type: "item.completed",
      item: {
        id: "item-msg-1",
        type: "agent_message",
        text: "Done.",
      },
    });
    emit({
      type: "turn.completed",
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    process.exit(0);
    return;
  }

  process.stderr.write("unknown scenario " + scenario + "\\n");
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(String(e) + "\\n");
  process.exit(1);
});
`;
  return writeFakeBin(path.join(dir, "fake-codex"), body);
}

describe("codex event parse helpers", () => {
  it("extracts session id from thread.started", () => {
    const ev = { type: "thread.started", thread_id: "t-1" };
    assert.equal(isSessionStartEvent(ev), true);
    assert.equal(extractSessionId(ev), "t-1");
  });

  it("extracts agent message text from item.completed", () => {
    assert.equal(
      extractAgentMessageText({
        type: "item.completed",
        item: { type: "agent_message", text: "hi" },
      }),
      "hi",
    );
  });

  it("extracts command items start/complete", () => {
    const start = extractCommandItem({
      type: "item.started",
      item: { id: "c1", type: "command_execution", command: "ls" },
    });
    assert.equal(start.phase, "started");
    assert.equal(start.command, "ls");

    const done = extractCommandItem({
      type: "item.completed",
      item: {
        id: "c1",
        type: "command_execution",
        command: "ls",
        aggregated_output: "a\\nb",
        exit_code: 1,
      },
    });
    assert.equal(done.phase, "completed");
    assert.equal(done.exitCode, 1);
    assert.match(done.output, /a/);
  });

  it("extracts usage from turn.completed", () => {
    const u = extractUsage({
      type: "turn.completed",
      usage: { input_tokens: 5, output_tokens: 7 },
    });
    assert.equal(u.inputTokens, 5);
    assert.equal(u.outputTokens, 7);
  });

  it("ignores unknown event types", () => {
    assert.equal(extractAgentMessageText({ type: "mystery", foo: 1 }), null);
    assert.equal(extractCommandItem({ type: "mystery" }), null);
    assert.equal(extractLiveItem({ type: "mystery" }), null);
  });

  it("extracts reasoning / file_change / mcp / web_search / todo_list as live items", () => {
    const reason = extractLiveItem({
      type: "item.started",
      item: { id: "r1", type: "reasoning", text: "looking around" },
    });
    assert.equal(reason.kind, "reasoning");
    assert.equal(reason.phase, "started");
    assert.equal(reason.text, "looking around");

    const edit = extractLiveItem({
      type: "item.started",
      item: {
        id: "f1",
        type: "file_change",
        changes: [{ path: "src/foo.ts", kind: "update" }],
      },
    });
    assert.equal(edit.kind, "file_change");
    assert.equal(edit.phase, "started");
    assert.equal(edit.changes[0].path, "src/foo.ts");

    const mcp = extractLiveItem({
      type: "item.started",
      item: {
        id: "m1",
        type: "mcp_tool_call",
        server: "github",
        tool: "get_issue",
        arguments: { number: 171 },
        status: "in_progress",
      },
    });
    assert.equal(mcp.kind, "mcp_tool_call");
    assert.equal(mcp.tool, "get_issue");
    assert.equal(mcp.server, "github");

    const search = extractLiveItem({
      type: "item.started",
      item: { id: "s1", type: "web_search", query: "codex exec json" },
    });
    assert.equal(search.kind, "web_search");
    assert.equal(search.query, "codex exec json");

    const todos = extractLiveItem({
      type: "item.updated",
      item: {
        id: "t1",
        type: "todo_list",
        items: [
          { text: "patch foo", completed: false },
          { text: "run tests", completed: true },
        ],
      },
    });
    assert.equal(todos.kind, "todo_list");
    assert.equal(todos.phase, "updated");
    assert.equal(todos.todos[1].status, "completed");

    assert.equal(
      extractLiveItem({
        type: "item.started",
        item: { id: "c1", type: "command_execution", command: "ls" },
      }),
      null,
      "command_execution stays on extractCommandItem",
    );
  });

  it("extracts official completed-only file_change and web_search (#171)", () => {
    const edit = extractLiveItem({
      type: "item.completed",
      item: {
        id: "f1",
        type: "file_change",
        changes: [{ path: "src/foo.ts", kind: "update" }],
        status: "completed",
      },
    });
    assert.equal(edit.kind, "file_change");
    assert.equal(edit.phase, "completed");
    assert.equal(edit.done, true);
    assert.equal(edit.name, "Edit");

    const search = extractLiveItem({
      type: "item.completed",
      item: { id: "s1", type: "web_search", query: "codex exec json" },
    });
    assert.equal(search.kind, "web_search");
    assert.equal(search.phase, "completed");
    assert.equal(search.done, true);
    assert.equal(search.name, "WebSearch");
    assert.equal(search.query, "codex exec json");
  });
});

describe("runner codex provider", () => {
  let tmpDir;
  let store;
  let runner;
  let pushes;
  let core;
  let prevSimulate;
  let prevAgentCmd;
  let prevCodexBin;
  let prevScenario;
  let prevArgvFile;
  let fakeCodex;
  let argvFile;

  let prevGrokMcpDisable;
  let prevGrokBin;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevCodexBin = process.env.CODER_CODEX_BIN;
    prevScenario = process.env.CODER_FAKE_CODEX_SCENARIO;
    prevArgvFile = process.env.CODER_FAKE_CODEX_ARGV_FILE;
    prevGrokMcpDisable = process.env.CODER_GROK_MCP_DISABLE;
    prevGrokBin = process.env.CODER_GROK_BIN;

    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    // Structural kill switch + fake bin: supervisor tests must never touch
    // ~/.grok/config.toml via real `grok mcp add -s user`.
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = "no-grok-not-a-real-binary";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-codex-"));
    fakeCodex = await writeFakeCodex(tmpDir);
    argvFile = path.join(tmpDir, "argv.json");
    process.env.CODER_CODEX_BIN = fakeCodex;
    process.env.CODER_FAKE_CODEX_ARGV_FILE = argvFile;

    store = new Store(path.join(tmpDir, "store.json"));
    pushes = [];
    core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: (channel, payload) => {
        pushes.push({ channel, payload });
      },
      tickMs: 15,
    });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Codex Thread",
    });
    services.setProvider(store, { threadId: thread.id, provider: "codex" });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    if (prevCodexBin === undefined) delete process.env.CODER_CODEX_BIN;
    else process.env.CODER_CODEX_BIN = prevCodexBin;
    if (prevScenario === undefined) delete process.env.CODER_FAKE_CODEX_SCENARIO;
    else process.env.CODER_FAKE_CODEX_SCENARIO = prevScenario;
    if (prevArgvFile === undefined) delete process.env.CODER_FAKE_CODEX_ARGV_FILE;
    else process.env.CODER_FAKE_CODEX_ARGV_FILE = prevArgvFile;
    if (prevGrokMcpDisable === undefined) delete process.env.CODER_GROK_MCP_DISABLE;
    else process.env.CODER_GROK_MCP_DISABLE = prevGrokMcpDisable;
    if (prevGrokBin === undefined) delete process.env.CODER_GROK_BIN;
    else process.env.CODER_GROK_BIN = prevGrokBin;
    require("../codexWorkspaceWrite.js").resetCodexGhAuthOkForTests();
  });

  it("Planboard GitHub origin allowlists github hosts under workspace-write (#848)", async () => {
    const { setCodexGhAuthOkForTests } = require("../codexWorkspaceWrite.js");
    setCodexGhAuthOkForTests(true);
    process.env.CODER_FAKE_CODEX_SCENARIO = "success";
    const repo = store.getProjects()[0].path;
    git(repo, ["remote", "add", "origin", "git@github.com:acme/demo.git"]);
    const thread = store.getThreads()[0];
    if (fs.existsSync(argvFile)) fs.unlinkSync(argvFile);
    await runner.startRun({ threadId: thread.id, prompt: "plan me" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const domains = argv.find((a) =>
      String(a).startsWith("features.network_proxy.domains="),
    );
    assert.ok(domains, `expected GitHub proxy allowlist, got ${JSON.stringify(argv)}`);
    assert.ok(
      argv.includes("features.network_proxy.enabled=true"),
      JSON.stringify(argv),
    );
    for (const host of ["api.github.com", "github.com", "uploads.github.com"]) {
      assert.ok(
        domains.includes(`"${host}" = "allow"`) ||
          domains.includes(`"${host}"="allow"`),
        `missing ${host} in ${domains}`,
      );
    }
    assert.ok(!domains.includes('"*"'), domains);
    const prompt = String(argv[argv.length - 1]);
    assert.match(prompt, /issue_create/);
    assert.doesNotMatch(prompt, /using `gh`/);
  });

  it("omits GitHub proxy flags when sandbox gh cannot authenticate (#848)", async () => {
    const { setCodexGhAuthOkForTests } = require("../codexWorkspaceWrite.js");
    setCodexGhAuthOkForTests(false);
    process.env.CODER_FAKE_CODEX_SCENARIO = "success";
    const repo = store.getProjects()[0].path;
    git(repo, ["remote", "add", "origin", "git@github.com:acme/demo.git"]);
    const thread = store.getThreads()[0];
    if (fs.existsSync(argvFile)) fs.unlinkSync(argvFile);
    await runner.startRun({ threadId: thread.id, prompt: "plan me" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(
      !argv.some((a) => String(a).startsWith("features.network_proxy.domains=")),
      `fail-closed: no GitHub proxy when gh cannot auth, got ${JSON.stringify(argv)}`,
    );
    const prompt = String(argv[argv.length - 1]);
    assert.doesNotMatch(prompt, /using `gh`/);
  });

  it("full lifecycle: sessionId, assistant, tool Command, usage, done", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "success";
    const thread = store.getThreads()[0];
    assert.equal(thread.provider, "codex");

    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "codex please",
    });

    await waitFor(() => store.getThread(thread.id).status === "done");

    const updated = store.getThread(thread.id);
    assert.equal(updated.sessionId, "codex-sess-001");
    assert.equal(updated.status, "done");

    const msgs = store.getMessages(thread.id);
    const assistants = msgs.filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].text, "Hello from codex");
    assert.equal(assistants[0].runId, runId);

    const tools = msgs.filter((m) => m.role === "tool");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool.name, "Command");
    assert.match(tools[0].tool.input, /echo hi/);
    assert.equal(tools[0].tool.done, true);
    assert.equal(tools[0].tool.isError, false);
    assert.match(tools[0].tool.output, /hi/);

    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 30);
    assert.equal(usage.outputTokens, 12);
    assert.equal(usage.costUsd, 0);
    assert.equal(usage.turns, 1);

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    // Shebang scripts include the script path as argv[0]; flags follow.
    const execIdx = argv.indexOf("exec");
    assert.ok(execIdx >= 0, `expected exec in ${JSON.stringify(argv)}`);
    assert.ok(argv.includes("--json"));
    assert.ok(argv.includes("--skip-git-repo-check"));
    const last = argv[argv.length - 1];
    assert.equal(
      typeof last,
      "string",
      `runner prompt must stay last: ${JSON.stringify(argv)}`,
    );
    assert.ok(
      last.includes("codex please"),
      `last argv token must contain the original prompt: ${JSON.stringify(argv)}`,
    );
    assert.ok(!argv.includes("resume"));
  });

  it("resume pass uses exec resume <sessionId>", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "success";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "first" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    assert.equal(store.getThread(thread.id).sessionId, "codex-sess-001");

    process.env.CODER_FAKE_CODEX_SCENARIO = "resume-turn";
    fs.unlinkSync(argvFile);

    await runner.startRun({ threadId: thread.id, prompt: "second" });
    await waitFor(() => {
      const msgs = store.getMessages(thread.id);
      return msgs.filter((m) => m.role === "assistant").length >= 2;
    });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const execIdx = argv.indexOf("exec");
    assert.ok(execIdx >= 0, `expected exec in ${JSON.stringify(argv)}`);
    assert.equal(argv[execIdx + 1], "resume");
    assert.equal(argv[execIdx + 2], "codex-sess-001");
    assert.ok(argv.includes("--json"));
    assert.ok(
      !argv.includes("--sandbox"),
      "codex exec resume rejects --sandbox (issue #795)",
    );
    const last = argv[argv.length - 1];
    assert.equal(
      typeof last,
      "string",
      `runner prompt must stay last after resume: ${JSON.stringify(argv)}`,
    );
    assert.ok(
      last.includes("second"),
      `last argv token must contain the original prompt: ${JSON.stringify(argv)}`,
    );
  });

  it("isolates CODEX_HOME and bypasses hook trust for classifyTool (#813)", async () => {
    runner.stopAll();
    runner = createRunner({
      store,
      core,
      pushFn: (channel, payload) => {
        pushes.push({ channel, payload });
      },
      tickMs: 15,
      userDataPath: tmpDir,
    });
    process.env.CODER_FAKE_CODEX_SCENARIO = "success";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "guard me" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(
      argv.includes("--dangerously-bypass-hook-trust"),
      JSON.stringify(argv),
    );
    assert.ok(argv.includes("features.hooks=true"), JSON.stringify(argv));
    assert.match(String(argv[argv.length - 1]), /guard me/);

    const dest = path.join(tmpDir, "codex-homes", thread.id);
    assert.ok(fs.existsSync(path.join(dest, "hooks.json")));
    const env = JSON.parse(fs.readFileSync(argvFile + ".env.json", "utf8"));
    assert.equal(env.CODEX_HOME, dest);
  });

  it("nonzero exit without stream sets failed + stderr", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "fail-exit";
    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "boom",
    });
    await waitFor(() => store.getThread(thread.id).status === "failed");
    assert.ok(
      store
        .getMessages(thread.id)
        .some(
          (m) =>
            m.role === "event" &&
            /Run error/i.test(m.text) &&
            /codex-stderr-boom/i.test(m.text) &&
            m.runId === runId,
        ),
    );
  });

  it("classifies stdout-only turn.failed overflow and publishes normalized failure", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "structured-overflow";
    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "overflow",
    });

    await waitFor(() => store.getThread(thread.id).status === "failed");

    const failed = store.getThread(thread.id);
    assert.equal(failed.lastErrorKind, "context-overflow");
    assert.equal(failed.quotaWaitUntil, null);
    assert.match(failed.lastError, /^Context window is full\./);

    const events = store
      .getMessages(thread.id)
      .filter((m) => m.role === "event" && m.runId === runId);
    assert.equal(events.length, 1);
    assert.match(events[0].text, /^Context window is full\./);
    assert.match(events[0].text, /context_length_exceeded/);
    assert.match(events[0].text, /ran out of room/);
    assert.doesNotMatch(events[0].text, /Quota wait:/);

    const published = pushes
      .filter((p) => p.channel === "threads:changed")
      .flatMap((p) => p.payload)
      .filter((t) => t.id === thread.id && t.status === "failed")
      .at(-1);
    assert.ok(published);
    assert.equal(published.lastErrorKind, "context-overflow");
    assert.equal(published.lastError, failed.lastError);
  });

  it("adds -c mcp_servers.coder-memory.url override only when memory is healthy", async () => {
    const {
      resetMemorySupForTests,
      createMemorySupervisor,
      getCodexMcpArgs,
    } = require("../memory-sup.js");
    const http = require("node:http");

    resetMemorySupForTests();
    process.env.CODER_FAKE_CODEX_SCENARIO = "success";
    if (fs.existsSync(argvFile)) fs.unlinkSync(argvFile);

    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "no-mem" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    let argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(!argv.some((a) => String(a).includes("mcp_servers.coder-memory")));
    assert.equal(getCodexMcpArgs().length, 0);

    const memDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-codex-mem-"));
    const freePort = await new Promise((resolve, reject) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => {
        const { port } = s.address();
        s.close((err) => (err ? reject(err) : resolve(port)));
      });
      s.on("error", reject);
    });
    const token = "codex-mcp-token";
    fs.writeFileSync(
      path.join(memDir, "memory-server.json"),
      JSON.stringify({
        port: freePort,
        token,
        dbPath: path.join(memDir, "db"),
      }),
      "utf8",
    );
    // Keep kimi config writes out of home during this test.
    const prevKimiMcp = process.env.CODER_KIMI_MCP_PATH;
    process.env.CODER_KIMI_MCP_PATH = path.join(memDir, "kimi-mcp.json");

    const crypto = require("node:crypto");
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/health") {
        const body = { ok: true };
        const nonce = url.searchParams.get("nonce");
        if (nonce) {
          body.proof = crypto
            .createHmac("sha256", token)
            .update(nonce)
            .digest("hex");
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => server.listen(freePort, "127.0.0.1", r));
    try {
      const sup = createMemorySupervisor({
        userDataPath: memDir,
        appPath: memDir,
        log: () => {},
        env: {
          ...process.env,
          // Defense in depth: never run real `grok mcp add` during tests
          // (-s user writes ~/.grok/config.toml with no path override).
          CODER_GROK_MCP_DISABLE: "1",
          CODER_GROK_BIN: path.join(memDir, "no-grok-not-a-real-binary"),
          CODER_KIMI_BIN: path.join(memDir, "no-kimi"),
        },
      });
      await sup.start();
      assert.equal(sup.getStatus().running, true);
      const mcpArgs = getCodexMcpArgs();
      assert.equal(mcpArgs[0], "-c");
      assert.equal(
        mcpArgs[1],
        `mcp_servers.coder-memory.url="http://127.0.0.1:${freePort}/mcp"`,
      );
      assert.equal(
        mcpArgs[3],
        'mcp_servers.coder-memory.bearer_token_env_var="CODER_MCP_TOKEN_CODER_MEMORY"',
      );
      assert.ok(
        mcpArgs.includes(
          'mcp_servers.coder-memory.default_tools_approval_mode="approve"',
        ),
        `expected first-party auto-approve (#846), got ${JSON.stringify(mcpArgs)}`,
      );

      const project = store.getProjects()[0];
      const t2 = services.createThread(store, {
        projectId: project.id,
        title: "Codex Mem",
      });
      services.setProvider(store, { threadId: t2.id, provider: "codex" });
      fs.unlinkSync(argvFile);
      await runner.startRun({ threadId: t2.id, prompt: "with-mem" });
      await waitFor(() => store.getThread(t2.id).status === "done");
      argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
      const cwd = t2.worktreePath || project.path;
      const boundUrl = `mcp_servers.coder-memory.url="http://127.0.0.1:${freePort}/mcp?project=${encodeURIComponent(cwd)}"`;
      assertCodexMcpOnExec(argv, {
        url: boundUrl,
        resume: false,
      });
      // The token reaches codex by env only: argv is visible to every local
      // process via `ps` for the whole run (issue #125).
      assert.ok(
        !argv.some((a) => String(a).includes(token)),
        `token leaked into argv: ${JSON.stringify(argv)}`,
      );
      const spawnedEnv = JSON.parse(
        fs.readFileSync(argvFile + ".env.json", "utf8"),
      );
      assert.equal(spawnedEnv.CODER_MCP_TOKEN_CODER_MEMORY, token);

      // Resume is the live miss: global `codex -c` before exec is dropped
      // by `exec resume`, so thread_send dies under approval_policy=never.
      const sessionId = store.getThread(t2.id).sessionId;
      assert.ok(sessionId, "first turn must capture a session to resume");
      const assistantsBefore = store
        .getMessages(t2.id)
        .filter((m) => m.role === "assistant").length;
      fs.unlinkSync(argvFile);
      await runner.startRun({ threadId: t2.id, prompt: "resume-mem" });
      await waitFor(
        () =>
          store.getMessages(t2.id).filter((m) => m.role === "assistant")
            .length > assistantsBefore,
      );
      await waitFor(() => store.getThread(t2.id).status === "done");
      argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
      assertCodexMcpOnExec(argv, { url: boundUrl, resume: sessionId });
      assert.ok(
        argv[argv.length - 1].includes("resume-mem"),
        `prompt must stay last: ${JSON.stringify(argv)}`,
      );
      sup.stop();
    } finally {
      await new Promise((r) => server.close(r));
      resetMemorySupForTests();
      if (prevKimiMcp === undefined) delete process.env.CODER_KIMI_MCP_PATH;
      else process.env.CODER_KIMI_MCP_PATH = prevKimiMcp;
      fs.rmSync(memDir, { recursive: true, force: true });
    }
  });

  it("surfaces reasoning before the first tool and does not duplicate on item.completed (#752)", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "thinking-then-tool";
    const thread = store.getThreads()[0];

    await runner.startRun({ threadId: thread.id, prompt: "patch foo" });

    await waitFor(() =>
      store
        .getMessages(thread.id)
        .some((m) => m.thinking && /foo\.ts/.test(m.text)),
    );
    assert.equal(
      store.getMessages(thread.id).filter((m) => m.role === "tool").length,
      0,
      "thinking must be visible before the later file_change",
    );

    await waitFor(
      () => store.getThread(thread.id).status === "done",
      { timeoutMs: 15000 },
    );

    const msgs = store.getMessages(thread.id);
    const thinking = msgs.filter((m) => m.thinking);
    assert.equal(
      thinking.length,
      1,
      "item.completed must not duplicate the thinking card",
    );
    assert.match(thinking[0].text, /foo\.ts/);
    assert.equal(thinking[0].role, "event");

    const tools = msgs.filter((m) => m.role === "tool");
    assert.equal(
      tools.length,
      1,
      "item.completed must not duplicate the file_change card",
    );
    assert.equal(tools[0].tool.name, "Edit");
    assert.equal(tools[0].tool.done, true);
    assert.match(tools[0].text, /foo\.ts/);
  });

  it("maps mcp / web_search / completed-only file_change onto tool cards and todo_list onto plan steps (#171)", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "dropped-items";
    const thread = store.getThreads()[0];

    await runner.startRun({ threadId: thread.id, prompt: "do the work" });

    let sawLivePlan = false;
    await waitFor(() => {
      const t = store.getThread(thread.id);
      if ((t.planSteps || []).length > 0 && t.status !== "done") {
        sawLivePlan = true;
      }
      return t.status === "done";
    });
    assert.equal(
      sawLivePlan,
      true,
      "todo_list must feed planSteps before the turn settles",
    );

    // Official TodoItem is { text, completed } only — no in_progress — so
    // incomplete steps stay "todo" until completed flips them to "done".
    assert.deepEqual(store.getThread(thread.id).planSteps, [
      { step: "Patch foo", status: "done" },
      { step: "Run tests", status: "done" },
    ]);

    const tools = store.getMessages(thread.id).filter((m) => m.role === "tool");
    const names = tools.map((m) => m.tool && m.tool.name);
    assert.deepEqual(names, ["Todo", "github/get_issue", "Edit", "WebSearch"]);
    assert.equal(
      tools.length,
      4,
      "item.completed of the same ids must not duplicate cards",
    );
    assert.ok(tools.every((m) => m.tool && m.tool.done === true));

    const mcp = tools.find((m) => m.tool.name === "github/get_issue");
    assert.match(mcp.tool.input, /171/);
    assert.match(String(mcp.tool.output), /open/);

    const edit = tools.find((m) => m.tool.name === "Edit");
    assert.match(edit.text, /foo\.ts/);

    const search = tools.find((m) => m.tool.name === "WebSearch");
    assert.match(search.text, /codex exec json/);
  });
});
