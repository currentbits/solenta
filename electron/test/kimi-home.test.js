"use strict";

/**
 * Isolated KIMI_CODE_HOME (issue #671). A Solenta kimi turn must not inherit
 * the user's other MCP servers or workspaces.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

const { materializeKimiHome, workspaceId } = require("../kimi.js");
const {
  kimiMcpServersForRun,
  registerMcpServer,
  resetMemorySupForTests,
} = require("../memory-sup.js");
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

describe("materializeKimiHome", () => {
  let source;
  let dest;

  beforeEach(() => {
    source = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-src-"));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-dst-"));
    fs.writeFileSync(
      path.join(source, "config.toml"),
      'default_model = "kimi-code/k3"\n',
    );
    fs.writeFileSync(path.join(source, "device_id"), "device-1\n");
    fs.writeFileSync(
      path.join(source, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          girder: { command: "/tmp/girder-mcp" },
          agentmux: { command: "/tmp/agentmux-mcp" },
        },
      }),
    );
    fs.writeFileSync(
      path.join(source, "workspaces.json"),
      JSON.stringify({
        version: 1,
        workspaces: {
          wd_root: { root: "/", name: "" },
          wd_home: { root: os.homedir(), name: "home" },
        },
        deleted_workspace_ids: [],
      }),
    );
    fs.writeFileSync(
      path.join(source, "AGENTS.md"),
      "# foreign memory preflight\n",
    );
  });

  afterEach(() => {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it("writes only Solenta MCP servers and only this cwd as a workspace", () => {
    const cwd = "/tmp/alpha-project";
    materializeKimiHome({
      dest,
      sourceHome: source,
      cwd,
      mcpServers: {
        "coder-memory": {
          type: "http",
          url: "http://127.0.0.1:9/mcp?project=%2Ftmp%2Falpha-project",
        },
      },
    });

    const mcp = JSON.parse(fs.readFileSync(path.join(dest, "mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(mcp.mcpServers), ["coder-memory"]);
    assert.ok(!mcp.mcpServers.girder);
    assert.ok(!mcp.mcpServers.agentmux);

    const ws = JSON.parse(
      fs.readFileSync(path.join(dest, "workspaces.json"), "utf8"),
    );
    const roots = Object.values(ws.workspaces).map((w) => w.root);
    assert.deepEqual(roots, [cwd]);
    assert.ok(!roots.includes("/"));
    assert.ok(!roots.includes(os.homedir()));

    assert.equal(fs.existsSync(path.join(dest, "AGENTS.md")), false);
    assert.equal(
      fs.readFileSync(path.join(dest, "config.toml"), "utf8"),
      'default_model = "kimi-code/k3"\n',
    );
    assert.ok(fs.lstatSync(path.join(dest, "device_id")).isSymbolicLink());
  });

  it("workspaceId is stable for the same path", () => {
    assert.equal(workspaceId("/tmp/alpha"), workspaceId("/tmp/alpha"));
    assert.notEqual(workspaceId("/tmp/alpha"), workspaceId("/tmp/beta"));
  });
});

describe("kimiMcpServersForRun binds project on the URL", () => {
  let tmpDir;
  let prevEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-mcp-run-"));
    prevEnv = {
      CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
    };
    process.env.CODER_KIMI_MCP_PATH = path.join(tmpDir, "kimi-mcp.json");
    process.env.CODER_KIMI_BIN = path.join(tmpDir, "no-kimi");
    process.env.CODER_GROK_MCP_DISABLE = "1";
    resetMemorySupForTests();
  });

  afterEach(() => {
    resetMemorySupForTests();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("puts projectId and project path on the matching server URLs", () => {
    registerMcpServer({
      name: "coder-threads",
      port: 4321,
      token: "tok-threads",
      userDataPath: tmpDir,
    });
    const servers = kimiMcpServersForRun({
      projectId: "proj-1",
      projectPath: "/tmp/alpha",
    });
    assert.equal(
      servers["coder-threads"].url,
      "http://127.0.0.1:4321/mcp?projectId=proj-1",
    );
    assert.equal(
      servers["coder-threads"].headers.Authorization,
      "Bearer tok-threads",
    );
    assert.ok(!servers.girder);
  });
});

describe("runner kimi overlay", () => {
  it("points KIMI_CODE_HOME at an isolated home that drops foreign MCP", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-kimi-iso-"));
    const sourceHome = path.join(tmpDir, "user-kimi");
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
    const seenFile = path.join(tmpDir, "seen.json");
    const fakeKimi = writeFakeBin(
      path.join(tmpDir, "fake-kimi"),
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
emit({ type: "text", text: "ok" });
emit({ type: "usage", input_tokens: 1, output_tokens: 1 });
`,
    );

    const prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_AGENT_CMD: process.env.CODER_AGENT_CMD,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_FAKE_KIMI_SEEN_FILE: process.env.CODER_FAKE_KIMI_SEEN_FILE,
      KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
    };
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_KIMI_BIN = fakeKimi;
    process.env.CODER_FAKE_KIMI_SEEN_FILE = seenFile;
    process.env.KIMI_CODE_HOME = sourceHome;

    let runner;
    try {
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
      runner = createRunner({
        store,
        core,
        pushFn() {},
        tickMs: 15,
        userDataPath: tmpDir,
      });
      const project = await services.addProject(store, projectDir);
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "Kimi Isolate",
      });
      services.setProvider(store, { threadId: thread.id, provider: "kimi" });
      services.setReasoningEffort(store, {
        threadId: thread.id,
        effort: "low",
      });

      await runner.startRun({ threadId: thread.id, prompt: "stay in project" });
      await waitFor(() => store.getThread(thread.id).status === "done");

      const seen = JSON.parse(fs.readFileSync(seenFile, "utf8"));
      const expectedHome = path.join(tmpDir, "kimi-homes", thread.id);
      assert.equal(seen.home, expectedHome);
      assert.equal(seen.effort, "low");
      assert.match(
        fs.readFileSync(path.join(sourceHome, "config.toml"), "utf8"),
        /effort = "high"/,
        "the user's kimi home must not be flipped",
      );
      const mcp = JSON.parse(seen.mcp);
      assert.ok(!mcp.mcpServers || !mcp.mcpServers.girder);
      const ws = JSON.parse(
        fs.readFileSync(path.join(expectedHome, "workspaces.json"), "utf8"),
      );
      const roots = Object.values(ws.workspaces).map((w) => w.root);
      assert.deepEqual(roots, [projectDir]);
    } finally {
      if (runner) runner.stopAll();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
