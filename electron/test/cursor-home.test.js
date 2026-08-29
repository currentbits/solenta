"use strict";

/**
 * Isolated Cursor HOME overlay (issue #700). A Solenta cursor turn must
 * receive bound Solenta MCP servers without writing the user's
 * ~/.cursor/mcp.json or the project tree.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

const { materializeCursorHome } = require("../cursor.js");
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

describe("materializeCursorHome", () => {
  let source;
  let dest;

  beforeEach(() => {
    source = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-src-"));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-dst-"));
    fs.mkdirSync(path.join(source, ".cursor"));
    fs.writeFileSync(
      path.join(source, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          girder: { command: "/tmp/girder-mcp" },
        },
      }),
    );
    fs.writeFileSync(
      path.join(source, ".cursor", "cli-config.json"),
      '{"auth":true}\n',
    );
    fs.writeFileSync(path.join(source, ".gitconfig"), "[user]\n\tname = Test\n");
  });

  afterEach(() => {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it("writes only Solenta MCP under .cursor and keeps git/auth via home symlinks", () => {
    materializeCursorHome({
      dest,
      sourceHome: source,
      mcpServers: {
        "coder-memory": {
          type: "http",
          url: "http://127.0.0.1:9/mcp?project=%2Ftmp%2Falpha-project",
          headers: { Authorization: "Bearer tok" },
        },
      },
    });

    const mcpPath = path.join(dest, ".cursor", "mcp.json");
    const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    assert.deepEqual(Object.keys(mcp.mcpServers), ["coder-memory"]);
    assert.ok(!mcp.mcpServers.girder);
    assert.equal(
      fs.statSync(mcpPath).mode & 0o777,
      0o600,
    );

    const cli = path.join(dest, ".cursor", "cli-config.json");
    assert.ok(fs.lstatSync(cli).isSymbolicLink());
    assert.equal(
      fs.readFileSync(cli, "utf8"),
      '{"auth":true}\n',
    );
    assert.equal(
      fs.existsSync(path.join(dest, ".cursor", "mcp.json")),
      true,
    );
    assert.ok(!fs.lstatSync(mcpPath).isSymbolicLink());

    const gitconfig = path.join(dest, ".gitconfig");
    assert.ok(fs.lstatSync(gitconfig).isSymbolicLink());
    assert.equal(
      fs.readFileSync(gitconfig, "utf8"),
      "[user]\n\tname = Test\n",
    );
    assert.equal(
      fs.readFileSync(path.join(source, ".cursor", "mcp.json"), "utf8"),
      JSON.stringify({
        mcpServers: {
          girder: { command: "/tmp/girder-mcp" },
        },
      }),
      "the user's ~/.cursor/mcp.json must not be rewritten",
    );
  });
});

describe("kimiMcpServersForRun binds project for cursor overlay", () => {
  let tmpDir;
  let prevEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-mcp-run-"));
    prevEnv = {
      CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
      CODER_CURSOR_MCP_DISABLE: process.env.CODER_CURSOR_MCP_DISABLE,
    };
    process.env.CODER_KIMI_MCP_PATH = path.join(tmpDir, "kimi-mcp.json");
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_CURSOR_MCP_DISABLE = "1";
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
  });
});

describe("runner cursor overlay", () => {
  it("points HOME at an isolated home with bound Solenta MCP (#700)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-cursor-iso-"));
    const seenFile = path.join(tmpDir, "seen.json");
    const fakeCursor = writeFakeBin(
      path.join(tmpDir, "fake-cursor"),
      `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const home = process.env.HOME;
const mcpPath = path.join(home, ".cursor", "mcp.json");
let mcp = "";
try { mcp = fs.readFileSync(mcpPath, "utf8"); } catch { mcp = ""; }
fs.writeFileSync(process.env.CODER_FAKE_CURSOR_SEEN_FILE, JSON.stringify({
  home,
  mcp,
  argv: process.argv.slice(2),
}));
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
emit({ type: "system", subtype: "init", session_id: "cursor-sess-1", model: "auto" });
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
});
`,
    );

    const prev = {
      CODER_SIMULATE: process.env.CODER_SIMULATE,
      CODER_AGENT_CMD: process.env.CODER_AGENT_CMD,
      CODER_CURSOR_BIN: process.env.CODER_CURSOR_BIN,
      CODER_FAKE_CURSOR_SEEN_FILE: process.env.CODER_FAKE_CURSOR_SEEN_FILE,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
      CODER_CURSOR_MCP_DISABLE: process.env.CODER_CURSOR_MCP_DISABLE,
      CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
    };
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_CURSOR_BIN = fakeCursor;
    process.env.CODER_FAKE_CURSOR_SEEN_FILE = seenFile;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_CURSOR_MCP_DISABLE = "1";
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
        title: "Cursor Isolate",
      });
      services.setProvider(store, { threadId: thread.id, provider: "cursor" });

      await runner.startRun({ threadId: thread.id, prompt: "stay in project" });
      await waitFor(() => store.getThread(thread.id).status === "done");

      const seen = JSON.parse(fs.readFileSync(seenFile, "utf8"));
      const expectedHome = path.join(tmpDir, "cursor-homes", thread.id);
      assert.equal(seen.home, expectedHome);
      const mcp = JSON.parse(seen.mcp);
      assert.ok(mcp.mcpServers["coder-threads"]);
      assert.match(
        mcp.mcpServers["coder-threads"].url,
        new RegExp(`projectId=${project.id}`),
      );
      assert.ok(!mcp.mcpServers.girder);
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
