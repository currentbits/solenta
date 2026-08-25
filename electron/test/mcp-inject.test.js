/**
 * Provider injection for remote HTTP + local stdio user MCP servers.
 * Run: node --test electron/test/mcp-inject.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  activeServers,
  getClaudeMcpArgs,
  getCodexMcpArgs,
  getCodexMcpEnv,
  tomlEscape,
  getGrokMcpEnv,
  mergeGrokSpawnEnv,
  ensureKimiMcpConfig,
  ensureGrokMcpConfig,
  registerMcpServer,
  resetMemorySupForTests,
  syncUserMcpServers,
  whenGrokMcpIdle,
} = require("../memory-sup.js");
const { writeFakeBin } = require("./support/fakeBin.js");

function waitFor(predicate, { timeoutMs = 3000, intervalMs = 20 } = {}) {
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

describe("syncUserMcpServers remote + stdio injection", () => {
  let tmp;
  let prevEnv;
  let mcpArgvFile;
  let fakeGrok;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-mcp-inject-"));
    prevEnv = {
      CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
      CODER_GROK_BIN: process.env.CODER_GROK_BIN,
      CODER_GROK_CONFIG_PATH: process.env.CODER_GROK_CONFIG_PATH,
      CODER_FAKE_GROK_MCP_ARGV_FILE: process.env.CODER_FAKE_GROK_MCP_ARGV_FILE,
    };
    process.env.CODER_KIMI_MCP_PATH = path.join(tmp, "kimi-mcp.json");
    process.env.CODER_GROK_CONFIG_PATH = path.join(tmp, "grok-config.toml");
    process.env.CODER_GROK_MCP_DISABLE = "1";
    mcpArgvFile = path.join(tmp, "grok-argv.jsonl");
    const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
if (process.env.CODER_FAKE_GROK_MCP_ARGV_FILE) {
  fs.appendFileSync(
    process.env.CODER_FAKE_GROK_MCP_ARGV_FILE,
    JSON.stringify({
      argv: process.argv.slice(2),
      env: {
        CODER_MCP_TOKEN_TEAM_TOOLS: process.env.CODER_MCP_TOKEN_TEAM_TOOLS || null,
        CODER_MCP_HEADER_TEAM_TOOLS_X_API_KEY:
          process.env.CODER_MCP_HEADER_TEAM_TOOLS_X_API_KEY || null,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN || null,
      },
    }) + "\\n",
    "utf8",
  );
}
process.exit(0);
`;
    fakeGrok = writeFakeBin(path.join(tmp, "fake-grok-mcp"), body);
    resetMemorySupForTests();
  });

  afterEach(async () => {
    await whenGrokMcpIdle();
    resetMemorySupForTests();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function remoteAndStdio() {
    return [
      {
        name: "team-tools",
        transport: "http",
        url: "https://tools.example.com/mcp",
        token: "remote-tok",
        headers: { "X-Api-Key": "hdr" },
        enabled: true,
      },
      {
        name: "local-tools",
        transport: "stdio",
        command: "/usr/bin/mcp-server",
        args: ["--stdio", 'quoted"val'],
        env: { GITHUB_TOKEN: "ghp-secret" },
        enabled: true,
        trusted: true,
      },
    ];
  }

  it("active entries carry transport and the correct fields", () => {
    syncUserMcpServers(remoteAndStdio(), { userDataPath: tmp });
    const byName = Object.fromEntries(activeServers().map((s) => [s.name, s]));
    assert.equal(byName["team-tools"].transport, "http");
    assert.equal(byName["team-tools"].url, "https://tools.example.com/mcp");
    assert.equal(byName["team-tools"].token, "remote-tok");
    assert.equal(byName["team-tools"].headers["X-Api-Key"], "hdr");
    assert.equal(byName["local-tools"].transport, "stdio");
    assert.equal(byName["local-tools"].command, "/usr/bin/mcp-server");
    assert.deepEqual(byName["local-tools"].args, ["--stdio", 'quoted"val']);
    assert.deepEqual(byName["local-tools"].env, { GITHUB_TOKEN: "ghp-secret" });
    assert.equal(byName["local-tools"].trusted, true);
  });

  it("injects HTTP + stdio into Claude JSON; Codex uses env_vars not secret argv", () => {
    syncUserMcpServers(remoteAndStdio(), { userDataPath: tmp });

    const args = getClaudeMcpArgs();
    assert.ok(args[0].startsWith("--mcp-config="));
    const cfg = JSON.parse(
      fs.readFileSync(args[0].slice("--mcp-config=".length), "utf8"),
    );
    assert.deepEqual(cfg.mcpServers["team-tools"], {
      type: "http",
      url: "https://tools.example.com/mcp",
      headers: {
        Authorization: "Bearer remote-tok",
        "X-Api-Key": "hdr",
      },
    });
    assert.deepEqual(cfg.mcpServers["local-tools"], {
      type: "stdio",
      command: "/usr/bin/mcp-server",
      args: ["--stdio", 'quoted"val'],
      env: { GITHUB_TOKEN: "ghp-secret" },
    });

    const codex = getCodexMcpArgs();
    const pairs = [];
    for (let i = 0; i < codex.length; i += 2) {
      assert.equal(codex[i], "-c");
      pairs.push(codex[i + 1]);
    }
    assert.ok(
      pairs.includes(
        'mcp_servers.team-tools.url="https://tools.example.com/mcp"',
      ),
    );
    assert.ok(
      pairs.includes(
        'mcp_servers.team-tools.bearer_token_env_var="CODER_MCP_TOKEN_TEAM_TOOLS"',
      ),
    );
    assert.ok(
      pairs.includes('mcp_servers.local-tools.command="/usr/bin/mcp-server"'),
    );
    assert.ok(
      pairs.some(
        (p) =>
          p.startsWith("mcp_servers.local-tools.args=") &&
          p.includes("--stdio") &&
          p.includes('quoted\\"val'),
      ),
      `expected escaped stdio args, got ${JSON.stringify(pairs)}`,
    );
    assert.ok(
      pairs.some(
        (p) =>
          p.startsWith("mcp_servers.local-tools.env_vars=") &&
          p.includes("GITHUB_TOKEN"),
      ),
      `expected env_vars names, got ${JSON.stringify(pairs)}`,
    );
    assert.ok(
      !pairs.some((p) => p.includes("ghp-secret")),
      "Codex argv must not carry stdio env values",
    );
    assert.ok(!pairs.some((p) => p.includes("mcp_servers.local-tools.url=")));
    assert.ok(!pairs.some((p) => p.startsWith("mcp_servers.local-tools.env=")));
    assert.ok(
      pairs.some(
        (p) =>
          p.startsWith("mcp_servers.team-tools.env_http_headers=") &&
          p.includes("X-Api-Key") &&
          p.includes("CODER_MCP_HEADER_TEAM_TOOLS_X_API_KEY"),
      ),
      `expected env_http_headers names, got ${JSON.stringify(pairs)}`,
    );
    assert.ok(
      !pairs.some((p) => p.includes("remote-tok") || p.includes("hdr")),
      "Codex argv must not carry remote secret values",
    );
    assert.deepEqual(getCodexMcpEnv(), {
      CODER_MCP_TOKEN_TEAM_TOOLS: "remote-tok",
      CODER_MCP_HEADER_TEAM_TOOLS_X_API_KEY: "hdr",
      GITHUB_TOKEN: "ghp-secret",
    });
  });

  it("omits SSE from Codex with a logged limitation; Kimi emits type sse", () => {
    const logs = [];
    const origWarn = console.warn;
    console.warn = (msg) => logs.push(String(msg));
    try {
      syncUserMcpServers(
        [
          {
            name: "sse-tools",
            transport: "sse",
            url: "https://sse.example.com/mcp",
            token: "sse-tok",
            headers: { "X-Api-Key": "sse-hdr" },
            enabled: true,
          },
        ],
        { userDataPath: tmp, log: (m) => logs.push(String(m)) },
      );
      const pairs = [];
      const args = getCodexMcpArgs();
      for (let i = 0; i < args.length; i += 2) pairs.push(args[i + 1]);
      assert.ok(
        !pairs.some((p) => p.includes("sse-tools")),
        "Codex only supports streamable HTTP",
      );
    } finally {
      console.warn = origWarn;
    }
    assert.ok(
      logs.some((m) => /codex/i.test(m) && /sse/i.test(m) && /sse-tools/.test(m)),
      `expected Codex SSE limitation log, got ${JSON.stringify(logs)}`,
    );
    ensureKimiMcpConfig({
      log: () => {},
      isKimiAvailable: () => true,
    });
    const doc = JSON.parse(
      fs.readFileSync(process.env.CODER_KIMI_MCP_PATH, "utf8"),
    );
    assert.deepEqual(doc.mcpServers["sse-tools"], {
      type: "sse",
      url: "https://sse.example.com/mcp",
      headers: {
        Authorization: "Bearer sse-tok",
        "X-Api-Key": "sse-hdr",
      },
    });
  });

  it("escapes a legal HTTP URL so Codex -c cannot create an extra TOML key", () => {
    const url = 'https://a.example.com/mcp?x="&mcp_servers.evil.command="id';
    syncUserMcpServers(
      [
        {
          name: "team-tools",
          transport: "http",
          url,
          enabled: true,
        },
      ],
      { userDataPath: tmp },
    );
    const pairs = [];
    const args = getCodexMcpArgs();
    for (let i = 0; i < args.length; i += 2) {
      assert.equal(args[i], "-c");
      pairs.push(args[i + 1]);
    }
    const urlArg = pairs.find((p) => p.startsWith("mcp_servers.team-tools.url="));
    const escaped =
      'mcp_servers.team-tools.url="https://a.example.com/mcp?x=\\"&mcp_servers.evil.command=\\"id"';
    assert.equal(urlArg, escaped);
    assert.equal(urlArg, `mcp_servers.team-tools.url="${tomlEscape(url)}"`);
    assert.match(
      urlArg,
      /^mcp_servers\.team-tools\.url="(?:\\.|[^"\\])*"$/,
      "url= must be one TOML basic string; an unescaped quote would start another key",
    );
  });

  it("tomlEscape uses exact TOML basic-string escapes including CR/LF/controls", () => {
    assert.equal(tomlEscape('a"b\\c'), 'a\\"b\\\\c');
    assert.equal(tomlEscape("line\nfeed"), "line\\nfeed");
    assert.equal(tomlEscape("ret\rurn"), "ret\\rurn");
    assert.equal(tomlEscape("tab\there"), "tab\\there");
    assert.equal(tomlEscape("nul\0end"), "nul\\u0000end");
    assert.equal(tomlEscape("bell\u0007x"), "bell\\u0007x");
  });

  it("escapes stdio cwd in Codex -c output", () => {
    const cwd = path.join(tmp, 'foo"bar');
    fs.mkdirSync(cwd);
    syncUserMcpServers(
      [
        {
          name: "local-tools",
          transport: "stdio",
          command: "/usr/bin/mcp-server",
          args: [],
          env: {},
          cwd,
          enabled: true,
          trusted: true,
        },
      ],
      { userDataPath: tmp },
    );
    const pairs = [];
    const args = getCodexMcpArgs();
    for (let i = 0; i < args.length; i += 2) {
      assert.equal(args[i], "-c");
      pairs.push(args[i + 1]);
    }
    const cwdArg = pairs.find((p) => p.startsWith("mcp_servers.local-tools.cwd="));
    assert.equal(cwdArg, `mcp_servers.local-tools.cwd="${tomlEscape(cwd)}"`);
    assert.match(cwdArg, /^mcp_servers\.local-tools\.cwd="(?:\\.|[^"\\])*"$/);
    assert.ok(cwdArg.includes('\\"'), "quote in cwd must be TOML-escaped");
  });

  it("writes Kimi HTTP as today plus an equivalent stdio entry", () => {
    syncUserMcpServers(remoteAndStdio(), { userDataPath: tmp });
    const ok = ensureKimiMcpConfig({
      log: () => {},
      isKimiAvailable: () => true,
    });
    assert.equal(ok, true);
    const doc = JSON.parse(
      fs.readFileSync(process.env.CODER_KIMI_MCP_PATH, "utf8"),
    );
    assert.deepEqual(doc.mcpServers["team-tools"], {
      type: "http",
      url: "https://tools.example.com/mcp",
      headers: {
        Authorization: "Bearer remote-tok",
        "X-Api-Key": "hdr",
      },
    });
    assert.deepEqual(doc.mcpServers["local-tools"], {
      type: "stdio",
      command: "/usr/bin/mcp-server",
      args: ["--stdio", 'quoted"val'],
      env: { GITHUB_TOKEN: "ghp-secret" },
    });
  });

  it("registers grok stdio with official add -- command args and env refs, not secret argv", async () => {
    syncUserMcpServers(remoteAndStdio(), { userDataPath: tmp });
    if (fs.existsSync(mcpArgvFile)) fs.unlinkSync(mcpArgvFile);
    const grokEnv = {
      ...process.env,
      CODER_GROK_BIN: fakeGrok,
      CODER_FAKE_GROK_MCP_ARGV_FILE: mcpArgvFile,
    };
    delete grokEnv.CODER_GROK_MCP_DISABLE;
    const ok = ensureGrokMcpConfig({
      log: () => {},
      env: grokEnv,
    });
    assert.equal(ok, true);
    await waitFor(() => {
      if (!fs.existsSync(mcpArgvFile)) return false;
      return fs.readFileSync(mcpArgvFile, "utf8").trim().split("\n").length >= 2;
    });
    const jobs = fs
      .readFileSync(mcpArgvFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const remote = jobs.find((j) => j.argv.includes("team-tools"));
    const local = jobs.find((j) => j.argv.includes("local-tools"));
    assert.ok(remote, `expected remote job, got ${JSON.stringify(jobs)}`);
    assert.deepEqual(remote.argv, [
      "mcp",
      "add",
      "--transport",
      "http",
      "team-tools",
      "https://tools.example.com/mcp",
      "--header",
      "Authorization: Bearer ${CODER_MCP_TOKEN_TEAM_TOOLS}",
      "--header",
      "X-Api-Key: ${CODER_MCP_HEADER_TEAM_TOOLS_X_API_KEY}",
      "--scope",
      "user",
    ]);
    assert.equal(remote.env.CODER_MCP_TOKEN_TEAM_TOOLS, "remote-tok");
    assert.equal(remote.env.CODER_MCP_HEADER_TEAM_TOOLS_X_API_KEY, "hdr");
    assert.ok(
      !JSON.stringify(remote.argv).includes("remote-tok"),
      "Grok argv must not include remote token",
    );
    assert.ok(
      !JSON.stringify(remote.argv).includes("hdr"),
      "Grok argv must not include header secret",
    );
    const dash = local.argv.indexOf("--");
    assert.ok(dash >= 0, `expected -- separator, got ${JSON.stringify(local)}`);
    assert.deepEqual(local.argv.slice(0, 3), ["mcp", "add", "local-tools"]);
    assert.deepEqual(local.argv.slice(dash), [
      "--",
      "/usr/bin/mcp-server",
      "--stdio",
      'quoted"val',
    ]);
    const scopeAt = local.argv.indexOf("--scope");
    assert.ok(scopeAt >= 0 && scopeAt < dash);
    assert.equal(local.argv[scopeAt + 1], "user");
    assert.ok(
      !JSON.stringify(local.argv).includes("ghp-secret"),
      "Grok argv must not include stdio env values",
    );
    const envFlag = local.argv.findIndex((a) => a === "--env" || a === "-e");
    assert.ok(envFlag >= 0 && envFlag < dash);
    assert.match(local.argv[envFlag + 1], /GITHUB_TOKEN=\$\{GITHUB_TOKEN\}/);
    assert.equal(local.env.GITHUB_TOKEN, "ghp-secret");
    assert.deepEqual(getGrokMcpEnv(), {
      CODER_MCP_TOKEN_TEAM_TOOLS: "remote-tok",
      CODER_MCP_HEADER_TEAM_TOOLS_X_API_KEY: "hdr",
      GITHUB_TOKEN: "ghp-secret",
    });
    assert.deepEqual(mergeGrokSpawnEnv({ OTEL_X: "1" }), {
      OTEL_X: "1",
      CODER_MCP_TOKEN_TEAM_TOOLS: "remote-tok",
      CODER_MCP_HEADER_TEAM_TOOLS_X_API_KEY: "hdr",
      GITHUB_TOKEN: "ghp-secret",
    });
    const grokCfg = process.env.CODER_GROK_CONFIG_PATH;
    if (grokCfg && fs.existsSync(grokCfg)) {
      assert.ok(
        !fs.readFileSync(grokCfg, "utf8").includes("ghp-secret"),
        "Grok config must not persist stdio env secret literals",
      );
    }
  });

  it("excludes disabled and untrusted stdio and removes them when they go stale", () => {
    registerMcpServer({
      name: "coder-threads",
      port: 4317,
      token: "secret",
      userDataPath: tmp,
    });
    syncUserMcpServers(
      [
        {
          name: "off-remote",
          transport: "http",
          url: "https://off.example.com/mcp",
          enabled: false,
        },
        {
          name: "untrusted",
          transport: "stdio",
          command: "/bin/echo",
          args: [],
          enabled: true,
          trusted: false,
        },
        {
          name: "local-tools",
          transport: "stdio",
          command: "/bin/echo",
          args: [],
          enabled: true,
          trusted: true,
        },
      ],
      { userDataPath: tmp },
    );
    assert.deepEqual(
      activeServers().map((s) => s.name).sort(),
      ["coder-threads", "local-tools"],
    );

    syncUserMcpServers(
      [
        {
          name: "local-tools",
          transport: "stdio",
          command: "/bin/echo",
          args: [],
          enabled: false,
          trusted: true,
        },
      ],
      { userDataPath: tmp },
    );
    assert.deepEqual(activeServers().map((s) => s.name), ["coder-threads"]);
  });

  it("excludes Grok stdio servers that need cwd and logs the limitation", async () => {
    const logs = [];
    const cwd = path.join(tmp, "stdio-cwd");
    fs.mkdirSync(cwd);
    syncUserMcpServers(
      [
        {
          name: "needs-cwd",
          transport: "stdio",
          command: "/bin/echo",
          args: [],
          cwd,
          enabled: true,
          trusted: true,
        },
        {
          name: "no-cwd",
          transport: "stdio",
          command: "/bin/echo",
          args: [],
          enabled: true,
          trusted: true,
        },
      ],
      { userDataPath: tmp, log: (m) => logs.push(String(m)) },
    );
    assert.deepEqual(
      activeServers().map((s) => s.name).sort(),
      ["needs-cwd", "no-cwd"],
    );
    if (fs.existsSync(mcpArgvFile)) fs.unlinkSync(mcpArgvFile);
    const grokEnv = {
      ...process.env,
      CODER_GROK_BIN: fakeGrok,
      CODER_FAKE_GROK_MCP_ARGV_FILE: mcpArgvFile,
    };
    delete grokEnv.CODER_GROK_MCP_DISABLE;
    ensureGrokMcpConfig({ log: (m) => logs.push(String(m)), env: grokEnv });
    await waitFor(() => {
      if (!fs.existsSync(mcpArgvFile)) return false;
      return fs.readFileSync(mcpArgvFile, "utf8").trim().length > 0;
    });
    const jobs = fs
      .readFileSync(mcpArgvFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.ok(
      jobs.some((j) => j.argv.includes("no-cwd")),
      "stdio without cwd must still register",
    );
    assert.ok(
      !jobs.some((j) => j.argv.includes("needs-cwd")),
      "Grok CLI cannot express cwd; must not silently drop it onto add",
    );
    assert.ok(
      logs.some((m) => /cwd/i.test(m) && /needs-cwd/.test(m) && /grok/i.test(m)),
      `expected Grok cwd limitation log, got ${JSON.stringify(logs)}`,
    );
  });

  it("registerMcpServer rejects credentialed and control-character URLs", () => {
    assert.equal(
      registerMcpServer({
        name: "creds",
        url: "https://user:pass@evil.example.com/mcp",
        userDataPath: tmp,
      }),
      false,
    );
    assert.equal(
      registerMcpServer({
        name: "ctrl",
        url: "https://ok.example.com/mcp\n",
        userDataPath: tmp,
      }),
      false,
    );
    assert.deepEqual(activeServers().map((s) => s.name), []);
  });

  it("never uses a shell to inject MCP config", () => {
    const child = require("node:child_process");
    const spawnCalls = [];
    const execCalls = [];
    const origSpawn = child.spawn;
    const origExec = child.exec;
    child.spawn = (...a) => {
      spawnCalls.push(a);
      return origSpawn(...a);
    };
    child.exec = (...a) => {
      execCalls.push(a);
      return origExec(...a);
    };
    try {
      syncUserMcpServers(remoteAndStdio(), { userDataPath: tmp });
      assert.equal(execCalls.length, 0, "must not call child_process.exec");
      assert.ok(
        spawnCalls.every((c) => !c[2] || c[2].shell !== true),
        `spawn must not use shell: ${JSON.stringify(spawnCalls)}`,
      );
    } finally {
      child.spawn = origSpawn;
      child.exec = origExec;
    }
  });
});
