/**
 * MCP settings model: legacy HTTP migration, stdio, strict validation.
 * Run: node --test electron/test/mcp-model.test.js
 */
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeMcpServers,
  validateMcpServers,
} = require("../store.js");

const HTTP = {
  name: "team-tools",
  transport: "http",
  url: "https://tools.example.com/mcp",
  enabled: true,
  headers: {},
};

const STDIO = {
  name: "local-tools",
  transport: "stdio",
  command: "/usr/bin/mcp-server",
  args: ["--stdio"],
  env: {},
  enabled: true,
  trusted: true,
};

describe("normalizeMcpServers", () => {
  it("migrates legacy {name,url,token,enabled} to explicit http without data loss", () => {
    const out = normalizeMcpServers([
      {
        name: "legacy",
        url: "https://old.example.com/mcp",
        token: "keep-me",
        enabled: false,
      },
    ]);
    assert.deepEqual(out, [
      {
        name: "legacy",
        transport: "http",
        url: "https://old.example.com/mcp",
        token: "keep-me",
        enabled: false,
        headers: {},
      },
    ]);
  });

  it("canonicalizes stdio with stable empty args/env", () => {
    const out = normalizeMcpServers([
      {
        name: "local-tools",
        transport: "stdio",
        command: "/usr/bin/mcp-server",
        enabled: true,
        trusted: true,
      },
    ]);
    assert.deepEqual(out, [{ ...STDIO, args: [] }]);
  });

  it("drops reserved, invalid, duplicate, non-http, and credentialed URLs; coerces enabled", () => {
    const out = normalizeMcpServers([
      { name: "ok-one", url: "https://a.example.com/mcp", token: "t" },
      { name: "coder-memory", url: "https://b.example.com/mcp" },
      { name: "Bad Name", url: "https://c.example.com/mcp" },
      { name: "no-url" },
      { name: "ok-one", url: "https://dup.example.com/mcp" },
      { name: "ftp-one", url: "ftp://a.example.com/mcp" },
      { name: "creds", url: "https://user:pass@a.example.com/mcp" },
      { name: "off", url: "http://127.0.0.1:9000/mcp", enabled: 0 },
      "garbage",
      null,
      [{ name: "array-not-object", url: "https://a.example.com/mcp" }],
    ]);
    assert.deepEqual(out, [
      {
        name: "ok-one",
        transport: "http",
        url: "https://a.example.com/mcp",
        token: "t",
        enabled: true,
        headers: {},
      },
      {
        name: "off",
        transport: "http",
        url: "http://127.0.0.1:9000/mcp",
        enabled: true,
        headers: {},
      },
    ]);
  });

  it("returns [] for non-arrays and drops overlong names", () => {
    assert.deepEqual(normalizeMcpServers(null), []);
    assert.deepEqual(normalizeMcpServers("x"), []);
    const long = "n".repeat(65);
    assert.deepEqual(
      normalizeMcpServers([{ name: long, url: "https://a.example.com/mcp" }]),
      [],
    );
  });

  it("drops enabled stdio that is not trusted, keeps parked untrusted stdio", () => {
    const out = normalizeMcpServers([
      {
        name: "unsafe",
        transport: "stdio",
        command: "/bin/echo",
        enabled: true,
        trusted: false,
      },
      {
        name: "parked",
        transport: "stdio",
        command: "/bin/echo",
        enabled: false,
        trusted: false,
      },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "parked");
    assert.equal(out[0].trusted, false);
    assert.equal(out[0].enabled, false);
    assert.deepEqual(out[0].args, []);
    assert.deepEqual(out[0].env, {});
  });

  it("drops stdio entries whose cwd has CR/LF or is overlong", () => {
    const out = normalizeMcpServers([
      {
        name: "nl",
        transport: "stdio",
        command: "/bin/echo",
        cwd: "/tmp/ok\nbad",
        enabled: true,
        trusted: true,
      },
      {
        name: "wide",
        transport: "stdio",
        command: "/bin/echo",
        cwd: `/${"x".repeat(4096)}`,
        enabled: true,
        trusted: true,
      },
      {
        name: "ok-cwd",
        transport: "stdio",
        command: "/bin/echo",
        cwd: "/tmp/mcp-ok",
        enabled: true,
        trusted: true,
      },
    ]);
    assert.deepEqual(
      out.map((s) => s.name),
      ["ok-cwd"],
    );
    assert.equal(out[0].cwd, "/tmp/mcp-ok");
  });

  it("drops later stdio servers that disagree on an env key", () => {
    const out = normalizeMcpServers([
      {
        name: "one",
        transport: "stdio",
        command: "/bin/echo",
        env: { SHARED: "a" },
        enabled: true,
        trusted: true,
      },
      {
        name: "two",
        transport: "stdio",
        command: "/bin/cat",
        env: { SHARED: "b" },
        enabled: true,
        trusted: true,
      },
    ]);
    assert.deepEqual(
      out.map((s) => s.name),
      ["one"],
    );
  });
});

describe("validateMcpServers", () => {
  it("accepts explicit http (with headers) and trusted stdio", () => {
    const out = validateMcpServers([
      { ...HTTP, headers: { "X-Api-Key": "k" }, token: "t" },
      { ...STDIO, env: { GITHUB_TOKEN: "tok" } },
    ]);
    assert.equal(out[0].transport, "http");
    assert.equal(out[0].headers["X-Api-Key"], "k");
    assert.equal(out[0].token, "t");
    assert.equal(out[1].transport, "stdio");
    assert.equal(out[1].command, "/usr/bin/mcp-server");
    assert.deepEqual(out[1].args, ["--stdio"]);
    assert.deepEqual(out[1].env, { GITHUB_TOKEN: "tok" });
    assert.equal(out[1].trusted, true);
  });

  it("migrates legacy entries on the strict path too", () => {
    const out = validateMcpServers([
      { name: "legacy", url: "https://old.example.com/mcp", enabled: true },
    ]);
    assert.deepEqual(out[0], {
      name: "legacy",
      transport: "http",
      url: "https://old.example.com/mcp",
      enabled: true,
      headers: {},
    });
  });

  it("rejects name / reserved / duplicate / transport / non-object problems", () => {
    assert.throws(() => validateMcpServers("nope"), /must be an array/);
    assert.throws(
      () => validateMcpServers([{ name: "X", url: "https://a.b/mcp" }]),
      /name must be lowercase/,
    );
    assert.throws(
      () =>
        validateMcpServers([
          { name: "n".repeat(65), url: "https://a.b/mcp" },
        ]),
      /64/,
    );
    assert.throws(
      () =>
        validateMcpServers([
          { name: "coder-threads", url: "https://a.b/mcp" },
        ]),
      /reserved/,
    );
    assert.throws(
      () =>
        validateMcpServers([
          { name: "dup", url: "https://a.b/mcp" },
          { name: "dup", url: "https://c.d/mcp" },
        ]),
      /Duplicate/,
    );
    assert.throws(
      () =>
        validateMcpServers([
          { name: "ok", transport: "ftp", url: "https://a.b/mcp" },
        ]),
      /transport/,
    );
    assert.throws(
      () => validateMcpServers([[{ name: "ok", url: "https://a.b/mcp" }]]),
      /plain object/,
    );
  });

  it("rejects remote URL credentials, schemes, header CR/LF, and bounds", () => {
    assert.throws(
      () => validateMcpServers([{ name: "ok", url: "ftp://a.b/mcp" }]),
      /http\(s\)/,
    );
    assert.throws(
      () =>
        validateMcpServers([
          { name: "ok", url: "https://user:pass@a.b/mcp" },
        ]),
      /credential/i,
    );
    assert.throws(
      () =>
        validateMcpServers([
          { name: "ok", url: `https://a.b/${"x".repeat(2048)}` },
        ]),
      /2048/,
    );
    const tooMany = {};
    for (let i = 0; i < 33; i++) tooMany[`H${i}`] = "v";
    assert.throws(
      () =>
        validateMcpServers([
          { name: "ok", url: "https://a.b/mcp", headers: tooMany },
        ]),
      /32/,
    );
    assert.throws(
      () =>
        validateMcpServers([
          {
            name: "ok",
            url: "https://a.b/mcp",
            headers: { "Bad Name": "v" },
          },
        ]),
      /header/i,
    );
    assert.throws(
      () =>
        validateMcpServers([
          {
            name: "ok",
            url: "https://a.b/mcp",
            headers: { Ok: "v\n" },
          },
        ]),
      /CR|LF|NUL|newline/i,
    );
    assert.throws(
      () =>
        validateMcpServers([
          {
            name: "ok",
            url: "https://a.b/mcp",
            headers: { "X-Ok": "v\r" },
          },
        ]),
      /CR|LF|NUL|newline/i,
    );
    assert.throws(
      () =>
        validateMcpServers([
          { name: "ok", url: "https://a.b/mcp", headers: ["not", "object"] },
        ]),
      /headers/,
    );
  });

  it("rejects stdio injection, env keys, and the trust gate", () => {
    assert.throws(
      () =>
        validateMcpServers([
          {
            name: "ok",
            transport: "stdio",
            command: "echo\nboom",
            trusted: true,
          },
        ]),
      /command/,
    );
    assert.throws(
      () =>
        validateMcpServers([
          {
            name: "ok",
            transport: "stdio",
            command: "/bin/echo",
            args: ["ok\0"],
            trusted: true,
          },
        ]),
      /NUL|nul/i,
    );
    assert.throws(
      () =>
        validateMcpServers([
          {
            name: "ok",
            transport: "stdio",
            command: "/bin/echo",
            env: { "9BAD": "v" },
            trusted: true,
          },
        ]),
      /env/i,
    );
    assert.throws(
      () =>
        validateMcpServers([
          {
            name: "ok",
            transport: "stdio",
            command: "/bin/echo",
            env: { OK: "x\ny" },
            trusted: true,
          },
        ]),
      /env|newline|NUL/i,
    );
    assert.throws(
      () =>
        validateMcpServers([
          {
            name: "ok",
            transport: "stdio",
            command: "/bin/echo",
            enabled: true,
            trusted: false,
          },
        ]),
      /trusted/,
    );
  });

  it("does not require trusted when the stdio server is disabled", () => {
    const out = validateMcpServers([
      {
        name: "parked",
        transport: "stdio",
        command: "/bin/echo",
        enabled: false,
        trusted: false,
      },
    ]);
    assert.equal(out[0].trusted, false);
    assert.equal(out[0].enabled, false);
    assert.deepEqual(out[0].args, []);
    assert.deepEqual(out[0].env, {});
  });

  it("rejects two enabled stdio servers that disagree on the same env key", () => {
    assert.throws(
      () =>
        validateMcpServers([
          {
            name: "one",
            transport: "stdio",
            command: "/bin/echo",
            env: { SHARED: "a" },
            enabled: true,
            trusted: true,
          },
          {
            name: "two",
            transport: "stdio",
            command: "/bin/cat",
            env: { SHARED: "b" },
            enabled: true,
            trusted: true,
          },
        ]),
      /SHARED|conflict/i,
    );
  });

  it("allows the same env key when enabled stdio servers agree on the value", () => {
    const out = validateMcpServers([
      {
        name: "one",
        transport: "stdio",
        command: "/bin/echo",
        env: { SHARED: "same" },
        enabled: true,
        trusted: true,
      },
      {
        name: "two",
        transport: "stdio",
        command: "/bin/cat",
        env: { SHARED: "same" },
        enabled: true,
        trusted: true,
      },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].env.SHARED, "same");
    assert.equal(out[1].env.SHARED, "same");
  });

  it("rejects cwd with CR/LF/NUL, overlong cwd, and relative paths", () => {
    const base = {
      name: "ok",
      transport: "stdio",
      command: "/bin/echo",
      enabled: true,
      trusted: true,
    };
    assert.throws(
      () => validateMcpServers([{ ...base, cwd: "/tmp/ok\nbad" }]),
      /cwd|CR|LF|NUL|newline/i,
    );
    assert.throws(
      () => validateMcpServers([{ ...base, cwd: "/tmp/ok\rbad" }]),
      /cwd|CR|LF|NUL|newline/i,
    );
    assert.throws(
      () => validateMcpServers([{ ...base, cwd: "/tmp/ok\0bad" }]),
      /cwd|CR|LF|NUL|nul/i,
    );
    assert.throws(
      () => validateMcpServers([{ ...base, cwd: `/${"x".repeat(4096)}` }]),
      /4096|cwd/i,
    );
    assert.throws(
      () => validateMcpServers([{ ...base, cwd: "relative/path" }]),
      /absolute/i,
    );
    const kept = validateMcpServers([{ ...base, cwd: "/tmp/mcp-ok" }]);
    assert.equal(kept[0].cwd, "/tmp/mcp-ok");
  });

  it("canonicalizes remote URLs to URL.href", () => {
    const out = validateMcpServers([
      { name: "ok", url: "https://Example.COM:443/mcp" },
    ]);
    assert.equal(out[0].url, "https://example.com/mcp");
  });

  it("rejects prototype keys and non-plain header/env objects from JSON.parse", () => {
    const protoHeaders = JSON.parse(
      '{"name":"ok","url":"https://a.b/mcp","headers":{"__proto__":{"x":"1"}}}',
    );
    assert.throws(() => validateMcpServers([protoHeaders]), /prototype|__proto__/i);
    const ctorEnv = JSON.parse(
      '{"name":"ok","transport":"stdio","command":"/bin/echo","trusted":true,"env":{"constructor":"x"}}',
    );
    assert.throws(() => validateMcpServers([ctorEnv]), /prototype|constructor/i);
    const protoEnv = JSON.parse(
      '{"name":"ok","transport":"stdio","command":"/bin/echo","trusted":true,"env":{"prototype":"x"}}',
    );
    assert.throws(() => validateMcpServers([protoEnv]), /prototype/i);
    class Hdr {
      constructor() {
        this.Ok = "v";
      }
    }
    assert.throws(
      () =>
        validateMcpServers([
          { name: "ok", url: "https://a.b/mcp", headers: new Hdr() },
        ]),
      /plain object/,
    );
  });

  it("rejects process-control env names that could hijack a parent spawn", () => {
    for (const key of [
      "PATH",
      "NODE_OPTIONS",
      "NODE_PATH",
      "BASH_ENV",
      "ENV",
      "SHELLOPTS",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "ELECTRON_RUN_AS_NODE",
    ]) {
      assert.throws(
        () =>
          validateMcpServers([
            {
              name: "ok",
              transport: "stdio",
              command: "/bin/echo",
              env: { [key]: "x" },
              trusted: true,
            },
          ]),
        /process-control|env/i,
        `should reject ${key}`,
      );
    }
  });
});
