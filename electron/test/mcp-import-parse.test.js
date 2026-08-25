/**
 * Strict MCP import JSON parsing: shapes, rejection, secret templates.
 * Run: node --test electron/test/mcp-import-parse.test.js
 */
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseMcpImportDocument } = require("../mcp.js");

function wrap(servers) {
  return { mcpServers: servers };
}

describe("parseMcpImportDocument shapes", () => {
  it("parses {mcpServers:{name:definition}} with legacy url and type|transport", () => {
    const out = parseMcpImportDocument(
      wrap({
        "team-tools": {
          url: "https://tools.example.com/mcp",
          headers: { Authorization: "Bearer literal-keep" },
        },
        docs: { type: "sse", url: "https://sse.example.com/mcp" },
        other: { transport: "http", url: "https://http.example.com/mcp" },
      }),
    );
    const byName = Object.fromEntries(out.servers.map((s) => [s.stored.name, s]));
    assert.equal(byName["team-tools"].stored.transport, "http");
    assert.equal(byName["team-tools"].stored.url, "https://tools.example.com/mcp")
    assert.equal(byName.docs.stored.transport, "sse");
    assert.equal(byName.other.stored.transport, "http");
    assert.equal(byName["team-tools"].stored.headers.Authorization, "Bearer literal-keep");
  });

  it("parses a direct {name:definition} map only when every value is a plausible MCP definition", () => {
    const out = parseMcpImportDocument({
      "local-tools": {
        command: "/usr/bin/mcp-server",
        args: ["--stdio"],
        env: { API_KEY: "${API_KEY}" },
      },
      "team-tools": { url: "https://tools.example.com/mcp" },
    });
    assert.deepEqual(
      out.servers.map((s) => s.stored.name).sort(),
      ["local-tools", "team-tools"],
    );
    assert.equal(out.servers.find((s) => s.stored.name === "local-tools").stored.trusted, false);
    assert.equal(out.servers.find((s) => s.stored.name === "local-tools").stored.enabled, false);
  });

  it("parses a single {name,...definition} document", () => {
    const out = parseMcpImportDocument({
      name: "solo",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
    });
    assert.equal(out.servers.length, 1);
    assert.equal(out.servers[0].stored.name, "solo");
    assert.equal(out.servers[0].stored.transport, "stdio");
    assert.deepEqual(out.servers[0].stored.args, ["-y", "@playwright/mcp@latest"]);
  });

  it("accepts stdio command,args,env,cwd from Claude/Cursor-like JSON", () => {
    const out = parseMcpImportDocument(
      wrap({
        worker: {
          command: "npx",
          args: ["-y", "foo"],
          env: { HOME_OVERRIDE: "/tmp/ok" },
          cwd: "/tmp/mcp-ok",
        },
      }),
    );
    const stored = out.servers[0].stored;
    assert.equal(stored.command, "npx");
    assert.deepEqual(stored.args, ["-y", "foo"]);
    assert.equal(stored.cwd, "/tmp/mcp-ok");
    assert.equal(stored.env.HOME_OVERRIDE, "/tmp/ok");
  });
});

describe("parseMcpImportDocument rejection", () => {
  it("rejects an ambiguous mix of mcpServers and a direct server map", () => {
    assert.throws(
      () =>
        parseMcpImportDocument({
          mcpServers: { a: { url: "https://a.example.com/mcp" } },
          b: { url: "https://b.example.com/mcp" },
        }),
      /ambiguous/i,
    );
  });

  it("rejects a purported direct map when any value is not a plausible MCP definition", () => {
    assert.throws(
      () =>
        parseMcpImportDocument({
          "team-tools": { url: "https://tools.example.com/mcp" },
          version: "1.0.0",
        }),
      /ambiguous|plausible|MCP/i,
    );
  });

  it("rejects duplicate names, reserved names, and invalid definitions", () => {
    assert.throws(
      () =>
        parseMcpImportDocument({
          mcpServers: {
            dup: { url: "https://a.example.com/mcp" },
          },
          name: "dup",
          url: "https://b.example.com/mcp",
        }),
      /ambiguous|duplicate/i,
    );
    assert.throws(
      () =>
        parseMcpImportDocument(
          wrap({
            "coder-memory": { url: "https://evil.example.com/mcp" },
          }),
        ),
      /reserved/i,
    );
    assert.throws(
      () =>
        parseMcpImportDocument(
          wrap({
            ok: { url: "ftp://tools.example.com/mcp" },
          }),
        ),
      /http/i,
    );
    assert.throws(
      () =>
        parseMcpImportDocument(
          wrap({
            "Bad Name": { url: "https://tools.example.com/mcp" },
          }),
        ),
      /name/i,
    );
  });

  it("rejects malformed, oversized, and too-deep JSON", () => {
    assert.throws(() => parseMcpImportDocument("{nope"), /valid JSON/);
    const deep = {};
    let cur = deep;
    for (let i = 0; i < 40; i += 1) {
      cur.mcpServers = {};
      cur = cur.mcpServers;
    }
    cur.ok = { url: "https://ok.example.com/mcp" };
    assert.throws(() => parseMcpImportDocument(deep), /deep/i);
    const huge = `{"mcpServers":{"ok":{"url":"https://ok.example.com/mcp","token":"${"x".repeat(600 * 1024)}"}}} `;
    assert.throws(() => parseMcpImportDocument(huge), /size|large|bytes/i);
  });
});

describe("parseMcpImportDocument secret templates", () => {
  it("keeps ${ENV} templates in stored values and describes them without adjacent secret text", () => {
    const out = parseMcpImportDocument(
      wrap({
        "team-tools": {
          url: "https://tools.example.com/mcp",
          token: "${MCP_TOKEN}",
          headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
        },
        "local-tools": {
          command: "/usr/bin/mcp-server",
          env: { API_KEY: "${API_KEY}" },
        },
      }),
    );
    const remote = out.servers.find((s) => s.stored.name === "team-tools");
    const local = out.servers.find((s) => s.stored.name === "local-tools");
    assert.equal(remote.stored.token, "${MCP_TOKEN}");
    assert.equal(remote.stored.headers.Authorization, "Bearer ${GITHUB_TOKEN}");
    assert.equal(local.stored.env.API_KEY, "${API_KEY}");
    const labels = out.servers.flatMap((s) => s.requiredSecrets.map((d) => d.label)).sort();
    assert.deepEqual(labels, ["API_KEY", "GITHUB_TOKEN", "MCP_TOKEN"]);
    for (const server of out.servers) {
      for (const desc of server.requiredSecrets) {
        assert.match(desc.id, /^[a-f0-9]{8,}$/);
        assert.equal(typeof desc.server, "string");
        assert.equal(typeof desc.field, "string");
        assert.equal(desc.template, undefined);
        assert.equal(desc.value, undefined);
      }
    }
    const publicish = JSON.stringify(
      out.servers.map((s) => ({
        name: s.stored.name,
        requiredSecrets: s.requiredSecrets,
      })),
    );
    assert.equal(publicish.includes("Bearer "), false);
    assert.equal(publicish.includes("${GITHUB_TOKEN}"), false);
    assert.equal(publicish.includes("${MCP_TOKEN}"), false);
    assert.equal(publicish.includes("${API_KEY}"), false);
  });

  it("does not treat a non-template literal as a required secret descriptor", () => {
    const out = parseMcpImportDocument(
      wrap({
        "team-tools": {
          url: "https://tools.example.com/mcp",
          token: "literal-secret-value",
        },
      }),
    );
    assert.equal(out.servers[0].requiredSecrets.length, 0);
    assert.equal(out.servers[0].stored.token, "literal-secret-value");
  });
});
