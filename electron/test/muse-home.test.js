"use strict";

/**
 * Isolated Muse XDG overlay (issue #873). A Solenta muse turn must not
 * inherit the user's other MCP servers. Child env is XDG_CONFIG_HOME +
 * XDG_DATA_HOME; there is no first-party MUSE_HOME.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  materializeMuseHome,
  museChildEnv,
  toMuseMcpServers,
} = require("../muse.js");

describe("materializeMuseHome", () => {
  let sourceConfig;
  let sourceData;
  let dest;

  beforeEach(() => {
    sourceConfig = fs.mkdtempSync(path.join(os.tmpdir(), "muse-cfg-"));
    sourceData = fs.mkdtempSync(path.join(os.tmpdir(), "muse-data-"));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), "muse-dst-"));
  });

  afterEach(() => {
    fs.rmSync(sourceConfig, { recursive: true, force: true });
    fs.rmSync(sourceData, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it("writes schema_version 1 settings with only Solenta MCP and does not copy user settings", () => {
    fs.mkdirSync(path.join(sourceConfig, "muse"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceConfig, "muse", "settings.json"),
      JSON.stringify({ schema_version: 1, mcp_servers: { leaked: { transport: "stdio", command: "evil" } } }),
    );
    fs.writeFileSync(path.join(sourceConfig, "muse", "auth.json"), '{"token":"keep"}\n');
    fs.mkdirSync(path.join(sourceData, "muse", "sessions"), { recursive: true });

    materializeMuseHome({
      dest,
      sourceConfigDir: path.join(sourceConfig, "muse"),
      sourceDataDir: path.join(sourceData, "muse"),
      mcpServers: {
        "coder-memory": {
          type: "http",
          url: "http://127.0.0.1:9/mcp?project=%2Ftmp%2Falpha",
          headers: { Authorization: "Bearer mem" },
        },
      },
    });

    const settings = JSON.parse(
      fs.readFileSync(path.join(dest, "config", "muse", "settings.json"), "utf8"),
    );
    assert.equal(settings.schema_version, 1);
    assert.equal(settings.mcp_servers.leaked, undefined);
    assert.equal(settings.mcp_servers["coder-memory"].transport, "streamable_http");
    assert.equal(settings.mcp_servers["coder-memory"].mode, "optional");
    assert.ok(
      fs.lstatSync(path.join(dest, "config", "muse", "auth.json")).isSymbolicLink(),
    );
    assert.ok(
      fs.lstatSync(path.join(dest, "share", "muse", "sessions")).isSymbolicLink(),
    );
    assert.equal(
      fs.lstatSync(path.join(dest, "config", "muse", "settings.json")).isSymbolicLink(),
      false,
    );
  });

  it("throws when dest is empty", () => {
    assert.throws(() => materializeMuseHome({ dest: "" }), /dest required/);
  });

  it("sets child XDG env without HOME or MUSE_HOME", () => {
    const env = museChildEnv(dest);
    assert.equal(env.XDG_CONFIG_HOME, path.join(dest, "config"));
    assert.equal(env.XDG_DATA_HOME, path.join(dest, "share"));
    assert.equal(env.HOME, undefined);
    assert.equal(env.MUSE_HOME, undefined);
  });

  it("writes solenta-hooks.json and points managed_hooks_path at it when hookCommand is set", () => {
    materializeMuseHome({
      dest,
      mcpServers: {},
      hookCommand: "node /tmp/muse-guardrail-hook.js",
    });
    const hooksPath = path.join(dest, "solenta-hooks.json");
    const settings = JSON.parse(
      fs.readFileSync(path.join(dest, "config", "muse", "settings.json"), "utf8"),
    );
    assert.equal(settings.managed_hooks_path, hooksPath);
    assert.equal(fs.existsSync(hooksPath), true);
    const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
    assert.ok(Array.isArray(hooks));
    assert.equal(hooks[0].event, "PreToolUse");
    assert.equal(hooks[0].command, "node /tmp/muse-guardrail-hook.js");
    assert.equal(hooks[0].timeout, 15);
  });
});

describe("toMuseMcpServers", () => {
  it("maps kimiMcpServersForRun http and stdio shapes", () => {
    const mcp = toMuseMcpServers({
      "coder-memory": {
        type: "http",
        url: "http://127.0.0.1:9/mcp?project=%2Ftmp%2Falpha",
        headers: { Authorization: "Bearer mem" },
      },
      local: {
        type: "stdio",
        command: "/bin/echo",
        args: ["--stdio"],
      },
    });
    assert.equal(mcp["coder-memory"].transport, "streamable_http");
    assert.equal(
      mcp["coder-memory"].url,
      "http://127.0.0.1:9/mcp?project=%2Ftmp%2Falpha",
    );
    assert.equal(mcp["coder-memory"].headers.Authorization, "Bearer mem");
    assert.equal(mcp["coder-memory"].enabled, true);
    assert.equal(mcp["coder-memory"].mode, "optional");
    assert.equal(mcp.local.transport, "stdio");
    assert.equal(mcp.local.command, "/bin/echo");
    assert.deepEqual(mcp.local.args, ["--stdio"]);
    assert.equal(mcp.local.enabled, true);
    assert.equal(mcp.local.mode, "optional");
  });
});
