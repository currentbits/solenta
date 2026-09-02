"use strict";

/**
 * Issue #792 / #799 / #811 / #814: workflow Codex phases must get thread.webSearch
 * as `-c web_search=live`. Codex 0.152.0 rejects `--search` after `exec`.
 * startWorkflowRun already has the thread; spawnPhaseAgent fans out to
 * spawnAgentCodex; Codex buildArgs already emits the flag. The spawn path
 * used to drop webSearch entirely.
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

function writeDumpingCodex(dir) {
  const argvFile = path.join(dir, "argv.json");
  const fakeCodex = writeFakeBin(
    path.join(dir, "fake-codex"),
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
if (process.env.CODER_FAKE_CODEX_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_CODEX_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
}
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({ type: "thread.started", thread_id: "wf-codex-search-sess" });
emit({
  type: "item.completed",
  item: { id: "m1", type: "agent_message", text: "CODEX_SEARCH_PHASE_OK" },
});
emit({
  type: "turn.completed",
  usage: { input_tokens: 1, output_tokens: 1 },
});
`,
  );
  return { fakeCodex, argvFile };
}

function readArgv(argvFile) {
  assert.ok(fs.existsSync(argvFile), "fake Codex must dump process.argv");
  return JSON.parse(fs.readFileSync(argvFile, "utf8"));
}

describe("workflow Codex phases get thread.webSearch (#792)", () => {
  let tmpDir;
  let fakeCodex;
  let argvFile;
  let prev;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wf-search-"));
    ({ fakeCodex, argvFile } = writeDumpingCodex(tmpDir));
    prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_AGENT_CMD: process.env.CODER_AGENT_CMD,
      CODER_CODEX_BIN: process.env.CODER_CODEX_BIN,
      CODER_FAKE_CODEX_ARGV_FILE: process.env.CODER_FAKE_CODEX_ARGV_FILE,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
      CODER_GROK_BIN: process.env.CODER_GROK_BIN,
    };
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_CODEX_BIN = fakeCodex;
    process.env.CODER_FAKE_CODEX_ARGV_FILE = argvFile;
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

  it("spawnPhaseAgent emits -c web_search=live from webSearch", async () => {
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    const prompt = "PROMPT_WF_SEARCH_spawn";
    const { done } = spawnPhaseAgent({
      providerId: "codex",
      prompt,
      cwd: projectDir,
      model: null,
      webSearch: true,
    });
    const result = await done;
    assert.equal(result.ok, true, result.stderr);

    const argv = readArgv(argvFile);
    assert.ok(
      !argv.includes("--search"),
      `spawnPhaseAgent must not pass --search after exec, got ${JSON.stringify(argv)}`,
    );
    assert.ok(
      argv.includes("web_search=live"),
      `spawnPhaseAgent must pass -c web_search=live into Codex argv, got ${JSON.stringify(argv)}`,
    );
    assert.equal(argv[argv.indexOf("web_search=live") - 1], "-c");
    assert.equal(
      argv[argv.length - 1],
      prompt,
      `prompt must stay last after live search: ${JSON.stringify(argv)}`,
    );
  });

  it("startWorkflowRun wires thread.webSearch into Codex -c web_search=live", async () => {
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
        title: "Codex Workflow Search",
      });
      services.setProvider(store, { threadId: thread.id, provider: "codex" });
      services.setWebSearch(store, { threadId: thread.id, webSearch: true });
      const tmpl = services.saveTemplate(store, {
        name: "Codex only",
        phases: [
          {
            name: "plan",
            agentCount: 1,
            instruction: "Codex plans briefly.",
            provider: "codex",
            model: null,
          },
        ],
      });

      const prompt = "PROMPT_WF_SEARCH_start";
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

      const argv = readArgv(argvFile);
      assert.ok(
        !argv.includes("--search"),
        `startWorkflowRun must not pass --search after exec, got ${JSON.stringify(argv)}`,
      );
      assert.ok(
        argv.includes("web_search=live"),
        `startWorkflowRun must pass -c web_search=live into Codex argv, got ${JSON.stringify(argv)}`,
      );
      assert.equal(argv[argv.indexOf("web_search=live") - 1], "-c");
    } finally {
      runner.stopAll();
    }
  });
});
