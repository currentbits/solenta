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
    const overlaySessions = fs.lstatSync(path.join(dest, "sessions"));
    assert.equal(
      overlaySessions.isSymbolicLink(),
      false,
      "overlay sessions must not be a symlink into ~/.grok (grok stale-session GC deletes through it)",
    );
    assert.ok(overlaySessions.isDirectory());
    const mode = fs.statSync(path.join(dest, "config.toml")).mode & 0o777;
    if (process.platform === "win32") {
      // Node's Windows chmod only implements the read-only flag. writeSecretFile
      // still requests 0o600; a writable file stats as 0o666 because group/other
      // bits are not stored.
      assert.equal(mode & 0o200, 0o200, `secret file must stay writable, got ${mode.toString(8)}`);
    } else {
      assert.equal(mode, 0o600);
    }
  });

  it("does not resurrect auth.json after grok deleted the overlay copy", () => {
    materializeGrokHome({ dest, sourceHome: source });
    fs.unlinkSync(path.join(dest, "auth.json"));

    materializeGrokHome({ dest, sourceHome: source });

    assert.equal(
      fs.existsSync(path.join(dest, "auth.json")),
      false,
      "re-linking the same rejected credentials makes grok retry RefreshTokenRejected and print Not signed in",
    );
    assert.equal(
      fs.readFileSync(path.join(source, "auth.json"), "utf8"),
      '{"token":"keep"}\n',
      "source ~/.grok/auth.json must stay intact",
    );
  });

  it("re-links auth.json once source credentials change after a grok delete", () => {
    materializeGrokHome({ dest, sourceHome: source });
    fs.unlinkSync(path.join(dest, "auth.json"));
    materializeGrokHome({ dest, sourceHome: source });
    assert.equal(fs.existsSync(path.join(dest, "auth.json")), false);

    fs.writeFileSync(path.join(source, "auth.json"), '{"token":"fresh-login"}\n');
    materializeGrokHome({ dest, sourceHome: source });

    const overlayAuth = path.join(dest, "auth.json");
    assert.ok(fs.lstatSync(overlayAuth).isSymbolicLink());
    assert.equal(
      fs.readFileSync(overlayAuth, "utf8"),
      '{"token":"fresh-login"}\n',
    );
  });

  it("replaces a grok-written regular auth.json with a symlink after login", () => {
    materializeGrokHome({ dest, sourceHome: source });
    fs.unlinkSync(path.join(dest, "auth.json"));
    fs.writeFileSync(path.join(dest, "auth.json"), "{}\n");

    materializeGrokHome({ dest, sourceHome: source });
    assert.equal(
      fs.lstatSync(path.join(dest, "auth.json")).isSymbolicLink(),
      false,
      "same rejected credentials must not be restored over grok's cleared file",
    );

    fs.writeFileSync(path.join(source, "auth.json"), '{"token":"fresh-login"}\n');
    materializeGrokHome({ dest, sourceHome: source });
    assert.ok(fs.lstatSync(path.join(dest, "auth.json")).isSymbolicLink());
    assert.equal(
      fs.readFileSync(path.join(dest, "auth.json"), "utf8"),
      '{"token":"fresh-login"}\n',
    );
  });

  it("shares auth.json.lock with the real grok home so refresh is serialized", () => {
    fs.writeFileSync(path.join(source, "auth.json.lock"), "src-lock\n");
    materializeGrokHome({ dest, sourceHome: source });
    const overlayLock = path.join(dest, "auth.json.lock");
    assert.ok(fs.lstatSync(overlayLock).isSymbolicLink());
    assert.equal(fs.realpathSync(overlayLock), fs.realpathSync(path.join(source, "auth.json.lock")));
  });

  it("replaces an overlay-private auth.json.lock with a symlink to the real lock", () => {
    fs.writeFileSync(path.join(source, "auth.json.lock"), "src-lock\n");
    materializeGrokHome({ dest, sourceHome: source });
    fs.unlinkSync(path.join(dest, "auth.json.lock"));
    fs.writeFileSync(path.join(dest, "auth.json.lock"), "overlay-private\n");

    materializeGrokHome({ dest, sourceHome: source });

    const overlayLock = path.join(dest, "auth.json.lock");
    assert.ok(fs.lstatSync(overlayLock).isSymbolicLink());
    assert.equal(fs.readFileSync(overlayLock, "utf8"), "src-lock\n");
  });

  it("replaces a leftover sessions symlink without following it", () => {
    const keep = path.join(source, "sessions", "keep-me.json");
    fs.writeFileSync(keep, "source-session\n");
    fs.rmSync(path.join(dest, "sessions"), { recursive: true, force: true });
    fs.symlinkSync(path.join(source, "sessions"), path.join(dest, "sessions"));

    materializeGrokHome({ dest, sourceHome: source });

    const overlaySessions = path.join(dest, "sessions");
    assert.equal(
      fs.lstatSync(overlaySessions).isSymbolicLink(),
      false,
      "rematerialize must unlink the leftover sessions symlink",
    );
    assert.ok(fs.lstatSync(overlaySessions).isDirectory());
    assert.equal(
      fs.readFileSync(keep, "utf8"),
      "source-session\n",
      "unlinking overlay/sessions must not follow into ~/.grok",
    );
  });

  it("does not let overlay session GC delete the source session store", () => {
    const encodedCwd = encodeURIComponent("/tmp/proj");
    const otherId = "01a0other-session";
    const otherDir = path.join(source, "sessions", encodedCwd, otherId);
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, "summary.json"), "keep-source\n");

    materializeGrokHome({ dest, sourceHome: source });

    const overlayOther = path.join(dest, "sessions", encodedCwd, otherId);
    if (fs.existsSync(overlayOther)) {
      // grok cleanup_stale_sessions deletes session folders inside
      // GROK_HOME/sessions, following a directory symlink into ~/.grok.
      fs.rmSync(overlayOther, { recursive: true, force: true });
    }
    assert.equal(
      fs.existsSync(path.join(otherDir, "summary.json")),
      true,
      "grok GC of overlay/sessions/<cwd>/<id> must not delete ~/.grok/sessions",
    );
    assert.equal(
      fs.readFileSync(path.join(otherDir, "summary.json"), "utf8"),
      "keep-source\n",
    );
  });

  it("copies only the resume session into the overlay so --resume still works", () => {
    const encodedCwd = encodeURIComponent("/tmp/proj");
    const resumeId = "01a0resume-session";
    const otherId = "01a0other-session";
    const resumeDir = path.join(source, "sessions", encodedCwd, resumeId);
    const otherDir = path.join(source, "sessions", encodedCwd, otherId);
    fs.mkdirSync(resumeDir, { recursive: true });
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(resumeDir, "summary.json"), "resume-me\n");
    fs.writeFileSync(path.join(otherDir, "summary.json"), "foreign\n");

    materializeGrokHome({ dest, sourceHome: source, sessionId: resumeId });

    const overlaySessions = path.join(dest, "sessions");
    assert.equal(fs.lstatSync(overlaySessions).isSymbolicLink(), false);
    assert.equal(
      fs.readFileSync(
        path.join(overlaySessions, encodedCwd, resumeId, "summary.json"),
        "utf8",
      ),
      "resume-me\n",
    );
    assert.equal(
      fs.existsSync(path.join(overlaySessions, encodedCwd, otherId)),
      false,
      "other ~/.grok sessions must not be visible to overlay GC",
    );
    fs.rmSync(path.join(overlaySessions, encodedCwd, resumeId), {
      recursive: true,
      force: true,
    });
    assert.equal(
      fs.readFileSync(path.join(resumeDir, "summary.json"), "utf8"),
      "resume-me\n",
      "resume session is a copy, so overlay GC cannot delete ~/.grok",
    );
    assert.equal(
      fs.readFileSync(path.join(otherDir, "summary.json"), "utf8"),
      "foreign\n",
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

/**
 * #812 / #827: overlay inject writes the live 1.0.13 PreToolUse shape
 * (config.toml [[hooks.PreToolUse]], source.type=configToml). The gate is
 * never written through GROK_HOME_LINKS "hooks" (user ~/.grok/hooks).
 */
describe("materializeGrokHome PreToolUse inject (#812)", () => {
  let source;
  let dest;
  let prevGuardrails;

  beforeEach(() => {
    prevGuardrails = process.env.CODER_GUARDRAILS;
    delete process.env.CODER_GUARDRAILS;
    source = fs.mkdtempSync(path.join(os.tmpdir(), "grok-src-"));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), "grok-dst-"));
    fs.writeFileSync(
      path.join(source, "config.toml"),
      "[marketplace]\nauto_update = true\n",
    );
    fs.writeFileSync(path.join(source, "auth.json"), '{"token":"keep"}\n');
  });

  afterEach(() => {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
    if (prevGuardrails === undefined) delete process.env.CODER_GUARDRAILS;
    else process.env.CODER_GUARDRAILS = prevGuardrails;
  });

  it("writes live-proven config.toml PreToolUse and copies hook next to guardrails.js", () => {
    materializeGrokHome({ dest, sourceHome: source });
    const overlay = fs.readFileSync(path.join(dest, "config.toml"), "utf8");
    assert.match(overlay, /auto_update = true/);
    assert.match(
      overlay,
      /\[\[hooks\.PreToolUse\]\]\nmatcher = ""\nhooks = \[\n  \{ type = "command", command = ".+", timeout = \d+ \},\n\]/,
    );
    assert.match(overlay, /grok-guardrail-hook\.js/);
    assert.equal(
      overlay.includes("control_request"),
      false,
      "overlay must not invent a control_request path",
    );

    const hookDest = path.join(dest, "grok-guardrail-hook.js");
    const policyDest = path.join(dest, "guardrails.js");
    assert.equal(fs.existsSync(hookDest), true);
    assert.equal(fs.existsSync(policyDest), true);
    assert.equal(fs.lstatSync(hookDest).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(policyDest).isSymbolicLink(), false);
    assert.equal(path.dirname(hookDest), path.dirname(policyDest));

    const src = fs.readFileSync(path.join(source, "config.toml"), "utf8");
    assert.equal(src.includes("[[hooks.PreToolUse]]"), false);
  });

  it("does not put the gate on the GROK_HOME_LINKS hooks/ symlink", () => {
    const userHooks = path.join(source, "hooks");
    fs.mkdirSync(userHooks);
    fs.writeFileSync(path.join(userHooks, "agentmux.json"), "{}\n");

    materializeGrokHome({ dest, sourceHome: source });

    const destHooks = path.join(dest, "hooks");
    assert.ok(
      fs.lstatSync(destHooks).isSymbolicLink(),
      "hooks/ stays the GROK_HOME_LINKS symlink to the user home",
    );
    assert.equal(fs.realpathSync(destHooks), fs.realpathSync(userHooks));
    assert.equal(fs.existsSync(path.join(userHooks, "grok-guardrail-hook.js")), false);
    assert.equal(fs.existsSync(path.join(destHooks, "grok-guardrail-hook.js")), false);

    const hookDest = path.join(dest, "grok-guardrail-hook.js");
    assert.equal(fs.existsSync(hookDest), true);
    assert.equal(fs.lstatSync(hookDest).isSymbolicLink(), false);

    const overlay = fs.readFileSync(path.join(dest, "config.toml"), "utf8");
    assert.match(overlay, /\[\[hooks\.PreToolUse\]\]/);
    assert.match(overlay, /grok-guardrail-hook\.js/);
    assert.equal(
      overlay.includes(`${destHooks}${path.sep}`),
      false,
      "command must not point at the hooks/ symlink",
    );
  });

  it("skips the hook when CODER_GUARDRAILS=off", () => {
    process.env.CODER_GUARDRAILS = "off";
    materializeGrokHome({ dest, sourceHome: source });
    const overlay = fs.readFileSync(path.join(dest, "config.toml"), "utf8");
    assert.equal(overlay.includes("[[hooks.PreToolUse]]"), false);
    assert.equal(fs.existsSync(path.join(dest, "grok-guardrail-hook.js")), false);
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
