"use strict";

/**
 * Workflow phases for claude/codex/opencode/cursor must forward
 * thread.reasoningEffort into provider buildArgs (issue #785).
 * Grok shares spawnAgentClaude, so it must emit --reasoning-effort too.
 * Kimi already does this (workflow-kimi.test.js) — do not change it.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

const { spawnPhaseAgent } = require("../workflow.js");
const { getProvider } = require("../providers.js");
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

function writeDumpingBin(dir, name, envKey, emits) {
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
${emits}
`,
  );
  return { fake, argvFile };
}

function readArgv(argvFile) {
  assert.ok(fs.existsSync(argvFile), `fake must write argv file ${argvFile}`);
  return JSON.parse(fs.readFileSync(argvFile, "utf8"));
}

function effortAt(argv, flag) {
  const at = argv.indexOf(flag);
  assert.ok(at >= 0, `must pass ${flag}, got ${JSON.stringify(argv)}`);
  return argv[at + 1];
}

describe("workflow phases forward reasoningEffort (#785)", () => {
  let tmpDir;
  let prev;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wf-effort-"));
    prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_AGENT_CMD: process.env.CODER_AGENT_CMD,
      CODER_CLAUDE_BIN: process.env.CODER_CLAUDE_BIN,
      CODER_CODEX_BIN: process.env.CODER_CODEX_BIN,
      CODER_OPENCODE_BIN: process.env.CODER_OPENCODE_BIN,
      CODER_CURSOR_BIN: process.env.CODER_CURSOR_BIN,
      CODER_GROK_BIN: process.env.CODER_GROK_BIN,
      CODER_FAKE_CLAUDE_ARGV_FILE: process.env.CODER_FAKE_CLAUDE_ARGV_FILE,
      CODER_FAKE_GROK_ARGV_FILE: process.env.CODER_FAKE_GROK_ARGV_FILE,
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
      `emit({ type: "system", subtype: "init", session_id: "wf-effort-claude" });
emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
emit({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } });`,
    );
    process.env.CODER_CLAUDE_BIN = fake;
    process.env.CODER_FAKE_CLAUDE_ARGV_FILE = argvFile;
    return argvFile;
  }

  function installGrok() {
    const { fake, argvFile } = writeDumpingBin(
      tmpDir,
      "grok",
      "CODER_FAKE_GROK_ARGV_FILE",
      `emit({ type: "system", subtype: "init", session_id: "wf-effort-grok" });
emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
emit({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } });`,
    );
    process.env.CODER_GROK_BIN = fake;
    process.env.CODER_FAKE_GROK_ARGV_FILE = argvFile;
    return argvFile;
  }

  function installCodex() {
    const { fake, argvFile } = writeDumpingBin(
      tmpDir,
      "codex",
      "CODER_FAKE_CODEX_ARGV_FILE",
      `emit({ type: "thread.started", thread_id: "wf-effort-codex" });
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
      `emit({ type: "text", timestamp: Date.now(), sessionID: "ses_wf", part: { id: "p1", text: "ok" } });`,
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
      `emit({ type: "system", subtype: "init", session_id: "wf-effort-cursor" });
emit({ type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text: "ok" }] } });`,
    );
    process.env.CODER_CURSOR_BIN = fake;
    process.env.CODER_FAKE_CURSOR_ARGV_FILE = argvFile;
    return argvFile;
  }

  async function runOnePhaseWorkflow({ provider, model, effort }) {
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
    const runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 15,
      userDataPath: tmpDir,
    });
    try {
      const project = await services.addProject(store, projectDir);
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "Effort Workflow",
      });
      services.setReasoningEffort(store, {
        threadId: thread.id,
        effort,
      });
      const tmpl = services.saveTemplate(store, {
        name: `${provider} effort`,
        phases: [
          {
            name: "plan",
            agentCount: 1,
            instruction: "Plan briefly.",
            provider,
            model,
          },
        ],
      });
      await runner.startWorkflowRun({
        threadId: thread.id,
        prompt: "phase task",
        templateId: tmpl.id,
      });
      await waitFor(() => {
        const t = store.getThread(thread.id);
        return t && (t.status === "done" || t.status === "failed");
      });
      assert.equal(store.getThread(thread.id).status, "done");
    } finally {
      runner.stopAll();
    }
  }

  it("spawnPhaseAgent passes --effort into claude argv", async () => {
    const argvFile = installClaude();
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    const { done } = spawnPhaseAgent({
      providerId: "claude",
      prompt: "phase work",
      cwd: projectDir,
      model: null,
      reasoningEffort: "xhigh",
    });
    const result = await done;
    assert.equal(result.ok, true, result.stderr);
    assert.equal(effortAt(readArgv(argvFile), "--effort"), "xhigh");
  });

  it("spawnPhaseAgent passes --reasoning-effort into grok argv", async () => {
    const argvFile = installGrok();
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    const { done } = spawnPhaseAgent({
      providerId: "grok",
      prompt: "PROMPT_WF_EFFORT_GROK",
      cwd: projectDir,
      model: "grok-4.6",
      reasoningEffort: "low",
    });
    const result = await done;
    assert.equal(result.ok, true, result.stderr);
    const argv = readArgv(argvFile);
    assert.equal(effortAt(argv, "--reasoning-effort"), "low");
    assert.equal(argv[argv.length - 1], "PROMPT_WF_EFFORT_GROK");
  });

  it("spawnPhaseAgent passes model_reasoning_effort into codex argv", async () => {
    const argvFile = installCodex();
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    const { done } = spawnPhaseAgent({
      providerId: "codex",
      prompt: "phase work",
      cwd: projectDir,
      model: null,
      reasoningEffort: "high",
    });
    const result = await done;
    assert.equal(result.ok, true, result.stderr);
    const argv = readArgv(argvFile);
    assert.ok(
      argv.includes("model_reasoning_effort=high"),
      `codex argv must include effort, got ${JSON.stringify(argv)}`,
    );
  });

  it("spawnPhaseAgent passes --variant into opencode argv", async () => {
    const argvFile = installOpencode();
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    const { done } = spawnPhaseAgent({
      providerId: "opencode",
      prompt: "phase work",
      cwd: projectDir,
      model: "opencode/ling-3.0-flash-fin-free",
      reasoningEffort: "high",
    });
    const result = await done;
    assert.equal(result.ok, true, result.stderr);
    assert.equal(effortAt(readArgv(argvFile), "--variant"), "high");
  });

  it("spawnPhaseAgent forwards reasoningEffort into cursor buildArgs", async () => {
    installCursor();
    const entry = getProvider("cursor");
    const orig = entry.buildArgs;
    /** @type {object | null} */
    let seen = null;
    entry.buildArgs = (opts) => {
      seen = opts;
      return orig.call(entry, opts);
    };
    try {
      const projectDir = path.join(tmpDir, "proj");
      fs.mkdirSync(projectDir);
      const { done } = spawnPhaseAgent({
        providerId: "cursor",
        prompt: "phase work",
        cwd: projectDir,
        model: null,
        reasoningEffort: "high",
      });
      const result = await done;
      assert.equal(result.ok, true, result.stderr);
      assert.equal(
        seen && seen.reasoningEffort,
        "high",
        "cursor buildArgs must receive thread effort even though the CLI bakes effort into the model id",
      );
    } finally {
      entry.buildArgs = orig;
    }
  });

  it("startWorkflowRun wires thread.reasoningEffort into claude phases", async () => {
    const argvFile = installClaude();
    await runOnePhaseWorkflow({
      provider: "claude",
      model: null,
      effort: "xhigh",
    });
    assert.equal(effortAt(readArgv(argvFile), "--effort"), "xhigh");
  });

  it("startWorkflowRun wires thread.reasoningEffort into codex phases", async () => {
    const argvFile = installCodex();
    await runOnePhaseWorkflow({
      provider: "codex",
      model: null,
      effort: "high",
    });
    const argv = readArgv(argvFile);
    assert.ok(
      argv.includes("model_reasoning_effort=high"),
      `workflow codex phase must see thread.reasoningEffort, got ${JSON.stringify(argv)}`,
    );
  });

  it("startWorkflowRun wires thread.reasoningEffort into opencode phases", async () => {
    const argvFile = installOpencode();
    await runOnePhaseWorkflow({
      provider: "opencode",
      model: "opencode/ling-3.0-flash-fin-free",
      effort: "high",
    });
    assert.equal(effortAt(readArgv(argvFile), "--variant"), "high");
  });

  it("startWorkflowRun wires thread.reasoningEffort into cursor phases", async () => {
    installCursor();
    const entry = getProvider("cursor");
    const orig = entry.buildArgs;
    /** @type {object | null} */
    let seen = null;
    entry.buildArgs = (opts) => {
      seen = opts;
      return orig.call(entry, opts);
    };
    try {
      await runOnePhaseWorkflow({
        provider: "cursor",
        model: null,
        effort: "high",
      });
      assert.equal(
        seen && seen.reasoningEffort,
        "high",
        "workflow cursor phase must receive thread.reasoningEffort",
      );
    } finally {
      entry.buildArgs = orig;
    }
  });
});
