"use strict";

/**
 * Workflow kimi phases must get the same effort flip and KIMI_CODE_HOME
 * overlay as a normal kimi turn (issue #699). spawnAgentKimi used to drop
 * both: no reasoningEffort to runKimi, and no materializeKimiHome.
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
const {
  registerMcpServer,
  resetMemorySupForTests,
} = require("../memory-sup.js");
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

function writeSourceHome(dir) {
  const sourceHome = path.join(dir, "user-kimi");
  fs.mkdirSync(sourceHome);
  fs.writeFileSync(
    path.join(sourceHome, "config.toml"),
    '[thinking]\nenabled = true\neffort = "high"\n',
  );
  fs.writeFileSync(
    path.join(sourceHome, "mcp.json"),
    JSON.stringify({
      mcpServers: { girder: { command: "/tmp/girder-mcp" } },
    }),
  );
  return sourceHome;
}

function writeDumpingKimi(dir) {
  const seenFile = path.join(dir, "seen.json");
  const fakeKimi = writeFakeBin(
    path.join(dir, "fake-kimi"),
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const home = process.env.KIMI_CODE_HOME;
const mcp = fs.readFileSync(path.join(home, "mcp.json"), "utf8");
const cfg = fs.readFileSync(path.join(home, "config.toml"), "utf8");
const m = cfg.match(/effort[ \\t]*=[ \\t]*"([^"]*)"/);
fs.writeFileSync(process.env.CODER_FAKE_KIMI_SEEN_FILE, JSON.stringify({
  home,
  mcp,
  effort: m ? m[1] : "none",
}));
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({ type: "text", text: "KIMI_PHASE_OK" });
emit({ type: "usage", input_tokens: 1, output_tokens: 1 });
`,
  );
  return { fakeKimi, seenFile };
}

describe("workflow kimi phases get effort and MCP overlay (#699)", () => {
  let tmpDir;
  let sourceHome;
  let fakeKimi;
  let seenFile;
  let prev;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wf-kimi-"));
    sourceHome = writeSourceHome(tmpDir);
    ({ fakeKimi, seenFile } = writeDumpingKimi(tmpDir));
    prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_AGENT_CMD: process.env.CODER_AGENT_CMD,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_FAKE_KIMI_SEEN_FILE: process.env.CODER_FAKE_KIMI_SEEN_FILE,
      KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
    };
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_KIMI_BIN = fakeKimi;
    process.env.CODER_FAKE_KIMI_SEEN_FILE = seenFile;
    process.env.KIMI_CODE_HOME = sourceHome;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    resetMemorySupForTests();
    registerMcpServer({
      name: "coder-threads",
      port: 4321,
      token: "tok-threads",
      userDataPath: tmpDir,
    });
  });

  afterEach(() => {
    resetMemorySupForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("spawnPhaseAgent flips effort on an isolated overlay, not the user home", async () => {
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    const { done } = spawnPhaseAgent({
      providerId: "kimi",
      prompt: "phase work",
      cwd: projectDir,
      model: null,
      reasoningEffort: "low",
      userDataPath: tmpDir,
      threadId: "tid-1",
      projectId: "proj-1",
      overlayKey: "0:plan:0",
    });
    const result = await done;
    assert.equal(result.ok, true, result.stderr);

    const seen = JSON.parse(fs.readFileSync(seenFile, "utf8"));
    const overlayRoot = path.join(tmpDir, "kimi-homes", "tid-1");
    assert.ok(
      seen.home === overlayRoot || seen.home.startsWith(overlayRoot + path.sep),
      `KIMI_CODE_HOME must be the overlay, got ${seen.home}`,
    );
    assert.equal(seen.effort, "low", "phase must see the requested effort");
    const mcp = JSON.parse(seen.mcp);
    assert.ok(!mcp.mcpServers || !mcp.mcpServers.girder, "foreign MCP must stay out");
    assert.ok(
      mcp.mcpServers && mcp.mcpServers["coder-threads"],
      "Solenta MCP must be injected",
    );
    assert.match(
      fs.readFileSync(path.join(sourceHome, "config.toml"), "utf8"),
      /effort = "high"/,
      "the user's kimi home must not be flipped",
    );
  });

  it("startWorkflowRun wires thread.reasoningEffort and the overlay into kimi phases", async () => {
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
        title: "Kimi Workflow",
      });
      services.setReasoningEffort(store, {
        threadId: thread.id,
        effort: "low",
      });
      const tmpl = services.saveTemplate(store, {
        name: "Kimi only",
        phases: [
          {
            name: "plan",
            agentCount: 1,
            instruction: "Kimi plans briefly.",
            provider: "kimi",
            model: null,
          },
        ],
      });

      await runner.startWorkflowRun({
        threadId: thread.id,
        prompt: "kimi phase task",
        templateId: tmpl.id,
      });
      await waitFor(() => {
        const t = store.getThread(thread.id);
        return t && (t.status === "done" || t.status === "failed");
      });
      assert.equal(store.getThread(thread.id).status, "done");

      const seen = JSON.parse(fs.readFileSync(seenFile, "utf8"));
      const overlayRoot = path.join(tmpDir, "kimi-homes", thread.id);
      assert.ok(
        seen.home === overlayRoot || seen.home.startsWith(overlayRoot + path.sep),
        `workflow kimi phase must use the overlay, got ${seen.home}`,
      );
      assert.equal(
        seen.effort,
        "low",
        "workflow kimi phase must see thread.reasoningEffort",
      );
      const mcp = JSON.parse(seen.mcp);
      assert.ok(!mcp.mcpServers || !mcp.mcpServers.girder);
      assert.ok(mcp.mcpServers && mcp.mcpServers["coder-threads"]);
      assert.match(
        fs.readFileSync(path.join(sourceHome, "config.toml"), "utf8"),
        /effort = "high"/,
      );
    } finally {
      runner.stopAll();
    }
  });
});
