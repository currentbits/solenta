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
const { setupWorktree } = require("../worktrees.js");
const {
  extractSessionId,
  isSessionStartEvent,
  extractAgentMessageText,
  extractCommandItem,
  extractLiveItem,
  extractUsage,
} = require("../codex.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
}

function readRpc(rpcFile) {
  if (!rpcFile || !fs.existsSync(rpcFile)) return [];
  return fs
    .readFileSync(rpcFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function turnPrompt(rpc) {
  const start = rpc.find((m) => m.method === "turn/start");
  const input = start && start.params && start.params.input;
  if (!Array.isArray(input)) return "";
  return input
    .filter((p) => p && p.type === "text")
    .map((p) => String(p.text || ""))
    .join("\n");
}

/**
 * MCP `-c` must sit after `app-server` so resume still auto-approves
 * first-party servers (#846).
 * @param {string[]} argv
 * @param {{ url: string }} opts
 */
function assertCodexMcpOnAppServer(argv, opts) {
  const idx = argv.indexOf("app-server");
  assert.ok(idx >= 0, `expected app-server in ${JSON.stringify(argv)}`);
  const before = argv.slice(0, idx);
  for (let i = 0; i < before.length; i++) {
    if (before[i] === "-c") {
      assert.ok(
        !String(before[i + 1] || "").startsWith("mcp_servers."),
        `mcp -c must sit after app-server: ${JSON.stringify(argv)}`,
      );
    }
  }
  const after = argv.slice(idx);
  const values = [];
  for (let i = 0; i < after.length - 1; i++) {
    if (after[i] === "-c") values.push(after[i + 1]);
  }
  assert.ok(
    values.includes(opts.url),
    `missing bound MCP url after app-server: ${JSON.stringify(argv)}`,
  );
  assert.ok(
    values.includes(
      'mcp_servers.coder-memory.default_tools_approval_mode="approve"',
    ),
    `missing MCP auto-approve after app-server: ${JSON.stringify(argv)}`,
  );
}

/**
 * writable_roots lists realpath(git dir), TOML-quoted. A raw `includes`
 * misses both the doubled Windows backslashes and an 8.3-vs-long name.
 * @param {string[]} argv
 * @param {string} gitDir
 */
function assertWritableGitRoot(argv, gitDir) {
  let canonical = gitDir;
  try {
    canonical = fs.realpathSync(gitDir);
  } catch {
    canonical = path.resolve(gitDir);
  }
  const flag = argv.find((a) =>
    String(a).startsWith("sandbox_workspace_write.writable_roots="),
  );
  assert.ok(flag, `missing writable_roots in ${JSON.stringify(argv)}`);
  const quoted = `"${canonical.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  assert.ok(flag.includes(quoted), `missing ${quoted} in ${flag}`);
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
  const helper = require.resolve("./support/fakeCodexCli.js");
  return writeFakeBin(
    path.join(dir, "fake-codex"),
    `"use strict";
require(${JSON.stringify(helper)}).main();
`,
  );
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

    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const mcpImage = extractLiveItem({
      type: "item.completed",
      item: {
        id: "m-img",
        type: "mcp_tool_call",
        server: "shots",
        tool: "screenshot",
        status: "completed",
        result: [
          { type: "text", text: "captured" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: png },
          },
        ],
      },
    });
    assert.equal(mcpImage.kind, "mcp_tool_call");
    assert.equal(mcpImage.images.length, 1);
    assert.equal(mcpImage.images[0].mediaType, "image/png");
    assert.equal(mcpImage.images[0].data, png);
    assert.equal(mcpImage.output.includes(png), false);
    assert.match(mcpImage.output, /\[image\]/);

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
  let rpcFile;
  let prevRpcFile;

  let prevGrokMcpDisable;
  let prevGrokBin;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevCodexBin = process.env.CODER_CODEX_BIN;
    prevScenario = process.env.CODER_FAKE_CODEX_SCENARIO;
    prevArgvFile = process.env.CODER_FAKE_CODEX_ARGV_FILE;
    prevRpcFile = process.env.CODER_FAKE_CODEX_RPC_FILE;
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
    rpcFile = path.join(tmpDir, "rpc.jsonl");
    process.env.CODER_CODEX_BIN = fakeCodex;
    process.env.CODER_FAKE_CODEX_ARGV_FILE = argvFile;
    process.env.CODER_FAKE_CODEX_RPC_FILE = rpcFile;

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

  afterEach(async () => {
    if (runner) runner.stopAll();
    // stopAll has already taskkilled. Windows can still EBUSY the cwd
    // rmdir, and fs.rmSync maxRetries does not retry that first rmdir.
    await rmTree(tmpDir);
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
    if (prevRpcFile === undefined) delete process.env.CODER_FAKE_CODEX_RPC_FILE;
    else process.env.CODER_FAKE_CODEX_RPC_FILE = prevRpcFile;
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
    const prompt = turnPrompt(readRpc(rpcFile));
    assert.match(prompt, /issue_create/);
    assert.doesNotMatch(prompt, /using `gh`/);
  });

  it("workspace-write grants linked-worktree git metadata (#847)", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "success";
    const repo = store.getProjects()[0].path;
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);
    try {
      git(repo, ["checkout", "-b", "main"]);
    } catch {
      // already on main
    }

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

    const project = store.getProjects()[0];
    const t = services.createThread(store, {
      projectId: project.id,
      title: "WT Codex",
    });
    services.setProvider(store, { threadId: t.id, provider: "codex" });
    const setup = setupWorktree({
      store,
      threadId: t.id,
      worktreeBase: path.join(tmpDir, "worktrees"),
      broadcast: () => {},
    });
    if (fs.existsSync(argvFile)) fs.unlinkSync(argvFile);
    await runner.startRun({ threadId: t.id, prompt: "commit me" });
    await waitFor(() => store.getThread(t.id).status === "done");
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const gitDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-dir"],
      { cwd: setup.worktreePath, encoding: "utf8" },
    ).trim();
    assertWritableGitRoot(argv, gitDir);
  });

  it("workspace-write grants standalone .git metadata (#1160)", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "success";
    const repo = store.getProjects()[0].path;
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);
    if (fs.existsSync(argvFile)) fs.unlinkSync(argvFile);
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "commit me" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const gitDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-dir"],
      { cwd: repo, encoding: "utf8" },
    ).trim();
    assertWritableGitRoot(argv, gitDir);
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
    const prompt = turnPrompt(readRpc(rpcFile));
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
    assert.ok(
      argv.includes("app-server"),
      `expected app-server in ${JSON.stringify(argv)}`,
    );
    assert.ok(
      argv.includes("stdio://"),
      `expected stdio listen in ${JSON.stringify(argv)}`,
    );
    assert.ok(!argv.includes("exec"));
    const rpc = readRpc(rpcFile);
    assert.ok(rpc.some((m) => m.method === "thread/start"));
    assert.equal(
      rpc.some((m) => m.method === "thread/resume"),
      false,
    );
    assert.match(turnPrompt(rpc), /codex please/);
  });

  it("resume pass uses thread/resume of the stored session id", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "success";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "first" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    assert.equal(store.getThread(thread.id).sessionId, "codex-sess-001");

    process.env.CODER_FAKE_CODEX_SCENARIO = "resume-turn";
    fs.unlinkSync(argvFile);
    if (fs.existsSync(rpcFile)) fs.unlinkSync(rpcFile);

    await runner.startRun({ threadId: thread.id, prompt: "second" });
    await waitFor(() => {
      const msgs = store.getMessages(thread.id);
      return msgs.filter((m) => m.role === "assistant").length >= 2;
    });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(
      argv.includes("app-server"),
      `expected app-server in ${JSON.stringify(argv)}`,
    );
    assert.ok(
      !argv.includes("--sandbox"),
      "resume must not pass --sandbox (issue #795)",
    );
    assert.ok(
      argv.some((a) =>
        String(a).startsWith("sandbox_workspace_write.writable_roots="),
      ),
      `resume must still pass writable_roots (#1160): ${JSON.stringify(argv)}`,
    );
    const rpc = readRpc(rpcFile);
    const resume = rpc.find((m) => m.method === "thread/resume");
    assert.ok(resume, `expected thread/resume, got ${JSON.stringify(rpc)}`);
    assert.equal(resume.params.threadId, "codex-sess-001");
    assert.equal(resume.params.excludeTurns, true);
    assert.equal(
      rpc.some((m) => m.method === "thread/start"),
      false,
    );
    assert.match(turnPrompt(rpc), /second/);
  });

  it("isolates CODEX_HOME and persists overlay hook trust without the exec-only flag (#1311)", async () => {
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
    // Live Codex 0.153.4 `app-server` rejects this exec-only flag (exit 2).
    assert.equal(
      argv.includes("--dangerously-bypass-hook-trust"),
      false,
      JSON.stringify(argv),
    );
    assert.ok(argv.includes("app-server"), JSON.stringify(argv));
    assert.ok(argv.includes("features.hooks=true"), JSON.stringify(argv));
    assert.match(turnPrompt(readRpc(rpcFile)), /guard me/);

    const dest = path.join(tmpDir, "codex-homes", thread.id);
    assert.ok(fs.existsSync(path.join(dest, "hooks.json")));
    const cfg = fs.readFileSync(path.join(dest, "config.toml"), "utf8");
    assert.match(cfg, /trusted_hash = "sha256:[0-9a-f]{64}"/);
    assert.match(cfg, /hooks\.json:pre_tool_use:0:0/);
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
    assert.equal(store.getThread(thread.id).lastErrorKind, null);
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

  it("classifies writer-lock, keeps sessionId, and later resumes the same id (#953)", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "writer-lock";
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, { sessionId: "codex-sess-001" });

    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "resume while locked",
    });
    await waitFor(() => store.getThread(thread.id).status === "failed");

    const failed = store.getThread(thread.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastErrorKind, "writer-lock");
    assert.equal(failed.sessionId, "codex-sess-001");
    assert.match(failed.lastError, /^Codex session is locked by another process\./);

    const events = store
      .getMessages(thread.id)
      .filter((m) => m.role === "event" && m.runId === runId);
    assert.equal(events.length, 1);
    assert.match(events[0].text, /^Codex session is locked by another process\./);
    assert.match(events[0].text, /Provider error:/);
    assert.match(events[0].text, /thread-store conflict/);
    assert.doesNotMatch(events[0].text, /^ERROR codex_core::session/);
    assert.doesNotMatch(events[0].text, /thread\/resume failed/);

    process.env.CODER_FAKE_CODEX_SCENARIO = "resume-turn";
    if (fs.existsSync(argvFile)) fs.unlinkSync(argvFile);

    await runner.startRun({
      threadId: thread.id,
      prompt: "after lock released",
    });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const done = store.getThread(thread.id);
    assert.equal(done.status, "done");
    assert.equal(done.sessionId, "codex-sess-001");
    assert.equal(done.lastErrorKind, null);

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(
      argv.includes("app-server"),
      `expected app-server in ${JSON.stringify(argv)}`,
    );
    const rpc = readRpc(rpcFile);
    const resume = rpc.find((m) => m.method === "thread/resume");
    assert.ok(resume);
    assert.equal(resume.params.threadId, "codex-sess-001");
  });

  it("records lock-holder diagnosis and kills a leftover Solenta child (#1226)", async () => {
    const killed = [];
    runner.stopAll();
    runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 15,
      userDataPath: tmpDir,
      inspectCodexWriterLockFn: () => ({
        holderPid: 4242,
        holderCommand: "codex",
        ours: true,
        stale: false,
        lockDirShared: true,
        lockPath: "/tmp/overlay/thread-writer-locks/codex-sess-001.lock",
        codexHome: "/tmp/overlay",
      }),
      killWriterLockPidFn: (pid) => killed.push(pid),
    });
    process.env.CODER_FAKE_CODEX_SCENARIO = "writer-lock";
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, { sessionId: "codex-sess-001" });
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "resume while locked",
    });
    await waitFor(() => store.getThread(thread.id).status === "failed");
    assert.deepEqual(killed, [4242]);
    const failed = store.getThread(thread.id);
    assert.equal(failed.lastErrorKind, "writer-lock");
    assert.equal(failed.sessionId, "codex-sess-001");
    const events = store
      .getMessages(thread.id)
      .filter((m) => m.role === "event" && m.runId === runId);
    assert.match(events[0].text, /pid 4242/);
    assert.match(events[0].text, /Solenta Codex child/);
    assert.match(events[0].text, /CODEX_HOME=\/tmp\/overlay/);
    assert.match(events[0].text, /symlink/);
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
      // Same bind as boundSolentaMcpUrl: URL.searchParams encodes `~`
      // (Windows 8.3 temps) as %7E. encodeURIComponent leaves it raw.
      const bound = new URL(`http://127.0.0.1:${freePort}/mcp`);
      bound.searchParams.set("project", cwd);
      const boundUrl = `mcp_servers.coder-memory.url="${bound.toString()}"`;
      assertCodexMcpOnAppServer(argv, {
        url: boundUrl,
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
      if (fs.existsSync(rpcFile)) fs.unlinkSync(rpcFile);
      await runner.startRun({ threadId: t2.id, prompt: "resume-mem" });
      await waitFor(
        () =>
          store.getMessages(t2.id).filter((m) => m.role === "assistant")
            .length > assistantsBefore,
      );
      await waitFor(() => store.getThread(t2.id).status === "done");
      argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
      assertCodexMcpOnAppServer(argv, { url: boundUrl });
      const rpc = readRpc(rpcFile);
      const resume = rpc.find((m) => m.method === "thread/resume");
      assert.ok(resume);
      assert.equal(resume.params.threadId, sessionId);
      assert.match(turnPrompt(rpc), /resume-mem/);
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

  it("steerRun writes turn/steer on the same runId (#1170)", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "steer-wait";
    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "work",
    });
    await waitFor(() => runner.isRunning(thread.id));
    await waitFor(() => {
      const rpc = readRpc(rpcFile);
      return rpc.some((m) => m.method === "turn/start");
    });
    const steered = await runner.steerRun({
      threadId: thread.id,
      prompt: "nudge mid-turn",
    });
    assert.equal(steered.runId, runId);
    const steerRow = store.getMessages(thread.id).find((m) => m.steer === true);
    assert.ok(steerRow);
    assert.equal(steerRow.runId, runId);
    assert.equal(steerRow.text, "nudge mid-turn");
    await waitFor(() => store.getThread(thread.id).status === "done");
    const rpc = readRpc(rpcFile);
    const steer = rpc.find((m) => m.method === "turn/steer");
    assert.ok(steer);
    assert.equal(steer.params.expectedTurnId, "turn-1");
    assert.equal(
      rpc.filter((m) => m.method === "thread/start" || m.method === "thread/resume")
        .length,
      1,
    );
  });

  it("steerRun before turn/start returns no steer row", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "hang";
    process.env.CODER_FAKE_CODEX_TURN_DELAY_MS = "400";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "work" });
    await waitFor(() => runner.isRunning(thread.id));
    await assert.rejects(
      () => runner.steerRun({ threadId: thread.id, prompt: "too soon" }),
      /not accepting input/i,
    );
    assert.equal(
      store.getMessages(thread.id).some((m) => m.steer === true),
      false,
    );
    delete process.env.CODER_FAKE_CODEX_TURN_DELAY_MS;
  });

  it("passes image attachments as localImage input, not argv -i (#176)", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "success";
    const thread = store.getThreads()[0];
    services.setProvider(store, { threadId: thread.id, model: "gpt-6-astra" });
    const image = path.join(tmpDir, "shot.png");
    const folder = path.join(tmpDir, "specs");
    const notes = path.join(tmpDir, "notes.txt");
    fs.writeFileSync(image, "x");
    fs.writeFileSync(notes, "hello");
    fs.mkdirSync(folder);
    if (fs.existsSync(argvFile)) fs.unlinkSync(argvFile);

    await runner.startRun({
      threadId: thread.id,
      prompt: "look at these",
      attachments: [
        { kind: "image", path: image, name: "shot.png" },
        { kind: "folder", path: folder, name: "specs" },
        { kind: "file", path: notes, name: "notes.txt" },
      ],
    });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(
      argv.includes("app-server"),
      `expected app-server in ${JSON.stringify(argv)}`,
    );
    assert.ok(
      !argv.includes("-i"),
      `images are UserInput, not -i: ${JSON.stringify(argv)}`,
    );
    const rpc = readRpc(rpcFile);
    const start = rpc.find((m) => m.method === "turn/start");
    assert.ok(start);
    const input = start.params.input;
    assert.ok(input.some((p) => p.type === "text" && /look at these/.test(p.text)));
    assert.ok(input.some((p) => p.type === "localImage" && p.path === image));
    const text = turnPrompt(rpc);
    assert.ok(
      !text.includes(image),
      "vision models must not stuff the image path into the prompt",
    );
    assert.ok(text.includes(`- Folder: ${folder}`));
    assert.ok(text.includes(`- File: ${notes}`));
    assert.ok(
      !argv.some((a) => String(a).includes("CODER_MCP_TOKEN")),
      `token leaked into argv: ${JSON.stringify(argv)}`,
    );

    const userMsg = store
      .getMessages(thread.id)
      .find((m) => m.role === "user");
    assert.equal(userMsg.text, "look at these");
    assert.deepEqual(userMsg.attachments, [
      { kind: "image", path: image, name: "shot.png" },
      { kind: "folder", path: folder, name: "specs" },
      { kind: "file", path: notes, name: "notes.txt" },
    ]);
  });

  it("Spark stays text-only: no -i, image path stays in the prompt (#176 / #1167)", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "success";
    const thread = store.getThreads()[0];
    services.setProvider(store, {
      threadId: thread.id,
      model: "gpt-5.3-codex-spark",
    });
    const image = path.join(tmpDir, "spark.png");
    fs.writeFileSync(image, "x");
    if (fs.existsSync(argvFile)) fs.unlinkSync(argvFile);

    await runner.startRun({
      threadId: thread.id,
      prompt: "what is this",
      attachments: [{ kind: "image", path: image, name: "spark.png" }],
    });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(
      !argv.includes("-i"),
      `Spark must not get -i: ${JSON.stringify(argv)}`,
    );
    const rpc = readRpc(rpcFile);
    const start = rpc.find((m) => m.method === "turn/start");
    assert.ok(start);
    assert.equal(
      start.params.input.some((p) => p.type === "localImage"),
      false,
      "Spark must not send localImage",
    );
    const last = turnPrompt(rpc);
    assert.ok(last.includes("what is this"));
    assert.ok(
      last.includes(`- Image: ${image}`),
      "text-only Spark still lists the image as a prompt path",
    );
    assert.ok(
      !argv.some((a) => String(a).includes("CODER_MCP_TOKEN")),
      `token leaked into argv: ${JSON.stringify(argv)}`,
    );
  });
});
