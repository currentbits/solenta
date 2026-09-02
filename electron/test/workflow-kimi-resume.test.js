"use strict";

/**
 * Workflow kimi phases must persist the stream's resume hint on the
 * workflow agent (not thread.sessionId) and emit -S on a later spawn
 * of that same agent. Never -c (issue #220 / #782).
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

function writeDumpingKimi(dir) {
  const argvFile = path.join(dir, "kimi-argv.json");
  const fakeKimi = writeFakeBin(
    path.join(dir, "fake-kimi"),
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
if (process.env.CODER_FAKE_KIMI_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_KIMI_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
}
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({ role: "assistant", content: "KIMI_RESUME_OK" });
emit({
  role: "meta",
  type: "session.resume_hint",
  session_id: "session_wf_1",
  command: "kimi -S session_wf_1",
  content: "To resume this session: kimi -S session_wf_1",
});
emit({ type: "usage", input_tokens: 2, output_tokens: 1 });
`,
  );
  return { fakeKimi, argvFile };
}

function readArgv(argvFile) {
  assert.ok(fs.existsSync(argvFile), "fake kimi must dump process.argv");
  return JSON.parse(fs.readFileSync(argvFile, "utf8"));
}

function assertNeverContinueFlag(argv) {
  assert.ok(!argv.includes("-c"), `-c must never be emitted: ${JSON.stringify(argv)}`);
}

describe("workflow kimi phase session resume (#782)", () => {
  let tmpDir;
  let fakeKimi;
  let argvFile;
  let prev;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wf-kimi-resume-"));
    ({ fakeKimi, argvFile } = writeDumpingKimi(tmpDir));
    prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_AGENT_CMD: process.env.CODER_AGENT_CMD,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_FAKE_KIMI_ARGV_FILE: process.env.CODER_FAKE_KIMI_ARGV_FILE,
      KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
    };
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_KIMI_BIN = fakeKimi;
    process.env.CODER_FAKE_KIMI_ARGV_FILE = argvFile;
    process.env.KIMI_CODE_HOME = path.join(tmpDir, "user-kimi");
    fs.mkdirSync(process.env.KIMI_CODE_HOME);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("fresh spawn captures the resume hint and emits neither -S nor -c", async () => {
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    const { done } = spawnPhaseAgent({
      providerId: "kimi",
      prompt: "first pass",
      cwd: projectDir,
      model: null,
    });
    const result = await done;
    assert.equal(result.ok, true, result.stderr);
    assert.equal(
      result.sessionId,
      "session_wf_1",
      "phase child must surface extractSessionId",
    );

    const argv = readArgv(argvFile);
    assert.ok(!argv.includes("-S"), `fresh spawn must not -S: ${JSON.stringify(argv)}`);
    assertNeverContinueFlag(argv);
  });

  it("retry spawn with a real session id emits -S and never -c", async () => {
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    const { done } = spawnPhaseAgent({
      providerId: "kimi",
      prompt: "retry pass",
      cwd: projectDir,
      model: null,
      sessionId: "session_wf_1",
    });
    const result = await done;
    assert.equal(result.ok, true, result.stderr);
    assert.equal(result.sessionId, "session_wf_1");

    const argv = readArgv(argvFile);
    const sIdx = argv.indexOf("-S");
    assert.ok(sIdx >= 0, `expected -S: ${JSON.stringify(argv)}`);
    assert.equal(argv[sIdx + 1], "session_wf_1");
    assertNeverContinueFlag(argv);
  });

  it("cwd sentinel and empty session id never emit -S or -c (issue #220)", async () => {
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    for (const sessionId of ["cwd", "", null]) {
      if (fs.existsSync(argvFile)) fs.unlinkSync(argvFile);
      const { done } = spawnPhaseAgent({
        providerId: "kimi",
        prompt: "no resume",
        cwd: projectDir,
        model: null,
        sessionId,
      });
      const result = await done;
      assert.equal(result.ok, true, result.stderr);
      const argv = readArgv(argvFile);
      assert.ok(
        !argv.includes("-S"),
        `sessionId=${JSON.stringify(sessionId)} must not -S: ${JSON.stringify(argv)}`,
      );
      assertNeverContinueFlag(argv);
      assert.ok(!argv.includes("cwd"), `must not pass cwd as a session: ${JSON.stringify(argv)}`);
    }
  });

  it("startWorkflowRun stores the hint on the agent, not thread.sessionId", async () => {
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
    /** @type {object[]} */
    const workflows = [];
    const runner = createRunner({
      store,
      core,
      pushFn(channel, payload) {
        if (payload && payload.workflow) {
          workflows.push(payload.workflow);
        }
      },
      tickMs: 15,
      userDataPath: tmpDir,
    });
    try {
      const project = await services.addProject(store, projectDir);
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "Kimi Resume",
      });
      services.setProvider(store, { threadId: thread.id, provider: "kimi" });
      const tmpl = services.saveTemplate(store, {
        name: "Kimi resume",
        phases: [
          {
            name: "plan",
            agentCount: 1,
            instruction: "Plan briefly.",
            provider: "kimi",
            model: null,
          },
        ],
      });

      await runner.startWorkflowRun({
        threadId: thread.id,
        prompt: "resume task",
        templateId: tmpl.id,
      });
      await waitFor(() => {
        const t = store.getThread(thread.id);
        return t && (t.status === "done" || t.status === "failed");
      });
      assert.equal(store.getThread(thread.id).status, "done");
      assert.equal(
        store.getThread(thread.id).sessionId,
        null,
        "workflow kimi session must not land on the parent thread",
      );

      const seenAgent = workflows
        .flatMap((w) => w.phases || [])
        .flatMap((p) => p.agents || [])
        .find((a) => a.sessionId === "session_wf_1");
      assert.ok(
        seenAgent,
        "workflow agent must carry the captured session id",
      );

      const argv = readArgv(argvFile);
      assert.ok(!argv.includes("-S"), "first spawn of a phase is fresh");
      assertNeverContinueFlag(argv);
    } finally {
      runner.stopAll();
    }
  });
});
