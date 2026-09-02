"use strict";

/**
 * Issue #793: workflow Codex / OpenCode / Cursor phases must get
 * thread.permissionMode. startWorkflowRun already has the thread;
 * spawnPhaseAgent already destructures it; only spawnAgentClaude
 * used to pass it into buildArgs. The other three spawners dropped it,
 * so Codex always --sandbox workspace-write, OpenCode never --auto,
 * and Cursor always --force.
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

function writeDumpingCli(dir, name, envKey, emitBody) {
  const argvFile = path.join(dir, `${name}-argv.json`);
  const fake = writeFakeBin(
    path.join(dir, `fake-${name}`),
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
if (process.env.${envKey}) {
  fs.writeFileSync(
    process.env.${envKey},
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
}
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
${emitBody}
`,
  );
  return { fake, argvFile };
}

function writeDumpingCodex(dir) {
  return writeDumpingCli(
    dir,
    "codex",
    "CODER_FAKE_CODEX_ARGV_FILE",
    `
emit({ type: "thread.started", thread_id: "wf-codex-perm-sess" });
emit({
  type: "item.completed",
  item: { id: "m1", type: "agent_message", text: "CODEX_PERM_PHASE_OK" },
});
emit({
  type: "turn.completed",
  usage: { input_tokens: 1, output_tokens: 1 },
});
`,
  );
}

function writeDumpingOpencode(dir) {
  return writeDumpingCli(
    dir,
    "opencode",
    "CODER_FAKE_OPENCODE_ARGV_FILE",
    `
emit({ type: "step_start", timestamp: Date.now(), sessionID: "ses_wf_perm" });
emit({
  type: "text",
  timestamp: Date.now(),
  sessionID: "ses_wf_perm",
  part: { id: "p1", text: "OPENCODE_PERM_PHASE_OK" },
});
`,
  );
}

function writeDumpingCursor(dir) {
  return writeDumpingCli(
    dir,
    "cursor",
    "CODER_FAKE_CURSOR_ARGV_FILE",
    `
emit({
  type: "system",
  subtype: "init",
  session_id: "wf-cursor-perm-sess",
  model: "Composer",
});
emit({
  type: "assistant",
  timestamp_ms: 1,
  message: { content: [{ type: "text", text: "CURSOR_PERM_PHASE_OK" }] },
  session_id: "wf-cursor-perm-sess",
});
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "CURSOR_PERM_PHASE_OK",
  session_id: "wf-cursor-perm-sess",
});
`,
  );
}

function readArgv(argvFile) {
  assert.ok(fs.existsSync(argvFile), "fake CLI must dump process.argv");
  return JSON.parse(fs.readFileSync(argvFile, "utf8"));
}

function sandboxOf(args) {
  const i = args.indexOf("--sandbox");
  return i >= 0 ? args[i + 1] : null;
}

async function runWorkflowPhase({
  tmpDir,
  provider,
  permissionMode,
  prompt,
}) {
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
      title: `Workflow permission ${provider}`,
    });
    services.setProvider(store, { threadId: thread.id, provider });
    services.setPermissionMode(store, { threadId: thread.id, mode: permissionMode });
    const tmpl = services.saveTemplate(store, {
      name: `${provider} only`,
      phases: [
        {
          name: "plan",
          agentCount: 1,
          instruction: `${provider} plans briefly.`,
          provider,
          model: null,
        },
      ],
    });

    await runner.startWorkflowRun({
      threadId: thread.id,
      prompt,
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

describe("workflow phases get thread.permissionMode (#793)", () => {
  let tmpDir;
  let fakeCodex;
  let fakeOpencode;
  let fakeCursor;
  let codexArgvFile;
  let opencodeArgvFile;
  let cursorArgvFile;
  let prev;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wf-perm-"));
    ({ fake: fakeCodex, argvFile: codexArgvFile } = writeDumpingCodex(tmpDir));
    ({ fake: fakeOpencode, argvFile: opencodeArgvFile } =
      writeDumpingOpencode(tmpDir));
    ({ fake: fakeCursor, argvFile: cursorArgvFile } = writeDumpingCursor(tmpDir));
    prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_AGENT_CMD: process.env.CODER_AGENT_CMD,
      CODER_CODEX_BIN: process.env.CODER_CODEX_BIN,
      CODER_OPENCODE_BIN: process.env.CODER_OPENCODE_BIN,
      CODER_CURSOR_BIN: process.env.CODER_CURSOR_BIN,
      CODER_FAKE_CODEX_ARGV_FILE: process.env.CODER_FAKE_CODEX_ARGV_FILE,
      CODER_FAKE_OPENCODE_ARGV_FILE: process.env.CODER_FAKE_OPENCODE_ARGV_FILE,
      CODER_FAKE_CURSOR_ARGV_FILE: process.env.CODER_FAKE_CURSOR_ARGV_FILE,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
      CODER_GROK_BIN: process.env.CODER_GROK_BIN,
    };
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_CODEX_BIN = fakeCodex;
    process.env.CODER_OPENCODE_BIN = fakeOpencode;
    process.env.CODER_CURSOR_BIN = fakeCursor;
    process.env.CODER_FAKE_CODEX_ARGV_FILE = codexArgvFile;
    process.env.CODER_FAKE_OPENCODE_ARGV_FILE = opencodeArgvFile;
    process.env.CODER_FAKE_CURSOR_ARGV_FILE = cursorArgvFile;
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

  it("spawnPhaseAgent Codex plan emits --sandbox read-only", async () => {
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    const prompt = "PROMPT_WF_PERM_codex_spawn";
    const { done } = spawnPhaseAgent({
      providerId: "codex",
      prompt,
      cwd: projectDir,
      model: null,
      permissionMode: "plan",
    });
    const result = await done;
    assert.equal(result.ok, true, result.stderr);

    const argv = readArgv(codexArgvFile);
    assert.equal(
      sandboxOf(argv),
      "read-only",
      `spawnPhaseAgent Codex plan must emit --sandbox read-only, got ${JSON.stringify(argv)}`,
    );
    assert.equal(argv[argv.length - 1], prompt);
  });

  it("spawnPhaseAgent OpenCode bypassPermissions emits --auto", async () => {
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    const prompt = "PROMPT_WF_PERM_opencode_spawn";
    const { done } = spawnPhaseAgent({
      providerId: "opencode",
      prompt,
      cwd: projectDir,
      model: null,
      permissionMode: "bypassPermissions",
    });
    const result = await done;
    assert.equal(result.ok, true, result.stderr);

    const argv = readArgv(opencodeArgvFile);
    assert.ok(
      argv.includes("--auto"),
      `spawnPhaseAgent OpenCode bypassPermissions must emit --auto, got ${JSON.stringify(argv)}`,
    );
    assert.equal(argv[argv.length - 1], prompt);
  });

  it("spawnPhaseAgent Cursor plan emits --mode plan and omits --force", async () => {
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    const prompt = "PROMPT_WF_PERM_cursor_spawn";
    const { done } = spawnPhaseAgent({
      providerId: "cursor",
      prompt,
      cwd: projectDir,
      model: null,
      permissionMode: "plan",
    });
    const result = await done;
    assert.equal(result.ok, true, result.stderr);

    const argv = readArgv(cursorArgvFile);
    assert.equal(
      argv[argv.indexOf("--mode") + 1],
      "plan",
      `spawnPhaseAgent Cursor plan must emit --mode plan, got ${JSON.stringify(argv)}`,
    );
    assert.ok(
      !argv.includes("--force"),
      `spawnPhaseAgent Cursor plan must omit --force, got ${JSON.stringify(argv)}`,
    );
    assert.equal(argv[argv.length - 1], prompt);
  });

  it("startWorkflowRun wires thread.permissionMode into Codex --sandbox", async () => {
    await runWorkflowPhase({
      tmpDir,
      provider: "codex",
      permissionMode: "plan",
      prompt: "PROMPT_WF_PERM_codex_start",
    });
    const argv = readArgv(codexArgvFile);
    assert.equal(
      sandboxOf(argv),
      "read-only",
      `startWorkflowRun Codex plan must emit --sandbox read-only, got ${JSON.stringify(argv)}`,
    );
  });

  it("startWorkflowRun wires thread.permissionMode into OpenCode --auto", async () => {
    await runWorkflowPhase({
      tmpDir,
      provider: "opencode",
      permissionMode: "bypassPermissions",
      prompt: "PROMPT_WF_PERM_opencode_start",
    });
    const argv = readArgv(opencodeArgvFile);
    assert.ok(
      argv.includes("--auto"),
      `startWorkflowRun OpenCode bypassPermissions must emit --auto, got ${JSON.stringify(argv)}`,
    );
  });

  it("startWorkflowRun wires thread.permissionMode into Cursor --mode plan", async () => {
    await runWorkflowPhase({
      tmpDir,
      provider: "cursor",
      permissionMode: "plan",
      prompt: "PROMPT_WF_PERM_cursor_start",
    });
    const argv = readArgv(cursorArgvFile);
    assert.equal(
      argv[argv.indexOf("--mode") + 1],
      "plan",
      `startWorkflowRun Cursor plan must emit --mode plan, got ${JSON.stringify(argv)}`,
    );
    assert.ok(
      !argv.includes("--force"),
      `startWorkflowRun Cursor plan must omit --force, got ${JSON.stringify(argv)}`,
    );
  });
});
