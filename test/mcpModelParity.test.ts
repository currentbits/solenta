/**
 * Electron mcp.js vs src/shared/mcpModel.ts must not drift.
 * Junk is dropped (normalize) or thrown (validate) the same way on both sides.
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/mcpModelParity.test.ts
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import * as shared from "../src/shared/mcpModel.ts";

const require = createRequire(import.meta.url);
const electron = require("../electron/mcp.js") as typeof shared & {
  normalizeMcpServers: (raw: unknown) => unknown[];
};

type Outcome =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

function capture(fn: () => unknown): Outcome {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function same(label: string, left: Outcome, right: Outcome) {
  assert.deepEqual(right, left, label);
}

const HTTP = {
  name: "team-tools",
  transport: "http" as const,
  url: "https://tools.example.com/mcp",
  token: "secret-token",
  headers: { Authorization: "Bearer keep-hdr", "X-Api-Key": "k" },
  enabled: true,
};

const STDIO = {
  name: "local-tools",
  transport: "stdio" as const,
  command: "/usr/bin/mcp-server",
  args: ["--stdio"],
  env: { GITHUB_TOKEN: "tok" },
  cwd: "/tmp/mcp-ok",
  enabled: true,
  trusted: true,
};

const JUNK_NORMALIZE = [
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
];

const INVALID_VALIDATE: Array<{ label: string; raw: unknown }> = [
  { label: "non-array", raw: "nope" },
  { label: "bad name", raw: [{ name: "X", url: "https://a.b/mcp" }] },
  { label: "reserved", raw: [{ name: "coder-threads", url: "https://a.b/mcp" }] },
  {
    label: "duplicate",
    raw: [
      { name: "dup", url: "https://a.b/mcp" },
      { name: "dup", url: "https://c.d/mcp" },
    ],
  },
  { label: "ftp", raw: [{ name: "ok", url: "ftp://a.b/mcp" }] },
  {
    label: "credentials",
    raw: [{ name: "ok", url: "https://user:pass@a.b/mcp" }],
  },
  {
    label: "control url",
    raw: [{ name: "ok", url: "https://ok.example.com/mcp\n" }],
  },
  {
    label: "untrusted stdio",
    raw: [
      {
        name: "unsafe",
        transport: "stdio",
        command: "/bin/echo",
        enabled: true,
        trusted: false,
      },
    ],
  },
  {
    label: "trusted 1",
    raw: [
      {
        name: "unsafe",
        transport: "stdio",
        command: "/bin/echo",
        enabled: true,
        trusted: 1,
      },
    ],
  },
  {
    label: "relative cwd",
    raw: [
      {
        name: "ok",
        transport: "stdio",
        command: "/bin/echo",
        cwd: "relative/path",
        trusted: true,
      },
    ],
  },
  {
    label: "proto headers",
    raw: [
      JSON.parse(
        '{"name":"ok","url":"https://a.b/mcp","headers":{"__proto__":{"x":"1"}}}',
      ),
    ],
  },
  {
    label: "NODE_OPTIONS",
    raw: [
      {
        name: "ok",
        transport: "stdio",
        command: "/bin/echo",
        env: { NODE_OPTIONS: "x" },
        trusted: true,
      },
    ],
  },
  { label: "array entry", raw: [[{ name: "ok", url: "https://a.b/mcp" }]] },
];

describe("electron vs shared MCP model", () => {
  it("exposes the same entry points including normalize", () => {
    for (const name of [
      "normalizeMcpServers",
      "validateMcpServers",
      "upsertMcpServer",
      "mergeMcpSettingsPatch",
      "redactMcpServer",
      "redactMcpServers",
    ] as const) {
      assert.equal(typeof electron[name], "function", `electron.${name}`);
      assert.equal(typeof shared[name], "function", `shared.${name}`);
    }
  });

  it("normalize drops the same junk and keeps the same survivors", () => {
    same(
      "junk list",
      capture(() => electron.normalizeMcpServers(JUNK_NORMALIZE)),
      capture(() => shared.normalizeMcpServers(JUNK_NORMALIZE)),
    );
    same(
      "null",
      capture(() => electron.normalizeMcpServers(null)),
      capture(() => shared.normalizeMcpServers(null)),
    );
    same(
      "enabled untrusted stdio",
      capture(() =>
        electron.normalizeMcpServers([
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
        ]),
      ),
      capture(() =>
        shared.normalizeMcpServers([
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
        ]),
      ),
    );
  });

  it("validate accepts the same valid rows and rejects the same invalid ones", () => {
    const valid = [
      { name: "legacy", url: "https://old.example.com/mcp", enabled: true },
      { name: "canon", url: "https://Example.COM:443/mcp" },
      { ...HTTP },
      {
        name: "sse-tools",
        transport: "sse",
        url: "https://sse.example.com/mcp",
        enabled: true,
      },
      { ...STDIO },
    ];
    same(
      "valid set",
      capture(() => electron.validateMcpServers(valid)),
      capture(() => shared.validateMcpServers(valid)),
    );
    for (const row of INVALID_VALIDATE) {
      same(
        row.label,
        capture(() => electron.validateMcpServers(row.raw)),
        capture(() => shared.validateMcpServers(row.raw)),
      );
    }
  });

  it("redaction and secret-merge match, including omitted and transport-switch", () => {
    const stored = electron.validateMcpServers([HTTP, STDIO]);
    same(
      "redact list",
      capture(() => electron.redactMcpServers(stored)),
      capture(() => shared.redactMcpServers(stored)),
    );

    const omitted = [
      { name: "team-tools", url: "https://tools.example.com/mcp", enabled: false },
      {
        name: "local-tools",
        transport: "stdio",
        command: "/usr/bin/mcp-server",
        enabled: true,
        trusted: true,
      },
    ];
    same(
      "omitted secrets",
      capture(() => electron.mergeMcpSettingsPatch(stored, omitted)),
      capture(() => shared.mergeMcpSettingsPatch(stored, omitted)),
    );

    const redactedPublic = electron.redactMcpServers(stored);
    same(
      "redacted public patch",
      capture(() => electron.mergeMcpSettingsPatch(stored, redactedPublic)),
      capture(() => shared.mergeMcpSettingsPatch(stored, redactedPublic)),
    );

    const switched = [
      {
        name: "team-tools",
        transport: "stdio",
        command: "/bin/echo",
        args: [],
        enabled: true,
        trusted: true,
      },
    ];
    same(
      "transport switch",
      capture(() => electron.mergeMcpSettingsPatch(stored, switched)),
      capture(() => shared.mergeMcpSettingsPatch(stored, switched)),
    );

    same(
      "clear token",
      capture(() =>
        electron.upsertMcpServer(stored, {
          name: "team-tools",
          url: "https://tools.example.com/mcp",
          enabled: true,
          token: "",
        }),
      ),
      capture(() =>
        shared.upsertMcpServer(stored, {
          name: "team-tools",
          url: "https://tools.example.com/mcp",
          enabled: true,
          token: "",
        }),
      ),
    );

    same(
      "merge junk entry",
      capture(() => electron.mergeMcpSettingsPatch(stored, [null, HTTP])),
      capture(() => shared.mergeMcpSettingsPatch(stored, [null, HTTP])),
    );
  });
});
