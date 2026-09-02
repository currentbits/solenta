"use strict";

/**
 * Issue #815: a failed workflow agent gets one bounded retry on the same
 * slot. The second spawn must emit the provider resume flag when a real
 * session id was captured. A second failure still fails the phase. Never
 * write thread.sessionId. Never mint a sibling agent. Kimi retry emits
 * `-S` when a real session id was captured, never `-c`, and reuses the
 * same overlayKey (issue #782).
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

const { spawnPhaseAgent } = require("../workflow.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
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

function readHits(file) {
  assert.ok(fs.existsSync(file), `expected hits file ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeDumpingBin(dir, name, envKey, body) {
  const argvFile = path.join(dir, `${name}-argv.json`);
  const fake = writeFakeBin(
    path.join(dir, `fake-${name}`),
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
if (process.env.${envKey}) {
  fs.writeFileSync(process.env.${envKey}, JSON.stringify(process.argv.slice(1)), "utf8");
}
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
${body}
`,
  );
  return { fake, argvFile };
}

function writeRetryBin(dir, name, hitsEnv, body) {
  const hitsFile = path.join(dir, `${name}-hits.json`);
  const fake = writeFakeBin(
    path.join(dir, `fake-${name}-retry`),
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function appendHit(row) {
  const file = process.env.${hitsEnv};
  let prev = [];
  try { if (file && fs.existsSync(file)) prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch { prev = []; }
  if (!Array.isArray(prev)) prev = [];
  prev.push(row);
  fs.writeFileSync(file, JSON.stringify(prev), "utf8");
  return prev;
}
${body}
`,
  );
  return { fake, hitsFile };
}

function lastWorkflowPush(pushes) {
  return [...pushes]
    .reverse()
    .find((p) => p.channel === "thread:updated" && p.payload && p.payload.workflow);
}

describe("workflow phase resume flags (#808 / #815)", () => {
  let tmpDir;
  let prev;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wf-retry-"));
    prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_AGENT_CMD: process.env.CODER_AGENT_CMD,
      CODER_CLAUDE_BIN: process.env.CODER_CLAUDE_BIN,
      CODER_CODEX_BIN: process.env.CODER_CODEX_BIN,
      CODER_OPENCODE_BIN: process.env.CODER_OPENCODE_BIN,
      CODER_CURSOR_BIN: process.env.CODER_CURSOR_BIN,
      CODER_GROK_BIN: process.env.CODER_GROK_BIN,
      CODER_FAKE_CLAUDE_ARGV_FILE: process.env.CODER_FAKE_CLAUDE_ARGV_FILE,
      CODER_FAKE_CODEX_ARGV_FILE: process.env.CODER_FAKE_CODEX_ARGV_FILE,
      CODER_FAKE_OPENCODE_ARGV_FILE: process.env.CODER_FAKE_OPENCODE_ARGV_FILE,
      CODER_FAKE_CURSOR_ARGV_FILE: process.env.CODER_FAKE_CURSOR_ARGV_FILE,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
    };
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = "no-grok";
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function installClaude() {
    const { fake, argvFile } = writeDumpingBin(
      tmpDir,
      "claude",
      "CODER_FAKE_CLAUDE_ARGV_FILE",
      `emit({ type: "system", subtype: "init", session_id: "wf-retry-claude" });
emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
emit({ type: "result", subtype: "success", session_id: "wf-retry-claude", usage: { input_tokens: 1, output_tokens: 1 } });`,
    );
    process.env.CODER_CLAUDE_BIN = fake;
    process.env.CODER_FAKE_CLAUDE_ARGV_FILE = argvFile;
    return argvFile;
  }

  function installCodex() {
    const { fake, argvFile } = writeDumpingBin(
      tmpDir,
      "codex",
      "CODER_FAKE_CODEX_ARGV_FILE",
      `emit({ type: "thread.started", thread_id: "wf-retry-codex" });
emit({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "ok" } });
emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });`,
    );
    process.env.CODER_CODEX_BIN = fake;
    process.env.CODER_FAKE_CODEX_ARGV_FILE = argvFile;
    return argvFile;
  }

  function installOpencode() {
    const { fake, argvFile } = writeDumpingBin(
      tmpDir,
      "opencode",
      "CODER_FAKE_OPENCODE_ARGV_FILE",
      `emit({ type: "step_start", sessionID: "ses_wf_retry" });
emit({ type: "text", sessionID: "ses_wf_retry", part: { id: "p1", text: "ok" } });`,
    );
    process.env.CODER_OPENCODE_BIN = fake;
    process.env.CODER_FAKE_OPENCODE_ARGV_FILE = argvFile;
    return argvFile;
  }

  function installCursor() {
    const { fake, argvFile } = writeDumpingBin(
      tmpDir,
      "cursor",
      "CODER_FAKE_CURSOR_ARGV_FILE",
      `emit({ type: "system", subtype: "init", session_id: "wf-retry-cursor" });
emit({ type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text: "ok" }] }, session_id: "wf-retry-cursor" });
emit({ type: "result", session_id: "wf-retry-cursor" });`,
    );
    process.env.CODER_CURSOR_BIN = fake;
    process.env.CODER_FAKE_CURSOR_ARGV_FILE = argvFile;
    return argvFile;
  }

  function readArgv(argvFile) {
    assert.ok(fs.existsSync(argvFile), `fake must dump argv ${argvFile}`);
    return JSON.parse(fs.readFileSync(argvFile, "utf8"));
  }

  it("spawnPhaseAgent Claude emits --resume only for a real session id", async () => {
    const argvFile = installClaude();
    const cwd = path.join(tmpDir, "proj");
    fs.mkdirSync(cwd);
    const { done } = spawnPhaseAgent({
      providerId: "claude",
      prompt: "phase work",
      cwd,
      sessionId: "sess-claude-1",
    });
    const result = await done;
    assert.equal(result.ok, true, result.stderr);
    const argv = readArgv(argvFile);
    const at = argv.indexOf("--resume");
    assert.ok(at >= 0, `claude must --resume, got ${JSON.stringify(argv)}`);
    assert.equal(argv[at + 1], "sess-claude-1");
    assert.equal(result.sessionId, "wf-retry-claude");
  });

  it("spawnPhaseAgent Claude never resumes cwd or empty", async () => {
    const cwd = path.join(tmpDir, "proj");
    fs.mkdirSync(cwd);
    for (const sessionId of ["cwd", "", null]) {
      const argvFile = installClaude();
      const { done } = spawnPhaseAgent({
        providerId: "claude",
        prompt: "phase work",
        cwd,
        sessionId,
      });
      const result = await done;
      assert.equal(result.ok, true, result.stderr);
      const argv = readArgv(argvFile);
      assert.ok(
        !argv.includes("--resume"),
        `claude must not --resume for ${JSON.stringify(sessionId)}, got ${JSON.stringify(argv)}`,
      );
    }
  });

  it("spawnPhaseAgent Codex emits exec resume and omits --sandbox", async () => {
    const argvFile = installCodex();
    const cwd = path.join(tmpDir, "proj");
    fs.mkdirSync(cwd);
    const { done } = spawnPhaseAgent({
      providerId: "codex",
      prompt: "phase work",
      cwd,
      sessionId: "sess-codex-1",
    });
    const result = await done;
    assert.equal(result.ok, true, result.stderr);
    const argv = readArgv(argvFile);
    const execAt = argv.indexOf("exec");
    assert.ok(execAt >= 0, `codex argv ${JSON.stringify(argv)}`);
    assert.equal(argv[execAt + 1], "resume");
    assert.equal(argv[execAt + 2], "sess-codex-1");
    assert.ok(!argv.includes("--sandbox"), "exec resume must omit --sandbox (#795)");
    assert.equal(result.sessionId, "wf-retry-codex");
  });

  it("spawnPhaseAgent OpenCode emits -s for a real session id", async () => {
    const argvFile = installOpencode();
    const cwd = path.join(tmpDir, "proj");
    fs.mkdirSync(cwd);
    const { done } = spawnPhaseAgent({
      providerId: "opencode",
      prompt: "phase work",
      cwd,
      sessionId: "ses_real",
    });
    const result = await done;
    assert.equal(result.ok, true, result.stderr);
    const argv = readArgv(argvFile);
    const at = argv.indexOf("-s");
    assert.ok(at >= 0, `opencode must -s, got ${JSON.stringify(argv)}`);
    assert.equal(argv[at + 1], "ses_real");
    assert.equal(result.sessionId, "ses_wf_retry");
  });

  it("spawnPhaseAgent Cursor emits --resume for a real session id", async () => {
    const argvFile = installCursor();
    const cwd = path.join(tmpDir, "proj");
    fs.mkdirSync(cwd);
    const { done } = spawnPhaseAgent({
      providerId: "cursor",
      prompt: "phase work",
      cwd,
      sessionId: "sess-cursor-1",
    });
    const result = await done;
    assert.equal(result.ok, true, result.stderr);
    const argv = readArgv(argvFile);
    const at = argv.indexOf("--resume");
    assert.ok(at >= 0, `cursor must --resume, got ${JSON.stringify(argv)}`);
    assert.equal(argv[at + 1], "sess-cursor-1");
    assert.equal(result.sessionId, "wf-retry-cursor");
  });
});

describe("workflow phase bounded retry (#815)", () => {
  let tmpDir;
  let prev;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wf-retry-run-"));
    prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_AGENT_CMD: process.env.CODER_AGENT_CMD,
      CODER_CLAUDE_BIN: process.env.CODER_CLAUDE_BIN,
      CODER_CODEX_BIN: process.env.CODER_CODEX_BIN,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_GROK_BIN: process.env.CODER_GROK_BIN,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
      CODER_WF_RETRY_HITS: process.env.CODER_WF_RETRY_HITS,
      CODER_WF_RETRY_MODE: process.env.CODER_WF_RETRY_MODE,
      KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
    };
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    delete process.env.CODER_WF_RETRY_MODE;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = "no-grok";
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function installClaudeRetry() {
    const { fake, hitsFile } = writeRetryBin(
      tmpDir,
      "claude",
      "CODER_WF_RETRY_HITS",
      `
const argv = process.argv.slice(1);
const hits = appendHit({ provider: "claude", argv });
const resumeAt = argv.indexOf("--resume");
const resumed = resumeAt >= 0 ? argv[resumeAt + 1] : null;
emit({ type: "system", subtype: "init", session_id: "wf-retry-claude" });
if (process.env.CODER_WF_RETRY_MODE === "always-fail" || !resumed) {
  process.stderr.write("transient-claude-boom\\n");
  process.exit(2);
}
emit({ type: "assistant", message: { content: [{ type: "text", text: "CLAUDE_RETRY_OK" }] } });
emit({
  type: "result",
  subtype: "success",
  result: "CLAUDE_RETRY_OK",
  session_id: "wf-retry-claude",
  usage: { input_tokens: 3, output_tokens: 4 },
  total_cost_usd: 0.001,
});
`,
    );
    process.env.CODER_CLAUDE_BIN = fake;
    process.env.CODER_WF_RETRY_HITS = hitsFile;
    return hitsFile;
  }

  function installCodexRetry() {
    const { fake, hitsFile } = writeRetryBin(
      tmpDir,
      "codex",
      "CODER_WF_RETRY_HITS",
      `
const argv = process.argv.slice(1);
appendHit({ provider: "codex", argv });
const execAt = argv.indexOf("exec");
const resumed = execAt >= 0 && argv[execAt + 1] === "resume" ? argv[execAt + 2] : null;
emit({ type: "thread.started", thread_id: "wf-retry-codex" });
if (process.env.CODER_WF_RETRY_MODE === "always-fail" || !resumed) {
  process.stderr.write("transient-codex-boom\\n");
  process.exit(2);
}
emit({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "CODEX_RETRY_OK" } });
emit({ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 3 } });
`,
    );
    process.env.CODER_CODEX_BIN = fake;
    process.env.CODER_WF_RETRY_HITS = hitsFile;
    return hitsFile;
  }

  function installKimiRetry() {
    const sourceHome = path.join(tmpDir, "user-kimi");
    fs.mkdirSync(sourceHome);
    fs.writeFileSync(
      path.join(sourceHome, "config.toml"),
      '[thinking]\nenabled = true\neffort = "high"\n',
    );
    fs.writeFileSync(
      path.join(sourceHome, "mcp.json"),
      JSON.stringify({ mcpServers: {} }),
    );
    const { fake, hitsFile } = writeRetryBin(
      tmpDir,
      "kimi",
      "CODER_WF_RETRY_HITS",
      `
const argv = process.argv.slice(1);
const hits = appendHit({
  provider: "kimi",
  argv,
  home: process.env.KIMI_CODE_HOME || "",
});
emit({ role: "meta", session_id: "wf-retry-kimi" });
if (process.env.CODER_WF_RETRY_MODE === "always-fail" || hits.length < 2) {
  process.stderr.write("transient-kimi-boom\\n");
  process.exit(2);
}
emit({ type: "text", text: "KIMI_RETRY_OK" });
emit({ type: "usage", input_tokens: 1, output_tokens: 1 });
`,
    );
    process.env.CODER_KIMI_BIN = fake;
    process.env.CODER_WF_RETRY_HITS = hitsFile;
    process.env.KIMI_CODE_HOME = sourceHome;
    return hitsFile;
  }

  async function startOnePhase(opts) {
    const {
      provider,
      hitsFile,
      prompt = "retry the phase",
    } = opts;
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    git(projectDir, ["init"]);
    git(projectDir, ["config", "user.email", "t@t.com"]);
    git(projectDir, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(projectDir, "README.md"), "hi\n");
    git(projectDir, ["add", "."]);
    git(projectDir, ["commit", "-m", "init"]);

    const store = new Store(path.join(tmpDir, "store.json"));
    const core = await loadCore();
    /** @type {{ channel: string, payload: object }[]} */
    const pushes = [];
    const runner = createRunner({
      store,
      core,
      pushFn(channel, payload) {
        pushes.push({ channel, payload });
      },
      tickMs: 15,
      userDataPath: tmpDir,
    });
    const project = await services.addProject(store, projectDir);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Phase retry",
    });
    services.setProvider(store, { threadId: thread.id, provider });
    const tmpl = services.saveTemplate(store, {
      name: `${provider} retry`,
      phases: [
        {
          name: "plan",
          agentCount: 1,
          instruction: "Do the phase once.",
          provider,
          model: null,
        },
      ],
    });
    const { runId } = await runner.startWorkflowRun({
      threadId: thread.id,
      prompt,
      templateId: tmpl.id,
    });
    await waitFor(() => {
      const t = store.getThread(thread.id);
      return t && (t.status === "done" || t.status === "failed");
    });
    return { store, runner, thread, runId, pushes, hitsFile };
  }

  it("retries a failed Claude slot once with --resume and does not write thread.sessionId", async () => {
    const hitsFile = installClaudeRetry();
    const { store, runner, thread, runId, pushes } = await startOnePhase({
      provider: "claude",
      hitsFile,
    });
    try {
      assert.equal(store.getThread(thread.id).status, "done");
      assert.equal(store.getThread(thread.id).sessionId, null);

      const hits = readHits(hitsFile);
      assert.equal(hits.length, 2, "exactly one retry");
      assert.ok(
        !hits[0].argv.includes("--resume"),
        `first spawn must be fresh, got ${JSON.stringify(hits[0].argv)}`,
      );
      const at = hits[1].argv.indexOf("--resume");
      assert.ok(at >= 0, `second spawn must --resume, got ${JSON.stringify(hits[1].argv)}`);
      assert.equal(hits[1].argv[at + 1], "wf-retry-claude");

      const push = lastWorkflowPush(pushes);
      assert.ok(push);
      const agents = push.payload.workflow.phases[0].agents;
      assert.equal(agents.length, 1, "no sibling agent");
      assert.equal(agents[0].status, "settled");
      assert.equal(agents[0].sessionId, "wf-retry-claude");

      const dossiers = store
        .getMessages(thread.id)
        .filter((m) => m.role === "tool" && m.runId === runId);
      assert.equal(dossiers.length, 1);
      assert.equal(dossiers[0].tool.isError, false);
    } finally {
      runner.stopAll();
    }
  });

  it("a second Claude failure still fails the phase", async () => {
    process.env.CODER_WF_RETRY_MODE = "always-fail";
    const hitsFile = installClaudeRetry();
    const { store, runner, thread, runId, pushes } = await startOnePhase({
      provider: "claude",
      hitsFile,
    });
    try {
      assert.equal(store.getThread(thread.id).status, "failed");
      assert.equal(store.getThread(thread.id).sessionId, null);

      const hits = readHits(hitsFile);
      assert.equal(hits.length, 2, "retry once, then stop");
      const at = hits[1].argv.indexOf("--resume");
      assert.ok(at >= 0, `second spawn must --resume, got ${JSON.stringify(hits[1].argv)}`);
      assert.equal(hits[1].argv[at + 1], "wf-retry-claude");

      const push = lastWorkflowPush(pushes);
      assert.ok(push);
      const agents = push.payload.workflow.phases[0].agents;
      assert.equal(agents.length, 1);
      assert.equal(agents[0].status, "failed");

      const dossiers = store
        .getMessages(thread.id)
        .filter((m) => m.role === "tool" && m.runId === runId);
      assert.equal(dossiers.length, 1);
      assert.equal(dossiers[0].tool.isError, true);
    } finally {
      runner.stopAll();
    }
  });

  it("retries a failed Codex slot with exec resume", async () => {
    const hitsFile = installCodexRetry();
    const { store, runner, thread } = await startOnePhase({
      provider: "codex",
      hitsFile,
    });
    try {
      assert.equal(store.getThread(thread.id).status, "done");
      assert.equal(store.getThread(thread.id).sessionId, null);
      const hits = readHits(hitsFile);
      assert.equal(hits.length, 2);
      assert.ok(!hits[0].argv.includes("resume"));
      const execAt = hits[1].argv.indexOf("exec");
      assert.equal(hits[1].argv[execAt + 1], "resume");
      assert.equal(hits[1].argv[execAt + 2], "wf-retry-codex");
      assert.ok(!hits[1].argv.includes("--sandbox"));
    } finally {
      runner.stopAll();
    }
  });

  it("retries kimi on the same overlay with -S and never -c or thread.sessionId (#782)", async () => {
    const hitsFile = installKimiRetry();
    const { store, runner, thread } = await startOnePhase({
      provider: "kimi",
      hitsFile,
    });
    try {
      assert.equal(store.getThread(thread.id).status, "done");
      assert.equal(store.getThread(thread.id).sessionId, null);
      const hits = readHits(hitsFile);
      assert.equal(hits.length, 2, "kimi slot retries once");
      assert.ok(hits[0].home, "first spawn must have an overlay home");
      assert.equal(hits[1].home, hits[0].home, "same overlayKey / KIMI_CODE_HOME");
      assert.ok(!hits[0].argv.includes("-S"), `fresh kimi must not -S: ${JSON.stringify(hits[0].argv)}`);
      const sIdx = hits[1].argv.indexOf("-S");
      assert.ok(sIdx >= 0, `retry must -S: ${JSON.stringify(hits[1].argv)}`);
      assert.equal(hits[1].argv[sIdx + 1], "wf-retry-kimi");
      for (const hit of hits) {
        assert.ok(!hit.argv.includes("-c"), `kimi must not -c, got ${JSON.stringify(hit.argv)}`);
      }
    } finally {
      runner.stopAll();
    }
  });
});
