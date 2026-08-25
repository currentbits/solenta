/**
 * Dedicated mcp.* IPC: redacted results, upsert secret rules, no renderer hooks.
 * Run: node --test electron/test/mcp-ipc.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IPC_HANDLERS } = require("../ipc.js");
const { Store } = require("../store.js");
const { createSecrets } = require("../secrets.js");
const { resetMemorySupForTests, activeServers } = require("../memory-sup.js");

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString(plain) {
      return Buffer.from(`ENC(${plain})`, "utf8");
    },
    decryptString(buf) {
      const s = Buffer.from(buf).toString("utf8");
      if (!s.startsWith("ENC(") || !s.endsWith(")")) {
        throw new Error("bad cipher");
      }
      return s.slice(4, -1);
    },
  };
}

describe("mcp IPC", () => {
  let tmp;
  let store;
  let ctx;
  let prevEnv;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-mcp-ipc-"));
    prevEnv = {
      CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
    };
    process.env.CODER_KIMI_MCP_PATH = path.join(tmp, "kimi-mcp.json");
    process.env.CODER_GROK_MCP_DISABLE = "1";
    resetMemorySupForTests();
    const secrets = createSecrets({
      safeStorage: fakeSafeStorage(),
      inElectron: true,
      log: () => {},
    });
    store = new Store(path.join(tmp, "store.json"), { secrets });
    ctx = { store, userDataPath: tmp };
  });

  afterEach(() => {
    resetMemorySupForTests();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("list/save/remove/setEnabled exist and return only redacted definitions", async () => {
    const created = await IPC_HANDLERS["mcp:save"](ctx, {
      name: "team-tools",
      transport: "http",
      url: "https://tools.example.com/mcp",
      enabled: true,
      token: "ipc-token-unique",
      headers: { Authorization: "Bearer ipc-hdr-unique" },
    });
    assert.equal(created.transport, "http");
    assert.equal(created.hasToken, true);
    assert.deepEqual(created.headerNames, ["Authorization"]);
    assert.equal(created.token, undefined);
    assert.equal(created.headers, undefined);
    assert.ok(!JSON.stringify(created).includes("ipc-token-unique"));
    assert.ok(!JSON.stringify(created).includes("ipc-hdr-unique"));

    const listed = await IPC_HANDLERS["mcp:list"](ctx);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].hasToken, true);
    assert.ok(!JSON.stringify(listed).includes("ipc-token-unique"));

    const local = await IPC_HANDLERS["mcp:save"](ctx, {
      name: "local-tools",
      transport: "stdio",
      command: "/usr/bin/mcp-server",
      args: ["--stdio"],
      enabled: true,
      trusted: true,
      env: { API_KEY: "ipc-env-unique" },
    });
    assert.equal(local.hasSecrets, true);
    assert.deepEqual(local.envNames, ["API_KEY"]);
    assert.equal(local.env, undefined);
    assert.ok(!JSON.stringify(local).includes("ipc-env-unique"));

    store.saveNow();
    const disk = fs.readFileSync(store.filePath, "utf8");
    assert.ok(!disk.includes("ipc-token-unique"));
    assert.ok(!disk.includes("ipc-env-unique"));
    const parsed = JSON.parse(disk);
    assert.ok(parsed.settings.mcpServers[0].token.startsWith("enc:v1:"));
    assert.ok(parsed.settings.mcpServers[1].env.API_KEY.startsWith("enc:v1:"));

    const toggled = await IPC_HANDLERS["mcp:setEnabled"](ctx, {
      name: "team-tools",
      enabled: false,
    });
    assert.equal(toggled.enabled, false);
    assert.equal(toggled.hasToken, true);
    assert.equal(
      store.getSettings().mcpServers.find((s) => s.name === "team-tools").token,
      "ipc-token-unique",
    );

    await IPC_HANDLERS["mcp:remove"](ctx, { name: "local-tools" });
    const after = await IPC_HANDLERS["mcp:list"](ctx);
    assert.deepEqual(
      after.map((s) => s.name),
      ["team-tools"],
    );
  });

  it("save preserves omitted secrets and removes explicit empties", async () => {
    await IPC_HANDLERS["mcp:save"](ctx, {
      name: "team-tools",
      transport: "http",
      url: "https://tools.example.com/mcp",
      enabled: true,
      token: "keep-token",
      headers: { A: "1", B: "2" },
    });
    const preserved = await IPC_HANDLERS["mcp:save"](ctx, {
      name: "team-tools",
      transport: "http",
      url: "https://tools.example.com/mcp2",
      enabled: true,
    });
    assert.equal(preserved.hasToken, true);
    assert.deepEqual(preserved.headerNames.sort(), ["A", "B"]);
    assert.equal(
      store.getSettings().mcpServers[0].token,
      "keep-token",
    );

    const cleared = await IPC_HANDLERS["mcp:save"](ctx, {
      name: "team-tools",
      transport: "http",
      url: "https://tools.example.com/mcp2",
      enabled: true,
      token: "",
      headers: { A: "", B: "2" },
    });
    assert.equal(cleared.hasToken, false);
    assert.deepEqual(cleared.headerNames, ["B"]);
    assert.equal(store.getSettings().mcpServers[0].token, undefined);
  });

  it("changing transport drops secrets from the old transport", async () => {
    await IPC_HANDLERS["mcp:save"](ctx, {
      name: "flip",
      transport: "http",
      url: "https://a.example.com/mcp",
      enabled: true,
      token: "old-token",
    });
    const flipped = await IPC_HANDLERS["mcp:save"](ctx, {
      name: "flip",
      transport: "stdio",
      command: "/bin/echo",
      args: [],
      enabled: true,
      trusted: true,
    });
    assert.equal(flipped.transport, "stdio");
    assert.equal(flipped.hasSecrets, false);
    const stored = store.getSettings().mcpServers[0];
    assert.equal(stored.token, undefined);
    assert.deepEqual(stored.env, {});
  });

  it("does not honor renderer sync/runner/hooks and still syncs from ctx", async () => {
    let threw = false;
    const result = await IPC_HANDLERS["mcp:save"](ctx, {
      name: "team-tools",
      transport: "http",
      url: "https://tools.example.com/mcp",
      enabled: true,
      token: "tok",
      runner: () => {
        threw = true;
        throw new Error("renderer runner");
      },
      syncUserMcpServers: () => {
        threw = true;
        throw new Error("renderer sync");
      },
      hooks: {
        afterSave: () => {
          threw = true;
        },
      },
      spawn: () => {
        threw = true;
      },
    });
    assert.equal(threw, false);
    assert.equal(result.name, "team-tools");
    assert.deepEqual(
      activeServers().map((s) => s.name),
      ["team-tools"],
    );
  });

  it("saves MCP settings even when no skill targets are active", async () => {
    const listed = await IPC_HANDLERS["mcp:list"](ctx);
    assert.deepEqual(listed, []);
    const saved = await IPC_HANDLERS["mcp:save"](ctx, {
      name: "solo",
      transport: "sse",
      url: "https://solo.example.com/mcp",
      enabled: true,
    });
    assert.equal(saved.transport, "sse");
    assert.equal(saved.enabled, true);
  });

  it("keeps legacy settings:set MCP form functional", async () => {
    const next = await IPC_HANDLERS["settings:set"](ctx, {
      mcpServers: [
        {
          name: "legacy",
          url: "https://old.example.com/mcp",
          enabled: true,
          token: "legacy-tok",
        },
      ],
    });
    assert.equal(next.mcpServers[0].name, "legacy");
    assert.equal(next.mcpServers[0].url, "https://old.example.com/mcp");
    assert.equal(next.mcpServers[0].token, undefined);
    assert.equal(next.mcpServers[0].hasToken, true);
    const publicList = await IPC_HANDLERS["mcp:list"](ctx);
    assert.equal(publicList[0].transport, "http");
    assert.equal(publicList[0].hasToken, true);
    assert.ok(!JSON.stringify(publicList).includes("legacy-tok"));
  });

  it("settings:get/set never return MCP secret values; set merges omitted secrets", async () => {
    await IPC_HANDLERS["mcp:save"](ctx, {
      name: "legacy",
      transport: "http",
      url: "https://old.example.com/mcp",
      enabled: true,
      token: "keep-secret",
      headers: { Authorization: "Bearer keep-hdr" },
    });
    const got = await IPC_HANDLERS["settings:get"](ctx);
    assert.equal(got.mcpServers[0].token, undefined);
    assert.equal(got.mcpServers[0].headers, undefined);
    assert.equal(got.mcpServers[0].hasToken, true);
    assert.ok(!JSON.stringify(got).includes("keep-secret"));
    assert.ok(!JSON.stringify(got).includes("keep-hdr"));
    assert.equal(store.getSettings().mcpServers[0].token, "keep-secret");

    const saved = await IPC_HANDLERS["settings:set"](ctx, {
      mcpServers: [
        { name: "legacy", url: "https://old.example.com/mcp", enabled: false },
      ],
    });
    assert.equal(saved.mcpServers[0].enabled, false);
    assert.equal(saved.mcpServers[0].hasToken, true);
    assert.ok(!JSON.stringify(saved).includes("keep-secret"));
    assert.equal(store.getSettings().mcpServers[0].token, "keep-secret");
    assert.equal(
      store.getSettings().mcpServers[0].headers.Authorization,
      "Bearer keep-hdr",
    );
  });

  it("settings:set drops secrets on remove and transport switch", async () => {
    await IPC_HANDLERS["mcp:save"](ctx, {
      name: "flip",
      transport: "http",
      url: "https://a.example.com/mcp",
      enabled: true,
      token: "old-token",
    });
    await IPC_HANDLERS["settings:set"](ctx, {
      mcpServers: [
        {
          name: "flip",
          transport: "stdio",
          command: "/bin/echo",
          args: [],
          enabled: true,
          trusted: true,
        },
      ],
    });
    const stored = store.getSettings().mcpServers[0];
    assert.equal(stored.transport, "stdio");
    assert.equal(stored.token, undefined);
    await IPC_HANDLERS["settings:set"](ctx, { mcpServers: [] });
    assert.deepEqual(store.getSettings().mcpServers, []);
  });

  it("mcp:save critical section is synchronous so concurrent calls cannot interleave", async () => {
    const src = fs.readFileSync(path.join(__dirname, "../ipc.js"), "utf8");
    const start = src.indexOf('"mcp:save"');
    const end = src.indexOf('"mcp:remove"');
    const body = src.slice(start, end);
    assert.ok(!/\bawait\b/.test(body), "mcp:save must not await before setSettings");
    const [a, b] = await Promise.all([
      IPC_HANDLERS["mcp:save"](ctx, {
        name: "one",
        transport: "http",
        url: "https://one.example.com/mcp",
        enabled: true,
      }),
      IPC_HANDLERS["mcp:save"](ctx, {
        name: "two",
        transport: "http",
        url: "https://two.example.com/mcp",
        enabled: true,
      }),
    ]);
    assert.deepEqual(
      (await IPC_HANDLERS["mcp:list"](ctx)).map((s) => s.name).sort(),
      ["one", "two"],
    );
    assert.equal(a.name, "one");
    assert.equal(b.name, "two");
  });

  it("previewImport/installImport round-trip JSON without leaking secrets", async () => {
    const preview = await IPC_HANDLERS["mcp:previewImport"](ctx, {
      kind: "json",
      text: JSON.stringify({
        mcpServers: {
          "ipc-local": {
            command: "/usr/bin/mcp-server",
            args: ["--stdio"],
            env: { GITHUB_TOKEN: "ipc-secret" },
          },
        },
      }),
    });
    assert.equal(preview.servers[0].name, "ipc-local");
    assert.deepEqual(preview.servers[0].envNames, ["GITHUB_TOKEN"]);
    assert.equal(JSON.stringify(preview).includes("ipc-secret"), false);
    const result = await IPC_HANDLERS["mcp:installImport"](ctx, {
      previewId: preview.previewId,
      selected: ["ipc-local"],
      trustLocal: true,
    });
    assert.deepEqual(
      result.installed.map((s) => (typeof s === "string" ? s : s.name)),
      ["ipc-local"],
    );
    const listed = await IPC_HANDLERS["mcp:list"](ctx);
    const row = listed.find((s) => s.name === "ipc-local");
    assert.equal(row.transport, "stdio");
    assert.equal(row.trusted, true);
    assert.deepEqual(row.envNames, ["GITHUB_TOKEN"]);
    assert.equal(JSON.stringify(listed).includes("ipc-secret"), false);
    const catalog = await IPC_HANDLERS["mcp:catalog"](ctx);
    assert.ok(Array.isArray(catalog));
    assert.ok(catalog.length >= 1);
    assert.equal(catalog[0].definition, undefined);
    assert.equal(catalog[0].url, undefined);
  });
});
