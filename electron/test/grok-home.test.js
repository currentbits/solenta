"use strict";

/**
 * Isolated GROK_HOME (issue #706). A Solenta grok turn must not inherit the
 * user's other MCP servers or a user-global last-write-wins `?project=`.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

const { materializeGrokHome } = require("../grok.js");
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

describe("materializeGrokHome", () => {
  let source;
  let dest;

  beforeEach(() => {
    source = fs.mkdtempSync(path.join(os.tmpdir(), "grok-src-"));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), "grok-dst-"));
    fs.writeFileSync(
      path.join(source, "config.toml"),
      `[marketplace]
auto_update = true

[mcp_servers.girder]
command = "/tmp/girder-mcp"

[mcp_servers.coder-memory]
url = "http://127.0.0.1:9/mcp"

[plugins]
enabled = ["ponytail"]
`,
    );
    fs.writeFileSync(path.join(source, "auth.json"), '{"token":"keep"}\n');
    fs.writeFileSync(path.join(source, "agent_id"), "agent-1\n");
    fs.mkdirSync(path.join(source, "sessions"));
    fs.writeFileSync(path.join(source, "sessions", "s1.json"), "{}\n");
  });

  afterEach(() => {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it("writes only Solenta MCP servers with bound URLs and keeps auth as a symlink", () => {
    materializeGrokHome({
      dest,
      sourceHome: source,
      mcpServers: {
        "coder-memory": {
          type: "http",
          url: "http://127.0.0.1:9/mcp?project=%2Ftmp%2Falpha-project",
          headers: { Authorization: "Bearer mem-tok" },
        },
        "coder-threads": {
          type: "http",
          url: "http://127.0.0.1:9/mcp?projectId=proj-1",
          headers: { Authorization: "Bearer thr-tok" },
        },
      },
    });

    const cfg = fs.readFileSync(path.join(dest, "config.toml"), "utf8");
    assert.match(cfg, /auto_update = true/);
    assert.match(cfg, /enabled = \["ponytail"\]/);
    assert.match(
      cfg,
      /url = "http:\/\/127\.0\.0\.1:9\/mcp\?project=%2Ftmp%2Falpha-project"/,
    );
    assert.match(cfg, /url = "http:\/\/127\.0\.0\.1:9\/mcp\?projectId=proj-1"/);
    assert.match(cfg, /Authorization = "Bearer mem-tok"/);
    assert.equal(
      /mcp_servers\.girder/.test(cfg),
      false,
      "foreign MCP must not be copied into the overlay",
    );
    assert.match(cfg, /\[compat\.claude\]/);
    assert.match(cfg, /mcps = false/);

    assert.equal(fs.lstatSync(path.join(dest, "config.toml")).isSymbolicLink(), false);
    assert.ok(fs.lstatSync(path.join(dest, "auth.json")).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(dest, "sessions")).isSymbolicLink());
    assert.equal(
      fs.statSync(path.join(dest, "config.toml")).mode & 0o777,
      0o600,
    );
  });

  it("skips stdio servers that need cwd (Grok cannot express it)", () => {
    materializeGrokHome({
      dest,
      sourceHome: source,
      mcpServers: {
        "needs-cwd": {
          type: "stdio",
          command: "/bin/echo",
          args: [],
          cwd: "/tmp/somewhere",
        },
        "no-cwd": {
          type: "stdio",
          command: "/bin/echo",
          args: ["--stdio"],
        },
      },
    });
    const cfg = fs.readFileSync(path.join(dest, "config.toml"), "utf8");
    assert.equal(/mcp_servers\.needs-cwd/.test(cfg), false);
    assert.match(cfg, /\[mcp_servers\.no-cwd\]/);
    assert.match(cfg, /command = "\/bin\/echo"/);
  });
});

describe("kimiMcpServersForRun binds projectId for grok overlay", () => {
  let tmpDir;
  let prevEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mcp-run-"));
    prevEnv = {
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
    };
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_KIMI_BIN = path.join(tmpDir, "no-kimi");
    process.env.CODER_KIMI_MCP_PATH = path.join(tmpDir, "kimi-mcp.json");
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

  it("puts projectId on coder-threads (coder-memory is owned by markHealthy)", () => {
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
  });
});

describe("runner grok overlay", () => {
  it("points GROK_HOME at an isolated home with bound Solenta MCP", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-grok-iso-"));
    const sourceHome = path.join(tmpDir, "user-grok");
    fs.mkdirSync(sourceHome);
    fs.writeFileSync(
      path.join(sourceHome, "config.toml"),
      `[mcp_servers.girder]
command = "/tmp/girder-mcp"
`,
    );
    fs.writeFileSync(path.join(sourceHome, "auth.json"), "{}\n");
    const seenFile = path.join(tmpDir, "seen.json");
    const fakeGrok = writeFakeBin(
      path.join(tmpDir, "fake-grok"),
      `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const home = process.env.GROK_HOME;
const cfg = home
  ? fs.readFileSync(path.join(home, "config.toml"), "utf8")
  : "";
fs.writeFileSync(process.env.CODER_FAKE_GROK_SEEN_FILE, JSON.stringify({
  home,
  cfg,
  claudeMcps: process.env.GROK_CLAUDE_MCPS_ENABLED || "",
  cursorMcps: process.env.GROK_CURSOR_MCPS_ENABLED || "",
}));
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({ type: "system", subtype: "init", session_id: "g1", model: "grok-4.5" });
emit({
  type: "assistant",
  message: { content: [{ type: "text", text: "ok" }] },
});
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
  usage: { input_tokens: 1, output_tokens: 1 },
  total_cost_usd: 0,
});
`,
    );

    const prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_AGENT_CMD: process.env.CODER_AGENT_CMD,
      CODER_GROK_BIN: process.env.CODER_GROK_BIN,
      CODER_FAKE_GROK_SEEN_FILE: process.env.CODER_FAKE_GROK_SEEN_FILE,
      GROK_HOME: process.env.GROK_HOME,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
    };
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_GROK_BIN = fakeGrok;
    process.env.CODER_FAKE_GROK_SEEN_FILE = seenFile;
    process.env.GROK_HOME = sourceHome;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_KIMI_BIN = path.join(tmpDir, "no-kimi");
    process.env.CODER_KIMI_MCP_PATH = path.join(tmpDir, "kimi-mcp.json");

    let runner;
    try {
      resetMemorySupForTests();
      registerMcpServer({
        name: "coder-threads",
        port: 4321,
        token: "tok-thr",
        userDataPath: tmpDir,
      });

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
        title: "Grok Isolate",
      });
      services.setProvider(store, { threadId: thread.id, provider: "grok" });

      await runner.startRun({ threadId: thread.id, prompt: "stay in project" });
      await waitFor(() => store.getThread(thread.id).status === "done");

      const seen = JSON.parse(fs.readFileSync(seenFile, "utf8"));
      const expectedHome = path.join(tmpDir, "grok-homes", thread.id);
      assert.equal(seen.home, expectedHome);
      assert.match(seen.claudeMcps, /^(0|false)$/i);
      assert.match(seen.cursorMcps, /^(0|false)$/i);
      assert.match(seen.cfg, new RegExp(`projectId=${project.id}`));
      assert.match(seen.cfg, /mcp_servers\.coder-threads/);
      assert.equal(/mcp_servers\.girder/.test(seen.cfg), false);
      assert.match(
        fs.readFileSync(path.join(sourceHome, "config.toml"), "utf8"),
        /girder/,
        "the user's grok home must not be rewritten",
      );
    } finally {
      if (runner) runner.stopAll();
      resetMemorySupForTests();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
